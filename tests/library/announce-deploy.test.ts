import { describe, expect, it } from 'vitest';
import { validate } from '../../scripts/lib/notify-contract.mjs';
import { kanonBullet, kanonList, kanonMaint } from '../../scripts/lib/release-notes.mjs';
import { API, buildDeployMessage, buildFailureMessage, failureSeverity, main, parseTag, produce, selectReleases } from '../../scripts/announce-deploy.mjs';

/**
 * Plan 0011 step N9, wired into plan 0010's lane (the Owner's decisions of 2026-10-15):
 * `announce-deploy.mjs` is the producer of `deploy` messages, once per environment. A landed
 * deploy announces the releases since the environment's previous successful GitHub deployment; a
 * failed one is `critical` on production and `warning` elsewhere; nothing is moved after a post.
 * No case makes a request: `fetch` is injected, and records every URL it is asked for.
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

const ENV = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: REPO, STAGE: 'production', VERSION: 'v0.1.3', OUTCOME: 'ok', GITHUB_RUN_ID: '7', GITHUB_OUTPUT: 'out.txt' };

/** One deployment of the environment, newest first in the list, with its latest status. */
type Deployment = { id: number; ref: string; sha: string; state: string; run?: string };
const SHA = (n: number) => String(n).repeat(40).slice(0, 40);
/** This run's own deployment, which just succeeded: its status links run 7. */
const OWN: Deployment = { id: 100, ref: 'v0.1.3', sha: SHA(3), state: 'success', run: '7' };

/** A GitHub API double: the environment's deployments, the releases, the tags, and every request recorded. */
function fakeGithub(deployments: Deployment[] = [OWN]) {
  const requests: { url: string, method: string }[] = [];
  const files: Record<string, string> = {};
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const io = {
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ url, method: init.method ?? 'GET' });
      const statuses = /\/deployments\/(\d+)\/statuses/.exec(url);
      if (statuses) {
        const d = deployments.find((x) => x.id === Number(statuses[1]))!;
        return json(200, [{ state: d.state, log_url: `https://github.com/${REPO}/actions/runs/${d.run ?? '1'}/job/9` }]);
      }
      if (url.includes('/deployments?')) return json(200, deployments.map(({ id, ref, sha }) => ({ id, ref, sha })));
      if (url.includes('/tags')) return json(200, [1, 2, 3, 5].map((n) => ({ name: `v0.1.${n}`, commit: { sha: SHA(n) } })));
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

  it('caps a list with an …and N more line, and rolls Maintenance into one line', () => {
    expect(kanonList(['**a:** 1', '**a:** 2', '**a:** 3'], 2)).toBe('- a: 1\n- a: 2\n…and 1 more');
    expect(kanonList([])).toBe('');
    expect(kanonMaint(['**deps:** bump x', '**ci:** y'])).toBe('1 dependency update · ci updates');
  });

  it("selects the releases since the previous deployment's, or the deployed one alone with none", () => {
    expect(selectReleases(RELEASES, '0.1.5', '0.1.1').map((r: Any) => r.tag_name)).toEqual(['v0.1.2', 'v0.1.3', 'v0.1.5']);
    expect(selectReleases(RELEASES, '0.1.3', null).map((r: Any) => r.tag_name)).toEqual(['v0.1.3']);
    // A release is newer than a pre-release of its own version.
    expect(selectReleases(RELEASES, '0.1.3', 'v0.1.3-rc.1').map((r: Any) => r.tag_name)).toEqual(['v0.1.3']);
  });
});

describe('a landed deploy announces the releases since the environment\'s previous successful deployment', () => {
  const message = (g: ReturnType<typeof fakeGithub>, path = 'message.json') => JSON.parse(g.files[path] ?? 'null');

  it('writes a valid message for the range and names it in the output, reading only', async () => {
    const g = fakeGithub([OWN, { id: 99, ref: 'v0.1.1', sha: SHA(1), state: 'success' }]);
    expect(await produce({ env: { ...ENV, MESSAGE_PATH: 'm.json' }, io: g.io, out: g.out })).toBe(0);
    const m = message(g, 'm.json');
    expect(validate(m)).toEqual({ ok: true });
    expect(m.source.run_url).toBe(RUN);
    expect(m.title).toBe('v0.1.2 to v0.1.3 (2 releases) are live on production');
    expect(g.files['out.txt']).toBe('message=m.json\n');
    expect(g.requests.every((r) => r.method === 'GET')).toBe(true);
    expect(g.requests.some((r) => r.url.includes('/deployments?environment=production&'))).toBe(true);
  });

  it("skips this run's own deployment, a failed one, and reads a dispatch's commit through the tags", async () => {
    const g = fakeGithub([OWN, { id: 98, ref: 'v0.1.2', sha: SHA(2), state: 'failure' }, { id: 97, ref: 'main', sha: SHA(1), state: 'success' }]);
    expect(await produce({ env: ENV, io: g.io, out: g.out })).toBe(0);
    expect(message(g).title).toBe('v0.1.2 to v0.1.3 (2 releases) are live on production');
  });

  it('announces the deployed release alone with no earlier successful deployment, or one it cannot read', async () => {
    for (const deployments of [[OWN], [], [OWN, { id: 97, ref: 'main', sha: 'f'.repeat(40), state: 'success' }]]) {
      const g = fakeGithub(deployments);
      expect(await produce({ env: ENV, io: g.io, out: g.out })).toBe(0);
      expect(message(g).title).toBe('v0.1.3 is live on production');
    }
  });

  it('announces nothing on a redeploy of the same release, and the deployed release alone on a rollback', async () => {
    const same = fakeGithub([OWN, { id: 99, ref: 'v0.1.3', sha: SHA(3), state: 'success' }]);
    expect(await produce({ env: ENV, io: same.io, out: same.out })).toBe(0);
    expect(Object.keys(same.files)).toEqual(['out.txt']);
    expect(same.files['out.txt']).toBe('message=\n');
    const back = fakeGithub([OWN, { id: 99, ref: 'v0.1.5', sha: SHA(5), state: 'success' }]);
    expect(await produce({ env: ENV, io: back.io, out: back.out })).toBe(0);
    expect(message(back).title).toBe('v0.1.3 is live on production');
  });

  it("reads a deployment another run made as the previous one, so this run's is told apart by its run", async () => {
    // Were this run's own deployment read as the previous one, every landed deploy would announce nothing.
    const g = fakeGithub([{ ...OWN, run: '6' }, { id: 99, ref: 'v0.1.1', sha: SHA(1), state: 'success' }]);
    expect(await produce({ env: ENV, io: g.io, out: g.out })).toBe(0);
    expect(g.files['out.txt']).toBe('message=\n');
  });

  it('on a dry run, prints the message, its text and the Slack payload, and writes no message', async () => {
    const g = fakeGithub();
    expect(await produce({ env: { ...ENV, DRY_RUN: '1', GITHUB_STEP_SUMMARY: 'summary.md' }, io: g.io, out: g.out })).toBe(0);
    expect(g.files['message.json']).toBeUndefined();
    expect(g.files['summary.md']).toContain('"kind": "deploy"');
    expect(g.files['summary.md']).toContain("Kanon's Slack hook's payload");
  });

  it('refuses a STAGE of more than one line, before any request', async () => {
    const g = fakeGithub();
    expect(await produce({ env: { ...ENV, STAGE: 'a\nb' }, io: g.io, out: g.out })).toBe(1);
    expect(g.requests).toEqual([]);
  });
});

describe('a release tag with a line prefix, as release-please writes for a component (kanon#1039)', () => {
  /** Two components' lines and a pre-release, each with its own version line. */
  const LINES = [
    release(1, { tag_name: 'widgets-v1.0.0' }), release(2, { tag_name: 'widgets-v1.1.0' }), release(3, { tag_name: 'widgets-v1.2.0' }),
    release(4, { tag_name: 'gadgets-v1.0.5' }), release(6, { tag_name: 'gadgets-v1.1.5' }), release(5, { tag_name: 'candidate-v1.3.0', prerelease: true }),
  ];
  const lined = (deployments: Deployment[]) => {
    const g = fakeGithub(deployments);
    const fetch = g.io.fetch;
    g.io.fetch = (async (input: string | URL | Request, init?: RequestInit) => (String(input).includes('/releases') ? new Response(JSON.stringify(LINES)) : fetch(input, init))) as typeof globalThis.fetch;
    return g;
  };
  const own = (tag: string): Deployment => ({ ...OWN, ref: tag });

  it('reads the line, the version and a pre-release, trying the bare shapes first', () => {
    expect(parseTag('widgets-v1.2.0')).toEqual({ line: 'widgets', parts: [1, 2, 0], pre: false, suffix: '' });
    expect(parseTag('my-app-1.2.0')).toMatchObject({ line: 'my-app', parts: [1, 2, 0] });
    expect(parseTag('v1.2.3-rc.1')).toEqual({ line: '', parts: [1, 2, 3], pre: true, suffix: '-rc.1' });
    expect(parseTag('candidate-v1.3.0')).toMatchObject({ line: 'candidate', pre: false });
    expect(parseTag('latest')).toBeNull();
  });

  it("announces the range within the deployed tag's line alone, keeping the full tag in the title and the link", async () => {
    const g = lined([own('widgets-v1.2.0'), { id: 99, ref: 'widgets-v1.0.0', sha: SHA(1), state: 'success' }]);
    expect(await produce({ env: { ...ENV, VERSION: 'widgets-v1.2.0' }, io: g.io, out: g.out })).toBe(0);
    const m = JSON.parse(g.files['message.json'] ?? '');
    expect(validate(m)).toEqual({ ok: true });
    expect(m.title).toBe('widgets-v1.1.0 to widgets-v1.2.0 (2 releases) are live on production');
    // gadgets-v1.1.5 falls between them by number, and is another line's.
    expect(selectReleases(LINES, 'widgets-v1.2.0', 'widgets-v1.0.0').map((r: Any) => r.tag_name)).toEqual(['widgets-v1.1.0', 'widgets-v1.2.0']);
  });

  it("never starts the range at another line's deployment: it announces the deployed release alone", async () => {
    // gadgets-v1.0.5 is older by number, so read as widgets' start it would announce widgets-v1.1.0 too.
    const g = lined([own('widgets-v1.2.0'), { id: 99, ref: 'gadgets-v1.0.5', sha: SHA(4), state: 'success' }]);
    expect(await produce({ env: { ...ENV, VERSION: 'widgets-v1.2.0' }, io: g.io, out: g.out })).toBe(0);
    const m = JSON.parse(g.files['message.json'] ?? '');
    expect(m.title).toBe('widgets-v1.2.0 is live on production');
    expect(m.links[0].url).toBe(`https://github.com/${REPO}/releases/tag/widgets-v1.2.0`);
  });

  it('announces a prefixed pre-release, as GitHub marks it, alone, and a failure names the tag whole', async () => {
    const g = lined([own('candidate-v1.3.0'), { id: 99, ref: 'widgets-v1.0.0', sha: SHA(1), state: 'success' }]);
    expect(await produce({ env: { ...ENV, VERSION: 'candidate-v1.3.0' }, io: g.io, out: g.out })).toBe(0);
    expect(JSON.parse(g.files['message.json'] ?? '').title).toBe('candidate-v1.3.0 is live on production');
    const f = lined([]);
    expect(await produce({ env: { ...ENV, VERSION: 'widgets-v1.2.0', OUTCOME: 'failed', FAILED_STAGE: 'smoke' }, io: f.io, out: f.out })).toBe(0);
    expect(JSON.parse(f.files['message.json'] ?? '').title).toBe('widgets-v1.2.0 failed to deploy to production');
  });

  it('refuses a tag of no version shape, before any request', async () => {
    const g = lined([]);
    expect(await produce({ env: { ...ENV, VERSION: 'latest' }, io: g.io, out: g.out })).toBe(1);
    expect(g.requests).toEqual([]);
  });
});

describe('under the no-environments fallback, with no deployment to read (kanon#1038)', () => {
  const FALLBACK = { ...ENV, FALLBACK: 'no-environments' };

  it('reads no deployment and starts at the release before the deployed one, so it announces that release alone', async () => {
    // Even a deployment from before the fallback is not read: under it, GitHub records none, so one would be stale.
    const g = fakeGithub([OWN, { id: 99, ref: 'v0.1.1', sha: SHA(1), state: 'success' }]);
    expect(await produce({ env: FALLBACK, io: g.io, out: g.out })).toBe(0);
    expect(JSON.parse(g.files['message.json'] ?? '').title).toBe('v0.1.3 is live on production');
    expect(g.requests.map((r) => r.url.replace(`${API}/repos/${REPO}`, ''))).toEqual(['/releases?per_page=100']);
  });

  it('announces a redeploy of the same release again, since nothing tells it apart', async () => {
    const g = fakeGithub([]);
    expect(await produce({ env: FALLBACK, io: g.io, out: g.out })).toBe(0);
    expect(JSON.parse(g.files['message.json'] ?? '').title).toBe('v0.1.3 is live on production');
  });

  it('reads the deployments with any other fallback, or none', async () => {
    const g = fakeGithub([OWN, { id: 99, ref: 'v0.1.1', sha: SHA(1), state: 'success' }]);
    expect(await produce({ env: { ...ENV, FALLBACK: 'no-reviewers' }, io: g.io, out: g.out })).toBe(0);
    expect(JSON.parse(g.files['message.json'] ?? '').title).toBe('v0.1.2 to v0.1.3 (2 releases) are live on production');
  });
});

describe('a failed deploy posts too (the Owner\'s decision of 2026-10-15)', () => {
  const FAIL = { ...ENV, OUTCOME: 'failed', FAILED_STAGE: 'deploy', ISSUE: '42', SHA: 'abc1234def' };

  it('is critical on production, naming the environment, the release, the stage, the run and the issue', async () => {
    const g = fakeGithub();
    expect(await produce({ env: FAIL, io: g.io, out: g.out })).toBe(0);
    const m = JSON.parse(g.files['message.json'] ?? '');
    expect(validate(m)).toEqual({ ok: true });
    expect(m).toMatchObject({ kind: 'deploy', severity: 'critical', title: 'v0.1.3 failed to deploy to production' });
    expect(m.summary).toBe('**v0.1.3** did not deploy to **production**: it failed at the **deploy** stage. Build `abc1234`.');
    expect(m.sections[0].fields).toEqual([{ label: 'Environment', value: 'production' }, { label: 'Release', value: 'v0.1.3' }, { label: 'Failed stage', value: 'deploy' }]);
    expect(m.links).toEqual([{ label: 'Run', url: RUN }, { label: 'Issue #42', url: `https://github.com/${REPO}/issues/42` }]);
    // A failure reads no deployment and no release.
    expect(g.requests).toEqual([]);
  });

  it('is a warning on any other environment', async () => {
    const g = fakeGithub();
    expect(await produce({ env: { ...FAIL, STAGE: 'staging', ROLE: 'pre-production', ISSUE: '' }, io: g.io, out: g.out })).toBe(0);
    const m = JSON.parse(g.files['message.json'] ?? '');
    expect(validate(m)).toEqual({ ok: true });
    expect(m).toMatchObject({ severity: 'warning', title: 'v0.1.3 failed to deploy to staging' });
    expect(m.links).toEqual([{ label: 'Run', url: RUN }]);
    expect(failureSeverity('production')).toBe('critical');
    expect(failureSeverity('pre-production')).toBe('warning');
  });

  it('keeps text nobody controls literal', () => {
    const m = buildFailureMessage({ repo: REPO, stage: 'prod_eu', role: 'production', version: 'v1.0.0', failedStage: 'build', runUrl: RUN });
    expect(validate(m)).toEqual({ ok: true });
    expect(m.summary).toContain('**prod\\_eu**');
  });

  it.each(['refused', 'rejected', 'cancelled', ''])('announces nothing for %j, reading nothing', async (outcome) => {
    const g = fakeGithub();
    expect(await produce({ env: { ...ENV, OUTCOME: outcome }, io: g.io, out: g.out })).toBe(0);
    expect(g.files).toEqual({ 'out.txt': 'message=\n' });
    expect(g.requests).toEqual([]);
  });
});

describe('live, smoke failed: the landed message, flagged (plan 0013 §7.2, `K-SHIP-10`)', () => {
  const SMOKE = { ...ENV, OUTCOME: 'smoke_failed', FAILED_STAGE: 'smoke', ISSUE: '51', SHA: 'abc1234def' };
  const message = (g: ReturnType<typeof fakeGithub>) => JSON.parse(g.files['message.json'] ?? 'null');

  it('says the release is live and its smoke check failed, with the same sections a landed deploy gets, critical on production', async () => {
    const g = fakeGithub([OWN, { id: 99, ref: 'v0.1.2', sha: SHA(2), state: 'success' }]);
    expect(await produce({ env: SMOKE, io: g.io, out: g.out })).toBe(0);
    const m = message(g);
    expect(validate(m)).toEqual({ ok: true });
    expect(m).toMatchObject({ kind: 'deploy', severity: 'critical', title: 'v0.1.3 is live on production, and its smoke check failed' });
    expect(m.summary).toBe("**v0.1.3** is now live on **production**. Build `abc1234`. The smoke check failed: the release is live and unchecked, and the environments after **production** don't start.");
    // The flag first, then what went live, exactly as an `ok` deploy lists it.
    expect(m.sections.map((s: Any) => s.heading)).toEqual(['Smoke check', 'Features', 'Fixes', 'Maintenance']);
    expect(m.sections[0].fields).toEqual([{ label: 'Smoke check', value: 'failed at smoke' }]);
    const landed: Any = buildDeployMessage({ repo: REPO, stage: 'production', runUrl: RUN, releases: [release(3)] });
    expect(m.sections.slice(1)).toEqual(landed.sections);
    expect(m.links).toEqual([
      { label: 'Run', url: RUN },
      { label: 'Smoke issue #51', url: `https://github.com/${REPO}/issues/51` },
      { label: 'Release notes', url: `https://github.com/${REPO}/releases/tag/v0.1.3` },
    ]);
    expect(JSON.stringify(m)).not.toMatch(/failed to deploy|did not deploy/);
  });

  it('is a warning elsewhere, and a failed reset says the smoke check did not run', async () => {
    const g = fakeGithub();
    expect(await produce({ env: { ...SMOKE, STAGE: 'staging', ROLE: 'pre-production', FAILED_STAGE: 'reset', ISSUE: '' }, io: g.io, out: g.out })).toBe(0);
    const m = message(g);
    expect(validate(m)).toEqual({ ok: true });
    expect(m).toMatchObject({ severity: 'warning', title: 'v0.1.3 is live on staging, and its smoke check failed' });
    expect(m.summary).toContain("The reset hook failed, so the smoke check didn't run");
    expect(m.sections[0].fields).toEqual([{ label: 'Smoke check', value: 'failed at reset' }]);
    expect(m.links.map((l: Any) => l.label)).toEqual(['Run', 'Release notes']);
  });

  it('is never skipped: a redeploy of the live release names it alone', async () => {
    const g = fakeGithub([OWN, { id: 99, ref: 'v0.1.3', sha: SHA(3), state: 'success' }]);
    expect(await produce({ env: SMOKE, io: g.io, out: g.out })).toBe(0);
    expect(message(g).title).toBe('v0.1.3 is live on production, and its smoke check failed');
    expect(g.files['out.txt']).toBe('message=message.json\n');
  });

  it('a range says the smoke check of the range failed', async () => {
    const g = fakeGithub([OWN, { id: 99, ref: 'v0.1.1', sha: SHA(1), state: 'success' }]);
    expect(await produce({ env: SMOKE, io: g.io, out: g.out })).toBe(0);
    expect(message(g).title).toBe('v0.1.2 to v0.1.3 (2 releases) are live on production, and the smoke check failed');
  });

  it('MUTATION: announcing a `smoke_failed` with the failure template reads "failed to deploy" and drops the sections', () => {
    const failure: Any = buildFailureMessage({ repo: REPO, stage: 'production', role: 'production', version: 'v0.1.3', failedStage: 'smoke', runUrl: RUN });
    expect(failure.title).toBe('v0.1.3 failed to deploy to production');
    expect(failure.sections.map((s: Any) => s.heading)).not.toContain('Features');
  });
});

describe('no request leaves for anything but GitHub, and nothing is written to GitHub', () => {
  it.each([
    ['a landed deploy', { OUTCOME: 'ok' }],
    ['a landed deploy, dry run', { OUTCOME: 'ok', DRY_RUN: '1' }],
  ])('%s', async (_name, extra) => {
    const g = fakeGithub([OWN, { id: 99, ref: 'v0.1.1', sha: SHA(1), state: 'success' }]);
    expect(await main({ argv: [], env: { ...ENV, ...extra, KANON_CHAT_DEPLOY: 'https://hooks.slack.com/services/T/B/x' }, io: g.io, out: g.out })).toBe(0);
    expect(g.requests.length).toBeGreaterThan(0);
    for (const r of g.requests) {
      expect(r.url.startsWith(`${API}/repos/${REPO}/`)).toBe(true);
      expect(r.method).toBe('GET');
    }
  });

  it('reads no chat secret, and no repository variable', async () => {
    const { readFileSync } = await import('node:fs');
    const code = readFileSync(new URL('../../scripts/announce-deploy.mjs', import.meta.url), 'utf8');
    const lines = code.split('\n').filter((l) => !/^\s*(\/\/|\/\*\*|\*)/.test(l));
    expect(lines.join('\n')).not.toMatch(/KANON_CHAT_|SLACK_RELEASE_WEBHOOK|DIGEST_WEBHOOK|WEBHOOK|actions\/variables|ANNOUNCED_/);
  });

  it('takes no argument: --advance is gone', async () => {
    const g = fakeGithub();
    expect(await main({ argv: ['--advance'], env: ENV, io: g.io, out: g.out })).toBe(1);
    expect(g.lines.join('\n')).toMatch(/--advance is gone/);
    expect(g.requests).toEqual([]);
  });
});
