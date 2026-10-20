/**
 * The release announcement (kanon#1190): the producer of Kanon's `release` message (plan 0011
 * §3.2), for a repository that releases without deploying. Run by the release-announce lane's
 * `announce` job (`agent-release-announce.yml`), once per published release. It writes one
 * `message.json` for the lane to upload, and the lane's `notify` job posts it with the kind's
 * secret, `KANON_CHAT_RELEASE`. It never posts and never reads a chat secret.
 *
 * WHAT IT ANNOUNCES (the Owner's decisions of 2026-10-20): the published release whose tag is
 * `TAG`, read from GitHub. A stable release and a pre-release both post, and both are `info`; a
 * pre-release says so, "pre-release" and "candidate", in its title and summary. Its notes become
 * Features, Fixes and Maintenance, read from the release body with the helpers the deploy
 * announcement reads it with (`scripts/lib/release-notes.mjs`), each note's line through `literal`.
 * A draft announces nothing: the event says so before anything is read (`DRAFT`), and a release
 * GitHub returns as a draft is skipped the same way. A tag with no published release fails by name.
 *
 * Nothing records what was announced: each published release fires the lane once, and a dispatch
 * with the tag announces it again.
 *
 * It makes requests to GitHub's API and nowhere else, and only reads.
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, TAG (the release's tag), DRAFT (`true` when the event's
 * release is a draft), MESSAGE_PATH (default `message.json`), GITHUB_SERVER_URL and GITHUB_RUN_ID
 * (the run link), GITHUB_OUTPUT (`message=<path>`, empty when there is nothing to announce),
 * GITHUB_STEP_SUMMARY (a dry run's rendering), DRY_RUN (print, write nothing).
 *
 * Locally, exactly as CI runs it:
 *   GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=<owner>/<repo> TAG=v1.2.3 DRY_RUN=1 \
 *   node scripts/announce-release.mjs
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { payload } from '../actions/notify/slack/slack.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { describeErrors, fit, literal, renderText, validate } from './lib/notify-contract.mjs';
import { classify, kanonList, kanonMaint, parseSections, scopeOf } from './lib/release-notes.mjs';

/** The one host it makes requests to. */
export const API = 'https://api.github.com';

/** `owner/name`, as GitHub spells them; anything else never reaches a request's path. */
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
/**
 * A tag, as git allows one to be named: no whitespace or control character, none of `~^:?*[\`,
 * and no `..`. Any project's scheme passes (`v1.2.3`, `widgets@1.2.3`, `candidate-v1.2.3`): a
 * repository that releases without deploying tags as it likes.
 */
// eslint-disable-next-line no-control-regex -- a tag refuses control characters by name
const TAG = /^(?!.*\.\.)[^\u0000- \u007f~^:?*[\\]{1,255}$/;

/**
 * @typedef {{ fetch: typeof fetch, writeFile: (path: string, text: string) => void, appendFile: (path: string, text: string) => void }} Io
 * @typedef {{ log: (s: string) => void, error: (s: string) => void }} Out
 * @typedef {Record<string, string | undefined>} Env
 * @typedef {{ tag_name: string, name?: string | null, body?: string | null, draft?: boolean, prerelease?: boolean }} Release
 */

/**
 * One `release` message for a published release, fitted to the contract (§3.3).
 * @param {{ repo: string, release: Release, server?: string, runUrl: string }} args
 * @returns {Record<string, any>}
 */
export function buildReleaseMessage({ repo, release, server = 'https://github.com', runUrl }) {
  /** @type {string[]} */ const features = [];
  /** @type {string[]} */ const fixes = [];
  /** @type {string[]} */ const maint = [];
  for (const [heading, bullets] of Object.entries(parseSections(release.body || ''))) {
    for (const raw of /** @type {string[]} */ (bullets)) {
      const bucket = classify(heading, scopeOf(raw));
      (bucket === 'feature' ? features : bucket === 'fix' ? fixes : maint).push(raw);
    }
  }

  const tag = release.tag_name;
  const pre = release.prerelease === true;
  const name = String(release.name ?? '').trim();
  const named = name && name !== tag ? `, “${literal(name)}”` : '';
  const title = pre ? `${repo} ${tag} is a pre-release` : `${repo} ${tag} is released`;
  const summary = pre
    ? `**${literal(repo)}** published the **pre-release** **${literal(tag)}**${named}, a candidate: not yet a stable release.`
    : `**${literal(repo)}** published the release **${literal(tag)}**${named}.`;

  const sections = [
    { heading: 'Features', body: kanonList(features) },
    { heading: 'Fixes', body: kanonList(fixes) },
    { heading: 'Maintenance', body: kanonMaint(maint) },
  ].filter((s) => s.body !== '');

  return fit({
    kind: 'release',
    severity: 'info',
    title,
    summary,
    sections,
    links: [{ label: `Release ${tag}`, url: `${server}/${repo}/releases/tag/${encodeURIComponent(tag)}` }],
    source: { repository: repo, lane: 'release-announce', run_url: runUrl },
  });
}

/**
 * Write the release's `release` message, or nothing for a draft. Returns the exit code.
 * @param {{ env: Env, io: Io, out: Out }} args
 */
export async function produce({ env, io, out }) {
  const missing = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'TAG'].filter((k) => !env[k]);
  if (missing.length) { out.error(`Missing required env: ${missing.join(', ')}`); return 1; }
  const repo = /** @type {string} */ (env.GITHUB_REPOSITORY);
  const tag = /** @type {string} */ (env.TAG);
  if (!REPOSITORY.test(repo)) { out.error('GITHUB_REPOSITORY is not owner/name.'); return 1; }
  if (!TAG.test(tag)) { out.error('TAG is not a tag: one line, at most 255 characters, with no space, control character, `..` or any of ~^:?*[\\.'); return 1; }
  const dryRun = Boolean(env.DRY_RUN);
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  if (!/^https:\/\/[^\s/]+$/.test(server)) { out.error('GITHUB_SERVER_URL is not an https:// origin.'); return 1; }
  if (!env.GITHUB_RUN_ID && !dryRun) { out.error('Missing required env: GITHUB_RUN_ID'); return 1; }
  const runId = env.GITHUB_RUN_ID && /^\d+$/.test(env.GITHUB_RUN_ID) ? env.GITHUB_RUN_ID : '';
  const runUrl = runId ? `${server}/${repo}/actions/runs/${runId}` : `${server}/${repo}/actions`;
  const output = (/** @type {string} */ value) => { if (env.GITHUB_OUTPUT) io.appendFile(env.GITHUB_OUTPUT, `message=${value}\n`); };
  const draft = () => {
    out.log(`Nothing to announce: ${tag} is a draft release, and a draft announces nothing.`);
    output('');
    return 0;
  };
  if (env.DRAFT === 'true') return draft();

  const res = await io.fetch(`${API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (res.status === 404) { out.error(`GitHub has no published release tagged ${tag}, so there is nothing to announce.`); return 1; }
  if (!res.ok) { out.error(`GitHub GET /releases/tags/${tag} → ${res.status}`); return 1; }
  const release = /** @type {Release} */ (await res.json());
  if (release?.tag_name !== tag) { out.error(`GitHub answered for /releases/tags/${tag} with another release.`); return 1; }
  if (release.draft) return draft();

  const message = buildReleaseMessage({ repo, release, server, runUrl });
  const checked = validate(message);
  if (!checked.ok) {
    out.error(`The release message is invalid: ${describeErrors(checked.errors)}`);
    return 1;
  }
  const what = `${tag}${release.prerelease ? ', a pre-release' : ''}`;

  if (dryRun) {
    const shown = [
      `DRY RUN: would announce ${what}; nothing is written or uploaded.`,
      '', '--- message.json ---', JSON.stringify(message, null, 2),
      '', '--- text (what a hook gets as `text`) ---', renderText(message),
      '', "--- Kanon's Slack hook's payload ---", JSON.stringify(payload(message), null, 2),
    ].join('\n');
    out.log(shown);
    if (env.GITHUB_STEP_SUMMARY) io.appendFile(env.GITHUB_STEP_SUMMARY, `\`\`\`\n${shown}\n\`\`\`\n`);
    output('');
    return 0;
  }

  const path = env.MESSAGE_PATH || 'message.json';
  io.writeFile(path, `${JSON.stringify(message, null, 2)}\n`);
  output(path);
  out.log(`Wrote the release message for ${what} to ${path}. The notify job posts it.`);
  return 0;
}

/**
 * The CLI. Returns the exit code.
 * @param {{ argv: string[], env: Env, io: Io, out?: Out }} args
 */
export async function main({ argv, env, io, out = console }) {
  if (argv.length) {
    out.error(`Unknown argument: ${argv[0]}. It takes none.`);
    return 1;
  }
  return produce({ env, io, out });
}

if (isCliEntry(import.meta.url)) {
  const io = /** @type {Io} */ ({
    fetch: globalThis.fetch,
    writeFile: (p, t) => writeFileSync(p, t),
    appendFile: (p, t) => appendFileSync(p, t),
  });
  process.exitCode = await main({ argv: process.argv.slice(2), env: process.env, io });
}
