/**
 * The status core and its project view (project #1327, Issue A): one injected reader and no write,
 * the declarations from the default branch, an incomplete read as an error, and the project view
 * judged by the reconciler's and the closure module's own functions.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers/adopter.js';
import { connection } from './helpers/fake-reader.js';
import { BRIEF, PROJECT, adopterFiles, adopterProject, marker, repoWorld } from './helpers/status-world.js';

const { projectView, IncompleteRead } = await import('../../scripts/status/project.mjs');
const { ReadError, ghReader, watched } = await import('../../scripts/status/reader.mjs');
const { readProjectWorld, phaseOf, HELD, HELD_MARKER } = await import('../../scripts/lead-reconcile.mjs');
const { openGatingWork } = await import('../../scripts/project-closure.mjs');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe('the status core reads through its reader alone', () => {
  it('[STAT-1] asks only REST GETs and GraphQL queries, and writes nothing while it reads', async () => {
    const w = adopterProject();
    const view: Any = await projectView({ reader: w.reader, repo: w.repo, project: PROJECT });
    expect(view.items, 'the view was built, so the reads below are the whole of it').toHaveLength(3);
    expect(w.seen.length).toBeGreaterThan(5);
    for (const s of w.seen) expect(s, s).toMatch(/^(GET|PAGES|GraphQL) /);
    for (const q of w.queries) expect(q.trimStart(), q.slice(0, 60)).toMatch(/^query\s/);

    // No write of any kind: run in a process of its own, in an empty directory, with every fs
    // write, every child process and every fetch replaced by a recorder once the core is loaded.
    const dir = mkdtempSync(join(tmpdir(), 'status-core-'));
    const script = `
      import fs from 'node:fs';
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const { projectView } = await import(${JSON.stringify(join(ROOT, 'scripts/status/project.mjs'))});
      const calls = [];
      const record = (name) => (...args) => { calls.push(name + ' ' + String(args[0])); throw new Error('the core must not ' + name); };
      for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync', 'copyFileSync', 'openSync', 'readFileSync', 'readdirSync', 'existsSync', 'statSync', 'writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'createWriteStream']) fs[name] = record('fs.' + name);
      for (const k of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'readFile', 'readdir', 'open']) fs.promises[k] = record('fs.promises.' + k);
      for (const name of ['execFileSync', 'execSync', 'spawnSync', 'spawn', 'exec', 'execFile', 'fork']) cp[name] = record('child_process.' + name);
      globalThis.fetch = record('fetch');
      syncBuiltinESMExports();
      const answers = JSON.parse(process.argv[1]);
      const reader = {
        get: (p) => { const r = answers.get[p]; if (r === undefined) throw Object.assign(new Error('not found'), { status: 404 }); return r; },
        pages: (p) => answers.pages[p] ?? [[]],
        graphql: (q, v) => answers.graphql[(/query\\s+(\\w+)/.exec(q) ?? [])[1]] ?? {},
      };
      let view;
      try { view = await projectView({ reader, repo: 'acme/shop', project: 7 }); } catch (e) { view = { error: e.message }; }
      console.log(JSON.stringify({ calls, view }));
    `;
    const answers = {
      get: {
        'repos/acme/shop': { default_branch: 'main' },
        'repos/acme/shop/contents/docs/projects/7.md?ref=main': { type: 'file', encoding: 'base64', content: Buffer.from(BRIEF).toString('base64') },
      },
      pages: {},
      graphql: {
        Labels: { repository: { labels: connection([{ name: 'enhancement' }]) } },
        Members: { search: { ...connection([]), issueCount: 0 } },
        Labelled: { repository: { issues: connection([]) } },
        Issue: { repository: { issue: { state: 'OPEN', labels: connection([]) } } },
      },
    };
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(answers)], { cwd: dir, encoding: 'utf8' });
    expect(run.stderr).toBe('');
    const out = JSON.parse(run.stdout);
    expect(out.calls, 'no file read or written, no process started, no other network').toEqual([]);
    expect(out.view.error, 'and the view was answered').toBeUndefined();
    expect(out.view.items.map((i: Any) => i.key)).toEqual(['A', 'B', 'C']);
    expect(readdirSync(dir), 'nothing left behind').toEqual([]);
  });
});

describe('the declarations come from the default branch', () => {
  it('[STAT-2] reads every declaration at the default branch, and reads a fixture adopter and Kanon alike', async () => {
    const w = adopterProject({ branch: 'trunk' });
    const view: Any = await projectView({ reader: w.reader, repo: w.repo, project: PROJECT });
    expect(view.branch).toBe('trunk');
    const contents = w.seen.filter((s) => s.includes('/contents/'));
    for (const want of [`docs/projects/${PROJECT}.md`, 'docs/qa/agent-identities.md', 'docs/qa/specs', 'docs/qa/specs/storefront.md']) {
      expect(contents, want).toContain(`GET repos/acme/shop/contents/${want}?ref=trunk`);
    }
    for (const s of contents) expect(s, 'every declaration read names the default branch').toMatch(/\?ref=trunk$/);
    expect(w.seen).toContain('GET repos/acme/shop/git/trees/trunk?recursive=1');

    // The same code over Kanon's own declarations: its brief for this project, its spec layer,
    // its register and its stack document, under another repository's name.
    const kanon = repoWorld({
      repo: 'someone/kanon',
      project: 1327,
      files: adopterFiles(ROOT, { 'docs/projects/1327.md': readFileSync(join(ROOT, 'docs/projects/1327.md'), 'utf8') }),
      tests: { 'tests/library/status.test.ts': "it('[STAT-1] reads', () => {});\n" },
    });
    const own: Any = await projectView({ reader: kanon.reader, repo: kanon.repo, project: 1327 });
    expect(own.brief.state).toBe('parsed');
    expect(own.items[0].key).toBe('A');
    expect(own.items[0].acs.map((a: Any) => [a.id, a.clause, a.tested])).toEqual([
      ['STAT-1', 'seed', true], ['STAT-2', 'seed', false], ['STAT-3', 'seed', false], ['STAT-4', 'seed', false], ['STAT-5', 'seed', false],
    ]);

    // The code names no repository, reads none from the environment, and reads no checkout. The
    // one `GITHUB_REPOSITORY` is the key of the environment the promotion's check is handed, set
    // to the repository the caller passed (the release view, Issue E).
    const dir = join(ROOT, 'scripts/status');
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/yedeya|process\.env|process\.cwd|from 'node:fs'/);
      expect(src.replace('check({ GITHUB_REPOSITORY: repo,', ''), f).not.toMatch(/GITHUB_REPOSITORY/);
    }
  });
});

describe('an incomplete read is an error', () => {
  it('[STAT-3] names the read and why, with the reset time for a rate limit, and never answers in part', async () => {
    // Refused: the reconciler reads the labels softly, and the view still fails by name.
    const refused = adopterProject({ overrides: { graphql: { Labels: () => { throw new ReadError('GraphQL Labels', 'Resource not accessible by integration', { status: 403 }); } } } });
    await expect(projectView({ reader: refused.reader, repo: refused.repo, project: PROJECT })).rejects.toThrow(/GraphQL Labels failed: Resource not accessible by integration/);

    // Rate-limited: the reset time is in the message.
    const limited = adopterProject();
    const graphql = limited.reader.graphql;
    limited.reader.graphql = (q: string, v?: Record<string, unknown>) => {
      if (/query ItemPullRequests/.test(q)) throw new ReadError('GraphQL ItemPullRequests', 'API rate limit exceeded', { status: 403, resetAt: '2026-10-23T15:00:00.000Z' });
      return graphql(q, v);
    };
    const err: Any = await projectView({ reader: limited.reader, repo: limited.repo, project: PROJECT }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncompleteRead);
    expect((err as Error).message).toMatch(/GraphQL ItemPullRequests failed: API rate limit exceeded \(the rate limit resets at 2026-10-23T15:00:00.000Z\)/);

    // Not found: a member's issue the search found and the issue read can't.
    const gone = adopterProject({ overrides: { graphql: { Issue: () => { throw new ReadError('GraphQL Issue', 'Could not resolve to an Issue with the number of 7.', { status: 404 }); } } } });
    await expect(projectView({ reader: gone.reader, repo: gone.repo, project: PROJECT })).rejects.toThrow(/project #7 couldn't be read whole, so there is no answer: GraphQL Issue failed: Could not resolve/);

    // Truncated: a search that stops before the count it reports, and a tree GitHub cut short.
    const cut = adopterProject({ overrides: { graphql: { Members: () => ({ search: { ...connection([]), issueCount: 1200 } }) } } });
    await expect(projectView({ reader: cut.reader, repo: cut.repo, project: PROJECT })).rejects.toThrow(/cut short: 0 of 1200/);
    // A listing the reconciler reads softly, which answers without the connection asked for.
    const soft = adopterProject({ overrides: { graphql: { Labelled: () => ({ repository: null }) } } });
    const softly = await projectView({ reader: soft.reader, repo: soft.repo, project: PROJECT }).catch((e: unknown) => e);
    expect(softly).toBeInstanceOf(IncompleteRead);
    expect((softly as Error).message).toMatch(/GraphQL Labelled failed: the answer has no such connection/);
    const tree = adopterProject();
    const get = tree.reader.get;
    tree.reader.get = (p: string) => (p.includes('/git/trees/') ? { truncated: true, tree: [] } : get(p));
    await expect(projectView({ reader: tree.reader, repo: tree.repo, project: PROJECT })).rejects.toThrow(/cut the tree short/);

    // `gh`'s own failures: the status it names, and the reset time read from the rate limit.
    const gh = (stderr: string) => ghReader({
      run: (args: string[]) => {
        if (args[1] === 'rate_limit') return JSON.stringify({ resources: { core: { reset: 1792767600 }, graphql: { reset: 1792771200 } } });
        throw Object.assign(new Error('exit 1'), { stderr });
      },
    });
    const e404: Any = await Promise.resolve().then(() => gh('gh: Not Found (HTTP 404)').get('repos/a/b/contents/x')).catch((e: Any) => e);
    expect([e404.status, e404.read, e404.resetAt]).toEqual([404, 'GET repos/a/b/contents/x', null]);
    const e403: Any = await Promise.resolve().then(() => gh('gh: API rate limit exceeded for installation (HTTP 403)').graphql('query Q { viewer { login } }')).catch((e: Any) => e);
    // A GraphQL read names the GraphQL limit's reset, not the core one's.
    expect(e403.message).toBe('GraphQL Q failed: API rate limit exceeded for installation (HTTP 403) (the rate limit resets at 2026-10-23T16:00:00.000Z)');

    const partial = ghReader({ run: () => JSON.stringify({ data: { repository: null }, errors: [{ message: 'Could not resolve to a Repository' }] }) });
    await expect(Promise.resolve().then(() => partial.graphql('query Repo { repository(owner: "a", name: "b") { id } }'))).rejects.toThrow('GraphQL Repo failed: Could not resolve to a Repository');

    // A failure the caller reads as an answer (a file that isn't there) is not one.
    const { reader, failures } = watched({ get: () => { throw new ReadError('GET x', 'Not Found', { status: 404 }); }, pages: () => [], graphql: () => ({}) });
    await (reader.get('x') as Promise<unknown>).catch((e: Any) => { e.expected = true; });
    expect(failures()).toEqual([]);
  });
});

describe('the project view', () => {
  it('[STAT-4] lists each item\'s issue, pull requests, dependencies and criteria, with the phase and gating work the reconciler derives', async () => {
    const w = adopterProject();
    const view: Any = await projectView({ reader: w.reader, repo: w.repo, project: PROJECT });
    const [a, b, c] = view.items;
    expect(a).toMatchObject({ key: 'A', title: 'Show the price', issue: { number: 11, state: 'CLOSED' }, prs: { open: [], merged: [21] }, dependsOn: [] });
    expect(a.acs).toEqual([{ id: 'STORE-1', declared: true, clause: 'seed', tested: true, tests: ['tests/price.test.ts'] }]);
    expect(b).toMatchObject({ key: 'B', issue: { number: 12, state: 'OPEN', labels: ['enhancement'] }, prs: { open: [22], merged: [] }, dependsOn: [{ key: 'A', issue: 11, state: 'CLOSED' }] });
    expect(b.acs, 'a mention in a helper is no citation, and an unknown id has no clause').toEqual([
      { id: 'STORE-2', declared: true, clause: 'confirmed', tested: false, tests: [] },
      { id: 'STORE-99', declared: true, clause: null, tested: false, tests: [] },
    ]);
    expect(c).toMatchObject({ key: 'C', issue: null, prs: { open: [], merged: [] }, dependsOn: [{ key: 'B', issue: 12, state: 'OPEN' }], acs: [] });

    // The phase and the gating work are the reconciler's own answers for the same reads.
    const again = adopterProject();
    const world = await readProjectWorld(PROJECT, { reader: again.reader, repo: again.repo, warn: () => {}, readBrief: () => BRIEF, explorer: null, environment: async () => null });
    expect(view.phase).toBe(phaseOf(world));
    expect(view.phase).toBe('file');
    expect(view.gating).toEqual(openGatingWork(world.open, world.proposed).map((i: Any) => i.number));
    expect(view.gating).toEqual([12]);
  });

  it('[STAT-5] names why each item can\'t proceed, and a missing or unparseable brief as that', async () => {
    const issues = [
      { number: 11, title: 'Show the price', labels: ['qa:needs-info', 'blocked'] },
      { number: 12, title: 'Place an order once', labels: ['qa:needs-split', 'qa:human-action'] },
    ];
    const w = adopterProject({ issues, prs: {} });
    const view: Any = await projectView({ reader: w.reader, repo: w.repo, project: PROJECT });
    const reasons = (i: Any) => i.stops.map((s: Any) => s.reason);
    expect(reasons(view.items[0])).toEqual(['qa:needs-info', 'blocked']);
    expect(reasons(view.items[1])).toEqual(['dependency', 'qa:needs-split', 'qa:human-action']);
    expect(view.items[1].stops[0].detail).toBe('A (#11) is still open');
    expect(reasons(view.items[2])).toEqual(['dependency']);

    // The Lead's hold: `needs:human` and its hold comment. The label alone is a person's.
    const held = adopterProject({ issues: [], tracking: { state: 'OPEN', labels: [HELD] }, trackingComments: [{ author: { login: 'x' }, body: `held\n${HELD_MARKER}`, createdAt: '2026-10-01T00:00:00Z' }] });
    const hv: Any = await projectView({ reader: held.reader, repo: held.repo, project: PROJECT });
    expect(hv.hold).toEqual({ label: HELD, by: 'lead' });
    expect(hv.items.map((i: Any) => reasons(i).at(-1))).toEqual(['lead-hold', 'lead-hold', 'lead-hold']);
    const person = adopterProject({ issues: [], tracking: { state: 'OPEN', labels: [HELD] } });
    expect(((await projectView({ reader: person.reader, repo: person.repo, project: PROJECT })) as Any).hold).toEqual({ label: HELD, by: 'person' });

    // A brief that isn't there, or doesn't parse, is reported as that: never as no items.
    const files = adopterFiles();
    const missing = repoWorld({ files });
    const mv: Any = await projectView({ reader: missing.reader, repo: missing.repo, project: PROJECT });
    expect([mv.brief.state, mv.items, mv.phase]).toEqual(['missing', null, 'awaiting-brief']);
    const prose = repoWorld({ files: { ...files, [`docs/projects/${PROJECT}.md`]: '# Project 7\n\nJust prose.\n' } });
    const pv: Any = await projectView({ reader: prose.reader, repo: prose.repo, project: PROJECT });
    expect([pv.brief.state, pv.items, pv.phase]).toEqual(['unparseable', null, 'brief-unparseable']);
  });
});

describe('the project read settles its member search before it trusts it (kanon#1322)', () => {
  const read = (w: ReturnType<typeof adopterProject>) =>
    readProjectWorld(PROJECT, { reader: w.reader, repo: w.repo, warn: () => {}, readBrief: () => BRIEF, explorer: null, environment: async () => null });
  const members = (q: string) => (/qa:project 7\b/.test(q)
    ? [11, 12].map((number, i) => ({ number, title: ['Show the price', 'Place an order once'][i], state: 'OPEN', body: marker(), closedAt: null, labels: [] }))
    : []);

  it('reads a member search that answered nothing again, and takes the members the next answer finds', async () => {
    const saved = process.env.KANON_SEARCH_WAIT_MS;
    process.env.KANON_SEARCH_WAIT_MS = '0';
    try {
      let asked = 0;
      const w = adopterProject({ overrides: { search: (q) => (asked++ === 0 ? [] : members(q)) } });
      const world: Any = await read(w);
      expect(asked, 'the empty answer was read again, until two answers agree').toBe(3);
      expect(world.all.map((i: Any) => i.number)).toEqual([11, 12]);
      expect(phaseOf(world)).toBe('file');
    } finally {
      if (saved === undefined) delete process.env.KANON_SEARCH_WAIT_MS;
      else process.env.KANON_SEARCH_WAIT_MS = saved;
    }
  });

  it('holds the project when the label listing holds members a settled zero missed', async () => {
    const saved = process.env.KANON_SEARCH_WAIT_MS;
    process.env.KANON_SEARCH_WAIT_MS = '0';
    try {
      const w = adopterProject({
        overrides: {
          search: () => [],
          graphql: { Labelled: () => ({ repository: { issues: connection([{ number: 11, body: marker() }]) } }) },
        },
      });
      const world: Any = await read(w);
      expect(world.membershipUnread).toMatch(/the member search returned 0 member\(s\), but the `project:7` label listing holds #11/);
      expect(phaseOf(world)).toBe('membership-unread');
    } finally {
      if (saved === undefined) delete process.env.KANON_SEARCH_WAIT_MS;
      else process.env.KANON_SEARCH_WAIT_MS = saved;
    }
  });
});
