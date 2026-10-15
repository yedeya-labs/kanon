import { describe, expect, it } from 'vitest';
import { validate } from '../../scripts/lib/notify-contract.mjs';
import { kanonBullet, kanonList, kanonMaint, renderMaint } from '../../scripts/lib/release-notes.mjs';
import { API, advance, buildDeployMessage, main, produce, selectReleases } from '../../scripts/announce-deploy.mjs';

/**
 * Plan 0011 step N9: `announce-deploy.mjs` is the producer of `deploy` messages, and moving
 * ANNOUNCED_<STAGE>_VERSION is a mode of its own, `--advance`, run only after `notify` posted. Each
 * "What must be true" of the N9 row is a case here, by name. No case makes a request: `fetch` is
 * injected, and records every URL it is asked for.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a message is read field by field
type Any = Record<string, any>;

const REPO = 'acme/widgets';
const RUN = 'https://github.com/acme/widgets/actions/runs/7';

const NOTES = (n: number) => [
  '## [0.1.' + n + '](https://github.com/acme/widgets/compare/v0.1.0...v0.1.' + n + ') (2026-10-14)',
  '### Features',
  `* **checkout:** add-on number ${n} for \`Array<string>\` and **urgent** snake_case_name ([#${10 + n}](https://github.com/acme/widgets/issues/${10 + n})) ([abc1234](https://github.com/acme/widgets/commit/abc1234))`,
  '### Bug Fixes',
  `* **ui:** fix ${n} ([#${20 + n}](https://github.com/acme/widgets/issues/${20 + n}))`,
  '* **deps:** bump lodash',
  '* **ci:** speed up',
].join('\n');

const release = (n: number, over: Any = {}) => ({ tag_name: `v0.1.${n}`, body: NOTES(n), draft: false, prerelease: false, ...over });
const RELEASES = [release(1), release(2), release(3), release(4, { draft: true }), release(5)];

const ENV = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: REPO, STAGE: 'production', VERSION: '0.1.3', GITHUB_RUN_ID: '7', GITHUB_OUTPUT: 'out.txt' };

/** A GitHub API double: the variable (or a 404), the releases, and every request recorded. */
function fakeGithub(last: string | null, opts: { patch404?: boolean } = {}) {
  const requests: { url: string, method: string, body?: string }[] = [];
  const files: Record<string, string> = {};
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const io = {
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      requests.push({ url, method, body: init.body ? String(init.body) : undefined });
      if (url.endsWith('/actions/variables/ANNOUNCED_PRODUCTION_VERSION') && method === 'GET') {
        return last === null ? json(404, { message: 'Not Found' }) : json(200, { name: 'ANNOUNCED_PRODUCTION_VERSION', value: last });
      }
      if (url.endsWith('/actions/variables/ANNOUNCED_PRODUCTION_VERSION') && method === 'PATCH') return opts.patch404 ? json(404, {}) : new Response(null, { status: 204 });
      if (url.endsWith('/actions/variables') && method === 'POST') return new Response(null, { status: 201 });
      if (url.includes('/releases')) return json(200, RELEASES);
      return json(500, {});
    }) as typeof fetch,
    writeFile: (p: string, t: string) => { files[p] = t; },
    appendFile: (p: string, t: string) => { files[p] = (files[p] ?? '') + t; },
  };
  const lines: string[] = [];
  const out = { log: (s: string) => lines.push(s), error: (s: string) => lines.push(`ERROR ${s}`) };
  return { io, out, requests, files, lines };
}

describe('a valid `deploy` message', () => {
  it('for one release', () => {
    const m: Any = buildDeployMessage({ repo: REPO, stage: 'production', sha: 'abc1234def', runUrl: RUN, releases: [release(3)] });
    expect(validate(m)).toEqual({ ok: true });
    expect(m).toMatchObject({ schema_version: 1, kind: 'deploy', severity: 'info', title: 'v0.1.3 is live on production', source: { repository: REPO, lane: 'deploy', run_url: RUN } });
    expect(m.summary).toBe('**v0.1.3** is now live on **production**. Build `abc1234`.');
    expect(m.sections.map((s: Any) => s.heading)).toEqual(['Features', 'Fixes', 'Maintenance']);
    expect(m.links).toEqual([{ label: 'Release notes', url: 'https://github.com/acme/widgets/releases/tag/v0.1.3' }]);
  });

  it('for a range, merging every release into one summary', () => {
    const m: Any = buildDeployMessage({ repo: REPO, stage: 'production', runUrl: RUN, releases: [release(1), release(2), release(3)] });
    expect(validate(m)).toEqual({ ok: true });
    expect(m.title).toBe('v0.1.1 to v0.1.3 (3 releases) are live on production');
    expect(m.summary).toBe('**v0.1.1** to **v0.1.3**, 3 releases, are now live on **production**.');
    const features = m.sections.find((s: Any) => s.heading === 'Features');
    expect(features.body.split('\n')).toHaveLength(3);
    expect(m.links[0].url).toBe('https://github.com/acme/widgets/releases');
  });

  it('holds no Slack syntax, and text nobody controls stays literal', () => {
    const m: Any = buildDeployMessage({ repo: REPO, stage: 'prod_eu', runUrl: RUN, releases: [release(3)] });
    const text = JSON.stringify(m);
    expect(text).not.toMatch(/<https?:[^>]*\|/);
    expect(text).not.toMatch(/:rocket:/);
    expect(m.sections[0].body).toBe('- checkout: add-on number 3 for \\`Array<string>\\` and \\*\\*urgent\\*\\* snake\\_case\\_name ([#13](https://github.com/acme/widgets/issues/13))');
    expect(m.summary).toContain('**prod\\_eu**');
  });

  it('stays valid however long the notes run', () => {
    const huge = Array.from({ length: 40 }, (_, i) => release(i + 1, { body: `### Features\n${Array.from({ length: 200 }, (_, j) => `* **s${j}:** ${'x'.repeat(400)} ${i}-${j}`).join('\n')}` }));
    expect(validate(buildDeployMessage({ repo: REPO, stage: 'production', runUrl: RUN, releases: huge }))).toEqual({ ok: true });
  });
});

describe('the release-note helpers in Kanon text', () => {
  it('drops a link that is not https://, and keeps the PR link otherwise', () => {
    expect(kanonBullet('**a:** b ([#1](http://x.test/1))')).toBe('a: b');
    expect(kanonBullet('**a:** b ([#1](https://x.test/1))')).toBe('a: b ([#1](https://x.test/1))');
  });

  it('caps a list with an …and N more line, and Maintenance matches the Slack rendering', () => {
    expect(kanonList(['**a:** 1', '**a:** 2', '**a:** 3'], 2)).toBe('- a: 1\n- a: 2\n…and 1 more');
    expect(kanonList([])).toBe('');
    const maint = ['**deps:** bump x', '**ci:** y'];
    expect(kanonMaint(maint)).toBe('1 dependency update · ci updates');
    expect(renderMaint(maint)).toBe('\n*Maintenance* — 1 dependency update · ci updates\n');
  });

  it('selects the releases since the last announced, or the deployed one alone on a first run', () => {
    expect(selectReleases(RELEASES, '0.1.5', '0.1.1').map((r: Any) => r.tag_name)).toEqual(['v0.1.2', 'v0.1.3', 'v0.1.5']);
    expect(selectReleases(RELEASES, '0.1.3', null).map((r: Any) => r.tag_name)).toEqual(['v0.1.3']);
  });
});

describe('produce writes one message.json and moves nothing', () => {
  it('writes a valid message for the range and names it in the output', async () => {
    const g = fakeGithub('0.1.1');
    expect(await produce({ env: { ...ENV, MESSAGE_PATH: 'm.json' }, io: g.io, out: g.out })).toBe(0);
    const m = JSON.parse(g.files['m.json'] ?? '');
    expect(validate(m)).toEqual({ ok: true });
    expect(m.source.run_url).toBe(RUN);
    expect(m.title).toBe('v0.1.2 to v0.1.3 (2 releases) are live on production');
    expect(g.files['out.txt']).toBe('message=m.json\n');
    expect(g.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('writes nothing, and an empty output, when there is nothing new', async () => {
    const g = fakeGithub('0.1.3');
    expect(await produce({ env: ENV, io: g.io, out: g.out })).toBe(0);
    expect(Object.keys(g.files)).toEqual(['out.txt']);
    expect(g.files['out.txt']).toBe('message=\n');
  });

  it('on a dry run, prints the message, its text and the Slack payload, and writes no message', async () => {
    const g = fakeGithub(null);
    expect(await produce({ env: { ...ENV, DRY_RUN: '1', GITHUB_STEP_SUMMARY: 'summary.md' }, io: g.io, out: g.out })).toBe(0);
    expect(g.files['message.json']).toBeUndefined();
    expect(g.files['summary.md']).toContain('"kind": "deploy"');
    expect(g.files['summary.md']).toContain("Kanon's Slack hook's payload");
  });

  it('refuses a STAGE that makes no variable name, before any request', async () => {
    const g = fakeGithub(null);
    expect(await produce({ env: { ...ENV, STAGE: '../x' }, io: g.io, out: g.out })).toBe(1);
    expect(g.requests).toEqual([]);
  });
});

describe('no request leaves for anything but GitHub', () => {
  it.each([
    ['produce', [], {}],
    ['produce, dry run', [], { DRY_RUN: '1' }],
    ['--advance', ['--advance'], { NOTIFY_RESULT: 'success' }],
    ['--advance, creating the variable', ['--advance'], { NOTIFY_RESULT: 'success' }],
  ])('%s', async (name, argv, extra) => {
    const g = fakeGithub(name.includes('creating') ? null : '0.1.1', { patch404: name.includes('creating') });
    expect(await main({ argv, env: { ...ENV, ...extra, KANON_CHAT_DEPLOY: 'https://hooks.slack.com/services/T/B/x' }, io: g.io, out: g.out })).toBe(0);
    expect(g.requests.length).toBeGreaterThan(0);
    for (const r of g.requests) expect(r.url.startsWith(`${API}/repos/${REPO}/`)).toBe(true);
    expect(g.requests.some((r) => r.url.includes('hooks.slack.com'))).toBe(false);
  });

  it('reads no chat secret', async () => {
    const { readFileSync } = await import('node:fs');
    const code = readFileSync(new URL('../../scripts/announce-deploy.mjs', import.meta.url), 'utf8');
    const lines = code.split('\n').filter((l) => !/^\s*(\/\/|\/\*\*|\*)/.test(l));
    expect(lines.join('\n')).not.toMatch(/KANON_CHAT_|SLACK_RELEASE_WEBHOOK|DIGEST_WEBHOOK|WEBHOOK/);
  });
});

describe('--advance moves the announced version only after notify posted', () => {
  it.each([undefined, '', 'failure', 'cancelled', 'skipped', 'Success'])('refuses with NOTIFY_RESULT=%j, making no request', async (result) => {
    const g = fakeGithub('0.1.1');
    const env: Record<string, string | undefined> = { ...ENV, NOTIFY_RESULT: result };
    expect(await advance({ env, io: g.io, out: g.out })).toBe(1);
    expect(g.requests).toEqual([]);
    expect(g.lines.join('\n')).toMatch(/--advance refuses: the notify job did not post/);
  });

  it('moves it to the deployed version with NOTIFY_RESULT=success', async () => {
    const g = fakeGithub('0.1.1');
    expect(await advance({ env: { ...ENV, NOTIFY_RESULT: 'success' }, io: g.io, out: g.out })).toBe(0);
    const patch = g.requests.find((r) => r.method === 'PATCH');
    expect(JSON.parse(patch?.body ?? '{}')).toEqual({ name: 'ANNOUNCED_PRODUCTION_VERSION', value: '0.1.3' });
  });

  it('creates the variable on a first run', async () => {
    const g = fakeGithub(null, { patch404: true });
    expect(await advance({ env: { ...ENV, NOTIFY_RESULT: 'success' }, io: g.io, out: g.out })).toBe(0);
    expect(g.requests.map((r) => r.method)).toEqual(['GET', 'PATCH', 'POST']);
  });

  it('never moves it back', async () => {
    const g = fakeGithub('0.1.5');
    expect(await advance({ env: { ...ENV, NOTIFY_RESULT: 'success' }, io: g.io, out: g.out })).toBe(0);
    expect(g.requests.map((r) => r.method)).toEqual(['GET']);
  });

  it('refuses an unknown flag', async () => {
    const g = fakeGithub(null);
    expect(await main({ argv: ['--force'], env: ENV, io: g.io, out: g.out })).toBe(1);
    expect(g.requests).toEqual([]);
  });
});
