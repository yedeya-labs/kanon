import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { mechanismRows } from '../../scripts/lib/mechanisms.mjs';

/**
 * Kanon's adoption record (`K-ADOPT-9`) says, row by row, which mechanisms run on this repository.
 * This test holds each row's status to what the checkout runs (#1236):
 *
 *   - a row marked `installed YYYY-MM-DD` must have a workflow here that runs it: a caller of its
 *     lane, a step that uses its action, a step that runs its script, or the unit suite CI runs;
 *   - a row marked `not yet installed` or `not applicable` must have none.
 *
 * HOW EACH ROW IS DETECTED is the one table below, `DETECTORS`, keyed by how the row's Mechanism
 * cell begins. A new row with no entry fails the test, and so does an entry that matches no row,
 * or more than one. A few rows are platform state the checkout can't show, such as the ruleset;
 * their entry says where to look instead (`outside`). A few name mechanisms Kanon hasn't built;
 * their entry says so (`unbuilt`), and such a row can't be marked installed until the entry
 * becomes a detector.
 *
 * WHAT "RUNS" MEANS. A workflow that starts on its own (any trigger but `workflow_call`), other
 * than a smoke run, which runs Kanon's code on fixtures and not on this repository, is an entry.
 * What an entry runs is every `run:` step of its jobs and of every workflow its jobs call,
 * followed by file name into this checkout's copy: a caller of `yedeya-labs/kanon/.github/
 * workflows/agent-x.yml@<pin>` is read as running this checkout's `agent-x.yml`. So the test reads
 * the lanes on `main`, not at the release the callers pin; where only the pinned release
 * decides, the entry reads the CHANGELOG (`shipped`).
 */

type Workflow = { on?: unknown; jobs?: Record<string, { uses?: string; steps?: Array<{ uses?: string; run?: string }> }> };
type Repo = { root: string; workflows: Map<string, Workflow> };
type Result = { runs: boolean; evidence: string };
type Detector =
  | { kind: 'detect'; what: string; detect: (repo: Repo) => Result }
  | { kind: 'outside'; where: string }
  | { kind: 'unbuilt'; why: string };

const ROOT = process.cwd();
const RECORD = 'docs/qa/adoption.md';
const THIS = 'tests/unit/adoption-mechanisms.test.ts';

const readRepo = (root: string): Repo => {
  const dir = join(root, '.github/workflows');
  const workflows = new Map<string, Workflow>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.yml'))) workflows.set(f, (parse(readFileSync(join(dir, f), 'utf8')) ?? {}) as Workflow);
  return { root, workflows };
};

/** A workflow `uses:` a reusable workflow: its file name, wherever it is pinned, or null. */
const calledFile = (uses: string | undefined): string | null =>
  /^(?:yedeya-labs\/kanon\/|\.\/|\$\/)\.github\/workflows\/([^@/]+\.yml)(?:@.*)?$/.exec(uses ?? '')?.[1] ?? null;

const isEntry = (name: string, wf: Workflow): boolean => {
  if (name.endsWith('-smoke.yml')) return false;
  const on = wf.on;
  const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on.map(String) : Object.keys((on as object | undefined) ?? {});
  return triggers.some((t) => t !== 'workflow_call');
};

/** Every entry, with the files it reaches through calls, itself first. */
const reach = (repo: Repo): Array<{ entry: string; files: string[] }> =>
  [...repo.workflows].filter(([n, wf]) => isEntry(n, wf)).map(([entry]) => {
    const files: string[] = [];
    const visit = (f: string) => {
      if (files.includes(f) || !repo.workflows.has(f)) return;
      files.push(f);
      for (const job of Object.values(repo.workflows.get(f)?.jobs ?? {})) {
        const called = calledFile(job.uses);
        if (called) visit(called);
      }
    };
    visit(entry);
    return { entry, files };
  });

const runsOf = (wf: Workflow | undefined): string[] =>
  Object.values(wf?.jobs ?? {}).flatMap((j) => (j.steps ?? []).map((s) => s.run ?? '').filter(Boolean));

// ── The detectors' parts ────────────────────────────────────────────────────────────────────

/** An entry runs `scripts/<script>` in a step, its own or a called workflow's. */
const runs = (script: string): Detector => ({
  kind: 'detect',
  what: `a workflow here that runs scripts/${script}`,
  detect: (repo) => {
    for (const { entry, files } of reach(repo)) {
      const file = files.find((f) => runsOf(repo.workflows.get(f)).some((r) => r.includes(`scripts/${script}`)));
      if (file) return { runs: true, evidence: `.github/workflows/${entry} runs scripts/${script}${file === entry ? '' : ` (through ${file})`}` };
    }
    return { runs: false, evidence: `no workflow here runs scripts/${script}` };
  },
});

/** An entry calls the reusable workflow `lane`, directly or through another. */
const calls = (lane: string): Detector => ({
  kind: 'detect',
  what: `a caller of ${lane}`,
  detect: (repo) => {
    const hit = reach(repo).find(({ entry, files }) => entry !== lane && files.includes(lane));
    return hit ? { runs: true, evidence: `.github/workflows/${hit.entry} calls ${lane}` } : { runs: false, evidence: `no workflow here calls ${lane}` };
  },
});

/** An entry's step uses Kanon's action `name`. */
const action = (name: string): Detector => ({
  kind: 'detect',
  what: `a step that uses Kanon's ${name} action`,
  detect: (repo) => {
    for (const [entry, wf] of repo.workflows) {
      if (!isEntry(entry, wf)) continue;
      const steps = Object.values(wf.jobs ?? {}).flatMap((j) => j.steps ?? []);
      if (steps.some((s) => new RegExp(`^(?:yedeya-labs/kanon/|\\./)actions/${name}(?:@|$)`).test(s.uses ?? ''))) return { runs: true, evidence: `.github/workflows/${entry} uses the ${name} action` };
    }
    return { runs: false, evidence: `no workflow here uses the ${name} action` };
  },
});

/** A test file that CI's unit suite runs: `ci.yml` runs `npm test`, which runs every file. */
const test = (file: string): Detector => ({
  kind: 'detect',
  what: `${file}, in the unit suite ci.yml runs`,
  detect: (repo) => {
    const ci = existsSync(join(repo.root, '.github/workflows/ci.yml')) && runsOf(repo.workflows.get('ci.yml')).some((r) => /\bnpm test\b/.test(r));
    const there = existsSync(join(repo.root, file));
    return { runs: ci && there, evidence: !there ? `${file} doesn't exist` : ci ? `ci.yml runs ${file} with the unit suite` : 'ci.yml runs no `npm test`' };
  },
});

/** A file of the repository's own, such as a declaration a mechanism reads. */
const file = (path: string): Detector => ({
  kind: 'detect',
  what: path,
  detect: (repo) => (existsSync(join(repo.root, path)) ? { runs: true, evidence: `${path} exists` } : { runs: false, evidence: `${path} doesn't exist` }),
});

/**
 * The release the lane callers pin ships the change pull request `pr` made: the CHANGELOG names
 * it in that release's section or an older one. For a mechanism on `main` that no release the
 * callers pin carries yet.
 */
const shipped = (pr: number): Detector => ({
  kind: 'detect',
  what: `a CHANGELOG entry for #${pr} at or below the release the callers pin`,
  detect: (repo) => {
    const pins = new Set<string>();
    for (const wf of repo.workflows.values()) {
      for (const j of Object.values(wf.jobs ?? {})) {
        const m = /^yedeya-labs\/kanon\/\.github\/workflows\/[^@]+@(?:candidate-)?v(\d+\.\d+\.\d+)$/.exec(j.uses ?? '');
        if (m?.[1]) pins.add(m[1]);
      }
    }
    const [pin] = [...pins];
    if (pins.size !== 1 || !pin) return { runs: false, evidence: `the lane callers pin ${pins.size} releases, not one` };
    const log = existsSync(join(repo.root, 'CHANGELOG.md')) ? readFileSync(join(repo.root, 'CHANGELOG.md'), 'utf8') : '';
    const at = log.indexOf(`## [${pin}]`);
    const below = at === -1 ? '' : log.slice(at);
    return new RegExp(`/(?:issues|pull)/${pr}\\)`).test(below)
      ? { runs: true, evidence: `the CHANGELOG lists #${pr} at or below ${pin}, the release the callers pin` }
      : { runs: false, evidence: `the CHANGELOG lists #${pr} at no release up to ${pin}, the one the callers pin` };
  },
});

const all = (...ds: Detector[]): Detector => ({
  kind: 'detect',
  what: ds.map((d) => (d.kind === 'detect' ? d.what : '?')).join(', and '),
  detect: (repo) => {
    const rs = ds.map((d) => (d.kind === 'detect' ? d.detect(repo) : { runs: false, evidence: 'not a detector' }));
    const missing = rs.filter((r) => !r.runs);
    return missing.length ? { runs: false, evidence: missing.map((r) => r.evidence).join('; ') } : { runs: true, evidence: rs.map((r) => r.evidence).join('; ') };
  },
});

const any = (...ds: Detector[]): Detector => ({
  kind: 'detect',
  what: ds.map((d) => (d.kind === 'detect' ? d.what : '?')).join(', or '),
  detect: (repo) => {
    const rs = ds.map((d) => (d.kind === 'detect' ? d.detect(repo) : { runs: false, evidence: 'not a detector' }));
    const hit = rs.find((r) => r.runs);
    return hit ?? { runs: false, evidence: rs.map((r) => r.evidence).join('; ') };
  },
});

const outside = (where: string): Detector => ({ kind: 'outside', where });
const unbuilt = (why: string): Detector => ({ kind: 'unbuilt', why });

// ── THE TABLE: how each mechanism row of the record is detected ─────────────────────────────
// Keyed by how the row's Mechanism cell begins. Add an entry with every new row.
export const DETECTORS: Array<[string, Detector]> = [
  // The workflow skips until the pinned release carries the script (#1257).
  ['The force-push notice, `scripts/force-push-notice.mjs`', all(runs('force-push-notice.mjs'), shipped(1257))],
  ["The release workflow's release-PR guard", all(file('.github/workflows/release.yml'), test('tests/unit/release-pr-guard.test.ts'))],
  ["`actions/agent-run`'s settings that keep a headless run's commands", test('tests/unit/headless-run.test.ts')],
  ['The finding count, `scripts/finding-counts.mjs`', runs('finding-counts.mjs')],
  ['The `main` ruleset: pull request required', outside("the `main` ruleset's rules (GitHub's API: `repos/{repo}/rulesets`)")],
  ["The ruleset's required approving review", outside("the `main` ruleset's pull-request rule, and its history")],
  ['The merge queue, with every required check', outside("the `main` ruleset's merge-queue rule; tests/unit/workflows.test.ts holds the checks to `merge_group`")],
  ["The repository's merge settings", calls('release.yml')],
  ['The reusable release workflow', calls('release.yml')],
  ['The `pr-title` action', all(action('pr-title'), test('tests/unit/pr-title.test.ts'))],
  ['The `dco` action', all(action('dco'), test('tests/unit/dco.test.ts'))],
  ['`tests/unit/workflows.test.ts`', test('tests/unit/workflows.test.ts')],
  ['`tests/unit/workflow-security.test.ts`', test('tests/unit/workflow-security.test.ts')],
  ['`tests/unit/rulebook-why.test.ts`', test('tests/unit/rulebook-why.test.ts')],
  ['`tests/unit/app-key-isolation.test.ts`', test('tests/unit/app-key-isolation.test.ts')],
  ['`tests/unit/pr-code-token-isolation.test.ts`', all(test('tests/unit/pr-code-token-isolation.test.ts'), test('tests/unit/lead-shell.test.ts'))],
  ['`kanon apps`, and the test', test('tests/unit/agent-permissions.test.ts')],
  ["The Reviewer App's permission grants", outside("the Judge App's installation and grants (`apps-check`, `kanon doctor`)")],
  ['The review lane, called by `review.yml`', calls('agent-review.yml')],
  ['The Reviewer, through its playbook', all(calls('agent-review.yml'), file('docs/qa/reviewer-playbook.md'))],
  ["Unit tests on Kanon's own lanes", test('tests/unit/lane-workflows.test.ts')],
  ["The brief guard's test against the shipped template", test('tests/library/brief-guard.test.ts')],
  ['`tests/unit/rule-one-home.test.ts`', test('tests/unit/rule-one-home.test.ts')],
  ['`tests/unit/adoption-record.test.ts`', test('tests/unit/adoption-record.test.ts')],
  ['`tests/unit/register-footnote-pointers.test.ts`', test('tests/unit/register-footnote-pointers.test.ts')],
  ['`tests/unit/adoption-mechanisms.test.ts`', test('tests/unit/adoption-mechanisms.test.ts')],
  ['The other agent lanes and their App tokens', all(...['agent-implement.yml', 'agent-implement-revise.yml', 'agent-triage.yml', 'agent-lead.yml', 'agent-lead-revise.yml', 'agent-lead-split.yml', 'agent-lead-reconcile.yml', 'agent-merge.yml', 'agent-code-audit.yml', 'agent-explore-telemetry.yml'].map(calls))],
  ['The conflict lane, called by `rebase.yml`', calls('agent-rebase.yml')],
  ['The test-database block in the lanes', all(action('lane-check'), file('docs/qa/test-database.md'))],
  ["`lane-check`'s reading of the project documents", all(action('lane-check'), file('docs/qa/stack.md'))],
  ["`lane-check`'s caller file names", action('lane-check')],
  ["The review lane running none of the pull request's code", calls('agent-review.yml')],
  ["The Reviewer's and the Lead's user settings", all(calls('agent-review.yml'), calls('agent-lead.yml'))],
  ['Re-delivery and retry logic', calls('agent-review.yml')],
  ["The merge gate: the Merger's verdict function", all(calls('agent-merge.yml'), file('docs/qa/escalation-paths.md'))],
  ['A ruleset bypass list naming only the release bot', outside("the `main` ruleset's bypass list, and its history")],
  ['The red-test check on agent-authored pull requests', calls('red-test.yml')],
  ['The watching agent (Overseer)', all(calls('agent-overseer.yml'), file('docs/qa/overseer-playbook.md'))],
  ["The Explorer's sweep", calls('agent-explore.yml')],
  ["The Explorer's telemetry mode", calls('agent-explore-telemetry.yml')],
  ['The issue-opened automation', calls('agent-issue-backstop.yml')],
  ['The filing skill', all(file('skills/file-issue/SKILL.md'), shipped(1156))],
  // It runs only where the filing skill runs, so it reaches Kanon no sooner than #1156. Once the
  // pull request that closes #1247 has a number, add `shipped(<that number>)` here (#1247).
  ["The body check in the filing skill's `plan`", all(file('skills/file-issue/SKILL.md'), test('tests/unit/issue-triage-defaults.test.ts'), shipped(1156))],
  ['The shared milestone classifier', all(runs('backlog-feed.mjs'), runs('gate-candidate-exit.mjs'))],
  ['The label guard', runs('label-guard.mjs')],
  ['The re-dispatch sweep', calls('agent-dispatch-sweep.yml')],
  ['The project reconciler and its closure module', calls('agent-lead-reconcile.yml')],
  ["The intake path's single-label test", unbuilt('Kanon has no intake path for untrusted reports, and no test of one')],
  ['The spec guard', runs('spec-guard.mjs')],
  ['The id allocator and its test', runs('spec-ids.mjs')],
  ['The locked-set ratchet', runs('locked-set.mjs')],
  ['The coverage and acceptance-criteria tools', runs('spec-coverage.mjs')],
  ["The brief guard on this repository's briefs", runs('brief-guard.mjs')],
  // #1259's three guards reach Kanon only at a release that carries it.
  ['The pull-request milestone backstop', all(calls('agent-issue-backstop.yml'), shipped(1259))],
  ['`tests/unit/search-scope.test.ts`', test('tests/unit/search-scope.test.ts')],
  ["`kanon doctor`'s `label.github-default` finding", shipped(1259)],
  ["The brief guard's tracking-issue check", all(runs('brief-guard.mjs'), shipped(1259))],
  ['The worktree script', unbuilt('Kanon ships no worktree script')],
  ['The ship command', runs('ship-review-scope.mjs')],
  ['The guard on tracked environment files', unbuilt('Kanon ships no such guard')],
  ['The closing-references check', runs('closing-refs.mjs')],
  ['Deploy, production approval and announcement workflows', any(calls('deploy-release.yml'), calls('deploy.yml'))],
  ['The digest jobs', any(all(calls('agent-project-digest.yml'), file('.github/actions/notify/action.yml')), calls('agent-weekly-digest.yml'))],
  ["The observability document's signal guards", file('docs/observability.md')],
  ["The observability document's hand-created-resource check", unbuilt('Kanon ships no check of the hand-created-resource table')],
  ['The workflow-health check', runs('workflow-health.mjs')],
  ['The notification contract and the `notify` job', all(calls('agent-project-digest.yml'), test('tests/unit/notify-guard.test.ts'), test('tests/library/notify-contract.test.ts'))],
  ['The hosted telemetry store: the collector', calls('telemetry-collect.yml')],
  ["The hosted telemetry store's quality columns", all(runs('agent-quality-columns.mjs'), runs('overseer-telemetry.mjs'))],
  ['The fallback-model test and the fallback lists', unbuilt('no test holds the verdict lanes to having no fallback model')],
  ['The lint chain runner, the flag guard and the permissions guard', unbuilt('Kanon ships none of the three')],
  ['The path guard', runs('doc-path-guard.mjs')],
  ["The citation guard on Kanon's own `docs/`", all(runs('citation-guard.mjs'), runs('citation-shift.mjs'))],
  ["The capability ledger's watermark reader", all(runs('runtime-bump.mjs'), file('docs/qa/capability-ledger.md'))],
  ['The calibration record and the run-record writer', unbuilt('Kanon ships neither')],
  ["`lane-check`'s exact-pin and Dependabot-entry checks", all(action('lane-check'), file('.github/dependabot.yml'))],
  ['The installer, `kanon init` with `kanon doctor`', outside("a person's machine: `kanon init` and `kanon doctor` run there, not in a workflow")],
  ["Planned guards the rules name but Kanon hasn't built", unbuilt("they are planned, and the rules say so")],
  ['The sign-off delegation record', all(file('docs/qa/sign-off-delegation.md'), file('.github/actions/project-setup/action.yml'))],
  ['The exemptions file', all(file('docs/qa/exemptions.md'), any(runs('brief-guard.mjs'), runs('doc-path-guard.mjs')))],
];

const short = (cell: string) => (cell.length > 70 ? `${cell.slice(0, 70)}…` : cell);

/** Every row whose status the checkout contradicts, and every row or entry the table can't pair. */
export const problems = (root: string, recordText: string, detectors: Array<[string, Detector]>): string[] => {
  const repo = readRepo(root);
  const rows = mechanismRows(recordText);
  const out: string[] = [];
  if (rows.length === 0) return [`${RECORD} has no mechanism table: the check would go blind`];
  for (const [key] of detectors) {
    const n = rows.filter((r) => r.mechanism.startsWith(key)).length;
    if (n !== 1) out.push(`${THIS}: the detector "${key}" matches ${n} rows of ${RECORD}, not one: key it by how exactly one row's Mechanism cell begins`);
  }
  for (const row of rows) {
    const where = `${RECORD}:${row.line} "${short(row.mechanism)}"`;
    const matched = detectors.filter(([key]) => row.mechanism.startsWith(key));
    if (matched.length !== 1) {
      if (matched.length === 0) out.push(`${where} has no detector: add an entry to DETECTORS in ${THIS}, keyed by how its Mechanism cell begins, saying what runs it here`);
      continue;
    }
    const detector = (matched[0] as [string, Detector])[1];
    const installed = row.status.startsWith('installed ');
    if (detector.kind === 'outside') continue;
    if (detector.kind === 'unbuilt') {
      if (installed) out.push(`${where} is marked "${row.status}", but DETECTORS in ${THIS} says it isn't built (${detector.why}): replace that entry with what runs it here, or flip the row to \`not yet installed\``);
      continue;
    }
    const { runs: ran, evidence } = detector.detect(repo);
    if (installed && !ran) out.push(`${where} is marked "${row.status}", but nothing here runs it (looked for ${detector.what}: ${evidence}): flip its status to \`not yet installed\`, or, if it moved, update its entry in DETECTORS in ${THIS}`);
    if (!installed && ran) {
      out.push(row.status === 'not applicable'
        ? `${where} is marked "not applicable", but ${evidence}: flip its status to \`installed YYYY-MM-DD\`, the date the change that runs it merged, and remove its \`Mechanism not applicable\` bullet from ## Choices`
        : `${where} is marked "${row.status}", but ${evidence}: flip its status to \`installed YYYY-MM-DD\`, the date the change that runs it merged, and say in the row what runs it`);
    }
  }
  return out;
};

describe("Kanon's adoption record says what runs here (K-ADOPT-9, #1236)", () => {
  it('has a detector for every mechanism row, and every status agrees with the checkout', () => {
    expect(problems(ROOT, readFileSync(join(ROOT, RECORD), 'utf8'), DETECTORS)).toEqual([]);
  });

  it('detects the mechanisms it says run, on this checkout', () => {
    const repo = readRepo(ROOT);
    const detect = (d: Detector) => (d.kind === 'detect' ? d.detect(repo).runs : null);
    expect(detect(calls('agent-review.yml'))).toBe(true);
    expect(detect(runs('workflow-health.mjs'))).toBe(true);
    expect(detect(action('lane-check'))).toBe(true);
    expect(detect(calls('agent-explore.yml'))).toBe(false);
    // The spec guard runs on this repository's specs since #1237, not only on the smoke's fixture.
    expect(detect(runs('spec-guard.mjs'))).toBe(true);
    expect(detect(runs('locked-set.mjs'))).toBe(false);
  });
});

describe('the check fails each way a row can be wrong', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const repo = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'kanon-mechanisms-'));
    dirs.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  };
  const record = (...rows: string[]) => ['# Adoption record', '', '## Mechanisms', '', '| Mechanism | Rules | Status |', '|---|---|---|', ...rows, '', '## Choices', ''].join('\n');
  const CI = 'on:\n  pull_request:\njobs:\n  guard:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node scripts/label-guard.mjs\n';
  const LANE = 'on:\n  workflow_call:\njobs:\n  run:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node "$KANON/scripts/workflow-health.mjs"\n';
  const CALLER = 'on:\n  schedule:\n    - cron: "0 6 * * *"\njobs:\n  digest:\n    uses: yedeya-labs/kanon/.github/workflows/agent-digest.yml@v0.42.0\n';
  const SMOKE = 'on:\n  pull_request:\njobs:\n  smoke:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node scripts/spec-guard.mjs\n';
  const table: Array<[string, Detector]> = [
    ['The label guard', runs('label-guard.mjs')],
    ['The health check', runs('workflow-health.mjs')],
    ['The spec guard', runs('spec-guard.mjs')],
    ['The sweep', calls('agent-sweep.yml')],
  ];
  const files = {
    '.github/workflows/ci.yml': CI,
    '.github/workflows/agent-digest.yml': LANE,
    '.github/workflows/digest.yml': CALLER,
    '.github/workflows/agent-blocks-smoke.yml': SMOKE,
  };
  const good = record(
    '| The label guard | `K-A-1` | installed 2026-10-21 |',
    '| The health check | `K-A-2` | installed 2026-10-21 |',
    '| The spec guard | `K-A-3` | not yet installed |',
    '| The sweep | `K-A-4` | not applicable |',
  );

  it('passes rows that agree with the workflows, through a pinned caller, and not counting a smoke run', () => {
    expect(problems(repo(files), good, table)).toEqual([]);
  });

  it('names the row to flip to installed when a guard starts running (the second pull request to merge fixes it)', () => {
    const root = repo({ ...files, '.github/workflows/ci.yml': `${CI}      - run: node scripts/spec-guard.mjs\n` });
    expect(problems(root, good, table)).toEqual([
      `${RECORD}:9 "The spec guard" is marked "not yet installed", but .github/workflows/ci.yml runs scripts/spec-guard.mjs: flip its status to \`installed YYYY-MM-DD\`, the date the change that runs it merged, and say in the row what runs it`,
    ]);
  });

  it('names the row to flip to not yet installed when nothing runs it', () => {
    const root = repo({ ...files, '.github/workflows/digest.yml': CALLER.replace('agent-digest.yml', 'agent-other.yml') });
    expect(problems(root, good, table).join('\n')).toMatch(/adoption\.md:8 "The health check" is marked "installed 2026-10-21", but nothing here runs it .*: flip its status to `not yet installed`/);
  });

  it('names a not-applicable row that something runs, and its bullet', () => {
    const root = repo({ ...files, '.github/workflows/sweep.yml': CALLER.replace('agent-digest.yml', 'agent-sweep.yml'), '.github/workflows/agent-sweep.yml': LANE });
    expect(problems(root, good, table).join('\n')).toMatch(/:10 "The sweep" is marked "not applicable", but \.github\/workflows\/sweep\.yml calls agent-sweep\.yml: .*remove its `Mechanism not applicable` bullet/);
  });

  it('fails a row with no detector, and a detector with no row', () => {
    const extra = good.replace('| The sweep |', '| The new guard | `K-A-5` | not yet installed |\n| The sweep |');
    expect(problems(repo(files), extra, table).join('\n')).toMatch(/"The new guard" has no detector: add an entry to DETECTORS/);
    expect(problems(repo(files), good, [...table, ['The gone guard', runs('gone.mjs')]]).join('\n')).toMatch(/the detector "The gone guard" matches 0 rows/);
  });

  it('fails an installed row whose detector says it is not built', () => {
    expect(problems(repo(files), good, table.map(([k, d]): [string, Detector] => [k, k === 'The label guard' ? unbuilt('not yet written') : d])).join('\n')).toMatch(/"The label guard" is marked "installed 2026-10-21", but DETECTORS .* says it isn't built \(not yet written\)/);
  });
});
