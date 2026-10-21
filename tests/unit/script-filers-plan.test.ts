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
 */
const FILERS = ['scripts/overseer-file.mjs', 'scripts/workflow-health.mjs', 'scripts/telemetry-file.mjs'];

describe("the Overseer's filer, workflow-health and the telemetry filer ask plan() for their routing (K-WORK-8)", () => {
  it.each(FILERS)('%s names no bucket and passes no --milestone of its own', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toMatch(/import \{[^}]*\bplan\b[^}]*\} from '\.\/issue-triage-defaults\.mjs'/);
    expect(BUCKET_MILESTONES.filter((m) => src.includes(m))).toEqual([]);
    // A string literal, not the backticked flag a comment names.
    expect(src).not.toMatch(/['"]--milestone['"]/);
    // Nor the backstop's `decide()`, the rule's other caller, which a filer never asks.
    expect(src).not.toMatch(/\bdecide\b/);
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
