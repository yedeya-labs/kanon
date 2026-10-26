#!/usr/bin/env node
// The hosted status server's deploy smoke (project #1327, Issue I, `[MCP-11]`), which the
// operator's smoke hook runs at the pinned Kanon right after the deploy:
//
//   node "$KANON/infra/status/smoke.mjs" --url <server-url>/mcp
//   node "$KANON/infra/status/smoke.mjs" --stack [--region eu-central-1]   # reads the stack, with the deploy's credential
//
// It passes only when both hold, and exits 1 naming each check that failed otherwise:
// - an unauthenticated `POST /mcp` of `tools/list` gets 401, with a `WWW-Authenticate: Bearer`
//   header whose `resource_metadata` is on the server's own origin (`[MCP-4]`);
// - that metadata answers 200 with JSON whose `resource` is the server's `/mcp` and whose
//   `authorization_servers` names the server.
// With `--stack`, the stack must also be `CREATE_COMPLETE` or `UPDATE_COMPLETE`.
//
// Both are refusals and reads: it signs nobody in, needs no token and no secret, and sends nothing
// but `tools/list`. A red smoke files the deploy lane's failure issue in the operator's repository.
// A server whose secret can't be read answers 500 here, so it fails too (`function/handler.mjs`).

import { URL } from 'node:url';
import { parseArgs } from 'node:util';
import { COMPLETE, STACK, stackState } from './deploy.mjs';
import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';

/** How long each request may take. */
const TIMEOUT_MS = 30_000;

/** Why a request couldn't be sent, by its cause's code alone. @param {unknown} e */
const why = (e) => String(/** @type {any} */ (e)?.cause?.code ?? /** @type {any} */ (e)?.name ?? 'an error');

/**
 * What is wrong with the server at `url`, its `/mcp` address: nothing, when it passes.
 * @param {string} url
 * @param {{ fetch?: typeof fetch }} [options]
 * @returns {Promise<string[]>}
 */
export async function checkServer(url, { fetch: fetchImpl = fetch } = {}) {
  const origin = new URL(url).origin;
  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      redirect: 'manual',
      signal: globalThis.AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
  } catch (e) {
    return [`tools/list at ${url} could not be sent: ${why(e)}`];
  }
  await res.body?.cancel();
  if (res.status !== 401) return [`tools/list at ${url} got ${res.status}, not 401`];
  const challenge = res.headers.get('www-authenticate') ?? '';
  const metadata = /^Bearer\b.*\bresource_metadata="([^"]+)"/i.exec(challenge)?.[1];
  if (!metadata) return ['the 401 names no resource_metadata in its WWW-Authenticate header'];
  let at;
  try {
    at = new URL(metadata);
  } catch {
    return [`the 401 names metadata that isn't a URL: ${metadata}`];
  }
  if (at.origin !== origin) return [`the 401 names metadata on another origin: ${metadata}`];

  /** @type {any} */
  let doc;
  try {
    const meta = await fetchImpl(metadata, { redirect: 'manual', signal: globalThis.AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
    if (meta.status !== 200) {
      await meta.body?.cancel();
      return [`the metadata at ${metadata} got ${meta.status}, not 200`];
    }
    doc = await meta.json().catch(() => null);
  } catch (e) {
    return [`the metadata at ${metadata} could not be read: ${why(e)}`];
  }
  if (doc === null || typeof doc !== 'object') return [`the metadata at ${metadata} isn't a JSON object`];
  const failures = [];
  if (doc.resource !== url) failures.push(`the metadata names the resource ${typeof doc.resource === 'string' ? doc.resource : JSON.stringify(doc.resource ?? null)}, not ${url}`);
  const servers = Array.isArray(doc.authorization_servers) ? doc.authorization_servers.map((/** @type {unknown} */ s) => String(s).replace(/\/+$/, '')) : [];
  if (!servers.includes(origin)) failures.push(`the metadata names authorization_servers ${JSON.stringify(doc.authorization_servers ?? null)}, not ${origin}`);
  return failures;
}

if (isCliEntry(import.meta.url)) {
  const usage = (/** @type {string} */ message) => {
    process.stderr.write(`smoke: ${message}\nusage: smoke.mjs --url <server-url>/mcp | --stack [--region <region>]\n`);
    process.exit(2);
  };
  const { values } = parseArgs({ options: { url: { type: 'string' }, stack: { type: 'boolean' }, region: { type: 'string' } } });
  /** @type {string} */
  let url;
  if (values.stack) {
    const state = stackState(values.region || 'eu-central-1');
    if (!COMPLETE.includes(state.status) || !state.url) {
      process.stdout.write(`smoke: failed: ${STACK} is ${state.status || 'unknown'}, not ${COMPLETE.join(' or ')} with an address\n`);
      process.exit(1);
    }
    url = state.url;
  } else {
    if (!values.url) usage('--url or --stack is required');
    url = String(values.url);
  }
  /** @type {URL | null} */
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    usage(`${url} isn't a URL`);
  }
  if (!parsed || !/^https?:$/.test(parsed.protocol) || parsed.pathname !== '/mcp' || parsed.search || parsed.hash) usage(`${url} isn't a server's /mcp address`);
  const failures = await checkServer(url);
  for (const f of failures) process.stdout.write(`smoke: failed: ${f}\n`);
  if (failures.length) process.exit(1);
  process.stdout.write(`smoke: ok, ${url} answers 401 and serves its metadata\n`);
}
