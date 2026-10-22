import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { actionFiles } from './helpers/actions.js';
import { isReleaseRef } from './helpers/release-ref.js';

// K-PRIN-19: the security rules that can be checked by reading Kanon's own workflow files.
// - K-AGENT-48: no `pull_request_target` workflow checks out the PR's head, or calls one that does,
//   but the same-repository heads the rule names.
// - K-ADOPT-12: every third-party `uses:` is pinned to a version tag or a full SHA.
// - K-AGENT-47: no job passes `secrets: inherit`.
// Each check is a function, run first against small fixtures that must fail, so that a
// check which can't fail shows up here rather than as a green run over clean files.

type Env = Record<string, unknown>;
type Step = { id?: unknown; name?: unknown; uses?: unknown; run?: unknown; with?: Record<string, unknown>; env?: Env };
type Job = { uses?: unknown; with?: Record<string, unknown>; secrets?: unknown; env?: Env; steps?: Step[] };
type Doc = { on?: unknown; env?: Env; jobs?: Record<string, Job>; runs?: { steps?: Step[] } };

const files = [
  ...readdirSync('.github/workflows').filter((f) => f.endsWith('.yml')).map((f) => join('.github/workflows', f)),
  // Every Kanon action, nested ones too (plan 0011's `actions/notify/slack/action.yml`).
  ...actionFiles(),
  // The hook files `kanon init` writes into an adopter's repository (plan 0011 §7.1): they call
  // Kanon by release, and K-ADOPT-12 holds that pin as it holds any other.
  ...readdirSync('actions/notify/hooks').filter((f) => f.endsWith('.yml')).map((f) => join('actions/notify/hooks', f)),
  // The fixture notify hook the notify block's tests run (plan 0011 step N6): an adopter's own hook,
  // held to the same pins as a hook Kanon writes.
  'tests/fixtures/notify-hook/.github/actions/notify/action.yml',
  // The AWS QA store's actions (plan 0004 step P9), which an adopter's hook calls by path.
  'infra/qa-store/aws/action.yml',
  'infra/qa-store/aws/maintenance/action.yml',
];
const docs = files.map((file) => ({ file, doc: parse(readFileSync(file, 'utf8')) as Doc }));

const stepsOf = (doc: Doc): Step[] => [
  ...(doc.runs?.steps ?? []),
  ...Object.values(doc.jobs ?? {}).flatMap((j) => j.steps ?? []),
];

/** The events a workflow's `on:` names, in any of its three spellings. */
const eventsOf = (doc: Doc): string[] => {
  const on = doc.on;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.filter((e): e is string => typeof e === 'string');
  if (on !== null && typeof on === 'object') return Object.keys(on);
  return [];
};

/**
 * A reference to the pull request's head: its ref, its SHA, its repository, GitHub's PR refs, the
 * head a `workflow_run` names, or a job's or step's output a lane named for the head
 * (`needs.filter.outputs.head_sha`), since a `run:` that sets one can't be read.
 */
const HEAD = /github\.event\.pull_request\.head\.|github\.head_ref|refs\/pull\/|github\.event\.workflow_run\.head_(sha|branch)\b|\.outputs\.head[_-](sha|ref)\b/;

/**
 * The path in Kanon's own tree that a `uses:` reaches: `$/`, a local `./`, or Kanon at a ref,
 * which is read as the file here, as the Owner decided on kanon#1128 (K-ADOPT-12 holds the ref
 * itself). Undefined for another repository's action, which isn't Kanon's to read.
 */
const localPath = (uses: string): string | undefined => {
  if (uses.startsWith('$/') || uses.startsWith('./')) return uses.slice(2);
  return /^yedeya-labs\/kanon\/([^@]+)@/.exec(uses)?.[1];
};

/** Reads a called workflow, or an action's `action.yml`, by its path. */
type Load = (path: string) => { file: string; doc: Doc } | undefined;

const loadLocal: Load = (path) => {
  const file = [path, join(path, 'action.yml'), join(path, 'action.yaml')].find((p) => existsSync(p) && statSync(p).isFile());
  return file ? { file, doc: parse(readFileSync(file, 'utf8')) as Doc } : undefined;
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const inputNamed = (name: string) => new RegExp(`\\binputs\\.${escape(name)}(?![\\w-])`);
const shellVar = (name: string) => new RegExp(`\\$\\{?${escape(name)}\\b`);

/**
 * Every step that checks out or fetches the PR's head under a `pull_request_target` workflow
 * (K-AGENT-48): in it, and in every workflow and action of Kanon's it calls, transitively, since
 * each of Kanon's callers is one `uses:` job with no step of its own (kanon#1128). A step counts
 * when it gives `actions/checkout` a head reference, or a `fetch-depth: 0`, which fetches every
 * branch and so every same-repository head; or when a `run:` line checks out with `gh`, or checks
 * out or fetches a head reference with git, inline or through an `env:` variable set to one. An
 * input a caller hands a head reference is one in the file it calls. A call into Kanon's tree that
 * can't be read is a finding too, never a pass. `read` counts the steps read, so a check that
 * reached none shows up as zero rather than as a clean result.
 */
const headCheckoutWalk = (file: string, doc: Doc, load: Load): { found: string[]; read: number } => {
  const found: string[] = [];
  let read = 0;
  if (!eventsOf(doc).includes('pull_request_target')) return { found, read };
  const seen = new Set<string>();
  const visit = (file: string, doc: Doc, heads: string[], inherited: string[]) => {
    const key = `${file}|${[...heads].sort().join()}|${[...inherited].sort().join()}`;
    if (seen.has(key)) return;
    seen.add(key);
    const isHead = (v: unknown) => {
      const text = typeof v === 'string' ? v : JSON.stringify(v ?? null);
      return HEAD.test(text) || heads.some((n) => inputNamed(n).test(text));
    };
    const headVars = (env?: Record<string, unknown>) => Object.entries(env ?? {}).filter(([, v]) => isHead(v)).map(([k]) => k);
    const call = (where: string, uses: string, given: Record<string, unknown> | undefined, env: string[]) => {
      const path = localPath(uses);
      if (path === undefined) return;
      const target = load(path);
      if (!target) {
        found.push(`${where}: calls ${uses}, which the guard cannot read`);
        return;
      }
      visit(target.file, target.doc, headVars(given), env);
    };
    // A composite action's steps run in its caller's job, with that job's environment.
    const jobs: [string, Job][] = doc.runs ? [['runs', { steps: doc.runs.steps }]] : Object.entries(doc.jobs ?? {});
    for (const [name, job] of jobs) {
      if (typeof job.uses === 'string') call(`${file} › ${name}`, job.uses, job.with, []);
      const jobVars = [...inherited, ...headVars(doc.env), ...headVars(job.env)];
      for (const [i, s] of (job.steps ?? []).entries()) {
        read += 1;
        const where = `${file} › ${name} › ${String(s.name ?? s.id ?? s.uses ?? `step ${i + 1}`)}`;
        const vars = [...jobVars, ...headVars(s.env)];
        if (typeof s.uses === 'string' && /^actions\/checkout@/.test(s.uses)) {
          if (isHead(s.with ?? {})) found.push(`${where}: checks out the head`);
          else if (String(s.with?.['fetch-depth']) === '0') found.push(`${where}: fetches every branch (fetch-depth: 0)`);
        } else if (typeof s.uses === 'string') {
          call(where, s.uses, s.with, vars);
        }
        const fetches = typeof s.run === 'string' && s.run.split('\n').some((l) => /\bgh\s+pr\s+checkout\b/.test(l)
          || (/\bgit\s+(fetch|checkout|switch|pull|worktree)\b/.test(l) && (isHead(l) || vars.some((v) => shellVar(v).test(l)))));
        if (fetches) found.push(`${where}: fetches the head`);
      }
    }
  };
  visit(file, doc, [], []);
  return { found: [...new Set(found)], read };
};

/** The same, for one file read alone: what the fixtures below need. */
const prTargetHeadCheckouts = (doc: Doc): string[] => headCheckoutWalk('workflow.yml', doc, () => undefined).found;

/**
 * The same-repository heads K-AGENT-48 allows, each by file, job and step, with why (the Owner's
 * decision on kanon#1128, 2026-10-20). Each must still be found, so a lane that stops checking out
 * a head leaves this list, and any other head checkout under `pull_request_target` fails.
 */
const SAME_REPOSITORY_HEADS: Record<string, string> = {
  '.github/workflows/review-agent-job.yml › review › checkout: checks out the head':
    'The Reviewer reads the head the checks ran on. The filter refuses a fork\'s head before this job starts, and no step installs, builds or runs the tree (review-verdict.test.ts).',
  '.github/workflows/review-agent-job.yml › review › Resolve the re-review scope from the last reviewed commit: fetches the head':
    'The same head, fetched again with its history for the incremental review; nothing runs it.',
  '.github/workflows/rebase-agent-job.yml › resolve › checkout: fetches every branch (fetch-depth: 0)':
    'The agent merges the default branch into an Implementer pull request from this repository, never a fork\'s (rebase-lane.mjs, ineligible), and runs its gates, as K-AGENT-50 accepts for this lane.',
};

/** Every `uses:` in a file, on steps and on jobs. */
const usesOf = (doc: Doc): string[] =>
  [...stepsOf(doc), ...Object.values(doc.jobs ?? {})]
    .map((n) => n.uses)
    .filter((u): u is string => typeof u === 'string');

/** A version tag (`v7`, `v1.0.239`) or a full commit SHA. Anything else may be a branch. */
const PINNED = /^(v\d+(\.\d+){0,2}|[0-9a-f]{40})$/;

/**
 * The third-party `uses:` that aren't pinned to a version tag or a full SHA (K-ADOPT-12).
 * Kanon's own `$/` and the adopter's `./` aren't third-party. A Kanon reference may also pin a
 * candidate, `candidate-vX.Y.Z`, an exact version (K-ADOPT-11), as Kanon's own callers do during
 * a soak (plan 0009 S4); no other repository's tag of that form counts.
 */
const unpinned = (doc: Doc): string[] =>
  usesOf(doc).filter((u) => {
    if (u.startsWith('$/') || u.startsWith('./')) return false;
    const at = u.lastIndexOf('@');
    if (at !== -1 && u.startsWith('yedeya-labs/kanon/') && isReleaseRef(u.slice(at + 1))) return false;
    return at === -1 || !PINNED.test(u.slice(at + 1));
  });

/** The jobs that hand a called workflow every secret (K-AGENT-47). */
const inheritsSecrets = (doc: Doc): string[] =>
  Object.entries(doc.jobs ?? {}).filter(([, j]) => j.secrets === 'inherit').map(([name]) => name);

const y = (text: string) => parse(text) as Doc;

describe("K-AGENT-48 pull_request_target checks out no fork's head, and runs a pull request's code only where K-AGENT-50 accepts it", () => {
  it.each([
    ['a checkout of the head SHA', 'on: pull_request_target\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n'],
    ['a checkout of the head ref', 'on: [pull_request_target]\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n        with:\n          ref: ${{ github.head_ref }}\n'],
    ["a checkout of the fork's repository", 'on:\n  pull_request_target:\n    types: [opened]\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n        with:\n          repository: ${{ github.event.pull_request.head.repo.full_name }}\n'],
    ['a fetch of the PR ref', 'on: pull_request_target\njobs:\n  a:\n    steps:\n      - run: git fetch origin "refs/pull/${{ github.event.number }}/head"\n'],
    ['gh pr checkout', 'on: pull_request_target\njobs:\n  a:\n    steps:\n      - run: |\n          echo hi\n          gh pr checkout "$PR"\n'],
  ])('finds %s', (_, text) => {
    expect(prTargetHeadCheckouts(y(text))).toHaveLength(1);
  });

  it.each([
    ['the base checkout', 'on: pull_request_target\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n'],
    ['a head SHA used only to report a status', 'on: pull_request_target\njobs:\n  a:\n    steps:\n      - run: gh api "repos/o/r/statuses/${{ github.event.pull_request.head.sha }}" -f state=success\n'],
    ['a pull_request workflow checking out the head', 'on: pull_request\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n'],
  ])('allows %s', (_, text) => {
    expect(prTargetHeadCheckouts(y(text))).toEqual([]);
  });

  // A caller with no steps of its own, as each of Kanon's three is, and the files it reaches.
  const CALLER = [
    'on: pull_request_target',
    'jobs:',
    '  a:',
    '    uses: yedeya-labs/kanon/.github/workflows/lane.yml@candidate-v0.41.0',
    '    with:',
    '      pr_number: ${{ github.event.number }}',
  ].join('\n');
  const LANE = [
    'on: workflow_call',
    'jobs:',
    '  filter:',
    '    steps:',
    '      - run: echo "head_sha=$(gh pr view --json headRefOid -q .headRefOid)" >> "$GITHUB_OUTPUT"',
    '  run:',
    '    uses: $/.github/workflows/agent-job.yml',
    '    with:',
    '      head_sha: ${{ needs.filter.outputs.head_sha }}',
    '      base: ${{ github.event.pull_request.base.sha }}',
  ].join('\n');
  const job = (...steps: string[]) => ['on: workflow_call', 'jobs:', '  agent:', '    steps:', ...steps].join('\n');
  const tree = (files: Record<string, string>): Load => (path) =>
    [path, `${path}/action.yml`].filter((p) => p in files).map((p) => ({ file: p, doc: y(files[p]!) }))[0];
  const walkOf = (agentJob: string, more: Record<string, string> = {}) =>
    headCheckoutWalk('caller.yml', y(CALLER), tree({ '.github/workflows/lane.yml': LANE, '.github/workflows/agent-job.yml': agentJob, ...more }));

  it.each([
    ['a checkout of a head SHA handed down as an input', job('      - id: checkout', '        uses: actions/checkout@v7', '        with:', '          ref: ${{ inputs.head_sha }}'),
      'agent-job.yml › agent › checkout: checks out the head'],
    ['a fetch of a head SHA through an env var', job('      - name: Scope', '        env:', '          HEAD_SHA: ${{ inputs.head_sha }}', '        run: git fetch --unshallow origin "$HEAD_SHA"'),
      'agent-job.yml › agent › Scope: fetches the head'],
    ['a checkout that fetches every branch', job('      - id: checkout', '        uses: actions/checkout@v7', '        with:', '          fetch-depth: 0'),
      'agent-job.yml › agent › checkout: fetches every branch (fetch-depth: 0)'],
    ['a composite action handed the head', job('      - uses: $/actions/look', '        with:', '          sha: ${{ inputs.head_sha }}'),
      'actions/look/action.yml › runs › actions/checkout@v7: checks out the head'],
  ])('follows the call into %s', (_, agentJob, found) => {
    const look = 'runs:\n  using: composite\n  steps:\n    - uses: actions/checkout@v7\n      with:\n        ref: ${{ inputs.sha }}\n';
    const { found: all, read } = walkOf(agentJob, { 'actions/look/action.yml': look });
    expect(all.map((f) => f.replace(/^\.github\/workflows\//, ''))).toEqual([found]);
    expect(read).toBeGreaterThanOrEqual(2);
  });

  it('allows a called checkout of the base, an input that names no head, and a fetch of the base', () => {
    const { found, read } = walkOf(job(
      '      - uses: actions/checkout@v7',
      '        with:',
      '          ref: ${{ inputs.base }}',
      '          persist-credentials: false',
      '      - env:',
      '          BASE: ${{ inputs.base }}',
      '        run: git fetch origin "$BASE"',
    ));
    expect(found).toEqual([]);
    expect(read).toBe(3);
  });

  it("names a call it can't read, rather than passing it", () => {
    const { found } = headCheckoutWalk('caller.yml', y(CALLER), tree({}));
    expect(found).toEqual(['caller.yml › a: calls yedeya-labs/kanon/.github/workflows/lane.yml@candidate-v0.41.0, which the guard cannot read']);
  });

  it('reads nothing of a workflow no pull_request_target starts', () => {
    expect(headCheckoutWalk('caller.yml', y(CALLER.replace('pull_request_target', 'pull_request')), tree({}))).toEqual({ found: [], read: 0 });
  });

  it("holds for every one of Kanon's workflows, but the named same-repository heads, and reads each chain's steps", () => {
    const callers = docs.filter(({ doc }) => eventsOf(doc).includes('pull_request_target'));
    expect(callers.map(({ file }) => file).sort()).toEqual([
      // kanon#1242: the backstop takes a milestone off a pull request, a fork's included, and
      // checks nothing out on that event.
      '.github/workflows/issue-backstop.yml',
      '.github/workflows/overseer.yml',
      '.github/workflows/rebase.yml',
      '.github/workflows/review.yml',
    ]);
    const walks = callers.map(({ file, doc }) => ({ file, ...headCheckoutWalk(file, doc, loadLocal) }));
    for (const w of walks) expect(w.read, `${w.file}: steps read`).toBeGreaterThan(0);
    expect([...new Set(walks.flatMap((w) => w.found))].sort()).toEqual(Object.keys(SAME_REPOSITORY_HEADS).sort());
  });
});

describe('K-ADOPT-12 every third-party action is pinned to a version tag or a full SHA', () => {
  it('flags a branch, a short SHA and a missing ref, on steps and on jobs', () => {
    const doc = y([
      'jobs:',
      '  a:',
      '    steps:',
      '      - uses: actions/checkout@main',
      '      - uses: actions/setup-node@1a2b3c4',
      '      - uses: someone/action',
      '      - uses: actions/checkout@v7',
      '      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567',
      '      - uses: $/actions/dco',
      '      - uses: ./.github/actions/project-setup',
      '  b:',
      '    uses: someone/repo/.github/workflows/x.yml@develop',
    ].join('\n'));
    expect(unpinned(doc)).toEqual([
      'actions/checkout@main',
      'actions/setup-node@1a2b3c4',
      'someone/action',
      'someone/repo/.github/workflows/x.yml@develop',
    ]);
  });

  it("takes a Kanon candidate as pinned, and only Kanon's, never a branch or a malformed one", () => {
    const doc = y([
      'jobs:',
      '  a:',
      '    steps:',
      '      - uses: yedeya-labs/kanon/actions/dco@candidate-v0.41.0',
      '      - uses: yedeya-labs/kanon/actions/dco@v0.41.0',
      '      - uses: yedeya-labs/kanon/actions/dco@main',
      '      - uses: yedeya-labs/kanon/actions/dco@candidate-main',
      '      - uses: yedeya-labs/kanon/actions/dco@candidate-v0',
      '      - uses: someone/action@candidate-v1.2.3',
      '  b:',
      '    uses: yedeya-labs/kanon/.github/workflows/agent-review.yml@candidate-v0.41.0',
    ].join('\n'));
    expect(unpinned(doc)).toEqual([
      'yedeya-labs/kanon/actions/dco@main',
      'yedeya-labs/kanon/actions/dco@candidate-main',
      'yedeya-labs/kanon/actions/dco@candidate-v0',
      'someone/action@candidate-v1.2.3',
    ]);
  });

  it('reads composite actions too', () => {
    expect(unpinned(y('runs:\n  using: composite\n  steps:\n    - uses: actions/upload-artifact@master\n'))).toEqual([
      'actions/upload-artifact@master',
    ]);
  });

  it("holds for every one of Kanon's workflows and actions, and finds some to check", () => {
    const thirdParty = docs.flatMap(({ doc }) => usesOf(doc)).filter((u) => !u.startsWith('$/') && !u.startsWith('./'));
    expect(thirdParty.length).toBeGreaterThanOrEqual(5);
    expect(docs.flatMap(({ file, doc }) => unpinned(doc).map((u) => `${file}: ${u}`))).toEqual([]);
  });
});

describe('K-AGENT-47 no job passes secrets: inherit', () => {
  it('flags a job that inherits, and not one that names its secrets', () => {
    const doc = y([
      'jobs:',
      '  a:',
      '    uses: $/.github/workflows/x.yml',
      '    secrets: inherit',
      '  b:',
      '    uses: $/.github/workflows/x.yml',
      '    secrets:',
      '      TOKEN: ${{ secrets.TOKEN }}',
    ].join('\n'));
    expect(inheritsSecrets(doc)).toEqual(['a']);
  });

  it("holds for every one of Kanon's workflows, and finds called workflows to check", () => {
    expect(docs.filter(({ doc }) => Object.values(doc.jobs ?? {}).some((j) => typeof j.uses === 'string')).length).toBeGreaterThanOrEqual(3);
    expect(docs.flatMap(({ file, doc }) => inheritsSecrets(doc).map((j) => `${file}: ${j}`))).toEqual([]);
  });
});

// kanon#1190: the release announcement runs on a published release and a dispatch, never on a
// pull request, so no fork's pull request reaches the hook its `notify` job runs, and its caller
// grants it nothing but contents: read.
describe('the release announcement (kanon#1190) is started by no pull request, pins its actions and inherits nothing', () => {
  const lane = docs.find(({ file }) => file.endsWith('/agent-release-announce.yml'))!;
  const caller = (on: string) => y(`on:\n  ${on}:\n    types: [published]\njobs:\n  announce:\n    uses: $/.github/workflows/agent-release-announce.yml\n    secrets:\n      KANON_CHAT_RELEASE: \${{ secrets.KANON_CHAT_RELEASE }}\n`);

  it('is read, and holds', () => {
    expect(lane).toBeDefined();
    expect(eventsOf(lane.doc)).toEqual(['workflow_call']);
    expect(unpinned(lane.doc)).toEqual([]);
    expect(inheritsSecrets(lane.doc)).toEqual([]);
    expect(headCheckoutWalk(lane.file, lane.doc, loadLocal)).toEqual({ found: [], read: 0 });
    expect((lane.doc as Doc & { permissions?: unknown }).permissions).toEqual({ contents: 'read' });
  });

  it('a caller started by release reads nothing for K-AGENT-48, and one started by pull_request_target would be walked', () => {
    expect(headCheckoutWalk('caller.yml', caller('release'), loadLocal)).toEqual({ found: [], read: 0 });
    expect(headCheckoutWalk('caller.yml', caller('pull_request_target'), loadLocal).read).toBeGreaterThan(0);
  });
});
