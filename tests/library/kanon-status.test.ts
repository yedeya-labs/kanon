/**
 * `kanon status` (project #1327, Issue B): one `kanon-status/v1` document over the status core's
 * views, the same result as prose with the same exit code, its fields held to `docs/status.md`,
 * and the page linked from the three pages a person starts at.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers/adopter.js';
import { RELEASES, chain, promoting } from './helpers/release-world.js';
import { CHAIN_DEPLOY, PROJECT, adopterFiles, adopterProject, adoptionWith, repoWorld } from './helpers/status-world.js';

const { status, SCHEMA, EXIT } = await import('../../cli/status.mjs');
const { projectView } = await import('../../scripts/status/project.mjs');
const { ReadError } = await import('../../scripts/status/reader.mjs');
const { HELD, HELD_MARKER } = await import('../../scripts/lead-reconcile.mjs');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type World = { reader: ReturnType<typeof adopterProject>['reader']; seen: string[] };
type GhResult = { status: number | null; stdout: string; stderr: string };

const READ_AT = '2026-10-24T09:30:00.000Z';

/**
 * Runs `kanon status` over a world, with every outside effect injected: the checkout's origin
 * remote, `gh` for whose token it is, and the reader the views read through.
 */
async function run(argv: string[], w: World | null, { origin = 'git@github.com:acme/shop.git', login = 'octo' as string | null, refused = false } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const readers: string[] = [];
  const code = await status(argv, {
    git: (args: string[]) => (args.join(' ') === 'remote get-url origin' && origin ? { status: 0, stdout: `${origin}\n`, stderr: '' } : { status: 128, stdout: '', stderr: 'fatal: not a git repository' }),
    gh: async (args: string[]): Promise<GhResult> => {
      if (args.join(' ') !== 'api user --jq .login') throw new Error(`unrouted gh ${args.join(' ')}`);
      if (refused) return { status: 1, stdout: '', stderr: 'gh: Bad credentials (HTTP 401)' };
      return login ? { status: 0, stdout: `${login}\n`, stderr: '' } : { status: 1, stdout: '', stderr: 'gh: Resource not accessible by integration (HTTP 403)' };
    },
    reader: () => {
      readers.push('made');
      if (!w) throw new Error('this case reads nothing');
      return w.reader;
    },
    env: {},
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
    release: () => 'v9.9.9',
    now: () => new Date(READ_AT),
  });
  return { code, out: out.join('\n'), err: err.join('\n'), readers, doc: () => JSON.parse(out.join('\n')) };
}

/** Every key path a JSON value holds: `a.b`, and `a[].b` for each object in an array. */
function paths(value: unknown, at = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => (v !== null && typeof v === 'object' ? paths(v, `${at}[]`) : []));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
    const p = at ? `${at}.${k}` : k;
    return [p, ...paths(v, p)];
  });
}

/** The worlds that, between them, make the command emit every field it has. */
const held = () => adopterProject({
  tracking: { state: 'OPEN', labels: [HELD] },
  trackingComments: [{ author: { login: 'lead' }, body: `held\n${HELD_MARKER}`, createdAt: '2026-10-01T00:00:00Z' }],
});
const unparseable = () => repoWorld({ files: { ...adopterFiles(), [`docs/projects/${PROJECT}.md`]: '# Project 7\n\n## Decomposition\n\nJust prose.\n' } });
const refusedLabels = () => adopterProject({ overrides: { graphql: { Labels: () => { throw new ReadError('GraphQL Labels', 'API rate limit exceeded', { status: 403, resetAt: '2026-10-24T10:00:00.000Z' }); } } } });
const noJob = () => chain({ files: adopterFiles(undefined, { 'docs/qa/adoption.md': adoptionWith(CHAIN_DEPLOY.replace('`staging / deploy`', '`ship`')) }) });
const refusedPulls = () => {
  const w = chain();
  w.reader.pages = () => { throw new ReadError('GET repos/acme/shop/pulls?state=open&per_page=100', 'Bad credentials', { status: 401 }); };
  return w;
};

/** The body of a Markdown section: from its heading to the next heading of its level or above. */
const section = (text: string, heading: string): string | null => {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l === heading);
  if (at < 0) return null;
  const level = /^(#+) /.exec(lines[at]!)![1]!.length;
  const end = lines.findIndex((l, i) => i > at && /^(#+) /.test(l) && /^(#+) /.exec(l)![1]!.length <= level);
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n');
};
/** Each table row's first cell, when that cell is one code span. */
const firstCells = (text: string): string[] =>
  [...text.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]!);

const PAGE = () => readFileSync(join(ROOT, 'docs/status.md'), 'utf8');

describe('kanon status prints one document, or the same result as prose', () => {
  it('[STAT-11] prints one kanon-status/v1 document following docs/cli-json.md, and prose with the same exit code', async () => {
    // One document, and nothing else on standard output: it parses whole.
    const ok = await run(['--project', String(PROJECT), '--json'], adopterProject());
    expect(ok.code).toBe(EXIT.ok);
    const doc = ok.doc();
    expect(SCHEMA).toBe('kanon-status/v1');
    // Its opening fields, as docs/cli-json.md has every document open.
    expect(Object.keys(doc).slice(0, 4)).toEqual(['schema', 'kanon', 'status', 'exitCode']);
    expect(doc).toMatchObject({ schema: 'kanon-status/v1', kanon: 'v9.9.9', status: 'ok', exitCode: 0, repo: 'acme/shop', readAt: READ_AT });
    // One section per view asked for, and it is the view's own answer for the same reads.
    expect(doc.project).toEqual(await projectView({ reader: adopterProject().reader, repo: 'acme/shop', project: PROJECT }));
    expect(doc.project.items.map((i: Any) => i.key)).toEqual(['A', 'B', 'C']);
    // camelCase names, all the way down.
    for (const p of paths(doc)) for (const k of p.replace(/\[\]/g, '').split('.')) expect(k, p).toMatch(/^[a-z][a-zA-Z0-9]*$/);
    // Which token it read with goes to standard error, as `kanon doctor` says it.
    expect(ok.err).toContain('Using gh\'s stored login, which belongs to octo.');

    // The prose is the same result, with the same exit code.
    const prose = await run(['--project', String(PROJECT)], adopterProject());
    expect(prose.code).toBe(ok.code);
    expect(() => JSON.parse(prose.out)).toThrow();
    expect(prose.out).toContain('acme/shop');
    expect(prose.out).toContain(`Project #${PROJECT}: phase ${doc.project.phase}`);
    for (const i of doc.project.items) expect(prose.out).toContain(`${i.key}  ${i.title}`);
    expect(prose.out).toContain('STORE-1 seed, tested by tests/price.test.ts');
    expect(prose.out).toContain("can't proceed: dependency, B (#12) is still open");

    // The release view is a section of its own, the view's answer for the same reads, and its prose.
    // The view is imported here, not with the others, so this file still loads without it and the
    // assertions below are what turn red when the release view is gone.
    const { releaseView } = await import('../../scripts/status/release.mjs');
    const rel = await run(['--release', '--json'], chain());
    expect(rel.code).toBe(EXIT.ok);
    expect(Object.keys(rel.doc())).toEqual(['schema', 'kanon', 'status', 'exitCode', 'repo', 'readAt', 'release']);
    expect(rel.doc().release).toEqual(await releaseView({ reader: chain().reader, repo: 'acme/shop', now: new Date(READ_AT) }));
    const relProse = await run(['--release'], chain());
    expect(relProse.code).toBe(rel.code);
    expect(relProse.out).toContain('Release pull request #40: chore(main): release 2.2.0');
    expect(relProse.out).toContain(`Latest pre-release: v2.2.0-rc.1, published ${RELEASES[0]!.published_at}, 48h ago`);
    expect(relProse.out).toContain('production: v2.1.0 failed (deploy.yml, job `production / deploy`');
    const gates = await run(['--release'], promoting());
    expect(gates.out).toMatch(/Promotion \(promote\.yml\): promote, candidate-v0\.41\.0: every gate passed\n {7}Soak: pass, pinned \d+h/);
    const relCut = await run(['--release', '--json'], refusedPulls());
    expect([relCut.code, relCut.doc().release.reads[0].status]).toEqual([EXIT.incomplete, 401]);
    expect((await run(['--release'], refusedPulls())).out).toMatch(/The release view has no answer: the release view couldn't be read whole, .*Bad credentials/);

    // A read that didn't complete: the view's answer is an error naming the read, never a partial one.
    const cut = await run(['--project', String(PROJECT), '--json'], refusedLabels());
    expect(cut.code).toBe(EXIT.incomplete);
    const cutDoc = cut.doc();
    expect(cutDoc).toMatchObject({ schema: SCHEMA, status: 'incomplete', exitCode: EXIT.incomplete });
    expect(cutDoc.project.error).toMatch(/GraphQL Labels failed: API rate limit exceeded \(the rate limit resets at 2026-10-24T10:00:00.000Z\)/);
    expect(cutDoc.project.reads).toEqual([{ read: 'GraphQL Labels', why: 'API rate limit exceeded', status: 403, resetAt: '2026-10-24T10:00:00.000Z' }]);
    expect(cutDoc.project.items, 'no partial answer beside the error').toBeUndefined();
    const cutProse = await run(['--project', String(PROJECT)], refusedLabels());
    expect(cutProse.code).toBe(cut.code);
    expect(cutProse.out).toMatch(/The project view has no answer: project #7 couldn't be read whole, .*GraphQL Labels failed/);

    // A usage error: the error document, or the message and the usage, and exit 2 either way.
    for (const argv of [['--project', 'seven'], [], ['--project', '7', '--repo', 'not-a-repo'], ['--bogus'], ['--pr', '5']]) {
      const j = await run([...argv, '--json'], null);
      expect(j.code, argv.join(' ')).toBe(EXIT.usage);
      expect(Object.keys(j.doc()).sort()).toEqual(['error', 'exitCode', 'kanon', 'schema', 'status']);
      expect(j.doc()).toMatchObject({ schema: SCHEMA, kanon: 'v9.9.9', status: 'error', exitCode: EXIT.usage });
      const p = await run(argv, null);
      expect(p.code, argv.join(' ')).toBe(j.code);
      expect(p.err).toContain(`kanon status: ${j.doc().error}`);
      expect(p.out, 'nothing on standard output').toBe('');
      expect(j.readers, 'nothing was read').toEqual([]);
    }
    expect((await run(['--pr', '5', '--json'], null)).doc().error).toMatch(/readiness view/);

    // It can't run: no repository to read, or a token GitHub refuses. Exit 3 either way.
    const nowhere = await run(['--project', '7', '--json'], null, { origin: '' });
    expect(nowhere.doc()).toMatchObject({ status: 'error', exitCode: EXIT.error });
    expect(nowhere.doc().error).toMatch(/--repo/);
    expect((await run(['--project', '7'], null, { origin: '' })).code).toBe(EXIT.error);
    const refused = await run(['--project', '7', '--json'], adopterProject(), { refused: true });
    expect(refused.doc()).toMatchObject({ status: 'error', exitCode: EXIT.error });
    expect(refused.doc().error).toMatch(/GitHub refuses gh's stored login/);
    expect(refused.readers).toEqual([]);
    expect((await run(['--project', '7'], adopterProject(), { refused: true })).code).toBe(EXIT.error);

    // --repo names the repository; without it, the checkout's origin remote does.
    const named = adopterProject();
    const byFlag = await run(['--repo', 'acme/shop', '--project', '7', '--json'], named, { origin: '' });
    expect([byFlag.code, byFlag.doc().repo]).toEqual([0, 'acme/shop']);
    expect(named.seen).toContain('GET repos/acme/shop');
    const https = await run(['--project=7', '--json'], adopterProject(), { origin: 'https://github.com/acme/shop.git' });
    expect(https.doc().repo).toBe('acme/shop');
    // A token whose login can't be read (an installation's) still reads.
    expect((await run(['--project', '7', '--json'], adopterProject(), { login: null })).code).toBe(EXIT.ok);

    // The `kanon` command dispatches it.
    const help = spawnSync(process.execPath, [join(ROOT, 'cli/kanon.mjs'), 'status', '--help'], { encoding: 'utf8' });
    expect([help.status, help.stdout]).toEqual([0, expect.stringContaining('Usage: kanon status')]);
    expect(spawnSync(process.execPath, [join(ROOT, 'cli/kanon.mjs'), '--help'], { encoding: 'utf8' }).stdout).toMatch(/^ {2}status +/m);
  });
});

describe('docs/status.md is held to the code', () => {
  it('[STAT-12] lists every field of kanon-status/v1 and every tool of the hosted server, and nothing the code doesn\'t emit', async () => {
    const page = PAGE();
    const fields = section(page, '### The fields');
    expect(fields, 'docs/status.md has a "### The fields" table').not.toBeNull();
    const documented = new Set(firstCells(fields!));

    // Between them these make the command emit each field it has: a whole answer with items,
    // stops and an environment; a Lead's hold; a brief that doesn't parse; a missing one; a read
    // that didn't complete; and the error document.
    const emitted = new Set<string>();
    const docs: Any[] = [];
    for (const w of [adopterProject(), held(), unparseable(), repoWorld({ files: adopterFiles() }), refusedLabels()]) {
      docs.push((await run(['--project', String(PROJECT), '--json'], w)).doc());
    }
    docs.push((await run(['--json'], null)).doc());
    for (const d of docs) for (const p of paths(d)) emitted.add(p);
    // The worlds did reach each branch, so a field missing from them is missing from the code.
    expect(docs.map((d) => d.project?.brief?.state ?? d.project?.error?.slice(0, 10) ?? d.status)).toEqual(['parsed', 'parsed', 'unparseable', 'missing', 'project #7', 'error']);
    expect(docs[1].project.hold).toEqual({ label: HELD, by: 'lead' });
    // And the release view's: a chain's deploys, an environment with no job, the promotion's gates
    // with no pre-release beside them, and a read that didn't complete.
    const releaseDocs: Any[] = [];
    for (const w of [chain(), noJob(), promoting(), refusedPulls()]) releaseDocs.push((await run(['--release', '--json'], w)).doc());
    for (const d of releaseDocs) for (const p of paths(d)) emitted.add(p);
    expect(releaseDocs.map((d) => (d.release.error ? 'error' : [d.release.deploys.map((e: Any) => e.job), d.release.promotion?.gates.length ?? null]))).toEqual([
      [['staging / deploy', 'production / deploy'], null], [['ship', null], null], [['ship'], 5], 'error',
    ]);

    const sorted = (s: Set<string>) => [...s].sort();
    expect(sorted(emitted).filter((p) => !documented.has(p)), 'emitted, and not in the table').toEqual([]);
    expect(sorted(documented).filter((p) => !emitted.has(p)), 'in the table, and never emitted').toEqual([]);

    // The hosted server's tools. It has none until it is built (Issue G), so the page lists none.
    const TOOLS: string[] = [];
    const tools = section(page, '## The hosted server\'s tools');
    expect(tools, 'docs/status.md has a "## The hosted server\'s tools" section').not.toBeNull();
    expect(firstCells(tools!).sort()).toEqual([...TOOLS].sort());
  });
});

describe('the page is linked from where a person starts', () => {
  it('[STAT-13] README.md, docs/architecture.md and docs/install.md each link docs/status.md', () => {
    for (const file of ['README.md', 'docs/architecture.md', 'docs/install.md']) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      const targets = [...text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)].map((m) => normalize(relative(ROOT, join(ROOT, dirname(file), m[1]!))));
      expect(targets, file).toContain(normalize('docs/status.md'));
    }
  });
});
