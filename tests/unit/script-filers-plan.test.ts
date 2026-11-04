import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUCKET_MILESTONES, PIPELINE_MILESTONE, plan } from '../../scripts/issue-triage-defaults.mjs';
import { LABELS, routing } from '../../scripts/overseer-file.mjs';
import { LABELS as TELEMETRY_LABELS, routingFor } from '../../scripts/telemetry-file.mjs';
import { PIPELINE_ROUTING } from '../../scripts/workflow-health.mjs';

/**
 * kanon#1194, `K-WORK-8`: the routing rule has one home, the planning module's `plan()`. A script
 * that files an issue from code takes its `--label` and `--milestone` arguments from it, and names
 * no bucket of its own, so a change to the bucket rule in `plan()` reaches every filer.
 *
 * kanon#1600: the deploy lane's report and the promotion's held issue file on the workflow token,
 * whose `issues: opened` starts no backstop run, so `plan()` is the only routing they get. The list
 * is held to every script that creates an issue, found by the call, so a new filer can't be missed.
 */
const FILERS = [
  'scripts/overseer-file.mjs', 'scripts/workflow-health.mjs', 'scripts/telemetry-file.mjs',
  'scripts/deploy-report.mjs', 'scripts/promote.mjs',
];
/** The Lead's reconcile tick asks `plan()` too, and `tests/library/lead-reconcile.test.ts` holds each of its creates to it. */
const HELD_ELSEWHERE = ['scripts/lead-reconcile.mjs'];

/** A `gh issue create` argument list, or a REST `POST` to a repository's `/issues`. */
const CREATES_AN_ISSUE = [/['"]issue['"],\s*['"]create['"]/, /\/issues[`'"],\s*\{\s*method:\s*['"]POST['"]/];

describe('every script that creates an issue is a filer this test holds (kanon#1600)', () => {
  const code = execFileSync('git', ['ls-files', 'scripts', 'actions', 'cli', 'infra', '.github/scripts'], { encoding: 'utf8' })
    .split('\n').filter((f) => /\.(?:mjs|js|cjs|ts|sh)$/.test(f));

  it('finds the filers by their create call (MUTATION: dropping a filer from FILERS turns this red)', () => {
    const creators = code.filter((f) => CREATES_AN_ISSUE.some((re) => re.test(readFileSync(f, 'utf8'))));
    expect(creators.sort()).toEqual([...FILERS, ...HELD_ELSEWHERE].sort());
  });
});

describe('every script filer asks plan() for its routing (K-WORK-8)', () => {
  it.each(FILERS)('%s names no bucket and passes no --milestone of its own', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toMatch(/import \{[^}]*\bplan\b[^}]*\} from '\.\/issue-triage-defaults\.mjs'/);
    expect(BUCKET_MILESTONES.filter((m) => src.includes(m))).toEqual([]);
    // A string literal, not the backticked flag a comment names.
    expect(src).not.toMatch(/['"]--milestone['"]/);
    // Nor the backstop's `decide()`, the rule's other caller, which a filer never asks: its import
    // or a call, not the English word a held issue's prose uses.
    expect(src).not.toMatch(/import \{[^}]*\bdecide\b|\bdecide\s*\(/);
  });

  it("routes each of workflow-health's creates through PIPELINE_ROUTING", () => {
    const src = readFileSync('scripts/workflow-health.mjs', 'utf8');
    const creates = src.split(/'issue', 'create'/).slice(1);
    expect(creates.length).toBeGreaterThanOrEqual(3);
    // Each create's argument list, up to its closing `])`, spreads the routing.
    for (const call of creates) expect(call.slice(0, call.indexOf('])'))).toContain('...PIPELINE_ROUTING()');
  });

  it('sends the pipeline work of both to the bucket plan() names for it', () => {
    expect(PIPELINE_ROUTING()).toEqual(['--label', 'pipeline-improvement', '--milestone', PIPELINE_MILESTONE]);
    expect(routing(LABELS)).toEqual(plan(LABELS, { subject: 'pipeline' }).args);
    expect(routing([...LABELS, 'capability'])).toEqual([
      '--label', 'pipeline-improvement', '--label', 'agent:overseer', '--label', 'capability', '--milestone', PIPELINE_MILESTONE,
    ]);
  });

  it("sends the telemetry filer's findings to the bucket plan() names for product work", () => {
    const bug = [...TELEMETRY_LABELS.bug, 'sev:high'];
    expect(routingFor(bug).args).toEqual(plan(bug, { subject: 'product' }).args);
    expect(routingFor(TELEMETRY_LABELS['spec-delta']).args).toEqual(plan(TELEMETRY_LABELS['spec-delta'], { subject: 'product' }).args);
  });
});
