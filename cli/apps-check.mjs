// `apps-check`: checks each agent App in the register against its installation (#39).
//
// The App register (docs/qa/agent-identities.md, K-LAYOUT-6) is a claim; App scopes live in
// the installation, not in any file (K-AGENT-3). This script, run by
// .github/workflows/apps-check.yml, turns the claim into a check (K-AGENT-5). Two commands:
//
//   node cli/apps-check.mjs roles   prints `roles=<json>` for $GITHUB_OUTPUT: every agent
//                                   role the register lists, with its slug and secret prefix.
//   node cli/apps-check.mjs check   checks one role's installation, from the environment the
//                                   workflow sets after minting the role's token.
//
// A role fails when the minted App's slug isn't the register's, when the installation
// doesn't cover this repository, or when its permissions differ from the role's in
// rulebook/agent-permissions.json. It warns when the installation covers other
// repositories too, or all of them (K-ADOPT-8: one App per role per repository).
//
// The register is read with actions/lane-check/app-register.awk, the one reader the lanes
// use, so this check and the lanes can't disagree about what the register says.
//
// Node built-ins only. The private key is read from the environment to sign the App JWT
// that reads the installation's permissions; it is never printed or written.

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appJwt, loadRoles, REGISTER_PATH } from './apps.mjs';
import { isCliEntry } from '../scripts/lib/cli-entry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AWK = join(ROOT, 'actions/lane-check/app-register.awk');
const API = 'https://api.github.com';
const HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'kanon-apps-check' };

/** @typedef {import('./apps.mjs').RoleSpec} RoleSpec */
/** @typedef {{ key: string, role: string, slug: string, secret: string }} RegisteredRole */

/**
 * Every agent role the register lists, in the order of agent-permissions.json. A role the
 * register doesn't list is skipped; any other complaint from the reader is an error.
 * @param {string} registerPath
 * @param {Record<string, RoleSpec>} roles
 * @param {(role: string) => { status: number | null, stdout: string, stderr: string }} [read]
 * @returns {RegisteredRole[]}
 */
export const registeredRoles = (registerPath, roles, read = (role) => spawnSync('awk', ['-v', `role=${role}`, '-f', AWK, registerPath], { encoding: 'utf8' })) => {
  /** @type {RegisteredRole[]} */
  const found = [];
  for (const [key, spec] of Object.entries(roles)) {
    const r = read(spec.role);
    if (r.status === 0) {
      found.push({ key, role: spec.role, slug: r.stdout.trim(), secret: key.toUpperCase() });
      continue;
    }
    // No row for the role, or no table at all (a register that says "none installed").
    if (new RegExp(`lists the role ${spec.role} 0 times|has 0 tables headed`).test(r.stderr)) continue;
    throw new Error(r.stderr.trim() || `the register reader exited ${r.status} for ${spec.role}`);
  }
  if (!found.length) throw new Error(`${REGISTER_PATH} lists no agent App, so there is nothing to check`);
  return found;
};

/**
 * Compares one installation with the register and the role's permissions.
 * @param {{
 *   role: string,
 *   spec: RoleSpec,
 *   registerSlug: string,
 *   appSlug: string,
 *   repository: string,
 *   selection: string,
 *   repositories: string[],
 *   permissions: Record<string, string>,
 * }} a
 * @returns {{ failures: string[], warnings: string[] }}
 */
export const compare = ({ role, spec, registerSlug, appSlug, repository, selection, repositories, permissions }) => {
  /** @type {string[]} */
  const failures = [];
  /** @type {string[]} */
  const warnings = [];
  if (appSlug !== registerSlug) {
    failures.push(`${role}: the minted App is \`${appSlug}\`, but the register says \`${registerSlug}\` (K-AGENT-5).`);
  }
  const want = repository.toLowerCase();
  if (selection === 'all') {
    warnings.push(`${role}: the installation covers ALL repositories in the organisation, not only ${repository} (K-ADOPT-8).`);
  } else {
    if (!repositories.some((n) => n.toLowerCase() === want)) {
      failures.push(`${role}: the installation doesn't cover ${repository} (it covers: ${repositories.join(', ') || 'nothing'}).`);
    }
    const others = repositories.filter((n) => n.toLowerCase() !== want);
    if (others.length) warnings.push(`${role}: the installation also covers ${others.join(', ')} (K-ADOPT-8: one App per role per repository).`);
  }
  const expected = spec.permissions;
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(permissions)])].sort();
  const drift = keys.filter((k) => permissions[k] !== expected[k]).map((k) => `${k}: ${permissions[k] ?? 'none'}, expected ${expected[k] ?? 'none'}`);
  if (drift.length) failures.push(`${role}: the installation's permissions differ from rulebook/agent-permissions.json: ${drift.join('; ')}.`);
  return { failures, warnings };
};

/** @param {string} s */
const cell = (s) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * The step summary: one table row for the role, then its failures and warnings.
 * @param {{ role: string, slug: string, installation: string, selection: string, repositories: string[], permissions: Record<string, string>, failures: string[], warnings: string[] }} r
 */
export const summary = (r) => {
  const verdict = r.failures.length ? 'Fail' : r.warnings.length ? 'Pass, with warnings' : 'Pass';
  const perms = Object.entries(r.permissions).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}: ${v}`).join(', ');
  const repos = r.selection === 'all' ? 'all' : r.repositories.join(', ') || 'none';
  return [
    '| Role | App slug | Installation | Repositories | Permissions | Result |',
    '| --- | --- | --- | --- | --- | --- |',
    `| ${cell(r.role)} | \`${cell(r.slug)}\` | ${cell(r.installation)} | ${cell(repos)} | ${cell(perms || 'none')} | ${verdict} |`,
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

/** @param {Deps} deps @param {string} name */
const need = (deps, name) => {
  const v = deps.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

/** @param {Deps} deps */
const roleList = (deps) => {
  const list = registeredRoles(join(deps.env.REGISTER_DIR ?? process.cwd(), REGISTER_PATH), loadRoles(), deps.read);
  deps.out(`roles=${JSON.stringify(list)}`);
  return 0;
};

/** @param {Deps} deps */
const check = async (deps) => {
  const key = need(deps, 'ROLE');
  const spec = loadRoles()[key];
  if (!spec) throw new Error(`"${key}" is not an agent role`);
  const repository = need(deps, 'REPOSITORY');
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

  const { failures, warnings } = compare({ role: spec.role, spec, registerSlug, appSlug, repository, selection, repositories, permissions });
  for (const w of warnings) deps.out(`::warning title=apps-check::${w}`);
  for (const f of failures) deps.out(`::error title=apps-check::${f}`);
  if (deps.env.GITHUB_STEP_SUMMARY) {
    deps.append(deps.env.GITHUB_STEP_SUMMARY, summary({ role: spec.role, slug: appSlug, installation, selection, repositories, permissions, failures, warnings }));
  }
  if (!failures.length) deps.out(`${spec.role}: the installation matches the register and the role's permissions.`);
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
    if (argv[0] === 'roles') return roleList(deps);
    if (argv[0] === 'check') return await check(deps);
    throw new Error('usage: apps-check.mjs roles | check');
  } catch (e) {
    deps.out(`::error title=apps-check::${/** @type {Error} */ (e).message}`);
    return 1;
  }
};

if (isCliEntry(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}

