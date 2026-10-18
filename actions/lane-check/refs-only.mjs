// Whether the pull request lane-check runs on only moves Kanon's references (kanon#1106). Such a
// pull request is Dependabot's upgrade (K-ADOPT-11), or a person's pin bump, and when it is red
// the release it moves to changes what the callers need: lane-check then says to run
// /kanon:upgrade on the branch, which makes the caller changes Dependabot can't.
//
// It reads what the run already has, and needs no permission the caller doesn't grant: the
// event's payload names the pull request's base (`GITHUB_EVENT_PATH`), and the checkout holds the
// head. actions/checkout leaves one commit, so the base is fetched from `origin` when it isn't
// there, with the token the checkout keeps for `contents: read`, or none on a public repository.
// When the base can't be read at all, a Dependabot branch (`GITHUB_HEAD_REF`) still counts, since
// Dependabot's pull request changes only the refs. Anything else is not refs-only, and lane-check
// prints what it always printed.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** A `uses:` line of a Kanon action or workflow, in a job or a step, its ref and any comment apart. */
const KANON_USES = /^([ \t]*(?:-[ \t]+)?uses:[ \t]*["']?yedeya-labs\/kanon\/[^@\s"']+@)[^\s"'#]+(["']?)[ \t]*(?:#.*)?$/;

/** The line with its ref and comment taken out, or `null` when it is no Kanon `uses:` line. @param {string} line */
const unpinned = (line) => {
  const m = KANON_USES.exec(line);
  return m ? `${m[1]}${m[2]}` : null;
};

/**
 * Whether a `git diff` changes nothing but the refs of Kanon `uses:` lines: in each file, every
 * line it removes and adds is one, and the lines it removes are the lines it adds, but for their
 * refs and comments. A file added, deleted, renamed or binary, or an empty diff, is not.
 * @param {string} diff
 */
export const movesOnlyKanonRefs = (diff) => {
  /** @type {Array<{ removed: string[], added: string[] }>} */
  const files = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { files.push({ removed: [], added: [] }); continue; }
    const file = files.at(-1);
    if (line === '') continue;
    if (!file) return false;
    if ( line.startsWith('index ') || line.startsWith('@@') || line.startsWith('\\ ')) continue;
    if (line.startsWith('--- a/') || line.startsWith('+++ b/')) continue;
    const kept = line.startsWith('-') || line.startsWith('+') ? unpinned(line.slice(1)) : null;
    if (kept === null) return false;
    (line.startsWith('-') ? file.removed : file.added).push(kept);
  }
  const same = (/** @type {string[]} */ a, /** @type {string[]} */ b) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
  return files.length > 0 && files.every((f) => f.removed.length > 0 && same(f.removed, f.added));
};

/** @param {string[]} args */
const git = (args) => spawnSync('git', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 1 << 26, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

/**
 * Whether this run is on a pull request that only moves Kanon's references, read from the
 * runner's variables and the checkout in the working directory.
 * @param {NodeJS.ProcessEnv} env
 */
export const pullRequestMovesOnlyKanonRefs = (env) => {
  if (!['pull_request', 'pull_request_target'].includes(env.GITHUB_EVENT_NAME ?? '')) return false;
  const dependabot = (env.GITHUB_HEAD_REF ?? '').startsWith('dependabot/github_actions/');
  /** @type {unknown} */
  let base = null;
  try { base = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8'))?.pull_request?.base?.sha; } catch { /* no payload */ }
  if (typeof base !== 'string' || !/^[0-9a-f]{40}$/.test(base)) return dependabot;
  const present = () => git(['cat-file', '-e', `${base}^{commit}`]).status === 0;
  if (!present()) git(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--depth=1', 'origin', base]);
  if (!present()) return dependabot;
  const d = git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '-U0', base, 'HEAD']);
  return d.status === 0 ? movesOnlyKanonRefs(d.stdout) : dependabot;
};
