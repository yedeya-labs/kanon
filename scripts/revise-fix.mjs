// Runs the fix commands of a hand-back's failed checks, in the revise lane, before any model run
// (kanon#1173), and pushes what they rewrote.
//
// The Merger names each failed check's fix by its key in `lib/fix-commands.mjs`, and only when
// every failed check has one. `run` runs those keys' commands from that file, in the checkout of
// the pull request's branch, then each check's own command, which must pass, and writes the files
// they rewrote to `--out`. Anything else, a key that isn't on the list, a command that fails, a
// check still red after its fix, or a fix that changed nothing, is `changed=false` with the reason,
// and the lane's model run gets the hand-back as before.
//
// TWO JOBS, BECAUSE OF `K-AGENT-49`. A job that checks out the pull request's branch holds no App
// key, so `run` works on a checkout with the workflow's read token and pushes nothing. `push` runs
// in a job with the Implementer's token and no checkout: it commits the files over the API, on top
// of the head the Merger handed back, and moves the branch only if it is still there. The commit is
// the App's, and carries the delegate's sign-off from the default branch's record, as an agent's
// commit does (`K-AGENT-44`).
//
// Usage: node scripts/revise-fix.mjs run --checks <key>[,<key>]... --base <commit> --out <file>
//        node scripts/revise-fix.mjs push --change <file> --branch <name> --head <sha> --message <text>
// `run` writes `changed=true|false` and `why=<reason>` to `$GITHUB_OUTPUT`, and `push` writes
// `pushed=true` and `sha=<commit>`. `KANON` is the Kanon tree whose commands run; it defaults to
// the one this file is in. `push` reads `GH_TOKEN` and `REPO`.

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandsFor } from './lib/fix-commands.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { DELEGATION_PATH, parseDelegation } from '../actions/dco/dco.mjs';

/**
 * @typedef {{path: string, mode: string, content: string}} ChangedFile  `content` is base64.
 * @typedef {{files: ChangedFile[]}} Change
 */

/** The project's workflow files' text, where its CI says how it runs each check. */
const readWorkflows = (/** @type {string} */ cwd) => {
  const dir = join(cwd, '.github', 'workflows');
  try {
    return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => readFileSync(join(dir, f), 'utf8'));
  } catch {
    return [];
  }
};

const tail = (/** @type {string} */ s) => s.trim().split('\n').slice(-3).join(' / ');

/**
 * The files the working tree changed from `HEAD`, each with its mode and content, or a reason it
 * isn't a change this lane pushes: a fix command only rewrites files that exist.
 *
 * @returns {{change: Change}|{why: string}}
 */
export function changeOf(/** @type {string} */ cwd) {
  const git = (/** @type {string[]} */ a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
  const status = git(['status', '--porcelain', '-z', '--untracked-files=no']).split('\0').filter(Boolean);
  const files = [];
  for (const entry of status) {
    const [code, path] = [entry.slice(0, 2), entry.slice(3)];
    if (code.trim() !== 'M') return { why: `\`${path}\` is ${code.trim()}, and a fix command only rewrites files that exist` };
    const mode = git(['ls-files', '-s', '--', path]).split(' ')[0] ?? '';
    if (!/^100(644|755)$/.test(mode)) return { why: `\`${path}\` has mode ${mode}, not a regular file` };
    files.push({ path, mode, content: readFileSync(join(cwd, path)).toString('base64') });
  }
  return { change: { files } };
}

/**
 * @param {{keys: string[], base: string, kanon: string, cwd?: string,
 *          run?: (argv: string[]) => {ok: boolean, output: string}}} opts
 * @returns {{changed: boolean, why: string, ran: string[][], change?: Change}}
 */
export function reviseFix({ keys, base, kanon, cwd = process.cwd(), run }) {
  const exec = run ?? ((argv) => {
    try {
      return { ok: true, output: execFileSync(argv[0] ?? '', argv.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) {
      const err = /** @type {{stdout?: string, stderr?: string}} */ (e);
      return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  });
  /** @type {string[][]} */
  const ran = [];
  if (!keys.length) return { changed: false, why: 'the hand-back named no fix command', ran };
  if (!base) return { changed: false, why: 'no base commit to take the diff against', ran };
  const plan = commandsFor(keys, { kanon, base, workflows: readWorkflows(cwd) });
  if ('unknown' in plan) return { changed: false, why: `\`${plan.unknown}\` is not a check with a fix command Kanon knows`, ran };
  for (const { key, fix, verify } of plan.commands) {
    ran.push(fix);
    const f = exec(fix);
    if (!f.ok) return { changed: false, why: `${key}'s fix command failed: ${tail(f.output)}`, ran };
    ran.push(verify);
    const v = exec(verify);
    if (!v.ok) return { changed: false, why: `${key} still fails after its fix command: ${tail(v.output)}`, ran };
  }
  const c = changeOf(cwd);
  if ('why' in c) return { changed: false, why: c.why, ran };
  if (!c.change.files.length) return { changed: false, why: `the fix command of ${keys.join(', ')} changed nothing`, ran };
  return { changed: true, why: `ran the fix command of ${keys.join(', ')}`, ran, change: c.change };
}

/**
 * The delegate's `Signed-off-by:` trailer from the default branch's record, or `''` with a warning
 * when there is none or it is malformed: the commit then fails the `dco` check, which is the rule's
 * own outcome for a repository that delegates nothing, as `agent-commits.sh` says.
 *
 * @param {(args: string[], input?: unknown) => string} gh
 */
export function signOff(gh, /** @type {string} */ repo) {
  let text;
  try {
    text = gh(['api', `repos/${repo}/contents/${DELEGATION_PATH}`, '-H', 'Accept: application/vnd.github.raw']);
  } catch {
    console.log(`::warning title=revise fix command::${DELEGATION_PATH} could not be read from the default branch, so this commit carries no sign-off (K-AGENT-44)`);
    return '';
  }
  const r = parseDelegation(text);
  if ('problem' in r) {
    console.log(`::warning title=revise fix command::${r.problem}, so this commit carries no sign-off (K-AGENT-44)`);
    return '';
  }
  return `Signed-off-by: ${r.delegate.name} <${r.delegate.email}>`;
}

/**
 * Commit `change` on top of `head` over the API, and move `branch` to it only if it is still at
 * `head`: the ref update isn't forced, so a branch that moved refuses it. The commit's author and
 * committer are the token's App.
 *
 * @param {{change: Change, repo: string, branch: string, head: string, message: string,
 *          gh: (args: string[], input?: unknown) => string}} opts
 * @returns {string} the new commit
 */
export function pushChange({ change, repo, branch, head, message, gh }) {
  if (!change.files.length) throw new Error('nothing to push');
  const post = (/** @type {string} */ path, /** @type {unknown} */ body, method = 'POST') =>
    JSON.parse(gh(['api', '-X', method, `repos/${repo}/${path}`, '--input', '-'], body));
  const baseTree = JSON.parse(gh(['api', `repos/${repo}/git/commits/${head}`])).tree.sha;
  const tree = change.files.map((f) => ({ path: f.path, mode: f.mode, type: 'blob', sha: post('git/blobs', { content: f.content, encoding: 'base64' }).sha }));
  const treeSha = post('git/trees', { base_tree: baseTree, tree }).sha;
  const sha = post('git/commits', { message, tree: treeSha, parents: [head] }).sha;
  post(`git/refs/heads/${branch}`, { sha, force: false }, 'PATCH');
  return sha;
}

if (isCliEntry(import.meta.url)) {
  const arg = (/** @type {string} */ name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? '' : (process.argv[i + 1] ?? '');
  };
  const output = (/** @type {Record<string, string>} */ o) => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(o).map(([k, v]) => `${k}=${String(v).replace(/\n/g, ' ')}\n`).join(''));
  };
  const cmd = process.argv[2];
  if (cmd === 'run') {
    const keys = arg('--checks').split(',').map((k) => k.trim()).filter(Boolean);
    const kanon = process.env.KANON || dirname(dirname(fileURLToPath(import.meta.url)));
    const r = reviseFix({ keys, base: arg('--base'), kanon });
    for (const argv of r.ran) console.log(`ran: ${argv.join(' ')}`);
    console.log(`${r.changed ? 'changed' : 'unchanged'}: ${r.why}`);
    if (r.change) {
      const out = arg('--out');
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(r.change));
      for (const f of r.change.files) console.log(`rewrote: ${f.path}`);
    }
    output({ changed: String(r.changed), why: r.why });
  } else if (cmd === 'push') {
    const repo = process.env.REPO ?? '';
    const gh = (/** @type {string[]} */ args, /** @type {unknown} */ input = undefined) => execFileSync('gh', args, {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input: JSON.stringify(input) }),
    });
    const trailer = signOff(gh, repo);
    const message = trailer ? `${arg('--message').trimEnd()}\n\n${trailer}\n` : `${arg('--message').trimEnd()}\n`;
    const change = /** @type {Change} */ (JSON.parse(readFileSync(arg('--change'), 'utf8')));
    const sha = pushChange({ change, repo, branch: arg('--branch'), head: arg('--head'), message, gh });
    console.log(`pushed ${sha} to ${arg('--branch')}`);
    output({ pushed: 'true', sha });
  } else {
    console.error('usage: revise-fix.mjs run|push …');
    process.exitCode = 2;
  }
}
