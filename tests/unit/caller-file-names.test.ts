import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * K-LAYOUT-18 (kanon#207): Kanon's scripts and lanes reach an adopter's workflows by FILE NAME,
 * so every name they use must be one the rule fixes: a lane's own file name (each caller has
 * its lane's name), or a workflow a lane declares on a `# READS WORKFLOW:` line, which
 * `lane-check` then requires the adopter to have. A site that reaches a lane's runs or
 * dispatches it goes through the lane's CALLER (`via: 'caller'`, kanon#726): the workflow on the
 * default branch that calls the lane, which is the lane's file name only when nothing else is.
 *
 * Every site that names a workflow file is listed below, and a sweep of the library and the
 * lanes fails on one that isn't, so a new read can't arrive without a decision here.
 */

const ROOT = process.cwd();
const WORKFLOWS = join(ROOT, '.github/workflows');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Kanon's lanes: `agent-*.yml` reusable workflows, the spine excepted. */
const LANES = readdirSync(WORKFLOWS)
  .filter((f) => /^agent-.*\.yml$/.test(f) && f !== 'agent-lane.yml')
  .filter((f) => (parse(read(`.github/workflows/${f}`)) as { on?: Record<string, unknown> }).on?.workflow_call !== undefined);

/** A line that reaches a workflow by its file name: a run listing, a dispatch, the runs API, or a file-name filter. */
const READ = /'--workflow'|--workflow\s|'workflow',\s*'run'|actions\/workflows\/|startsWith\('agent-'\)/;

type Site = {
  /** Where, and a fragment of the line. */
  file: string;
  line: string;
  /**
   * What it reaches: a workflow file name, read where the line says or through `constant`;
   * `declared`, a name the adopter declares (the reference deploy, `K-PROJ-11`); or `callers`,
   * every lane caller, by the `agent-` prefix every caller's name has; or `self`, the run's own
   * top-level workflow, read from `GITHUB_WORKFLOW_REF`, so no name is fixed (the collector's
   * watermark, plan 0002 S7).
   */
  reaches: string | 'declared' | 'callers' | 'self';
  constant?: string;
  /** `caller`: the line names the file `laneCallerFile` resolved for the lane `reaches` (kanon#726). */
  via?: 'caller';
  /**
   * The deploy lane's workflow that runs the line (plan 0010 D4). The deploy lane is not an agent
   * lane, so no `# READS WORKFLOW:` line and no `lane-check` caller requires the name: doctor's
   * `deploy.ci-push-missing` does (plan 0010 §12, step D7).
   */
  deployLane?: string;
};

const SITES: Site[] = [
  { file: 'scripts/merge-gate.mjs', line: "gh(['workflow', 'run', caller,", reaches: 'agent-review.yml', constant: 'REVIEW_LANE_FILE', via: 'caller' },
  { file: 'scripts/review-run-evidence.mjs', line: '/runs?event=workflow_run', reaches: 'agent-review.yml', constant: 'REVIEW_WORKFLOW_FILE', via: 'caller' },
  { file: 'scripts/review-run-evidence.mjs', line: '/runs?head_sha=', reaches: 'agent-review.yml', constant: 'REVIEW_WORKFLOW_FILE', via: 'caller' },
  { file: 'scripts/brief-revise-recovery.mjs', line: "'--workflow', laneCallerFile(WORKFLOW,", reaches: 'agent-lead-revise.yml', constant: 'WORKFLOW', via: 'caller' },
  { file: 'scripts/lead-reconcile.mjs', line: "'--workflow', laneCallerFile(REVISE_WORKFLOW,", reaches: 'agent-implement-revise.yml', constant: 'REVISE_WORKFLOW', via: 'caller' },
  { file: 'scripts/lib/lane-caller.mjs', line: "l.startsWith('agent-')", reaches: 'callers' },
  { file: 'scripts/lead-reconcile.mjs', line: "'--workflow', deploy.workflow,", reaches: 'declared' },
  { file: 'scripts/review-recovery.mjs', line: "'--workflow', 'ci.yml'", reaches: 'ci.yml' },
  { file: 'scripts/workflow-health.mjs', line: "f.startsWith('agent-')", reaches: 'callers' },
  { file: 'scripts/workflow-health.mjs', line: "'--workflow', file,", reaches: 'callers' },
  { file: 'scripts/workflow-health.mjs', line: 'actions/workflows/${encodeURIComponent(file)}', reaches: 'callers' },
  { file: '.github/workflows/agent-lead-reconcile.yml', line: 'set -- --workflow "$workflow"', reaches: 'declared' },
  { file: '.github/workflows/agent-review.yml', line: '--workflow ci.yml --commit', reaches: 'ci.yml' },
  // Each lane's caller, as `resolveCaller` finds it, to measure its runner-minutes (kanon#581).
  { file: 'scripts/actions-minutes.mjs', line: '/actions/workflows/${file}/runs?created=', reaches: 'callers' },
  { file: 'scripts/actions-minutes.mjs', line: '/actions/workflows/${caller.file}`]', reaches: 'callers' },
  { file: 'scripts/telemetry-collect.mjs', line: '/actions/workflows/${encodeURIComponent(file)}/runs', reaches: 'self' },
  // A re-ask's due check lists its own caller's runs, by the file `GITHUB_WORKFLOW_REF` names (kanon#813).
  { file: 'scripts/reask-due.mjs', line: '/actions/workflows/${file}/runs', reaches: 'self' },
  // The deploy gate waits for the release commit's `ci.yml` push run (`K-SHIP-8`, plan 0010 §3 check 4).
  { file: 'scripts/deploy-gate.mjs', line: '/actions/workflows/${CI_WORKFLOW}/runs', reaches: 'ci.yml', constant: 'CI_WORKFLOW', deployLane: 'deploy-release.yml' },
];

/** Code lines only: a comment that names a workflow reaches nothing. */
const codeLines = (rel: string): string[] =>
  read(rel).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l));

const SOURCES = [
  ...readdirSync(join(ROOT, 'scripts')).filter((f) => f.endsWith('.mjs')).map((f) => `scripts/${f}`),
  ...readdirSync(join(ROOT, 'scripts/lib')).filter((f) => f.endsWith('.mjs')).map((f) => `scripts/lib/${f}`),
  ...LANES.map((f) => `.github/workflows/${f}`),
];

/** The lanes that run a script, or the lane itself for a site in a lane. */
const lanesReaching = (file: string): string[] => {
  if (file.startsWith('.github/workflows/')) return [file.replace('.github/workflows/', '')];
  const script = file.replace(/^scripts\//, '');
  return LANES.filter((l) => read(`.github/workflows/${l}`).includes(`"$KANON/scripts/${script}"`));
};

const declaredReads = (lane: string): string[] =>
  [...read(`.github/workflows/${lane}`).matchAll(/^# READS WORKFLOW: (\S+)$/gm)].map((m) => m[1]!);

describe('every workflow Kanon reaches by file name is one K-LAYOUT-18 fixes', () => {
  const hits = SOURCES.flatMap((file) => codeLines(file).filter((l) => READ.test(l)).map((l) => ({ file, l })));

  it('finds the sites, so the checks below are not vacuous', () => {
    expect(hits.length).toBeGreaterThanOrEqual(SITES.length);
  });

  it('lists every line that reaches a workflow by name, and no line that no longer does', () => {
    const unlisted = hits.filter((h) => !SITES.some((s) => s.file === h.file && h.l.includes(s.line))).map((h) => `${h.file}: ${h.l.trim()}`);
    expect(unlisted, 'a new read of a workflow by file name: add it to SITES, and to K-LAYOUT-18 if it is a new name').toEqual([]);
    const stale = SITES.filter((s) => !hits.some((h) => h.file === s.file && h.l.includes(s.line))).map((s) => `${s.file}: ${s.line}`);
    expect(stale).toEqual([]);
  });

  it.each(SITES.filter((s) => s.constant))('$file reaches $reaches through $constant', (s) => {
    expect(read(s.file)).toMatch(new RegExp(`\\b${s.constant} = '${s.reaches.replace('.', '\\.')}';`));
  });

  it.each(SITES.filter((s) => s.via === 'caller'))('$file reaches $reaches through its caller (kanon#726)', (s) => {
    expect(read(s.file)).toMatch(new RegExp(`laneCallerFile\\(${s.constant}, \\{ repo(?:: REPO)?, json \\}\\)`));
  });

  it.each(SITES.filter((s) => s.deployLane))('$file reaches $reaches from the deploy lane, $deployLane, where doctor requires it', (s) => {
    expect(read(`.github/workflows/${s.deployLane}`)).toContain(`"$KANON/${s.file}"`);
  });

  it.each(SITES.filter((s) => !s.deployLane && s.reaches !== 'declared' && s.reaches !== 'callers' && s.reaches !== 'self'))('$file reaches $reaches, a name the rule fixes', (s) => {
    if (LANES.includes(s.reaches)) return; // a caller has its lane's file name
    const lanes = lanesReaching(s.file);
    expect(lanes.length, `${s.file} runs in no lane`).toBeGreaterThan(0);
    for (const lane of lanes) expect(declaredReads(lane), `${lane} must declare \`# READS WORKFLOW: ${s.reaches}\``).toContain(s.reaches);
  });

  it('every `# READS WORKFLOW:` line is a read the lane makes, so none is required for nothing', () => {
    for (const lane of LANES) {
      for (const w of declaredReads(lane)) {
        expect(SITES.some((s) => s.reaches === w && lanesReaching(s.file).includes(lane)), `${lane}: ${w}`).toBe(true);
      }
    }
  });

  it('the lanes that read CI declare it: the review lane and the reconciler', () => {
    expect(LANES.filter((l) => declaredReads(l).includes('ci.yml')).sort()).toEqual(['agent-lead-reconcile.yml', 'agent-review.yml']);
  });
});

/**
 * kanon#738: a re-run hint is a dispatch a human runs, and since kanon#726 a lane's caller need
 * not have the lane's name (a `caller.misplaced` waiver; Kanon's own, beside the lanes). A hint
 * that names the lane's own file dispatches the lane there, which runs only on `workflow_call`.
 * So no hint fixes a lane's name: a lane prints the caller `GITHUB_WORKFLOW_REF` names. Comments
 * are read too, since they quote the hint a reader copies.
 */
describe('no re-run hint dispatches a lane by its own file name (kanon#738)', () => {
  /** Every file of the library, the actions, the command and the workflows. */
  const walk = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(`${dir}/${e.name}`)) : /\.(mjs|ya?ml|sh)$/.test(e.name) ? [`${dir}/${e.name}`] : []);
  const FILES = ['.github/workflows', 'actions', 'scripts', 'cli'].flatMap(walk);
  const HINT = /gh workflow run agent-[\w-]+\.ya?ml/;
  /**
   * The one exception, which the issue names: the Lead's QA-verification issue quotes the verify
   * lane's dispatch, and `QA_BODY_ANCHOR` matches an earlier body by that exact text.
   */
  const KEPT = [{ file: 'scripts/lead-reconcile.mjs', line: '`gh workflow run agent-verify-acs.yml -f project=${world.project}' }];

  it('reads the lanes and the scripts, so the sweep is not vacuous', () => {
    expect(FILES).toContain('.github/workflows/review-agent-job.yml');
    expect(FILES).toContain('actions/agent-classify/classify-agent-result.mjs');
    expect(FILES).toContain('scripts/lead-reconcile.mjs');
  });

  it('finds none outside the one the Lead\'s verification issue quotes', () => {
    const hits = FILES.flatMap((file) => read(file).split('\n').filter((l) => HINT.test(l)).map((l) => ({ file, l })));
    const kept = hits.filter((h) => KEPT.some((k) => k.file === h.file && h.l.includes(k.line)));
    expect(kept.length, 'the kept hint is still there, so its entry is not stale').toBe(KEPT.length);
    expect(hits.filter((h) => !kept.includes(h)).map((h) => `${h.file}: ${h.l.trim()}`)).toEqual([]);
  });
});
