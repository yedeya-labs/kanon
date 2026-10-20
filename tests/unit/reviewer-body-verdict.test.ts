import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFlattened } from './helpers/called-workflow.js';

/**
 * kanon#1136 — a pull request body that would make a wrong squash commit message is a
 * changes-request, not an approval with a note.
 *
 * The body is the squash commit's message (`K-SHIP-3`), and the merge follows the approval,
 * often within minutes and with no push between: four approvals that asked for a body edit
 * merged with the body unedited, and a squash message can't be corrected afterwards. The
 * Owner decided that only the body blocks: a small code cleanup stays a note on an approval,
 * and one that merges unapplied is accepted. These are prose guards, so each anchors on the
 * claim it holds and fails when the claim goes.
 */

const wf = readFlattened(join(process.cwd(), '.github/workflows/agent-review.yml'));
const prompt: string = wf.jobs.review.steps.find((s: { id?: string }) => s.id === 'agent').with.prompt;

/** The prompt's paragraph (blank-line separated) that holds `needle`; throws when none does. */
const paragraphOf = (text: string, needle: string): string => {
  const hit = text.split(/\n\s*\n/).filter((p) => p.includes(needle));
  if (hit.length !== 1) throw new Error(`expected one paragraph with ${needle}, found ${hit.length}`);
  return hit[0]!.replace(/\s+/g, ' ');
};

describe("the review lane's prompt (kanon#1136)", () => {
  it('requests changes on a body that would make a wrong or stale squash message (K-SHIP-3)', () => {
    const p = paragraphOf(prompt, 'K-SHIP-3');
    expect(p).toMatch(/squash commit's message/i);
    expect(p).toMatch(/wrong or stale/);
    expect(p).toMatch(/REQUEST_CHANGES naming the edit/);
    expect(p).toMatch(/never `?APPROVE`? with a note/);
  });

  it('no longer says a green rollup alone means APPROVE', () => {
    expect(prompt).not.toMatch(/all green → `APPROVE`/);
    expect(paragraphOf(prompt, 'RA-293')).toMatch(/all green → your findings decide/);
  });
});

describe("Kanon's reviewer playbook (kanon#1136)", () => {
  const playbook = readFileSync(join(process.cwd(), 'docs/qa/reviewer-playbook.md'), 'utf8');
  const section = playbook.split(/^## /m).find((s) => s.startsWith('What to check\n'));
  if (!section) throw new Error("the playbook's `## What to check` heading moved");
  const item = section.split('\n').filter((l) => /^\d+\. /.test(l) && l.includes('`K-SHIP-3`'));

  it('has one check that the body is the squash message, and requests changes on a wrong one', () => {
    expect(item).toHaveLength(1);
    expect(item[0]).toMatch(/squash commit's message/);
    expect(item[0]).toMatch(/request changes naming the edit/);
    expect(item[0]).toMatch(/never approve with a note/);
  });

  it('keeps a small code cleanup a note on an approval, accepted if it merges unapplied', () => {
    expect(item[0]).toMatch(/small code cleanup[^.]*note on an approval \(`K-WORK-17`\)/);
    expect(item[0]).toMatch(/merges unapplied, that is accepted/);
  });
});
