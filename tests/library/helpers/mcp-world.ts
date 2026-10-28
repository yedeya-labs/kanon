/**
 * The worlds the hosted status server's tests read over (project #1327): each tool with the CLI's
 * flags for the same view and the worlds it runs over, the CLI's answer for a world, and a
 * `fetch` that serves a world as GitHub's API serves it. Shared by the handler's tests
 * (`status-mcp.test.ts`) and its authentication's (`status-mcp-auth.test.ts`).
 */
import { chain, promoting } from './release-world.js';
import { PROJECT, adopterProject, laneCaller, laneFleet, laneWorld } from './status-world.js';
import { NUMBER, briefPr, implementerPr, personPr, readerFor } from './pr-world.js';
import { ownerWorld } from './owner-world.js';

const { status } = await import('../../../cli/status.mjs');
const { ReadError } = await import('../../../scripts/status/reader.mjs');
const { HELD, HELD_MARKER } = await import('../../../scripts/lead-reconcile.mjs');
const { askBody } = await import('../../../scripts/lib/decision-asks.mjs');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
export type Reader = { get: (p: string) => unknown; pages: (p: string) => unknown; graphql: (q: string, v?: Record<string, unknown>) => unknown };

export const READ_AT = '2026-10-24T09:30:00.000Z';
export const REPO = 'acme/shop';
export const API = 'https://api.github.com';

/** Runs `kanon status --json` over a world, as `kanon-status.test.ts` does. */
export async function cli(argv: string[], reader: Reader, readAt = READ_AT) {
  const out: string[] = [];
  await status([...argv, '--repo', REPO, '--json'], {
    git: () => ({ status: 128, stdout: '', stderr: '' }),
    gh: async () => ({ status: 0, stdout: 'octo\n', stderr: '' }),
    reader: () => reader as Any,
    env: {},
    out: (l: string) => out.push(l),
    err: () => {},
    release: () => 'v9.9.9',
    now: () => new Date(readAt),
  });
  return JSON.parse(out.join('\n'));
}

/** The needs-the-Owner world with one of each entry, as `kanon-status.test.ts` builds it. */
export const owing = () => ownerWorld({
  prs: [personPr(), briefPr('Which store? ⛔ OPEN', { number: 46, head: 'b'.repeat(40), reviews: [] })],
  issues: [
    { number: 7, title: 'Project: storefront', labels: [HELD], comments: [{ login: 'example-lead', body: `**Lead** <!-- kanon:role=lead -->\n\nheld\n${HELD_MARKER}`, createdAt: '2026-10-01T00:00:00Z' }] },
    { number: 30, title: 'Pick a store', labels: ['qa:needs-info'] },
    { number: 60, title: 'Pick a payment provider', labels: ['decision:needed'], comments: [{ login: 'octo', body: askBody({ question: 'Which provider?', options: ['One', 'Two'], recommendation: 'One.' }), createdAt: '2026-10-01T00:00:00Z' }] },
  ],
  workflows: { 'implement.yml': laneCaller('implement') },
  runs: { 'implement.yml': [{ id: 1, conclusion: 'failure' }, { id: 2, conclusion: 'failure' }, { id: 3, conclusion: 'failure' }] },
  jobs: { 1: [], 2: [], 3: [] },
});
/** A lane-health world whose jobs read hits the rate limit. */
export const refusedLanes = () => laneWorld({
  workflows: { 'review.yml': laneCaller('review') },
  runs: { 'review.yml': [{ id: 1, conclusion: 'failure' }] },
  jobs: { 1: [] },
  overrides: {
    pages: (p) => {
      if (p.includes('/jobs')) throw new ReadError(`GET ${p}`, 'API rate limit exceeded', { status: 403, resetAt: '2026-10-24T10:00:00.000Z' });
      return undefined;
    },
  },
});

/**
 * Each tool, the CLI's flags for the same view, its section's key, and the worlds it is run over:
 * between them a whole answer of each view, and a view whose reads didn't complete.
 */
export const CASES: Array<{ tool: string; args: Record<string, unknown>; argv: string[]; key: string; worlds: Array<() => { reader: Reader }> }> = [
  { tool: 'project', args: { repo: REPO, project: PROJECT }, argv: ['--project', String(PROJECT)], key: 'project', worlds: [() => adopterProject()] },
  { tool: 'release', args: { repo: REPO }, argv: ['--release'], key: 'release', worlds: [() => chain(), () => promoting()] },
  { tool: 'pull_request', args: { repo: REPO, number: NUMBER }, argv: ['--pr', String(NUMBER)], key: 'pr', worlds: [() => readerFor(implementerPr()), () => readerFor(briefPr('Which store? ⛔ OPEN'))] },
  { tool: 'lanes', args: { repo: REPO }, argv: ['--lanes'], key: 'lanes', worlds: [() => laneFleet(), () => refusedLanes()] },
  { tool: 'needs_owner', args: { repo: REPO }, argv: ['--needs-owner'], key: 'needsOwner', worlds: [() => owing()] },
  { tool: 'inbox', args: { repo: REPO }, argv: ['--inbox'], key: 'inbox', worlds: [() => owing()] },
];

/**
 * A `fetch` over a world's reader, recording every request: what the hosted server's
 * `fetchReader` sends GitHub, answered from the same world the CLI reads directly. A REST path
 * the world reads as pages is served one page per request, chained by `Link: next`, as GitHub
 * serves them; a read the world refuses is GitHub's error, with the rate limit's headers when
 * that is the cause.
 */
export function fetchOver(reader: Reader) {
  const requests: Array<{ method: string; url: string; body?: string; headers: Record<string, string> }> = [];
  const PAGE_MARK = /[?&]kanon_page=(\d+)$/;
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const failure = (e: Any) => {
    const limited = typeof e?.resetAt === 'string';
    return reply(typeof e?.status === 'number' ? e.status : 500, { message: e?.why ?? e?.message ?? String(e) }, limited
      ? { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.parse(e.resetAt) / 1000) }
      : {});
  };
  const fetchImpl = async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    requests.push({ method, url, body: init.body as string | undefined, headers: init.headers as Record<string, string> });
    if (!url.startsWith(`${API}/`)) throw new Error(`a request left GitHub's API: ${url}`);
    const raw = url.slice(API.length + 1);
    try {
      if (method === 'POST' && raw === 'graphql') {
        const { query, variables } = JSON.parse(String(init.body));
        return reply(200, { data: await reader.graphql(query, variables) });
      }
      if (method !== 'GET') throw new Error(`unrouted ${method} ${url}`);
      const mark = PAGE_MARK.exec(raw);
      const path = mark ? raw.replace(PAGE_MARK, '') : raw;
      let pages: unknown[] | null = null;
      if (!mark) {
        try {
          return reply(200, await reader.get(path));
        } catch (e) {
          if (!/^unrouted/.test((e as Error)?.message ?? '')) throw e;
        }
      }
      pages = (await reader.pages(path)) as unknown[];
      const i = mark ? Number(mark[1]) : 0;
      const next: Record<string, string> = i + 1 < pages.length ? { link: `<${API}/${path}${path.includes('?') ? '&' : '?'}kanon_page=${i + 1}>; rel="next"` } : {};
      return reply(200, pages[i], next);
    } catch (e) {
      return failure(e);
    }
  };
  return { fetch: fetchImpl as unknown as typeof fetch, requests };
}
