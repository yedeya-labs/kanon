import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * kanon#1595 (the Owner's decision of 2026-11-06): a defect or gap the Reviewer names and doesn't
 * fold in is filed, at `sev:low` with its reasoning when judged unlikely, never declined as "not
 * real". Only a question about intent and a nit that asks for nothing stay review-only. The prompts
 * make no exception of their own and defer to the playbook, so they no longer contradict the
 * severity rubric's `sev:low` = cosmetic. Kanon's playbook and the baseline one say the same.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
/** A prompt's text with its YAML indentation and line breaks folded to single spaces. */
const flat = (p: string) => read(p).replace(/\s+/g, ' ');
const REVIEW = flat('.github/workflows/review-agent-job.yml');
const RECONCILE = flat('.github/workflows/merge-reconcile-agent-job.yml');

describe('the Reviewer files what it names (kanon#1595)', () => {
  it('files a named defect or gap it does not fold in, at the severity its reachable impact fits', () => {
    expect(REVIEW).toContain('a defect or gap you name in the review and do not fold into this PR is FILED as a `follow-up` issue');
    expect(REVIEW).toContain('one unreachable in practice, by-hand only or of no current impact is `sev:low`, with that reasoning in the body');
    // Rarity never lowers a reachable impact's level (K-WORK-9): only reach does.
    expect(REVIEW).toContain('one whose reachable impact fits a higher level keeps that level, however rare you judge it (K-WORK-9)');
    expect(REVIEW).not.toMatch(/one you judge unlikely is `sev:low`/);
    expect(REVIEW).toContain('never whether to file it');
  });

  it('makes no exception of its own, and none the severity rubric contradicts', () => {
    expect(REVIEW).not.toMatch(/real deferred work/);
    expect(REVIEW).not.toMatch(/Pure confirmations \/ cosmetics \/ no-action nits/);
    expect(REVIEW).toContain(`What stays in the review alone is what the playbook's "Capturing follow-ups" says stays there; by default, only a question about intent and a nit that asks for nothing. Follow the playbook.`);
    // The rubric it no longer contradicts.
    expect(REVIEW).toContain('`sev:low` = cosmetic');
  });

  it('has the merge reconcile, which files what a merge left unapplied, read the same bar', () => {
    expect(RECONCILE).not.toMatch(/IGNORE pure confirmations, cosmetics, and no-action nits/);
    expect(RECONCILE).toContain('any defect or gap the review named without filing it');
    expect(RECONCILE).toContain(`IGNORE only what the playbook's "Capturing follow-ups" keeps in the review: by default, a question about intent and a nit that asks for nothing.`);
  });

  it("says the same in Kanon's playbook and the baseline adopters read", () => {
    const own = read('docs/qa/reviewer-playbook.md');
    expect(own).toContain("**A defect or gap you name and don't fold in is filed**");
    expect(own).toMatch(/one you judge unreachable in practice, by-hand only or of no current impact is `sev:low`, with that reasoning in the body, and one whose reachable impact fits a higher level keeps that level/);
    // A cleanup note on an approval stays accepted unapplied (#1136), and "Capturing follow-ups"
    // says so, so merge reconcile, which ignores only what that section keeps, files nothing for it.
    expect(own).toMatch(/if the pull request merges unapplied, that is accepted/);
    expect(own).toContain('a small code cleanup left as a note on an approval: item 11 accepts it unapplied');
    expect(own).not.toMatch(/one you judge not worth doing, say so in the review and file nothing/);
    const baseline = read('rulebook/templates/playbooks/reviewer-playbook.md');
    expect(baseline).toContain("A defect or gap you name in the review and don't fold in is trackable work: file it, rather than declining it in the review, at the severity its reachable impact fits (`K-WORK-9`)");
    expect(baseline).not.toMatch(/when you judge it unlikely/);
    expect(read('docs/lanes.md')).toContain('at the severity its reachable impact fits (`K-WORK-9`)');
  });
});
