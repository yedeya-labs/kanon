import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// kanon#1569: the brief lane's comments, and the spine's, say what #1562's tracking-issue refusal
// changed: the filter job checks the tracking issue too, and agent-run's outcome can be a refusal's.
describe('the comments over the tracking-issue refusal (#1569)', () => {
  const lead = readFileSync('.github/workflows/agent-lead.yml', 'utf8');
  it("say the brief lane's filter job checks the tracking issue, and the brief job hands its refusal on", () => {
    expect(lead).toMatch(/# AND THE TRACKING-ISSUE CHECK \(`K-AGENT-30`[^\n]*\n {2}# dispatch, the job also checks that its `context` names a tracking issue\. Its `refusal` output/);
    expect(lead).not.toMatch(/the job above is the membership gate alone/);
    expect(lead).toMatch(/# and the tracking-issue check, whose `refusal` output this job hands to `agent-run`/);
  });

  it("say the spine's agent outcome is the action's, or a check's that refused the run before it", () => {
    const spine = readFileSync('.github/workflows/lane-agent-job.yml', 'utf8');
    expect(spine).not.toMatch(/whose only step that can fail is the action/);
    expect(spine).toMatch(/Its outcome is the action's, or that of a check before\n\s+# the action that refused the run/);
  });
});
