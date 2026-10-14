import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * kanon#801: the lanes `K-AGENT-50` accepts as exceptions are stated in three places, and they
 * must agree (K-PRIN-2: a restatement that can't be avoided gets a parity test).
 *
 *   - SECURITY.md's "Accepted exposures", under "Which lanes, and what runs": the page an
 *     adopter's security review reads;
 *   - the rule itself, `rulebook/03-agents.md` `K-AGENT-50`, in its **Rule**'s sentence on the
 *     accepted exceptions;
 *   - the isolation guard's `ACCEPTED` exceptions in `tests/unit/pr-code-token-isolation.test.ts`,
 *     each a `file:job` that must still fail, so a fixed lane leaves the list.
 *
 * The guard names the job that runs the code, which may sit in a workflow the lane calls
 * (`rebase-agent-job.yml`, through `rebase-run.yml`); it maps to the one lane, an
 * `agent-*.yml`, that calls it through `$/`, directly or through another.
 */

const ROOT = process.cwd();
const WORKFLOWS = '.github/workflows';
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** The body under the heading `heading` (exact line), up to the next heading of that level or higher. */
const under = (text: string, heading: string): string => {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`no "${heading}" heading`);
  const level = /^#+/.exec(heading)![0].length;
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}} `).test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
};

const ymls = (text: string) => [...text.matchAll(/`([\w.-]+\.ya?ml)`/g)].map((m) => m[1]!);

/** The lanes SECURITY.md accepts: each bullet of the first list under "Which lanes, and what runs" names one. */
function securityLanes(security: string): string[] {
  const lines = under(under(security, '## Accepted exposures'), '### Which lanes, and what runs').split('\n');
  const first = lines.findIndex((l) => l.startsWith('- '));
  const end = lines.findIndex((l, i) => i > first && !l.startsWith('- '));
  return lines.slice(first < 0 ? lines.length : first, end < 0 ? undefined : end).map((l) => {
    const named = ymls(l);
    if (named.length !== 1) throw new Error(`a lane bullet names ${named.length} workflows: ${l}`);
    return named[0]!;
  }).sort();
}

/** The lanes K-AGENT-50's Rule accepts: the workflows its sentence on the accepted exceptions names. */
function ruleLanes(rulebook: string): string[] {
  const rule = under(rulebook, '### `K-AGENT-50` A job that runs the code under test holds no write credential');
  const text = /^\*\*Rule\.\*\*(.*)$/m.exec(rule)?.[1];
  if (!text) throw new Error('K-AGENT-50 has no **Rule.** paragraph');
  const sentence = text.split(/(?<=\.)\s+(?=[A-Z])/).find((s) => /accepted exceptions/.test(s));
  if (!sentence) throw new Error('K-AGENT-50 names no accepted exceptions');
  return ymls(sentence).sort();
}

/** The isolation guard's `ACCEPTED` exceptions, as `file:job`. */
function guardAccepted(guard: string): string[] {
  return [...guard.matchAll(/^\s*'([\w.-]+\.ya?ml):[\w-]+':\s*ACCEPTED,/gm)].map((m) => m[1]!).sort();
}

/** The `agent-*.yml` lanes that run `file`: itself, or each that calls it through `$/`, transitively. */
function lanesOf(file: string, workflows: Readonly<Record<string, string>>): string[] {
  if (/^agent-/.test(file)) return [file];
  const callers = Object.entries(workflows)
    .filter(([, text]) => new RegExp(`uses:\\s*\\$/\\.github/workflows/${file.replace(/\./g, '\\.')}\\s*$`, 'm').test(text))
    .map(([name]) => name);
  return [...new Set(callers.flatMap((c) => (c === file ? [] : lanesOf(c, workflows))))].sort();
}

const WORKFLOW_TEXT = Object.fromEntries(
  readdirSync(join(ROOT, WORKFLOWS)).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, read(`${WORKFLOWS}/${f}`)]),
);
const SECURITY = read('SECURITY.md');
const RULEBOOK = read('rulebook/03-agents.md');
const GUARD = read('tests/unit/pr-code-token-isolation.test.ts');

const guardLanes = (guard: string) => [...new Set(guardAccepted(guard).map((f) => {
  const lanes = lanesOf(f, WORKFLOW_TEXT);
  if (lanes.length !== 1) throw new Error(`${f} is run by ${lanes.length} lanes (${lanes.join(', ')}), not one`);
  return lanes[0]!;
}))].sort();

describe("the lanes K-AGENT-50 accepts are the same in SECURITY.md, the rule and the isolation guard (kanon#801)", () => {
  it('each reads a set that is not empty', () => {
    expect(securityLanes(SECURITY).length).toBeGreaterThan(0);
    expect(ruleLanes(RULEBOOK).length).toBeGreaterThan(0);
    expect(guardAccepted(GUARD).length).toBeGreaterThan(0);
  });

  it('every lane named is a workflow of this tree', () => {
    for (const lane of [...securityLanes(SECURITY), ...ruleLanes(RULEBOOK)]) expect(WORKFLOW_TEXT, lane).toHaveProperty([lane]);
  });

  it('SECURITY.md accepts exactly the lanes the rule lists', () => {
    expect(securityLanes(SECURITY)).toEqual(ruleLanes(RULEBOOK));
  });

  it("the rule lists exactly the lanes of the guard's ACCEPTED jobs", () => {
    expect(ruleLanes(RULEBOOK)).toEqual(guardLanes(GUARD));
  });

  it("maps a called job's file to the one lane that calls it", () => {
    expect(lanesOf('rebase-agent-job.yml', WORKFLOW_TEXT)).toEqual(['agent-rebase.yml']);
    expect(lanesOf('agent-implement-revise.yml', WORKFLOW_TEXT)).toEqual(['agent-implement-revise.yml']);
  });
});

// K-PRIN-11: each drift a change could make turns the parity red.
describe('the parity goes red', () => {
  it('when SECURITY.md drops a lane the rule still lists', () => {
    const bullet = /^- \*\*The rebase lane\*\*.*\n/m;
    expect(SECURITY).toMatch(bullet);
    expect(securityLanes(SECURITY.replace(bullet, ''))).not.toEqual(ruleLanes(RULEBOOK));
  });

  it('when the rule accepts a lane SECURITY.md does not state', () => {
    const named = "and its conflict-resolution lane (`agent-rebase.yml`)";
    expect(RULEBOOK).toContain(named);
    expect(securityLanes(SECURITY)).not.toEqual(ruleLanes(RULEBOOK.replace(named, `${named} and the triage lane (\`agent-triage.yml\`)`)));
  });

  it('when the guard fixes a lane and drops it from ACCEPTED', () => {
    const entry = "  'rebase-agent-job.yml:resolve': ACCEPTED,\n";
    expect(GUARD).toContain(entry);
    expect(guardLanes(GUARD.replace(entry, ''))).not.toEqual(ruleLanes(RULEBOOK));
  });

  it('when the guard accepts a new lane', () => {
    const anchor = "  'rebase-agent-job.yml:resolve': ACCEPTED,\n";
    expect(guardLanes(GUARD.replace(anchor, `${anchor}  'agent-triage.yml:triage-fix': ACCEPTED,\n`))).not.toEqual(ruleLanes(RULEBOOK));
  });
});
