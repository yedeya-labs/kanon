import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BATTERY, LEAD_BATTERY, LEAD_RECORD, RECORD, actionPin, batteryDigest, flagsDigest, judge, leadFlags, probeArgs,
  probedFlags, probeInput, reviewerFlags,
} from '../../.github/scripts/reviewer-grant-probe.mjs';
import { claudeArgWords } from '../../scripts/lib/claude-args.mjs';

/**
 * kanon#284 — a bump of the pinned claude-code-action can't ship until the Reviewer's grant has
 * been re-probed against the CLI that the new version installs.
 *
 * The Reviewer's flags leave every command but named `gh` subcommands to Claude Code's own
 * read-only set (kanon#248), load no project settings (kanon#277), and run on a user scope its
 * job made (kanon#283). All of that is the CLI's behaviour, fixed per Kanon release only by
 * `agent-run`'s exact pin, and a Dependabot pull request has no secrets to probe it with. So a
 * maintainer runs `.github/scripts/reviewer-grant-probe.mjs` against the CLI the pin installs,
 * and commits the record it writes when every probe passes. These tests hold the record to the
 * tree: a different pin, different Reviewer flags or a different battery is red until it is
 * re-run. The record can't prove the probes ran; it makes skipping them a deliberate act.
 */

type Record = {
  action: string; cli: string; flags_sha256: string; battery_sha256: string;
  results: { id: string; expect: string; pass: boolean }[];
};
const record = JSON.parse(readFileSync(RECORD, 'utf8')) as Record;
const RERUN = 'Re-run `node .github/scripts/reviewer-grant-probe.mjs` (kanon#284) and commit the record it writes.';

describe("the probe record matches what ships (kanon#284)", () => {
  it("was taken on the claude-code-action version agent-run pins", () => {
    expect(record.action, RERUN).toBe(actionPin());
    expect(record.cli, 'the record names the CLI version it probed').toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("was taken with the Reviewer's flags as they are", () => {
    expect(record.flags_sha256, RERUN).toBe(flagsDigest(reviewerFlags()));
  });

  it('was taken with this battery, and every probe in it passed', () => {
    expect(record.battery_sha256, RERUN).toBe(batteryDigest());
    expect(record.results.map((r) => r.id)).toEqual(BATTERY.map((p) => p.id));
    expect(record.results.filter((r) => !r.pass)).toEqual([]);
  });
});

/**
 * kanon#405 — the Lead's lanes lean on the same CLI behaviour, and add `Edit(/docs/**)` and a git
 * allow-list (`K-AGENT-50`). Their record is held to the tree the same way, so a change to either
 * arm's flags, or a bump of the pin, is red until the Lead's battery is re-run too.
 */
const lead = JSON.parse(readFileSync(LEAD_RECORD, 'utf8')) as Record;
const LEAD_RERUN = 'Re-run `node .github/scripts/reviewer-grant-probe.mjs --lane lead` (kanon#405) and commit the record it writes.';

describe("the Lead's probe record matches what ships (kanon#405)", () => {
  it("was taken on the claude-code-action version agent-run pins, and the CLI the Reviewer's was", () => {
    expect(lead.action, LEAD_RERUN).toBe(actionPin());
    expect(lead.cli, 'both records probe the CLI the pin installs').toBe(record.cli);
  });

  it("was taken with both Lead arms' flags as they are", () => {
    expect(lead.flags_sha256, LEAD_RERUN).toBe(flagsDigest(leadFlags()));
  });

  it('was taken with this battery, and every probe in it passed', () => {
    expect(lead.battery_sha256, LEAD_RERUN).toBe(batteryDigest(LEAD_BATTERY));
    expect(lead.results.map((r) => r.id)).toEqual(LEAD_BATTERY.map((p) => p.id));
    expect(lead.results.filter((r) => !r.pass)).toEqual([]);
  });
});

describe("the Lead's battery covers its flags (kanon#405)", () => {
  const tagged = (tag: string, expect: string) => LEAD_BATTERY.filter((p) => p.tags.includes(tag) && p.expect === expect);
  const arms = leadFlags();

  it('probes one set of flags that stands for both arms', () => {
    expect(arms).toHaveLength(2);
    expect(probedFlags(arms)).toBe(arms[0]);
    expect(() => probedFlags([arms[0]!, `${arms[1]!}\n--allowedTools Write`])).toThrow(/probe each arm/);
  });

  it('refuses writes outside docs/, directly, by `..`, through a symlink, and git config', () => {
    expect(tagged('writes-outside', 'refused').length).toBeGreaterThanOrEqual(8);
    expect(tagged('symlink', 'refused').map((p) => p.tool === 'Write' && p.file.startsWith('{repo}/docs/link-'))).toEqual([true, true, true]);
    expect(tagged('writes-outside', 'refused').some((p) => p.tool === 'Write' && p.file.includes('/docs/../'))).toBe(true);
    expect(tagged('git-config', 'refused').filter((p) => p.tool === 'Bash' && /^git config /.test(p.command)).length).toBeGreaterThanOrEqual(2);
  });

  it('refuses a program for the far end of a push or fetch, in each spelling the deny rules name', () => {
    const commands = tagged('git-transport', 'refused').map((p) => (p.tool === 'Bash' ? p.command : ''));
    for (const shape of [/^git push .*--receive-pack=/, /^git push .*--receive-pack \S/, /^git push -u .*--exec=/, /^git push .*--rec''eive/,
      /^git push .*--rec""eive/, /^git push .*\\/, /^git push .*--\{/, /^git fetch .*--upload-pack=/, /^git fetch .*--upl \S/, /^git fetch .*--up""load/]) {
      expect(commands.some((c) => shape.test(c)), String(shape)).toBe(true);
    }
  });

  it('allows a write under docs/, and every git command on its allow-list', () => {
    expect(tagged('docs-write', 'allowed').map((p) => p.tool === 'Write' && p.file.startsWith('{repo}/docs/'))).toEqual([true]);
    // Each `Bash(git …:*)` rule the arms grant has an allowed probe that it is the longest
    // match for, so a git rule added to the flags needs a probe as well as a record.
    const rules = [...new Set(arms.flatMap((a) => claudeArgWords(a)))]
      .flatMap((w) => /^Bash\((git [^:]+):\*\)$/.exec(w)?.[1] ?? []);
    expect(rules.length, 'the check is not vacuous').toBeGreaterThanOrEqual(7);
    const commands = tagged('git', 'allowed').map((p) => (p.tool === 'Bash' ? p.command : ''));
    const owner = (c: string) => rules.filter((r) => c === r || c.startsWith(`${r} `)).sort((a, b) => b.length - a.length)[0];
    expect(rules.filter((r) => !commands.some((c) => owner(c) === r))).toEqual([]);
  });

  it('gives every probe a unique id', () => {
    expect(new Set(LEAD_BATTERY.map((p) => p.id)).size).toBe(LEAD_BATTERY.length);
  });
});

describe('the battery keeps the bar #276 and #282 set', () => {
  const tagged = (tag: string, expect: string) => BATTERY.filter((p) => p.tags.includes(tag) && p.expect === expect).length;

  it('refuses running a tree file every way #276 measured, and writing outside qa-review-*.md', () => {
    expect(tagged('runs-tree-file', 'refused')).toBeGreaterThanOrEqual(25);
    expect(tagged('writes-outside', 'refused')).toBeGreaterThanOrEqual(12);
    for (const tag of ['compound', 'interpreter', 'package-manager', 'exec-wrapper', 'git-exec-option', 'flag-check']) {
      expect(tagged(tag, 'refused'), tag).toBeGreaterThan(0);
    }
    expect(BATTERY.filter((p) => p.tool === 'Write' && p.expect === 'refused').length).toBeGreaterThanOrEqual(2);
  });

  it("still allows the reads and the verdict write the Reviewer needs", () => {
    expect(tagged('read', 'allowed')).toBeGreaterThanOrEqual(8);
    expect(BATTERY.filter((p) => p.tags.includes('verdict') && p.expect === 'allowed').map((p) => p.tool).sort()).toEqual(['Bash', 'Write']);
  });

  it('gives every probe a unique id', () => {
    expect(new Set(BATTERY.map((p) => p.id)).size).toBe(BATTERY.length);
  });
});

describe('the harness runs the Reviewer as it runs', () => {
  const flags = reviewerFlags();
  const args = probeArgs(flags, '/rt', 'haiku');

  it("passes the Reviewer's own flags, with only the cost flags swapped", () => {
    expect(args).toContain('--setting-sources');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('user');
    expect(args).toContain('Edit(//rt/qa-review-*.md)');
    expect(args).toContain('Bash(gh api:*)');
    expect(args.join(' ')).not.toContain('${{');
    expect(args.filter((a) => a === '--model')).toHaveLength(1);
    expect(args[args.indexOf('--model') + 1]).toBe('haiku');
    expect(args).not.toContain('--max-budget-usd');
    expect(args).not.toContain('--effort');
  });

  it('fills the repository and the temp directory into a probe', () => {
    const write = BATTERY.find((p) => p.id === 'write-verdict')!;
    expect(probeInput(write, { repo: '/r', temp: '/t' })).toEqual({ file_path: '/t/qa-review-verdict.md', content: 'probe\n' });
  });
});

describe('judging one probe', () => {
  const bash = { id: 'x', expect: 'refused' as const, tags: [] as string[], tool: 'Bash' as const, command: 'sh marker.sh' };
  const allowed = { ...bash, expect: 'allowed' as const, command: 'git status' };
  const use = (id: string, command: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const result = (id: string, isError = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] } });
  const end = (denied: string[]) => ({ type: 'result', permission_denials: denied.map((id) => ({ tool_name: 'Bash', tool_use_id: id })) });
  const clean = { ran: false, loaded: [], treeChanges: [] };

  it('passes a refused probe only when the CLI denied the exact call', () => {
    const input = { command: 'sh marker.sh' };
    expect(judge(bash, { ...clean, input, events: [use('a', 'sh  marker.sh'), result('a', true), end(['a'])] }).pass).toBe(true);
    expect(judge(bash, { ...clean, input, events: [use('a', 'sh marker.sh'), result('a'), end([])] })).toEqual({ pass: false, detail: 'allowed' });
    expect(judge(bash, { ...clean, input, events: [use('a', 'bash marker.sh'), end(['a'])] }).detail).toMatch(/^not attempted/);
    expect(judge(bash, { ...clean, input, events: [end([])] }).detail).toMatch(/^not attempted/);
  });

  it('fails any probe when something ran, loaded or changed the tree, denial or not', () => {
    const input = { command: 'sh marker.sh' };
    const events = [use('a', 'sh marker.sh'), end(['a'])];
    expect(judge(bash, { ...clean, input, events, ran: true }).pass).toBe(false);
    expect(judge(bash, { ...clean, input, events, loaded: ['project-hook-session-start'] }).pass).toBe(false);
    expect(judge(bash, { ...clean, input, events, treeChanges: ['?? written.txt'] }).pass).toBe(false);
    // An instruction file shows only as the model obeying it.
    expect(judge(bash, { ...clean, input, events: [use('b', 'touch /m/project-instructions'), ...events] }).detail).toMatch(/^loaded: project-instructions/);
  });

  it('passes an allowed probe only when the call went through without error', () => {
    const input = { command: 'git status' };
    expect(judge(allowed, { ...clean, input, events: [use('a', 'git status'), result('a'), end([])] }).pass).toBe(true);
    expect(judge(allowed, { ...clean, input, events: [use('a', 'git status'), result('a', true), end(['a'])] }).detail).toBe('denied');
    expect(judge(allowed, { ...clean, input, events: [use('a', 'git status'), result('a', true), end([])] }).detail).toMatch(/^errored/);
  });

  it('matches a Write probe on its path', () => {
    const write = { id: 'w', expect: 'refused' as const, tags: [] as string[], tool: 'Write' as const, file: '{repo}/x' };
    const input = { file_path: '/r/x', content: 'probe\n' };
    const w = (id: string, file_path: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path } }] } });
    expect(judge(write, { ...clean, input, events: [w('a', '/r/x'), end(['a'])] }).pass).toBe(true);
    expect(judge(write, { ...clean, input, events: [w('a', '/r/y'), end(['a'])] }).pass).toBe(false);
  });
});
