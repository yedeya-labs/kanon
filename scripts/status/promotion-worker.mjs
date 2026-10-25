// The promotion's check in a worker thread (`promotion.mjs`): `check` reads through a synchronous
// `api`, which posts each read to the thread that holds the reader and blocks until the answer is
// back. Never run on its own.

import { parentPort, receiveMessageOnPort, workerData } from 'node:worker_threads';
import { ApiError, Refusal, check } from '../promote.mjs';

const { repo, branch, workflows, now, signal, port } = /** @type {{ repo: string, branch: string, workflows: Array<{ file: string, text: string }>, now: number, signal: Int32Array, port: import('node:worker_threads').MessagePort }} */ (workerData);

/** @type {import('../promote.mjs').Api} */
const api = (path, { method = 'GET', raw = false } = {}) => {
  if (method !== 'GET') throw new Error(`the status core writes nothing, and the promotion's check asked to ${method} ${path}`);
  Atomics.store(signal, 0, 0);
  port.postMessage({ path, raw });
  Atomics.wait(signal, 0, 0);
  const answer = /** @type {{ body?: unknown, error?: { message: string, status: number | null } } | undefined} */ (receiveMessageOnPort(port)?.message);
  if (!answer) throw new Error(`no answer came back for ${path}`);
  if (answer.error) throw new ApiError(answer.error.message, answer.error.status);
  return answer.body;
};

try {
  parentPort?.postMessage({ outcome: check({ GITHUB_REPOSITORY: repo, DEFAULT_BRANCH: branch }, { api, now, workflows }) });
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  const status = /** @type {{ status?: unknown }} */ (e)?.status;
  parentPort?.postMessage(e instanceof Refusal ? { refusal: message } : { failure: { message, status: typeof status === 'number' ? status : null } });
}
