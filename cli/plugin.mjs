// The `kanon` Claude Code plugin, declared at project scope (#376; docs/skills.md).
//
// The plugin that ships the skills (`.claude-plugin/`, `skills/`, ADR 0014) is installed from
// Kanon's own repository, which is also its marketplace. Installed with `claude plugin
// marketplace add`, its release lives in each person's Claude Code configuration, where neither
// Dependabot nor `kanon doctor` sees it. A repository can declare it instead, in the project's
// `.claude/settings.json`, with the three keys Claude Code documents for that
// (https://code.claude.com/docs/en/plugins/org#require-plugins-per-repository):
//
//   - `extraKnownMarketplaces.<name>.source`, a `github` source with `repo` and `ref`, a branch
//     or tag (https://code.claude.com/docs/en/plugins/marketplace-reference#marketplace-sources):
//     the marketplace, pinned to a release tag;
//   - `extraKnownMarketplaces.<name>.autoUpdate: true`, beside `source`: Claude Code updates the
//     installed plugin to that `ref` itself (kanon#1578, below);
//   - `enabledPlugins["kanon@<name>"]: true`: the plugin, on for everyone in the repository
//     (https://code.claude.com/docs/en/settings-reference#enabledplugins).
//
// Claude Code honours the marketplace only once the person trusts the folder, and re-fetches a
// declared marketplace whose source changed in settings when a session starts
// (https://code.claude.com/docs/en/plugins/loading), so moving the repository's release is one
// edit of `ref`. The fetch alone doesn't move the installed plugin: with `autoUpdate`, Claude Code
// updates it in the background a few minutes into the session, and without it, it moves with
// `claude plugin update`; in neither case while a marketplace the person added themselves holds
// the old `ref` (#1552; docs/skills.md, "Moving the plugin"). `kanon init` offers to write the
// declaration, and `kanon doctor` reports a `ref` that differs from the release it checks against
// (`plugin.version-mismatch`), a `ref` below Kanon's latest release (`plugin.below-latest`), and
// an installed plugin older than the release it checks against (`plugin.behind`), read from this
// machine's plugin records (below).
//
// Node built-ins only: this runs from a Kanon checkout or through `npx`, with no install.

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { isKanonSource, kanonMarketplace, marketplaces } from '../actions/lane-check/plugin-ref.mjs';

/** Where a project declares its Claude Code settings for everyone in the repository. */
export const SETTINGS_PATH = '.claude/settings.json';

/** The marketplace's name, `.claude-plugin/marketplace.json`'s, and the plugin's. */
export const MARKETPLACE = 'kanon';
export const PLUGIN = 'kanon';

/** The repository the marketplace is, in `owner/repo` form. */
export const KANON_MARKETPLACE_REPO = 'yedeya-labs/kanon';

/** The marketplace entry's key that makes Claude Code update its plugins in the background (kanon#1578). */
export const AUTO_UPDATE = 'autoUpdate';

/** @param {unknown} v @returns {v is Record<string, any>} */
const isMap = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The declaration's keys, pinned to `release`: what `kanon init` writes, or merges by hand. The
 * marketplace entry sets `autoUpdate` (kanon#1578, the Owner's decision of 2026-11-02), so Claude
 * Code updates the installed plugin to the entry's `ref` in the background, with no manual step:
 * the plugin a person runs follows the repository's pin, and nothing newer.
 * @param {string} release
 */
export const pluginSettings = (release) => ({
  extraKnownMarketplaces: { [MARKETPLACE]: { source: { source: 'github', repo: KANON_MARKETPLACE_REPO, ref: release }, [AUTO_UPDATE]: true } },
  enabledPlugins: { [`${PLUGIN}@${MARKETPLACE}`]: true },
});

/** `.claude/settings.json` holding the declaration alone. @param {string} release */
export const pluginSettingsFile = (release) => `${JSON.stringify(pluginSettings(release), null, 2)}\n`;

/** Whether a marketplace source is Kanon's repository; lane-check reads the declaration with it too. */
export { isKanonSource };

/**
 * @typedef {{ status: 'absent' }
 *   | { status: 'unreadable', reason: string }
 *   | { status: 'undeclared', enabled: string[] }
 *   | { status: 'declared', name: string, ref: string | null, enabled: boolean }} PluginDeclaration
 */

/**
 * What a project's `.claude/settings.json` declares of the kanon plugin: no file; a file that
 * isn't a JSON object; no marketplace whose source is Kanon's repository (with any `kanon@…`
 * plugin it enables all the same, from a marketplace someone added to their own configuration);
 * or that marketplace's name, its `ref` (null when it has none, so it follows Kanon's default
 * branch), and whether `kanon@<name>` is enabled. `additionalMarketplaces` is read as Claude
 * Code reads it: the alias, used only when the canonical key is absent.
 * @param {string | null} text
 * @returns {PluginDeclaration}
 */
export const readPluginDeclaration = (text) => {
  if (text === null) return { status: 'absent' };
  /** @type {unknown} */
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { status: 'unreadable', reason: `it is not JSON (${/** @type {Error} */ (e).message})` };
  }
  if (!isMap(doc)) return { status: 'unreadable', reason: 'it is not a JSON object' };
  const enabled = isMap(doc.enabledPlugins) ? doc.enabledPlugins : {};
  const found = kanonMarketplace(doc);
  if (!found) return { status: 'undeclared', enabled: Object.keys(enabled).filter((k) => k.startsWith(`${PLUGIN}@`) && enabled[k] === true) };
  return { status: 'declared', name: found.name, ref: found.ref, enabled: enabled[`${PLUGIN}@${found.name}`] === true };
};

// ── The plugin on the person's machine (#1552) ───────────────────────────────────────────────
//
// What the repository declares is not what a person runs. Claude Code keeps its own records of
// what it fetched, under one plugins root per person (https://code.claude.com/docs/en/plugins/loading,
// "Find plugins on disk"): `known_marketplaces.json`, each marketplace it fetched with its
// `source`, and `installed_plugins.json`, each install with its `scope`, `projectPath` and
// `version`. A marketplace the person added themselves keeps its own `ref` there, and, without
// `autoUpdate` on the marketplace, an installed plugin moves only when Claude Code is asked to
// update it, so the plugin can stay releases behind the repository's `ref` without a word. `kanon doctor` reads those two files, and nothing else
// under the root: never the person's settings, whose `env` can hold a credential, and never a file
// it names. It writes nothing there.

/** The two records doctor reads, relative to the plugins root. */
export const KNOWN_MARKETPLACES = 'known_marketplaces.json';
export const INSTALLED_PLUGINS = 'installed_plugins.json';

/**
 * The plugins root on this machine, as Claude Code finds it: `CLAUDE_CODE_PLUGIN_CACHE_DIR`, which
 * names the root itself; else `plugins` under `CLAUDE_CONFIG_DIR`; else `~/.claude/plugins`. Null
 * when the environment names no home, as a test's or a bare runner's may not.
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export const pluginsRoot = (env) => {
  const at = (/** @type {string | undefined} */ v) => (typeof v === 'string' && v.trim() ? v.trim().replace(/[\\/]+$/, '') : null);
  const cache = at(env.CLAUDE_CODE_PLUGIN_CACHE_DIR);
  if (cache) return cache;
  const config = at(env.CLAUDE_CONFIG_DIR);
  if (config) return `${config}/plugins`;
  const home = at(env.HOME) ?? at(env.USERPROFILE);
  return home ? `${home}/.claude/plugins` : null;
};

/**
 * @typedef {{ status: 'unchecked', reason: string }
 *   | { status: 'read', marketplace: { name: string, ref: string | null } | null, installed: { version: string, scope: string } | null }} MachinePlugin
 */

/**
 * What Claude Code on this machine holds of the kanon plugin for the checkout at `root`, from the
 * two records' text (null for a file that isn't there): the marketplace whose source is Kanon's
 * repository, under `name` when the repository declares one, with the `ref` Claude Code fetched;
 * and the install that applies in the checkout, the most specific scope first, as Claude Code
 * picks it: `local`, then `project`, for this checkout's path, then `user`. Unchecked when neither
 * file is there, as on a CI runner, or one isn't the JSON Claude Code writes.
 * @param {{ known: string | null, installed: string | null, name: string | null, root: string, same: (a: string, b: string) => boolean }} c
 * @returns {MachinePlugin}
 */
export const readMachinePlugin = ({ known, installed, name, root, same }) => {
  if (known === null && installed === null) return { status: 'unchecked', reason: `Claude Code keeps no plugin records on this machine (no ${KNOWN_MARKETPLACES} or ${INSTALLED_PLUGINS} under its plugins root)` };
  /** @param {string | null} text @param {string} file */
  const parse = (text, file) => {
    if (text === null) return {};
    try {
      const doc = JSON.parse(text);
      if (isMap(doc)) return doc;
    } catch {
      // fall through
    }
    throw new Error(`${file} is not a JSON object`);
  };
  /** @type {Record<string, any>} */
  let markets;
  /** @type {Record<string, any>} */
  let installs;
  try {
    markets = parse(known, KNOWN_MARKETPLACES);
    installs = parse(installed, INSTALLED_PLUGINS);
  } catch (e) {
    return { status: 'unchecked', reason: `could not read Claude Code's plugin records: ${/** @type {Error} */ (e).message}` };
  }
  /** @type {[string, Record<string, any>] | null} */
  const found = name !== null
    ? (isMap(markets[name]) && isKanonSource(markets[name].source) ? [name, markets[name]] : null)
    : /** @type {[string, Record<string, any>] | undefined} */ (Object.entries(markets).find(([, m]) => isMap(m) && isKanonSource(m.source))) ?? null;
  const ref = found ? found[1].source.ref : null;
  const marketplace = found ? { name: found[0], ref: typeof ref === 'string' && ref.trim() ? ref.trim() : null } : null;
  const records = isMap(installs.plugins) ? installs.plugins[`${PLUGIN}@${marketplace?.name ?? name ?? MARKETPLACE}`] : null;
  const list = Array.isArray(records) ? records.filter((r) => isMap(r) && typeof r.version === 'string' && typeof r.scope === 'string') : [];
  const here = (/** @type {Record<string, any>} */ r) => typeof r.projectPath === 'string' && same(r.projectPath, root);
  const pick = list.find((r) => r.scope === 'local' && here(r)) ?? list.find((r) => r.scope === 'project' && here(r)) ?? list.find((r) => r.scope === 'user');
  return { status: 'read', marketplace, installed: pick ? { version: pick.version, scope: pick.scope } : null };
};

/**
 * Whether an installed plugin's version is older than a release: `0.38.0` against `v0.42.0` or
 * `candidate-v0.42.0`, a candidate counted as its release. Null when either isn't a version, such
 * as a commit Claude Code recorded for a plugin with no version in its manifest.
 * @param {string} version @param {string} release
 * @returns {boolean | null}
 */
export const installedBehind = (version, release) => {
  const a = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  const b = /^(?:candidate-)?v(\d+)\.(\d+)\.(\d+)$/.exec(release);
  if (!a || !b) return null;
  for (let i = 1; i <= 3; i++) if (Number(a[i]) !== Number(b[i])) return Number(a[i]) < Number(b[i]);
  return false;
};

/**
 * Whether two paths name one directory: Claude Code records a checkout's path as it saw it, which
 * can differ from the checkout's by a link (`/tmp` and `/private/tmp` on macOS).
 * @param {string} a @param {string} b
 */
export const samePath = (a, b) => {
  const real = (/** @type {string} */ p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return resolve(a) === resolve(b) || real(a) === real(b);
};

// ── The marketplace's auto-update (kanon#1578) ────────────────────────────────────────────────
//
// With `"autoUpdate": true` on the repository's marketplace entry, beside `source`, Claude Code
// refreshes the marketplace and updates its installed plugins in the background, a few minutes
// into a session (https://code.claude.com/docs/en/plugins/install#keep-plugins-updated). The
// `ref` still pins the release, so the plugin follows the repository's pin and nothing newer.
// Without it, each person moves their plugin by hand (docs/skills.md, "Moving the plugin").

/**
 * Whether the Kanon marketplace the project's `.claude/settings.json` declares sets
 * `"autoUpdate": true`; null when the file declares none, or can't be read (what
 * `readPluginDeclaration` says of it).
 * @param {string | null} text
 * @returns {boolean | null}
 */
export const declaresAutoUpdate = (text) => {
  const declared = readPluginDeclaration(text);
  if (declared.status !== 'declared') return null;
  const entry = marketplaces(JSON.parse(/** @type {string} */ (text)))[declared.name];
  return isMap(entry) && entry[AUTO_UPDATE] === true;
};

// ── The file Claude Code's own install writes (kanon#1607, point 8) ─────────────────────────
//
// `claude plugin marketplace add --scope project yedeya-labs/kanon#<ref>` and `claude plugin
// install --scope project kanon@kanon` write `.claude/settings.json` with the marketplace's source
// and the plugin's switch, and nothing else: no `autoUpdate`. A person following the install path
// reaches `kanon init` with that file, never committed, so `init` takes it as its own (it rewrites
// it to its template, `autoUpdate` on and `ref` at its release) rather than raising `plugin.declare`
// for the person to merge two keys by hand. A file with anything else in it, or one in git's
// history, stays the project's.

/** @param {Record<string, unknown>} m @param {string[]} allowed */
const onlyKeys = (m, allowed) => Object.keys(m).every((k) => allowed.includes(k));

/**
 * Whether a settings file's text parses to nothing but Kanon's marketplace entry, named `kanon`
 * (its source Kanon's repository, at any `ref`, with or without `"autoUpdate": true`), and, if it
 * enables plugins at all, `kanon@kanon` alone: the file Claude Code's install writes.
 * @param {string | null} text
 */
export const pluginInstallOnly = (text) => {
  if (text === null) return false;
  /** @type {unknown} */
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isMap(doc) || !onlyKeys(doc, ['extraKnownMarketplaces', 'enabledPlugins'])) return false;
  const markets = doc.extraKnownMarketplaces;
  if (!isMap(markets) || !onlyKeys(markets, [MARKETPLACE]) || !isMap(markets[MARKETPLACE])) return false;
  const entry = markets[MARKETPLACE];
  if (!onlyKeys(entry, ['source', AUTO_UPDATE]) || (AUTO_UPDATE in entry && entry[AUTO_UPDATE] !== true)) return false;
  if (!isKanonSource(entry.source) || !onlyKeys(entry.source, ['source', 'repo', 'url', 'ref'])) return false;
  if (doc.enabledPlugins === undefined) return true;
  const enabled = doc.enabledPlugins;
  return isMap(enabled) && onlyKeys(enabled, [`${PLUGIN}@${MARKETPLACE}`]) && enabled[`${PLUGIN}@${MARKETPLACE}`] === true;
};
