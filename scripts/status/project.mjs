// THE PROJECT VIEW (project #1327, Issue A): where one project stands, read live, as the Lead's
// reconciler would read it on its next tick, and nothing written anywhere.
//
// ONE READ, NOT A SECOND COPY OF IT. The world comes from the reconciler's own project read,
// `readProjectWorld`, over the reader the caller passes; the phase is `phaseOf`'s answer for that
// world and the gating work `openGatingWork`'s (`[STAT-4]`). The declarations come from the default
// branch through the shared declarations reader, never from a checkout (`[STAT-2]`). What this
// file adds is only what the reconciler doesn't need: each item's pull requests, its acceptance
// criteria against the spec layer and the tests, and why an item can't proceed (`[STAT-5]`).
//
// INCOMPLETE IS AN ERROR (`[STAT-3]`). The reconciler tolerates a failed read by design, in the
// direction that holds; a status answer built on one would be a partial answer. Every read goes
// through `watched`, and a view whose reads failed throws `IncompleteRead`, naming each.

import { APP_REGISTER, parseAppRegister } from '../app-register.mjs';
import { classify as classifyLane, norm, registerBotLogins } from '../dispatch-sweep.mjs';
import { defaultBranchReader } from '../lib/declarations.mjs';
import { declaredEnvironmentAt, referenceDeployAt } from '../lib/deploy-declaration.mjs';
import { HELD, HELD_MARKER, HUMAN_ACTION, NEEDS_INFO, issueComments, leadComments, phaseOf, readProjectWorld } from '../lead-reconcile.mjs';
import { openGatingWork } from '../project-closure.mjs';
import { SPLIT_LABEL } from '../split-lineage.mjs';
import { acsFromBrief } from '../verify-acs.mjs';
import { ReadError, allNodes, ownerAndName, watched } from './reader.mjs';
import { readCitations, readSpecLayer } from './spec-layer.mjs';

/** A view whose reads didn't all complete. `reads` names each failed read and why. */
export class IncompleteRead extends Error {
  /** @param {string} what @param {ReadError[]} reads */
  constructor(what, reads) {
    super(`${what} couldn't be read whole, so there is no answer: ${reads.map((r) => r.message).join('; ')}`);
    this.name = 'IncompleteRead';
    this.reads = reads;
  }
}

/** The labels that stop an item (`[STAT-5]`). Each is its own reason. */
const STOPPING_LABELS = [NEEDS_INFO, SPLIT_LABEL, 'blocked', HUMAN_ACTION];

const Q_ITEM_PRS = `query ItemPullRequests($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      closedByPullRequestsReferences(first: 100, after: $after, includeClosedPrs: true) {
        nodes { number state url }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

/**
 * @typedef {{ id: string, declared: boolean, clause: string | null, tested: boolean, tests: string[] }} ItemAc
 * @typedef {{ reason: string, detail: string }} Stop `dependency`, `lead-hold`, `held`, or the stopping label
 * @typedef {object} Item
 * @property {string} key the brief's key, `Issue A`
 * @property {string} title
 * @property {{ number: number, state: string, labels: string[] } | null} issue the filed issue, by the project marker
 * @property {{ open: number[], merged: number[] }} prs
 * @property {Array<{ key: string, issue: number | null, state: string | null }>} dependsOn
 * @property {ItemAc[]} acs
 * @property {Stop[]} stops why it can't proceed; empty when it can
 */

/**
 * One project's view. Reads only through `reader`; writes nothing.
 * @param {{ reader: import('./reader.mjs').Reader, repo: string, project: number | string }} args
 */
export async function projectView({ reader: given, repo, project }) {
  const { reader, failures } = watched(given);
  try {
    return await view(project, { reader, repo, failures });
  } catch (e) {
    // A read that failed, whether the reconciler tolerated it or this view didn't, is the answer.
    const failed = failures();
    if (e instanceof ReadError && !failed.includes(e)) failed.push(e);
    if (failed.length) throw new IncompleteRead(`project #${project}`, failed);
    throw e;
  }
}

/**
 * @param {number | string} project
 * @param {{ reader: import('./reader.mjs').Reader, repo: string, failures: () => import('./reader.mjs').ReadError[] }} io
 */
async function view(project, { reader, repo, failures }) {
  /** @type {string[]} */
  const notes = [];
  const files = await defaultBranchReader(reader, repo);
  const briefPath = `docs/projects/${project}.md`;
  const brief = await files.read(briefPath);
  const registerText = await files.read(APP_REGISTER);
  const register = registerText === null ? new Map() : parseAppRegister(registerText, `${APP_REGISTER} on \`${files.branch}\``);
  const bots = registerBotLogins(register);
  const world = await readProjectWorld(project, {
    reader,
    repo,
    warn: (m) => notes.push(m),
    readBrief: () => brief,
    declared: () => referenceDeployAt(files),
    environment: () => declaredEnvironmentAt(files),
    classify: (issue, comments, hasPr, opts = {}) => classifyLane(issue, comments, hasPr, {
      isBot: (/** @type {string} */ login) => bots.has(norm(login)),
      agent: register.get('Implementer') ?? null,
      sweep: register.get('Lead') ?? null,
      ...opts,
    }),
    explorer: register.get('Explorer') ?? null,
    lead: register.get('Lead') ?? null,
  });
  const phase = phaseOf(world);
  /** @type {string[] | undefined} */
  const residue = /** @type {any} */ (world.proposed).residue;
  const hold = world.projectHeld ? await holdOf(project, register.get('Lead') ?? null, { reader, repo }) : null;
  const briefState = brief === null ? 'missing' : !world.proposed.length || residue?.length ? 'unparseable' : 'parsed';
  const items = brief !== null && briefState === 'parsed' ? await itemsOf(world, brief, { reader, repo, files, hold }) : null;
  const failed = failures();
  if (failed.length) throw new IncompleteRead(`project #${project}`, failed);
  return {
    project: Number(project),
    branch: files.branch,
    brief: { path: briefPath, state: briefState, ...(briefState === 'unparseable' ? { residue: residue ?? [] } : {}) },
    phase,
    gating: openGatingWork(world.open, world.proposed).map((/** @type {{ number: number }} */ i) => i.number),
    hold,
    environment: world.environment ?? null,
    items,
    notes,
  };
}

/**
 * Whose hold the tracking issue carries: the Lead's when its hold comment is there beside the
 * label, a person's otherwise. The hold comment is the Lead's own, as the reconciler counts it
 * (`leadComments`, kanon#1415): the Lead's App wrote it with the Lead's role marker. A copy of
 * the marker in anyone else's comment would send the reader to the Lead for a person's hold. A
 * register with no Lead row names no login, and no comment is the Lead's then.
 * @param {number | string} project
 * @param {string | null} lead the Lead's login, from the default branch's register
 * @param {{ reader: import('./reader.mjs').Reader, repo: string }} io
 */
async function holdOf(project, lead, io) {
  const comments = await issueComments(project, io);
  const leads = leadComments(comments, lead).some((c) => (c.body ?? '').includes(HELD_MARKER));
  return { label: HELD, by: leads ? 'lead' : 'person' };
}

/**
 * Each decomposition item, with its issue, pull requests, dependencies, criteria and stops.
 * @param {any} world
 * @param {string} brief
 * @param {{ reader: import('./reader.mjs').Reader, repo: string, files: import('../lib/declarations.mjs').BranchFiles, hold: { label: string, by: string } | null }} io
 * @returns {Promise<Item[]>}
 */
async function itemsOf(world, brief, { reader, repo, files, hold }) {
  const acs = acsFromBrief(brief);
  const spec = acs.length ? await readSpecLayer(files) : /** @type {import('./spec-layer.mjs').SpecLayer} */ ({ prefixes: [], clauses: new Map() });
  // The test files are read when a cited id is under a declared prefix, as `readCitations` matches
  // them, not only when it has a clause: whether a test cites one id can't hang on another (#1402).
  const cited = acs.some((a) => spec.prefixes.includes(a.id.replace(/-\d+$/, ''))) ? await readCitations(reader, repo, files, spec.prefixes) : new Map();
  /** @param {string} key */
  const issueOf = (key) => {
    const mine = world.all.filter((/** @type {any} */ i) => i.key === key && i.number !== Number(world.project));
    return mine.find((/** @type {any} */ i) => i.state === 'OPEN') ?? mine[0] ?? null;
  };
  /** @type {Item[]} */
  const out = [];
  for (const p of world.proposed) {
    const issue = issueOf(p.key);
    const prs = issue ? await allNodes(reader, Q_ITEM_PRS, { ...ownerAndName(repo), number: issue.number }, (d) => d?.repository?.issue?.closedByPullRequestsReferences) : [];
    const dependsOn = (p.dependsOnKeys ?? []).map((/** @type {string} */ key) => {
      const dep = issueOf(key);
      return { key, issue: dep?.number ?? null, state: dep?.state ?? null };
    });
    /** @type {Stop[]} */
    const stops = [];
    if (!issue || issue.state === 'OPEN') {
      for (const d of dependsOn) {
        if (d.state !== 'CLOSED') {
          stops.push({ reason: 'dependency', detail: d.issue ? `${d.key} (#${d.issue}) is still open` : `${d.key} isn't filed yet` });
        }
      }
      for (const label of STOPPING_LABELS) {
        if (issue?.labels.includes(label)) stops.push({ reason: label, detail: `#${issue.number} carries \`${label}\`` });
      }
      if (hold) {
        stops.push({ reason: hold.by === 'lead' ? 'lead-hold' : 'held', detail: `the project carries \`${hold.label}\`${hold.by === 'lead' ? ' and the Lead\'s hold comment' : ''}` });
      }
    }
    out.push({
      key: p.key,
      title: p.title,
      issue: issue ? { number: issue.number, state: issue.state, labels: issue.labels } : null,
      prs: {
        open: prs.filter((r) => r.state === 'OPEN').map((r) => r.number),
        merged: prs.filter((r) => r.state === 'MERGED').map((r) => r.number),
      },
      dependsOn,
      acs: acs.filter((a) => a.issue === p.key).map((a) => {
        const tests = [...(cited.get(a.id) ?? [])].sort();
        return { id: a.id, declared: a.declared, clause: spec.clauses.get(a.id)?.status ?? null, tested: tests.length > 0, tests };
      }),
      stops,
    });
  }
  return out;
}
