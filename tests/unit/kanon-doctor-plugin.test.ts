import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { EXIT, UNWAIVABLE, WAIVER_LABEL } from '../../cli/doctor.mjs';
import { declaresAutoUpdate, installedBehind, isKanonSource, pluginSettings, pluginSettingsFile, pluginsRoot, readMachinePlugin, readPluginDeclaration } from '../../cli/plugin.mjs';
import { checkout, clone, fakeGitHub, healthyFiles, ids, NEXT, PINNED, REQ, run, type Result } from './helpers/doctor.js';
import { SPAWNS } from './helpers/spawns.js';

/**
 * `kanon doctor` on the kanon plugin's declared release (#376), and the reader of the declaration.
 *
 * Split out of kanon-doctor.test.ts, which holds the plan's falsifiable checks and the JSON contract,
 * so the doctor's cases run in parallel (#436). The fixtures are in helpers/doctor.ts.
 */
// Every case runs doctor against a real git checkout (helpers/doctor.ts).
vi.setConfig({ testTimeout: SPAWNS.timeout });

// kanon#1578: the declaration init writes, without the `"autoUpdate": true` it carries.
const withoutAutoUpdate = (text: string) => {
  const doc = JSON.parse(text);
  delete doc.extraKnownMarketplaces.kanon.autoUpdate;
  return `${JSON.stringify(doc, null, 2)}\n`;
};

// #376: a project declares the kanon plugin in its .claude/settings.json (docs/skills.md), and
// doctor compares the declared release with the one it checks against, without blocking.
describe("kanon doctor and the kanon plugin's declared release (#376)", () => {
  const SETTINGS = '.claude/settings.json';
  const declared = (ref: string | null, over: { name?: string; source?: Record<string, unknown>; enabled?: boolean; autoUpdate?: unknown } = {}) => {
    const name = over.name ?? 'kanon';
    const source = over.source ?? { source: 'github', repo: 'yedeya-labs/kanon', ...(ref === null ? {} : { ref }) };
    // kanon#1578: with the key init writes, unless a case leaves it out.
    const entry = 'autoUpdate' in over && over.autoUpdate === undefined ? { source } : { source, autoUpdate: 'autoUpdate' in over ? over.autoUpdate : true };
    return `${JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, extraKnownMarketplaces: { [name]: entry }, enabledPlugins: { [`kanon@${name}`]: over.enabled ?? true } }, null, 2)}\n`;
  };
  const mismatch = (r: Result) => r.json.findings.filter((f: { id: string }) => f.id === 'plugin.version-mismatch');

  it('says nothing of a plugin declared at the pinned release, and notes one not declared at all', async () => {
    const at = await run(checkout({ ...healthyFiles(), [SETTINGS]: pluginSettingsFile(PINNED) }), fakeGitHub(), ['--json']);
    expect(at.status, at.out).toBe(EXIT.healthy);
    expect(at.json.findings).toEqual([]);
    expect(at.json.notes.join('\n')).not.toContain(SETTINGS);
    const none = await run(checkout(healthyFiles()), fakeGitHub(), ['--json']);
    expect(none.json.findings).toEqual([]);
    expect(none.json.notes.join('\n')).toContain(`${SETTINGS} doesn't declare the kanon plugin, so its release lives in each person's Claude Code configuration`);
  });

  it('names a declaration at another release, without blocking, with the one ref to set', async () => {
    const r = await run(checkout({ ...healthyFiles(), [SETTINGS]: declared('v0.9.0') }), fakeGitHub(), ['--json']);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(r.json.status).toBe('healthy');
    expect(mismatch(r)).toEqual([{
      id: 'plugin.version-mismatch', category: 'pin', blocking: false, subject: SETTINGS,
      message: `declares the kanon plugin's marketplace "kanon" at v0.9.0, not at ${PINNED} (the release the callers pin); the skills run kanon from the release they ship in, and install it (K-ADOPT-11).`,
      fix: { text: `Set the "kanon" marketplace's ref in ${SETTINGS} to ${PINNED}. Claude Code fetches the marketplace again from the changed source when a session starts; with "autoUpdate": true on the entry, Claude Code then updates the installed plugin to it in the background, a few minutes into a session (docs/skills.md, "Moving the plugin").`, commands: [`"ref": "${PINNED}"`], url: null },
    }]);
    // kanon#1578: without the key, the person moves the installed plugin with the update command.
    const off = await run(checkout({ ...healthyFiles(), [SETTINGS]: declared('v0.9.0', { autoUpdate: undefined }) }), fakeGitHub(), ['--json']);
    expect(mismatch(off).map((f: { fix: { text: string } }) => f.fix.text)).toEqual([`Set the "kanon" marketplace's ref in ${SETTINGS} to ${PINNED}. Claude Code fetches the marketplace again from the changed source when a session starts, and the installed plugin then moves with claude plugin update kanon@kanon (docs/skills.md, "Moving the plugin").`]);
    const prose = await run(checkout({ ...healthyFiles(), [SETTINGS]: declared('v0.9.0') }), fakeGitHub());
    expect(prose.status).toBe(EXIT.healthy);
    expect(prose.out).toContain(`[Pin, not blocking] ${SETTINGS}: declares the kanon plugin's marketplace "kanon" at v0.9.0`);
  });

  it('names a declaration with no ref, which follows the default branch', async () => {
    const r = await run(checkout({ ...healthyFiles(), [SETTINGS]: declared(null) }), fakeGitHub(), ['--json']);
    expect(mismatch(r).map((f: { message: string }) => f.message)).toEqual([expect.stringContaining("with no ref, so it follows Kanon's default branch, not at")]);
  });

  it('compares with the release --to moves to: the plugin at the pin is named, the plugin at the target is not', async () => {
    const github = fakeGitHub();
    github.st.releases[NEXT] = clone(REQ);
    const atPin = await run(checkout({ ...healthyFiles(), [SETTINGS]: pluginSettingsFile(PINNED) }), github, ['--to', NEXT, '--json']);
    expect(mismatch(atPin).map((f: { fix: { commands: string[] } }) => f.fix.commands)).toEqual([[`"ref": "${NEXT}"`]]);
    expect(mismatch(atPin)[0].message).toContain(`not at ${NEXT} (the release you are moving to)`);
    const atTarget = await run(checkout({ ...healthyFiles(), [SETTINGS]: pluginSettingsFile(NEXT) }), github, ['--to', NEXT, '--json']);
    expect(mismatch(atTarget)).toEqual([]);
  });

  it('finds Kanon by its marketplace source, whatever the entry is called, and only Kanon', async () => {
    const git = await run(checkout({ ...healthyFiles(), [SETTINGS]: declared('v0.9.0', { name: 'tools', source: { source: 'git', url: 'https://github.com/yedeya-labs/kanon.git', ref: 'v0.9.0' } }) }), fakeGitHub(), ['--json']);
    expect(mismatch(git).map((f: { message: string }) => f.message)).toEqual([expect.stringContaining('marketplace "tools" at v0.9.0')]);
    const other = await run(checkout({ ...healthyFiles(), [SETTINGS]: declared('v0.9.0', { source: { source: 'github', repo: 'acme/kanon-fork', ref: 'v0.9.0' } }) }), fakeGitHub(), ['--json']);
    expect(mismatch(other)).toEqual([]);
    expect(other.json.notes.join('\n')).toContain(`${SETTINGS} doesn't declare the kanon plugin (it enables kanon@kanon, from a marketplace each person added themselves)`);
  });

  it('notes a declared marketplace whose plugin is not enabled', async () => {
    const r = await run(checkout({ ...healthyFiles(), [SETTINGS]: declared(PINNED, { enabled: false }) }), fakeGitHub(), ['--json']);
    expect(r.json.findings).toEqual([]);
    expect(r.json.notes.join('\n')).toContain(`declares the kanon plugin's marketplace "kanon" but doesn't enable kanon@kanon`);
  });

  // kanon#1578 (the Owner, 2026-11-02): init writes "autoUpdate": true, and doctor notes an entry without it.
  it('notes a declared marketplace without "autoUpdate": true, without blocking, with the one key to set', async () => {
    const autoOff = (r: Result) => r.json.findings.filter((f: { id: string }) => f.id === 'plugin.auto-update-off');
    for (const value of [undefined, false, 'true']) {
      const r = await run(checkout({ ...healthyFiles(), [SETTINGS]: declared(PINNED, { name: 'tools', autoUpdate: value }) }), fakeGitHub(), ['--json']);
      expect(r.status, String(value)).toBe(EXIT.healthy);
      expect(autoOff(r), String(value)).toEqual([{
        id: 'plugin.auto-update-off', category: 'pin', blocking: false, subject: SETTINGS,
        message: `declares the kanon plugin's marketplace "tools" without "autoUpdate": true, so Claude Code doesn't update the installed plugin when the ref moves: each person moves it by hand (docs/skills.md, "Moving the plugin").`,
        fix: { text: expect.stringContaining('Set "autoUpdate": true on the "tools" marketplace entry'), commands: ['"autoUpdate": true'], url: null },
      }]);
    }
    // With the key, or with nothing declared, nothing.
    expect(autoOff(await run(checkout({ ...healthyFiles(), [SETTINGS]: declared(PINNED) }), fakeGitHub(), ['--json']))).toEqual([]);
    expect(autoOff(await run(checkout(healthyFiles()), fakeGitHub(), ['--json']))).toEqual([]);
  });

  it('reads "autoUpdate" on the Kanon marketplace entry alone, through the alias as Claude Code does', () => {
    expect(pluginSettings(PINNED).extraKnownMarketplaces.kanon).toEqual({ source: { source: 'github', repo: 'yedeya-labs/kanon', ref: PINNED }, autoUpdate: true });
    expect(declaresAutoUpdate(pluginSettingsFile(PINNED))).toBe(true);
    expect(declaresAutoUpdate(declared(PINNED, { autoUpdate: undefined }))).toBe(false);
    expect(declaresAutoUpdate(JSON.stringify({ additionalMarketplaces: { k: { source: { source: 'github', repo: 'yedeya-labs/kanon', ref: PINNED }, autoUpdate: true } } }))).toBe(true);
    // Another marketplace's key is not Kanon's.
    expect(declaresAutoUpdate(JSON.stringify({ extraKnownMarketplaces: { kanon: { source: { source: 'github', repo: 'yedeya-labs/kanon' } }, other: { source: { source: 'github', repo: 'acme/plugins' }, autoUpdate: true } } }))).toBe(false);
    for (const text of [null, '[]', '{ "permissions": {} }']) expect(declaresAutoUpdate(text), String(text)).toBeNull();
  });

  it('lets the adoption record waive plugin.auto-update-off, a choice of the project\'s', async () => {
    const record = `${healthyFiles()['docs/qa/adoption.md']}- **${WAIVER_LABEL}:** \`plugin.auto-update-off\` on \`${SETTINGS}\` (we move the plugin by hand)\n`;
    const r = await run(checkout({ ...healthyFiles(), [SETTINGS]: declared(PINNED, { autoUpdate: undefined }), 'docs/qa/adoption.md': record }), fakeGitHub(), ['--json']);
    expect(r.json.findings).toEqual([]);
    expect(r.json.waived.map((w: { id: string }) => w.id)).toEqual(['plugin.auto-update-off']);
  });

  it('is incomplete, exit 4, when the settings file is not a JSON object', async () => {
    for (const text of ['{ "enabledPlugins": ', '[]\n']) {
      const r = await run(checkout({ ...healthyFiles(), [SETTINGS]: text }), fakeGitHub(), ['--json']);
      expect(r.status, text).toBe(EXIT.incomplete);
      expect(r.json.unchecked).toEqual([{ check: 'plugin', subject: SETTINGS, reason: expect.stringMatching(/^could not read it: it is not (JSON|a JSON object)/) }]);
    }
  });

  it('lets the adoption record waive it, as any finding (#390)', async () => {
    const record = `${healthyFiles()['docs/qa/adoption.md']}- **${WAIVER_LABEL}:** \`plugin.version-mismatch\` on \`${SETTINGS}\` (the plugin leads the pin until Dependabot's bump merges)\n`;
    const r = await run(checkout({ ...healthyFiles(), [SETTINGS]: declared('v0.9.0'), 'docs/qa/adoption.md': record }), fakeGitHub(), ['--json']);
    expect(r.json.findings).toEqual([]);
    expect(r.json.waived.map((w: { id: string; reason: string }) => [w.id, w.reason])).toEqual([['plugin.version-mismatch', "the plugin leads the pin until Dependabot's bump merges"]]);
    expect(UNWAIVABLE['plugin.version-mismatch']).toBeUndefined();
  });

  it("doesn't call its waiver stale when the settings file can't be read, and doesn't excuse another pin waiver", async () => {
    const waive = (id: string, subject: string) => `- **${WAIVER_LABEL}:** \`${id}\` on \`${subject}\` (kept on purpose)\n`;
    const record = `${healthyFiles()['docs/qa/adoption.md']}${waive('plugin.version-mismatch', SETTINGS)}${waive('pin.mixed', '.github')}`;
    const r = await run(checkout({ ...healthyFiles(), [SETTINGS]: '{', 'docs/qa/adoption.md': record }), fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual(['waiver.stale docs/qa/adoption.md']);
    expect(r.json.findings[0].message).toContain('waives pin.mixed on .github');
    expect(r.json.notes.join('\n')).toContain('waives plugin.version-mismatch on .claude/settings.json, which doctor did not report; the plugin check could not run');
  });
});

describe('the reader of the kanon plugin\'s declaration (cli/plugin.mjs)', () => {
  const at = (doc: unknown) => readPluginDeclaration(JSON.stringify(doc));
  const kanon = (ref?: string) => ({ source: { source: 'github', repo: 'yedeya-labs/kanon', ...(ref ? { ref } : {}) } });

  it('reads what init writes as declared at its release, and enabled', () => {
    expect(readPluginDeclaration(pluginSettingsFile('v1.2.3'))).toEqual({ status: 'declared', name: 'kanon', ref: 'v1.2.3', enabled: true });
    expect(readPluginDeclaration(null)).toEqual({ status: 'absent' });
  });

  it('reads the alias only when the canonical key is absent, as Claude Code does', () => {
    expect(at({ additionalMarketplaces: { kanon: kanon('v1.0.0') } })).toMatchObject({ status: 'declared', ref: 'v1.0.0' });
    expect(at({ extraKnownMarketplaces: { kanon: kanon('v2.0.0') }, additionalMarketplaces: { kanon: kanon('v1.0.0') } })).toMatchObject({ status: 'declared', ref: 'v2.0.0' });
  });

  it('knows Kanon by a github or git source, in any case, and nothing else', () => {
    for (const source of [
      { source: 'github', repo: 'Yedeya-Labs/Kanon' },
      { source: 'git', url: 'https://github.com/yedeya-labs/kanon' },
      { source: 'git', url: 'git@github.com:yedeya-labs/kanon.git' },
    ]) expect(isKanonSource(source), JSON.stringify(source)).toBe(true);
    for (const source of [
      { source: 'github', repo: 'yedeya-labs/kanon-fork' },
      { source: 'github', repo: 'acme/kanon' },
      { source: 'git', url: 'https://gitlab.com/yedeya-labs/kanon.git' },
      { source: 'git', url: 'https://github.com/yedeya-labs/kanon-fork.git' },
      { source: 'directory', path: '.' },
      { source: 'url', url: 'https://github.com/yedeya-labs/kanon' },
      null,
    ]) expect(isKanonSource(source), JSON.stringify(source)).toBe(false);
  });

  it('treats an empty ref as none', () => {
    expect(at({ extraKnownMarketplaces: { kanon: { source: { source: 'github', repo: 'yedeya-labs/kanon', ref: ' ' } } }, enabledPlugins: { 'kanon@kanon': true } })).toEqual({ status: 'declared', name: 'kanon', ref: null, enabled: true });
  });
});

// #1552: the plugin a person runs is what Claude Code installed on their machine, read from its
// own records under the plugins root, which each case writes in a temporary directory of its own
// and hands doctor through CLAUDE_CODE_PLUGIN_CACHE_DIR. No case reads the real ~/.claude.
describe('kanon doctor and the kanon plugin installed on this machine (#1552)', () => {
  const SETTINGS = '.claude/settings.json';
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  const kanonSource = (ref: string | null) => ({ source: 'github', repo: 'yedeya-labs/kanon', ...(ref ? { ref } : {}) });
  /** A plugins root holding Claude Code's two records, either left out with null. */
  const machine = (known: Record<string, unknown> | null, installed: Array<Record<string, unknown>> | null, name = 'kanon') => {
    const root = mkdtempSync(join(tmpdir(), 'kanon-plugins-'));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    if (known) writeFileSync(join(root, 'known_marketplaces.json'), JSON.stringify(known));
    if (installed) writeFileSync(join(root, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [`kanon@${name}`]: installed } }));
    return { CLAUDE_CODE_PLUGIN_CACHE_DIR: root };
  };
  const known = (ref: string | null, name = 'kanon') => ({ [name]: { source: kanonSource(ref), installLocation: '/x', lastUpdated: '2026-11-01T00:00:00Z' } });
  const behind = (r: Result) => r.json.findings.filter((f: { id: string }) => f.id === 'plugin.behind');
  const OLD = '0.9.0';
  const CURRENT = PINNED.slice(1);

  it('says nothing when the plugin installed for this checkout is the pinned release, and reports what it read', async () => {
    const dir = checkout({ ...healthyFiles(), [SETTINGS]: pluginSettingsFile(PINNED) });
    const r = await run(dir, fakeGitHub(), ['--json'], undefined, machine(known(PINNED), [{ scope: 'user', version: OLD }, { scope: 'project', projectPath: dir, version: CURRENT }]));
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(r.json.findings).toEqual([]);
    expect(r.json.plugin).toEqual({ declared: PINNED, machine: 'read', reason: null, marketplace: PINNED, installed: CURRENT, scope: 'project' });
  });

  it("names a project install older than the pin, with the update to run, when Claude Code's marketplace is at the repository's ref", async () => {
    const dir = checkout({ ...healthyFiles(), [SETTINGS]: pluginSettingsFile(PINNED) });
    const r = await run(dir, fakeGitHub(), ['--json'], undefined, machine(known(PINNED), [{ scope: 'project', projectPath: dir, version: OLD }]));
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(behind(r)).toEqual([{
      id: 'plugin.behind', category: 'pin', blocking: false, subject: 'kanon@kanon',
      message: `Claude Code on this machine runs the kanon plugin at ${OLD} (project scope), older than ${PINNED} (the release the callers pin): its skills follow ${OLD}'s rules against this installation (K-ADOPT-11).`,
      fix: { text: expect.stringContaining('hasn\'t updated the installed plugin yet: with "autoUpdate": true on the entry it does so in the background, a few minutes into a session. To move it now, run the command'), commands: ['claude plugin update kanon@kanon'], url: null },
    }]);
    // kanon#1578: without the key, Claude Code moves it only when asked.
    const off = checkout({ ...healthyFiles(), [SETTINGS]: withoutAutoUpdate(pluginSettingsFile(PINNED)) });
    const offRun = await run(off, fakeGitHub(), ['--json'], undefined, machine(known(PINNED), [{ scope: 'project', projectPath: off, version: OLD }]));
    expect(behind(offRun).map((f: { fix: { text: string } }) => f.fix.text)).toEqual([expect.stringContaining('but, without "autoUpdate": true on the entry, moves an installed plugin only when asked. Run the command')]);
  });

  it("names a user's own marketplace entry held at an older ref, which the repository's ref doesn't move, with the steps that move it", async () => {
    const dir = checkout({ ...healthyFiles(), [SETTINGS]: pluginSettingsFile(PINNED) });
    const r = await run(dir, fakeGitHub(), ['--json'], undefined, machine(known('v0.9.0'), [{ scope: 'user', version: OLD }]));
    expect(behind(r).map((f: { fix: { commands: string[] } }) => f.fix.commands)).toEqual([['claude plugin marketplace remove kanon --scope user', 'claude plugin update kanon@kanon']]);
    expect(behind(r)[0].fix.text).toContain('holds the "kanon" marketplace at v0.9.0, not at the');
    expect(behind(r)[0].message).toContain('(user scope)');
    expect(r.json.plugin).toMatchObject({ marketplace: 'v0.9.0', installed: OLD, scope: 'user' });
  });

  it("gives an undeclared plugin's person their own lines, at the checked release", async () => {
    const r = await run(checkout(healthyFiles()), fakeGitHub(), ['--json'], undefined, machine(known('v0.9.0'), [{ scope: 'user', version: OLD }]));
    expect(behind(r).map((f: { fix: { commands: string[] } }) => f.fix.commands)).toEqual([['claude plugin marketplace remove kanon', `claude plugin marketplace add --scope project yedeya-labs/kanon#${PINNED}`, 'claude plugin install --scope project kanon@kanon']]);
    // kanon#1616: at project scope, never the user scope that overrides every repository's pin.
    expect(behind(r)[0].fix.text).toContain("in this repository's checkout");
    expect(r.json.plugin.declared).toBeNull();
  });

  it('compares with the release --to moves to, and never calls a later plugin behind', async () => {
    const github = fakeGitHub();
    github.st.releases[NEXT] = clone(REQ);
    const dir = checkout({ ...healthyFiles(), [SETTINGS]: pluginSettingsFile(NEXT) });
    const env = machine(known(NEXT), [{ scope: 'project', projectPath: dir, version: CURRENT }]);
    const to = await run(dir, github, ['--to', NEXT, '--json'], undefined, env);
    expect(behind(to).map((f: { message: string }) => f.message)).toEqual([expect.stringContaining(`older than ${NEXT} (the release you are moving to)`)]);
    const ahead = await run(dir, github, ['--json'], undefined, machine(known(NEXT), [{ scope: 'project', projectPath: dir, version: NEXT.slice(1) }]));
    expect(behind(ahead)).toEqual([]);
  });

  it("is unchecked, without a finding or exit 4, where the records aren't there, as on a CI runner", async () => {
    const dir = checkout({ ...healthyFiles(), [SETTINGS]: pluginSettingsFile(PINNED) });
    for (const env of [{}, machine(null, null)]) {
      const r = await run(dir, fakeGitHub(), ['--json'], undefined, env);
      expect(r.status, r.out).toBe(EXIT.healthy);
      expect(r.json.unchecked).toEqual([]);
      expect(r.json.plugin).toMatchObject({ machine: 'unchecked', reason: expect.any(String), installed: null });
      expect(r.json.notes.join('\n')).toContain("doctor didn't compare the kanon plugin installed on this machine");
    }
    const garbled = machine(null, null);
    writeFileSync(join(garbled.CLAUDE_CODE_PLUGIN_CACHE_DIR, 'installed_plugins.json'), '{');
    const r = await run(dir, fakeGitHub(), ['--json'], undefined, garbled);
    expect(r.json.plugin).toMatchObject({ machine: 'unchecked', reason: expect.stringContaining('installed_plugins.json is not a JSON object') });
  });

  it("can't be waived: the machine's state isn't the repository's, so the bullet is malformed and the finding stays", async () => {
    const dir = checkout({ ...healthyFiles(), [SETTINGS]: pluginSettingsFile(PINNED), 'docs/qa/adoption.md': `${healthyFiles()['docs/qa/adoption.md']}- **${WAIVER_LABEL}:** \`plugin.behind\` on \`kanon@kanon\` (my plugin is old on purpose)\n` });
    const r = await run(dir, fakeGitHub(), ['--json'], undefined, machine(known(PINNED), [{ scope: 'project', projectPath: dir, version: OLD }]));
    expect(UNWAIVABLE['plugin.behind']).toBeDefined();
    expect(behind(r)).toHaveLength(1);
    expect(r.json.waived).toEqual([]);
    expect(r.json.findings.find((f: { id: string }) => f.id === 'declaration.malformed')?.message).toContain("waives `plugin.behind`, which can't be waived");
  });

  it('notes a plugin the repository enables that Claude Code never installed for this checkout', async () => {
    const dir = checkout({ ...healthyFiles(), [SETTINGS]: pluginSettingsFile(PINNED) });
    const r = await run(dir, fakeGitHub(), ['--json'], undefined, machine(known(PINNED), [{ scope: 'project', projectPath: '/somewhere/else', version: OLD }]));
    expect(behind(r)).toEqual([]);
    expect(r.json.notes.join('\n')).toContain('claude plugin install kanon@kanon --scope project');
  });
});

describe('kanon doctor and a plugin pinned below the latest release (#1551 point 2)', () => {
  const SETTINGS = '.claude/settings.json';
  const below = (r: Result) => r.json.findings.filter((f: { id: string }) => f.id === 'plugin.below-latest');

  it('names a declared ref below the latest release, with the ref to set, without blocking', async () => {
    const r = await run(checkout({ ...healthyFiles(), [SETTINGS]: pluginSettingsFile(PINNED) }), fakeGitHub({ latest: NEXT }), ['--json']);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(below(r)).toEqual([{
      id: 'plugin.below-latest', category: 'pin', blocking: false, subject: SETTINGS,
      message: `pins the kanon plugin's marketplace "kanon" at ${PINNED}, below Kanon's latest release, ${NEXT}. /plugin marketplace update and /plugin update fetch ${PINNED} again, never a later release: the plugin, and the skills it ships, move only when this ref does.`,
      fix: { text: expect.stringContaining(`on the branch kanon/upgrade-${NEXT}, start a new Claude Code session in this repository, where Claude Code updates the plugin itself ("autoUpdate": true), then`), commands: [`"ref": "${NEXT}"`], url: null },
    }]);
    // kanon#1578: without the key, the second command moves the installed plugin.
    const off = await run(checkout({ ...healthyFiles(), [SETTINGS]: withoutAutoUpdate(pluginSettingsFile(PINNED)) }), fakeGitHub({ latest: NEXT }), ['--json']);
    expect(below(off).map((f: { fix: { text: string; commands: string[] } }) => f.fix)).toEqual([expect.objectContaining({ text: expect.stringContaining('in this repository and run the second command there, then'), commands: [`"ref": "${NEXT}"`, 'claude plugin update kanon@kanon'] })]);
  });

  it('can be waived, being about the repository\'s ref', async () => {
    const record = `${healthyFiles()['docs/qa/adoption.md']}- **${WAIVER_LABEL}:** \`plugin.below-latest\` on \`${SETTINGS}\` (we hold the plugin back on purpose)\n`;
    const r = await run(checkout({ ...healthyFiles(), [SETTINGS]: pluginSettingsFile(PINNED), 'docs/qa/adoption.md': record }), fakeGitHub({ latest: NEXT }), ['--json']);
    expect(below(r)).toEqual([]);
    expect(r.json.waived.map((w: { id: string }) => w.id)).toEqual(['plugin.below-latest']);
    expect(UNWAIVABLE['plugin.below-latest']).toBeUndefined();
  });

  it('says nothing at the latest release, when the latest is unknown, under --to the latest, or with no declaration', async () => {
    const github = fakeGitHub({ latest: NEXT });
    github.st.releases[NEXT] = clone(REQ);
    const at = await run(checkout({ ...healthyFiles(), [SETTINGS]: pluginSettingsFile(PINNED) }), fakeGitHub({ latest: PINNED }), ['--json']);
    const unknown = await run(checkout({ ...healthyFiles(), [SETTINGS]: pluginSettingsFile(PINNED) }), fakeGitHub(), ['--json']);
    const to = await run(checkout({ ...healthyFiles(), [SETTINGS]: pluginSettingsFile(PINNED) }), github, ['--to', NEXT, '--json']);
    const none = await run(checkout(healthyFiles()), fakeGitHub({ latest: NEXT }), ['--json']);
    for (const r of [at, unknown, to, none]) expect(below(r)).toEqual([]);
  });
});

describe("the reader of Claude Code's plugin records (cli/plugin.mjs, #1552)", () => {
  const same = (a: string, b: string) => a === b;
  const records = (plugins: Record<string, unknown>) => JSON.stringify({ version: 2, plugins });

  it('finds the plugins root as Claude Code does, and none without a home', () => {
    expect(pluginsRoot({ CLAUDE_CODE_PLUGIN_CACHE_DIR: '/c/', CLAUDE_CONFIG_DIR: '/d', HOME: '/h' })).toBe('/c');
    expect(pluginsRoot({ CLAUDE_CONFIG_DIR: '/d', HOME: '/h' })).toBe('/d/plugins');
    expect(pluginsRoot({ HOME: '/h' })).toBe('/h/.claude/plugins');
    expect(pluginsRoot({})).toBeNull();
  });

  it("picks this checkout's local install, then its project install, then the user's, of the declared marketplace", () => {
    const installs = [{ scope: 'user', version: '1.0.0' }, { scope: 'project', projectPath: '/r', version: '2.0.0' }, { scope: 'local', projectPath: '/r', version: '3.0.0' }, { scope: 'local', projectPath: '/other', version: '4.0.0' }];
    const known = JSON.stringify({ tools: { source: { source: 'git', url: 'https://github.com/yedeya-labs/kanon.git', ref: 'v3.0.0' } }, other: { source: { source: 'github', repo: 'acme/x' } } });
    expect(readMachinePlugin({ known, installed: records({ 'kanon@tools': installs }), name: 'tools', root: '/r', same })).toEqual({ status: 'read', marketplace: { name: 'tools', ref: 'v3.0.0' }, installed: { version: '3.0.0', scope: 'local' } });
    expect(readMachinePlugin({ known, installed: records({ 'kanon@tools': installs.slice(0, 2) }), name: null, root: '/r', same })).toMatchObject({ installed: { version: '2.0.0', scope: 'project' } });
    expect(readMachinePlugin({ known, installed: records({ 'kanon@tools': installs.slice(0, 2) }), name: null, root: '/elsewhere', same })).toMatchObject({ installed: { version: '1.0.0', scope: 'user' } });
    expect(readMachinePlugin({ known, installed: null, name: 'other', root: '/r', same })).toEqual({ status: 'read', marketplace: null, installed: null });
  });

  it('is unchecked with no records, or with records that are not JSON objects', () => {
    expect(readMachinePlugin({ known: null, installed: null, name: null, root: '/r', same }).status).toBe('unchecked');
    expect(readMachinePlugin({ known: '[]', installed: null, name: null, root: '/r', same })).toEqual({ status: 'unchecked', reason: expect.stringContaining('known_marketplaces.json is not a JSON object') });
  });

  it('compares an installed version with a release, a candidate as its release, and nothing that is not a version', () => {
    expect(installedBehind('0.38.0', 'v0.42.0')).toBe(true);
    expect(installedBehind('0.42.0', 'candidate-v0.42.0')).toBe(false);
    expect(installedBehind('0.43.0', 'v0.42.0')).toBe(false);
    expect(installedBehind('0.42.0', 'v0.42.1')).toBe(true);
    expect(installedBehind('f004877ceb7e', 'v0.42.0')).toBeNull();
  });
});
