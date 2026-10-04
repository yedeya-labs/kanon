import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * K-LAYOUT-18 (kanon#207): Kanon's scripts and lanes reach an adopter's workflows by FILE NAME,
 * so every name they use must be one the rule fixes: a lane's own file name (each caller has
 * its lane's name), or a workflow a lane declares on a `# READS WORKFLOW:` line, which
 * `lane-check` then requires the adopter to have.
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
   * every lane caller, by the `agent-` prefix every caller's name has.
   */
  reaches: string | 'declared' | 'callers';
  constant?: string;
};

const SITES: Site[] = [
  { file: 'scripts/merge-gate.mjs', line: "gh(['workflow', 'run', 'agent-review.yml'", reaches: 'agent-review.yml' },
  { file: 'scripts/review-run-evidence.mjs', line: '/runs?event=workflow_run', reaches: 'agent-review.yml', constant: 'REVIEW_WORKFLOW_FILE' },
  { file: 'scripts/review-run-evidence.mjs', line: '/runs?head_sha=', reaches: 'agent-review.yml', constant: 'REVIEW_WORKFLOW_FILE' },
  { file: 'scripts/brief-revise-recovery.mjs', line: "'--workflow', WORKFLOW,", reaches: 'agent-lead-revise.yml', constant: 'WORKFLOW' },
  { file: 'scripts/lead-reconcile.mjs', line: "'--workflow', 'agent-implement-revise.yml'", reaches: 'agent-implement-revise.yml' },
  { file: 'scripts/lead-reconcile.mjs', line: "'--workflow', deploy.workflow,", reaches: 'declared' },
  { file: 'scripts/review-recovery.mjs', line: "'--workflow', 'ci.yml'", reaches: 'ci.yml' },
  { file: 'scripts/workflow-health.mjs', line: "f.startsWith('agent-')", reaches: 'callers' },
  { file: 'scripts/workflow-health.mjs', line: "'--workflow', file,", reaches: 'callers' },
  { file: '.github/workflows/agent-lead-reconcile.yml', line: 'set -- --workflow "$workflow"', reaches: 'declared' },
  { file: '.github/workflows/agent-review.yml', line: '--workflow ci.yml --commit', reaches: 'ci.yml' },
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

  it.each(SITES.filter((s) => s.reaches !== 'declared' && s.reaches !== 'callers'))('$file reaches $reaches, a name the rule fixes', (s) => {
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
