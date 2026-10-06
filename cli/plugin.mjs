// The `kanon` Claude Code plugin, declared at project scope (#376; docs/skills.md).
//
// The plugin that ships the skills (`.claude-plugin/`, `skills/`, ADR 0014) is installed from
// Kanon's own repository, which is also its marketplace. Installed with `claude plugin
// marketplace add`, its release lives in each person's Claude Code configuration, where neither
// Dependabot nor `kanon doctor` sees it. A repository can declare it instead, in the project's
// `.claude/settings.json`, with the two keys Claude Code documents for that
// (https://code.claude.com/docs/en/plugins/org#require-plugins-per-repository):
//
//   - `extraKnownMarketplaces.<name>.source`, a `github` source with `repo` and `ref`, a branch
//     or tag (https://code.claude.com/docs/en/plugins/marketplace-reference#marketplace-sources):
//     the marketplace, pinned to a release tag;
//   - `enabledPlugins["kanon@<name>"]: true`: the plugin, on for everyone in the repository
//     (https://code.claude.com/docs/en/settings-reference#enabledplugins).
//
// Claude Code honours the marketplace only once the person trusts the folder, and re-fetches a
// declared marketplace whose source changed in settings
// (https://code.claude.com/docs/en/plugins/loading), so moving the plugin to a release is one
// edit of `ref`. `kanon init` offers to write the declaration, and `kanon doctor` reports a
// `ref` that differs from the release it checks against (`plugin.version-mismatch`).
//
// Node built-ins only: this runs from a Kanon checkout or through `npx`, with no install.

/** Where a project declares its Claude Code settings for everyone in the repository. */
export const SETTINGS_PATH = '.claude/settings.json';

/** The marketplace's name, `.claude-plugin/marketplace.json`'s, and the plugin's. */
export const MARKETPLACE = 'kanon';
export const PLUGIN = 'kanon';

/** The repository the marketplace is, in `owner/repo` form. */
export const KANON_MARKETPLACE_REPO = 'yedeya-labs/kanon';

/** @param {unknown} v @returns {v is Record<string, any>} */
const isMap = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The declaration's keys, pinned to `release`: what `kanon init` writes, or merges by hand.
 * @param {string} release
 */
export const pluginSettings = (release) => ({
  extraKnownMarketplaces: { [MARKETPLACE]: { source: { source: 'github', repo: KANON_MARKETPLACE_REPO, ref: release } } },
  enabledPlugins: { [`${PLUGIN}@${MARKETPLACE}`]: true },
});

/** `.claude/settings.json` holding the declaration alone. @param {string} release */
export const pluginSettingsFile = (release) => `${JSON.stringify(pluginSettings(release), null, 2)}\n`;

/**
 * Whether a marketplace source is Kanon's repository: a `github` source naming it, or a `git`
 * source cloning it from github.com.
 * @param {unknown} source
 */
export const isKanonSource = (source) => {
  if (!isMap(source)) return false;
  if (source.source === 'github') return typeof source.repo === 'string' && source.repo.trim().toLowerCase() === KANON_MARKETPLACE_REPO;
  if (source.source === 'git') return typeof source.url === 'string' && /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[/:]yedeya-labs\/kanon(?:\.git)?\/?$/i.test(source.url.trim());
  return false;
};

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
  const markets = doc.extraKnownMarketplaces !== undefined ? doc.extraKnownMarketplaces : doc.additionalMarketplaces;
  const enabled = isMap(doc.enabledPlugins) ? doc.enabledPlugins : {};
  const found = Object.entries(isMap(markets) ? markets : {}).find(([, m]) => isMap(m) && isKanonSource(m.source));
  if (!found) return { status: 'undeclared', enabled: Object.keys(enabled).filter((k) => k.startsWith(`${PLUGIN}@`) && enabled[k] === true) };
  const [name, entry] = found;
  const ref = typeof entry.source.ref === 'string' && entry.source.ref.trim() ? entry.source.ref.trim() : null;
  return { status: 'declared', name, ref, enabled: enabled[`${PLUGIN}@${name}`] === true };
};
