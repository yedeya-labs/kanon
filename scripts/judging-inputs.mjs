// The inputs a lane that judges a pull request reads from the default branch, never from the
// pull request (`K-MERGE-17`, kanon#25).
//
// ONE LIST. `JUDGING_INPUTS` is `K-MERGE-17`'s table, row for row, and everything that pins
// a judging input reads it from here: the review lane's restore step (through
// `restore-judging-inputs.sh`), the digest it records before any of the PR's code runs and
// re-checks after, and the review filter's "this push touches the reviewer's own inputs"
// carve-out. `tests/unit/judging-inputs.test.ts` fails when this list and the rule's table
// disagree, so a new input is added to both or to neither.
//
// WHAT EACH ROW MATCHES. A pattern ending in `/` is everything under that directory; `*`
// matches within one path segment; anything else is one file. The rule's one exception, the
// spec corpus (`K-SPEC-1`), is never an input, even when an instruction links to a spec.
//
// "ANYTHING THE INPUTS ABOVE DELEGATE TO". A document the judge is told to trust can send it
// to another document, and pinning the first while the second comes from the PR reopens the
// gap one document over. So the set is closed over delegation: every markdown document that a
// markdown input links to (`[text](path)`) or imports (`@path`, how `CLAUDE.md` pulls in
// `AGENTS.md`), resolved against the linking file, and so on until nothing new is reached.
// Only markdown documents are followed: a link to source code is a pointer at the work under
// review, not an instruction, and pinning it would review the PR against base's code. Links
// inside fenced code blocks are examples and are not followed; nor are URLs.
//
// THREE READERS of one tree: a git revision (what the default branch holds, for the restore),
// the working tree on disk (for the digest, which must not ask git: by then the PR's code has
// run and may have rewritten `.git`), and the GitHub API at a ref (for the review filter,
// which has no checkout). The set is the same function of the tree in all three.
//
// NODE BUILTINS ONLY: lanes run it from the action cache through `kanon-path`, before any
// install, and the review filter runs it in a job with no checkout.
//
// CLI:
//   restore-set <rev>        the paths to restore: the inputs at <rev>, plus every tracked
//                            path in the working tree that matches a row (so a file the PR
//                            adds where base has none is taken out). Run in the checkout.
//   manifest                 `<sha256>  <path>` for every input on disk, sorted.
//   select --api <repo> --ref <ref>
//                            reads paths on stdin and prints the ones that are inputs at
//                            <ref>, read over the API (`gh`).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * `K-MERGE-17`'s table. `input` is the rule's first column, exactly; `rule` is every path the
 * rule's second column names in backticks; `patterns` is what this module matches. The last
 * row has no pattern of its own: it is the closure described above.
 *
 * @type {ReadonlyArray<{ input: string, rule: readonly string[], patterns: readonly string[] }>}
 */
export const JUDGING_INPUTS = [
  { input: "The project's agent instructions", rule: ['AGENTS.md', 'CLAUDE.md'], patterns: ['AGENTS.md', 'CLAUDE.md'] },
  { input: 'The agent configuration', rule: ['.claude/'], patterns: ['.claude/'] },
  { input: 'The identity register', rule: ['docs/qa/agent-identities.md'], patterns: ['docs/qa/agent-identities.md'] },
  { input: 'The sign-off delegation', rule: ['docs/qa/sign-off-delegation.md'], patterns: ['docs/qa/sign-off-delegation.md'] },
  { input: 'The other pipeline documents', rule: ['docs/qa/'], patterns: ['docs/qa/*.md'] },
  { input: 'The project-setup hook', rule: ['.github/actions/project-setup'], patterns: ['.github/actions/project-setup/'] },
  { input: 'Anything the inputs above delegate to', rule: [], patterns: [] },
];

/** The rule's one exception (`K-SPEC-1`): read from the PR, never an input. */
export const NEVER_AN_INPUT = 'docs/qa/specs/';

/** @param {string} pattern @returns {(path: string) => boolean} */
const matcher = (pattern) => {
  if (pattern.endsWith('/')) return (p) => p.startsWith(pattern);
  if (!pattern.includes('*')) return (p) => p === pattern;
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
  return (p) => re.test(p);
};
const MATCHERS = JUDGING_INPUTS.flatMap((row) => row.patterns.map(matcher));

/**
 * Does a path match one row's own patterns?
 *
 * @param {{ patterns: readonly string[] }} row
 * @param {string} path
 */
export const matchesRow = (row, path) => row.patterns.some((p) => matcher(p)(path));

/** Does a path match one of the rows that name paths (everything but delegation)? @param {string} path */
export const matchesARow = (path) => !path.startsWith(NEVER_AN_INPUT) && MATCHERS.some((m) => m(path));

/** The directories a row's patterns can match files under, to list without walking the tree. */
const ROOTS = [...new Set(JUDGING_INPUTS.flatMap((row) => row.patterns).map((p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.')))];

/**
 * The repository-relative markdown documents a markdown file delegates to.
 *
 * @param {string} from the linking file's path
 * @param {string} text its content
 * @returns {string[]}
 */
export function delegatedFrom(from, text) {
  const out = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const targets = [...line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1] ?? '');
    const imported = /^@(\S+)\s*$/.exec(line.trim());
    if (imported?.[1]) targets.push(imported[1]);
    for (const raw of targets) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#')) continue;
      let target = raw.split('#')[0] ?? '';
      try {
        target = decodeURIComponent(target);
      } catch {
        continue;
      }
      if (!target.endsWith('.md')) continue;
      const resolved = target.startsWith('/') ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(posix.dirname(from), target));
      if (resolved.startsWith('../') || resolved === '..') continue;
      out.push(resolved);
    }
  }
  return out;
}

/**
 * @typedef {{
 *   under: (dir: string) => string[],
 *   isFile: (path: string) => boolean,
 *   read: (path: string) => string | null,
 * }} Reader a tree: the regular files under a directory, whether a path is a regular file,
 *   and a regular file's content
 */

/**
 * Every judging input in a tree: the rows' matches, closed over delegation.
 *
 * @param {Reader} tree
 * @returns {string[]} sorted
 */
export function judgingInputs(tree) {
  const found = new Set(ROOTS.flatMap((root) => tree.under(root)).filter(matchesARow));
  const queue = [...found];
  while (queue.length) {
    const path = /** @type {string} */ (queue.shift());
    if (!path.endsWith('.md')) continue;
    const text = tree.read(path);
    if (text === null) continue;
    for (const target of delegatedFrom(path, text)) {
      if (found.has(target) || target.startsWith(NEVER_AN_INPUT) || !tree.isFile(target)) continue;
      found.add(target);
      queue.push(target);
    }
  }
  return [...found].sort();
}

/** @param {string[]} args @param {string} [cwd] @returns {Buffer} */
const git = (args, cwd) => execFileSync('git', args, { cwd, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * A git revision, read with `git ls-tree` and `git cat-file`. Symbolic links and submodules
 * are listed (the restore replaces them) but never read or followed.
 *
 * @param {string} rev
 * @param {string} [cwd]
 * @returns {Reader}
 */
export function gitReader(rev, cwd) {
  /** @type {Map<string, string>} path → mode */
  const modes = new Map();
  for (const entry of git(['ls-tree', '-r', '-z', '--full-tree', rev], cwd).toString('utf8').split('\0')) {
    const m = /^(\d+) \w+ [0-9a-f]+\t(.+)$/s.exec(entry);
    if (m?.[1] && m[2]) modes.set(m[2], m[1]);
  }
  const regular = (/** @type {string} */ p) => modes.get(p) === '100644' || modes.get(p) === '100755';
  return {
    under: (dir) => [...modes.keys()].filter((p) => dir === '.' ? !p.includes('/') : p.startsWith(`${dir}/`)),
    isFile: regular,
    read: (p) => (regular(p) ? git(['cat-file', 'blob', `${rev}:${p}`], cwd).toString('utf8') : null),
  };
}

/**
 * The working tree on disk, without asking git. A symbolic link is not a regular file, so it
 * is neither listed nor followed: a guarded file swapped for a link drops out of the set.
 *
 * @param {string} [root]
 * @returns {Reader}
 */
export function diskReader(root = '.') {
  /** @param {string} p */
  const stat = (p) => {
    try {
      return lstatSync(posix.join(root, p));
    } catch {
      return undefined;
    }
  };
  /** @param {string} dir @returns {string[]} */
  const walk = (dir) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = readdirSync(posix.join(root, dir), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.flatMap((e) => {
      const p = dir === '.' ? e.name : `${dir}/${e.name}`;
      if (e.isDirectory()) return dir === '.' ? [] : walk(p);
      return e.isFile() ? [p] : [];
    });
  };
  return {
    under: walk,
    isFile: (p) => stat(p)?.isFile() ?? false,
    read: (p) => (stat(p)?.isFile() ? readFileSync(posix.join(root, p), 'utf8') : null),
  };
}

/**
 * A ref of a GitHub repository, read with `gh api`: one recursive tree read, then one content
 * read per markdown input. Any failed read throws.
 *
 * @param {string} repo `owner/name`
 * @param {string} ref
 * @returns {Reader}
 */
export function apiReader(repo, ref) {
  const gh = (/** @type {string[]} */ args) => execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  /** @type {{ truncated?: boolean, tree?: Array<{ path: string, type: string, mode: string }> }} */
  const listing = JSON.parse(gh([`repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`]));
  if (listing.truncated) throw new Error(`the tree of ${repo}@${ref} is too large to read in one request`);
  const regular = new Set((listing.tree ?? []).filter((e) => e.type === 'blob' && (e.mode === '100644' || e.mode === '100755')).map((e) => e.path));
  return {
    under: (dir) => [...regular].filter((p) => (dir === '.' ? !p.includes('/') : p.startsWith(`${dir}/`))),
    isFile: (p) => regular.has(p),
    read: (p) => (regular.has(p) ? gh([`repos/${repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, '-H', 'Accept: application/vnd.github.raw']) : null),
  };
}

/**
 * `<sha256>  <path>` per input on disk, sorted, the form `sha256sum` prints.
 *
 * @param {string} [root]
 * @returns {string}
 */
export function manifest(root = '.') {
  return judgingInputs(diskReader(root))
    .map((p) => `${createHash('sha256').update(readFileSync(posix.join(root, p))).digest('hex')}  ${p}`)
    .join('\n');
}

/** @param {string[]} argv @returns {number} */
export function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  try {
    if (command === 'restore-set' && rest[0]) {
      const tracked = git(['ls-files', '-z']).toString('utf8').split('\0').filter((p) => p && matchesARow(p));
      const paths = new Set([...judgingInputs(gitReader(rest[0])), ...tracked]);
      process.stdout.write([...paths].sort().map((p) => `${p}\n`).join(''));
      return 0;
    }
    if (command === 'manifest' && rest.length === 0) {
      const text = manifest();
      process.stdout.write(text ? `${text}\n` : '');
      return 0;
    }
    if (command === 'select' && rest[0] === '--api' && rest[1] && rest[2] === '--ref' && rest[3]) {
      const inputs = new Set(judgingInputs(apiReader(rest[1], rest[3])));
      const asked = readFileSync(0, 'utf8').split('\n').filter(Boolean);
      process.stdout.write(asked.filter((p) => inputs.has(p)).map((p) => `${p}\n`).join(''));
      return 0;
    }
  } catch (e) {
    const err = /** @type {{ stderr?: Buffer | string, message?: string }} */ (e);
    console.error(`judging-inputs: ${String(err.stderr || err.message || e).trim()}`);
    return 1;
  }
  console.error('usage: judging-inputs.mjs restore-set <rev> | manifest | select --api <owner/name> --ref <ref>');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
