import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validate } from '../../scripts/lib/notify-contract.mjs';
import { API, buildReleaseMessage, main, produce } from '../../scripts/announce-release.mjs';

/**
 * kanon#1190: `announce-release.mjs` is the producer of `release` messages, one per published
 * release, for a repository that releases without deploying (plan 0011 §3.2's `release` kind). A
 * stable release and a pre-release both post; a pre-release says so in its title and summary, and
 * both are `info` (the Owner's decision 1 of 2026-10-20). A draft announces nothing. No case makes a
 * request: `fetch` is injected, and records every URL it is asked for.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a message is read field by field
type Any = Record<string, any>;

const REPO = 'acme/widgets';
const RUN = 'https://github.com/acme/widgets/actions/runs/7';

const NOTES = [
  '## [1.4.0](https://github.com/acme/widgets/compare/v1.3.0...v1.4.0) (2026-10-20)',
  '### Features',
  '* **checkout:** pay with `Array<string>` and **urgent** snake_case_name ([#11](https://github.com/acme/widgets/issues/11)) ([abc1234](https://github.com/acme/widgets/commit/abc1234))',
  '### Bug Fixes',
  '* **ui:** fix the header ([#21](https://github.com/acme/widgets/issues/21))',
  '* **deps:** bump lodash',
  '* **ci:** speed up',
].join('\n');

const RELEASE = { tag_name: 'v1.4.0', name: 'v1.4.0', body: NOTES, draft: false, prerelease: false };
const CANDIDATE = { tag_name: 'candidate-v1.4.0', name: 'candidate-v1.4.0', body: NOTES, draft: false, prerelease: true };

const ENV = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: REPO, TAG: 'v1.4.0', GITHUB_RUN_ID: '7', GITHUB_OUTPUT: 'out.txt' };

/** A GitHub API double: the release by its tag, and every request recorded. */
function fakeGithub(releases: Any[] = [RELEASE, CANDIDATE]) {
  const requests: { url: string, method: string }[] = [];
  const files: Record<string, string> = {};
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const io = {
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ url, method: init.method ?? 'GET' });
      const byTag = /\/releases\/tags\/([^/?]+)$/.exec(url);
      if (byTag) {
        const r = releases.find((x) => x.tag_name === decodeURIComponent(byTag[1]!));
        return r ? json(200, r) : json(404, { message: 'Not Found' });
      }
      return json(500, {});
    }) as typeof fetch,
    writeFile: (p: string, t: string) => { files[p] = t; },
    appendFile: (p: string, t: string) => { files[p] = (files[p] ?? '') + t; },
  };
  const lines: string[] = [];
  const out = { log: (s: string) => lines.push(s), error: (s: string) => lines.push(`ERROR ${s}`) };
  return { io, out, requests, files, lines };
}

describe('a valid `release` message', () => {
  it('for a stable release: its tag, its notes as Features, Fixes and Maintenance, and a link to it', () => {
    const m: Any = buildReleaseMessage({ repo: REPO, release: RELEASE, runUrl: RUN });
    expect(validate(m)).toEqual({ ok: true });
    expect(m).toMatchObject({ schema_version: 1, kind: 'release', severity: 'info', title: 'acme/widgets v1.4.0 is released', source: { repository: REPO, lane: 'release-announce', run_url: RUN } });
    expect(m.summary).toBe('**acme/widgets** published the release **v1.4.0**.');
    expect(m.sections.map((s: Any) => s.heading)).toEqual(['Features', 'Fixes', 'Maintenance']);
    expect(m.sections[0].body).toBe('- checkout: pay with \\`Array<string>\\` and \\*\\*urgent\\*\\* snake\\_case\\_name ([#11](https://github.com/acme/widgets/issues/11))');
    expect(m.sections[1].body).toBe('- ui: fix the header ([#21](https://github.com/acme/widgets/issues/21))');
    expect(m.sections[2].body).toBe('1 dependency update · ci updates');
    expect(m.links).toEqual([{ label: 'Release v1.4.0', url: 'https://github.com/acme/widgets/releases/tag/v1.4.0' }]);
  });

  it('for a pre-release: its title and summary say pre-release and candidate, and it is info too (decision 1)', () => {
    const m: Any = buildReleaseMessage({ repo: REPO, release: CANDIDATE, runUrl: RUN });
    expect(validate(m)).toEqual({ ok: true });
    expect(m.severity).toBe('info');
    expect(m.title).toBe('acme/widgets candidate-v1.4.0 is a pre-release');
    expect(m.summary).toBe('**acme/widgets** published the **pre-release** **candidate-v1.4.0**, a candidate: not yet a stable release.');
    expect(m.links).toEqual([{ label: 'Release candidate-v1.4.0', url: 'https://github.com/acme/widgets/releases/tag/candidate-v1.4.0' }]);
  });

  it('names the release when its name is not its tag, as text nobody controls', () => {
    const m: Any = buildReleaseMessage({ repo: REPO, release: { ...RELEASE, name: 'The **big** one' }, runUrl: RUN });
    expect(validate(m)).toEqual({ ok: true });
    expect(m.summary).toBe('**acme/widgets** published the release **v1.4.0**, “The \\*\\*big\\*\\* one”.');
  });

  it('with notes of no known section, or none, it has no sections and still validates', () => {
    for (const body of ['Just a line, no headings.', '', null]) {
      const m: Any = buildReleaseMessage({ repo: REPO, release: { ...RELEASE, body }, runUrl: RUN });
      expect(validate(m), String(body)).toEqual({ ok: true });
      expect(m.sections, String(body)).toBeUndefined();
    }
  });

  it('a tag with characters a URL path escapes is linked escaped', () => {
    const m: Any = buildReleaseMessage({ repo: REPO, release: { ...RELEASE, tag_name: 'widgets@1.4.0', name: '' }, runUrl: RUN });
    expect(validate(m)).toEqual({ ok: true });
    expect(m.links[0].url).toBe('https://github.com/acme/widgets/releases/tag/widgets%401.4.0');
  });

  it('fits notes far past the limits, with what was left out named', () => {
    const many = ['### Features', ...Array.from({ length: 400 }, (_, i) => `* **x:** feature ${i} ${'y'.repeat(60)}`)].join('\n');
    const m: Any = buildReleaseMessage({ repo: REPO, release: { ...RELEASE, body: many }, runUrl: RUN });
    expect(validate(m)).toEqual({ ok: true });
    expect(m.sections[0].body).toMatch(/…and 392 more$/);
  });
});

describe('produce: one message per published release, written for the notify job', () => {
  it('reads the release by its tag and writes its message, naming it in the output', async () => {
    const g = fakeGithub();
    expect(await produce({ env: { ...ENV, MESSAGE_PATH: 'm.json' }, io: g.io, out: g.out })).toBe(0);
    expect(g.requests.map((r) => r.url)).toEqual([`${API}/repos/${REPO}/releases/tags/v1.4.0`]);
    const m = JSON.parse(g.files['m.json'] ?? '');
    expect(validate(m)).toEqual({ ok: true });
    expect(m).toMatchObject({ kind: 'release', title: 'acme/widgets v1.4.0 is released', source: { run_url: RUN } });
    expect(g.files['out.txt']).toBe('message=m.json\n');
  });

  it('a pre-release is announced, as one', async () => {
    const g = fakeGithub();
    expect(await produce({ env: { ...ENV, TAG: 'candidate-v1.4.0' }, io: g.io, out: g.out })).toBe(0);
    const m = JSON.parse(g.files['message.json'] ?? '');
    expect(m.title).toMatch(/pre-release/);
  });

  it('a draft announces nothing: by the event, before any read, or by the release GitHub returns', async () => {
    const byEvent = fakeGithub();
    expect(await produce({ env: { ...ENV, DRAFT: 'true' }, io: byEvent.io, out: byEvent.out })).toBe(0);
    expect(byEvent.requests).toEqual([]);
    expect(byEvent.files).toEqual({ 'out.txt': 'message=\n' });
    expect(byEvent.lines.join('\n')).toMatch(/draft/);
    const byRead = fakeGithub([{ ...RELEASE, draft: true }]);
    expect(await produce({ env: ENV, io: byRead.io, out: byRead.out })).toBe(0);
    expect(byRead.files).toEqual({ 'out.txt': 'message=\n' });
  });

  it('a tag with no published release fails by name, and writes nothing', async () => {
    const g = fakeGithub();
    expect(await produce({ env: { ...ENV, TAG: 'v9.9.9' }, io: g.io, out: g.out })).toBe(1);
    expect(g.lines.join('\n')).toMatch(/no published release tagged v9\.9\.9/);
    expect(g.files).toEqual({});
  });

  it.each([
    [{ TAG: '' }, /Missing required env: TAG/],
    [{ GITHUB_TOKEN: '' }, /Missing required env: GITHUB_TOKEN/],
    [{ GITHUB_REPOSITORY: 'not a repo' }, /GITHUB_REPOSITORY is not owner\/name/],
    [{ TAG: 'v1 .0' }, /TAG is not a tag/],
    [{ TAG: 'a\nb' }, /TAG is not a tag/],
    [{ GITHUB_SERVER_URL: 'http://github.com' }, /GITHUB_SERVER_URL is not an https:\/\/ origin/],
    [{ GITHUB_RUN_ID: '' }, /Missing required env: GITHUB_RUN_ID/],
  ])('refuses %j before any request', async (over, said) => {
    const g = fakeGithub();
    expect(await produce({ env: { ...ENV, ...over }, io: g.io, out: g.out })).toBe(1);
    expect(g.lines.join('\n')).toMatch(said);
    expect(g.requests).toEqual([]);
  });

  it('a dry run prints the message, its plain text and the Slack hook\'s payload, and writes nothing to upload', async () => {
    const g = fakeGithub();
    expect(await produce({ env: { ...ENV, DRY_RUN: '1', GITHUB_STEP_SUMMARY: 'summary.md' }, io: g.io, out: g.out })).toBe(0);
    const said = g.lines.join('\n');
    expect(said).toMatch(/^DRY RUN: would announce v1\.4\.0/);
    expect(said).toContain('--- message.json ---');
    expect(said).toContain('--- text (what a hook gets as `text`) ---');
    expect(said).toContain("--- Kanon's Slack hook's payload ---");
    expect(said).toContain('"blocks"');
    expect(g.files['message.json']).toBeUndefined();
    expect(g.files['out.txt']).toBe('message=\n');
    expect(g.files['summary.md']).toContain('DRY RUN');
  });
});

describe('no request leaves for anything but GitHub, and nothing is written to GitHub', () => {
  it.each([
    ['a release', {}],
    ['a release, dry run', { DRY_RUN: '1' }],
  ])('%s', async (_name, extra) => {
    const g = fakeGithub();
    expect(await main({ argv: [], env: { ...ENV, ...extra, KANON_CHAT_RELEASE: 'https://hooks.slack.com/services/T/B/x' }, io: g.io, out: g.out })).toBe(0);
    expect(g.requests.length).toBeGreaterThan(0);
    for (const r of g.requests) {
      expect(r.url.startsWith(`${API}/repos/${REPO}/`)).toBe(true);
      expect(r.method).toBe('GET');
    }
  });

  it('reads no chat secret', () => {
    const code = readFileSync(new URL('../../scripts/announce-release.mjs', import.meta.url), 'utf8');
    const lines = code.split('\n').filter((l) => !/^\s*(\/\/|\/\*\*|\*)/.test(l));
    expect(lines.join('\n')).not.toMatch(/KANON_CHAT_|WEBHOOK/);
  });

  it('takes no argument', async () => {
    const g = fakeGithub();
    expect(await main({ argv: ['--post'], env: ENV, io: g.io, out: g.out })).toBe(1);
    expect(g.lines.join('\n')).toMatch(/Unknown argument: --post/);
    expect(g.requests).toEqual([]);
  });
});
