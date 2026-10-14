import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { renderText, validate } from '../../scripts/lib/notify-contract.mjs';
import { HEADERS, URL_MAX, main } from '../../actions/notify/webhook/webhook.mjs';
import { ROOT } from './helpers/adopter.js';
import { schemaAccepts } from './helpers/json-schema.js';

/**
 * Plan 0011 step N4, Kanon's generic webhook hook (§7.1, §7.3): `actions/notify/webhook` and the
 * hook file `kanon init` writes, `actions/notify/hooks/webhook.yml`. Every "What must be true" of
 * the N4 row is a case here, by name. No case makes a request: `fetch` and `sleep` are injected.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a message is read field by field
type Any = Record<string, any>;

const URL_ = 'https://receiver.example/kanon/notarealsecretvalue';
const RUN = 'https://github.com/acme/widgets/actions/runs/7';

const message = (over: Any = {}): Any => ({
  schema_version: 1,
  kind: 'weekly-digest',
  severity: 'info',
  title: 'The week, to Friday 10 October',
  summary: 'Two features shipped. **Nothing** is stopped.',
  sections: [{ heading: 'Shipped', body: '- [#812](https://github.com/acme/widgets/issues/812) Support Array<string>\n- `snake_case_name` & <!channel>', fields: [{ label: 'Merged', value: '9' }] }],
  links: [{ label: 'The board', url: 'https://github.com/orgs/acme/projects/1' }],
  source: { repository: 'acme/widgets', lane: 'weekly-digest', run_url: RUN },
  ...over,
});

/** The message file as the `notify` block writes it: a validated message, as JSON. */
const file = (m: Any): string => {
  expect(validate(m)).toEqual({ ok: true });
  return `${JSON.stringify(m, null, 2)}\n`;
};

type Init = { method: string; headers: Record<string, string>; body: string; redirect: string };
type Call = { url: string; init: Init };
type Answer = { status: number; body?: string; headers?: Record<string, string> };

/**
 * A stubbed `fetch` that answers in turn and records each call. It behaves as `fetch` does with a
 * redirect: unless `redirect: 'manual'`, a 3xx with a `Location` is followed, re-sending the body
 * to the new host, so a hook that follows redirects is caught by what it does, not how it says it.
 */
const stub = (...answers: Answer[]) => {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let next = 0;
  const answer = () => answers[Math.min(next++, answers.length - 1)] ?? { status: 200 };
  const respond = (a: Answer) => {
    const headers = new Map(Object.entries(a.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: a.status, headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null }, text: async () => a.body ?? '' };
  };
  const io = {
    fetch: async (url: string, init: Init) => {
      calls.push({ url, init });
      let a = answer();
      while (init.redirect !== 'manual' && a.status >= 300 && a.status < 400 && a.headers?.Location) {
        calls.push({ url: a.headers.Location, init });
        a = answer();
      }
      return respond(a);
    },
    sleep: async (ms: number) => { sleeps.push(ms); },
  };
  return { io, calls, sleeps };
};

/** Run the action on a message file, as the composite step does, and capture what it logs. */
const run = async (content: string, secret: string, ...answers: Answer[]) => {
  const s = stub(...answers);
  const logs: string[] = [];
  const read: string[] = [];
  const files: Record<string, string> = { 'message.json': content, 'text.txt': 'plain text rendering' };
  const code = await main({
    env: { MESSAGE_FILE: 'message.json', TEXT_FILE: 'text.txt', KIND: 'weekly-digest', SECRET: secret },
    io: s.io,
    readFile: (p: string) => { read.push(p); return files[p] ?? ''; },
    out: { log: (x: string) => logs.push(x), error: (x: string) => logs.push(x) },
  });
  return { code, log: logs.join('\n'), read, ...s };
};

describe('plan 0011 N4: the body is the message (§7.3)', () => {
  it('the body is byte for byte the validated message, and validates against the published JSON Schema', async () => {
    const m = message();
    const content = file(m);
    const r = await run(content, URL_, { status: 204 });
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.init.body).toBe(content);
    expect(Buffer.from(r.calls[0]?.init.body ?? '', 'utf8').equals(Buffer.from(content, 'utf8'))).toBe(true);
    const schema = JSON.parse(readFileSync(join(ROOT, 'docs', 'notify', 'message-v1.schema.json'), 'utf8'));
    expect(schemaAccepts(schema, JSON.parse(r.calls[0]?.init.body ?? ''))).toBe(true);
  });

  it('nothing is rendered or escaped, and `renderText`\'s text is not what is sent', async () => {
    const m = message();
    const r = await run(file(m), URL_, { status: 200 });
    const body = r.calls[0]?.init.body ?? '';
    expect(body).not.toBe(renderText(m));
    expect(body).not.toContain('plain text rendering');
    expect(JSON.parse(body).sections[0].body).toBe(m.sections[0].body);
    expect(r.read).toEqual(['message.json']);
  });

  it('a kind it doesn\'t know, with an additive field, is posted as it is, never dropped (§3.2, §3.4)', async () => {
    const content = JSON.stringify(message({ kind: 'release', colour: 'blue' }));
    const r = await run(content, URL_, { status: 200 });
    expect(r.code).toBe(0);
    expect(r.calls[0]?.init.body).toBe(content);
  });

  it.each([
    ['not JSON', '{"kind": '],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
  ])('a message file that is %s is refused, and nothing is posted', async (_, content) => {
    const r = await run(content, URL_);
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(0);
    expect(r.log).toContain('message-v1');
  });
});

describe('plan 0011 N4: the request', () => {
  it('posts once to the one URL in `secret`, with `Content-Type` and `User-Agent` and no other identifying header', async () => {
    const r = await run(file(message()), `${URL_}\n`, { status: 200 });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.url).toBe(URL_);
    expect(r.calls[0]?.init.method).toBe('POST');
    expect(r.calls[0]?.init.headers).toEqual({ 'Content-Type': 'application/json', 'User-Agent': 'kanon-notify/1' });
    expect(HEADERS).toEqual({ 'Content-Type': 'application/json', 'User-Agent': 'kanon-notify/1' });
    // No signature in version 1 (decision 20), and nothing naming the repository but the body.
    expect(JSON.stringify(r.calls[0]?.init.headers)).not.toMatch(/signature|acme|widgets|authorization/i);
  });

  it.each([
    ['an http:// URL', 'http://receiver.example/kanon/notarealsecretvalue'],
    ['an HTTP:// URL in capitals', 'HTTP://receiver.example/kanon/notarealsecretvalue'],
    ['another scheme', 'ftp://receiver.example/kanon/notarealsecretvalue'],
    ['no scheme', 'receiver.example/kanon/notarealsecretvalue'],
    ['a JSON routing map', JSON.stringify({ 'weekly-digest': URL_ })],
    ['two URLs on two lines', `${URL_}\n${URL_}`],
    ['a URL past 2,000 characters', `${URL_}/${'a'.repeat(URL_MAX)}`],
  ])('%s is refused without echoing it, and nothing is posted', async (_, secret) => {
    const r = await run(file(message()), secret);
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(0);
    expect(r.log).toMatch(/secret input/);
    expect(r.log).not.toContain('notarealsecretvalue');
    expect(r.log).not.toContain('receiver.example');
  });

  it('an empty secret is refused, and nothing is posted', async () => {
    const r = await run(file(message()), '  ');
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(0);
    expect(r.log).toContain('The secret input is empty');
  });

  it('a URL of exactly 2,000 characters is posted to', async () => {
    const long = `${URL_}/${'a'.repeat(URL_MAX - URL_.length - 1)}`;
    expect(long).toHaveLength(URL_MAX);
    const r = await run(file(message()), long, { status: 200 });
    expect(r.code).toBe(0);
    expect(r.calls[0]?.url).toBe(long);
  });
});

describe('plan 0011 N4: errors and the one retry (§5.4, §7.3)', () => {
  it('a 302 is not followed, and fails', async () => {
    const r = await run(file(message()), URL_, { status: 302, headers: { Location: 'https://elsewhere.example/catch' } }, { status: 200 });
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.calls.map((c) => c.url)).not.toContain('https://elsewhere.example/catch');
    expect(r.calls[0]?.init.redirect).toBe('manual');
    expect(r.log).toContain('HTTP 302');
    expect(r.log).toContain('redirect');
    expect(r.log).not.toContain('elsewhere.example');
  });

  it('a 500 fails with the status, and neither the URL nor the response body in the log', async () => {
    const r = await run(file(message()), URL_, { status: 500, body: `internal error: secret-marker ${URL_}` });
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.log).toContain('HTTP 500');
    expect(r.log).not.toContain('secret-marker');
    expect(r.log).not.toContain('internal error');
    expect(r.log).not.toContain('receiver.example');
    expect(r.log).not.toContain('notarealsecretvalue');
  });

  it('a short error body that looks like an error code is not printed either', async () => {
    const r = await run(file(message()), URL_, { status: 400, body: 'invalid_payload' });
    expect(r.code).toBe(1);
    expect(r.log).toContain('HTTP 400');
    expect(r.log).not.toContain('invalid_payload');
  });

  it('a 429 with `Retry-After: 5` retries once, after five seconds, with the same body to the same URL', async () => {
    const content = file(message());
    const r = await run(content, URL_, { status: 429, headers: { 'Retry-After': '5' } }, { status: 200 });
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(2);
    expect(r.calls.map((c) => [c.url, c.init.body])).toEqual([[URL_, content], [URL_, content]]);
    expect(r.sleeps).toEqual([5000]);
    expect(r.log).toContain('after one retry');
  });

  it('a second 429 fails: once, never twice', async () => {
    const r = await run(file(message()), URL_, { status: 429, headers: { 'Retry-After': '5' } });
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(2);
    expect(r.sleeps).toEqual([5000]);
    expect(r.log).toContain('HTTP 429');
  });

  it('a 429 asking for more than 60 seconds is not retried', async () => {
    const r = await run(file(message()), URL_, { status: 429, headers: { 'Retry-After': '61' } });
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.sleeps).toEqual([]);
  });

  it('a request that throws fails without its message, which could name the host', async () => {
    const logs: string[] = [];
    const code = await main({
      env: { MESSAGE_FILE: 'm', TEXT_FILE: 't', KIND: 'deploy', SECRET: URL_ },
      io: { fetch: async () => { throw Object.assign(new TypeError(`fetch failed ${URL_}`), { cause: { code: 'ENOTFOUND' } }); }, sleep: async () => {} },
      readFile: () => JSON.stringify(message()),
      out: { log: (x: string) => logs.push(x), error: (x: string) => logs.push(x) },
    });
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('The request to the webhook failed (ENOTFOUND)');
    expect(logs.join('\n')).not.toContain('notarealsecretvalue');
  });
});

describe('plan 0011 N4: the action and the hook file `kanon init` writes (§7.1)', () => {
  const INPUTS = ['message-v1', 'text', 'kind', 'secret'];
  const action = parse(readFileSync(join(ROOT, 'actions/notify/webhook/action.yml'), 'utf8')) as Any;
  const hookText = readFileSync(join(ROOT, 'actions/notify/hooks/webhook.yml'), 'utf8');
  const hook = parse(hookText) as Any;
  const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

  it('the action reads the hook interface\'s four inputs and nothing else, through the environment', () => {
    expect(Object.keys(action.inputs)).toEqual(INPUTS);
    expect(action.runs.using).toBe('composite');
    expect(action.runs.steps).toHaveLength(1);
    expect(action.runs.steps[0].run).toBe('node "$GITHUB_ACTION_PATH/webhook.mjs"');
    expect(action.runs.steps[0].env).toEqual({
      MESSAGE_FILE: '${{ inputs.message-v1 }}',
      TEXT_FILE: '${{ inputs.text }}',
      KIND: '${{ inputs.kind }}',
      SECRET: '${{ inputs.secret }}',
    });
  });

  it('`hooks/webhook.yml` is a composite hook declaring the four inputs, all required', () => {
    expect(hook.runs.using).toBe('composite');
    expect(Object.keys(hook.inputs)).toEqual(INPUTS);
    for (const name of INPUTS) expect(hook.inputs[name].required).toBe(true);
  });

  it('its one step names `actions/notify/webhook` at a version tag, the release\'s own, and passes the four inputs through', () => {
    expect(hook.runs.steps).toHaveLength(1);
    const step = hook.runs.steps[0];
    expect(step.uses).toMatch(/^yedeya-labs\/kanon\/actions\/notify\/webhook@v\d+\.\d+\.\d+$/);
    expect(step.uses).toBe(`yedeya-labs/kanon/actions/notify/webhook@v${version}`);
    expect(step.with).toEqual(Object.fromEntries(INPUTS.map((n) => [n, `\${{ inputs.${n} }}`])));
  });

  it('the pin carries the release-please marker, and the file is in extra-files, so a release moves it', () => {
    const line = hookText.split('\n').find((l) => l.includes('uses:'));
    expect(line).toMatch(/# x-release-please-version$/);
    const config = JSON.parse(readFileSync(join(ROOT, 'release-please-config.json'), 'utf8')) as Any;
    const extra = Object.values(config.packages as Any).flatMap((p: Any) => p['extra-files'] ?? []);
    expect(extra).toContain('actions/notify/hooks/webhook.yml');
  });
});
