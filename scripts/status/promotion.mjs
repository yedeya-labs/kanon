// The promotion's gates, as the status core reads them (project #1327, Issue E, `[STAT-9]`): the
// promotion's own read-only check, `check` in `scripts/promote.mjs`, run over the reader the
// caller passes, never a second reading of the gates beside it.
//
// WHERE IT RUNS. Only where the default branch runs Kanon's promotion workflow: a workflow there
// that runs `scripts/promote.mjs check`. That is a read of the repository's files, never a test of
// its name (`[STAT-2]`), so Kanon's own repository gets no special case.
//
// A SYNCHRONOUS CHECK OVER ANY READER. `check` reads through a synchronous `api`, and a reader may
// answer with a promise (the hosted server's reads over `fetch`). So `check` runs in a worker
// thread, whose `api` posts each read to this thread and blocks on a shared word until the answer
// is back; this thread reads it through the caller's reader. Each read is asked once, in the
// order `check` asks it, so the search re-reads and their waits (`trustedSearchSync`) are
// `check`'s own, and `scripts/promote.mjs` is run as it is, unchanged. `check` never writes, and
// the bridge refuses any method but `GET` (`[STAT-1]`).

import { MessageChannel, Worker } from 'node:worker_threads';
import { ReadError } from './reader.mjs';

/** A line that runs the promotion's check, outside a comment. */
const RUNS_CHECK = /\bscripts\/promote\.mjs\s+check\b/;

/**
 * The workflow on the default branch that runs Kanon's promotion workflow's check, or null.
 * @param {Array<{ file: string, text: string }>} workflows
 * @returns {string | null}
 */
export function promotionWorkflow(workflows) {
  const hit = workflows.find(({ text }) => text.split(/\r?\n/).some((l) => !/^\s*#/.test(l) && RUNS_CHECK.test(l)));
  return hit ? hit.file : null;
}

/**
 * @typedef {{ id: string, title: string, skipped: boolean, pass: boolean, evidence: string }} GateVerdict
 * @typedef {{ decision: 'promote' | 'hold' | 'none' | 'refused', why: string, candidate: string | null, gates: GateVerdict[] }} Promotion
 */

/**
 * The promotion's check, over `reader`: its decision, why, the candidate and each gate's verdict
 * and evidence. A `Refusal` is the check's answer too (`refused`), a state a person reads. Any
 * other failure throws: a `ReadError` naming the read, or the error itself.
 * @param {{ reader: import('./reader.mjs').Reader, repo: string, branch: string, workflows: Array<{ file: string, text: string }>, now: number }} args
 * @returns {Promise<Promotion>}
 */
export async function promotionCheck({ reader, repo, branch, workflows, now }) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL('./promotion-worker.mjs', import.meta.url), {
    workerData: { repo, branch, workflows, now, signal, port: port2 },
    transferList: [port2],
  });
  port1.on('message', async (/** @type {{ path: string, raw: boolean }} */ { path, raw }) => {
    /** @type {{ body: unknown } | { error: { message: string, status: number | null } }} */
    let answer;
    try {
      answer = { body: await read(reader, path, raw) };
    } catch (e) {
      const status = /** @type {{ status?: unknown }} */ (e)?.status;
      // "Not there" is an answer the check reads (a release, a ref, a file), not a failed read.
      if (status === 404) /** @type {{ expected?: boolean }} */ (e).expected = true;
      answer = { error: { message: e instanceof Error ? e.message : String(e), status: typeof status === 'number' ? status : null } };
    }
    port1.postMessage(answer);
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  });
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`the promotion's check stopped, exit code ${code}, before it answered`)));
    });
    const r = /** @type {{ outcome?: any, refusal?: string, failure?: { message: string, status: number | null } }} */ (result);
    if (r.refusal !== undefined) return { decision: 'refused', why: r.refusal, candidate: null, gates: [] };
    if (r.failure) throw new ReadError("the promotion's check", r.failure.message, { status: r.failure.status });
    const o = r.outcome;
    return {
      decision: o.decision,
      why: o.why,
      candidate: o.candidate ?? null,
      gates: (o.gates ?? []).map((/** @type {GateVerdict} */ g) => ({ id: g.id, title: g.title, skipped: g.skipped, pass: g.pass, evidence: g.evidence })),
    };
  } finally {
    port1.close();
    await worker.terminate();
  }
}

/**
 * One read `check` asked, through the reader: the parsed body, or, for a raw read of the contents
 * API, the file's text, as `gh api -H 'Accept: application/vnd.github.raw'` gives it.
 * @param {import('./reader.mjs').Reader} reader @param {string} path @param {boolean} raw
 */
async function read(reader, path, raw) {
  const body = await reader.get(path);
  if (!raw) return body;
  const file = /** @type {{ encoding?: unknown, content?: unknown, sha?: unknown }} */ (body);
  if (file?.encoding === 'base64' && typeof file.content === 'string') return Buffer.from(file.content, 'base64').toString('utf8');
  // Over 1 MB the contents API sends no content, and the blob API sends the file.
  const [, repo] = /^repos\/([^/]+\/[^/]+)\/contents\//.exec(path) ?? [];
  if (!repo || typeof file?.sha !== 'string') throw new ReadError(`GET ${path}`, 'the answer is not a file');
  const blob = /** @type {{ content?: unknown }} */ (await reader.get(`repos/${repo}/git/blobs/${file.sha}`));
  return Buffer.from(String(blob?.content ?? ''), 'base64').toString('utf8');
}
