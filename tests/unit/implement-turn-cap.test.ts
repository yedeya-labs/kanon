import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * RA-2207 — the implement lane's turn cap, and the two lanes agreeing on it.
 *
 * WHY A TEST AND NOT JUST A NUMBER. The cap was raised 150 → 300 because both
 * halves of project RA-1019's Issue C2 exhausted 150 and produced nothing — RA-1694
 * (contract) three times, RA-2167 (C1B, expand) once, and C1B is purely additive,
 * so the seam was not the problem. A bare number in two workflow files invites
 * the next reader to "tidy" one of them back down, and the failure that produces
 * is invisible: a capped run looks like an ordinary red, and the lane that still
 * reads 150 is the one nobody re-reads.
 *
 * THE TWO LANES MUST AGREE, which is the half a single-file check would miss. A
 * revise round on an issue whose first round needed >150 turns needs comparable
 * headroom; leaving `agent-implement-revise.yml` behind would move the same stall
 * one step later, onto the round that already has a PR to lose.
 *
 * KANON HOLDS THE REVISE LANE (plan 0001, step 2); the implement lane is still the reference
 * adopter's until step 3. So this pins the revise lane's half, and the adopter's copy of this
 * test holds the two to each other against a checkout of Kanon at the pinned tag.
 *
 * ⚠️ 300 IS HEADROOM, NOT A MEASURED REQUIREMENT — runs die AT the cap, so the
 * distance to completion is unobserved. This test pins what was agreed; it does
 * not claim 300 is sufficient. If a run caps at 300, RA-1781's decomposition path
 * is the answer, not 600.
 */
const read = (f: string) => readFileSync(join(process.cwd(), '.github/workflows', f), 'utf8');

const LANES = ['agent-implement-revise.yml'] as const;
const EXPECTED_CAP = 300;

/** Every `--max-turns N` the file passes to `claude_args`, as numbers. */
const caps = (text: string): number[] =>
  [...text.matchAll(/^\s*--max-turns\s+(\d+)\s*$/gm)].map((m) => Number(m[1]));

describe('RA-2207 — the implement lane turn cap', () => {
  it.each(LANES)('%s passes --max-turns at all, so the regex is not measuring its own typo', (lane) => {
    // Guards the guard: if `claude_args` is ever restructured so the flag stops
    // matching, every assertion below would pass vacuously over an empty array.
    expect(caps(read(lane)).length).toBeGreaterThan(0);
  });

  it.each(LANES)('%s sets every --max-turns to the agreed cap', (lane) => {
    for (const n of caps(read(lane))) expect(n).toBe(EXPECTED_CAP);
  });

  /**
   * BOTH LANES, not just the first (RA-2230). This suite's own docstring says the two lanes
   * must agree because "the lane that still reads 150 is the one nobody re-reads" — and
   * this assertion, the one protecting the REASON rather than the number, covered one
   * lane. The unguarded half was exactly the lane the suite says nobody re-reads, so the
   * rationale could have been tidied out of `agent-implement-revise.yml` with the cap
   * left in place and every check green.
   */
  it.each(LANES)('%s records WHY the number is what it is, so it is not tidied back down', (lane) => {
    const text = read(lane);
    // Anchored to the cap's own comment block rather than the whole file, so this
    // cannot be satisfied by the digits appearing somewhere unrelated.
    const anchor = text.indexOf('# TURN CAP — 300 since RA-2207');
    expect(anchor, `${lane}: the cap comment block moved or was reworded — re-anchor this test`).toBeGreaterThan(-1);
    const block = text.slice(anchor, anchor + 1800);
    expect(block, lane).toMatch(/A CAP IS A CEILING, NOT SPEND/);
    expect(block, lane).toMatch(/RA-1781/);
    expect(block, lane).toMatch(/HEADROOM, NOT A MEASURED REQUIREMENT/);
  });
});

/**
 * RA-2249 — the WALL-CLOCK CEILING the cap's whole argument depends on (RA-2212): the cap must
 * be what binds, so an exhausted run is the legible `max_turns` outcome rather than a
 * quieter death on the job timeout. Nothing read a `timeout-minutes` anywhere, and both
 * drift directions were silent: dropping the `with:` line falls back to the spine's
 * `default: 120`, and before the revise lane was converted (RA-2592) dropping its job key
 * fell back to Actions' 360m (the RA-1336 shape).
 *
 * Both lanes now pass it to the spine as a `with:` input. Each is still read from the
 * parsed YAML at its own path, not by one regex over both files.
 *
 * THE SPINE'S DEFAULT IS NOT PINNED: a future lane may legitimately want it. What is
 * pinned instead is that no spine CALLER relies on it silently — every caller passes the
 * input explicitly — so the default stays dead until someone chooses it.
 */
const EXPECTED_CEILING = 180;
const yaml = (f: string) => parse(read(f)) as { jobs: Record<string, Record<string, unknown> & { with?: Record<string, unknown>; uses?: string }> };
const ceilingOf: Record<(typeof LANES)[number], () => unknown> = {
  'agent-implement-revise.yml': () => yaml('agent-implement-revise.yml').jobs.revise?.with?.['timeout-minutes'],
};
const RATIONALE: Record<(typeof LANES)[number], { anchor: string; says: RegExp[] }> = {
  // Why it matches the first lane: one cap, one ceiling.
  'agent-implement-revise.yml': { anchor: '# WALL-CLOCK CEILING — 180 since RA-2212', says: [/matching `agent-implement\.yml`/, /turn cap/] },
};

describe('RA-2249 — the implement lanes wall-clock ceiling', () => {
  it.each(LANES)('%s resolves its ceiling to the agreed value', (lane) => {
    expect(ceilingOf[lane](), `${lane}: ceiling missing or changed`).toBe(EXPECTED_CEILING);
  });

  it.each(LANES)('%s records WHY its ceiling is what it is', (lane) => {
    const text = read(lane);
    const anchor = text.indexOf(RATIONALE[lane].anchor);
    expect(anchor, `${lane}: the ceiling's comment block moved or was reworded — re-anchor this test`).toBeGreaterThan(-1);
    // The rationale must sit directly above the value it explains (within its block).
    const block = text.slice(anchor, text.indexOf('timeout-minutes: 180', anchor) + 1);
    expect(block.length, `${lane}: no ceiling follows its rationale`).toBeGreaterThan(1);
    for (const re of RATIONALE[lane].says) expect(block, lane).toMatch(re);
  });

  it('no spine caller falls back to the default silently', () => {
    const callers = readdirSync(join(process.cwd(), '.github/workflows'))
      .filter((f) => f.endsWith('.yml'))
      .flatMap((f) => Object.entries(yaml(f).jobs ?? {}).map(([job, def]) => ({ where: `${f}:${job}`, def })))
      .filter(({ def }) => typeof def.uses === 'string' && def.uses.endsWith('/agent-lane.yml'));
    expect(callers.map((c) => c.where)).toEqual(expect.arrayContaining(['agent-triage.yml:triage-fix', 'agent-implement-revise.yml:revise', 'agent-lead-revise.yml:revise']));
    const silent = callers.filter(({ def }) => def.with?.['timeout-minutes'] === undefined).map((c) => c.where);
    expect(silent, 'these callers inherit the spine default — pass timeout-minutes explicitly').toEqual([]);
  });
});
