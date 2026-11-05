import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FINDINGS, UNWAIVABLE } from '../../scripts/lib/waivers.mjs';
import { managedSettingsPaths, pluginSettingsFile, readMarketplaceEntry, userSettingsPath } from '../../cli/plugin.mjs';
import { checkout, fakeGitHub, healthyFiles, PINNED, run, type Result } from './helpers/doctor.js';
import { SPAWNS } from './helpers/spawns.js';

// Every case runs doctor against a real git checkout (helpers/doctor.ts).
vi.setConfig({ testTimeout: SPAWNS.timeout });

/**
 * #1577, #1607 point 1: a `kanon` marketplace entry in the person's user settings, or the managed
 * settings, overrides the repository's pin. Doctor reads that one entry of each, from a home and
 * managed paths each case makes in a temporary directory, never the real ~/.claude.
 */
const SETTINGS = '.claude/settings.json';
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'kanon-user-pin-'));
  dirs.push(d);
  return d;
};
const SECRET = 'sk-ant-never-printed';
/** Settings with the kanon entry at `ref`, and a credential beside it that nothing may print. */
const settings = (ref: string | null, repo = 'yedeya-labs/kanon') =>
  JSON.stringify({ env: { ANTHROPIC_API_KEY: SECRET }, extraKnownMarketplaces: { kanon: { source: { source: 'github', repo, ...(ref ? { ref } : {}) } } } });
/** A home whose user settings hold `text`, or none. */
const home = (text: string | null) => {
  const h = temp();
  if (text !== null) {
    mkdirSync(join(h, '.claude'), { recursive: true });
    writeFileSync(join(h, '.claude', 'settings.json'), text);
  }
  return h;
};
const managedFile = (text: string) => {
  const p = join(temp(), 'managed-settings.json');
  writeFileSync(p, text);
  return p;
};
const declaredRepo = () => checkout({ ...healthyFiles(), [SETTINGS]: pluginSettingsFile(PINNED) });
const of = (r: Result, id: string) => r.json.findings.filter((f: { id: string }) => f.id === id);

describe('plugin.user-override', () => {
  it('is a note about one machine, which no waiver waives', () => {
    expect(FINDINGS['plugin.user-override']).toEqual({ category: 'pin', blocking: false });
    expect(UNWAIVABLE['plugin.user-override']).toMatch(/one person's machine/);
  });

  it("names a user entry at another ref as overriding the repository's pin, with the fix at project scope", async () => {
    const h = home(settings('v0.38.0'));
    const r = await run(declaredRepo(), fakeGitHub(), ['--json'], undefined, { HOME: h });
    expect(of(r, 'plugin.user-override')).toEqual([{
      id: 'plugin.user-override', category: 'pin', blocking: false, subject: '~/.claude/settings.json',
      message: expect.stringMatching(/^Your user settings declare the "kanon" marketplace at v0\.38\.0, which overrides the .* pin \.claude\/settings\.json declares/),
      fix: {
        text: expect.stringContaining("in this repository's checkout"),
        commands: ['claude plugin marketplace remove kanon --scope user', `claude plugin marketplace add --scope project yedeya-labs/kanon#${PINNED}`, 'claude plugin install --scope project kanon@kanon'],
        url: null,
      },
    }]);
    // Nothing else of the file reaches the document.
    expect(r.out).not.toContain(SECRET);
    expect(r.out).not.toContain(h);
  });

  it('names a managed entry, whose fix is the administrator\'s, and a user entry from another source', async () => {
    const managed = managedFile(settings('v0.38.0'));
    const r = await run(declaredRepo(), fakeGitHub(), ['--json'], undefined, { HOME: home(null) }, [managed]);
    const [f] = of(r, 'plugin.user-override');
    expect(f).toMatchObject({ subject: managed, message: expect.stringMatching(/^The managed settings declare/) });
    expect(f.fix.text).toMatch(/ask whoever manages them/);
    expect(f.fix.commands).not.toContainEqual(expect.stringContaining('remove'));
    const other = await run(declaredRepo(), fakeGitHub(), ['--json'], undefined, { HOME: home(settings(null, 'someone/else')) });
    expect(of(other, 'plugin.user-override')[0].message).toContain("from a source that isn't Kanon's repository");
  });

  it("is quiet for an entry at the repository's own ref, no entry, no file, no home, or no declaration", async () => {
    for (const env of <Array<Record<string, string>>>[{ HOME: home(settings(PINNED)) }, { HOME: home(JSON.stringify({ extraKnownMarketplaces: { other: {} } })) }, { HOME: home(null) }, {}]) {
      expect(of(await run(declaredRepo(), fakeGitHub(), ['--json'], undefined, env), 'plugin.user-override')).toEqual([]);
    }
    // Without the repository's declaration, the person's own entry is how they installed it.
    expect(of(await run(checkout(healthyFiles()), fakeGitHub(), ['--json'], undefined, { HOME: home(settings('v0.38.0')) }), 'plugin.user-override')).toEqual([]);
  });

  it('notes a settings file that is not JSON without quoting it', async () => {
    const r = await run(declaredRepo(), fakeGitHub(), ['--json'], undefined, { HOME: home(`{ "env": { "KEY": "${SECRET}" `) });
    expect(of(r, 'plugin.user-override')).toEqual([]);
    expect(r.json.notes.join('\n')).toContain("~/.claude/settings.json isn't JSON");
    expect(r.out).not.toContain(SECRET);
  });
});

// #1577: with the person's settings read, plugin.behind's fix for a marketplace held at another
// ref says which cause it is, instead of a remove the person may have nothing to remove for.
describe("plugin.behind's fix for a stale marketplace, once doctor can tell the cause", () => {
  const records = (marketRef: string) => {
    const root = temp();
    writeFileSync(join(root, 'known_marketplaces.json'), JSON.stringify({ kanon: { source: { source: 'github', repo: 'yedeya-labs/kanon', ref: marketRef }, installLocation: '/x', lastUpdated: '2026-11-01T00:00:00Z' } }));
    writeFileSync(join(root, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'kanon@kanon': [{ scope: 'user', version: '0.9.0' }] } }));
    return root;
  };
  const behind = (r: Result) => of(r, 'plugin.behind')[0];

  it('points at plugin.user-override where the user entry is the cause, and removes nothing itself', async () => {
    const r = await run(declaredRepo(), fakeGitHub(), ['--json'], undefined, { HOME: home(settings('v0.9.0')), CLAUDE_CODE_PLUGIN_CACHE_DIR: records('v0.9.0') });
    expect(behind(r).fix.commands).toEqual(['claude plugin update kanon@kanon']);
    expect(behind(r).fix.text).toContain('(plugin.user-override): follow that fix first');
  });

  it('says the marketplace is only behind where no settings of the person declare it', async () => {
    const r = await run(declaredRepo(), fakeGitHub(), ['--json'], undefined, { HOME: home(null), CLAUDE_CODE_PLUGIN_CACHE_DIR: records('v0.9.0') });
    expect(behind(r).fix.commands).toEqual(['claude plugin update kanon@kanon']);
    expect(behind(r).fix.text).toContain('No settings of yours declare it, so it is only behind');
  });

  it("keeps the remove, as a condition the person checks, where doctor couldn't read their settings", async () => {
    const r = await run(declaredRepo(), fakeGitHub(), ['--json'], undefined, { CLAUDE_CODE_PLUGIN_CACHE_DIR: records('v0.9.0') });
    expect(behind(r).fix.commands).toEqual(['claude plugin marketplace remove kanon --scope user', 'claude plugin update kanon@kanon']);
    expect(behind(r).fix.text).toContain('If you added the marketplace yourself');
  });
});

describe('the readers', () => {
  it('find the user settings as Claude Code does, and the managed paths per system', () => {
    expect(userSettingsPath({ HOME: '/h' })).toBe('/h/.claude/settings.json');
    expect(userSettingsPath({ HOME: '/h', CLAUDE_CONFIG_DIR: '/c/' })).toBe('/c/settings.json');
    expect(userSettingsPath({})).toBeNull();
    expect(managedSettingsPaths('darwin')).toEqual(['/Library/Application Support/ClaudeCode/managed-settings.json']);
    expect(managedSettingsPaths('linux')).toEqual(['/etc/claude-code/managed-settings.json']);
    expect(managedSettingsPaths('aix')).toEqual([]);
  });

  it('read the one entry and nothing else', () => {
    expect(readMarketplaceEntry(settings('v1.0.0'), 'kanon')).toEqual({ status: 'entry', kanon: true, ref: 'v1.0.0' });
    expect(readMarketplaceEntry(settings('v1.0.0'), 'other')).toEqual({ status: 'none' });
    expect(readMarketplaceEntry(null, 'kanon')).toEqual({ status: 'none' });
    expect(readMarketplaceEntry('[1]', 'kanon')).toEqual({ status: 'none' });
    expect(readMarketplaceEntry(`{"${SECRET}`, 'kanon')).toEqual({ status: 'unreadable' });
  });
});
