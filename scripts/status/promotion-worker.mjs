// The promotion's check in a worker thread (`promotion.mjs`): `check` reads through a synchronous
// `api` (`bridgeApi`), which posts each read to the thread that holds the reader and blocks until
// the answer is back. Never run on its own.

import { parentPort, workerData } from 'node:worker_threads';
import { Refusal, check } from '../promote.mjs';
import { bridgeApi } from './promotion.mjs';

const { repo, branch, workflows, now, signal, port } = /** @type {{ repo: string, branch: string, workflows: Array<{ file: string, text: string }>, now: number, signal: Int32Array, port: import('node:worker_threads').MessagePort }} */ (workerData);

const api = bridgeApi({ signal, port });

try {
  parentPort?.postMessage({ outcome: check({ GITHUB_REPOSITORY: repo, DEFAULT_BRANCH: branch }, { api, now, workflows }) });
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  const status = /** @type {{ status?: unknown }} */ (e)?.status;
  parentPort?.postMessage(e instanceof Refusal ? { refusal: message } : { failure: { message, status: typeof status === 'number' ? status : null } });
}
