import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  ENDPOINT, KINDS, MODEL, THRESHOLD, TIMEOUT_MS, buildRequest, call, decide, judge, parseResponse,
} from '../../scripts/telemetry/jev.mjs';

/**
 * Plan 0006 F6: `jev.mjs`, the client for TypeSafe's Jev that decides whether a private upstream
 * finding is promoted to a public Kanon issue. Every test runs on recorded fixtures and a fake
 * `fetch`; none reaches the network, and no real key exists here.
 */

type J = Record<string, unknown>;
const FIXTURES = 'tests/fixtures/jev';
const fixture = (name: string): J => JSON.parse(readFileSync(`${FIXTURES}/${name}`, 'utf8')) as J;
const INPUT = fixture('input.json') as unknown as Parameters<typeof buildRequest>[0];
const RESPONSE = fixture('response.json');
const KEY = 'k3f9a2';
const KEYS = new Set([KEY, 'q8w7e6']);
const API_KEY = 'ts-test-not-a-key';

/** The fixture response with its answers changed. */
const answering = (kind: J | null, actionable: J | null): J => {
  const answers = { ...(RESPONSE.answers as J) };
  if (kind === null) delete answers.kind; else answers.kind = { ...(answers.kind as J), ...kind };
  if (actionable === null) delete answers.actionable; else answers.actionable = { ...(answers.actionable as J), ...actionable };
  return { ...RESPONSE, answers };
};

type Seen = { url: string; init: RequestInit };
/** A fake `fetch` that records each call and answers `status` and `body`. */
const replying = (body: unknown, status = 200) => {
  const seen: Seen[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
};

const judged = (body: unknown, status = 200) => judge(INPUT, { keys: KEYS, apiKey: API_KEY, fetch: replying(body, status).fetch });

describe('the wire, pinned by recorded fixtures (§7.3)', () => {
  it('builds exactly the recorded request from the recorded finding', () => {
    expect(buildRequest(INPUT, { keys: KEYS })).toEqual(fixture('request.json'));
  });

  it('posts it to TypeSafe with model jev-latest, the key as a bearer token and a 30-second timeout', async () => {
    const { fetch, seen } = replying(RESPONSE);
    await judge(INPUT, { keys: KEYS, apiKey: API_KEY, fetch });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(ENDPOINT).toBe('https://api.typesafe.ai/v1/systemone');
    expect(MODEL).toBe('jev-latest');
    expect(TIMEOUT_MS).toBe(30_000);
    expect(seen[0]!.init.method).toBe('POST');
    expect(seen[0]!.init.headers).toEqual({ authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' });
    expect(seen[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual(fixture('request.json'));
  });

  it('reads the recorded response into both answers, and promotes it', async () => {
    expect(parseResponse(JSON.stringify(RESPONSE))).toEqual({ ok: true, choice: 'kanon_bug', choice_confidence: 0.93, noul: 0.96 });
    expect(await judged(RESPONSE)).toEqual({
      call: 'promote', reason: 'kanon_bug', choice: 'kanon_bug', choice_confidence: 0.93, noul: 0.96, noul_confidence: 0.96,
    });
  });

  it('asks the four kinds and the Noul, and only one kind can be promoted', () => {
    const { questions } = buildRequest(INPUT, { keys: KEYS });
    expect(Object.keys(questions.kind.criteria)).toEqual([...KINDS]);
    expect(KINDS).toEqual(['kanon_bug', 'adopter_configuration', 'platform', 'unclear']);
    expect(questions.actionable.type).toBe('noul');
    expect(questions.actionable.instructions).toMatch(/maintainer can act on this .*without asking the adopt/);
    expect(THRESHOLD).toBe(0.90);
  });
});

describe('what the request holds (§7.2)', () => {
  it('never a run id, a time or a finding index, whatever the finding carries', () => {
    const text = JSON.stringify(buildRequest(INPUT, { keys: KEYS }));
    for (const banned of ['98765432101', '98765432177', '2026-10-0', 'run_id', 'recorded_at', 'finding_index', 'first_seen']) {
      expect(text).not.toContain(banned);
    }
  });

  it('sends evidence only from a level-2 finding', () => {
    const codes = { ...INPUT, findings: [{ ...INPUT.findings[0]!, evidence: 'a stray text' }] };
    expect(buildRequest(codes, { keys: KEYS }).state.evidence).toEqual([]);
  });

  it('a request built from a finding that holds an adopter key throws, before fetch is called', async () => {
    const { fetch, seen } = replying(RESPONSE);
    const asField = { ...INPUT, findings: [{ ...INPUT.findings[0]!, kanon_version: KEY }] };
    const inText = { ...INPUT, findings: [{ ...INPUT.findings[1]!, evidence: `Observed: the key ${KEY} failed.` }] };
    for (const input of [asField, inText]) {
      await expect(judge(input, { keys: KEYS, apiKey: API_KEY, fetch })).rejects.toThrow(/adopter key/);
    }
    expect(seen).toHaveLength(0);
  });

  it('throws without the keys to check against, so an unchecked request is never sent', () => {
    expect(() => buildRequest(INPUT, {} as { keys: Set<string> })).toThrow(/no adopter keys/);
  });
});

describe('failing closed (§7.3): every case keeps the finding private', () => {
  it('a network error', async () => {
    const fetch = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof globalThis.fetch;
    expect(await judge(INPUT, { keys: KEYS, apiKey: API_KEY, fetch })).toMatchObject({ call: 'keep', reason: 'network_error' });
  });

  it('a timeout', async () => {
    // Answers only when the call's own signal aborts it, so only the timeout ends the call.
    const fetch = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as unknown as typeof globalThis.fetch;
    expect(await judge(INPUT, { keys: KEYS, apiKey: API_KEY, fetch, timeoutMs: 10 })).toMatchObject({ call: 'keep', reason: 'timeout' });
  }, 2_000);

  it('a 500, even with a promotable body', async () => {
    expect(await judged(RESPONSE, 500)).toMatchObject({ call: 'keep', reason: 'http_500' });
  });

  it('a malformed body', async () => {
    expect(await judged('{"answers": {"kind": ')).toMatchObject({ call: 'keep', reason: 'malformed_body' });
  });

  it('a body without answers, or without either answer', async () => {
    expect(await judged({ model: 'jev-1.13.0' })).toMatchObject({ call: 'keep', reason: 'no_answers' });
    expect(await judged(answering(null, {}))).toMatchObject({ call: 'keep', reason: 'no_choice' });
    expect(await judged(answering({}, null))).toMatchObject({ call: 'keep', reason: 'no_noul' });
    expect(await judged(answering({}, { noul: 'yes' }))).toMatchObject({ call: 'keep', reason: 'no_noul' });
    expect(await judged(answering({ confidence: 'high' }, {}))).toMatchObject({ call: 'keep', reason: 'no_choice' });
  });

  it('Choice unclear, or any kind but a Kanon bug', async () => {
    expect(await judged(answering({ choice: 'unclear' }, {}))).toMatchObject({ call: 'keep', reason: 'choice_unclear' });
    expect(await judged(answering({ choice: 'platform' }, {}))).toMatchObject({ call: 'keep', reason: 'choice_platform' });
    expect(await judged(answering({ choice: 'something_else' }, {}))).toMatchObject({ call: 'keep', reason: 'choice_unknown' });
  });

  it('the Noul not affirmed, however confident', async () => {
    expect(await judged(answering({}, { noul: 0.04 }))).toMatchObject({ call: 'keep', reason: 'noul_not_affirmed', noul_confidence: 0.96 });
  });

  it('a confidence of 0.89 on either answer', async () => {
    expect(await judged(answering({ confidence: 0.89 }, {}))).toMatchObject({ call: 'keep', reason: 'low_choice_confidence' });
    expect(await judged(answering({}, { noul: 0.89 }))).toMatchObject({ call: 'keep', reason: 'low_noul_confidence' });
  });

  it('no confidence on the Choice', async () => {
    const kind = { ...((RESPONSE.answers as J).kind as J) };
    delete kind.confidence;
    const body = { ...RESPONSE, answers: { ...(RESPONSE.answers as J), kind } };
    expect(await judged(body)).toMatchObject({ call: 'keep', reason: 'no_confidence', choice_confidence: null });
  });

  it('no provider key: nothing is called', async () => {
    const { fetch, seen } = replying(RESPONSE);
    expect(await judge(INPUT, { keys: KEYS, fetch })).toMatchObject({ call: 'keep', reason: 'no_provider_key' });
    expect(seen).toHaveLength(0);
  });

  it('promotes at exactly the threshold on both answers', () => {
    expect(decide({ ok: true, choice: 'kanon_bug', choice_confidence: 0.9, noul: 0.9 }).call).toBe('promote');
  });

  it('call never throws, and parseResponse reads text', async () => {
    const { fetch } = replying('not json');
    await expect(call(buildRequest(INPUT, { keys: KEYS }), { apiKey: API_KEY, fetch })).resolves.toEqual({ ok: false, reason: 'malformed_body' });
  });
});

describe('K-SELF-8', () => {
  it('imports nothing but node: built-ins and Kanon\'s own files', () => {
    const src = readFileSync('scripts/telemetry/jev.mjs', 'utf8');
    const specs = [...src.matchAll(/^import [^;]*? from ['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
    expect(specs.filter((s) => !/^(node:|\.\.?\/)/.test(s))).toEqual([]);
  });
});
