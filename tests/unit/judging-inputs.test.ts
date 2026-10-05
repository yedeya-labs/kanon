import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { JUDGING_INPUTS, NEVER_AN_INPUT, delegatedFrom, diskReader, judgingInputs, matchesRow } from '../../scripts/judging-inputs.mjs';
import { runWorkflowStep, type WorkflowStep } from './helpers/workflow-step.js';
import { writeStub } from './helpers/stub-bin.js';
import { readFlattened, workflowText } from './helpers/called-workflow.js';

/**
 * `K-MERGE-17` (kanon#25, kanon#62): a pull request never chooses the rules it is judged by.
 *
 *   1. The list in `scripts/judging-inputs.mjs` and the rule's table agree, row for row.
 *   2. The review lane restores from that list in one step, from the DEFAULT branch, before
 *      any of the PR's code runs, and re-checks the pin after it, before the token exists.
 *   3. For each input on the list, the lane's own restore step, executed against a PR that
 *      edits it, leaves the default branch's copy in the tree and parks the PR's.
 */

const ROOT = process.cwd();
const LANE = join(ROOT, '.github/workflows/agent-review.yml');
type Job = { steps: WorkflowStep[] };
const reviewJob = (): Job => (readFlattened(LANE) as { jobs: Record<string, Job> }).jobs.review!;

// ── 1. The list and the rule ─────────────────────────────────────────────────────────────

/** `K-MERGE-17`'s section of chapter 04, from its heading to the next rule. */
const ruleSection = (): string => {
  const text = readFileSync(join(ROOT, 'rulebook/04-review-and-merge.md'), 'utf8');
  const start = text.indexOf('### `K-MERGE-17`');
  if (start < 0) throw new Error('K-MERGE-17 is not in rulebook/04-review-and-merge.md');
  const end = text.indexOf('\n### ', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
};

/** The rule's table: each row's first cell, and the paths its second cell names in backticks. */
const ruleRows = (): Array<{ input: string; rule: string[] }> => {
  const lines = ruleSection().split('\n');
  const head = lines.findIndex((l) => /^\| Input \| Path \|/.test(l));
  if (head < 0) throw new Error("K-MERGE-17's table (| Input | Path | …) is not where it was");
  const rows = [];
  for (const line of lines.slice(head + 2)) {
    if (!line.startsWith('|')) break;
    const [input, path] = line.split('|').slice(1, 3).map((c) => c.trim());
    rows.push({ input: input!, rule: [...path!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!).filter((p) => !/^K-[A-Z]+-\d+$/.test(p)) });
  }
  return rows;
};

describe('the list is K-MERGE-17’s table, row for row', () => {
  it('finds the table, so this is not vacuous', () => {
    expect(ruleRows().length).toBeGreaterThanOrEqual(7);
  });
  it('names the same inputs, in the same order, with the same paths', () => {
    expect(JUDGING_INPUTS.map(({ input, rule }) => ({ input, rule: [...rule] }))).toEqual(ruleRows());
  });
  it('excepts exactly the spec corpus the rule excepts (K-SPEC-1)', () => {
    const exception = /\*\*One exception: the specs\.\*\* The spec corpus under `([^`]+)`/.exec(ruleSection());
    expect(exception?.[1]).toBe(NEVER_AN_INPUT);
  });
  it('fails when the two disagree: an input the rule adds, or one the list drops', () => {
    const rule = ruleRows();
    const list = JUDGING_INPUTS.map(({ input, rule: r }) => ({ input, rule: [...r] }));
    expect(list).not.toEqual([...rule, { input: 'A new input', rule: ['docs/new.md'] }]);
    expect(list.slice(1)).not.toEqual(rule);
  });
});

describe('what delegation follows', () => {
  it('a relative or root-relative link to a markdown document, resolved against the linking file', () => {
    expect(delegatedFrom('docs/qa/playbook.md', 'See [the pipeline](../pipeline.md#gates) and [x](/docs/x.md "t").')).toEqual(['docs/pipeline.md', 'docs/x.md']);
  });
  it('an `@` import on a line of its own, as CLAUDE.md imports AGENTS.md', () => {
    expect(delegatedFrom('CLAUDE.md', '@AGENTS.md\n')).toEqual(['AGENTS.md']);
    expect(delegatedFrom('AGENTS.md', 'ask @someone about it\n')).toEqual([]);
  });
  it('not a URL, an anchor, source code, a path out of the repository, or an example in a fence', () => {
    expect(delegatedFrom('AGENTS.md', [
      '[a](https://example.com/a.md) [b](#section) [c](src/app.ts) [d](../../outside.md)',
      '```md', '[e](docs/example.md)', '```',
    ].join('\n'))).toEqual([]);
  });
});

// ── 2. The review lane's steps ───────────────────────────────────────────────────────────

const stepIndex = (steps: WorkflowStep[], pred: (s: WorkflowStep) => boolean, what: string): number => {
  const i = steps.findIndex(pred);
  if (i < 0) throw new Error(`the review job has no step that ${what}`);
  return i;
};
const RESTORE = (s: WorkflowStep) => /scripts\/restore-judging-inputs\.sh/.test(s.run ?? '');
const REVERIFY = (s: WorkflowStep) => /judging-inputs\.mjs" manifest/.test(s.run ?? '') && !RESTORE(s);

describe('the review lane restores the list in one step, and re-checks it before the token', () => {
  const steps = reviewJob().steps;
  it('has exactly one restore, and no per-file restore beside it', () => {
    expect(steps.filter(RESTORE)).toHaveLength(1);
    const text = workflowText(LANE);
    expect(text).not.toMatch(/restore-agent-docs|pin_manifest|GUARD_RE/);
  });
  it('reads the default branch, never the PR’s base (kanon#62)', () => {
    const restore = steps.find(RESTORE)!;
    expect(restore.env?.DEFAULT_REF).toBe('${{ github.event.repository.default_branch }}');
    expect(JSON.stringify(restore)).not.toMatch(/base\.ref|baseRefName/);
  });
  it('runs the scripts the `kanon` step OUTPUT names, after the PR’s code has run', () => {
    for (const s of [steps.find(RESTORE)!, steps.find(REVERIFY)!]) expect(s.env?.KANON_PATH).toBe('${{ steps.kanon.outputs.path }}');
  });
  it('restores before the scope step; re-checks after it and before the token', () => {
    const restore = stepIndex(steps, RESTORE, 'restores');
    const scope = stepIndex(steps, (s) => s.id === 'scope', 'scopes the review');
    const verify = stepIndex(steps, REVERIFY, 're-checks the pin');
    // The token is minted in a job of its own (kanon#279, `K-AGENT-49`) and RECEIVED here, where the mint was.
    const mint = stepIndex(steps, (s) => s.id === 'app-token' && String(s.run ?? '').includes('::add-mask::'), 'receives the token');
    const agent = stepIndex(steps, (s) => s.uses === '$/actions/agent-run', 'runs the agent');
    expect(restore).toBeLessThan(scope);
    // No project-setup hook between them since kanon#185: the job runs none of the PR's code.
    expect(scope).toBeLessThan(verify);
    // Nothing but the token runs between the re-check and the agent.
    expect([verify + 1, verify + 2]).toEqual([mint, agent]);
  });
  it('compares the re-check against the digest the restore recorded', () => {
    expect(steps.find(REVERIFY)!.env?.EXPECTED).toBe('${{ steps.restore.outputs.pin_digest }}');
  });
});

// ── 3. Each input, executed ──────────────────────────────────────────────────────────────

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (dir: string, files: Record<string, string>) => {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
};

/** What the default branch holds: one file per input, a delegated chain, and things that are not inputs. */
const DEFAULT: Record<string, string> = {
  'AGENTS.md': 'Project instructions. Read [the guide](docs/guide.md).\n',
  'CLAUDE.md': '@AGENTS.md\n',
  '.claude/settings.json': '{"permissions":{}}\n',
  '.claude/commands/check.md': 'Check the work.\n',
  'docs/qa/agent-identities.md': '| Role | App slug |\n|---|---|\n| Reviewer | `example-reviewer` |\n',
  'docs/qa/sign-off-delegation.md': '| Delegate | Email | Delegated on |\n|---|---|---|\n| A Person | a@example.com | 2026-01-01 |\n',
  'docs/qa/reviewer-playbook.md': 'Review by [the gates](../gates.md). Specs: [area](specs/area.md).\n',
  '.github/actions/project-setup/action.yml': 'name: setup\nruns: { using: composite, steps: [] }\n',
  'docs/guide.md': 'Then read [deeper](deeper.md).\n',
  'docs/deeper.md': 'The deepest rule.\n',
  'docs/gates.md': 'The gates.\n',
  'docs/qa/specs/area.md': '# Area\n',
  'docs/other.md': 'Nothing links here.\n',
  'src/code.ts': 'export const x = 1;\n',
};
const PR = 'PR VERSION\n';
const POISON = 'STACKED BASE VERSION\n';

/** One path per input, and the input it stands for. */
const CASES: Array<[string, string]> = [
  ["The project's agent instructions", 'AGENTS.md'],
  ["The project's agent instructions", 'CLAUDE.md'],
  ['The agent configuration', '.claude/settings.json'],
  ['The agent configuration', '.claude/commands/check.md'],
  ['The identity register', 'docs/qa/agent-identities.md'],
  ['The sign-off delegation', 'docs/qa/sign-off-delegation.md'],
  ['The other pipeline documents', 'docs/qa/reviewer-playbook.md'],
  ['The project-setup hook', '.github/actions/project-setup/action.yml'],
  ['Anything the inputs above delegate to', 'docs/guide.md'],
  ['Anything the inputs above delegate to', 'docs/deeper.md'],
  ['Anything the inputs above delegate to', 'docs/gates.md'],
];

/**
 * An origin with `main`, a stacked base branch whose author poisoned every input, and a PR on
 * top that edits every input, adds an input, and edits things that are not inputs. Returns a
 * checkout of the PR's head, as `actions/checkout` leaves it.
 */
const fixture = (): { work: string; origin: string } => {
  const base = mkdtempSync(join(tmpdir(), 'judging-inputs-'));
  const seed = join(base, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 't@example.com');
  git(seed, 'config', 'user.name', 'T');
  put(seed, DEFAULT);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'default branch');
  git(seed, 'checkout', '-qb', 'stack');
  put(seed, Object.fromEntries(CASES.map(([, p]) => [p, POISON])));
  git(seed, 'commit', '-qam', 'stacked base');
  git(seed, 'checkout', '-qb', 'pr');
  put(seed, Object.fromEntries(CASES.map(([, p]) => [p, PR])));
  put(seed, {
    'docs/qa/added-by-pr.md': PR,
    '.claude/agents/added.md': PR,
    'docs/qa/specs/area.md': PR,
    'docs/other.md': PR,
    'src/code.ts': PR,
  });
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'the pull request');
  const origin = join(base, 'origin.git');
  git(base, 'clone', '-q', '--bare', seed, origin);
  const work = join(base, 'work');
  git(base, 'clone', '-q', `file://${origin}`, work);
  git(work, 'checkout', '-q', '--detach', git(origin, 'rev-parse', 'pr'));
  return { work, origin };
};

/** The expressions the restore and re-check steps declare, resolved as the runner would. */
const CONTEXT: Record<string, string> = {
  'github.event.repository.default_branch': 'main',
  'github.event.pull_request.base.ref': 'stack',
  'steps.kanon.outputs.path': ROOT,
};
const resolve = (env: Record<string, string> = {}, extra: Record<string, string> = {}) =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replace(/\$\{\{\s*([\w.-]+)\s*\}\}/g, (_m, e: string) => {
    const value = { ...CONTEXT, ...extra }[e];
    if (value === undefined) throw new Error(`the step reads \${{ ${e} }}, which this test does not model`);
    return value;
  })]));

const runStep = (pred: (s: WorkflowStep) => boolean, cwd: string, extra: Record<string, string> = {}) => {
  const step = reviewJob().steps.find(pred)!;
  return runWorkflowStep(step, { cwd, env: { ...process.env, ...resolve(step.env, extra) } });
};

describe('a PR editing each input is still reviewed under the default branch’s copy', () => {
  let work = '';
  let restored: ReturnType<typeof runWorkflowStep>;
  beforeAll(() => {
    ({ work } = fixture());
    restored = runStep(RESTORE, work);
  });
  const read = (p: string) => readFileSync(join(work, p), 'utf8');

  it('the restore step succeeds, and names the default branch’s commit', () => {
    expect(restored.status, restored.output).toBe(0);
    expect(restored.outputs.sha).toBe(git(work, 'rev-parse', 'origin/main'));
    expect(restored.outputs.pin_digest).toMatch(/^[0-9a-f]{64}$/);
  });
  it('covers every row of the list that names paths', () => {
    expect([...new Set(CASES.map(([input]) => input))].sort()).toEqual(JUDGING_INPUTS.map((r) => r.input).sort());
  });
  it.each(CASES.filter(([input]) => !input.startsWith('Anything')))('%s matches %s by its own row, not by another one', (input, path) => {
    expect(matchesRow(JUDGING_INPUTS.find((r) => r.input === input)!, path)).toBe(true);
  });
  it.each(CASES)('%s: %s', (_input, path) => {
    expect(read(path), 'the tree holds the default branch’s copy, not the PR’s or the stacked base’s').toBe(DEFAULT[path]);
    expect(read(`.qa-pr/${path}`), 'the PR’s copy is parked, so the change is still reviewable').toBe(PR);
  });
  it('takes out an input the PR adds where the default branch has none, and parks it', () => {
    for (const p of ['docs/qa/added-by-pr.md', '.claude/agents/added.md']) {
      expect(existsSync(join(work, p)), p).toBe(false);
      expect(read(`.qa-pr/${p}`)).toBe(PR);
    }
  });
  it('leaves the PR’s spec, its other documents and its code alone (K-SPEC-1)', () => {
    for (const p of ['docs/qa/specs/area.md', 'docs/other.md', 'src/code.ts']) {
      expect(read(p), p).toBe(PR);
      expect(existsSync(join(work, `.qa-pr/${p}`)), p).toBe(false);
    }
  });
  it('the re-check passes on the tree the restore left', () => {
    const r = runStep(REVERIFY, work, { 'steps.restore.outputs.pin_digest': restored.outputs.pin_digest! });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('pin intact');
  });
});

describe('the re-check refuses a tree the PR’s code changed after the restore', () => {
  const tampered = (change: (work: string) => void) => {
    const { work } = fixture();
    const restored = runStep(RESTORE, work);
    expect(restored.status, restored.output).toBe(0);
    change(work);
    return runStep(REVERIFY, work, { 'steps.restore.outputs.pin_digest': restored.outputs.pin_digest! });
  };
  it.each([
    ['a pinned playbook put back', (w: string) => writeFileSync(join(w, 'docs/qa/reviewer-playbook.md'), PR)],
    ['a delegated document rewritten', (w: string) => writeFileSync(join(w, 'docs/deeper.md'), PR)],
    ['a configuration file added', (w: string) => put(w, { '.claude/agents/late.md': PR })],
    // To a file with the same bytes, so only the link itself can be what is caught: the
    // PR's code could retarget it after the re-check.
    ['an input swapped for a symlink to the same bytes', (w: string) => {
      writeFileSync(join(w, 'same-bytes.md'), readFileSync(join(w, 'AGENTS.md')));
      rmSync(join(w, 'AGENTS.md'));
      symlinkSync('same-bytes.md', join(w, 'AGENTS.md'));
    }],
  ])('%s', (_what, change) => {
    const r = tampered(change);
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('pin tampered');
  });
  it('but not a spec or code the PR changes, which are the diff', () => {
    const r = tampered((w) => {
      appendFileSync(join(w, 'docs/qa/specs/area.md'), 'more\n');
      appendFileSync(join(w, 'src/code.ts'), 'more\n');
    });
    expect(r.status, r.output).toBe(0);
  });
});

describe('the restore fails closed', () => {
  it('when the event names no default branch', () => {
    const { work } = fixture();
    const r = runStep(RESTORE, work, { 'github.event.repository.default_branch': '' });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('names no default branch');
  });
  it('when the default branch cannot be read', () => {
    const { work } = fixture();
    const r = runStep(RESTORE, work, { 'github.event.repository.default_branch': 'no-such-branch' });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("cannot resolve the default branch 'no-such-branch'");
  });
});

describe('the review filter asks the same list, over the API', () => {
  it('selects the inputs among a push’s files, delegated documents included, at the default branch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'judging-api-'));
    const tree = Object.keys(DEFAULT).map((path) => ({ path, type: 'blob', mode: '100644' }));
    writeStub(join(dir, 'gh'), `#!/usr/bin/env bash
case "$2" in
  repos/o/r/git/trees/main\\?recursive=1) printf '%s' '${JSON.stringify({ tree })}' ;;
${Object.entries(DEFAULT).map(([p, body]) => `  repos/o/r/contents/${p.replace(/\./g, '\\.')}\\?ref=main) printf '%s' ${JSON.stringify(body)} ;;`).join('\n')}
  *) echo "unexpected gh call: $*" >&2; exit 3 ;;
esac
`);
    const out = execFileSync('node', [join(ROOT, 'scripts/judging-inputs.mjs'), 'select', '--api', 'o/r', '--ref', 'main'], {
      encoding: 'utf8',
      input: 'docs/deeper.md\ndocs/other.md\nsrc/code.ts\ndocs/qa/specs/area.md\nAGENTS.md\n',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    expect(out.split('\n').filter(Boolean)).toEqual(['docs/deeper.md', 'AGENTS.md']);
  });
  it('and the disk reader finds the same set the git reader does', () => {
    const { work } = fixture();
    git(work, 'checkout', '-q', 'origin/main');
    expect(judgingInputs(diskReader(work))).toEqual([...Object.keys(DEFAULT)].filter((p) => !['docs/qa/specs/area.md', 'docs/other.md', 'src/code.ts'].includes(p)).sort());
  });
});
