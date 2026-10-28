import { generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

import { handle } from '../../infra/telemetry/function/index.mjs';
import { dynamoOf, invokeOf, stsOf } from '../../infra/telemetry/function/aws.mjs';
import { ISSUER, keyCache } from '../../infra/telemetry/function/oidc.mjs';
import { keysCache, QUOTAS } from '../../infra/telemetry/function/register-store.mjs';
import { OPERATOR_FIELDS, TOMBSTONE_FIELDS } from '../../infra/telemetry/function/register-fields.mjs';
import { addMonths, PARTITIONS } from '../../infra/telemetry/function/rows.mjs';
import { openCursor, PAGE_ROWS, sessionPolicy } from '../../infra/telemetry/function/token.mjs';
import { SCHEMAS } from '../../actions/agent-telemetry/schema.mjs';
import { nameContext } from '../../actions/agent-telemetry/scrub.mjs';
import { fakeDynamo, REGISTER, ROWS, type Fake } from './helpers/fake-dynamo.js';

/**
 * Plan 0008 step J3: the ingest function's five endpoints on the `live` alias's URL (§3), behind
 * GitHub's token as `oidc.mjs` checks it, with registration (§3.3), the name hashes from the
 * token (§3.4), the adopter's own rows under a session held to its key (§3.5), the quotas (§6)
 * and erasure (§7). Tokens are signed in the test with a key pair generated in the test; the
 * register and rows tables are `helpers/fake-dynamo.ts`, which also holds IAM's grants, so a
 * write naming an operator field would be refused here as AWS would. No AWS, no network.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
type Claims = Record<string, unknown>;

const NOW = Date.parse('2026-10-12T12:00:00Z');
const T = NOW / 1000;
const DAY = 86_400_000;
const ACCOUNT = '1'.repeat(6) + '2'.repeat(6);
const FN = `arn:aws:lambda:eu-central-1:${ACCOUNT}:function:kanon-telemetry-ingest`;
const LIVE = `${FN}:live`;
const ERASE = `${FN}:erase`;
const ENV = {
  TABLE_NAME: ROWS, ACCOUNT_ID: ACCOUNT, REGISTER_TABLE: REGISTER, AUDIENCE: 'kanon-telemetry', MIN_TOKEN_VERSION: '0.40.0',
  SELF_READ_ROLE: `arn:aws:iam::${ACCOUNT}:role/kanon-telemetry-self-read`, CURSOR_KEY: 'ab'.repeat(32), AWS_LAMBDA_FUNCTION_NAME: 'kanon-telemetry-ingest',
};
const KANON = 'yedeya-labs/kanon/.github/workflows';
const COLLECT = `${KANON}/telemetry-collect.yml@refs/tags/v0.40.0`;
const OVERSEER = `${KANON}/agent-overseer.yml@refs/tags/v0.40.0`;
const EXPLORE = `${KANON}/agent-explore-telemetry.yml@refs/tags/v0.40.0`;
const REPO = '101';
const OWNER = '7';
const NAME = 'acme-corp/widget-shop';
/** Every key the tests mint or seed starts so, and no response may hold it. */
const KEY_MARK = 'k_test';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = keyCache({
  fetchImpl: (async () => new Response(JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'listed', use: 'sig', alg: 'RS256' }] }), { status: 200 })) as unknown as typeof fetch,
});
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const tokenOf = (claims: Claims) => {
  const input = `${b64({ typ: 'JWT', alg: 'RS256', kid: 'listed' })}.${b64(claims)}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), pair.privateKey).toString('base64url')}`;
};
const claims = (over: Claims = {}): Claims => ({
  iss: ISSUER, aud: 'kanon-telemetry', iat: T - 30, nbf: T - 630, exp: T + 270,
  event_name: 'schedule', job_workflow_ref: COLLECT,
  repository_id: REPO, repository_owner_id: OWNER, repository: NAME, ref: 'refs/heads/main', ref_type: 'branch',
  ...over,
});

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const runRow = (over: Claims = {}): Claims => ({
  schema_version: 2, row_kind: 'run', tag: 'run', recorded_at: iso(NOW - 60_000), run_id: 33679229731, run_attempt: 2,
  role: 'reviewer', lane: 'review', outcome: 'ok', reason: 'none', kanon_version: '0.40.0', pr_number: 42, ...over,
});
const workRow = (over: Claims = {}): Claims => ({
  schema_version: 1, row_kind: 'work_item', tag: 'run', recorded_at: iso(NOW - 60_000), pr_number: 42,
  closed_at: '2026-10-10T08:00:00Z', fate: 'merged', ...over,
});
const deployRow = (over: Claims = {}): Claims => ({
  schema_version: 1, row_kind: 'deploy', tag: 'run', recorded_at: iso(NOW - 60_000), run_id: 33679229731, run_attempt: 2,
  kanon_version: '0.50.0', role: 'production', position: 1, outcome: 'ok', ...over,
});
const smokeCheckRow = (over: Claims = {}): Claims => ({
  schema_version: 1, row_kind: 'smoke_check', tag: 'run', recorded_at: iso(NOW - 60_000), run_id: 33679229731, run_attempt: 2,
  trigger: 'schedule', kanon_version: '0.50.0', role: 'production', position: 1, outcome: 'ok', reset_ran: false, ...over,
});
const findingRow = (over: Claims = {}): Claims => ({
  schema_version: 1, row_kind: 'finding', tag: 'test', recorded_at: iso(NOW - 60_000), run_id: 33679229731, run_attempt: 2,
  finding_index: 3, reporter: 'overseer', subject: 'guard', kanon_version: '0.40.0', fix_category: 'guard', evidence_level: 'codes', ...over,
});

/** Every response any test saw: none may hold a key. */
const seen: string[] = [];

type Call = { method?: string, path: string, claims?: Claims, token?: string | null, body?: unknown, raw?: string, query?: Record<string, string>, arn?: string, iam?: boolean };

/** A store: the fake tables, and a call through the handler with the test's clock and stubs. */
function store(setup: (f: Fake) => void = () => {}) {
  const f = fakeDynamo();
  setup(f);
  const logs: string[] = [];
  const invoked: Array<{ fn: string, qualifier: string, payload: J }> = [];
  let minted = 0;
  const s = {
    f,
    logs,
    invoked,
    now: NOW,
    remaining: 60_000,
    keys: keysCache(),
    invokeFails: false,
    mint: () => `${KEY_MARK}${String(++minted).padStart(4, '0')}`,
    deps(arn: string | undefined) {
      return {
        env: ENV, now: () => s.now, log: (l: string) => logs.push(l), db: f.db, sts: f.sts, jwks, keys: s.keys,
        invoke: async (fn: string, qualifier: string, payload: J) => {
          if (s.invokeFails) throw new Error('Invoke failed: HTTP500');
          invoked.push({ fn, qualifier, payload });
        },
        mintKey: () => s.mint(), remainingMs: () => s.remaining, invokedFunctionArn: arn,
      };
    },
    async call(c: Call) {
      const token = c.token === undefined ? tokenOf(claims(c.claims)) : c.token;
      const event: J = {
        rawPath: c.path,
        requestContext: { http: { method: c.method ?? 'GET' }, ...(c.iam ? { authorizer: { iam: { userArn: `arn:aws:sts::${ACCOUNT}:assumed-role/kanon-telemetry-${KEY_MARK}0001-writer/x` } } } : {}) },
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
        ...(c.query ? { queryStringParameters: c.query } : {}),
        ...(c.raw !== undefined || c.body !== undefined ? { body: c.raw ?? JSON.stringify(c.body), isBase64Encoded: false } : {}),
      };
      const res: J = await handle(event, s.deps(c.arn ?? LIVE));
      seen.push(JSON.stringify(res));
      return { status: res.statusCode as number, body: JSON.parse(res.body), headers: res.headers as Record<string, string> };
    },
    /** The erasure walk, as Lambda would run it on the `erase` alias. */
    async walk(repositoryId = REPO) {
      const res: J = await handle({ kanon_erase: { repository_id: repositoryId } }, s.deps(ERASE));
      seen.push(JSON.stringify(res));
      return { status: res.statusCode as number, body: JSON.parse(res.body) };
    },
    register: (over: Call = { path: '' }) => s.call({ method: 'POST', ...over, path: '/v1/registrations' }),
    status: (over: Partial<Call> = {}) => s.call({ method: 'GET', ...over, path: '/v1/registrations/self' }),
    erase: (over: Partial<Call> = {}) => s.call({ method: 'DELETE', ...over, path: '/v1/registrations/self' }),
    post: (rows: unknown, over: Partial<Call> = {}) => s.call({ method: 'POST', body: rows, ...over, path: '/v1/rows' }),
    read: (query: Record<string, string>, over: Partial<Call> = {}) =>
      s.call({ method: 'GET', query, claims: { job_workflow_ref: OVERSEER }, ...over, path: '/v1/rows/self' }),
    registration: (id = REPO) => f.get(REGISTER, `repo#${id}`),
  };
  return s;
}

/** A registration seeded as the function or the import would leave it. */
const seedRegistration = (f: Fake, over: Record<string, unknown> = {}) => {
  const reg = {
    pk: `repo#${REPO}`, repository_id: REPO, repository_owner_id: OWNER, repository: NAME, key: `${KEY_MARK}seed`, status: 'active',
    default_ref: 'refs/heads/main', name_hashes: [...nameContext({ repository: NAME })].sort(), registered_at: '2026-10-01T00:00:00.000Z',
    registered_by_version: '0.40.0', last_seen_at: iso(NOW - 60_000), source: 'api', ...over,
  };
  f.seed(REGISTER, reg);
  if (typeof reg.key === 'string') f.seed(REGISTER, { pk: `key#${reg.key}`, repository_id: reg.repository_id });
  return reg;
};
/** Another adopter, with rows of its own. */
const seedOther = (f: Fake) => {
  seedRegistration(f, { pk: 'repo#202', repository_id: '202', repository_owner_id: '8', repository: 'zorblax/quintet', key: `${KEY_MARK}other` });
};
const OPERATOR = {
  aggregate_invoker: true, publish_own_figures_as: 'acme', page_reader: true, quota_rows_per_day: 6_000, quota_requests_per_hour: 200,
  first_review: { minutes: 42, review_recorded_at: '2026-10-01T00:00:00Z' },
};
const seedRow = (f: Fake, key: string, lane: string, over: Record<string, unknown> = {}) => {
  const recorded = String(over.recorded_at ?? iso(NOW - DAY));
  const sk = lane === 'work' ? `pr-${String(over.pr_number ?? 1).padStart(10, '0')}` : `${recorded.replace(/[-:]/g, '').slice(0, 15)}Z#${over.run_id ?? 1}-1-0`;
  const row = lane === 'work' ? workRow({ recorded_at: recorded, ...over }) : runRow({ lane, recorded_at: recorded, ...over });
  f.seed(ROWS, { ...row, pk: `${key}#${lane}`, sk, source: 'collector', received_at: recorded, expires_at: Math.floor(addMonths(NOW, 12) / 1000), ...over });
};

afterAll(() => {
  // No response, by any endpoint, holds a key (§3.2's "never returned"), the cursor included.
  expect(seen.length).toBeGreaterThan(0);
  for (const r of seen) expect(r).not.toContain(KEY_MARK);
});

describe('POST /v1/registrations (§3.2, §3.3)', () => {
  it('201: registers a new repository, active at once, and writes the registration and the key item', async () => {
    const s = store();
    const r = await s.register();
    expect(r).toMatchObject({ status: 201, body: { status: 'active', registered_at: new Date(NOW).toISOString() } });
    expect(Object.keys(r.body).sort()).toEqual(['registered_at', 'status']);
    const reg = s.registration()!;
    expect(reg).toEqual({
      pk: `repo#${REPO}`, repository_id: REPO, repository_owner_id: OWNER, repository: NAME, key: `${KEY_MARK}0001`, status: 'active',
      default_ref: 'refs/heads/main', name_hashes: [...nameContext({ repository: NAME })].sort(), registered_at: new Date(NOW).toISOString(),
      registered_by_version: '0.40.0', last_seen_at: new Date(NOW).toISOString(), source: 'api',
    });
    expect(s.f.get(REGISTER, `key#${KEY_MARK}0001`)).toEqual({ pk: `key#${KEY_MARK}0001`, repository_id: REPO });
    // The name hashes are hashes: no word of the name is stored in them.
    expect(JSON.stringify(reg.name_hashes)).not.toMatch(/acme|widget/);
  });

  it('200: an existing active registration answers the same, and makes nothing new', async () => {
    const s = store((f) => seedRegistration(f));
    const r = await s.register({ path: '', body: {} });
    expect(r).toMatchObject({ status: 200, body: { status: 'active', registered_at: '2026-10-01T00:00:00.000Z' } });
    expect(s.f.all(REGISTER).filter((i) => i.pk.startsWith('key#'))).toHaveLength(1);
  });

  it('two concurrent first runs make one registration: one answers 201, the other 200', async () => {
    const s = store();
    // Hold every transaction until both runs have read "no registration" and reached theirs.
    let waiting = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => { release = r; });
    s.f.before(async (op) => {
      if (op !== 'TransactWriteItems') return;
      waiting += 1;
      if (waiting === 2) release();
      await both;
    });
    const [a, b] = await Promise.all([s.register(), s.register()]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(s.f.all(REGISTER).filter((i) => i.pk.startsWith('repo#'))).toHaveLength(1);
    expect(s.f.all(REGISTER).filter((i) => i.pk.startsWith('key#'))).toHaveLength(1);
    // The refused transaction reserved nothing.
    expect(s.f.get(REGISTER, `count#owner#${OWNER}#2026-10-12`)?.n).toBe(1);
  });

  it('a minted key that is already registered is a retry with another key, never a shared key', async () => {
    const s = store((f) => seedOther(f));
    const keys = [`${KEY_MARK}other`, `${KEY_MARK}fresh`];
    s.mint = () => keys.shift()!;
    expect((await s.register()).status).toBe(201);
    expect(s.registration()!.key).toBe(`${KEY_MARK}fresh`);
    expect(s.f.get(REGISTER, `key#${KEY_MARK}other`)).toEqual({ pk: `key#${KEY_MARK}other`, repository_id: '202' });
  });

  it('409 `erased` on a tombstone without `reregister`; 201 with it, under a new key; 409 `erasing` while the walk runs', async () => {
    const tombstone = { pk: `repo#${REPO}`, repository_id: REPO, repository_owner_id: OWNER, status: 'erased', erased_at: '2026-10-11T00:00:00.000Z', rows_erased_at: '2026-10-11T00:05:00.000Z' };
    const s = store((f) => f.seed(REGISTER, tombstone));
    expect(await s.register()).toMatchObject({ status: 409, body: { error: 'erased' } });
    expect(await s.register({ path: '', body: { reregister: false } })).toMatchObject({ status: 409, body: { error: 'erased' } });
    const r = await s.register({ path: '', body: { reregister: true } });
    expect(r).toMatchObject({ status: 201, body: { status: 'active' } });
    expect(s.registration()).toMatchObject({ status: 'active', key: `${KEY_MARK}0001` });
    expect(s.registration()).not.toHaveProperty('erased_at');

    const walking = store((f) => seedRegistration(f, { status: 'erased', erased_at: '2026-10-11T00:00:00.000Z' }));
    expect(await walking.register({ path: '', body: { reregister: true } })).toMatchObject({ status: 409, body: { error: 'erasing' } });
  });

  it('403 `suspended`', async () => {
    const s = store((f) => seedRegistration(f, { status: 'suspended', suspended_at: '2026-10-11T00:00:00Z', suspended_reason: 'abuse' }));
    expect(await s.register()).toMatchObject({ status: 403, body: { error: 'suspended' } });
    expect(s.registration()!.status).toBe('suspended');
  });

  it('429 `registrations`: 20 a day per owner, and 100 store-wide, with Retry-After', async () => {
    const day = '2026-10-12';
    const owner = store((f) => f.seed(REGISTER, { pk: `count#owner#${OWNER}#${day}`, n: QUOTAS.registrations_per_owner_per_day }));
    const r = await owner.register();
    expect(r).toMatchObject({ status: 429, body: { error: 'quota', limit: 'registrations', resets_at: '2026-10-13T00:00:00.000Z' } });
    expect(r.headers['retry-after']).toBe(String(12 * 3600));
    expect(owner.registration()).toBeUndefined();
    const all = store((f) => f.seed(REGISTER, { pk: `count#all#${day}`, n: QUOTAS.registrations_per_day }));
    expect(await all.register()).toMatchObject({ status: 429, body: { limit: 'registrations' } });
    // Below the limits, it registers.
    const below = store((f) => f.seed(REGISTER, { pk: `count#owner#${OWNER}#${day}`, n: QUOTAS.registrations_per_owner_per_day - 1 }));
    expect((await below.register()).status).toBe(201);
  });

  it('400 for a body that is not `{}` or `{ "reregister": true }`', async () => {
    const s = store();
    expect(await s.register({ path: '', raw: '{not json' })).toMatchObject({ status: 400, body: { error: 'body-json' } });
    expect(await s.register({ path: '', body: [] })).toMatchObject({ status: 400, body: { error: 'body-json' } });
    expect(await s.register({ path: '', body: { reregister: 'yes' } })).toMatchObject({ status: 400, body: { error: 'body-fields' } });
    expect(await s.register({ path: '', body: { key: 'k1' } })).toMatchObject({ status: 400, body: { error: 'body-fields' } });
  });

  it('401 with WWW-Authenticate for no token or a bad one; 403 for another workflow; registration from the collector only', async () => {
    const s = store();
    const none = await s.register({ path: '', token: null });
    expect(none).toMatchObject({ status: 401, body: { error: 'token' } });
    expect(none.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    expect(await s.register({ path: '', claims: { aud: 'sts.amazonaws.com' } })).toMatchObject({ status: 401, body: { error: 'aud' } });
    expect(await s.register({ path: '', claims: { job_workflow_ref: OVERSEER } })).toMatchObject({ status: 403, body: { error: 'workflow' } });
    expect(await s.register({ path: '', claims: { event_name: 'push' } })).toMatchObject({ status: 403, body: { error: 'event' } });
    expect(s.registration()).toBeUndefined();
  });

  it('a schedule on a renamed default branch moves `default_ref`; a dispatch on another branch is refused', async () => {
    const s = store((f) => seedRegistration(f));
    expect(await s.register({ path: '', claims: { event_name: 'workflow_dispatch', ref: 'refs/heads/other' } })).toMatchObject({ status: 403, body: { error: 'ref' } });
    expect((await s.register({ path: '', claims: { ref: 'refs/heads/trunk' } })).status).toBe(200);
    expect(s.registration()!.default_ref).toBe('refs/heads/trunk');
  });
});

describe('GET /v1/registrations/self (§3.2)', () => {
  it('200: the status, quota and flags, never the key, the repository or `page_reader`', async () => {
    const s = store((f) => {
      seedRegistration(f, OPERATOR);
      f.seed(REGISTER, { pk: `count#${KEY_MARK}seed#2026-10-12`, n: 17 });
    });
    const r = await s.status();
    expect(r).toEqual({
      status: 200, headers: expect.anything(),
      body: {
        status: 'active', registered_at: '2026-10-01T00:00:00.000Z', rows_erased: false,
        quota: { rows_per_day: 6_000, rows_today: 17 }, aggregate_invoker: true, publish_own_figures_as: 'acme',
      },
    });
  });

  it('200 with the defaults, and from the Overseer and the Explorer too (§2.2)', async () => {
    const s = store((f) => seedRegistration(f));
    for (const job_workflow_ref of [COLLECT, OVERSEER, EXPLORE]) {
      const r = await s.status({ claims: { job_workflow_ref } });
      expect(r.body).toEqual({ status: 'active', registered_at: '2026-10-01T00:00:00.000Z', rows_erased: false, quota: { rows_per_day: 5_000, rows_today: 0 }, aggregate_invoker: false });
    }
  });

  it('200 for a suspended registration, with when and why', async () => {
    const s = store((f) => seedRegistration(f, { status: 'suspended', suspended_at: '2026-10-11T00:00:00Z', suspended_reason: 'quota' }));
    expect((await s.status()).body).toMatchObject({ status: 'suspended', suspended_at: '2026-10-11T00:00:00Z', suspended_reason: 'quota', rows_erased: false });
  });

  it('200 for an erasure, `rows_erased` false while the walk runs and true for a tombstone', async () => {
    const walking = store((f) => seedRegistration(f, { status: 'erased', erased_at: '2026-10-12T11:00:00.000Z' }));
    expect((await walking.status()).body).toMatchObject({ status: 'erased', erased_at: '2026-10-12T11:00:00.000Z', rows_erased: false });
    const done = store((f) => f.seed(REGISTER, { pk: `repo#${REPO}`, repository_id: REPO, repository_owner_id: OWNER, status: 'erased', erased_at: '2026-10-12T11:00:00.000Z', rows_erased_at: '2026-10-12T11:01:00.000Z' }));
    const r = await done.status({ claims: { event_name: 'workflow_dispatch', ref: 'refs/heads/main' } });
    expect(r.body).toEqual({ status: 'erased', erased_at: '2026-10-12T11:00:00.000Z', rows_erased: true, quota: { rows_per_day: 5_000, rows_today: 0 }, aggregate_invoker: false });
  });

  it('404 `not-registered`; 403 `owner` for another owner id', async () => {
    expect(await store().status()).toMatchObject({ status: 404, body: { error: 'not-registered' } });
    const s = store((f) => seedRegistration(f));
    expect(await s.status({ claims: { repository_owner_id: '99' } })).toMatchObject({ status: 403, body: { error: 'owner' } });
  });
});

describe('DELETE /v1/registrations/self (§3.2, §7)', () => {
  it('202: erased at once, the walk started on the `erase` alias by repository id, never by key', async () => {
    const s = store((f) => seedRegistration(f));
    const r = await s.erase();
    expect(r).toMatchObject({ status: 202, body: { status: 'erased', erased_at: new Date(NOW).toISOString(), rows_erased: false } });
    expect(s.registration()).toMatchObject({ status: 'erased', erased_at: new Date(NOW).toISOString(), key: `${KEY_MARK}seed` });
    expect(s.invoked).toEqual([{ fn: 'kanon-telemetry-ingest', qualifier: 'erase', payload: { kanon_erase: { repository_id: REPO } } }]);
  });

  it('200 on a repeat, which starts the walk again; `rows_erased` true once the tombstone is written', async () => {
    const s = store((f) => seedRegistration(f));
    await s.erase();
    s.now += 60_000;
    expect(await s.erase()).toMatchObject({ status: 200, body: { status: 'erased', erased_at: new Date(NOW).toISOString(), rows_erased: false } });
    expect(s.invoked).toHaveLength(2);
    expect((await s.walk()).status).toBe(200);
    expect(await s.erase()).toMatchObject({ status: 200, body: { status: 'erased', rows_erased: true } });
    expect(s.invoked).toHaveLength(2);
  });

  it('404 `not-registered`; 403 `suspended`, and the suspension stays', async () => {
    expect(await store().erase()).toMatchObject({ status: 404, body: { error: 'not-registered' } });
    const s = store((f) => seedRegistration(f, { status: 'suspended', suspended_at: '2026-10-11T00:00:00Z', suspended_reason: 'abuse' }));
    expect(await s.erase()).toMatchObject({ status: 403, body: { error: 'suspended' } });
    expect(s.registration()).toMatchObject({ status: 'suspended', suspended_reason: 'abuse' });
    expect(s.invoked).toEqual([]);
  });

  it('a suspension written between the read and the write holds: the conditional write fails, and 403', async () => {
    const s = store((f) => seedRegistration(f));
    s.f.before((op, body) => {
      // The operator suspends just before the function marks the registration erased.
      if (op === 'UpdateItem' && body.Key?.pk?.S === `repo#${REPO}` && String(body.UpdateExpression).includes(':erased')) {
        s.f.seed(REGISTER, { ...s.registration(), status: 'suspended', suspended_at: '2026-10-12T11:59:59Z', suspended_reason: 'abuse' });
      }
    });
    expect(await s.erase()).toMatchObject({ status: 403, body: { error: 'suspended' } });
    expect(s.registration()).toMatchObject({ status: 'suspended', suspended_reason: 'abuse' });
    expect(s.registration()).not.toHaveProperty('erased_at');
    expect(s.invoked).toEqual([]);
  });

  it('429 `erasures_per_day` past 5 a day', async () => {
    const s = store((f) => seedRegistration(f));
    for (let i = 0; i < QUOTAS.erasures_per_day; i += 1) expect((await s.erase()).status).toBeLessThan(300);
    expect(await s.erase()).toMatchObject({ status: 429, body: { error: 'quota', limit: 'erasures_per_day' } });
  });

  it('502 `erase-start` when the walk can\'t be started; the erasure stands, and a repeat starts it', async () => {
    const s = store((f) => seedRegistration(f));
    s.invokeFails = true;
    expect(await s.erase()).toMatchObject({ status: 502, body: { error: 'erase-start' } });
    expect(s.registration()!.status).toBe('erased');
    s.invokeFails = false;
    expect((await s.erase()).status).toBe(200);
    expect(s.invoked).toHaveLength(1);
  });
});

describe('the erasure walk on the `erase` alias (§7)', () => {
  const seeded = () => store((f) => {
    seedRegistration(f, OPERATOR);
    seedOther(f);
    for (const lane of PARTITIONS) {
      if (lane === 'work' || lane === 'finding' || lane === 'deploy' || lane === 'smoke_check') continue;
      seedRow(f, `${KEY_MARK}seed`, lane);
    }
    seedRow(f, `${KEY_MARK}seed`, 'work');
    for (let i = 0; i < 30; i += 1) seedRow(f, `${KEY_MARK}seed`, 'work', { pr_number: 100 + i });
    f.seed(ROWS, { ...findingRow(), pk: `${KEY_MARK}seed#finding`, sk: 'x', expires_at: 1 });
    f.seed(ROWS, { ...deployRow(), pk: `${KEY_MARK}seed#deploy`, sk: 'x', expires_at: 1 });
    f.seed(ROWS, { ...smokeCheckRow(), pk: `${KEY_MARK}seed#smoke_check`, sk: 'x', expires_at: 1 });
    seedRow(f, `${KEY_MARK}other`, 'review');
    seedRow(f, `${KEY_MARK}other`, 'work');
  });

  it('empties every partition, `work`, `finding`, `deploy` and `smoke_check` among them, leaves the tombstone alone, and the next POST /v1/rows gets 410', async () => {
    const s = seeded();
    expect(s.f.partition(`${KEY_MARK}seed#deploy`)).toHaveLength(1);
    expect(s.f.partition(`${KEY_MARK}seed#smoke_check`)).toHaveLength(1);
    expect((await s.erase()).status).toBe(202);
    expect(await s.walk()).toEqual({ status: 200, body: { done: true } });
    for (const p of PARTITIONS) expect(s.f.partition(`${KEY_MARK}seed#${p}`), p).toEqual([]);
    expect(s.f.partition(`${KEY_MARK}seed#deploy`)).toEqual([]);
    expect(s.f.partition(`${KEY_MARK}seed#smoke_check`)).toEqual([]);
    // Another key's rows are untouched.
    expect(s.f.partition(`${KEY_MARK}other#review`)).toHaveLength(1);
    expect(s.f.partition(`${KEY_MARK}other#work`)).toHaveLength(1);
    // The tombstone: exactly the two ids, the status and two dates. No key, name, hashes, quota or operator field.
    const t = s.registration()!;
    expect(Object.keys(t).sort()).toEqual([...TOMBSTONE_FIELDS].sort());
    expect(t).toMatchObject({ status: 'erased', erased_at: new Date(NOW).toISOString(), rows_erased_at: new Date(NOW).toISOString() });
    expect(s.f.get(REGISTER, `key#${KEY_MARK}seed`)).toBeUndefined();
    expect(await s.post([runRow()])).toMatchObject({ status: 410, body: { error: 'erased' } });
    expect(s.f.partition(`${KEY_MARK}seed#review`)).toEqual([]);
    expect(await s.read({ lane: 'review' })).toMatchObject({ status: 410, body: { error: 'erased' } });
  });

  it('walks under a session held to the erased key, and deletes nothing with the function\'s own role', async () => {
    const s = seeded();
    await s.erase();
    await s.walk();
    const deletes = s.f.calls.filter((c) => c.op === 'BatchWriteItem' || c.op === 'Query');
    expect(deletes.length).toBeGreaterThan(0);
    expect(deletes.every((c) => c.session)).toBe(true);
    expect([...s.f.sessions.values()]).toEqual([sessionPolicy(ENV, `${KEY_MARK}seed`, ['dynamodb:Query', 'dynamodb:BatchWriteItem'])]);
  });

  it('hands itself on when its time runs short, and a later run finishes', async () => {
    const s = seeded();
    await s.erase();
    s.remaining = 1_000;
    expect(await s.walk()).toEqual({ status: 202, body: { done: false } });
    expect(s.invoked.at(-1)).toEqual({ fn: 'kanon-telemetry-ingest', qualifier: 'erase', payload: { kanon_erase: { repository_id: REPO } } });
    expect(s.registration()!.key).toBe(`${KEY_MARK}seed`);
    s.remaining = 60_000;
    expect((await s.walk()).body).toEqual({ done: true });
  });

  it('walks only an erased registration: an active key is never walked, and a URL event is not the walk\'s', async () => {
    const s = seeded();
    expect(await s.walk()).toEqual({ status: 400, body: { error: 'not-erased' } });
    expect(s.f.partition(`${KEY_MARK}seed#review`)).toHaveLength(1);
    const url: J = await handle({ rawPath: '/', requestContext: { http: { method: 'POST' } }, kanon_erase: { repository_id: REPO } }, s.deps(ERASE));
    expect(JSON.parse(url.body)).toEqual({ error: 'event' });
  });
});

describe('POST /v1/rows (§3.2)', () => {
  it('200: run, finding, work-item, deploy and smoke-check rows mixed, each under its partition; a re-sent work item overwrites its pr- item', async () => {
    const s = store((f) => seedRegistration(f));
    const r = await s.post([runRow(), findingRow(), workRow(), deployRow(), smokeCheckRow()]);
    expect(r).toMatchObject({ status: 200, body: { results: [{ status: 'stored' }, { status: 'stored' }, { status: 'stored' }, { status: 'stored' }, { status: 'stored' }] } });
    expect(s.f.partition(`${KEY_MARK}seed#smoke_check`)).toEqual([expect.objectContaining({ sk: '20261012T115900Z#33679229731-2-1', row_kind: 'smoke_check', source: 'collector' })]);
    expect(s.f.partition(`${KEY_MARK}seed#deploy`)).toEqual([expect.objectContaining({ sk: '20261012T115900Z#33679229731-2-1', row_kind: 'deploy', source: 'collector' })]);
    expect(s.f.partition(`${KEY_MARK}seed#review`)).toEqual([expect.objectContaining({ sk: '20261012T115900Z#33679229731-2-42', source: 'collector' })]);
    expect(s.f.partition(`${KEY_MARK}seed#finding`)).toEqual([expect.objectContaining({ sk: '20261012T115900Z#33679229731-2-3' })]);
    expect(s.f.partition(`${KEY_MARK}seed#work`)).toEqual([expect.objectContaining({ sk: 'pr-0000000042', fate: 'merged' })]);
    expect((await s.post([workRow({ fate: 'closed_unmerged' })])).status).toBe(200);
    expect(s.f.partition(`${KEY_MARK}seed#work`)).toEqual([expect.objectContaining({ sk: 'pr-0000000042', fate: 'closed_unmerged' })]);
  });

  it('the key is the registration\'s: a `key` parameter is ignored, and no row can name a partition', async () => {
    const s = store((f) => { seedRegistration(f); seedOther(f); });
    expect((await s.post([runRow()], { query: { key: `${KEY_MARK}other` } })).status).toBe(200);
    expect(s.f.partition(`${KEY_MARK}other#review`)).toEqual([]);
    expect(s.f.partition(`${KEY_MARK}seed#review`)).toHaveLength(1);
    const named = await s.post([runRow({ pk: `${KEY_MARK}other#review` })]);
    expect(named.status).toBe(422);
    expect(s.f.partition(`${KEY_MARK}other#review`)).toEqual([]);
  });

  it('422 per row, by field and rule; the valid rows are stored', async () => {
    const s = store((f) => seedRegistration(f));
    const r = await s.post([runRow(), runRow({ surplus_field: 'SECRET-CONTENT' })]);
    expect(r.status).toBe(422);
    expect(r.body.results).toEqual([{ status: 'stored' }, { status: 'rejected', errors: [{ field: 'surplus_field', problem: 'unknown' }] }]);
    expect(JSON.stringify(r.body) + s.logs.join('\n')).not.toContain('SECRET-CONTENT');
  });

  it('502 when a write fails', async () => {
    const s = store((f) => seedRegistration(f));
    s.f.before((op, body) => { if (op === 'PutItem' && body.TableName === ROWS) throw new Error('throttled'); });
    expect(await s.post([runRow()])).toMatchObject({ status: 502, body: { results: [{ status: 'failed' }] } });
  });

  it('404, 403 `suspended`, 410 `erased`', async () => {
    expect(await store().post([runRow()])).toMatchObject({ status: 404, body: { error: 'not-registered' } });
    const suspended = store((f) => seedRegistration(f, { status: 'suspended', suspended_at: '2026-10-11T00:00:00Z', suspended_reason: 'abuse' }));
    expect(await suspended.post([runRow()])).toMatchObject({ status: 403, body: { error: 'suspended' } });
    expect(suspended.f.partition(`${KEY_MARK}seed#review`)).toEqual([]);
    const erased = store((f) => seedRegistration(f, { status: 'erased', erased_at: '2026-10-12T11:00:00Z' }));
    expect(await erased.post([runRow()])).toMatchObject({ status: 410, body: { error: 'erased' } });
    expect(erased.f.partition(`${KEY_MARK}seed#review`)).toEqual([]);
  });

  it('a batch past the day\'s quota is refused whole, 429 with Retry-After, and counted in refused#…', async () => {
    const s = store((f) => {
      seedRegistration(f);
      f.seed(REGISTER, { pk: `count#${KEY_MARK}seed#2026-10-12`, n: QUOTAS.rows_per_day - 2 });
    });
    const batch = [runRow({ run_id: 1 }), runRow({ run_id: 2 }), runRow({ run_id: 3 })];
    const r = await s.post(batch);
    expect(r).toMatchObject({ status: 429, body: { error: 'quota', limit: 'rows_per_day', resets_at: '2026-10-13T00:00:00.000Z' } });
    expect(r.headers['retry-after']).toBe(String(12 * 3600));
    expect(s.f.partition(`${KEY_MARK}seed#review`)).toEqual([]);
    expect(s.f.get(REGISTER, `count#${KEY_MARK}seed#2026-10-12`)!.n).toBe(QUOTAS.rows_per_day - 2);
    expect(s.f.get(REGISTER, `refused#${KEY_MARK}seed#2026-10-12`)).toMatchObject({ n: 3, expires_at: T + 2 * 86_400 });
    // The two that fit go through alone.
    expect((await s.post(batch.slice(0, 2))).status).toBe(200);
    expect(s.f.get(REGISTER, `count#${KEY_MARK}seed#2026-10-12`)!.n).toBe(QUOTAS.rows_per_day);
  });

  it('the operator\'s own limit replaces the default, and rejected rows are not counted', async () => {
    const s = store((f) => seedRegistration(f, { quota_rows_per_day: 2 }));
    expect((await s.post([runRow({ run_id: 1 }), runRow({ run_id: 2, surplus: 1 })])).status).toBe(422);
    expect(s.f.get(REGISTER, `count#${KEY_MARK}seed#2026-10-12`)!.n).toBe(1);
    expect((await s.post([runRow({ run_id: 3 })])).status).toBe(200);
    expect((await s.post([runRow({ run_id: 4 })])).status).toBe(429);
  });

  it('429 `requests_per_hour` past 120 requests in the hour, on every endpoint, with its rows counted as refused', async () => {
    const s = store((f) => {
      seedRegistration(f);
      f.seed(REGISTER, { pk: `count#${KEY_MARK}seed#2026-10-12T12`, n: QUOTAS.requests_per_hour });
    });
    const r = await s.post([runRow(), runRow({ run_id: 2 })]);
    expect(r).toMatchObject({ status: 429, body: { limit: 'requests_per_hour', resets_at: '2026-10-12T13:00:00.000Z' } });
    expect(r.headers['retry-after']).toBe('3600');
    expect(s.f.get(REGISTER, `refused#${KEY_MARK}seed#2026-10-12`)!.n).toBe(2);
    expect((await s.status()).status).toBe(429);
    expect((await s.read({ lane: 'review' })).status).toBe(429);
    expect((await s.register()).status).toBe(429);
    expect((await s.erase()).status).toBe(429);
    expect(s.registration()!.status).toBe('active');
  });

  it('413 and 400 for the body, as today', async () => {
    const s = store((f) => seedRegistration(f));
    expect(await s.post(null, { raw: `[${' '.repeat(256 * 1024)}]` })).toMatchObject({ status: 413, body: { error: 'body-size' } });
    expect(await s.post(null, { raw: '{not json' })).toMatchObject({ status: 400, body: { error: 'body-json' } });
    expect(await s.post(Array.from({ length: 26 }, (_, i) => runRow({ run_id: i + 1 })))).toMatchObject({ status: 400, body: { error: 'body-rows' } });
  });

  it('only the collector writes: the Overseer\'s token is refused, 403 `workflow`', async () => {
    const s = store((f) => seedRegistration(f));
    expect(await s.post([runRow()], { claims: { job_workflow_ref: OVERSEER } })).toMatchObject({ status: 403, body: { error: 'workflow' } });
  });
});

describe('the name hashes come from the token (§3.4)', () => {
  const withText = (evidence: string) => findingRow({
    subject: 'lane', lane: 'review', reason: 'did_not_finish', evidence_level: 'evidence', evidence,
    suggested_fix: 'Cap the re-reads in the review prompt.', scrub_version: 1,
  });

  it('a word of the token\'s repository is refused in a finding, whatever the registration holds', async () => {
    // The registration still holds an older name; the token's is current.
    const s = store((f) => seedRegistration(f, { repository: 'zorblax/quintet', name_hashes: [...nameContext({ repository: 'zorblax/quintet' })].sort() }));
    const own = await s.post([withText('Observed: the widget lane stopped at stage `agent`.')]);
    expect(own.body.results[0].errors).toEqual([{ field: 'evidence', problem: 'name' }]);
    expect((await s.post([withText('Observed: the zorblax lane stopped at stage `agent`.')])).status).toBe(200);
    // And the registration's name and hashes follow the token.
    expect(s.registration()).toMatchObject({ repository: NAME, name_hashes: [...nameContext({ repository: NAME })].sort() });
  });

  it('a token with no `repository` stores no finding: the sender\'s check can\'t run', async () => {
    const s = store((f) => seedRegistration(f));
    const c = claims();
    delete c.repository;
    const r = await s.post([findingRow()], { token: tokenOf(c) });
    expect(r.body.results[0].errors).toEqual([{ field: 'row_kind', problem: 'no-sender-context' }]);
  });

  it('a registered key in a finding is refused, another\'s as the sender\'s own', async () => {
    const s = store((f) => { seedRegistration(f); seedOther(f); });
    const other = await s.post([withText(`Observed: the row named ${KEY_MARK}other as its partition.`)]);
    expect(other.body.results[0].errors).toEqual([{ field: 'evidence', problem: 'key' }]);
    const own = await s.post([withText(`Observed: the row named ${KEY_MARK}seed as its partition.`)]);
    expect(own.body.results[0].errors).toEqual([{ field: 'evidence', problem: 'key' }]);
  });
});

describe('GET /v1/rows/self (§3.2, §3.5)', () => {
  const runFields = [...new Set(Object.values(SCHEMAS.run!).flatMap((v) => Object.keys(v)))];

  it('200: its own rows only, never another key\'s, and never one past expires_at', async () => {
    const s = store((f) => {
      seedRegistration(f);
      seedOther(f);
      seedRow(f, `${KEY_MARK}seed`, 'review', { run_id: 1 });
      seedRow(f, `${KEY_MARK}seed`, 'review', { run_id: 2, expires_at: T - 1 });
      seedRow(f, `${KEY_MARK}other`, 'review', { run_id: 3 });
    });
    const r = await s.read({ lane: 'review' });
    expect(r.status).toBe(200);
    expect(r.body.rows.map((x: J) => x.run_id)).toEqual([1]);
    // A `key` parameter is ignored: the key is the registration's.
    const named = await s.read({ lane: 'review', key: `${KEY_MARK}other` });
    expect(named.body.rows.map((x: J) => x.run_id)).toEqual([1]);
    // The read ran under a session whose LeadingKeys is the caller's key alone.
    expect([...s.f.sessions.values()].every((p) => JSON.stringify(p) === JSON.stringify(sessionPolicy(ENV, `${KEY_MARK}seed`, ['dynamodb:Query'])))).toBe(true);
    expect(s.f.calls.filter((c) => c.op === 'Query').every((c) => c.session)).toBe(true);
  });

  it('with no fields and no window: every schema field the row has, over thirteen months, run-tagged', async () => {
    const s = store((f) => {
      seedRegistration(f);
      seedRow(f, `${KEY_MARK}seed`, 'review', { run_id: 1, recorded_at: iso(addMonths(NOW, -13) + DAY), total_cost_usd: 0.5, model: 'claude-opus' });
      seedRow(f, `${KEY_MARK}seed`, 'review', { run_id: 2, recorded_at: iso(addMonths(NOW, -13) - DAY) });
      seedRow(f, `${KEY_MARK}seed`, 'review', { run_id: 3, tag: 'smoke' });
    });
    const r = await s.read({ lane: 'review' });
    expect(r.body.rows.map((x: J) => x.run_id)).toEqual([1]);
    const row = r.body.rows[0];
    expect(row).toMatchObject({ total_cost_usd: 0.5, model: 'claude-opus', lane: 'review', kanon_version: '0.40.0' });
    for (const k of Object.keys(row)) expect(runFields).toContain(k);
    for (const k of ['pk', 'sk', 'source', 'received_at', 'expires_at']) expect(row).not.toHaveProperty(k);
    expect((await s.read({ lane: 'review', tag: 'smoke' })).body.rows.map((x: J) => x.run_id)).toEqual([3]);
  });

  it('`work`, `fields` and a window', async () => {
    const s = store((f) => {
      seedRegistration(f);
      seedRow(f, `${KEY_MARK}seed`, 'work', { pr_number: 1, changed_lines: 10 });
      seedRow(f, `${KEY_MARK}seed`, 'work', { pr_number: 2, recorded_at: iso(NOW - 40 * DAY) });
      seedRow(f, `${KEY_MARK}seed`, 'review', { run_id: 7, recorded_at: iso(NOW - 3 * DAY) });
      seedRow(f, `${KEY_MARK}seed`, 'review', { run_id: 8, recorded_at: iso(NOW - 30 * DAY) });
    });
    const work = await s.read({ lane: 'work', fields: 'pr_number,changed_lines' });
    expect(work.body.rows).toEqual([{ pr_number: 1, changed_lines: 10 }, { pr_number: 2 }]);
    const recent = await s.read({ lane: 'review', from: iso(NOW - 14 * DAY), fields: 'run_id' });
    expect(recent.body.rows).toEqual([{ run_id: 7 }]);
  });

  it('400 `lane`, `fields`, `window`, `tag`, `cursor`', async () => {
    const s = store((f) => seedRegistration(f));
    for (const lane of ['finding', 'nope', '']) expect(await s.read({ lane }), lane).toMatchObject({ status: 400, body: { error: 'lane' } });
    expect(await s.read({})).toMatchObject({ status: 400, body: { error: 'lane' } });
    for (const fields of ['pk', 'sk', 'expires_at', 'source', 'run_id,run_id', '', 'fate']) {
      expect(await s.read({ lane: 'review', fields }), fields).toMatchObject({ status: 400, body: { error: 'fields' } });
    }
    expect(await s.read({ lane: 'work', fields: 'model' })).toMatchObject({ status: 400, body: { error: 'fields' } });
    const windows: Array<Record<string, string>> = [{ from: 'yesterday' }, { to: '2026-13-01T00:00:00Z' }, { from: iso(NOW), to: iso(NOW - DAY) }];
    for (const w of windows) {
      expect(await s.read({ lane: 'review', ...w })).toMatchObject({ status: 400, body: { error: 'window' } });
    }
    expect(await s.read({ lane: 'review', tag: 'other' })).toMatchObject({ status: 400, body: { error: 'tag' } });
    expect(await s.read({ lane: 'review', cursor: 'x'.repeat(60) })).toMatchObject({ status: 400, body: { error: 'cursor' } });
  });

  it('pages of at most 1,000 rows, with a cursor that holds no key in clear and can\'t be pointed at another partition', async () => {
    const s = store((f) => {
      seedRegistration(f);
      seedOther(f);
      for (let i = 0; i < PAGE_ROWS + 5; i += 1) seedRow(f, `${KEY_MARK}seed`, 'review', { run_id: 1000 + i });
      seedRow(f, `${KEY_MARK}other`, 'review', { run_id: 1 });
    });
    const first = await s.read({ lane: 'review', fields: 'run_id' });
    expect(first.body.rows).toHaveLength(PAGE_ROWS);
    expect(typeof first.body.cursor).toBe('string');
    expect(Buffer.from(first.body.cursor, 'base64url').toString('latin1')).not.toContain(KEY_MARK);
    const second = await s.read({ lane: 'review', fields: 'run_id', cursor: first.body.cursor });
    expect(second.body.rows).toHaveLength(5);
    expect(second.body).not.toHaveProperty('cursor');
    // The same cursor on another lane is refused; one changed by a bit is refused.
    expect(await s.read({ lane: 'implement', cursor: first.body.cursor })).toMatchObject({ status: 400, body: { error: 'cursor' } });
    const bytes = Buffer.from(first.body.cursor, 'base64url');
    bytes[bytes.length - 1]! ^= 1;
    expect(await s.read({ lane: 'review', cursor: bytes.toString('base64url') })).toMatchObject({ status: 400, body: { error: 'cursor' } });
    // Sealed under CURSOR_KEY: opened with it, it names this partition.
    expect(openCursor(Buffer.from(ENV.CURSOR_KEY, 'hex'), first.body.cursor).p).toBe(`${KEY_MARK}seed#review`);
  });

  it('only the Overseer reads: the collector\'s token is refused; 404, 403 `suspended`; 503 `config` without its key', async () => {
    const s = store((f) => seedRegistration(f));
    expect(await s.read({ lane: 'review' }, { claims: { job_workflow_ref: COLLECT } })).toMatchObject({ status: 403, body: { error: 'workflow' } });
    expect(await store().read({ lane: 'review' })).toMatchObject({ status: 404, body: { error: 'not-registered' } });
    const suspended = store((f) => seedRegistration(f, { status: 'suspended', suspended_at: '2026-10-11T00:00:00Z', suspended_reason: 'abuse' }));
    expect(await suspended.read({ lane: 'review' })).toMatchObject({ status: 403, body: { error: 'suspended' } });
    const res: J = await handle({ rawPath: '/v1/rows/self', requestContext: { http: { method: 'GET' } }, headers: { authorization: `Bearer ${tokenOf(claims({ job_workflow_ref: OVERSEER }))}` }, queryStringParameters: { lane: 'review' } },
      { ...s.deps(LIVE), env: { ...ENV, CURSOR_KEY: '' } });
    expect(res.statusCode).toBe(503);
  });
});

describe('the routes, and the two URLs (§3.1, §9)', () => {
  it('404 `route` and 405 `method`', async () => {
    const s = store((f) => seedRegistration(f));
    expect(await s.call({ method: 'GET', path: '/v1/nothing' })).toMatchObject({ status: 404, body: { error: 'route' } });
    expect(await s.call({ method: 'GET', path: '/v1/registrations' })).toMatchObject({ status: 405, body: { error: 'method' } });
    expect(await s.call({ method: 'PUT', path: '/v1/rows' })).toMatchObject({ status: 405, body: { error: 'method' } });
  });

  it('503 `config` without an audience or a version floor: no token is admitted', async () => {
    const s = store((f) => seedRegistration(f));
    for (const env of [{ ...ENV, AUDIENCE: '' }, { ...ENV, MIN_TOKEN_VERSION: '' }]) {
      const res: J = await handle({ rawPath: '/v1/rows', requestContext: { http: { method: 'POST' } }, headers: { authorization: `Bearer ${tokenOf(claims())}` }, body: '[]' },
        { ...s.deps(LIVE), env });
      expect(res.statusCode).toBe(503);
    }
  });

  it('an IAM-authenticated request on the alias\'s URL is refused, and nothing is stored', async () => {
    const s = store((f) => seedRegistration(f, { key: `${KEY_MARK}0001` }));
    const r = await s.post([runRow()], { iam: true, token: null });
    expect(r).toMatchObject({ status: 403, body: { error: 'path' } });
    expect(s.f.all(ROWS)).toEqual([]);
  });

  it('the unqualified function, which has no URL since J9, refuses a bearer token and a SigV4 request alike, and nothing is stored', async () => {
    const s = store((f) => seedRegistration(f));
    expect(await s.post([runRow()], { arn: FN })).toMatchObject({ status: 403, body: { error: 'path' } });
    expect(await s.post([runRow()], { arn: FN, iam: true })).toMatchObject({ status: 403, body: { error: 'path' } });
    expect(s.f.all(ROWS)).toEqual([]);
  });

  it('any other qualifier, or none that is a function\'s, is refused; the unqualified function never runs the walk', async () => {
    const s = store((f) => { seedRegistration(f, { status: 'erased', erased_at: '2026-10-12T11:00:00Z' }); seedRow(f, `${KEY_MARK}seed`, 'review'); });
    for (const arn of [`${FN}:$LATEST`, `${FN}:importer`, `${FN}:3`, 'not-an-arn']) {
      expect(await s.post([runRow()], { arn }), arn).toMatchObject({ status: 403, body: { error: 'path' } });
    }
    const direct: J = await handle({ kanon_erase: { repository_id: REPO } }, s.deps(FN));
    expect(direct.statusCode).toBe(403);
    expect(s.f.partition(`${KEY_MARK}seed#review`)).toHaveLength(1);
  });
});

describe('the operator\'s fields survive every write the function makes (register-fields.mjs)', () => {
  it('through a registration, a status read, rows written and read, a renamed repository and a moved branch, and an erasure, until the tombstone', async () => {
    const s = store((f) => seedRegistration(f, { ...OPERATOR, last_seen_at: iso(NOW - 2 * 3_600_000) }));
    const operatorOf = () => Object.fromEntries(OPERATOR_FIELDS.filter((k) => s.registration()![k] !== undefined).map((k) => [k, s.registration()![k]]));
    const before = operatorOf();
    expect(Object.keys(before).sort()).toEqual(Object.keys(OPERATOR).sort());
    // A schedule on a renamed branch, from a renamed repository: both are written back.
    const moved = { ref: 'refs/heads/trunk', repository: 'acme-corp/widget-store' };
    const steps: Array<() => Promise<{ status: number }>> = [
      () => s.register({ path: '', claims: moved }),
      () => s.status({ claims: moved }),
      () => s.post([runRow(), workRow(), findingRow()], { claims: moved }),
      () => s.read({ lane: 'review' }, { claims: { job_workflow_ref: OVERSEER, ...moved } }),
      () => s.erase({ claims: moved }),
    ];
    for (const step of steps) {
      expect((await step()).status).toBeLessThan(300);
      expect(operatorOf()).toEqual(before);
    }
    // The function's own fields moved, and were written.
    expect(s.registration()).toMatchObject({ default_ref: 'refs/heads/trunk', repository: 'acme-corp/widget-store', status: 'erased', last_seen_at: new Date(NOW).toISOString() });
    // IAM never had to refuse a write: none of the function's names an operator field.
    expect(s.logs.join('\n')).not.toContain('AccessDenied');
  });

  it('a suspended registration keeps its suspension through every endpoint\'s call', async () => {
    const s = store((f) => seedRegistration(f, { ...OPERATOR, status: 'suspended', suspended_at: '2026-10-11T00:00:00Z', suspended_reason: 'abuse' }));
    await s.register({ path: '', claims: { ref: 'refs/heads/trunk' } });
    await s.status();
    await s.post([runRow()]);
    await s.read({ lane: 'review' });
    await s.erase();
    expect(s.registration()).toMatchObject({ status: 'suspended', suspended_at: '2026-10-11T00:00:00Z', suspended_reason: 'abuse', default_ref: 'refs/heads/main', ...OPERATOR });
  });
});

describe('the AWS calls behind the token path (function/aws.mjs)', () => {
  const capture = (status: number, body: string) => {
    const seenReq: Array<{ url: string, init: RequestInit }> = [];
    const impl = (async (url: string, init: RequestInit) => {
      seenReq.push({ url, init });
      return new Response(status === 202 || status === 204 ? null : body, { status });
    }) as unknown as typeof fetch;
    return { impl, seenReq };
  };

  it('AssumeRole sends the session policy and reads the credentials from STS\'s answer', async () => {
    const xml = '<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>ASIA0000</AccessKeyId><SecretAccessKey>s3cret</SecretAccessKey><SessionToken>tok</SessionToken></Credentials></AssumeRoleResult></AssumeRoleResponse>';
    const c = capture(200, xml);
    const policy = sessionPolicy(ENV, `${KEY_MARK}seed`, ['dynamodb:Query']);
    const creds = await stsOf({ AWS_REGION: 'eu-central-1' }, c.impl)({ roleArn: ENV.SELF_READ_ROLE, sessionName: 'kanon-telemetry-self', policy });
    expect(creds).toEqual({ accessKeyId: 'ASIA0000', secretAccessKey: 's3cret', sessionToken: 'tok' });
    expect(c.seenReq[0]!.url).toBe('https://sts.eu-central-1.amazonaws.com/');
    const form = new URLSearchParams(String(c.seenReq[0]!.init.body));
    expect(form.get('Action')).toBe('AssumeRole');
    expect(JSON.parse(form.get('Policy')!)).toEqual(policy);
    // The session's name, which CloudTrail keeps, names no key.
    expect(form.get('RoleSessionName')).toBe('kanon-telemetry-self');
    await expect(stsOf({}, capture(403, '<Error><Code>AccessDenied</Code></Error>').impl)({ roleArn: 'r', sessionName: 's', policy: {} }))
      .rejects.toThrow('AssumeRole failed: AccessDenied');
  });

  it('the session policy holds every action to the key\'s partitions on the rows table alone', () => {
    expect(sessionPolicy(ENV, `${KEY_MARK}seed`, ['dynamodb:Query'])).toEqual({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow', Action: ['dynamodb:Query'], Resource: `arn:aws:dynamodb:eu-central-1:${ACCOUNT}:table/kanon-telemetry`,
        Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${KEY_MARK}seed#*`] } },
      }],
    });
  });

  it('the walk is started as an asynchronous Invoke of the `erase` alias', async () => {
    const c = capture(202, '');
    await invokeOf({ AWS_REGION: 'eu-central-1' }, c.impl)('kanon-telemetry-ingest', 'erase', { kanon_erase: { repository_id: REPO } });
    expect(c.seenReq[0]!.url).toBe('https://lambda.eu-central-1.amazonaws.com/2015-03-31/functions/kanon-telemetry-ingest/invocations?Qualifier=erase');
    expect((c.seenReq[0]!.init.headers as Record<string, string>)['x-amz-invocation-type']).toBe('Event');
    await expect(invokeOf({}, capture(200, '').impl)('f', 'erase', {})).rejects.toThrow('Invoke failed: HTTP200');
  });

  it('a cancelled transaction names each item\'s reason, and nothing of the request', async () => {
    const body = JSON.stringify({ __type: 'com.amazonaws.dynamodb.v20120810#TransactionCanceledException', message: `${KEY_MARK}seed`, CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }] });
    const err = await dynamoOf({}, capture(400, body).impl)('TransactWriteItems', {}).catch((e: unknown) => e) as { message: string, code: string, reasons: string[] };
    expect(err).toMatchObject({ code: 'TransactionCanceledException', reasons: ['ConditionalCheckFailed', 'None'] });
    expect(err.message).not.toContain(KEY_MARK);
  });
});
