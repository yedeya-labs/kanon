import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentPrompt } from '../unit/helpers/workflow-step.js';
import { effectiveSteps } from '../unit/helpers/spine.js';
import { surfacedByPr } from '../../scripts/lead-reconcile.mjs';
import { ROOT } from './helpers/adopter.js';
import { readFlattened } from '../unit/helpers/called-workflow.js';

/**
 * RA-1783 — follow-ups and bugs inherit their project's membership; RA-2412 — the Reviewer
 * no longer traces it. The reconciler derives it from the `Surfaced by PR #N review` line
 * (`deriveFollowUps`), so that line is the input to a mechanical check and must survive, and
 * a marker the Reviewer wrote would pre-empt it. Asserted over the prompt that executes.
 *
 * The reference adopter's playbook half ("the playbook states the same rule") and its
 * Explorer lane's half stay in the adopter: they test its own documents and a lane that has
 * not moved.
 */
const wf = readFlattened(join(ROOT, '.github/workflows/agent-review.yml'));
// Through the blocks: the review lane runs its agent in the `agent-run` block (RA-2608).
const review = agentPrompt(effectiveSteps(wf.jobs.review.steps)).replace(/\s+/g, ' ');

describe('the Reviewer (agent-review.yml) leaves membership to the reconciler (RA-2412)', () => {
  it('no longer carries the RA-1783 tracing paragraph', () => {
    expect(review).not.toMatch(/PROJECT MEMBERSHIP \((#|RA-)1783\)/);
    expect(review).not.toContain('--json closingIssuesReferences');
  });

  it('still mandates the provenance line the derivation reads, and says why', () => {
    expect(review).toContain('"Surfaced by PR #${{ env.PR_NUMBER }} review"');
    expect(review).toMatch(/do NOT add a `<!-- qa:project <n> -->` marker or a `project:<n>` label: the reconciler derives/);
  });

  it('the substituted provenance line is what the derivation parses', () => {
    const line = /"(Surfaced by PR #)\$\{\{ env\.PR_NUMBER \}\}( review)"/.exec(review);
    expect(line).toBeTruthy();
    expect(surfacedByPr(`finding\n\n${line![1]}2412${line![2]}`)).toBe(2412);
  });
});
