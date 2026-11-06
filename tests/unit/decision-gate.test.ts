import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DECISION_NEEDED, REFUSAL_MARKER, decide, labelNames, refusalComment } from '../../scripts/decision-gate.mjs';

/**
 * kanon#1594: the implement and triage lanes refuse an issue that waits on a person's decision
 * (`decision:needed`, K-WORK-24), after the membership gate and before any token or model.
 */
const label = (name: string) => ({ name, color: 'ffffff' });
const env = (over: Record<string, string>) => ({ REPO: 'acme/widgets', ISSUE: '7', EVENT: 'issues', LABELS: 'null', ...over });

describe('decide', () => {
  it('refuses an issue the label event says waits on a decision, and admits any other', () => {
    expect(decide({ env: env({ LABELS: JSON.stringify([label('agent:implement'), label(DECISION_NEEDED)]) }) })).toMatchObject({ admit: false, reason: expect.stringContaining('`decision:needed`') });
    expect(decide({ env: env({ LABELS: JSON.stringify([label('agent:implement')]) }) }).admit).toBe(true);
  });

  it('reads the labels from GitHub for a dispatch, which carries none, and admits when it cannot', () => {
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      return JSON.stringify([label(DECISION_NEEDED)]);
    };
    expect(decide({ env: env({ EVENT: 'workflow_dispatch' }), gh }).admit).toBe(false);
    expect(calls[0]).toEqual(['api', 'repos/acme/widgets/issues/7', '--jq', '.labels']);
    const failing = () => {
      throw new Error('HTTP 404');
    };
    expect(decide({ env: env({ EVENT: 'workflow_dispatch' }), gh: failing })).toMatchObject({ admit: true, reason: expect.stringMatching(/^could not read issue #7's labels/) });
  });

  it('reads label objects and names alike, and nothing else as a list', () => {
    expect(labelNames([label('a'), 'b'])).toEqual(['a', 'b']);
    expect(labelNames(null)).toBeNull();
  });

  it("comments with the label, the marker and what to do", () => {
    const c = refusalComment('implement');
    expect(c.startsWith(REFUSAL_MARKER)).toBe(true);
    expect(c).toContain('`decision:needed`');
    expect(c).toMatch(/Record the decision here and remove `decision:needed`/);
  });
});

describe('the lanes run it', () => {
  type Step = { id?: string; run?: string; if?: string; env: Record<string, string> };
  type Filter = { steps: Step[]; outputs: Record<string, string>; permissions?: Record<string, string> };
  const filter = (file: string) => (parse(readFileSync(join(process.cwd(), '.github/workflows', file), 'utf8')) as { jobs: { filter: Filter } }).jobs.filter;
  it.each([['agent-implement.yml', 'true'], ['agent-triage.yml', 'false']])('%s: after the membership gate, and its refusal skips the lane', (file, comment) => {
    const f = filter(file);
    const ids = f.steps.map((s) => s.id ?? '');
    expect(ids.indexOf('decision')).toBe(ids.indexOf('gate') + 1);
    const step = f.steps[ids.indexOf('decision')]!;
    expect(step.run).toBe('node "$KANON/scripts/decision-gate.mjs"');
    expect(step.if).toBe("steps.gate.outputs.member == 'true'");
    expect(step.env.COMMENT).toBe(comment);
    expect(step.env.LABELS).toBe('${{ toJSON(github.event.issue.labels) }}');
    expect(f.outputs.member).toBe("${{ steps.gate.outputs.member == 'true' && steps.decision.outputs.admit == 'true' && 'true' || 'false' }}");
  });

  it('gives the implement filter the issues: write its comment needs, which its caller grants', () => {
    expect(filter('agent-implement.yml').permissions).toEqual({ contents: 'read', issues: 'write' });
    const req = JSON.parse(readFileSync(join(process.cwd(), 'requirements.json'), 'utf8'));
    expect(req.lanes['agent-implement'].grant.issues).toBe('write');
    // The triage caller grants issues: read, for the labels a dispatch doesn't carry (kanon#1655),
    // and no issues: write, so its filter reads them and never comments.
    expect(filter('agent-triage.yml').permissions).toEqual({ contents: 'read', issues: 'read' });
    expect(req.lanes['agent-triage'].grant).toEqual({ contents: 'read', issues: 'read' });
  });
});
