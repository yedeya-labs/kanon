// Which files under `.github/` the Dependabot entry that proposes Kanon upgrades reaches
// (K-ADOPT-11, kanon#1105). lane-check counts a Kanon reference in every YAML file there, and
// Dependabot moves one only where its entry looks: from `/` it reads `.github/workflows/`, and a
// composite action's `action.yml` only from the action's own directory. An entry for `/` alone
// left an adopter's project-setup hook at the old release on every upgrade pull request, which
// lane-check's one-version rule then failed. lane-check and `kanon doctor` both read it here.
//
// Dependabot groups an entry's updates into one pull request across its directories, never
// across entries, so one entry has to reach every file. That holds only for the updates a group
// takes in: an update no group takes in is a pull request of its own, one per dependency and per
// directory (kanon#1126), so the entry also has to group Kanon, `groupsKanon` below. It reads a glob only in `directories`
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

// Which entries are held to that reach (kanon#1111): each one that would open a Kanon upgrade pull
// request, whatever else it sets. A github-actions entry proposes an update to every dependency it
// finds in the directories it reads, grouped or not, unless `allow` leaves the dependency out,
// `ignore` takes in all its updates, or `open-pull-requests-limit: 0` turns version updates off.
// So it proposes Kanon when it reaches a file that pins Kanon and none of those holds. lane-check
// and `kanon doctor` both ask this, so they hold the same entries.

/** @param {unknown} v @returns {v is Record<string, any>} */
const isMap = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Kanon's repository, which every Kanon dependency name starts with. */
const KANON = 'yedeya-labs/kanon';

/**
 * Kanon's dependency names, one of each kind (kanon#1126). Dependabot names an action at a release
 * tag `owner/repo`, whatever the path after it, but a reusable workflow `owner/repo` and its path,
 * so each Kanon lane a caller calls is a dependency of its own (dependabot-core's github_actions
 * file parser). The workflow here is one no pattern naming only some of Kanon's workflows is sure
 * to take in, so such a pattern counts as leaving Kanon's lanes out.
 */
const KANON_NAMES = [KANON, `${KANON}/.github/workflows/any.yml`];

/**
 * Whether the pattern `pattern` matches the dependency name `name`, `*` matching any run of
 * characters, as Dependabot matches it, and without case, as GitHub names a repository.
 * @param {unknown} pattern @param {string} name
 */
const wild = (pattern, name) => typeof pattern === 'string'
  && new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(name);

/** Whether a `dependency-name` matches a Kanon dependency name. @param {unknown} name */
const namesKanon = (name) => KANON_NAMES.some((n) => wild(name, n));

/** The update types that, ignored together, are every update. */
const EVERY_UPDATE = ['version-update:semver-major', 'version-update:semver-minor', 'version-update:semver-patch'];

/**
 * Whether the parsed Dependabot entry `entry` would open a Kanon upgrade pull request, given
 * `files`, the files that pin Kanon. Where a setting's effect on Kanon is unclear it holds the
 * entry: an `allow` item that names a path under Kanon's repository or no dependency, and an empty
 * `allow`.
 * @param {unknown} entry @param {string[]} files @returns {boolean}
 */
export const proposesKanon = (entry, files) => {
  if (!isMap(entry) || entry['package-ecosystem'] !== 'github-actions') return false;
  if (entry['open-pull-requests-limit'] === 0) return false;
  const updated = files.filter((f) => updatedFrom(f) !== null);
  if (unreached(entry, updated).length === updated.length) return false;
  const allow = entry.allow;
  if (Array.isArray(allow) && allow.length && !allow.some((a) => !isMap(a) || typeof a['dependency-name'] !== 'string'
    || namesKanon(a['dependency-name']) || a['dependency-name'].toLowerCase().startsWith(`${KANON}/`))) return false;
  // Every Kanon name ignored, the lanes' workflows as well as the actions (kanon#1126).
  const ignore = Array.isArray(entry.ignore) ? entry.ignore : [];
  return !KANON_NAMES.every((n) => ignore.some((i) => isMap(i) && wild(i['dependency-name'], n) && i.versions === undefined
    && (i['update-types'] === undefined || (Array.isArray(i['update-types']) && EVERY_UPDATE.every((t) => i['update-types'].includes(t))))));
};

// Whether an entry that proposes Kanon groups it (kanon#1126). Dependabot opens "a single pull
// request for each dependency that needs to be updated" unless a group takes it in, and, for one
// dependency across `directories`, "a separate pull request for each directory". Kanon is several
// dependencies, one per lane's workflow, so an entry that leaves any of them out of a group opens
// several Kanon upgrade pull requests, each moving only part of the pins, and each fails the
// one-version rule however well the entry reaches. Where the effect is unclear it counts the group
// as not taking Kanon in whole, and the entry fails, as the entry `kanon init` writes never does.

/** The semver update types a group's `update-types` names, which together take in every update. */
const EVERY_GROUP_UPDATE = ['major', 'minor', 'patch'];

/**
 * Whether the group `g` takes in the dependency `name`: a pattern matches it, or the group names
 * no patterns, and no `exclude-patterns` item matches it.
 * @param {Record<string, any>} g @param {string} name
 */
const takesIn = (g, name) => (g.patterns === undefined || (Array.isArray(g.patterns) && g.patterns.some((p) => wild(p, name))))
  && !(Array.isArray(g['exclude-patterns']) && g['exclude-patterns'].some((p) => wild(p, name)));

/**
 * Whether the parsed Dependabot entry `entry` puts every Kanon update in one group, so its Kanon
 * upgrade is one pull request: the first version-updates group that takes in each Kanon name,
 * Dependabot's rule for a dependency more than one group matches, is the same group for all of
 * them, and that group takes in every update to them, so it sets no `update-types` short of all
 * three, no `dependency-type`, and no `group-by`, which opens one pull request per dependency.
 * @param {unknown} entry @returns {boolean}
 */
export const groupsKanon = (entry) => {
  if (!isMap(entry) || !isMap(entry.groups)) return false;
  const groups = Object.values(entry.groups).filter((g) => isMap(g) && (g['applies-to'] === undefined || g['applies-to'] === 'version-updates'));
  const homes = KANON_NAMES.map((n) => groups.find((g) => takesIn(g, n)));
  const home = homes[0];
  return home !== undefined && homes.every((h) => h === home)
    && home['group-by'] === undefined && home['dependency-type'] === undefined
    && (home['update-types'] === undefined || (Array.isArray(home['update-types']) && EVERY_GROUP_UPDATE.every((t) => home['update-types'].includes(t))));
};

/** The `groups:` item `kanon init` writes, which takes in every Kanon update. */
export const KANON_GROUP = 'kanon: { patterns: ["yedeya-labs/kanon*"] }';

/**
 * How the fix for an entry `groupsKanon` refuses gets the `kanon` group in, one clause both
 * lane-check and `kanon doctor` say (kanon#1159). Where the entry has no group named `kanon`, add
 * it. Where it has one, adding a second writes a duplicate key in the one `groups:` map, which a
 * YAML parser refuses or reads as one of the two (Kanon's own reads the last), so the fix changes
 * that group instead: its `patterns` take in only part of Kanon, or a setting narrows the updates
 * it takes in, or an earlier group takes Kanon in first, since Dependabot puts a dependency in the
 * first group that matches it, so the group moves first as well.
 * @param {unknown} entry @returns {string}
 */
export const kanonGroupFix = (entry) => (isMap(entry) && isMap(entry.groups) && Object.hasOwn(entry.groups, 'kanon')
  ? "Change that entry's `kanon` group, without adding a second one, which would be a duplicate key: set its `patterns` to `[\"yedeya-labs/kanon*\"]`, remove any `exclude-patterns`, `update-types`, `dependency-type`, `group-by` or `applies-to` it sets, and move it first under the entry's `groups:`, so it is the `kanon` group `kanon init` writes"
  : "Add the `kanon` group `kanon init` writes as that entry's first group, under its `groups:`");

/**
 * The entries of the parsed `.github/dependabot.yml`, `doc`, that would open a Kanon upgrade pull
 * request, in order. None when `updates` isn't a list, which Dependabot refuses.
 * @param {unknown} doc @param {string[]} files @returns {unknown[]}
 */
export const kanonEntries = (doc, files) => (isMap(doc) && Array.isArray(doc.updates) ? doc.updates : []).filter((e) => proposesKanon(e, files));

/**
 * How a finding names `entry`, one of the parsed `doc`'s `updates`: its place in the list, with
 * its `target-branch` and the directories it names as written, since a second entry that proposes
 * Kanon often differs from the first only there (kanon#1111).
 * @param {unknown} doc @param {unknown} entry @returns {string}
 */
export const entryName = (doc, entry) => {
  const at = isMap(doc) && Array.isArray(doc.updates) ? doc.updates.indexOf(entry) : -1;
  const said = [
    ...(isMap(entry) && typeof entry['target-branch'] === 'string' ? [`target-branch: ${entry['target-branch']}`] : []),
    ...(isMap(entry) && typeof entry.directory === 'string' ? [`directory: ${entry.directory}`] : []),
    ...(isMap(entry) && Array.isArray(entry.directories) ? [`directories: ${JSON.stringify(entry.directories)}`] : []),
  ];
  return `at \`updates[${at}]\`${said.length ? ` (${said.map((s) => `\`${s}\``).join(', ')})` : ''}`;
};
