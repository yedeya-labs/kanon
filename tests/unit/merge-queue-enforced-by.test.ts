import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkJobs } from '../../cli/check-reporters.mjs';
import { LANE_CHECK, rulesetBody } from '../../cli/init.mjs';

/**
 * `K-MERGE-7`'s "Enforced by" line says what holds an adopter to the rule (#485). It names what
 * `kanon init` and `kanon doctor` do, and this test holds each of those claims to the code: the
 * ruleset init creates, the finding ids the two commands document, and the `merge_group` reading
 * they share. The line also says what stays prose only, so it can't claim more than this checks.
 */
const ROOT = process.cwd();
const CHAPTER = readFileSync(join(ROOT, 'rulebook/04-review-and-merge.md'), 'utf8');
const DOCS = ['docs/doctor.md', 'docs/init.md'].map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');

/** The "Enforced by" line of a rule in this chapter. @param id the rule's id */
const enforcedBy = (id: string): string => {
  const section = CHAPTER.split(/^### /m).find((s) => s.startsWith(`\`${id}\``)) ?? '';
  return /^\*\*Enforced by\.\*\* (.*)$/m.exec(section)?.[1] ?? '';
};

describe("K-MERGE-7's Enforced-by line names what holds an adopter to the rule (#485)", () => {
  const line = enforcedBy('K-MERGE-7');
  const adopter = line.slice(line.indexOf('For an adopter'));

  it('reads the line, so the checks below are not vacuous', () => {
    expect(line).toMatch(/merge-queue rule/);
    expect(adopter).toMatch(/^For an adopter/);
  });

  it('no longer calls the adopter half prose only, and says what still is', () => {
    expect(adopter).not.toMatch(/^For an adopter, prose only/);
    expect(adopter).toMatch(/kanon init/);
    expect(adopter).toMatch(/kanon doctor/);
    expect(adopter).toMatch(/prose only/);
  });

  it("names the ruleset init creates as it is: the merge queue where the plan has it, and the up-to-date setting off", () => {
    expect(adopter).toMatch(/merge-queue rule/);
    expect(adopter).toMatch(/up to date/);
    const queued = rulesetBody(true).rules as Array<{ type: string; parameters?: Record<string, unknown> }>;
    expect(queued.map((r) => r.type)).toContain('merge_queue');
    expect(queued.find((r) => r.type === 'required_status_checks')?.parameters?.strict_required_status_checks_policy).toBe(false);
    expect((rulesetBody(false).rules as Array<{ type: string }>).map((r) => r.type)).not.toContain('merge_queue');
  });

  it('names only finding ids doctor or init documents, and the two that read merge_group', () => {
    const ids = [...adopter.matchAll(/`(ruleset\.[a-z-]+)`/g)].map((m) => m[1]!);
    expect(ids).toEqual(expect.arrayContaining(['ruleset.check-unreported', 'ruleset.require-check']));
    for (const id of ids) expect(DOCS, id).toContain(`| \`${id}\` |`);
  });

  it('counts a job that reports the check only if its workflow runs on merge_group, through a merge queue', () => {
    const job = (on: unknown) => new Map([['lane-check.yml', { on, jobs: { lane: { name: LANE_CHECK, 'runs-on': 'ubuntu-latest' } } }]]);
    expect(checkJobs(job({ pull_request: null }), LANE_CHECK, 'main', true)[0]?.missing).toEqual(['merge_group']);
    expect(checkJobs(job({ pull_request: null, merge_group: null }), LANE_CHECK, 'main', true)[0]?.missing).toEqual([]);
  });
});
