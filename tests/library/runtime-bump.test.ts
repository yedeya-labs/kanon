import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimeBumpCli } from '../../scripts/runtime-bump.mjs';
import { AGENT_RUN, GRANT_RECORD, LEDGER, compareVersions, parseWatermark, reviewDue, runtimeOf } from '../../scripts/lib/runtime-bump.mjs';

/**
 * The Overseer's runtime-version trigger (plan 0004 decision 12, amended 2026-10-06; kanon#423):
 * on a merged pull request that moved the caller's Kanon pin, the lane audits only when the agent
 * runtime of the release it runs differs from the capability ledger's watermark (the Owner's
 * decision on kanon#423). The watermark is read by exact match (`K-LAYOUT-7`), and anything that
 * can't be read or compared makes the audit due.
 */
const KANON = fileURLToPath(new URL('../../', import.meta.url));
const fenced = (...lines: string[]) => ['# Capability ledger', '', 'Prose.', '', '```text', ...lines, '```', ''].join('\n');
const RUNTIME = { action: 'v1.0.241', cli: '2.1.289' };
const TRIGGER = 'pull_request_target';

describe('the watermark reader (K-LAYOUT-7)', () => {
  it('reads the bare line alone in a fenced block, with either fence and CRLF line endings', () => {
    expect(parseWatermark(fenced('Watermark: 2.1.289'))).toEqual({ watermark: '2.1.289' });
    expect(parseWatermark(fenced('', 'Watermark: 2.1.300', ''))).toEqual({ watermark: '2.1.300' });
    expect(parseWatermark('~~~\nWatermark: 2.1.1\n~~~\n')).toEqual({ watermark: '2.1.1' });
    expect(parseWatermark(fenced('Watermark: 2.1.289').replace(/\n/g, '\r\n'))).toEqual({ watermark: '2.1.289' });
  });

  it.each([
    ['outside a fence', '# Ledger\n\nWatermark: 2.1.289\n'],
    ['bolded', fenced('**Watermark:** 2.1.289')],
    ['in backticks', fenced('Watermark: `2.1.289`')],
    ['with a v', fenced('Watermark: v2.1.289')],
    ['indented', fenced('  Watermark: 2.1.289')],
    ['with a trailing word', fenced('Watermark: 2.1.289 (seed)')],
    ['beside another line in its block', fenced('Watermark: 2.1.289', 'Reviewed 2026-10-06')],
    ['in a fence that never closes', '```text\nWatermark: 2.1.289\n'],
    ['as a placeholder', fenced('Watermark: <version>')],
  ])('finds none when it is %s', (_name, text) => {
    expect(parseWatermark(text)).toHaveProperty('none');
  });

  it('finds none when two blocks each carry one, naming both', () => {
    const two = `${fenced('Watermark: 2.1.289')}\n${fenced('Watermark: 2.1.300')}`;
    expect(parseWatermark(two)).toEqual({ none: `${LEDGER} carries 2 watermarks (2.1.289, 2.1.300), so none of them is the one (K-LAYOUT-7)` });
  });

  it("reads Kanon's own ledger, seeded with a runtime version", () => {
    expect(parseWatermark(readFileSync(join(KANON, LEDGER), 'utf8'))).toEqual({ watermark: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
  });
});

describe('the runtime a Kanon tree runs', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
  const tree = (agentRun: string, record: object) => {
    dir = mkdtempSync(join(tmpdir(), 'runtime-bump-'));
    mkdirSync(join(dir, 'actions/agent-run'), { recursive: true });
    mkdirSync(join(dir, '.github/scripts'), { recursive: true });
    writeFileSync(join(dir, AGENT_RUN), agentRun);
    writeFileSync(join(dir, GRANT_RECORD), JSON.stringify(record));
    return dir;
  };
  const step = (pin: string) => `runs:\n  steps:\n    - uses: anthropics/claude-code-action@${pin}\n      id: agent\n`;

  it('is the CLI the pin installs, as the grant record names it', () => {
    expect(runtimeOf(tree(step('v1.0.241'), RUNTIME))).toEqual(RUNTIME);
  });

  it("reads this tree's own pin and record, which the grant-probe test holds in step", () => {
    expect(runtimeOf(KANON)).toEqual({ action: expect.stringMatching(/^v\d/), cli: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
  });

  it('refuses a record taken on another pin, two pins, none, and a record with no CLI version', () => {
    expect(() => runtimeOf(tree(step('v1.0.300'), RUNTIME))).toThrow(`${GRANT_RECORD} was taken on claude-code-action v1.0.241, but ${AGENT_RUN} pins v1.0.300`);
    expect(() => runtimeOf(tree(step('v1.0.241') + step('v1.0.241'), RUNTIME))).toThrow('pins anthropics/claude-code-action 2 times, not once');
    expect(() => runtimeOf(tree('runs:\n  steps: []\n', RUNTIME))).toThrow('0 times');
    expect(() => runtimeOf(tree(step('v1.0.241'), { action: 'v1.0.241', cli: 'latest' }))).toThrow('names no CLI version');
  });
});

describe('whether the audit is due', () => {
  const due = (o: { event?: string; runtime?: () => typeof RUNTIME; ledger?: () => string | null; watch?: string }) => reviewDue({
    event: o.event ?? TRIGGER,
    watch: o.watch ?? 'on',
    runtime: o.runtime ?? (() => RUNTIME),
    ledger: o.ledger ?? (() => fenced('Watermark: 2.1.289')),
  });
  const throws = (message: string) => () => { throw new Error(message); };

  it('always, on the schedule and a dispatch, reading nothing', () => {
    for (const event of ['schedule', 'workflow_dispatch']) {
      expect(due({ event, runtime: throws('read'), ledger: throws('read') })).toEqual({ due: true, note: '' });
    }
  });

  it('not, on the trigger, when the runtime is the watermark: the skip says so', () => {
    expect(due({})).toEqual({
      due: false,
      note: "the agent runtime is still Claude Code 2.1.289 (claude-code-action v1.0.241), the capability ledger's watermark: no runtime change to review, so this run skips the audit. The weekly run still audits.",
    });
  });

  it('on the trigger, when the runtime is newer than the watermark', () => {
    expect(due({ ledger: () => fenced('Watermark: 2.1.200') })).toEqual({
      due: true,
      note: "the agent runtime is now Claude Code 2.1.289 (claude-code-action v1.0.241), newer than the capability ledger's watermark, 2.1.200: the capability review is due",
    });
    // Numerically, part by part: 2.1.289 is newer than 2.1.29 and 2.0.999, which a string compare gets wrong.
    expect(due({ ledger: () => fenced('Watermark: 2.1.29') }).due).toBe(true);
    expect(due({ ledger: () => fenced('Watermark: 2.0.999') }).due).toBe(true);
    expect(due({ ledger: () => fenced('Watermark: 1.9.9') }).due).toBe(true);
  });

  it('not, on the trigger, when the runtime is older than the watermark: a rollback, or a review already past it (the Owner\'s decision)', () => {
    expect(due({ ledger: () => fenced('Watermark: 2.1.300') })).toEqual({
      due: false,
      note: "the agent runtime is Claude Code 2.1.289 (claude-code-action v1.0.241), older than the capability ledger's watermark, 2.1.300, which the review has already gone through: nothing new to review, so this run skips the audit. The weekly run still audits.",
    });
    // 2.1.289 is older than 2.1.1000 and 2.2.0 and 3.0.0, which a string compare gets wrong.
    for (const w of ['2.1.1000', '2.2.0', '3.0.0', '2.1.290']) expect(due({ ledger: () => fenced(`Watermark: ${w}`) }).due, w).toBe(false);
  });

  it('compares versions part by part, as numbers', () => {
    expect(compareVersions('2.1.10', '2.1.9')).toBeGreaterThan(0);
    expect(compareVersions('2.1.9', '2.1.10')).toBeLessThan(0);
    expect(compareVersions('2.10.0', '2.9.99')).toBeGreaterThan(0);
    expect(compareVersions('3.0.0', '2.99.99')).toBeGreaterThan(0);
    expect(compareVersions('2.1.289', '2.1.289')).toBe(0);
  });

  it('on the trigger, failing open, when anything is unreadable or there is no watermark', () => {
    const cases = [
      due({ runtime: throws('no record') }),
      due({ ledger: throws('HTTP 502') }),
      due({ ledger: () => null }),
      due({ ledger: () => '# Ledger\n\nWatermark: 2.1.289\n' }),
    ];
    for (const c of cases) expect(c.due).toBe(true);
    expect(cases.map((c) => c.note)).toEqual([
      "the agent runtime of this Kanon release couldn't be read (no record), so the audit runs: a runtime change is never left unreviewed on a guess",
      `${LEDGER} couldn't be read from the default branch (HTTP 502), so the audit runs: a runtime change is never left unreviewed on a guess`,
      `${LEDGER} doesn't exist on the default branch, so there is no watermark to compare the runtime, Claude Code 2.1.289, with, so the audit runs: a runtime change is never left unreviewed on a guess`,
      `${LEDGER} carries no bare \`Watermark: <version>\` line alone in a fenced block (K-LAYOUT-7), so there is nothing to compare the runtime, Claude Code 2.1.289, with, so the audit runs: a runtime change is never left unreviewed on a guess`,
    ]);
  });
});

describe('the CLI the gate job runs', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
  const kanonTree = (cli: string) => {
    dir = mkdtempSync(join(tmpdir(), 'runtime-bump-cli-'));
    mkdirSync(join(dir, 'actions/agent-run'), { recursive: true });
    mkdirSync(join(dir, '.github/scripts'), { recursive: true });
    writeFileSync(join(dir, AGENT_RUN), '    - uses: anthropics/claude-code-action@v1.0.241\n');
    writeFileSync(join(dir, GRANT_RECORD), JSON.stringify({ action: 'v1.0.241', cli }));
    return dir;
  };
  const gh = (ledger: string | null, calls: string[][] = []) => (args: string[]) => {
    calls.push(args);
    if (args[1] === 'repos/o/r') return 'trunk\n';
    if (ledger === null) throw Object.assign(new Error('gh failed'), { stderr: 'gh: Not Found (HTTP 404)' });
    return ledger;
  };

  it('prints false on an unchanged runtime, true on a changed one, reading the ledger from the default branch', () => {
    const calls: string[][] = [];
    const unchanged = runtimeBumpCli({ event: TRIGGER, watch: 'on', repo: 'o/r', root: kanonTree('2.1.289'), run: gh(fenced('Watermark: 2.1.289'), calls) });
    expect(unchanged).toMatchObject({ code: 0, out: 'false' });
    expect(unchanged.note).toMatch(/skips the audit/);
    expect(calls[1]![1]).toBe(`repos/o/r/contents/${LEDGER}?ref=trunk`);
    expect(runtimeBumpCli({ event: TRIGGER, watch: 'on', repo: 'o/r', root: kanonTree('2.1.300'), run: gh(fenced('Watermark: 2.1.289')) })).toMatchObject({ code: 0, out: 'true' });
    expect(runtimeBumpCli({ event: TRIGGER, watch: 'on', repo: 'o/r', root: kanonTree('2.1.200'), run: gh(fenced('Watermark: 2.1.289')) })).toMatchObject({ code: 0, out: 'false' });
    expect(runtimeBumpCli({ event: TRIGGER, watch: 'on', repo: 'o/r', root: kanonTree('2.1.289'), run: gh(null) })).toMatchObject({ code: 0, out: 'true' });
  });

  // kanon#477: the watch is the adoption record's choice, off by default; off, the trigger never audits.
  it('prints false on the trigger when the capability watch is off, reading neither the runtime nor the ledger', () => {
    const calls: string[][] = [];
    const off = runtimeBumpCli({ event: TRIGGER, watch: 'off', repo: 'o/r', root: kanonTree('2.1.300'), run: gh(fenced('Watermark: 2.1.289'), calls) });
    expect(off).toMatchObject({ code: 0, out: 'false' });
    expect(off.note).toMatch(/^the capability watch is off by choice .* this run skips the audit\. The weekly run still audits\.$/);
    expect(calls).toEqual([]);
    // Off the trigger the choice changes nothing here: the weekly audit runs, without the capability section.
    expect(runtimeBumpCli({ event: 'schedule', watch: 'off', repo: 'o/r' })).toEqual({ code: 0, out: 'true' });
    // A value the gate job couldn't have written fails open, as any unread input does.
    const odd = runtimeBumpCli({ event: TRIGGER, watch: '', repo: 'o/r', root: kanonTree('2.1.289'), run: gh(fenced('Watermark: 2.1.289')) });
    expect(odd).toMatchObject({ code: 0, out: 'true' });
    expect(odd.note).toMatch(/neither `on` nor `off`, so the audit runs/);
  });

  it('prints true with no note off the trigger, and exits 2 on the trigger without a repository', () => {
    expect(runtimeBumpCli({ event: 'schedule', repo: '' })).toEqual({ code: 0, out: 'true' });
    expect(runtimeBumpCli({ event: TRIGGER, repo: '' })).toEqual({ code: 2, out: 'runtime-bump: GITHUB_REPOSITORY must be set' });
  });
});
