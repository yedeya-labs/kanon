import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { LANES } from '../../infra/telemetry/function/schema.mjs';
import { TTL_ATTRIBUTES, declaresPin, pinnedLanes, render, summarize, ttlSplit } from '../../scripts/lib/cache-ttl.mjs';

/**
 * The detector that says whether any lane's run fell back to the five-minute prompt-cache TTL
 * (`cache-ttl.md`), moved from the reference adopter (RA-1899) with its tests, and plan 0002 §6's
 * changes for the hosted store (kanon#470): an arm is a lane, the lanes Kanon pins to 5m are read
 * from Kanon's own lane definitions, and only `tag: run` rows count. The pinned arms' health
 * check stayed behind with the cutover ledger that dated each pin, and came back with
 * `prompt_cache_ttl` (#546): a run row records the TTL its run was pinned at, so a pin is
 * judged on the rows that say they ran under it, and needs no date.
 *
 * The ONE thing that makes this check non-obvious is an absence: older rows lack
 * `cache_write_5m_tokens`, so for those the five-minute share is a SUBTRACTION
 * (`cache_write_tokens - cache_write_1h_tokens`). These fixtures omit the `_5m` field, as such
 * rows do; the breakdown cases add it where they test it.
 *
 * The pinned set each CASE describes is passed explicitly, so each case is a statement about the
 * classifier, not about today's workflows; `pinnedLanes`' agreement with them is asserted below.
 */
const NO_PINS = new Set<string>();
const DAYS = 14;

const row = (sk: string, total?: number, oneHour?: number) => ({
  sk: { S: sk },
  tag: { S: 'run' },
  ...(total === undefined ? {} : { cache_write_tokens: { N: String(total) } }),
  ...(oneHour === undefined ? {} : { cache_write_1h_tokens: { N: String(oneHour) } }),
});

describe('spotting a five-minute cache write', () => {
  it('reads a clean fleet as clean: every write at the 1h TTL', () => {
    const s = summarize([{ lane: 'review', items: [row('a', 1000, 1000), row('b', 500, 500)] }], NO_PINS);
    expect(s).toMatchObject({ examined: 2, offenders: [] });
  });

  it('flags a row whose 1h write is short of its total', () => {
    const s = summarize([{ lane: 'review', items: [row('a', 1000, 400)] }], NO_PINS);
    expect(s.offenders).toEqual([{ lane: 'review', share: 0.6 }]);
  });

  it('treats a MISSING 1h field as entirely 5m, not as clean', () => {
    const s = summarize([{ lane: 'code-audit', items: [row('a', 800)] }], NO_PINS);
    expect(s.offenders).toEqual([{ lane: 'code-audit', share: 1 }]);
  });

  it('skips rows with no cache write instead of counting them as clean', () => {
    const s = summarize([{ lane: 'lead', items: [row('a'), row('b', 0, 0), row('c', 100, 100)] }], NO_PINS);
    expect(s).toMatchObject({ examined: 1, skipped: 2, offenders: [] });
  });

  it('counts only real runs: a smoke or test row is never judged (plan 0002 §2.4)', () => {
    const smoke = { ...row('a', 100, 0), tag: { S: 'smoke' } };
    expect(summarize([{ lane: 'review', items: [smoke] }], NO_PINS)).toMatchObject({ examined: 0, offenders: [] });
  });

  it('projects the store to the fields it reads, and the tag', () => {
    expect([...TTL_ATTRIBUTES].sort()).toEqual([
      'cache_write_1h_tokens', 'cache_write_5m_tokens', 'cache_write_tokens', 'duration_api_ms', 'duration_ms', 'outcome',
      'prompt_cache_ttl', 'sk', 'tag',
    ]);
  });
});

describe('the lines the Overseer pastes into its audit', () => {
  it('states the denominator and the window on a clean result, so looking is distinguishable from finding', () => {
    const line = render(summarize([{ lane: 'review', items: [row('a', 10, 10)] }], NO_PINS), DAYS);
    expect(line).toMatch(/0 of 1 row\(s\) across 1 lane partition\(s\) over the last 14 days/);
    expect(line).toMatch(/no pin needed/);
  });

  it('never renders an empty read as clean', () => {
    const line = render(summarize([{ lane: 'review', items: [row('a')] }], NO_PINS), DAYS);
    expect(line).toMatch(/UNAVAILABLE, not as clean/);
    expect(line).not.toMatch(/no pin needed/);
  });

  it('carries the remedy AND the version trap when it fires', () => {
    const line = render(summarize([{ lane: 'review', items: [row('a', 100, 10)] }], NO_PINS), DAYS);
    expect(line).toMatch(/CLAUDE_CODE_PROMPT_CACHE_TTL=1h/);
    expect(line).toMatch(/`prompt-cache-ttl` input of `actions\/agent-run`/);
    expect(line).toMatch(/v2\.1\.242/);
    expect(line).toMatch(/IGNORED RATHER THAN REJECTED/);
  });

  it('names every AFFECTED LANE once, not the first five offending rows', () => {
    const nine = Array.from({ length: 9 }, (_, i) => row(`r${i}`, 100, 0));
    const line = render(summarize([
      { lane: 'code-audit', items: nine },
      { lane: 'review', items: [row('x', 100, 50)] },
      { lane: 'triage', items: [row('y', 100, 0)] },
    ], NO_PINS), DAYS);
    expect(line).toMatch(/11 of 11 row\(s\)/);
    expect(line).toMatch(/on 3 lane\(s\): code-audit 9 row\(s\), up to 100% at 5m; review 1 row\(s\), up to 50% at 5m; triage 1 row\(s\)/);
    expect(line).not.toMatch(/r\d/);
  });

  it('prefixes every finding line, and says what it did not check', () => {
    for (const items of [[row('a', 10, 10)], [row('a', 100, 0)], [row('a')]]) {
      const lines = render(summarize([{ lane: 'review', items }], NO_PINS), DAYS).split('\n');
      expect(lines[0]).toMatch(/^cache-ttl: /);
      expect(lines.at(-1)).toMatch(/^cache-ttl: the pinned lanes' own health .* is NOT checked: no row .* records a pin/);
    }
  });
});

describe('what the line could not read', () => {
  it('names an unreadable partition on the line, and never calls the result clean', () => {
    const line = render(summarize([{ lane: 'review', items: [row('a', 10, 10)] }], NO_PINS, ['code-audit']), DAYS);
    expect(line).toMatch(/1 partition\(s\) were UNREADABLE \(code-audit\), so this is PARTIAL, not clean\./);
    expect(line).not.toMatch(/no pin needed/);
    expect(line).toMatch(/0 of 1 row\(s\) across 1 lane partition\(s\) over the last 14 days were written/);
  });

  it('keeps the offender sentence whole when a partition is also unreadable', () => {
    const line = render(summarize([{ lane: 'review', items: [row('a', 100, 0)] }], NO_PINS, ['code-audit']), DAYS);
    expect(line).toMatch(/1 of 1 row\(s\) across 1 lane partition\(s\) over the last 14 days were written at the 5-minute TTL/);
    expect(line).toMatch(/UNREADABLE \(code-audit\)/);
  });

  it('still says PARTIAL when every read partition is empty', () => {
    const line = render(summarize([{ lane: 'review', items: [row('a')] }], NO_PINS, ['code-audit']), DAYS);
    expect(line).toMatch(/UNREADABLE \(code-audit\)/);
    expect(line).toMatch(/UNAVAILABLE/);
  });

  it('does not call a write with NO TTL breakdown a five-minute write', () => {
    const noBreakdown = { ...row('a', 100, 0), cache_write_5m_tokens: { N: '0' } };
    const s = summarize([{ lane: 'review', items: [noBreakdown] }], NO_PINS);
    expect(s.offenders).toEqual([]);
    expect(s.unbroken).toBe(1);
    const line = render(s, DAYS);
    expect(line).toMatch(/1 row\(s\) wrote cache but reported NO TTL breakdown/);
    expect(line).toMatch(/UNAVAILABLE/);
  });

  it('still fires on a row whose 5m field says it really wrote at 5m', () => {
    const real = { ...row('a', 100, 0), cache_write_5m_tokens: { N: '100' } };
    expect(summarize([{ lane: 'review', items: [real] }], NO_PINS).offenders).toHaveLength(1);
    expect(ttlSplit(real)).toEqual({ kind: 'judged', share: 1 });
  });

  it('trusts the 5m field over the subtraction where the row carries it', () => {
    const partial = { ...row('a', 100, 90), cache_write_5m_tokens: { N: '0' } };
    expect(summarize([{ lane: 'review', items: [partial] }], NO_PINS).offenders).toEqual([]);
  });
});

describe('a deliberate pin is the setting working, not a finding', () => {
  it('does not fire on a pinned lane writing 100% of its cache at 5m', () => {
    const s = summarize([{ lane: 'review', items: [row('a', 100, 0), row('b', 100, 0)] }], new Set(['review']));
    expect(s.offenders).toEqual([]);
    expect(s.expected).toHaveLength(2);
    const line = render(s, DAYS);
    expect(line).toMatch(/0 of 2 row\(s\)/);
    expect(line).toMatch(/BY DESIGN/);
    expect(line).not.toMatch(/REMEDY/);
  });

  it('still fires on an UNPINNED lane, even while a pinned lane is at 5m in the same read', () => {
    const s = summarize([
      { lane: 'implement', items: [row('a', 100, 0)] },
      { lane: 'review', items: [row('b', 100, 0)] },
    ], new Set(['review']));
    expect(s.offenders).toEqual([{ lane: 'implement', share: 1 }]);
    const line = render(s, DAYS);
    expect(line).toMatch(/on 1 lane\(s\): implement 1 row\(s\)/);
    expect(line).not.toMatch(/review \d+ row\(s\), up to/);
    expect(line).toMatch(/REMEDY/);
  });

  it('renders the by-design rows as a SUBSET of the denominator, not an addition to it', () => {
    const items = Array.from({ length: 4 }, (_, i) => row(`r${i}`, 100, 0));
    const line = render(summarize([{ lane: 'review', items }], new Set(['review'])), DAYS);
    expect(line).toMatch(/0 of 4 row\(s\)/);
    expect(line).toMatch(/Of those 4 row\(s\), 4 /);
    expect(line).not.toMatch(/further row/);
  });

  it("says the fallback's cause applies to the lanes that do NOT pin, so the remedy is not 'revert the pin'", () => {
    const line = render(summarize([{ lane: 'implement', items: [row('a', 100, 0)] }], new Set(['review'])), DAYS);
    expect(line).toMatch(/do NOT pin the TTL/);
  });
});

describe("a pinned lane's own health, from the rows that record their pin (#546)", () => {
  /** A row that records the TTL it ran at, with its 1h and 5m writes and its two durations. */
  const pinned = (ttl: string, oneHour: number, fiveMin: number, durationMs?: number, apiMs?: number) => ({
    ...row('p', oneHour + fiveMin, oneHour),
    cache_write_5m_tokens: { N: String(fiveMin) },
    prompt_cache_ttl: { S: ttl },
    ...(durationMs === undefined ? {} : { duration_ms: { N: String(durationMs) } }),
    ...(apiMs === undefined ? {} : { duration_api_ms: { N: String(apiMs) } }),
  });

  it('says a pin took effect when every row that records it wrote at its TTL, and what the runs idled', () => {
    const s = summarize([{ lane: 'review', items: [pinned('5m', 0, 100, 200_000, 150_000), pinned('5m', 0, 50, 90_000, 80_000)] }], new Set(['review']));
    expect(s.pins).toEqual([{ lane: 'review', ttl: '5m', rows: 2, judged: 2, missed: 0, idleKnown: 2, idleOver: 0, maxIdleMs: 50_000 }]);
    const line = render(s, DAYS);
    expect(line).toMatch(/^cache-ttl: pin health, from the 2 row\(s\) that record the TTL they ran at: review \(5m\) 2 row\(s\): the pin took effect on 2 of 2 judged; 0 of 2 with a known idle time idled over 300s in total \(the longest, 50s\)\.$/m);
    expect(line).not.toMatch(/NOT checked/);
    expect(line).not.toMatch(/PIN NOT TAKING EFFECT|IDLE PAST/);
  });

  it('names a pin that did NOT take effect: a row that records 5m and still wrote at 1h', () => {
    const s = summarize([{ lane: 'review', items: [pinned('5m', 100, 0), pinned('5m', 0, 100)] }], new Set(['review']));
    expect(s.pins[0]).toMatchObject({ rows: 2, judged: 2, missed: 1 });
    // Still no offender: the lane pinned 5m, so its 5m write is the setting working.
    expect(s.offenders).toEqual([]);
    const line = render(s, DAYS);
    expect(line).toMatch(/the pin took effect on 1 of 2 judged/);
    expect(line).toMatch(/PIN NOT TAKING EFFECT on review \(5m\)/);
    expect(line).toMatch(/v2\.1\.242/);
  });

  it('names a 5m pin whose runs idled past 300s in total, and says that is an upper bound, not a gap', () => {
    const s = summarize([{ lane: 'explore', items: [pinned('5m', 0, 100, 900_000, 400_000), pinned('5m', 0, 100, 60_000, 50_000)] }], new Set(['explore']));
    expect(s.pins[0]).toMatchObject({ idleKnown: 2, idleOver: 1, maxIdleMs: 500_000 });
    const line = render(s, DAYS);
    expect(line).toMatch(/1 of 2 with a known idle time idled over 300s in total \(the longest, 500s\)/);
    expect(line).toMatch(/IDLE PAST THE 5-MINUTE TTL on explore/);
    expect(line).toMatch(/upper bound/);
  });

  it('never counts a run with no API time as idle: an unknown idle is not a measured one', () => {
    const s = summarize([{ lane: 'review', items: [pinned('5m', 0, 100, 900_000)] }], new Set(['review']));
    expect(s.pins[0]).toMatchObject({ rows: 1, idleKnown: 0, idleOver: 0 });
    expect(render(s, DAYS)).toMatch(/0 of 0 with a known idle time/);
  });

  it("trusts the row's own pin over Kanon's lane definitions, both ways", () => {
    // Recorded `default` on a lane the definitions pin: its 5m write is the unintended fallback.
    const unpinned = { ...pinned('default', 0, 100) };
    expect(summarize([{ lane: 'review', items: [unpinned] }], new Set(['review'])).offenders).toEqual([{ lane: 'review', share: 1 }]);
    // Recorded `5m` on a lane they don't: its 5m write is the setting working.
    const s = summarize([{ lane: 'implement', items: [pinned('5m', 0, 100)] }], NO_PINS);
    expect(s.offenders).toEqual([]);
    expect(s.expected).toEqual([{ lane: 'implement', share: 1 }]);
    expect(render(s, DAYS)).toMatch(/BY DESIGN on the lane\(s\) that pin it, implement/);
  });

  it('calls a 1h pin that wrote at 5m a pin not taking effect, never the unpinned fallback', () => {
    const s = summarize([{ lane: 'implement', items: [pinned('1h', 0, 100)] }], NO_PINS);
    expect(s.offenders).toEqual([]);
    expect(s.pins).toEqual([expect.objectContaining({ lane: 'implement', ttl: '1h', judged: 1, missed: 1 })]);
    const line = render(s, DAYS);
    expect(line).toMatch(/PIN NOT TAKING EFFECT on implement \(1h\)/);
    // The idle check is a 5-minute pin's question only.
    expect(line).not.toMatch(/idle/);
  });

  it('judges no pin on a row with no TTL breakdown, and still reads its idle time', () => {
    const s = summarize([{ lane: 'review', items: [pinned('5m', 0, 0, 400_000, 0)] }], new Set(['review']));
    expect(s.pins[0]).toMatchObject({ rows: 1, judged: 0, missed: 0, idleKnown: 1, idleOver: 1 });
  });

  it('says how many rows on a pinned lane predate the field, which are counted by design and unchecked', () => {
    const s = summarize([{ lane: 'review', items: [row('a', 100, 0), pinned('5m', 0, 100)] }], new Set(['review']));
    expect(s.unrecorded).toBe(1);
    expect(render(s, DAYS)).toMatch(/1 row\(s\) on the lane\(s\) Kanon pins don't record their pin \(written before run row version 3\), so they are counted by design and not checked\./);
  });

  it('says no pin was checked when the only rows that record their TTL record none', () => {
    const s = summarize([{ lane: 'implement', items: [pinned('default', 100, 0)] }], NO_PINS);
    expect(s.pins).toEqual([]);
    expect(render(s, DAYS).split('\n').at(-1)).toMatch(/is NOT checked: no row .* records a pin/);
  });
});

describe('which lanes Kanon pins to 5m', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

  it("reads them from Kanon's own lane definitions, and agrees with the lanes that set the input", () => {
    expect([...pinnedLanes(fileURLToPath(new URL('../../.github/workflows', import.meta.url)), LANES)].sort()).toEqual(['explore', 'merge-reconcile', 'project-digest', 'review']);
  });

  it('counts a pin only on its own line, never a mention in a comment or a template', () => {
    expect(declaresPin('          prompt-cache-ttl: 5m\n')).toBe(true);
    expect(declaresPin('        CLAUDE_CODE_PROMPT_CACHE_TTL: "5m"\n')).toBe(true);
    expect(declaresPin('# prompt-cache-ttl: 5m pins it\n')).toBe(false);
    expect(declaresPin('          prompt-cache-ttl: ${{ inputs.prompt-cache-ttl }}\n')).toBe(false);
    expect(declaresPin('          prompt-cache-ttl: 1h\n')).toBe(false);
  });

  it("names only Kanon's lanes, so a step's other `lane:` value is no arm", () => {
    dir = mkdtempSync(join(tmpdir(), 'cache-ttl-'));
    mkdirSync(join(dir, 'w'));
    writeFileSync(join(dir, 'w', 'a.yml'), 'jobs:\n  x:\n    steps:\n      - with:\n          prompt-cache-ttl: 5m\n          lane: review\n      - with:\n          lane: not-a-lane\n');
    writeFileSync(join(dir, 'w', 'b.yml'), 'jobs:\n  x:\n    steps:\n      - with:\n          lane: implement\n');
    expect([...pinnedLanes(join(dir, 'w'), LANES)]).toEqual(['review']);
  });
});
