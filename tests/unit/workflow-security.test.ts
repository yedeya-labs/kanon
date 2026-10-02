import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// K-PRIN-19: the security rules that can be checked by reading Kanon's own workflow files.
// - K-AGENT-48: no `pull_request_target` workflow checks out the PR's head.
// - K-ADOPT-12: every third-party `uses:` is pinned to a version tag or a full SHA.
// - K-AGENT-47: no job passes `secrets: inherit`.
// Each check is a function, run first against small fixtures that must fail, so that a
// check which can't fail shows up here rather than as a green run over clean files.

type Step = { uses?: unknown; run?: unknown; with?: Record<string, unknown> };
type Job = { uses?: unknown; secrets?: unknown; steps?: Step[] };
type Doc = { on?: unknown; jobs?: Record<string, Job>; runs?: { steps?: Step[] } };

const files = [
  ...readdirSync('.github/workflows').filter((f) => f.endsWith('.yml')).map((f) => join('.github/workflows', f)),
  ...readdirSync('actions', { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join('actions', d.name, 'action.yml')),
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

/** A reference to the pull request's head: its ref, its SHA, its repository, or GitHub's PR refs. */
const HEAD = /github\.event\.pull_request\.head\.|github\.head_ref|refs\/pull\//;

/**
 * The steps of a `pull_request_target` workflow that check out or fetch the PR's head
 * (K-AGENT-48): `actions/checkout` given a head ref, SHA or repository, or a `run:` that
 * checks one out with git or `gh`.
 */
const prTargetHeadCheckouts = (doc: Doc): string[] => {
  if (!eventsOf(doc).includes('pull_request_target')) return [];
  return stepsOf(doc).flatMap((s) => {
    if (typeof s.uses === 'string' && /^actions\/checkout@/.test(s.uses)) {
      const target = JSON.stringify(s.with ?? {});
      return HEAD.test(target) ? [`${s.uses} with ${target}`] : [];
    }
    if (typeof s.run === 'string') {
      const lines = s.run.split('\n').filter((l) =>
        /\bgh\s+pr\s+checkout\b/.test(l) || (/\bgit\s+(fetch|checkout|switch|pull|worktree)\b/.test(l) && HEAD.test(l)));
      return lines.map((l) => `run: ${l.trim()}`);
    }
    return [];
  });
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
 * Kanon's own `$/` and the adopter's `./` aren't third-party.
 */
const unpinned = (doc: Doc): string[] =>
  usesOf(doc).filter((u) => {
    if (u.startsWith('$/') || u.startsWith('./')) return false;
    const at = u.lastIndexOf('@');
    return at === -1 || !PINNED.test(u.slice(at + 1));
  });

/** The jobs that hand a called workflow every secret (K-AGENT-47). */
const inheritsSecrets = (doc: Doc): string[] =>
  Object.entries(doc.jobs ?? {}).filter(([, j]) => j.secrets === 'inherit').map(([name]) => name);

const y = (text: string) => parse(text) as Doc;

describe('K-AGENT-48 pull_request_target never checks out the PR head', () => {
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

  it("holds for every one of Kanon's workflows", () => {
    expect(docs.flatMap(({ file, doc }) => prTargetHeadCheckouts(doc).map((x) => `${file}: ${x}`))).toEqual([]);
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
