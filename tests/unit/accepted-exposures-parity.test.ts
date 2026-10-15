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
 *
 * kanon#926: a lane's `notify` job is a third exposure, admitted outside that sentence, in
 * `K-AGENT-50`'s **Enforced by**, and accepted in `K-OBS-19`'s **Rule**: it runs the adopter's
 * notify hook at the run's commit on any branch, beside one chat secret. While the rulebook
 * accepts it, SECURITY.md states it in a subsection of its own (what the job holds, who can
 * reach it, what bounds it), and the sentence after "What bounds it", that every other lane
 * runs the project's code without a write credential or from reviewed code, names the
 * `notify` job as its exception.
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

const NOTIFY_HEADING = "### The `notify` job's chat secret";
const NOTIFY_ANCHOR = '#the-notify-jobs-chat-secret';

/** Whether the rulebook accepts the `notify` job's exposure: `K-AGENT-50`'s guard list or `K-OBS-19`'s Rule says so. */
function ruleAcceptsNotify(agents: string, obs: string): boolean {
  const rule = under(agents, '### `K-AGENT-50` A job that runs the code under test holds no write credential');
  const enforced = /^\*\*Enforced by\.\*\*(.*)$/m.exec(rule)?.[1];
  if (!enforced) throw new Error('K-AGENT-50 has no **Enforced by.** paragraph');
  const obs19 = obs.split('\n').find((l) => l.startsWith('### `K-OBS-19` '));
  const accepted = obs19 !== undefined && /That exposure is accepted/.test(under(obs, obs19));
  return /the `notify` job of `K-OBS-19`/.test(enforced) || accepted;
}

/** What SECURITY.md leaves unsaid about the `notify` job's exposure; empty when it says all of it. */
function notifyProblems(security: string): string[] {
  const accepted = under(security, '## Accepted exposures');
  const problems: string[] = [];
  const exception = under(accepted, '### What bounds it').split('\n').find((l) => l.startsWith('Every other lane that runs your project'));
  if (!exception || !/`notify` job/.test(exception) || !exception.includes(`](${NOTIFY_ANCHOR})`)) {
    problems.push('the "Every other lane" sentence under "What bounds it" does not name the `notify` job as its exception, linked to its subsection');
  }
  if (!accepted.split('\n').includes(NOTIFY_HEADING)) return [...problems, `no "${NOTIFY_HEADING}" subsection`];
  const sub = under(accepted, NOTIFY_HEADING);
  const needs: [string, RegExp][] = [
    ['the rule it cites', /\[`K-OBS-19`\]\(rulebook\/08-observability-and-cost\.md\)/],
    ['the hook it runs, on any branch', /`\.\/\.github\/actions\/notify`[^\n]*whatever branch/],
    ['what it holds: one chat secret and a read-only token', /\*\*What it holds\.\*\* One message kind's chat secret[^\n]*reads contents and nothing more/],
    ['who can reach it', /\*\*Who can reach it\.\*\* Anyone who can push a branch and dispatch a notifying lane/],
    ['what bounds it: no App key, no Claude credential', /\*\*What bounds it\.\*\* The job holds no App key[^\n]*no Claude credential[^\n]*nothing more/],
    ['where the topic doc says it in full', /\]\(docs\/notifications\.md#security\)/],
  ];
  for (const [what, re] of needs) if (!re.test(sub)) problems.push(`"${NOTIFY_HEADING}" does not state ${what}`);
  return problems;
}

const WORKFLOW_TEXT = Object.fromEntries(
  readdirSync(join(ROOT, WORKFLOWS)).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, read(`${WORKFLOWS}/${f}`)]),
);
const SECURITY = read('SECURITY.md');
const RULEBOOK = read('rulebook/03-agents.md');
const GUARD = read('tests/unit/pr-code-token-isolation.test.ts');
const OBS = read('rulebook/08-observability-and-cost.md');

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

describe("SECURITY.md states the `notify` job's exposure while the rulebook accepts it (kanon#926)", () => {
  it('the rulebook accepts it, so the check below is not vacuous', () => {
    expect(ruleAcceptsNotify(RULEBOOK, OBS)).toBe(true);
  });

  it('SECURITY.md says what the job holds, who can reach it and what bounds it, and names it as the exception', () => {
    expect(ruleAcceptsNotify(RULEBOOK, OBS) ? notifyProblems(SECURITY) : []).toEqual([]);
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

  it("when SECURITY.md drops the `notify` job's subsection", () => {
    const lines = SECURITY.split('\n');
    const start = lines.indexOf(NOTIFY_HEADING);
    expect(start).toBeGreaterThan(0);
    const end = lines.findIndex((l, i) => i > start && /^#{1,3} /.test(l));
    const dropped = [...lines.slice(0, start), ...(end < 0 ? [] : lines.slice(end))].join('\n');
    expect(notifyProblems(dropped)).toContain(`no "${NOTIFY_HEADING}" subsection`);
  });

  it('when the "Every other lane" sentence stops naming the `notify` job as its exception', () => {
    const clause = /, with one stated exception: a lane's `notify` job[^\n]*?\)\)\./;
    expect(SECURITY).toMatch(clause);
    expect(notifyProblems(SECURITY.replace(clause, '.'))).toHaveLength(1);
  });

  it('when the subsection stops saying what bounds it', () => {
    const bounds = 'no App key or App token, no Claude credential';
    expect(SECURITY).toContain(bounds);
    expect(notifyProblems(SECURITY.replace(bounds, 'an App token'))).toHaveLength(1);
  });

  it('when the guard accepts a new lane', () => {
    const anchor = "  'rebase-agent-job.yml:resolve': ACCEPTED,\n";
    expect(guardLanes(GUARD.replace(anchor, `${anchor}  'agent-triage.yml:triage-fix': ACCEPTED,\n`))).not.toEqual(ruleLanes(RULEBOOK));
  });
});
