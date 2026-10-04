import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
const {
  declaresMembership, deriveFollowUps, deriveMembership, followUpCandidates, membersOf,
  projectsOfPr, surfacedByPr, DERIVE_DAYS, MIRROR_PER_TICK, joinable,
} = await import('../../scripts/lead-reconcile.mjs');
import { ROOT } from './helpers/adopter.js';
/** A value of the untyped library, as the reference adopter's helper named it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LibraryValue = any;

/**
 * RA-2412 — a reviewer follow-up joins its project because of a check that can be tested:
 * `Surfaced by PR #N review` → PR #N's closing issues / changed brief → exactly one
 * active project → the marker appended as the body's last line.
 */
const FU = ['follow-up', 'agent:reviewer'];
const fu = (number: number, body: string, labels: string[] = FU) =>
  ({ number, state: 'OPEN', labels: labels.map((name) => ({ name })), body });
const worlds = [
  { project: '1015', all: [{ number: 1016 }, { number: 1017 }] },
  { project: '1019', all: [{ number: 1020 }] },
];

describe('surfacedByPr', () => {
  it('reads the one PR a follow-up names', () => {
    expect(surfacedByPr('x\n\nSurfaced by PR #2407 review')).toBe(2407);
    expect(surfacedByPr('Surfaced by PR #2407 review, round 2. Surfaced by PR #2407 review')).toBe(2407);
  });
  it('is null for none, or for two different PRs', () => {
    expect(surfacedByPr('found in PR #2407')).toBeNull();
    expect(surfacedByPr('Surfaced by PR #1 review\nSurfaced by PR #2 review')).toBeNull();
  });
});

describe('followUpCandidates', () => {
  it('keeps open reviewer follow-ups with no marker and one surfacing PR', () => {
    expect(followUpCandidates([fu(1, 'Surfaced by PR #9 review')]).map((i: { number: number }) => i.number)).toEqual([1]);
  });
  it('never touches a body carrying ANY marker, last line or not', () => {
    expect(followUpCandidates([
      fu(1, 'Surfaced by PR #9 review\n\n<!-- qa:project 1015 -->'),
      fu(2, 'Surfaced by PR #9 review\n\n<!-- qa:project 1019 -->\n\nhuman note'),
    ])).toEqual([]);
  });
  it('needs both provenance labels, an open state and a surfacing line', () => {
    expect(followUpCandidates([
      fu(1, 'Surfaced by PR #9 review', ['follow-up']),
      fu(2, 'Surfaced by PR #9 review', ['agent:reviewer']),
      { ...fu(3, 'Surfaced by PR #9 review'), state: 'CLOSED' },
      fu(4, 'no provenance'),
    ])).toEqual([]);
  });
});

describe('projectsOfPr', () => {
  const { memberOf, active } = membersOf(worlds);
  it('a PR closing a member of an active project is that project', () => {
    expect(projectsOfPr({ closes: [1016], files: [] }, memberOf, active)).toEqual([1015]);
  });
  it('a PR changing an active project brief is that project, even closing nothing', () => {
    expect(projectsOfPr({ closes: [], files: ['docs/projects/1019.md', 'src/x.ts'] }, memberOf, active)).toEqual([1019]);
  });
  it('the tracking issue itself counts as its project', () => {
    expect(projectsOfPr({ closes: [1015], files: [] }, memberOf, active)).toEqual([1015]);
  });
  it('an inactive brief, a non-member, or a lookalike path is nothing', () => {
    expect(projectsOfPr({ closes: [42], files: ['docs/projects/999.md', 'docs/projects/1015.md.bak', 'x/docs/projects/1015.md'] }, memberOf, active)).toEqual([]);
  });
  it('two projects are both reported, so the caller can refuse', () => {
    expect(projectsOfPr({ closes: [1016, 1020], files: [] }, memberOf, active).sort()).toEqual([1015, 1019]);
  });
});

describe('deriveMembership', () => {
  const base = membersOf(worlds);
  const prs: Record<number, { closes: number[]; files: string[] } | null> = {
    9: { closes: [1017], files: [] },
    10: { closes: [1016, 1020], files: [] },
    11: null,
    12: { closes: [5], files: [] },
  };
  it('appends exactly-one-project follow-ups and skips ambiguous, unreadable and unrelated ones', () => {
    const plan = deriveMembership(followUpCandidates([
      fu(1, 'Surfaced by PR #9 review'),
      fu(2, 'Surfaced by PR #10 review'),
      fu(3, 'Surfaced by PR #11 review'),
      fu(4, 'Surfaced by PR #12 review'),
    ]), { ...base, prFor: (n: number) => prs[n] });
    expect(plan.append).toEqual([{ number: 1, project: 1015, pr: 9 }]);
    expect(plan).toMatchObject({ capped: 0, unexamined: 0 });
  });
  it('reads each PR once however many follow-ups it surfaced', () => {
    let reads = 0;
    const plan = deriveMembership(followUpCandidates([fu(1, 'Surfaced by PR #9 review'), fu(2, 'Surfaced by PR #9 review')]),
      { ...base, prFor: (n: number) => { reads++; return prs[n]; } });
    expect(reads).toBe(1);
    expect(plan.append.map((a: LibraryValue) => a.number)).toEqual([1, 2]);
  });
  it('caps edits per tick and counts the rest as capped, not unexamined', () => {
    const many = Array.from({ length: 5 }, (_, i) => fu(i + 1, 'Surfaced by PR #9 review'));
    const plan = deriveMembership(followUpCandidates(many), { ...base, prFor: (n: number) => prs[n], cap: 2 });
    expect(plan.append).toHaveLength(2);
    expect(plan.capped).toBe(3);
    expect(plan.unexamined).toBe(0);
  });

  it('reads everything in one tick while the PRs fit the read budget', () => {
    let reads = 0;
    const few = Array.from({ length: 6 }, (_, i) => fu(i + 1, `Surfaced by PR #${100 + i} review`));
    const plan = deriveMembership(followUpCandidates(few), { ...base, prFor: () => { reads++; return null; }, cap: 2, tick: 7 });
    expect(reads).toBe(6);
    expect(plan).toMatchObject({ buckets: 1, unexamined: 0 });
  });

  // THE MEASURED CASE (the Reviewer, RA-2433): 82 distinct surfacing PRs at the default cap,
  // newest first, with the two project-1019 follow-ups well past the 30th.
  describe('over more PRs than the read budget', () => {
    const cap = 10;
    const prNumbers = Array.from({ length: 80 }, (_, i) => 2400 - i * 3);
    const cands = [
      ...prNumbers.map((n, i) => fu(5000 + i, `Surfaced by PR #${n} review`)),
      fu(2163, 'finding\n\nSurfaced by PR #2145 review'),
      fu(1994, 'finding\n\nSurfaced by PR #1991 review'),
    ];
    const proj = membersOf([{ project: '1019', all: [{ number: 1987 }] }]);
    const trace = (n: number) => (n === 2145 ? { closes: [], files: ['docs/projects/1019.md'] }
      : n === 1991 ? { closes: [1987], files: [] } : { closes: [], files: [] });
    const tickOf = (t: number) => {
      const read: number[] = [];
      const plan = deriveMembership(followUpCandidates(cands), { ...proj, cap, tick: t, prFor: (n: number) => { read.push(n); return trace(n); } });
      return { plan, read };
    };

    it('reads a bounded share each tick and covers EVERY PR within `buckets` ticks', () => {
      const first = tickOf(0);
      const k = first.plan.buckets;
      expect(k).toBe(3);
      const seen = new Set<number>();
      for (let t = 0; t < k; t++) {
        const { read } = tickOf(t);
        // Bounded: far fewer than all 82, and no PR read twice in a tick.
        expect(read.length).toBeLessThan(82);
        expect(new Set(read).size).toBe(read.length);
        read.forEach((n) => seen.add(n));
      }
      expect(seen.size).toBe(82);
    });

    it('the two RA-1019 backlog follow-ups get their marker within those ticks', () => {
      const joined = new Map<number, number>();
      for (let t = 100; t < 103; t++) tickOf(t).plan.append.forEach((a: LibraryValue) => joined.set(a.number, a.project));
      expect(joined.get(2163)).toBe(1019);
      expect(joined.get(1994)).toBe(1019);
    });

    it('accounts for every candidate it did not read, per tick', () => {
      const { plan, read } = tickOf(1);
      const readSet = new Set(read);
      const notRead = cands.filter((c) => !readSet.has(surfacedByPr(c.body)!)).length;
      expect(plan.unexamined).toBe(notRead);
      expect(plan.unexamined).toBeGreaterThan(0);
    });

    it('a PR keeps its turn when issues are filed or age out between ticks', () => {
      // An index-based cursor would shift every PR when the newest-first list gains or
      // loses one, and could skip a PR indefinitely. The bucket depends on the number.
      const ticksReading = (list: typeof cands, n: number) => [0, 1, 2].filter((t) => {
        const read: number[] = [];
        deriveMembership(followUpCandidates(list), { ...proj, cap, tick: t, prFor: (x: number) => { read.push(x); return null; } });
        return read.includes(n);
      });
      const shifted = [fu(9001, 'Surfaced by PR #2999 review'), ...cands.slice(1)];
      expect(ticksReading(cands, 1991)).toHaveLength(1);
      expect(ticksReading(shifted, 1991)).toEqual(ticksReading(cands, 1991));
    });
  });

  it('defaults to the label mirror cap and a positive window', () => {
    expect(MIRROR_PER_TICK).toBeGreaterThan(0);
    expect(DERIVE_DAYS).toBe(14);
  });
});

describe('deriveFollowUps (io through one seam)', () => {
  const stub = (bodies: Record<number, string>) => {
    const calls: string[][] = [];
    const run = (a: string[]) => {
      calls.push(a);
      if (a[0] === 'issue' && a[1] === 'list') return JSON.stringify([fu(1, bodies[1]), fu(2, bodies[2])]);
      if (a[0] === 'pr' && a[1] === 'view') return JSON.stringify({ closingIssuesReferences: [{ number: 1016 }], files: [] });
      if (a[0] === 'issue' && a[1] === 'view') return JSON.stringify({ body: bodies[Number(a[2])] });
      return '';
    };
    return { calls, run };
  };
  const edits = (calls: string[][]) => calls.filter((c) => c[0] === 'issue' && c[1] === 'edit');

  it('appends the marker as the LAST line, which is membership', () => {
    const s = stub({ 1: 'finding\n\nSurfaced by PR #9 review\n', 2: 'other\n\nSurfaced by PR #9 review' });
    deriveFollowUps(worlds, { run: s.run, apply: true, now: Date.parse('2026-09-25T00:00:00Z') });
    const e = edits(s.calls);
    expect(e).toHaveLength(2);
    const body = e[0][e[0].indexOf('--body') + 1];
    expect(declaresMembership(body, 1015)).toBe(true);
    expect(body.startsWith('finding\n\nSurfaced by PR #9 review')).toBe(true);
    // It never writes the label — the mirror is that label's only writer.
    expect(s.calls.some((c) => c.includes('--add-label'))).toBe(false);
  });

  it('re-reads before writing, and a marker added since wins', () => {
    const s = stub({ 1: 'Surfaced by PR #9 review', 2: 'Surfaced by PR #9 review' });
    const run = (a: string[]) => (a[0] === 'issue' && a[1] === 'view' && a[2] === '1'
      ? JSON.stringify({ body: 'Surfaced by PR #9 review\n\n<!-- qa:project 1019 -->' })
      : s.run(a));
    deriveFollowUps(worlds, { run, apply: true });
    expect(edits(s.calls).map((c) => c[2])).toEqual(['2']);
  });

  it('writes nothing on a dry run, and nothing with no active project', () => {
    const s = stub({ 1: 'Surfaced by PR #9 review', 2: 'Surfaced by PR #9 review' });
    expect(deriveFollowUps(worlds, { run: s.run, apply: false }).append).toHaveLength(2);
    expect(edits(s.calls)).toEqual([]);
    const t = stub({});
    expect(deriveFollowUps([], { run: t.run, apply: true }).append).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it('lists only recent open reviewer follow-ups', () => {
    const s = stub({ 1: '', 2: '' });
    deriveFollowUps(worlds, { run: s.run, apply: false, now: Date.parse('2026-09-25T00:00:00Z'), days: 14 });
    const list = s.calls[0].join(' ');
    expect(list).toContain('--label follow-up --label agent:reviewer');
    expect(list).toContain('--state open');
    expect(list).toContain('created:>=2026-09-11');
  });

  it('rotates by the tick hour, and the report never promises "next tick"', () => {
    const list = Array.from({ length: 40 }, (_, i) => fu(i + 1, `Surfaced by PR #${200 + i} review`));
    const reads = (hour: number) => {
      const r: string[] = [];
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      deriveFollowUps(worlds, {
        apply: false, now: hour * 3_600_000,
        run: (a: string[]) => {
          if (a[1] === 'list') return JSON.stringify(list);
          r.push(a[2]);
          return JSON.stringify({ closingIssuesReferences: [], files: [] });
        },
      });
      const out = log.mock.calls.flat().join('\n');
      log.mockRestore();
      return { r, out };
    };
    const a = reads(1000);
    const b = reads(1001);
    expect(a.r.length + b.r.length).toBe(40);
    expect(a.r.filter((n) => b.r.includes(n))).toEqual([]);
    expect(a.out).toMatch(/not examined this tick: their surfacing PRs are in the other 1 bucket\(s\) of 2/);
    expect(a.out).not.toMatch(/next tick/);
  });

  it('a failed list or edit never throws out of the tick', () => {
    expect(() => deriveFollowUps(worlds, { run: () => { throw new Error('403'); }, apply: true })).not.toThrow();
  });
});

describe('main runs the derivation after every project, and only over all of them', () => {
  it('is wired after reconcileAll, gated on no failures and the full scope', () => {
    // Static: `main` is the CLI entry and shells `gh`.
    const src = readFileSync(join(ROOT, 'scripts/lead-reconcile.mjs'), 'utf8');
    const main = src.slice(src.indexOf('function main() {'));
    expect(main).toContain('const { decisions, failures, worlds } = reconcileAll(projects, { evidenceOf: makeRetryEvidenceReader({ json: ghJson }) });');
    expect(main).toContain("if (!failures.length && process.env.QA_LEAD_SCOPE === 'all') deriveFollowUps(worlds);");
  });

  it('the workflow says `all` only when no project was named', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/agent-lead-reconcile.yml'), 'utf8');
    expect(wf).toContain("QA_LEAD_SCOPE: ${{ !inputs.project && 'all' || 'narrowed' }}");
  });

  it('a project this tick closed, or found closed, is not joinable', () => {
    expect(joinable({ trackingClosed: false }, { actions: [{ kind: 'dispatch' }] })).toBe(true);
    expect(joinable({}, { actions: [] })).toBe(true);
    expect(joinable({ trackingClosed: true }, { actions: [] })).toBe(false);
    expect(joinable({ trackingClosed: false }, { actions: [{ kind: 'close-project' }] })).toBe(false);
    const src = readFileSync(join(ROOT, 'scripts/lead-reconcile.mjs'), 'utf8');
    expect(src).toContain('if (joinable(world, decision)) worlds.push(world);');
  });
});
