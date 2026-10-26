/**
 * The hosted status server's sign-in (project #1327, Issue H): the server is its own OAuth
 * authorisation server in front of the status App's user-to-server flow, it reads GitHub only
 * with the person's own token, keeps no token at rest, refuses a repository the App can't reach
 * with the person's access, logs no token, login or text, and caches only per person.
 *
 * `serve` is driven directly, as a function URL's events, over a fake GitHub (its OAuth
 * endpoints and its API, per person), a fake KMS and a capturing logger. The browser's part of
 * the flow, and GitHub's authorise page, are the test's.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers/adopter.js';
import { laneFleet } from './helpers/status-world.js';
import { API, CASES, REPO, cli, fetchOver, refusedLanes, type Reader } from './helpers/mcp-world.js';

const { serve, LIFETIMES, DEFAULT_REDIRECTS, PATHS, redirectsFrom } = await import('../../infra/status/function/auth.mjs');
const { sealer } = await import('../../infra/status/function/seal.mjs');
const { kmsOf, KmsError } = await import('../../infra/status/function/kms.mjs');
const { readCache, CACHE_TTL_MS } = await import('../../infra/status/function/cache.mjs');
const { fetchReader } = await import('../../infra/status/function/reader.mjs');
const { ROUTES, OUTCOMES, FIELDS } = await import('../../infra/status/function/log.mjs');
const { TOOLS, METHODS } = await import('../../infra/status/function/index.mjs');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const ORIGIN = 'https://status.example';
const RESOURCE = `${ORIGIN}/mcp`;
const METADATA = `${ORIGIN}/.well-known/oauth-protected-resource/mcp`;
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const APP = { clientId: 'Iv23liStatusApp', clientSecret: 'status-app-secret-5f1e0c9a7b' };
const GITHUB = 'https://github.com';
const START = Date.parse('2026-10-26T12:00:00.000Z');
const PAGE = () => readFileSync(join(ROOT, 'docs/status.md'), 'utf8');

const b64url = (b: Buffer) => b.toString('base64url');
const s256 = (v: string) => b64url(createHash('sha256').update(v).digest());

/** KMS, in memory: data keys it generated, opened only with the same encryption context. */
function fakeKms() {
  const keys = new Map<string, { plaintext: Buffer; context: string }>();
  const calls: string[] = [];
  return {
    calls,
    generateDataKey: async ({ context }: { context: Record<string, string> }) => {
      calls.push('GenerateDataKey');
      const plaintext = randomBytes(32);
      const blob = randomBytes(48);
      keys.set(blob.toString('hex'), { plaintext, context: JSON.stringify(context) });
      return { plaintext: Buffer.from(plaintext), blob };
    },
    decrypt: async ({ blob, context }: { blob: Buffer; context: Record<string, string> }) => {
      calls.push('Decrypt');
      const k = keys.get(blob.toString('hex'));
      if (!k || k.context !== JSON.stringify(context)) throw new KmsError('Decrypt', 'InvalidCiphertextException');
      return Buffer.from(k.plaintext);
    },
  };
}

type Installation = { id: number; owner: string; repos: string[] };
type Person = { login: string; world: () => { reader: Reader }; installations: Installation[] };

/**
 * GitHub, for the status App: its authorise page (the test's browser calls `authorize`), its
 * token endpoint, which issues expiring user-to-server tokens and refuses a code or a refresh
 * token used twice, and its API, per person, answering each from that person's world with an
 * `ETag` and a 304 to a matching `If-None-Match`, as GitHub does.
 */
function fakeGitHub(people: Record<string, Person>, { accessLife = 28_800, refreshLife = 15_897_600 } = {}) {
  const requests: Array<{ method: string; url: string; headers: Record<string, string>; body?: string; status: number; text: string }> = [];
  const codes = new Map<string, { person: string; redirect: string; challenge: string; used: boolean }>();
  const access = new Map<string, string>();
  const refresh = new Map<string, { person: string; used: boolean }>();
  const issued: string[] = [];
  const revoked = new Set<string>();
  const remaining = new Map<string, number>();
  let n = 0;
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  const mint = (person: string) => {
    n += 1;
    const a = `ghu_${person}${String(n).padStart(4, '0')}abcdefghijklmnopqrstuv`;
    const r = `ghr_${person}${String(n).padStart(4, '0')}ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz`;
    access.set(a, person);
    refresh.set(r, { person, used: false });
    issued.push(a, r);
    return { access_token: a, expires_in: accessLife, refresh_token: r, refresh_token_expires_in: refreshLife, token_type: 'bearer', scope: '' };
  };

  const oauth = (body: Record<string, string>) => {
    if (body.client_id !== APP.clientId || body.client_secret !== APP.clientSecret) return reply(200, { error: 'incorrect_client_credentials' });
    if (body.grant_type === 'refresh_token') {
      const r = refresh.get(body.refresh_token ?? '');
      if (!r || r.used) return reply(200, { error: 'bad_refresh_token' });
      r.used = true;
      return reply(200, mint(r.person));
    }
    const c = codes.get(body.code ?? '');
    if (!c || c.used || c.redirect !== body.redirect_uri || s256(body.code_verifier ?? '') !== c.challenge) return reply(200, { error: 'bad_verification_code' });
    c.used = true;
    return reply(200, mint(c.person));
  };

  const etagOf = (text: string) => `W/"${createHash('sha1').update(text).digest('hex')}"`;

  const fetchImpl = async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    let res: Response;
    if (url === `${GITHUB}/login/oauth/access_token`) {
      res = oauth(JSON.parse(String(init.body)));
    } else if (url.startsWith(`${API}/`)) {
      const token = /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1] ?? '';
      const who = access.get(token);
      if (!who || revoked.has(token)) res = reply(401, { message: 'Bad credentials' });
      else {
        const person = people[who]!;
        const raw = url.slice(API.length + 1);
        const left = (remaining.get(who) ?? 5000) - 1;
        remaining.set(who, left);
        const limit = { 'x-ratelimit-remaining': String(left) };
        const inst = /^user\/installations\/(\d+)\/repositories\?per_page=100$/.exec(raw);
        if (raw === 'user/installations?per_page=100') {
          res = reply(200, { total_count: person.installations.length, installations: person.installations.map((i) => ({ id: i.id, account: { login: i.owner, type: 'Organization' }, app_slug: 'kanon-status' })) }, limit);
        } else if (inst) {
          const i = person.installations.find((x) => x.id === Number(inst[1]));
          res = i ? reply(200, { total_count: i.repos.length, repositories: i.repos.map((full_name) => ({ full_name, private: true })) }, limit) : reply(404, { message: 'Not Found' }, limit);
        } else {
          const inner = await fetchOver(person.world().reader).fetch(url, init);
          const h: Record<string, string> = { ...Object.fromEntries(inner.headers), ...limit };
          const text = await inner.text();
          if (method === 'GET' && inner.status === 200) h.etag = etagOf(text);
          res = method === 'GET' && inner.status === 200 && headers['if-none-match'] === h.etag
            ? new Response(null, { status: 304, headers: { etag: h.etag!, ...limit } })
            : new Response(text, { status: inner.status, headers: h });
        }
      }
    } else {
      throw new Error(`a request left GitHub: ${method} ${url}`);
    }
    const text = await res.clone().text();
    requests.push({ method, url, headers, body: init.body as string | undefined, status: res.status, text });
    return res;
  };

  return {
    fetch: fetchImpl as unknown as typeof fetch,
    requests,
    issued,
    /** The person's last access token GitHub issued. */
    tokenOf: (person: string) => [...access].filter(([, p]) => p === person).map(([t]) => t).pop()!,
    revoke: (token: string) => revoked.add(token),
    codes: () => [...codes.keys()],
    /**
     * GitHub's authorise page, for an App the person has authorised already: no screen, a code
     * bound to the redirect and the PKCE challenge, and a redirect back with the state.
     */
    authorize: (person: string, location: string) => {
      const u = new URL(location);
      expect(`${u.origin}${u.pathname}`).toBe(`${GITHUB}/login/oauth/authorize`);
      expect(u.searchParams.get('client_id')).toBe(APP.clientId);
      expect(u.searchParams.get('code_challenge_method')).toBe('S256');
      const code = `ghcode${person}${randomBytes(6).toString('hex')}`;
      codes.set(code, { person, redirect: u.searchParams.get('redirect_uri')!, challenge: u.searchParams.get('code_challenge')!, used: false });
      return `${u.searchParams.get('redirect_uri')}?${new URLSearchParams({ code, state: u.searchParams.get('state')! })}`;
    },
  };
}

type Ev = { method?: string; path: string; query?: Record<string, string> | string; headers?: Record<string, string>; body?: string; cookies?: string[]; domain?: string };
/** A function URL's event (payload 2.0). */
const event = ({ method = 'GET', path, query, headers = {}, body, cookies, domain = 'status.example' }: Ev) => ({
  version: '2.0',
  rawPath: path,
  rawQueryString: typeof query === 'string' ? query : new URLSearchParams(query ?? {}).toString(),
  headers,
  ...(cookies ? { cookies } : {}),
  requestContext: { http: { method, path }, domainName: domain },
  body,
  isBase64Encoded: false,
});

/** A server over a fake GitHub and a fake KMS, with a clock the test moves and a capturing log. */
function server(people: Record<string, Person>, opts: { accessLife?: number; refreshLife?: number; redirects?: string[] } = {}) {
  const gh = fakeGitHub(people, opts);
  const kms = fakeKms();
  const lines: string[] = [];
  let clock = START;
  const now = () => new Date(clock);
  const deps = {
    clientId: APP.clientId,
    clientSecret: APP.clientSecret,
    sealer: sealer({ kms, keyId: 'alias/kanon-status' }),
    fetch: gh.fetch,
    cache: readCache({ now: () => clock }),
    log: (l: string) => lines.push(l),
    now,
    ...(opts.redirects ? { redirects: opts.redirects } : {}),
  };
  const send = async (e: Ev, extra: Partial<typeof deps> = {}) => {
    const r: Any = await serve(event(e), { ...deps, ...extra });
    return { ...r, json: () => JSON.parse(r.body) };
  };
  return { gh, kms, lines, deps, send, advance: (ms: number) => { clock += ms; }, now };
}
type Server = ReturnType<typeof server>;

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

/**
 * The `Origin` a browser sends when a page served from `from` posts a form to `to`. This is the
 * Fetch standard's "append a request `Origin` header" step: a POST that isn't CORS follows the
 * page's referrer policy. Under `no-referrer`, and under `same-origin` for a post to another
 * origin, the browser sends `null`. The tests post the Allow with what the page's served policy
 * gives, never a hand-picked origin, so a page that makes browsers send `null` fails the flow.
 */
function browserOrigin(page: { headers: Record<string, string> }, to = `${ORIGIN}/authorize`, from = ORIGIN) {
  const policy = page.headers['referrer-policy'] ?? 'strict-origin-when-cross-origin';
  const target = new URL(to);
  if (policy === 'no-referrer') return 'null';
  if (policy === 'same-origin' && target.origin !== from) return 'null';
  if (['no-referrer-when-downgrade', 'strict-origin', 'strict-origin-when-cross-origin'].includes(policy) && from.startsWith('https:') && target.protocol !== 'https:') return 'null';
  return from;
}
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const JSON_HEADERS = { 'content-type': 'application/json' };

/** Registers a client, as Claude does, by dynamic client registration. */
async function register(s: Server, redirect = CLAUDE, name = 'Claude') {
  const r = await s.send({ method: 'POST', path: '/register', headers: JSON_HEADERS, body: JSON.stringify({ client_name: name, redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().client_id as string;
}

/** The client's authorise request, with PKCE. */
const authorizeQuery = (client_id: string, challenge: string, redirect = CLAUDE, extra: Record<string, string> = {}) =>
  ({ response_type: 'code', client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'client-state-1', resource: RESOURCE, ...extra });

/**
 * The whole sign-in, as a client and the person's browser walk it: register, authorise, the
 * consent page's Allow, GitHub's authorise page, the callback, and the token request. Answers
 * the tokens and every artefact the flow passed around.
 */
async function signIn(s: Server, person: string, { redirect = CLAUDE } = {}) {
  const client_id = await register(s, redirect);
  const verifier = b64url(randomBytes(32));
  const page = await s.send({ path: '/authorize', query: authorizeQuery(client_id, s256(verifier), redirect) });
  expect(page.statusCode, page.body).toBe(200);
  const consent = /name="consent" value="([^"]+)"/.exec(page.body)![1]!;
  const allow = await s.send({ method: 'POST', path: '/authorize', headers: { ...FORM, origin: browserOrigin(page) }, body: form({ consent, decision: 'allow' }) });
  expect(allow.statusCode, allow.body).toBe(302);
  const cookie = allow.cookies[0].split(';')[0];
  const upstream = new URL(allow.headers.location).searchParams.get('state')!;
  const back = new URL(s.gh.authorize(person, allow.headers.location));
  const cb = await s.send({ path: '/callback', query: back.search.slice(1), cookies: [cookie] });
  expect(cb.statusCode, cb.body).toBe(302);
  const to = new URL(cb.headers.location);
  expect(`${to.origin}${to.pathname}`).toBe(redirect.replace(/\/$/, ''));
  expect(to.searchParams.get('state')).toBe('client-state-1');
  const code = to.searchParams.get('code')!;
  const tok = await s.send({ method: 'POST', path: '/token', headers: FORM, body: form({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id, code_verifier: verifier }) });
  expect(tok.statusCode, tok.body).toBe(200);
  const tokens = tok.json();
  return { client_id, verifier, consent, from: browserOrigin(page), upstream, cookie, code, ghCode: back.searchParams.get('code')!, ...tokens } as { client_id: string; verifier: string; consent: string; from: string; upstream: string; cookie: string; code: string; ghCode: string; access_token: string; refresh_token: string; expires_in: number; token_type: string };
}

const rpc = (method: string, params?: unknown, id: number | string = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
/** POSTs one JSON-RPC message to `/mcp`, with a bearer token when there is one. */
const mcp = (s: Server, body: string, token?: string, headers: Record<string, string> = {}) =>
  s.send({ method: 'POST', path: '/mcp', headers: { ...JSON_HEADERS, accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body });
const tool = async (s: Server, token: string, name: string, args: Record<string, unknown>) => {
  const r = await mcp(s, rpc('tools/call', { name, arguments: args }), token);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().result;
};

const acme = (login: string, world: () => { reader: Reader } = () => laneFleet(), repos = [REPO]): Person => ({ login, world, installations: [{ id: 101, owner: 'acme', repos }] });
const apiRequests = (s: Server) => s.gh.requests.filter((r) => r.url.startsWith(`${API}/`));

describe('[MCP-4] no credential, or one that fails, is 401 naming the metadata, and runs no tool', () => {
  it('[MCP-4] answers a request with no credential, or one it can\'t verify or that has expired, with 401 and a WWW-Authenticate naming the protected-resource metadata, and runs no tool', async () => {
    const s = server({ octo: acme('octo-person') });
    const challenge = `Bearer resource_metadata="${METADATA}"`;

    // No credential: every method, and every verb, of the one endpoint.
    for (const [method, body] of [['POST', rpc('tools/list')], ['POST', rpc('tools/call', { name: 'lanes', arguments: { repo: REPO } })], ['POST', rpc('initialize', { protocolVersion: '2025-11-25' })], ['POST', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })], ['GET', undefined], ['DELETE', undefined]] as const) {
      const r = await s.send({ method, path: '/mcp', headers: JSON_HEADERS, body });
      expect([r.statusCode, r.headers['www-authenticate']], `${method} ${body}`).toEqual([401, challenge]);
    }
    // A credential that isn't a bearer token is no credential.
    for (const authorization of ['Basic b2N0bzpwdw==', 'Bearer', 'Bearer ', 'token abc']) {
      const r = await mcp(s, rpc('tools/list'), undefined, { authorization });
      expect([r.statusCode, r.headers['www-authenticate']], authorization).toEqual([401, challenge]);
    }

    // One it can't verify, and one that has expired: 401, and the challenge says the token is invalid.
    const { access_token } = await signIn(s, 'octo');
    const tampered = access_token.slice(0, -6) + (access_token.slice(-6, -5) === 'A' ? 'B' : 'A') + access_token.slice(-5);
    const before = apiRequests(s).length;
    for (const bad of ['not-a-token', tampered, `${access_token}x`, access_token.split('.').slice(0, -1).join('.'), access_token.replace(/^[^.]+/, 'v9')]) {
      const r = await mcp(s, rpc('tools/call', { name: 'lanes', arguments: { repo: REPO } }), bad);
      expect(r.statusCode, bad).toBe(401);
      expect(r.headers['www-authenticate']).toBe(`${challenge}, error="invalid_token"`);
    }
    s.advance(LIFETIMES.access * 1000 + 1000);
    const expired = await mcp(s, rpc('tools/call', { name: 'lanes', arguments: { repo: REPO } }), access_token);
    expect([expired.statusCode, expired.headers['www-authenticate']]).toEqual([401, `${challenge}, error="invalid_token"`]);
    // No tool ran: nothing was read from GitHub for any of them.
    expect(apiRequests(s).length).toBe(before);

    // The metadata it names is served, unauthenticated: this server is the resource and its own
    // authorisation server, with PKCE's S256, as the MCP authorisation specification asks.
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const prm = await s.send({ path });
      expect([prm.statusCode, prm.json()], path).toEqual([200, expect.objectContaining({ resource: RESOURCE, authorization_servers: [ORIGIN], bearer_methods_supported: ['header'] })]);
    }
    const asm = (await s.send({ path: '/.well-known/oauth-authorization-server' })).json();
    expect(asm).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/token`,
      registration_endpoint: `${ORIGIN}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    expect(Object.values(PATHS).sort()).toEqual(['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/authorize', '/callback', '/register', '/token']);

    // And with the token, the same call runs.
    const fresh = await signIn(s, 'octo');
    expect((await tool(s, fresh.access_token, 'lanes', { repo: REPO })).isError).toBe(false);
  });
});

describe('[MCP-5] only the person\'s own user-to-server token', () => {
  it('[MCP-5] calls GitHub only with the token GitHub issued for that person\'s sign-in, mints no installation token, and accepts no personal access token', async () => {
    const s = server({ octo: acme('octo-person'), mona: acme('mona-person') });
    const octo = await signIn(s, 'octo');
    const octoToken = s.gh.tokenOf('octo');
    const mona = await signIn(s, 'mona');
    const monaToken = s.gh.tokenOf('mona');

    for (const [who, token, gh] of [['octo', octo.access_token, octoToken], ['mona', mona.access_token, monaToken]] as const) {
      const start = s.gh.requests.length;
      for (const c of CASES) await tool(s, token, c.tool, c.args);
      const sent = s.gh.requests.slice(start);
      expect(sent.length, who).toBeGreaterThan(0);
      // Every request is to GitHub's API, with this person's own user-to-server token.
      for (const r of sent) {
        expect(r.url.startsWith(`${API}/`), r.url).toBe(true);
        expect(r.headers.authorization, r.url).toBe(`Bearer ${gh}`);
      }
    }
    // No installation token, no App JWT, no request as the App: nothing under `app/`, no
    // `access_tokens`, no bearer that is a JWT.
    for (const r of s.gh.requests) {
      expect(r.url, r.url).not.toMatch(/\/app\/|\/app$|access_tokens|\/installations\/\d+\/access/);
      expect(r.headers.authorization ?? '', r.url).not.toMatch(/^Bearer eyJ/);
    }
    // The App's client secret goes to GitHub's token endpoint alone.
    for (const r of s.gh.requests) if (!r.url.startsWith(`${GITHUB}/login/oauth/access_token`)) expect(JSON.stringify(r), r.url).not.toContain(APP.clientSecret);

    // A personal access token, of either kind, and GitHub's own tokens presented directly, are
    // refused before anything is read: only a token this server issued opens.
    const before = s.gh.requests.length;
    for (const pat of ['ghp_0123456789abcdefghijABCDEFGHIJ012345', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012345', octoToken, 'gho_0123456789abcdefghijABCDEFGHIJ012345', octo.refresh_token]) {
      const r = await mcp(s, rpc('tools/call', { name: 'lanes', arguments: { repo: REPO } }), pat);
      expect([r.statusCode, r.headers['www-authenticate']], pat.slice(0, 12)).toEqual([401, `Bearer resource_metadata="${METADATA}", error="invalid_token"`]);
    }
    expect(s.gh.requests.length).toBe(before);

    // When GitHub refuses the person's token (they revoked the App's authorisation), the answer is
    // HTTP 401, so the client refreshes or signs in again, not a tool's error.
    s.gh.revoke(octoToken);
    const revoked = await mcp(s, rpc('tools/call', { name: 'lanes', arguments: { repo: REPO } }), octo.access_token);
    expect([revoked.statusCode, revoked.headers['www-authenticate']]).toEqual([401, `Bearer resource_metadata="${METADATA}", error="invalid_token"`]);
  }, 60_000);
});

describe('[MCP-6] no GitHub token at rest', () => {
  it('[MCP-6] carries the person\'s GitHub tokens only inside the tokens it issues, sealed under its key, which expire after the lifetimes docs/status.md states', async () => {
    const s = server({ octo: acme('octo-person') });
    const t = await signIn(s, 'octo');
    const [ghAccess, ghRefresh] = s.gh.issued.slice(-2) as [string, string];

    // The tokens it issues are opaque: neither GitHub token appears in them in any encoding.
    for (const ours of [t.access_token, t.refresh_token]) {
      for (const theirs of [ghAccess, ghRefresh]) {
        for (const enc of [theirs, Buffer.from(theirs).toString('base64'), Buffer.from(theirs).toString('base64url'), Buffer.from(theirs).toString('hex')]) {
          expect(ours.includes(enc.slice(4, 24))).toBe(false);
        }
      }
    }
    // Sealed under the server's KMS key: one data key for the container, asked for once, and a
    // container that didn't seal a token asks KMS to open its data key, once.
    expect(s.kms.calls).toEqual(['GenerateDataKey']);
    const other = { ...s.deps, sealer: sealer({ kms: s.kms, keyId: 'alias/kanon-status' }) };
    for (let i = 0; i < 3; i++) expect((await s.send({ method: 'POST', path: '/mcp', headers: { ...JSON_HEADERS, authorization: `Bearer ${t.access_token}` }, body: rpc('ping') }, other)).statusCode).toBe(200);
    expect(s.kms.calls).toEqual(['GenerateDataKey', 'Decrypt']);
    // A container under another key opens none of them.
    const elsewhere = { ...s.deps, sealer: sealer({ kms: fakeKms(), keyId: 'alias/other' }) };
    expect((await s.send({ method: 'POST', path: '/mcp', headers: { ...JSON_HEADERS, authorization: `Bearer ${t.access_token}` }, body: rpc('ping') }, elsewhere)).statusCode).toBe(401);

    // The lifetimes docs/status.md states are the ones the server issues with.
    const table = /### Token lifetimes\n([\s\S]*?)(?:\n#|$)/.exec(PAGE())?.[1] ?? '';
    const UNIT: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86_400 };
    const stated = Object.fromEntries([...table.matchAll(/^\|\s*`(\w+)`[^|]*\|\s*(\d+) (second|minute|hour|day)s?\b/gm)].map((m) => [m[1]!, Number(m[2]) * UNIT[m[3]!]!]));
    expect(stated, 'docs/status.md\'s "### Token lifetimes" table').toEqual(LIFETIMES);
    expect(LIFETIMES).toEqual({ code: 60, consent: 600, state: 600, access: 3600, refresh: 30 * 86_400 });
    expect(t.expires_in).toBe(LIFETIMES.access);

    // The access token stops at its lifetime.
    s.advance(LIFETIMES.access * 1000 - 1000);
    expect((await mcp(s, rpc('ping'), t.access_token)).statusCode).toBe(200);
    s.advance(2000);
    expect((await mcp(s, rpc('ping'), t.access_token)).statusCode).toBe(401);

    // The refresh token rolls: each refresh starts a new 30 days, and 30 days idle ends it.
    const refresh = (token: string, client_id = t.client_id) => s.send({ method: 'POST', path: '/token', headers: FORM, body: form({ grant_type: 'refresh_token', refresh_token: token, client_id }) });
    s.advance((LIFETIMES.refresh - 2 * 86_400) * 1000);
    const r1 = await refresh(t.refresh_token);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.headers['cache-control']).toBe('no-store');
    expect((await mcp(s, rpc('ping'), r1.json().access_token)).statusCode).toBe(200);
    s.advance((LIFETIMES.refresh - 1) * 1000);
    const r2 = await refresh(r1.json().refresh_token);
    expect(r2.statusCode, r2.body).toBe(200);
    s.advance((LIFETIMES.refresh + 1) * 1000);
    const idle = await refresh(r2.json().refresh_token);
    expect([idle.statusCode, idle.json().error]).toEqual([400, 'invalid_grant']);

    // Never longer than the GitHub token inside it: GitHub's token expires in 10 minutes, so ours does.
    const short = server({ octo: acme('octo-person') }, { accessLife: 600 });
    const st = await signIn(short, 'octo');
    expect(st.expires_in).toBe(600);
    short.advance(601_000);
    expect((await mcp(short, rpc('ping'), st.access_token)).statusCode).toBe(401);

    // One kind of token is never accepted as another, and none for another server.
    const u = await signIn(s, 'octo');
    expect((await mcp(s, rpc('ping'), u.refresh_token)).statusCode).toBe(401);
    expect((await mcp(s, rpc('ping'), u.client_id)).statusCode).toBe(401);
    expect((await refresh(u.access_token)).json().error).toBe('invalid_grant');
    const otherOrigin = await s.send({ method: 'POST', path: '/mcp', headers: { ...JSON_HEADERS, authorization: `Bearer ${u.access_token}` }, body: rpc('ping'), domain: 'other.example' });
    expect(otherOrigin.statusCode).toBe(401);
    // A refresh token works only for the client it was issued to.
    const stranger = await register(s);
    expect((await refresh(u.refresh_token, stranger)).json().error).toBe('invalid_grant');
  }, 60_000);
});

describe('[MCP-7] a repository the App can\'t reach with the person\'s access is refused', () => {
  it('[MCP-7] answers a call about a repository where the status App isn\'t installed, or that the person can\'t read, with a tool error saying which, and reads none of its content', async () => {
    const s = server({
      none: { login: 'no-install', world: () => laneFleet(), installations: [{ id: 7, owner: 'elsewhere', repos: ['elsewhere/thing'] }] },
      some: acme('some-repos', () => laneFleet(), ['acme/other']),
      all: acme('all-repos'),
    });
    const none = await signIn(s, 'none');
    const some = await signIn(s, 'some');
    const all = await signIn(s, 'all');

    for (const c of CASES) {
      const start = s.gh.requests.length;
      const missing = await tool(s, none.access_token, c.tool, c.args);
      expect(missing.isError, c.tool).toBe(true);
      expect(missing.content[0].text).toMatch(/isn't installed on `acme`/);
      const unreadable = await tool(s, some.access_token, c.tool, c.args);
      expect(unreadable.isError, c.tool).toBe(true);
      expect(unreadable.content[0].text).toMatch(/can't reach `acme\/shop`.*isn't installed on that repository, or you can't read it/);
      // Neither read the repository: only the person's installations, and their repositories.
      const sent = s.gh.requests.slice(start).map((r) => r.url.slice(API.length + 1));
      expect(sent.every((u) => /^user\/installations(\/\d+\/repositories)?\?per_page=100$/.test(u)), sent.join('\n')).toBe(true);
    }
    // A repository the App reaches, with the person's access, runs, whatever the owner's case.
    expect((await tool(s, all.access_token, 'lanes', { repo: REPO })).isError).toBe(false);
    expect((await tool(s, all.access_token, 'lanes', { repo: 'ACME/Shop' })).isError).toBe(false);
  }, 60_000);
});

describe('[MCP-8] no token, login or read text in any log', () => {
  it('[MCP-8] logs per request only the method or route, the tool, the outcome, the duration, the GitHub request count and the remaining rate limit, over every tool and the whole authorisation flow', async () => {
    // The person's world is switched per call, so every tool runs over every world.
    const world = { current: CASES[0]!.worlds[0]! };
    const octoPerson: Person = { login: 'octo-person', world: () => world.current(), installations: [{ id: 101, owner: 'acme', repos: [REPO] }] };
    const t2 = server({ octo: octoPerson, stranger: { login: 'stranger-login', world: () => laneFleet(), installations: [] } });

    // The whole flow, and its refusals.
    const t = await signIn(t2, 'octo');
    const loopback = await signIn(t2, 'octo', { redirect: 'http://localhost:33418/callback' });
    const denied = await t2.send({ method: 'POST', path: '/authorize', headers: { ...FORM, origin: t.from }, body: form({ consent: t.consent, decision: 'deny' }) });
    expect(denied.statusCode).toBe(302);
    await t2.send({ method: 'POST', path: '/register', headers: JSON_HEADERS, body: JSON.stringify({ client_name: 'Evil', redirect_uris: ['https://evil.example/cb'] }) });
    await t2.send({ method: 'POST', path: '/token', headers: FORM, body: form({ grant_type: 'authorization_code', code: t.code, redirect_uri: CLAUDE, client_id: t.client_id, code_verifier: t.verifier }) });
    const refreshed = (await t2.send({ method: 'POST', path: '/token', headers: FORM, body: form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.client_id }) })).json();
    await t2.send({ path: '/callback', query: { code: 'x', state: t.upstream } });
    await t2.send({ path: '/.well-known/oauth-protected-resource/mcp' });
    await t2.send({ path: '/.well-known/oauth-authorization-server' });
    await mcp(t2, rpc('tools/list'));
    await mcp(t2, rpc('tools/list'), 'ghp_0123456789abcdefghijABCDEFGHIJ012345');
    await mcp(t2, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), t.access_token);
    await mcp(t2, rpc('initialize', { protocolVersion: '2025-11-25' }), t.access_token);
    await mcp(t2, rpc('ghp_0123456789abcdefghijABCDEFGHIJ012345'), t.access_token);
    await mcp(t2, rpc('tools/call', { name: 'octo-person', arguments: {} }), t.access_token);

    // Every tool, over every world, including views whose reads failed, and a refused repository.
    for (const c of CASES) {
      for (const w of c.worlds) {
        world.current = w;
        await tool(t2, refreshed.access_token, c.tool, c.args);
      }
    }
    const stranger = await signIn(t2, 'stranger');
    await tool(t2, stranger.access_token, 'lanes', { repo: REPO });
    // A request that throws inside the server is logged as an error, with nothing of the error.
    const broken = await t2.send({ method: 'POST', path: '/mcp', headers: { ...JSON_HEADERS, authorization: `Bearer ${t.access_token}` }, body: rpc('tools/call', { name: 'lanes', arguments: { repo: REPO } }) }, { fetch: (async () => { throw new Error(`boom ${t.access_token} octo-person`); }) as unknown as typeof fetch });
    expect(broken.statusCode).toBe(200);
    const thrown = await t2.send({ method: 'POST', path: '/token', headers: FORM, body: form({ grant_type: 'refresh_token', refresh_token: refreshed.refresh_token, client_id: t.client_id }) }, { fetch: (async () => { throw new Error(`boom ${refreshed.refresh_token}`); }) as unknown as typeof fetch });
    expect([thrown.statusCode, thrown.body]).toEqual([500, JSON.stringify({ error: 'server_error' })]);

    // One line per request, each one JSON object of exactly the fields, every value from a closed
    // list or a number.
    const lines = t2.lines;
    expect(lines.length).toBeGreaterThan(30);
    const methods = [...Object.keys(METHODS), 'notification', 'response', 'other'];
    const tools = [...TOOLS.map((x: Any) => x.name), 'other'];
    for (const line of lines) {
      const o = JSON.parse(line);
      expect(Object.keys(o).sort(), line).toEqual([...FIELDS].sort());
      expect(ROUTES, line).toContain(o.route);
      expect(o.method === null || methods.includes(o.method), line).toBe(true);
      expect(o.tool === null || tools.includes(o.tool), line).toBe(true);
      expect(OUTCOMES, line).toContain(o.outcome);
      for (const k of ['durationMs', 'githubRequests']) expect(Number.isInteger(o[k]) && o[k] >= 0, line).toBe(true);
      expect(o.rateLimitRemaining === null || Number.isInteger(o.rateLimitRemaining), line).toBe(true);
    }
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.filter((o) => o.method === 'tools/call').map((o) => o.tool)).toEqual(expect.arrayContaining(TOOLS.map((x: Any) => x.name)));
    expect(parsed.some((o) => o.route === '/mcp' && o.tool === 'lanes' && o.githubRequests > 0 && o.rateLimitRemaining !== null)).toBe(true);
    expect(parsed.some((o) => o.outcome === 'error')).toBe(true);

    // Never a token, a login, or text read from GitHub: every token and artefact of the flow,
    // the people's logins, the App's secret, and every string GitHub answered with.
    const log = lines.join('\n');
    const secrets = [
      ...t2.gh.issued, t.access_token, t.refresh_token, t.code, t.consent, t.upstream, t.client_id, t.verifier, t.ghCode, t.cookie.split('=')[1]!,
      loopback.access_token, refreshed.access_token, refreshed.refresh_token, stranger.access_token, ...t2.gh.codes(),
      APP.clientSecret, 'octo-person', 'stranger-login', 'ghp_0123456789abcdefghijABCDEFGHIJ012345',
    ];
    for (const secret of secrets) expect(log.includes(secret), secret.slice(0, 16)).toBe(false);
    const strings = new Set<string>();
    const walk = (v: unknown) => {
      if (typeof v === 'string') strings.add(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    for (const r of t2.gh.requests) {
      try {
        walk(JSON.parse(r.text));
      } catch {
        // a 304 has no body
      }
    }
    // Searched in what the lines say, not their field names, and skipping a fixture string that
    // is part of the log's own closed vocabulary (a tool named `lanes`, say).
    const values = parsed.map((o) => Object.values(o).join(' ')).join('\n');
    const vocabulary = [...ROUTES, ...OUTCOMES, ...methods, ...tools];
    const texts = [...strings].filter((x) => x.length >= 4 && !vocabulary.some((w) => w.includes(x)));
    expect(texts.length).toBeGreaterThan(50);
    for (const text of texts) expect(values.includes(text), text.slice(0, 40)).toBe(false);
    // It never asks who the person is.
    expect(t2.gh.requests.filter((r) => r.url === `${API}/user` || r.url.startsWith(`${API}/user?`))).toEqual([]);
  }, 120_000);
});

describe('[MCP-9] every answer carries its read time, and any cache is per person', () => {
  it('[MCP-9] every tool answer carries the time its GitHub reads were made', async () => {
    const s = server({ octo: acme('octo-person', () => CASES[0]!.worlds[0]!()) });
    const t = await signIn(s, 'octo');
    s.advance(5_000);
    const at = s.now().toISOString();
    for (const c of CASES) {
      const r = await tool(s, t.access_token, c.tool, c.args);
      expect(r._meta, c.tool).toEqual({ readAt: at });
      expect(r.content.at(-1), c.tool).toEqual({ type: 'text', text: `Read from GitHub at ${at}.` });
    }
    // A refused repository was read too: its installations.
    const refused = await tool(s, t.access_token, 'lanes', { repo: 'acme/elsewhere' });
    expect([refused.isError, refused._meta]).toEqual([true, { readAt: at }]);
  }, 60_000);

  it('[MCP-9] caches per person, keyed by the person\'s token and never shared, revalidated with GitHub every time, and used no longer than the time docs/status.md states', async () => {
    // The page states the lifetime, and the cache keeps it.
    expect(/per-person cache[^.]*\.\s*An answer is never used after (\d+) seconds/i.exec(PAGE())?.[1], 'docs/status.md states the cache\'s lifetime').toBe(String(CACHE_TTL_MS / 1000));
    expect(CACHE_TTL_MS).toBe(60_000);

    let clock = START;
    const cache = readCache({ now: () => clock });
    const sent: Array<{ who: string; url: string; inm?: string; method: string }> = [];
    const BODY: Record<string, string> = { tokA: 'answer for A', tokB: 'answer for B' };
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const h = init.headers as Record<string, string>;
      const who = h.authorization!.replace('Bearer ', '');
      sent.push({ who, url, inm: h['if-none-match'], method: init.method ?? 'GET' });
      if ((init.method ?? 'GET') === 'POST') return Response.json({ data: { who: BODY[who] } });
      const etag = `"${who}-v1"`;
      if (h['if-none-match'] === etag) return new Response(null, { status: 304, headers: { etag, 'x-ratelimit-remaining': '4999' } });
      return Response.json({ who: BODY[who] }, { headers: { etag, 'x-ratelimit-remaining': '4998' } });
    }) as unknown as typeof fetch;
    const as = (token: string) => {
      const stats = { requests: 0, rateLimitRemaining: null as number | null, unauthorized: false };
      return { reader: fetchReader({ token, fetch: fetchImpl, cache: cache.for(token), stats }), stats };
    };

    const a1 = as('tokA');
    expect(await a1.reader.get('repos/acme/shop')).toEqual({ who: 'answer for A' });
    // B reads the same path: A's entry isn't offered for it, and B gets B's own answer.
    expect(await as('tokB').reader.get('repos/acme/shop')).toEqual({ who: 'answer for B' });
    expect(sent.map((x) => [x.who, x.inm])).toEqual([['tokA', undefined], ['tokB', undefined]]);
    // A again: revalidated with GitHub, conditionally, and the 304 serves A's own body.
    const a2 = as('tokA');
    expect(await a2.reader.get('repos/acme/shop')).toEqual({ who: 'answer for A' });
    expect(sent.at(-1)).toEqual({ who: 'tokA', url: `${API}/repos/acme/shop`, inm: '"tokA-v1"', method: 'GET' });
    expect([a2.stats.requests, a2.stats.rateLimitRemaining]).toEqual([1, 4999]);
    // A body the view changes doesn't change what the cache holds.
    const mutable = (await as('tokB').reader.get('repos/acme/shop')) as Any;
    mutable.who = 'changed';
    expect(await as('tokB').reader.get('repos/acme/shop')).toEqual({ who: 'answer for B' });
    // GraphQL is never cached: no condition, and every query is sent.
    await as('tokA').reader.graphql('query Q { a }');
    await as('tokA').reader.graphql('query Q { a }');
    expect(sent.filter((x) => x.method === 'POST').map((x) => x.inm)).toEqual([undefined, undefined]);
    // The cache holds no token: it is keyed by the token's hash.
    expect(JSON.stringify(cache.keys())).not.toMatch(/tokA|tokB/);
    expect(cache.keys()).toEqual([createHash('sha256').update('tokA').digest('hex'), createHash('sha256').update('tokB').digest('hex')]);
    // After its lifetime the entry is gone, though it was revalidated meanwhile: no condition is sent.
    clock += CACHE_TTL_MS;
    expect(await as('tokA').reader.get('repos/acme/shop')).toEqual({ who: 'answer for A' });
    expect(sent.at(-1)!.inm).toBeUndefined();
    clock += CACHE_TTL_MS + 1;
    expect(cache.keys()).toEqual([]);

    // Through the server: two people, one container's cache, the same tool on the same
    // repository, interleaved; each answer is the one that person's own reads give.
    const s = server({ octo: acme('octo-person', () => laneFleet()), mona: acme('mona-person', () => refusedLanes()) });
    const octo = await signIn(s, 'octo');
    const mona = await signIn(s, 'mona');
    const wantOcto = (await cli(['--lanes'], laneFleet().reader))['lanes'];
    const wantMona = (await cli(['--lanes'], refusedLanes().reader))['lanes'];
    expect(wantOcto).not.toEqual(wantMona);
    for (let i = 0; i < 2; i++) {
      expect((await tool(s, octo.access_token, 'lanes', { repo: REPO })).structuredContent).toEqual(wantOcto);
      expect((await tool(s, mona.access_token, 'lanes', { repo: REPO })).structuredContent).toEqual(wantMona);
    }
    // The second round was revalidated: conditional, and each condition is the person's own.
    const conditional = apiRequests(s).filter((r) => r.headers['if-none-match']);
    expect(conditional.length).toBeGreaterThan(0);
    const firstSeen = new Map<string, string>();
    for (const r of apiRequests(s)) if (r.status === 200 && r.method === 'GET') firstSeen.set(`${r.headers.authorization} ${r.url}`, JSON.parse(r.text) && 'x');
    for (const r of conditional) expect(firstSeen.has(`${r.headers.authorization} ${r.url}`), r.url).toBe(true);
    expect(conditional.some((r) => r.status === 304)).toBe(true);
  }, 60_000);
});

describe('the authorisation flow', () => {
  it('registers only clients whose redirect is on the allow-list, and only public ones', async () => {
    const s = server({ octo: acme('octo-person') });
    expect(DEFAULT_REDIRECTS).toEqual(['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback', 'http://localhost:*', 'http://127.0.0.1:*']);
    for (const ok of [CLAUDE, 'https://claude.com/api/mcp/auth_callback', 'http://localhost:33418/callback', 'http://127.0.0.1:8080/cb', 'http://localhost:1']) await register(s, ok);
    for (const bad of ['https://evil.example/cb', 'https://claude.ai/api/mcp/auth_callback/x', 'https://claude.ai.evil.example/api/mcp/auth_callback', 'http://claude.ai/api/mcp/auth_callback', 'http://localhost/cb', 'http://localhost:80@evil.example/', 'http://localhost:8080/cb?x=1', 'https://localhost:8080/cb', 'javascript:alert(1)']) {
      const r = await s.send({ method: 'POST', path: '/register', headers: JSON_HEADERS, body: JSON.stringify({ client_name: 'X', redirect_uris: [bad] }) });
      expect([r.statusCode, r.json().error], bad).toEqual([400, 'invalid_redirect_uri']);
    }
    for (const body of ['{', '[]', JSON.stringify({ redirect_uris: [] }), JSON.stringify({ redirect_uris: [CLAUDE], token_endpoint_auth_method: 'client_secret_basic' }), JSON.stringify({ redirect_uris: [CLAUDE], grant_types: ['client_credentials'] })]) {
      const r = await s.send({ method: 'POST', path: '/register', headers: JSON_HEADERS, body });
      expect(r.statusCode, body).toBe(400);
      expect(['invalid_client_metadata', 'invalid_redirect_uri'], body).toContain(r.json().error);
    }
    // The allow-list is configuration: it replaces the defaults whole.
    expect(redirectsFrom(undefined)).toEqual(DEFAULT_REDIRECTS);
    expect(redirectsFrom('  ')).toEqual(DEFAULT_REDIRECTS);
    expect(redirectsFrom('https://a.example/cb, http://localhost:*')).toEqual(['https://a.example/cb', 'http://localhost:*']);
    const narrow = server({ octo: acme('octo-person') }, { redirects: ['https://a.example/cb'] });
    await register(narrow, 'https://a.example/cb');
    expect((await narrow.send({ method: 'POST', path: '/register', headers: JSON_HEADERS, body: JSON.stringify({ redirect_uris: [CLAUDE] }) })).statusCode).toBe(400);
  });

  it('shows a consent page naming the client and where it sends the answer, before anything goes to GitHub', async () => {
    const s = server({ octo: acme('octo-person') });
    const client_id = await register(s, 'http://localhost:4000/callback', '<script>alert("x")</script> Tool');
    const verifier = b64url(randomBytes(32));
    const page = await s.send({ path: '/authorize', query: authorizeQuery(client_id, s256(verifier), 'http://localhost:4000/callback') });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).not.toContain('<script>');
    expect(page.body).toContain('&lt;script&gt;');
    expect(page.body).toContain('localhost:4000');
    expect(page.body).toMatch(/program on this computer/);
    expect(s.gh.requests).toEqual([]);

    // The client's request is checked first: its client, its exact redirect, S256 PKCE, the resource.
    const bad = async (query: Record<string, string>) => s.send({ path: '/authorize', query });
    const q = authorizeQuery(client_id, s256(verifier), 'http://localhost:4000/callback');
    for (const wrong of [{ ...q, client_id: 'nope' }, { ...q, redirect_uri: 'http://localhost:4001/callback' }, { ...q, redirect_uri: CLAUDE }]) {
      const r = await bad(wrong);
      expect([r.statusCode, r.headers.location], JSON.stringify(wrong)).toEqual([400, undefined]);
    }
    for (const [wrong, error] of [[{ ...q, code_challenge_method: 'plain' }, 'invalid_request'], [{ ...q, code_challenge: '' }, 'invalid_request'], [{ ...q, response_type: 'token' }, 'unsupported_response_type'], [{ ...q, resource: 'https://other.example/mcp' }, 'invalid_target']] as const) {
      const r = await bad(wrong);
      expect(r.statusCode).toBe(302);
      const to = new URL(r.headers.location);
      expect([to.searchParams.get('error'), to.searchParams.get('state')], JSON.stringify(wrong)).toEqual([error, 'client-state-1']);
    }
    // No resource named is this server's one resource.
    const noResource: Record<string, string> = { ...q };
    delete noResource.resource;
    expect((await bad(noResource)).statusCode).toBe(200);
  });

  it('forwards to GitHub only on the person\'s Allow, from the consent page itself, and completes only in the browser that allowed it', async () => {
    const s = server({ octo: acme('octo-person') });
    const client_id = await register(s);
    const verifier = b64url(randomBytes(32));
    const page = await s.send({ path: '/authorize', query: authorizeQuery(client_id, s256(verifier)) });
    const consent = /name="consent" value="([^"]+)"/.exec(page.body)![1]!;
    // A form posted from another page, or with no origin, is refused: a crafted page can't press Allow.
    // `null` is what a crafted page under `no-referrer` makes a browser send. Our own page's posts
    // below carry what its served policy gives a browser.
    for (const headers of [{ ...FORM }, { ...FORM, origin: 'https://evil.example' }, { ...FORM, origin: 'null' }]) {
      const r = await s.send({ method: 'POST', path: '/authorize', headers, body: form({ consent, decision: 'allow' }) });
      expect([r.statusCode, r.headers.location], JSON.stringify(headers)).toEqual([403, undefined]);
    }
    // Deny goes back to the client.
    const deny = await s.send({ method: 'POST', path: '/authorize', headers: { ...FORM, origin: browserOrigin(page) }, body: form({ consent, decision: 'deny' }) });
    expect(new URL(deny.headers.location).searchParams.get('error')).toBe('access_denied');
    // A consent form that has lapsed, or isn't one, is refused.
    expect((await s.send({ method: 'POST', path: '/authorize', headers: { ...FORM, origin: browserOrigin(page) }, body: form({ consent: client_id, decision: 'allow' }) })).statusCode).toBe(400);
    const allow = await s.send({ method: 'POST', path: '/authorize', headers: { ...FORM, origin: browserOrigin(page) }, body: form({ consent, decision: 'allow' }) });
    expect(allow.statusCode).toBe(302);
    const up = new URL(allow.headers.location);
    expect(up.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/callback`);
    expect(allow.cookies[0]).toMatch(/^__Host-kanon-status-flow=[\w-]+; Max-Age=600; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
    const back = new URL(s.gh.authorize('octo', allow.headers.location));
    // The callback, in another browser (no cookie, or another's), is refused.
    for (const cookies of [undefined, ['__Host-kanon-status-flow=someone-else']]) {
      const r = await s.send({ path: '/callback', query: back.search.slice(1), ...(cookies ? { cookies } : {}) });
      expect([r.statusCode, r.headers.location]).toEqual([400, undefined]);
    }
    // GitHub's own refusal goes back to the client as access_denied.
    const cookie = allow.cookies[0].split(';')[0];
    const refused = await s.send({ path: '/callback', query: { error: 'access_denied', state: up.searchParams.get('state')! }, cookies: [cookie] });
    expect(new URL(refused.headers.location).searchParams.get('error')).toBe('access_denied');
    // The upstream state lapses after its lifetime.
    s.advance(LIFETIMES.state * 1000 + 1000);
    expect((await s.send({ path: '/callback', query: back.search.slice(1), cookies: [cookie] })).statusCode).toBe(400);
  });

  it('exchanges a code once, only for its client, redirect and verifier, and within its lifetime', async () => {
    const s = server({ octo: acme('octo-person') });
    const t = await signIn(s, 'octo');
    const exchange = (o: Record<string, string>) => s.send({ method: 'POST', path: '/token', headers: FORM, body: form({ grant_type: 'authorization_code', redirect_uri: CLAUDE, client_id: t.client_id, code_verifier: t.verifier, ...o }) });
    // Used once already, in signIn: GitHub refuses its own code a second time, so ours is single use.
    expect((await exchange({ code: t.code })).json().error).toBe('invalid_grant');

    const fresh = async () => {
      const client_id = t.client_id;
      const verifier = b64url(randomBytes(32));
      const page = await s.send({ path: '/authorize', query: authorizeQuery(client_id, s256(verifier)) });
      const consent = /name="consent" value="([^"]+)"/.exec(page.body)![1]!;
      const allow = await s.send({ method: 'POST', path: '/authorize', headers: { ...FORM, origin: browserOrigin(page) }, body: form({ consent, decision: 'allow' }) });
      const back = new URL(s.gh.authorize('octo', allow.headers.location));
      const cb = await s.send({ path: '/callback', query: back.search.slice(1), cookies: [allow.cookies[0].split(';')[0]] });
      return { code: new URL(cb.headers.location).searchParams.get('code')!, verifier };
    };
    const f = await fresh();
    const before = s.gh.requests.length;
    const stranger = await register(s);
    for (const [o, error] of [
      [{ code: f.code, code_verifier: b64url(randomBytes(32)) }, 'invalid_grant'],
      [{ code: f.code, code_verifier: f.verifier, redirect_uri: 'http://localhost:9/cb' }, 'invalid_grant'],
      [{ code: f.code, code_verifier: f.verifier, client_id: stranger }, 'invalid_grant'],
      [{ code: f.code, code_verifier: f.verifier, client_id: 'nope' }, 'invalid_client'],
      [{ code: f.code, code_verifier: f.verifier, resource: 'https://other.example/mcp' }, 'invalid_target'],
      [{ code: t.access_token, code_verifier: f.verifier }, 'invalid_grant'],
      [{ code: f.code, code_verifier: f.verifier, grant_type: 'password' }, 'unsupported_grant_type'],
    ] as const) {
      const r = await exchange(o as Record<string, string>);
      expect([r.statusCode >= 400, r.json().error], JSON.stringify(o).slice(0, 80)).toEqual([true, error]);
    }
    // None of those reached GitHub.
    expect(s.gh.requests.length).toBe(before);
    // Within its lifetime it exchanges; after it, it doesn't.
    s.advance(LIFETIMES.code * 1000 + 1000);
    expect((await exchange({ code: f.code, code_verifier: f.verifier })).json().error).toBe('invalid_grant');
    const g = await fresh();
    const ok = await exchange({ code: g.code, code_verifier: g.verifier, resource: RESOURCE });
    expect([ok.statusCode, ok.json().token_type, ok.headers['cache-control']]).toEqual([200, 'Bearer', 'no-store']);
    // A refresh token is single use, as GitHub's is.
    const refresh = (token: string) => s.send({ method: 'POST', path: '/token', headers: FORM, body: form({ grant_type: 'refresh_token', refresh_token: token, client_id: t.client_id }) });
    expect((await refresh(ok.json().refresh_token)).statusCode).toBe(200);
    expect((await refresh(ok.json().refresh_token)).json().error).toBe('invalid_grant');
  });
});

describe('the KMS client', () => {
  it('asks KMS for a data key and opens one, signed with SigV4, and fails by AWS\'s error code alone', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: Any }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const body = JSON.parse(String(init.body));
      seen.push({ url, headers, body });
      if (headers['x-amz-target'] === 'TrentService.GenerateDataKey') return Response.json({ CiphertextBlob: Buffer.from('blob').toString('base64'), Plaintext: Buffer.alloc(32, 7).toString('base64'), KeyId: 'arn:k' });
      if (body.CiphertextBlob === Buffer.from('bad').toString('base64')) return Response.json({ __type: 'InvalidCiphertextException', message: 'secret detail' }, { status: 400 });
      return Response.json({ Plaintext: Buffer.alloc(32, 7).toString('base64') });
    }) as unknown as typeof fetch;
    const env = { AWS_REGION: 'eu-central-1', AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret', AWS_SESSION_TOKEN: 'session' };
    const kms = kmsOf(env, fetchImpl);
    const key = await kms.generateDataKey({ keyId: 'alias/kanon-status', context: { service: 'kanon-status' } });
    expect([key.plaintext.length, key.blob.toString()]).toEqual([32, 'blob']);
    expect((await kms.decrypt({ keyId: 'alias/kanon-status', blob: Buffer.from('blob'), context: { service: 'kanon-status' } })).length).toBe(32);
    expect(seen[0]!.url).toBe('https://kms.eu-central-1.amazonaws.com/');
    expect(seen[0]!.headers['content-type']).toBe('application/x-amz-json-1.1');
    expect(seen[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/kms\/aws4_request, SignedHeaders=/);
    expect(seen[0]!.headers['x-amz-security-token']).toBe('session');
    expect(seen[0]!.body).toEqual({ KeyId: 'alias/kanon-status', KeySpec: 'AES_256', EncryptionContext: { service: 'kanon-status' } });
    expect(seen[1]!.body).toEqual({ KeyId: 'alias/kanon-status', CiphertextBlob: Buffer.from('blob').toString('base64'), EncryptionContext: { service: 'kanon-status' } });
    const failed = await kms.decrypt({ keyId: 'k', blob: Buffer.from('bad'), context: {} }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(KmsError);
    expect([(failed as Any).code, (failed as Any).message]).toEqual(['InvalidCiphertextException', 'KMS Decrypt failed: InvalidCiphertextException']);
  });
});
