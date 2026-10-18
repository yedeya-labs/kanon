// Which files under `.github/` the Dependabot entry that proposes Kanon upgrades reaches
// (K-ADOPT-11, kanon#1105). lane-check counts a Kanon reference in every YAML file there, and
// Dependabot moves one only where its entry looks: from `/` it reads `.github/workflows/`, and a
// composite action's `action.yml` only from the action's own directory. An entry for `/` alone
// left an adopter's project-setup hook at the old release on every upgrade pull request, which
// lane-check's one-version rule then failed. lane-check and `kanon doctor` both read it here.
//
// Dependabot groups an entry's updates into one pull request across its directories, never
// across entries, so one entry has to reach every file. It reads a glob only in `directories`
// (`*` one directory deep, `**` any depth), and `directory` as written.

/** @param {string} d */
const trim = (d) => d.replace(/^\/+|\/+$/g, '');

/**
 * The directories an entry names, each with whether Dependabot reads it as a glob.
 * @param {any} entry @returns {Array<{ dir: string, glob: boolean }>}
 */
const named = (entry) => [
  ...(typeof entry?.directory === 'string' ? [{ dir: entry.directory, glob: false }] : []),
  ...(Array.isArray(entry?.directories) ? entry.directories.filter((/** @type {unknown} */ d) => typeof d === 'string').map((/** @type {string} */ dir) => ({ dir, glob: true })) : []),
];

/** @param {{ dir: string, glob: boolean }} named @param {string} at */
const matches = ({ dir, glob }, at) => {
  if (!glob) return trim(dir) === at;
  const re = trim(dir).split(/(\*\*|\*)/).map((s) => (s === '**' ? '.*' : s === '*' ? '[^/]*' : s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(`^${re}$`).test(at);
};

/**
 * The directory Dependabot updates `file` from, relative to the root (`''` for `/`), or null
 * when it updates no such file: only a workflow directly in `.github/workflows/`, and an action's
 * `action.yml` or `action.yaml`.
 * @param {string} file @returns {string | null}
 */
export const updatedFrom = (file) => {
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)) return '';
  const m = /^(?:(.*)\/)?action\.ya?ml$/.exec(file);
  return m ? (m[1] ?? '') : null;
};

/**
 * The files, of `files`, that the parsed Dependabot entry `entry` doesn't reach.
 * @param {unknown} entry @param {string[]} files @returns {string[]}
 */
export const unreached = (entry, files) => files.filter((f) => {
  const at = updatedFrom(f);
  return at === null || !named(entry).some((n) => matches(n, at));
});

/**
 * The `directories` line that reaches every action of `files` the entry doesn't, keeping the
 * directories it names: `/.github/actions/*` for one under `.github/actions/`, so a hook added
 * later is reached too, and the action's own directory for any other.
 * @param {unknown} entry @param {string[]} files @returns {string}
 */
export const directoriesLine = (entry, files) => {
  const add = unreached(entry, files).map(updatedFrom).filter((at) => at !== null)
    .map((at) => (/^\.github\/actions\/[^/]+$/.test(at) ? '/.github/actions/*' : `/${at}`));
  const dirs = [...new Set([...named(entry).map((n) => n.dir), ...add])];
  return `directories: [${dirs.map((d) => JSON.stringify(d)).join(', ')}]`;
};
