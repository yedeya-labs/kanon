import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// kanon#576: a rule that says how it is enforced "until" a step or an issue keeps saying it after
// the step ships, and then its **Enforced by** line describes a Kanon that no longer exists.
// This holds the documents that describe today's Kanon (the rulebook, the README, the roadmap
// and the docs beside them) to having no temporary clause whose condition is already met.
// ADRs and plans are left out: they record what was true when they were written, and an ADR
// amends itself with a dated amendment rather than by losing a sentence (ADR 0011).
//
// The two lists below are what has happened. When a step of plan 0005 ships or an issue a rule
// waits on closes, add it here, and the clauses that waited on it fail by name.

// Plan 0005's steps that have shipped. L5 ran through L11's skills, which come after L7 to L10
// in its order of moves; L6 and M2 have not run.
const SHIPPED_STEPS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L7', 'L8', 'L9', 'L10', 'L11'];
// Kanon issues a clause waited on, now closed: #274 (an agent could reach an App key through the
// action cache), whose last jobs #279 closed.
const CLOSED_ISSUES = ['274', '279'];

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n');
const current = tracked.filter((f) =>
  /^(README|ROADMAP)\.md$/.test(f) || /^rulebook\/[^/]+\.(md|json)$/.test(f) || /^docs\/(qa\/)?[^/]+\.md$/.test(f));

// "until step L4", "Until the release that completes step L4", "until its step L2", "until L5".
const UNTIL_STEP = /\buntil (?:the release that completes )?(?:its )?(?:step )?(L\d+)\b/gi;
// "until kanon#274 is fixed", "until #279 closes".
const UNTIL_ISSUE = /\buntil (?:kanon)?#(\d+) (?:is fixed|is closed|closes)\b/gi;

function expired(text: string): string[] {
  const hits: string[] = [];
  for (const [clause, step = ''] of text.matchAll(UNTIL_STEP)) if (SHIPPED_STEPS.includes(step.toUpperCase())) hits.push(clause);
  for (const [clause, issue = ''] of text.matchAll(UNTIL_ISSUE)) if (CLOSED_ISSUES.includes(issue)) hits.push(clause);
  return hits;
}

describe('no current document keeps a temporary clause whose condition is met (kanon#576)', () => {
  it('reads the rulebook, the README and the roadmap, so the check is not vacuous', () => {
    for (const f of ['README.md', 'ROADMAP.md', 'rulebook/00-principles.md', 'rulebook/03-agents.md', 'rulebook/agent-permissions.json']) {
      expect(current).toContain(f);
    }
  });

  it('finds the clause shapes it looks for', () => {
    expect(expired('Until the release that completes step L4 of plan 0005, the lanes')).toEqual(['Until the release that completes step L4']);
    expect(expired('until its step L2, `kanon apps` needs an organisation')).toEqual(['until its step L2']);
    expect(expired('Until kanon#274 is fixed, an agent')).toEqual(['Until kanon#274 is fixed']);
    expect(expired('until L6, what bounds the cost is weaker; until #500 closes')).toEqual([]);
  });

  it('no clause waits on a shipped step of plan 0005 or a closed issue', () => {
    const hits = current.flatMap((f) => expired(readFileSync(f, 'utf8')).map((h) => `${f}: ${h}`));
    expect(hits).toEqual([]);
  });
});

describe('the README and the roadmap say what ships today (kanon#576)', () => {
  it('link no ADR that is wholly superseded, but the one that supersedes it', () => {
    const stale: string[] = [];
    for (const f of ['README.md', 'ROADMAP.md']) {
      for (const [, adr] of readFileSync(f, 'utf8').matchAll(/\(docs\/decisions\/(\d{4}-[^)#]+\.md)/g)) {
        const status = /^- \*\*Status:\*\*(.*)$/m.exec(readFileSync(`docs/decisions/${adr}`, 'utf8'))?.[1] ?? '';
        if (/^\s*superseded\b/i.test(status)) stale.push(`${f}: ${adr}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('says no lane is still being extracted, since every lane of docs/lanes.md ships', () => {
    const lanes = [...readFileSync('docs/lanes.md', 'utf8').matchAll(/^\| [^|]+ \| `(agent-[a-z-]+\.yml)` \|/gm)].map((m) => m[1]);
    expect(lanes).toContain('agent-merge.yml');
    for (const lane of lanes) expect(tracked).toContain(`.github/workflows/${lane}`);
    expect(readFileSync('README.md', 'utf8').split('\n').filter((l) => /being extracted/i.test(l))).toEqual([]);
  });
});
