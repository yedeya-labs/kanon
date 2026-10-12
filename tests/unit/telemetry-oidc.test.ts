import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  ENDPOINT_WORKFLOWS,
  ISSUER,
  JWKS_URL,
  keyCache,
  verifyToken,
} from '../../infra/telemetry/function/oidc.mjs';

/**
 * Plan 0008 step J1: the OIDC token verifier (§2.2 to §2.5), which J3's endpoints stand behind.
 * Every token here is signed in the test with a key pair generated in the test, and GitHub's
 * JWKS endpoint is a fake `fetch`, so no fixture holds a real token and nothing leaves the
 * process. Each row of §2.5's mutation table but the last four (the metrics page exception,
 * J4's) has its own test below, titled with the row it holds.
 */

type Claims = Record<string, unknown>;
type Header = Record<string, unknown>;

const NOW = Date.parse('2026-10-12T12:00:00Z');
const T = NOW / 1000;
const MINUTE = 60_000;
const AUDIENCE = 'kanon-telemetry';
const MIN_VERSION = '0.40.0';
const OWNER = '7890';
const REPO = '123456';
const COLLECT = 'yedeya-labs/kanon/.github/workflows/telemetry-collect.yml';
const OVERSEER = 'yedeya-labs/kanon/.github/workflows/agent-overseer.yml';
const EXPLORE = 'yedeya-labs/kanon/.github/workflows/agent-explore-telemetry.yml';

const pair = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const listed = pair();
const rotated = pair();
const unlisted = pair();
const jwk = (key: KeyObject, kid: string, over: Record<string, unknown> = {}) => ({ ...key.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256', ...over });

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (claims: Claims, { header = {}, key = listed.privateKey }: { header?: Header, key?: KeyObject } = {}) => {
  const input = `${b64({ typ: 'JWT', alg: 'RS256', kid: 'listed', ...header })}.${b64(claims)}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
};
const claims = (over: Claims = {}): Claims => ({
  iss: ISSUER, aud: AUDIENCE,
  // GitHub's one documented example: `exp = iat + 300`, `nbf = iat - 600` (§4.2).
  iat: T - 30, nbf: T - 630, exp: T + 270,
  event_name: 'schedule', job_workflow_ref: `${COLLECT}@refs/tags/v0.40.0`,
  repository_id: REPO, repository_owner_id: OWNER, repository: 'octo/widget', ref: 'refs/heads/main', ref_type: 'branch',
  sub: 'repo:octo/widget:ref:refs/heads/main',
  ...over,
});
/** A valid token minted for a request `ms` after `NOW`, for the cache's tests that move the clock. */
const tokenAt = (ms: number) => {
  const at = T + Math.floor(ms / 1000);
  return token(claims({ iat: at - 30, nbf: at - 630, exp: at + 270 }));
};
const without = (name: string) => {
  const c = claims();
  delete c[name];
  return c;
};

const jwks = (...keys: unknown[]) => new Response(JSON.stringify({ keys }), { status: 200 });
/** A fake `fetch` for GitHub's JWKS: answers from `answers` in turn, then repeats the last. */
const fakeFetch = (...answers: Array<() => Response | Promise<Response>>) => {
  const calls: Array<{ url: string, signal?: AbortSignal }> = [];
  const impl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), signal: init?.signal ?? undefined });
    return answers[Math.min(calls.length, answers.length) - 1]!();
  };
  return { impl, calls };
};
const up = () => jwks(jwk(listed.publicKey, 'listed'));
const down = () => { throw new TypeError('fetch failed'); };

const registrations: Record<string, { repository_owner_id: string, default_ref: string }> = {
  [REPO]: { repository_owner_id: OWNER, default_ref: 'refs/heads/main' },
};
const registrationOf = async (id: string) => registrations[id];

const verify = (t: unknown, over: Record<string, unknown> = {}) => verifyToken(t, {
  audience: AUDIENCE, endpoint: 'POST /v1/rows', now: NOW, minTokenVersion: MIN_VERSION,
  keys: keyCache({ fetchImpl: fakeFetch(up).impl }), registrationOf, ...over,
});
const refused = (status: number, error: string) => ({ ok: false, status, error });

describe('a valid token', () => {
  it('passes, and answers the checked claims and the registration', async () => {
    const r = await verify(token(claims()));
    expect(r).toEqual({
      ok: true,
      caller: {
        repository_id: REPO, repository_owner_id: OWNER, ref: 'refs/heads/main', event_name: 'schedule',
        workflow: 'telemetry-collect.yml', version: '0.40.0', repository: 'octo/widget',
      },
      registration: registrations[REPO],
      ref_moved: false,
    });
  });

  it('passes from a dispatch, as from a schedule', async () => {
    expect(await verify(token(claims({ event_name: 'workflow_dispatch' })))).toMatchObject({ ok: true });
  });

  it('passes with an audience given as an array of exactly that one value', async () => {
    expect(await verify(token(claims({ aud: [AUDIENCE] })))).toMatchObject({ ok: true });
  });

  it('passes inside the 60 s skew on exp, nbf and iat', async () => {
    expect(await verify(token(claims({ exp: T - 59 })))).toMatchObject({ ok: true });
    expect(await verify(token(claims({ nbf: T + 59 })))).toMatchObject({ ok: true });
    expect(await verify(token(claims({ iat: T + 59 })))).toMatchObject({ ok: true });
    expect(await verify(token(claims({ iat: T - 599 })))).toMatchObject({ ok: true });
  });

  it('passes at a release above the floor, compared as numbers, not as text', async () => {
    for (const v of ['0.40.1', '0.100.0', '1.0.0']) {
      expect(await verify(token(claims({ job_workflow_ref: `${COLLECT}@refs/tags/v${v}` }))), v).toMatchObject({ ok: true, caller: { version: v } });
    }
  });
});

describe('§2.5: every check fails closed, and each one can fail', () => {
  it('`alg` not checked: a token with `alg: none`, and one with HS256 signed with the public key as an HMAC secret, are refused', async () => {
    const input = (alg: string) => `${b64({ typ: 'JWT', alg, kid: 'listed' })}.${b64(claims())}`;
    expect(await verify(`${input('none')}.`)).toEqual(refused(401, 'alg'));
    const secret = listed.publicKey.export({ format: 'pem', type: 'spki' });
    const hs = `${input('HS256')}.${createHmac('sha256', secret).update(input('HS256')).digest('base64url')}`;
    expect(await verify(hs)).toEqual(refused(401, 'alg'));
    expect(await verify(token(claims(), { header: { alg: 'RS512' } }))).toEqual(refused(401, 'alg'));
  });

  it('`kid` not checked: a token with no `kid`, or an empty one, is refused before any key is looked up', async () => {
    const fetch = fakeFetch(up);
    const keys = keyCache({ fetchImpl: fetch.impl });
    expect(await verify(token(claims(), { header: { kid: undefined } }), { keys })).toEqual(refused(401, 'alg'));
    expect(await verify(token(claims(), { header: { kid: '' } }), { keys })).toEqual(refused(401, 'alg'));
    expect(await verify(token(claims(), { header: { kid: 7 } }), { keys })).toEqual(refused(401, 'alg'));
    expect(fetch.calls).toHaveLength(0);
  });

  it('signature not verified: a token whose payload changed after signing is refused', async () => {
    const [h, , s] = token(claims()).split('.');
    const forged = `${h}.${b64(claims({ repository_id: '999' }))}.${s}`;
    expect(await verify(forged)).toEqual(refused(401, 'signature'));
  });

  it('unknown `kid` accepted from another key: a token naming an unlisted `kid` is refused, even when a listed key signed it', async () => {
    expect(await verify(token(claims(), { header: { kid: 'unlisted' } }))).toEqual(refused(401, 'kid'));
  });

  it('a token signed by an unlisted key, with a listed `kid`, is refused', async () => {
    expect(await verify(token(claims(), { key: unlisted.privateKey }))).toEqual(refused(401, 'signature'));
  });

  it('`iss` compared by prefix: `https://token.actions.githubusercontent.com.evil` is refused', async () => {
    for (const iss of [`${ISSUER}.evil`, `${ISSUER}/`, 'https://token.actions.githubusercontent.co']) {
      expect(await verify(token(claims({ iss }))), iss).toEqual(refused(401, 'iss'));
    }
  });

  it('`aud` not checked, or `includes` on an array: the owner-URL audience, `sts.amazonaws.com`, and `["kanon-telemetry", "x"]` are refused', async () => {
    for (const aud of ['https://github.com/octo', 'sts.amazonaws.com', [AUDIENCE, 'x'], ['x', AUDIENCE], [], `${AUDIENCE}-wrong`]) {
      expect(await verify(token(claims({ aud }))), JSON.stringify(aud)).toEqual(refused(401, 'aud'));
    }
  });

  it('`exp` skew widened past 60 s, or dropped: a token expired 61 s ago is refused', async () => {
    expect(await verify(token(claims({ exp: T - 61 })))).toEqual(refused(401, 'time'));
  });

  it('`nbf` dropped: a token not valid for another 61 s is refused', async () => {
    expect(await verify(token(claims({ nbf: T + 61 })))).toEqual(refused(401, 'time'));
  });

  it('`iat` maximum age dropped: a token issued 601 s ago with a far `exp` is refused', async () => {
    expect(await verify(token(claims({ iat: T - 601, exp: T + 3600 })))).toEqual(refused(401, 'time'));
  });

  it('`iat` in the future: a token issued 61 s from now is refused', async () => {
    expect(await verify(token(claims({ iat: T + 61 })))).toEqual(refused(401, 'time'));
  });

  it('the times are integers: a string or fractional `exp`, `nbf` or `iat` is refused', async () => {
    for (const [name, value] of [['exp', String(T + 270)], ['exp', T + 270.5], ['nbf', String(T - 630)], ['iat', String(T - 30)]] as const) {
      expect(await verify(token(claims({ [name]: value }))), `${name}: ${JSON.stringify(value)}`).toEqual(refused(401, 'time'));
    }
  });

  it('`event_name` as a deny-list: `push` and `dynamic` are refused, as `pull_request` and `pull_request_target` are', async () => {
    for (const event_name of ['push', 'dynamic', 'pull_request', 'pull_request_target', 'merge_group', 'Schedule', ['schedule']]) {
      expect(await verify(token(claims({ event_name }))), JSON.stringify(event_name)).toEqual(refused(403, 'event'));
    }
  });

  it('`job_workflow_ref` repository or path not anchored: another owner, a fork and a `.bak` file are refused', async () => {
    for (const ref of [
      'evil/kanon/.github/workflows/telemetry-collect.yml@refs/tags/v9.0.0',
      'yedeya-labs/kanon-fork/.github/workflows/telemetry-collect.yml@refs/tags/v9.0.0',
      `${COLLECT}.bak@refs/tags/v9.0.0`,
      `x${COLLECT}@refs/tags/v9.0.0`,
      'yedeya-labs/kanon/.github/workflows/sub/telemetry-collect.yml@refs/tags/v9.0.0',
      'yedeya-labs/kanon/.github/workflows/x-telemetry-collect.yml@refs/tags/v9.0.0',
    ]) {
      expect(await verify(token(claims({ job_workflow_ref: ref }))), ref).toEqual(refused(403, 'workflow'));
    }
  });

  it('`job_workflow_ref` ref not checked: a branch, a pull request ref, a SHA and a pre-release tag are refused', async () => {
    for (const at of ['refs/heads/main', 'refs/pull/1/merge', 'a'.repeat(40), 'refs/tags/v9.0.0-rc.1', 'refs/tags/v9.0', 'refs/tags/9.0.0', 'refs/tags/v9.0.0x', 'refs/tags/v09.0.0']) {
      expect(await verify(token(claims({ job_workflow_ref: `${COLLECT}@${at}` }))), at).toEqual(refused(403, 'workflow'));
    }
  });

  it('version floor dropped: a release below `MIN_TOKEN_VERSION` is refused', async () => {
    for (const v of ['0.39.9', '0.39.100', '0.4.0', '0.0.40']) {
      expect(await verify(token(claims({ job_workflow_ref: `${COLLECT}@refs/tags/v${v}` }))), v).toEqual(refused(403, 'workflow'));
    }
  });

  it('endpoint\'s workflow not checked: the Overseer\'s token on `POST /v1/rows` is refused', async () => {
    expect(await verify(token(claims({ job_workflow_ref: `${OVERSEER}@refs/tags/v0.40.0` })))).toEqual(refused(403, 'workflow'));
  });

  it('each endpoint admits exactly the workflows of §2.2\'s table', async () => {
    const all = ['telemetry-collect.yml', 'agent-overseer.yml', 'agent-explore-telemetry.yml', 'metrics-page.yml', 'telemetry-verify.yml'];
    const expected: Record<string, string[]> = {
      'POST /v1/registrations': ['telemetry-collect.yml'],
      'GET /v1/registrations/self': ['telemetry-collect.yml', 'agent-overseer.yml', 'agent-explore-telemetry.yml'],
      'DELETE /v1/registrations/self': ['telemetry-collect.yml'],
      'POST /v1/rows': ['telemetry-collect.yml'],
      'GET /v1/rows/self': ['agent-overseer.yml'],
      aggregate: ['agent-explore-telemetry.yml'],
    };
    expect(Object.keys(ENDPOINT_WORKFLOWS).sort()).toEqual(Object.keys(expected).sort());
    for (const [endpoint, files] of Object.entries(expected)) {
      for (const file of all) {
        const r = await verify(token(claims({ job_workflow_ref: `yedeya-labs/kanon/.github/workflows/${file}@refs/tags/v0.40.0` })), { endpoint });
        expect(r, `${file} on ${endpoint}`).toMatchObject(files.includes(file) ? { ok: true } : refused(403, 'workflow'));
      }
    }
    expect(await verify(token(claims({ job_workflow_ref: `${EXPLORE}@refs/tags/v0.40.0` })), { endpoint: 'aggregate' })).toMatchObject({ ok: true });
  });

  it('`repository_owner_id` not compared: a registered `repository_id` under another owner id is refused', async () => {
    expect(await verify(token(claims({ repository_owner_id: '7891' })))).toEqual(refused(403, 'owner'));
  });

  it('a `repository_id` with no registration is refused, on every endpoint but registration', async () => {
    for (const [endpoint, files] of Object.entries(ENDPOINT_WORKFLOWS).filter(([e]) => e !== 'POST /v1/registrations')) {
      const file = files[0]!;
      const r = await verify(token(claims({ repository_id: '654321', job_workflow_ref: `yedeya-labs/kanon/.github/workflows/${file}@refs/tags/v0.40.0` })), { endpoint });
      expect(r, endpoint).toEqual(refused(404, 'not-registered'));
    }
  });

  it('the ids are decimal strings: a number, a leading zero, a sign or 21 digits is refused', async () => {
    for (const [name, value] of [
      ['repository_id', 123456], ['repository_id', '0123456'], ['repository_id', '+123456'], ['repository_id', '1'.repeat(21)], ['repository_id', '12 34'],
      ['repository_owner_id', 7890], ['repository_owner_id', '07890'], ['repository_owner_id', '-7890'], ['repository_owner_id', ''],
    ] as const) {
      const r = await verify(token(claims({ [name]: value })), { endpoint: 'POST /v1/registrations' });
      expect(r, `${name}: ${JSON.stringify(value)}`).toEqual(refused(403, 'owner'));
    }
  });

  it('registration reads no registration, and answers the token\'s ids and ref for it to record', async () => {
    let looked = 0;
    const r = await verify(token(claims({ repository_id: '654321', repository_owner_id: '1' })), {
      endpoint: 'POST /v1/registrations', registrationOf: async () => { looked += 1; return undefined; },
    });
    expect(r).toMatchObject({ ok: true, caller: { repository_id: '654321', repository_owner_id: '1', ref: 'refs/heads/main' }, registration: undefined });
    expect(looked).toBe(0);
  });

  it('`ref` not compared: a dispatch token on another branch of a registered repository is refused', async () => {
    expect(await verify(token(claims({ event_name: 'workflow_dispatch', ref: 'refs/heads/other' })))).toEqual(refused(403, 'ref'));
  });

  it('a schedule token on another branch is admitted, and says the default branch moved (§2.3: a rename heals on the next schedule)', async () => {
    expect(await verify(token(claims({ ref: 'refs/heads/trunk' })))).toMatchObject({ ok: true, caller: { ref: 'refs/heads/trunk' }, ref_moved: true });
  });

  it('a tombstone (§7: erased, no key, no default ref) holds `ref` to a branch\'s form only, so it can answer that it is erased (J3)', async () => {
    const tombstone = async () => ({ repository_owner_id: OWNER, status: 'erased' });
    const dispatch = token(claims({ event_name: 'workflow_dispatch', ref: 'refs/heads/other' }));
    expect(await verify(dispatch, { registrationOf: tombstone })).toMatchObject({ ok: true, ref_moved: false });
    // Still a branch, and still the registered owner.
    expect(await verify(token(claims({ ref_type: 'tag' })), { registrationOf: tombstone })).toEqual(refused(403, 'ref'));
    expect(await verify(token(claims({ repository_owner_id: '1' })), { registrationOf: tombstone })).toEqual(refused(403, 'owner'));
    // An erasure still walking (erased, its key kept) and a registration without a default ref are not tombstones.
    const walking = async () => ({ repository_owner_id: OWNER, status: 'erased', key: 'k_test', default_ref: 'refs/heads/main' });
    expect(await verify(dispatch, { registrationOf: walking })).toEqual(refused(403, 'ref'));
    const keyed = async () => ({ repository_owner_id: OWNER, status: 'erased', key: 'k_test' });
    expect(await verify(dispatch, { registrationOf: keyed })).toEqual(refused(403, 'ref'));
    expect(await verify(dispatch, { registrationOf: async () => ({ repository_owner_id: OWNER, status: 'active' }) })).toEqual(refused(403, 'ref'));
  });

  it('answers the token\'s `repository`, unchecked, for the name hashes (§3.4), and null without one', async () => {
    expect(await verify(token(claims()))).toMatchObject({ ok: true, caller: { repository: 'octo/widget' } });
    expect(await verify(token(without('repository')))).toMatchObject({ ok: true, caller: { repository: null } });
    expect(await verify(token(claims({ repository: ['octo/widget'] })))).toMatchObject({ ok: true, caller: { repository: null } });
  });

  it('`ref_type` not checked: a tag ref equal in name to the default branch is refused', async () => {
    expect(await verify(token(claims({ ref_type: 'tag' })))).toEqual(refused(403, 'ref'));
    expect(await verify(token(claims({ ref_type: 'tag' })), { endpoint: 'POST /v1/registrations' })).toEqual(refused(403, 'ref'));
  });

  it('a `ref` that is not a branch\'s is refused, at registration as on a schedule', async () => {
    for (const ref of ['refs/tags/main', 'main', 'refs/heads/', 'refs/pull/1/merge']) {
      expect(await verify(token(claims({ ref })), { endpoint: 'POST /v1/registrations' }), ref).toEqual(refused(403, 'ref'));
      expect(await verify(token(claims({ ref }))), ref).toEqual(refused(403, 'ref'));
    }
  });

  it.each([
    ['iss', 401, 'iss'], ['aud', 401, 'aud'], ['exp', 401, 'time'], ['nbf', 401, 'time'], ['iat', 401, 'time'],
    ['event_name', 403, 'event'], ['job_workflow_ref', 403, 'workflow'], ['repository_id', 403, 'owner'],
    ['repository_owner_id', 403, 'owner'], ['ref', 403, 'ref'], ['ref_type', 403, 'ref'],
  ] as const)('a missing claim treated as a pass: `%s` removed from an otherwise valid token is refused', async (name, status, error) => {
    expect(await verify(token(without(name)))).toEqual(refused(status, error));
    expect(await verify(token(without(name)), { endpoint: 'POST /v1/registrations' }), 'at registration').toEqual(refused(status, error));
  });

  it('a claim of the wrong type is refused, never coerced', async () => {
    expect(await verify(token(claims({ iss: [ISSUER] })))).toEqual(refused(401, 'iss'));
    expect(await verify(token(claims({ aud: [[AUDIENCE]] })))).toEqual(refused(401, 'aud'));
    expect(await verify(token(claims({ job_workflow_ref: [`${COLLECT}@refs/tags/v0.40.0`] })))).toEqual(refused(403, 'workflow'));
    expect(await verify(token(claims({ ref: ['refs/heads/main'] })))).toEqual(refused(403, 'ref'));
    expect(await verify(token(claims({ ref_type: ['branch'] })))).toEqual(refused(403, 'ref'));
  });

  it('a registration missing its owner id or default ref refuses, never admits', async () => {
    const holed = (reg: Record<string, unknown>) => async () => reg as never;
    expect(await verify(token(claims()), { registrationOf: holed({ default_ref: 'refs/heads/main' }) })).toEqual(refused(403, 'owner'));
    expect(await verify(token(claims()), { registrationOf: holed({ repository_owner_id: OWNER }) })).toEqual(refused(403, 'ref'));
  });

  it('a token that is not three base64url parts of JSON is refused', async () => {
    const [h, p, s] = token(claims()).split('.');
    for (const t of [undefined, '', 'abc', `${h}.${p}`, `${h}.${p}.${s}.x`, `${h}!.${p}.${s}`, `${b64('x')}.${p}.${s}`, `${Buffer.from('{').toString('base64url')}.${p}.${s}`, 42]) {
      expect(await verify(t), String(t)).toEqual(refused(401, 'token'));
    }
    const notJson = `${h}.${Buffer.from('nope').toString('base64url')}`;
    expect(await verify(`${notJson}.${sign('RSA-SHA256', Buffer.from(notJson), listed.privateKey).toString('base64url')}`)).toEqual(refused(401, 'token'));
  });

  it('stops at the first failure, in §2.2\'s order', async () => {
    const all = claims({ iss: 'x', aud: 'x', exp: 1, event_name: 'push', job_workflow_ref: 'x', repository_owner_id: 'x', ref_type: 'tag' });
    expect(await verify(token(all))).toEqual(refused(401, 'iss'));
    expect(await verify(token({ ...all, iss: ISSUER }))).toEqual(refused(401, 'aud'));
    expect(await verify(token({ ...all, iss: ISSUER, aud: AUDIENCE }))).toEqual(refused(401, 'time'));
    expect(await verify(token({ ...claims(), event_name: 'push', job_workflow_ref: 'x', repository_owner_id: 'x', ref_type: 'tag' }))).toEqual(refused(403, 'event'));
    expect(await verify(token({ ...claims(), job_workflow_ref: 'x', repository_owner_id: 'x', ref_type: 'tag' }))).toEqual(refused(403, 'workflow'));
    expect(await verify(token({ ...claims(), repository_owner_id: 'x', ref_type: 'tag' }))).toEqual(refused(403, 'owner'));
  });

  it('a refusal answers its status and code alone, never a claim\'s value', async () => {
    const r = await verify(token(claims({ repository_owner_id: '7891' })));
    expect(Object.keys(r).sort()).toEqual(['error', 'ok', 'status']);
  });

  it('logs nothing: the module holds no `console` and no write to a stream', () => {
    const source = readFileSync('infra/telemetry/function/oidc.mjs', 'utf8');
    expect(source).not.toMatch(/console\.|process\.std(out|err)/);
  });

  it('refuses a configuration it can\'t hold, rather than admitting', async () => {
    await expect(verify(token(claims()), { minTokenVersion: 'v0.40' })).rejects.toThrow(/minTokenVersion/);
    await expect(verify(token(claims()), { minTokenVersion: undefined })).rejects.toThrow(/minTokenVersion/);
    await expect(verify(token(claims()), { audience: '' })).rejects.toThrow(/audience/);
    await expect(verify(token(claims()), { endpoint: 'GET /v1/everything' })).rejects.toThrow(/endpoint/);
    await expect(verify(token(claims()), { keys: undefined })).rejects.toThrow(/keys/);
    await expect(verify(token(claims()), { registrationOf: undefined })).rejects.toThrow(/registrationOf/);
  });
});

describe('§2.4: GitHub\'s keys, cached and failing closed', () => {
  it('fetches GitHub\'s fixed JWKS URL with a 2-second timeout', async () => {
    const fetch = fakeFetch(up);
    expect(await verify(token(claims()), { keys: keyCache({ fetchImpl: fetch.impl }) })).toMatchObject({ ok: true });
    expect(JWKS_URL).toBe('https://token.actions.githubusercontent.com/.well-known/jwks');
    expect(fetch.calls).toEqual([{ url: JWKS_URL, signal: expect.any(AbortSignal) }]);
    expect(fetch.calls[0]!.signal!.aborted).toBe(false);
  });

  it('serves 15 minutes from the cache, then refetches', async () => {
    const fetch = fakeFetch(up);
    const keys = keyCache({ fetchImpl: fetch.impl });
    for (const at of [0, 5, 14.9]) expect(await verify(tokenAt(at * MINUTE), { keys, now: NOW + at * MINUTE }), `+${at} min`).toMatchObject({ ok: true });
    expect(fetch.calls).toHaveLength(1);
    expect(await verify(tokenAt(15 * MINUTE), { keys, now: NOW + 15 * MINUTE })).toMatchObject({ ok: true });
    expect(fetch.calls).toHaveLength(2);
  });

  it('JWKS fetch failure treated as an empty set and a pass, or a stale set used: with the fetch failing and the cache 16 minutes old, a valid token gets 503', async () => {
    const fetch = fakeFetch(up, down);
    const keys = keyCache({ fetchImpl: fetch.impl });
    expect(await verify(token(claims()), { keys })).toMatchObject({ ok: true });
    expect(await verify(tokenAt(16 * MINUTE), { keys, now: NOW + 16 * MINUTE })).toEqual(refused(503, 'jwks-unavailable'));
    expect(fetch.calls).toHaveLength(2);
  });

  it('a first fetch that fails, answers an error, or holds no RSA signing key answers 503, never a pass', async () => {
    for (const [name, answer] of [
      ['throws', down],
      ['500', () => new Response('{"keys":[]}', { status: 500 })],
      ['not JSON', () => new Response('<html>', { status: 200 })],
      ['no keys', () => jwks()],
      ['no keys array', () => new Response('{"keys":{}}', { status: 200 })],
      ['only an encryption key', () => jwks(jwk(listed.publicKey, 'listed', { use: 'enc' }))],
      ['only a non-RSA key', () => jwks({ kty: 'EC', kid: 'listed', use: 'sig', crv: 'P-256', x: 'x', y: 'y' })],
      // An RSA key's numbers under another `kty`: the filter, not Node's import, refuses it.
      ['only a key whose kty is not RSA, holding RSA numbers', () => jwks(jwk(listed.publicKey, 'listed', { kty: 'oct' }))],
    ] as const) {
      const keys = keyCache({ fetchImpl: fakeFetch(answer).impl });
      expect(await verify(token(claims()), { keys }), name).toEqual(refused(503, 'jwks-unavailable'));
    }
  });

  it('keeps only RSA keys with `use: sig`', async () => {
    const keys = keyCache({ fetchImpl: fakeFetch(() => jwks(jwk(listed.publicKey, 'listed', { use: 'enc' }), jwk(rotated.publicKey, 'rotated'))).impl });
    expect(await verify(token(claims()), { keys })).toEqual(refused(401, 'kid'));
    expect(await verify(token(claims(), { header: { kid: 'rotated' }, key: rotated.privateKey }), { keys })).toMatchObject({ ok: true });
  });

  it('a rotated key is picked up by the first token that names it', async () => {
    const fetch = fakeFetch(up, () => jwks(jwk(listed.publicKey, 'listed'), jwk(rotated.publicKey, 'rotated')));
    const keys = keyCache({ fetchImpl: fetch.impl });
    expect(await verify(token(claims()), { keys })).toMatchObject({ ok: true });
    const r = await verify(token(claims(), { header: { kid: 'rotated' }, key: rotated.privateKey }), { keys, now: NOW + 2 * MINUTE });
    expect(r).toMatchObject({ ok: true });
    expect(fetch.calls).toHaveLength(2);
  });

  it('an unknown `kid` refetches at most once a minute, so invented `kid`s can\'t become a stream of fetches', async () => {
    const fetch = fakeFetch(up);
    const keys = keyCache({ fetchImpl: fetch.impl });
    expect(await verify(token(claims()), { keys })).toMatchObject({ ok: true });
    for (let i = 0; i < 5; i += 1) {
      expect(await verify(token(claims(), { header: { kid: `invented-${i}` } }), { keys, now: NOW + 1000 * i })).toEqual(refused(401, 'kid'));
    }
    expect(fetch.calls).toHaveLength(1);
    expect(await verify(token(claims(), { header: { kid: 'invented' } }), { keys, now: NOW + MINUTE })).toEqual(refused(401, 'kid'));
    expect(fetch.calls).toHaveLength(2);
  });

  it('while GitHub is down, retries at most once a minute, and answers 503 between', async () => {
    const fetch = fakeFetch(down);
    const keys = keyCache({ fetchImpl: fetch.impl });
    for (let i = 0; i < 5; i += 1) expect(await verify(token(claims()), { keys, now: NOW + 1000 * i })).toEqual(refused(503, 'jwks-unavailable'));
    expect(fetch.calls).toHaveLength(1);
    expect(await verify(token(claims()), { keys, now: NOW + MINUTE })).toEqual(refused(503, 'jwks-unavailable'));
    expect(fetch.calls).toHaveLength(2);
  });

  it('a failed refetch for an unknown `kid` keeps the fresh set, and the next minute\'s refetch recovers', async () => {
    const fetch = fakeFetch(up, down, () => jwks(jwk(listed.publicKey, 'listed'), jwk(rotated.publicKey, 'rotated')));
    const keys = keyCache({ fetchImpl: fetch.impl });
    const rotatedToken = token(claims(), { header: { kid: 'rotated' }, key: rotated.privateKey });
    expect(await verify(token(claims()), { keys })).toMatchObject({ ok: true });
    expect(await verify(rotatedToken, { keys, now: NOW + MINUTE })).toEqual(refused(401, 'kid'));
    expect(await verify(token(claims()), { keys, now: NOW + MINUTE })).toMatchObject({ ok: true });
    expect(await verify(rotatedToken, { keys, now: NOW + 2 * MINUTE })).toMatchObject({ ok: true });
    expect(fetch.calls).toHaveLength(3);
  });
});
