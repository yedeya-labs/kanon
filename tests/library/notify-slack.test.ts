import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LIMITS, literal, validate } from '../../scripts/lib/notify-contract.mjs';
import { EMOJI, SLACK, main, payload, toMrkdwn } from '../../actions/notify/slack/slack.mjs';
import { ROOT } from './helpers/adopter.js';

/**
 * Plan 0011 step N3, Kanon's Slack hook (§7.1, §7.2): `actions/notify/slack` and the hook file
 * `kanon init` writes, `actions/notify/hooks/slack.yml`. Every "What must be true" of the N3 row is
 * a case here, by name. No case makes a request: `fetch` and `sleep` are injected.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a message and a payload are read field by field
type Any = Record<string, any>;

const WEBHOOK = 'https://hooks.slack.com/services/TKANON/BKANON/notarealsecretvalue';
const RUN = 'https://github.com/acme/widgets/actions/runs/7';
const SOURCE = { repository: 'acme/widgets', lane: 'project-digest', run_url: RUN };
const ZWSP = '​';

const message = (over: Any = {}): Any => ({
  schema_version: 1,
  kind: 'project-digest',
  severity: 'warning',
  title: 'Projects, Tuesday 14 October',
  summary: 'Three projects open. One is **stopped** on a decision you owe.',
  sections: [
    {
      heading: 'Stopped',
      body: '- [#812](https://github.com/acme/widgets/issues/812) Merge retry: stopped for a decision.\n- `kanon doctor` reports _two_ notes.',
      fields: [{ label: 'Open issues', value: '4' }],
    },
  ],
  links: [{ label: 'The board', url: 'https://github.com/orgs/acme/projects/1' }],
  source: SOURCE,
  ...over,
});

/** The message is a valid contract message: every case below feeds the hook what the `notify` block would. */
const valid = (m: Any): Any => {
  expect(validate(m)).toEqual({ ok: true });
  return m;
};

type Call = { url: string; init: { method: string; headers: Record<string, string>; body: string; redirect: string } };
type Answer = { status: number; body?: string; headers?: Record<string, string> };

/** A stubbed `fetch` that answers in turn, and records each call. */
const stub = (...answers: Answer[]) => {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const io = {
    fetch: async (url: string, init: Call['init']) => {
      calls.push({ url, init });
      const a = answers[Math.min(calls.length - 1, answers.length - 1)] ?? { status: 200, body: 'ok' };
      const headers = new Map(Object.entries(a.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      return { status: a.status, headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null }, text: async () => a.body ?? '' };
    },
    sleep: async (ms: number) => { sleeps.push(ms); },
  };
  return { io, calls, sleeps };
};

/** Run the action on a message, as the composite step does, and capture what it logs. */
const run = async (m: unknown, secret: string, ...answers: Answer[]) => {
  const s = stub(...answers);
  const logs: string[] = [];
  const code = await main({
    env: { MESSAGE_FILE: 'message.json', TEXT_FILE: 'text.txt', KIND: 'project-digest', SECRET: secret },
    io: s.io,
    readFile: () => JSON.stringify(m),
    out: { log: (x: string) => logs.push(x), error: (x: string) => logs.push(x) },
  });
  return { code, log: logs.join('\n'), ...s };
};

/** Every mrkdwn string in a payload: the fallback, each section's text and fields, each context element. */
const mrkdwnTexts = (p: { text: string; blocks: Any[] }): string[] => [
  p.text,
  ...p.blocks.flatMap((b) => [
    ...(b.text?.type === 'mrkdwn' ? [b.text.text as string] : []),
    ...((b.fields ?? []) as Any[]).map((f) => f.text as string),
    ...((b.elements ?? []) as Any[]).map((e) => e.text as string),
  ]),
];

/** Slack's entities back to characters, and the zero-width fences removed: what a reader sees. */
const shown = (s: string): string => s.replaceAll(ZWSP, '').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

describe('plan 0011 N3: the payload holds Slack\'s limits', () => {
  it('a 120-character title at info, the longest emoji, makes a header of at most 150 characters, whole', () => {
    const title = 'T'.repeat(LIMITS.title);
    const header = payload(valid(message({ severity: 'info', title }))).blocks[0];
    expect(header.type).toBe('header');
    expect(header.text.type).toBe('plain_text');
    expect(header.text.text).toBe(`${EMOJI.info} ${title}`);
    expect([...header.text.text].length).toBeLessThanOrEqual(SLACK.header);
    expect(Math.max(...Object.values(EMOJI).map((e) => e.length))).toBe(EMOJI.info.length);
  });

  it('a title a later contract version lets grow is cut at 150 with …', () => {
    const text = payload(message({ title: 'x'.repeat(400) })).blocks[0].text.text as string;
    expect([...text].length).toBe(SLACK.header);
    expect(text.endsWith('…')).toBe(true);
  });

  it('a context block holds 9 links and the run: at most 10 elements, the run\'s its own', () => {
    const links = Array.from({ length: LIMITS.links }, (_, i) => ({ label: `Link ${i + 1}`, url: `https://example.com/${i + 1}` }));
    const p = payload(valid(message({ links })));
    const context = p.blocks.at(-1) as Any;
    expect(context.type).toBe('context');
    expect(context.elements).toHaveLength(SLACK.contextElements);
    expect(context.elements.at(-1).text).toBe(`<${RUN}|The run>`);
    expect(context.elements.slice(0, 9).map((e: Any) => e.text)).toEqual(links.map((l) => `<${l.url}|${l.label}>`));
  });

  it('a body of 2,500 `&` renders past 3,000 after escaping, and splits into sections of at most 3,000', () => {
    const body = '&'.repeat(LIMITS.body);
    const p = payload(valid(message({ sections: [{ heading: 'Amps', body }] })));
    const sections = p.blocks.filter((b) => b.type === 'section').slice(1);
    expect(sections.length).toBeGreaterThan(1);
    for (const s of sections) expect([...(s.text.text as string)].length).toBeLessThanOrEqual(SLACK.sectionText);
    // Nothing lost: the pieces, joined, are the heading and the whole body.
    expect(sections[0].text.text.startsWith('*Amps*\n&amp;')).toBe(true);
    expect(shown(sections.map((s) => s.text.text as string).join(''))).toBe(`*Amps*\n${body}`);
  });

  it('at most 50 blocks: a message that escaping more than doubles is cut, and its last block says so and links the run', () => {
    // Sixteen bodies that escape past 3,000 split in two: 1 header, 2 summary sections, 16 x 3 and
    // 4 x 2 section blocks and a context, 60 in all, from a message well inside the contract.
    const sections = Array.from({ length: LIMITS.sections }, (_, i) => ({ heading: `S${i}`, body: i < 16 ? '&'.repeat(601) : 'x' }));
    const m = valid(message({ summary: '&'.repeat(LIMITS.summary), sections }));
    const p = payload(m);
    expect(p.blocks).toHaveLength(SLACK.blocks);
    const last = p.blocks.at(-1) as Any;
    expect(last.type).toBe('context');
    expect(last.elements[0].text).toContain('was cut');
    expect(last.elements[0].text).toContain(`<${RUN}|The run>`);
  });

  it('every field of a section is at most 2,000 characters, and a section has at most 10', () => {
    const fields = Array.from({ length: 10 }, (_, i) => (i < 5 ? { label: '<'.repeat(100), value: '&'.repeat(1800) } : { label: 'L', value: 'v' }));
    const p = payload(valid(message({ sections: [{ body: 'b', fields }] })));
    const withFields = p.blocks.find((b) => b.fields) as Any;
    expect(withFields.fields).toHaveLength(SLACK.fields);
    for (const f of withFields.fields) expect([...(f.text as string)].length).toBeLessThanOrEqual(SLACK.fieldText);
    expect(withFields.fields[0].text.endsWith('…')).toBe(true);
    expect(withFields.fields[9].text).toBe('*L*\nv');
  });
});

describe('plan 0011 N3: escaping, so no text can mention anyone', () => {
  const MENTIONS = '<!channel> <!here> <@U1>';
  const everywhere = message({
    title: `Title ${MENTIONS}`,
    summary: `Summary ${MENTIONS}`,
    sections: [{ heading: `Heading ${MENTIONS}`, body: `Body ${MENTIONS}\n- bullet ${MENTIONS}`, fields: [{ label: `L ${MENTIONS}`, value: `V ${MENTIONS}` }] }],
    links: [{ label: `Link ${MENTIONS}`, url: 'https://example.com/a' }],
  });

  it('`<!channel>` and `<@U1>` in any field reach Slack escaped, in the blocks and in the text', () => {
    const p = payload(valid(everywhere));
    for (const t of mrkdwnTexts(p)) {
      expect(t).not.toMatch(/<[!@#]/);
      expect(t).not.toContain('<!channel>');
    }
    const joined = mrkdwnTexts(p).join('\n');
    for (const field of ['Summary', 'Heading', 'Body', 'bullet', 'L', 'V', 'Link', 'Title']) {
      expect(joined).toContain(`${field} &lt;!channel&gt; &lt;!here&gt; &lt;@U1&gt;`);
    }
  });

  it('the header, the one place a title is not escaped, is plain_text, which Slack never parses', () => {
    const header = payload(valid(everywhere)).blocks[0];
    expect(header.text.type).toBe('plain_text');
    expect(header.text.text).toContain(MENTIONS);
  });

  it('an issue title `Array<string>` reaches Slack as `Array&lt;string&gt;`, and `snake_case_name` unformatted', () => {
    const body = `- ${literal('Support Array<string>')}\n- ${literal('**urgent** fix for snake_case_name')}`;
    const text = toMrkdwn(valid(message({ sections: [{ body }] })).sections[0].body);
    expect(text).toContain('Support Array&lt;string&gt;');
    // Each literal formatting character is fenced, so Slack pairs none of them: no `_` or `*`
    // without a zero-width space on each side, and the reader sees the title as written.
    expect(text.replace(new RegExp(`${ZWSP}[*_\`~]${ZWSP}`, 'g'), '')).not.toMatch(/[*_`~]/);
    expect(shown(text)).toBe('• Support Array<string>\n• **urgent** fix for snake_case_name');
  });

  it('Kanon text becomes mrkdwn: strong, emphasis, code, links and bullets', () => {
    expect(toMrkdwn('**bold** and _em_ and `a<b` and [the PR](https://example.com/p?a=1&b=2)'))
      .toBe('*bold* and _em_ and `a&lt;b` and <https://example.com/p?a=1&amp;b=2|the PR>');
    expect(toMrkdwn('- one\n\n- two')).toBe('• one\n\n• two');
    expect(toMrkdwn('# not a heading\n| not | a table |')).toBe('# not a heading\n| not | a table |');
  });
});

describe('plan 0011 N3: the text fallback (decision 6)', () => {
  it('is the full rendering when it fits in 4,000 characters', () => {
    const p = payload(valid(message()));
    expect(p.text.length).toBeLessThanOrEqual(SLACK.text);
    expect(p.text).toBe([
      'Warning: *Projects, Tuesday 14 October*',
      'Three projects open. One is *stopped* on a decision you owe.',
      '*Stopped*\n• <https://github.com/acme/widgets/issues/812|#812> Merge retry: stopped for a decision.\n• `kanon doctor` reports _two_ notes.\n*Open issues:* 4',
      `<https://github.com/orgs/acme/projects/1|The board> · <${RUN}|The run>`,
    ].join('\n\n'));
  });

  it('is the title, the summary and the run\'s link when the whole is over 4,000', () => {
    const sections = Array.from({ length: 4 }, (_, i) => ({ heading: `Part ${i}`, body: 'word '.repeat(400).trim() }));
    const p = payload(valid(message({ sections })));
    expect(p.text).toBe(`Warning: *Projects, Tuesday 14 October*\n\nThree projects open. One is *stopped* on a decision you owe.\n\n<${RUN}|The run>`);
  });

  it('is never over 4,000, even when the summary alone escapes past it', () => {
    const p = payload(valid(message({ summary: '&'.repeat(LIMITS.summary), sections: [{ body: 'x'.repeat(2500) }, { body: 'y'.repeat(2500) }] })));
    expect([...p.text].length).toBeLessThanOrEqual(SLACK.text);
    expect(p.text.endsWith(`<${RUN}|The run>`)).toBe(true);
  });
});

describe('plan 0011 N3: one webhook, the one it is given (decision 4)', () => {
  it('the one URL in `secret` is the one posted to, once, as JSON with `text` and `blocks`', async () => {
    const m = valid(message());
    const r = await run(m, `${WEBHOOK}\n`, { status: 200, body: 'ok' });
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.url).toBe(WEBHOOK);
    expect(r.calls[0]?.init.method).toBe('POST');
    expect(r.calls[0]?.init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(r.calls[0]?.init.redirect).toBe('manual');
    expect(JSON.parse(r.calls[0]?.init.body ?? '')).toEqual(payload(m));
    expect(Object.keys(JSON.parse(r.calls[0]?.init.body ?? ''))).toEqual(['text', 'blocks']);
  });

  it('a JSON object in `secret` (a routing map) is refused as not a Slack URL, without echoing it', async () => {
    const secret = JSON.stringify({ 'project-digest': WEBHOOK, 'weekly-digest': 'https://hooks.slack.com/services/TW/BW/other' });
    const r = await run(valid(message()), secret);
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(0);
    expect(r.log).toContain('not a Slack incoming-webhook URL');
    expect(r.log).toContain("Kanon's generic webhook hook");
    expect(r.log).not.toContain('notarealsecretvalue');
    expect(r.log).not.toContain('project-digest":');
  });

  it.each([
    ['another host', 'https://example.com/services/TKANON/BKANON/notarealsecretvalue'],
    ['plain http', 'http://hooks.slack.com/services/TKANON/BKANON/notarealsecretvalue'],
    ['a look-alike host', 'https://hooks.slack.com.example.com/services/TKANON/BKANON/notarealsecretvalue'],
    ['a Slack URL that is not a webhook', 'https://hooks.slack.com/workflows/TKANON/notarealsecretvalue'],
    ['an empty secret', ''],
  ])('%s is refused the same way, without echoing it', async (_, secret) => {
    const r = await run(valid(message()), secret);
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(0);
    expect(r.log).not.toContain('notarealsecretvalue');
    if (secret) expect(r.log).toContain('not a Slack incoming-webhook URL');
  });
});

describe('plan 0011 N3: errors and the one retry (§5.4, §7.2)', () => {
  it('a 429 with `Retry-After: 5` retries once, after five seconds', async () => {
    const r = await run(valid(message()), WEBHOOK, { status: 429, headers: { 'Retry-After': '5' } }, { status: 200, body: 'ok' });
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]?.url).toBe(WEBHOOK);
    expect(r.sleeps).toEqual([5000]);
    expect(r.log).toContain('after one retry');
  });

  it('a second 429 fails: once, never twice', async () => {
    const r = await run(valid(message()), WEBHOOK, { status: 429, headers: { 'Retry-After': '5' } });
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(2);
    expect(r.log).toContain('HTTP 429');
  });

  it('a 429 asking for more than 60 seconds is not retried', async () => {
    const r = await run(valid(message()), WEBHOOK, { status: 429, headers: { 'Retry-After': '61' } });
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.sleeps).toEqual([]);
  });

  it('a 400 `invalid_payload` fails naming it, and not the URL', async () => {
    const r = await run(valid(message()), WEBHOOK, { status: 400, body: 'invalid_payload' });
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.log).toContain('HTTP 400 invalid_payload');
    expect(r.log).not.toContain('hooks.slack.com');
    expect(r.log).not.toContain('notarealsecretvalue');
  });

  it('an answer body that is not Slack\'s error string is never printed', async () => {
    const r = await run(valid(message()), WEBHOOK, { status: 500, body: `<html>${WEBHOOK}</html>` });
    expect(r.code).toBe(1);
    expect(r.log).toContain('HTTP 500');
    expect(r.log).not.toContain('html');
    expect(r.log).not.toContain('notarealsecretvalue');
  });

  it('a request that throws fails without its message, which could name the host', async () => {
    const logs: string[] = [];
    const code = await main({
      env: { MESSAGE_FILE: 'm', TEXT_FILE: 't', KIND: 'deploy', SECRET: WEBHOOK },
      io: { fetch: async () => { throw Object.assign(new TypeError(`fetch failed ${WEBHOOK}`), { cause: { code: 'ECONNRESET' } }); }, sleep: async () => {} },
      readFile: () => JSON.stringify(message()),
      out: { log: (x: string) => logs.push(x), error: (x: string) => logs.push(x) },
    });
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('The request to Slack failed (ECONNRESET)');
    expect(logs.join('\n')).not.toContain('notarealsecretvalue');
  });

  it('a kind it doesn\'t know is posted as a generic message, never dropped (§3.2)', async () => {
    const r = await run(message({ kind: 'release', severity: 'notice' }), WEBHOOK, { status: 200, body: 'ok' });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.calls[0]?.init.body ?? '').blocks[0].text.text).toBe(`${EMOJI.info} Projects, Tuesday 14 October`);
  });
});

describe('plan 0011 N3: the action and the hook file `kanon init` writes (§7.1)', () => {
  const INPUTS = ['message-v1', 'text', 'kind', 'secret'];
  const action = parse(readFileSync(join(ROOT, 'actions/notify/slack/action.yml'), 'utf8')) as Any;
  const hook = parse(readFileSync(join(ROOT, 'actions/notify/hooks/slack.yml'), 'utf8')) as Any;
  const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

  it('the action reads the hook interface\'s four inputs and nothing else, through the environment', () => {
    expect(Object.keys(action.inputs)).toEqual(INPUTS);
    expect(action.runs.using).toBe('composite');
    expect(action.runs.steps).toHaveLength(1);
    expect(action.runs.steps[0].run).toBe('node "$GITHUB_ACTION_PATH/slack.mjs"');
    expect(action.runs.steps[0].env).toEqual({
      MESSAGE_FILE: '${{ inputs.message-v1 }}',
      TEXT_FILE: '${{ inputs.text }}',
      KIND: '${{ inputs.kind }}',
      SECRET: '${{ inputs.secret }}',
    });
  });

  it('`hooks/slack.yml` is a composite hook declaring the four inputs, all required', () => {
    expect(hook.runs.using).toBe('composite');
    expect(Object.keys(hook.inputs)).toEqual(INPUTS);
    for (const name of INPUTS) expect(hook.inputs[name].required).toBe(true);
  });

  it('its one step names `actions/notify/slack` at a version tag, the release\'s own, and passes the four inputs through', () => {
    expect(hook.runs.steps).toHaveLength(1);
    const step = hook.runs.steps[0];
    expect(step.uses).toMatch(/^yedeya-labs\/kanon\/actions\/notify\/slack@v\d+\.\d+\.\d+$/);
    expect(step.uses).toBe(`yedeya-labs/kanon/actions/notify/slack@v${version}`);
    expect(step.with).toEqual(Object.fromEntries(INPUTS.map((n) => [n, `\${{ inputs.${n} }}`])));
  });

  it('the pin carries the release-please marker, so a release moves it', () => {
    const line = readFileSync(join(ROOT, 'actions/notify/hooks/slack.yml'), 'utf8').split('\n').find((l) => l.includes('uses:'));
    expect(line).toMatch(/# x-release-please-version$/);
  });
});
