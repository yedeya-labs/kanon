import { describe, expect, it, vi } from 'vitest';
import { EXIT, UNWAIVABLE, WAIVER_LABEL } from '../../cli/doctor.mjs';
import { isKanonSource, pluginSettingsFile, readPluginDeclaration } from '../../cli/plugin.mjs';
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

// #376: a project declares the kanon plugin in its .claude/settings.json (docs/skills.md), and
// doctor compares the declared release with the one it checks against, without blocking.
describe("kanon doctor and the kanon plugin's declared release (#376)", () => {
  const SETTINGS = '.claude/settings.json';
  const declared = (ref: string | null, over: { name?: string; source?: Record<string, unknown>; enabled?: boolean } = {}) => {
    const name = over.name ?? 'kanon';
    const source = over.source ?? { source: 'github', repo: 'yedeya-labs/kanon', ...(ref === null ? {} : { ref }) };
    return `${JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, extraKnownMarketplaces: { [name]: { source } }, enabledPlugins: { [`kanon@${name}`]: over.enabled ?? true } }, null, 2)}\n`;
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
      fix: { text: `Set the "kanon" marketplace's ref in ${SETTINGS} to ${PINNED}. Claude Code fetches the marketplace again from the changed source; run /reload-plugins in a session that is open.`, commands: [`"ref": "${PINNED}"`], url: null },
    }]);
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
