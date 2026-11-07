import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * kanon#1685 (the Owner's decision of 2026-11-06). The Implementer's body said "170 tests pass";
 * every merge of main into its approved pull request made the count stale, the Reviewer requested
 * changes on the body alone (`K-SHIP-3`), and nothing but a person edited it. So the Implementer
 * states no suite total, the revise lane fixes a description finding with `gh pr edit`, and the
 * Reviewer asks for a stale total to be removed, not updated. Prose guards: each anchors on the
 * claim it holds and fails when the claim goes.
 */
const flat = (path: string) => readFileSync(path, 'utf8').replace(/\s+/g, ' ');

describe('the Implementer states no suite total (#1685)', () => {
  it.each(['.github/workflows/agent-implement.yml', '.github/workflows/agent-triage.yml'])('%s: the prompt says to state none, and what to give instead', (path) => {
    const text = flat(path);
    expect(text).toContain('STATE NO SUITE TOTAL IN THE BODY (kanon#1685)');
    expect(text).toContain('Give the command, list the tests your PR adds or changes, and say the CI run on the head counts the suite.');
  });

  it('the playbook says so in its pull request item', () => {
    const item = readFileSync('docs/qa/triage-fix-playbook.md', 'utf8').split('\n').find((l) => l.startsWith('8. **The pull request.**'));
    expect(item).toContain('State no total that a merge of the base branch moves');
    expect(item).toContain('point at the CI run on the head for the count');
  });
});

describe('the revise lane fixes a description finding (#1685)', () => {
  it('tells the agent the body is its to edit with gh pr edit, and a stale total is removed', () => {
    const text = flat('.github/workflows/agent-implement-revise.yml');
    expect(text).toContain('A FINDING ABOUT THE PR DESCRIPTION IS YOURS TO FIX (kanon#1685)');
    expect(text).toContain('`gh pr edit $PR --repo $REPO --body-file <file>`');
    expect(text).toContain('A suite total that went stale (a test count) is removed, never updated');
    // Before the marker comment, so the answer it reports includes the edit.
    expect(text.indexOf('A FINDING ABOUT THE PR DESCRIPTION')).toBeLessThan(text.indexOf('WHEN YOU ARE DONE'));
  });
});

describe("the playbook's Revise mode says the same as the revise prompt (#1691)", () => {
  it('a description finding is the agent\'s to fix with gh pr edit, and a stale total is removed', () => {
    const doc = readFileSync('docs/qa/triage-fix-playbook.md', 'utf8');
    const section = doc.slice(doc.indexOf('## Revise mode'));
    const next = section.indexOf('\n## ', 1);
    const revise = (next === -1 ? section : section.slice(0, next)).replace(/\s+/g, ' ');
    expect(revise).toContain("A finding about the pull request's description is yours to fix");
    expect(revise).toContain('`gh pr edit <n> --body-file <file>`');
    expect(revise).toContain('Remove a stale total, such as a test count, and never update it');
  });
});

describe('the Reviewer asks for a stale total to be removed (#1685)', () => {
  it.each([
    ['.github/workflows/review-agent-job.yml', 'A suite total a merge of main made stale (a test count) is asked to be REMOVED, not updated'],
    ['docs/qa/reviewer-playbook.md', 'A suite total that a merge of main made stale, such as a test count, is asked to be removed, not updated'],
    ['rulebook/templates/playbooks/reviewer-playbook.md', 'A suite total that a merge of the base branch made stale, such as a test count, is asked to be removed, not updated'],
  ])('%s', (path, claim) => {
    expect(flat(path)).toContain(claim);
  });
});
