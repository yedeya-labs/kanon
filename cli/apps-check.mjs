// `apps-check`: checks each of Kanon's Apps in the register against its installation (#39).
//
// The App register (docs/qa/agent-identities.md, K-LAYOUT-6) is a claim; App scopes live in
// the installation, not in any file (K-AGENT-3). This script, run by
// .github/workflows/apps-check.yml, turns the claim into a check (K-AGENT-5). Two commands:
//
//   node cli/apps-check.mjs apps    prints `apps=<json>` for $GITHUB_OUTPUT: each of the
//                                   Author, the Judge and the Releaser the register lists
//                                   (plan 0005 §3.4: one row per role, its roles sharing a
//                                   slug), with that slug, its roles and its secret prefix.
//   node cli/apps-check.mjs check   checks one App's installation, from the environment the
//                                   workflow sets after minting the App's token.
//
// An App fails when its roles name more than one slug, when the minted App's slug isn't the
// register's, when the installation doesn't cover this repository, or when its permissions
// differ from the App's in rulebook/agent-permissions.json (the `apps` block: the union of
// its roles' rows, plus any broadened permission). It warns when the installation covers ALL
// of its owner's repositories. Covering several is what one App per owner means (plan 0005
// §3.2, `K-ADOPT-8` as amended), so it is no longer a warning.
//
// The register is read with actions/lane-check/app-register.awk, the one reader the lanes
// use, so this check and the lanes can't disagree about what the register says.
//
// `check` also prints one line for `kanon doctor` (#417): `kanon-apps-check/v1 ` and a JSON
// object of the App's key, the minted slug, the App's id and the installation's permissions,
// whether the check passes or fails. A person's token and the workflow's can't read a private
// App, but they can read this run's log; `readResult` is the reader doctor uses.
//
// Node built-ins only. The private key is read from the environment to sign the App JWT
// that reads the installation's permissions; it is never printed or written.

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appJwt, loadRoles, REGISTER_PATH } from './apps.mjs';
import { isCliEntry } from '../scripts/lib/cli-entry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AWK = join(ROOT, 'actions/lane-check/app-register.awk');
const API = 'https://api.github.com';
const HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'kanon-apps-check' };

/** @typedef {{ app: string, roles: string[], permissions: Record<string, string>, optional?: boolean }} AppSpec */
/** @typedef {{ key: string, app: string, slug: string, roles: string[], secret: string }} RegisteredApp */

/** @returns {Record<string, AppSpec>} The `apps` block of rulebook/agent-permissions.json. */
export const loadApps = () => JSON.parse(readFileSync(join(ROOT, 'rulebook/agent-permissions.json'), 'utf8')).apps;

/**
 * Each App the register lists, in the order of agent-permissions.json's `apps` block: an App
 * is listed when any of its roles has a row. Its roles must all name one slug. A role the
 * register doesn't list is skipped; any other complaint from the reader is an error.
 * @param {string} registerPath
 * @param {Record<string, AppSpec>} apps
 * @param {Record<string, { role: string }>} roles
 * @param {(role: string) => { status: number | null, stdout: string, stderr: string }} [read]
 * @returns {RegisteredApp[]}
 */
export const registeredApps = (registerPath, apps, roles, read = (role) => spawnSync('awk', ['-v', `role=${role}`, '-f', AWK, registerPath], { encoding: 'utf8' })) => {
  /** @type {RegisteredApp[]} */
  const found = [];
  for (const [key, spec] of Object.entries(apps)) {
    /** @type {Array<[string, string]>} */
    const rows = [];
    for (const roleKey of spec.roles) {
      const role = roles[roleKey]?.role ?? roleKey[0]?.toUpperCase() + roleKey.slice(1);
      const r = read(role);
      if (r.status === 0) {
        rows.push([role, r.stdout.trim()]);
        continue;
      }
      // No row for the role, or no table at all (a register that says "none installed").
      if (new RegExp(`lists the role ${role} 0 times|has 0 tables headed`).test(r.stderr)) continue;
      throw new Error(r.stderr.trim() || `the register reader exited ${r.status} for ${role}`);
    }
    if (!rows.length) continue;
    const slugs = [...new Set(rows.map(([, s]) => s))];
    if (slugs.length > 1) {
      throw new Error(`${REGISTER_PATH}: the ${spec.app}'s roles name ${slugs.length} App slugs (${rows.map(([r, s]) => `${r} \`${s}\``).join(', ')}); one App, one slug (plan 0005 §3.4)`);
    }
    found.push({ key, app: spec.app, slug: /** @type {string} */ (slugs[0]), roles: rows.map(([r]) => r), secret: key.toUpperCase() });
  }
  if (!found.length) throw new Error(`${REGISTER_PATH} lists no App of Kanon's, so there is nothing to check`);
  return found;
};

/**
 * Compares one installation with the register and the App's permissions.
 * @param {{
 *   app: string,
 *   spec: AppSpec,
 *   registerSlug: string,
 *   appSlug: string,
 *   repository: string,
 *   selection: string,
 *   repositories: string[],
 *   permissions: Record<string, string>,
 * }} a
 * @returns {{ failures: string[], warnings: string[] }}
 */
export const compare = ({ app, spec, registerSlug, appSlug, repository, selection, repositories, permissions }) => {
  /** @type {string[]} */
  const failures = [];
  /** @type {string[]} */
  const warnings = [];
  if (appSlug !== registerSlug) {
    failures.push(`${app}: the minted App is \`${appSlug}\`, but the register says \`${registerSlug}\` (K-AGENT-5).`);
  }
  const want = repository.toLowerCase();
  if (selection === 'all') {
    warnings.push(`${app}: the installation covers ALL repositories of its owner, not only those that adopt Kanon (K-ADOPT-8). Choose "Only select repositories".`);
  } else if (!repositories.some((n) => n.toLowerCase() === want)) {
    failures.push(`${app}: the installation doesn't cover ${repository} (it covers: ${repositories.join(', ') || 'nothing'}).`);
  }
  const expected = spec.permissions;
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(permissions)])].sort();
  const drift = keys.filter((k) => permissions[k] !== expected[k]).map((k) => `${k}: ${permissions[k] ?? 'none'}, expected ${expected[k] ?? 'none'}`);
  if (drift.length) failures.push(`${app}: the installation's permissions differ from the ${app}'s in rulebook/agent-permissions.json: ${drift.join('; ')}.`);
  return { failures, warnings };
};

/** The mark that opens the line `check` prints for doctor; a new shape is a new version. */
export const RESULT_MARK = 'kanon-apps-check/v1';

/** @typedef {{ app: string, slug: string, permissions: Record<string, string> }} Result */

/**
 * The line `check` prints for doctor. It holds no secret's value: the runner masks each one in
 * the log as `***`, so a line with one in it, such as the App's id, which `kanon apps` stores as
 * the `<APP>_APP_ID` secret, would reach doctor as no JSON at all (#417).
 * @param {Result} r
 */
export const resultLine = (r) => `${RESULT_MARK} ${JSON.stringify({ app: r.app, slug: r.slug, permissions: r.permissions })}`;

/**
 * The App's result in a job's log, whose lines the runner opens with a timestamp; null when the
 * log has none, as from an apps-check before #417, or one that isn't this shape.
 * @param {string} log @param {string} app the App's key, `author`, `judge` or `releaser`
 * @returns {Result | null}
 */
export const readResult = (log, app) => {
  for (const line of log.split(/\r?\n/)) {
    const at = line.indexOf(`${RESULT_MARK} `);
    if (at < 0 || !/^(\S+ )?$/.test(line.slice(0, at))) continue;
    /** @type {any} */
    let r;
    try {
      r = JSON.parse(line.slice(at + RESULT_MARK.length + 1));
    } catch {
      continue;
    }
    if (r?.app !== app || typeof r.slug !== 'string' || !r.permissions || typeof r.permissions !== 'object' || Array.isArray(r.permissions)) continue;
    if (!Object.values(r.permissions).every((v) => typeof v === 'string')) continue;
    return { app, slug: r.slug, permissions: r.permissions };
  }
  return null;
};

/**
 * Whether the log holds a result line the runner masked part of, where a secret's value
 * appeared in it: that line can't be read, and doctor says so instead of "no result".
 * @param {string} log
 */
export const resultMasked = (log) => log.split(/\r?\n/).some((line) => line.includes(`${RESULT_MARK} `) && line.includes('***'));

/** @param {string} s */
const cell = (s) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * The step summary: one table row for the App, then its failures and warnings.
 * @param {{ app: string, roles: string[], slug: string, installation: string, selection: string, repositories: string[], permissions: Record<string, string>, failures: string[], warnings: string[] }} r
 */
export const summary = (r) => {
  const verdict = r.failures.length ? 'Fail' : r.warnings.length ? 'Pass, with warnings' : 'Pass';
  const perms = Object.entries(r.permissions).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}: ${v}`).join(', ');
  const repos = r.selection === 'all' ? 'all' : r.repositories.join(', ') || 'none';
  return [
    '| App | Roles | App slug | Installation | Repositories | Permissions | Result |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| ${cell(r.app)} | ${cell(r.roles.join(', '))} | \`${cell(r.slug)}\` | ${cell(r.installation)} | ${cell(repos)} | ${cell(perms || 'none')} | ${verdict} |`,
    '',
    ...r.failures.map((f) => `- **Fail:** ${f}`),
    ...r.warnings.map((w) => `- Warning: ${w}`),
    '',
  ].join('\n');
};

/**
 * @typedef {{
 *   env: Record<string, string | undefined>,
 *   github: (url: string, init?: RequestInit) => Promise<Response>,
 *   out: (line: string) => void,
 *   append: (path: string, text: string) => void,
 *   now: () => number,
 *   read?: (role: string) => { status: number | null, stdout: string, stderr: string },
 * }} Deps
 */

/** @param {Deps} deps @param {string} path @param {string} auth */
const get = async (deps, path, auth) => {
  const res = await deps.github(`${API}${path}`, { headers: { ...HEADERS, authorization: auth } });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`GitHub answered ${res.status} for GET ${path.replace(/\?.*/, '')}`);
  return JSON.parse(text);
};

/**
 * Why the App's token wasn't minted, or null when it was. GitHub never shows a secret's value, so
 * an empty one is seen only here, and `gh secret set` typed with `!` at the Claude Code prompt,
 * where standard input isn't a terminal, stores one without a word (#625). An empty secret and
 * one the caller doesn't map look the same to the job, so the message names both.
 * @param {string} app the App's name @param {string} key its key, `author`, `judge` or `releaser`
 * @param {string} repository @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export const unmintedMessage = (app, key, repository, env) => {
  if (env.APP_SLUG && env.INSTALLATION_ID && env.TOKEN) return null;
  const id = `${key.toUpperCase()}_APP_ID`;
  const pem = `${key.toUpperCase()}_APP_PRIVATE_KEY`;
  const empty = [env.APP_ID ? null : id, env.APP_PRIVATE_KEY ? null : pem].filter((n) => n !== null);
  if (!empty.length) return `${app}: the App's token wasn't minted from ${id} and ${pem} (the step above says why): they may not be this App's id and key, or its installation may be gone (docs/apps.md).`;
  return [
    `${app}: ${empty.join(' and ')} ${empty.length > 1 ? 'are' : 'is'} empty, or not mapped by the caller, so the App's token can't be minted.`,
    `An empty secret is a likely cause: GitHub never shows a secret's value, and \`gh secret set\` typed with \`!\` at the Claude Code prompt stores an empty one without a word (kanon#625).`,
    `Store ${empty.length > 1 ? 'them' : 'it'} again${empty.includes(id) ? `, the id with \`gh secret set ${id} -R ${repository} --body <the App ID on its settings page>\`` : ''}${empty.includes(pem) ? `${empty.includes(id) ? ' and' : ','} the key from its file with \`gh secret set ${pem} -R ${repository} < <key>.pem\`` : ''}, or both with \`kanon apps --reuse\` (docs/apps.md), then run apps-check again.`,
  ].join(' ');
};

/** @param {Deps} deps @param {string} name */
const need = (deps, name) => {
  const v = deps.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

/** @param {Deps} deps */
const appList = (deps) => {
  const list = registeredApps(join(deps.env.REGISTER_DIR ?? process.cwd(), REGISTER_PATH), loadApps(), loadRoles(), deps.read);
  deps.out(`apps=${JSON.stringify(list)}`);
  return 0;
};

/** @param {Deps} deps */
const check = async (deps) => {
  const key = need(deps, 'APP');
  const spec = loadApps()[key];
  if (!spec) throw new Error(`"${key}" is not one of Kanon's Apps (${Object.keys(loadApps()).join(', ')})`);
  const roles = need(deps, 'ROLES').split(',').filter(Boolean);
  const repository = need(deps, 'REPOSITORY');
  // The mint step continues on error, so this runs after a failed mint and can say why (#625).
  const unminted = unmintedMessage(spec.app, key, repository, deps.env);
  if (unminted) throw new Error(unminted);
  const registerSlug = need(deps, 'REGISTER_SLUG');
  const appSlug = need(deps, 'APP_SLUG');
  const installation = need(deps, 'INSTALLATION_ID');
  const token = need(deps, 'TOKEN');
  const jwt = appJwt(need(deps, 'APP_ID'), need(deps, 'APP_PRIVATE_KEY'), deps.now());

  // The installation's granted permissions need the App's JWT; its repositories, the token.
  const inst = await get(deps, `/app/installations/${encodeURIComponent(installation)}`, `Bearer ${jwt}`);
  const selection = String(inst.repository_selection ?? '');
  /** @type {Record<string, string>} */
  const permissions = inst.permissions ?? {};
  /** @type {string[]} */
  const repositories = [];
  if (selection !== 'all') {
    for (let page = 1; ; page++) {
      const r = await get(deps, `/installation/repositories?per_page=100&page=${page}`, `token ${token}`);
      const batch = (r.repositories ?? []).map((/** @type {any} */ x) => String(x.full_name));
      repositories.push(...batch);
      if (!batch.length || repositories.length >= Number(r.total_count ?? 0)) break;
    }
  }

  deps.out(resultLine({ app: key, slug: appSlug, permissions }));
  const { failures, warnings } = compare({ app: spec.app, spec, registerSlug, appSlug, repository, selection, repositories, permissions });
  for (const w of warnings) deps.out(`::warning title=apps-check::${w}`);
  for (const f of failures) deps.out(`::error title=apps-check::${f}`);
  if (deps.env.GITHUB_STEP_SUMMARY) {
    deps.append(deps.env.GITHUB_STEP_SUMMARY, summary({ app: spec.app, roles, slug: appSlug, installation, selection, repositories, permissions, failures, warnings }));
  }
  if (!failures.length) deps.out(`${spec.app}: the installation matches the register and the App's permissions.`);
  return failures.length ? 1 : 0;
};

/**
 * Returns the exit code.
 * @param {string[]} argv @param {Partial<Deps>} [overrides]
 */
export const main = async (argv, overrides = {}) => {
  /** @type {Deps} */
  const deps = {
    env: process.env,
    github: (url, init) => fetch(url, init),
    out: (line) => process.stdout.write(`${line}\n`),
    append: (path, text) => appendFileSync(path, text),
    now: () => Date.now(),
    ...overrides,
  };
  try {
    if (argv[0] === 'apps') return appList(deps);
    if (argv[0] === 'check') return await check(deps);
    throw new Error('usage: apps-check.mjs apps | check');
  } catch (e) {
    deps.out(`::error title=apps-check::${/** @type {Error} */ (e).message}`);
    return 1;
  }
};

if (isCliEntry(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}

