// The status core's six views, as each surface asks for one (project #1327): `kanon status`
// (`cli/status.mjs`) and the hosted MCP server (`infra/status/function/`). Both build each view's
// section of `kanon-status/v1` here, so a tool's answer is the command's section for the same
// reads by construction, never a second assembly beside it (`[MCP-2]`).
//
// A SECTION IS AN ANSWER OR AN ERROR (`[STAT-3]`). A view whose reads didn't complete has no
// answer: its section is `{ error, reads }`, naming each read and why. Any other failure throws,
// and the surface says it stopped.
//
// EVERY VIEW LOADS FROM ANY DIRECTORY. The readiness, needs-the-Owner and inbox views run the merge gate's
// verdict function, whose module reads no App register from the working directory when there is
// none, and judge by the logins in the default branch's register (kanon#1396). So the hosted
// server, which has no checkout, serves all six.

import { inboxView, needsOwnerView } from './needs-owner.mjs';
import { IncompleteRead, projectView } from './project.mjs';
import { readinessView } from './pull-request.mjs';
import { ReadError } from './reader.mjs';
import { laneHealthView } from './lanes.mjs';
import { releaseView } from './release.mjs';

/**
 * @typedef {{ reader: import('./reader.mjs').Reader, repo: string, readAt: string }} Reads what
 *   every view reads with: the reader, the `owner/name` repository, and when the reads began
 */

/**
 * Each view, by its key in `kanon-status/v1`. A view's own argument, the tracking issue or the
 * pull request, is `n`.
 * @type {Record<'project' | 'release' | 'pr' | 'lanes' | 'needsOwner' | 'inbox', (args: Reads & { n?: number }) => Promise<object>>}
 */
export const VIEWS = {
  project: ({ reader, repo, n }) => projectView({ reader, repo, project: /** @type {number} */ (n) }),
  release: ({ reader, repo, readAt }) => releaseView({ reader, repo, now: new Date(readAt) }),
  pr: ({ reader, repo, n, readAt }) => readinessView({ reader, repo, pr: /** @type {number} */ (n), now: Date.parse(readAt) }),
  lanes: ({ reader, repo }) => laneHealthView({ reader, repo }),
  needsOwner: ({ reader, repo, readAt }) => needsOwnerView({ reader, repo, now: Date.parse(readAt) }),
  inbox: ({ reader, repo, readAt }) => inboxView({ reader, repo, now: Date.parse(readAt) }),
};

/**
 * A view's section: its answer, or the error that stands in for it when its reads didn't
 * complete (`[STAT-3]`): each read named, why it failed, its HTTP status and the rate limit's
 * reset. Any other failure throws.
 * @param {() => Promise<object>} read
 * @returns {Promise<object>}
 */
export async function section(read) {
  try {
    return await read();
  } catch (e) {
    if (!(e instanceof IncompleteRead || e instanceof ReadError)) throw e;
    /** @type {ReadError[]} */
    const reads = e instanceof IncompleteRead ? /** @type {ReadError[]} */ (e.reads) : [e];
    return {
      error: e.message,
      reads: reads.map((r) => ({ read: r.read, why: r.why, status: r.status, resetAt: r.resetAt })),
    };
  }
}
