// The kanon plugin's marketplace `ref` a repository declares in `.claude/settings.json`
// (docs/skills.md, "Declare it in the repository"), read the way Claude Code reads the file, for
// lane-check's warning on a pull request whose callers' pin moved and the plugin's `ref` didn't, as
// a Dependabot bump leaves it (kanon#1552). `cli/plugin.mjs`, which `kanon init` and `kanon doctor`
// read the declaration with, takes `isKanonSource` and `kanonMarketplace` from here, so both say
// the same of a source and pick the same marketplace.
// Node built-ins only, and no imports: lane-check runs it from the action's own tree.

/** @param {unknown} v @returns {v is Record<string, any>} */
const isMap = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Whether a marketplace source is Kanon's repository: a `github` source naming it, or a `git`
 * source cloning it from github.com.
 * @param {unknown} source
 */
export const isKanonSource = (source) => {
  if (!isMap(source)) return false;
  if (source.source === 'github') return typeof source.repo === 'string' && source.repo.trim().toLowerCase() === 'yedeya-labs/kanon';
  if (source.source === 'git') return typeof source.url === 'string' && /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[/:]yedeya-labs\/kanon(?:\.git)?\/?$/i.test(source.url.trim());
  return false;
};

/**
 * The `ref` of the marketplace the settings file declares whose source is Kanon's repository:
 * `undefined` when the file declares none, or isn't a JSON object; null when that marketplace has
 * no `ref`, so it follows Kanon's default branch. `additionalMarketplaces` is the alias Claude Code
 * reads only when the canonical key is absent.
 * @param {string | null} text
 * @returns {{ name: string, ref: string | null } | undefined}
 */
export const declaredPluginRef = (text) => {
  if (text === null) return undefined;
  /** @type {unknown} */
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  return kanonMarketplace(doc);
};

/**
 * The marketplace a parsed settings document declares whose source is Kanon's repository, with
 * its `ref` (null when it has none). `additionalMarketplaces`
 * is the alias Claude Code reads only when the canonical key is absent. `cli/plugin.mjs`'s
 * `readPluginDeclaration` picks the marketplace with it too, so the alias lives here alone.
 * @param {unknown} doc
 * @returns {{ name: string, ref: string | null } | undefined}
 */
export const kanonMarketplace = (doc) => {
  if (!isMap(doc)) return undefined;
  const markets = doc.extraKnownMarketplaces !== undefined ? doc.extraKnownMarketplaces : doc.additionalMarketplaces;
  const found = Object.entries(isMap(markets) ? markets : {}).find(([, m]) => isMap(m) && isKanonSource(m.source));
  if (!found) return undefined;
  const ref = found[1].source.ref;
  return { name: found[0], ref: typeof ref === 'string' && ref.trim() ? ref.trim() : null };
};
