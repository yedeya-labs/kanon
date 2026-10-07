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
 * check stayed behind with the cutover ledger that dated each pin; the output says so.
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
    expect([...TTL_ATTRIBUTES].sort()).toEqual(['cache_write_1h_tokens', 'cache_write_5m_tokens', 'cache_write_tokens', 'outcome', 'sk', 'tag']);
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
      expect(lines.at(-1)).toMatch(/^cache-ttl: the pinned lanes' own health .* is NOT checked here/);
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
