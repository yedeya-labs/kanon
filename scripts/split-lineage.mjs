#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// RA-1781 — an issue too large for one implementer run is SPLIT, not retried, and only once.
//
// WHAT HAPPENED. RA-1694 hit the turn cap twice, ~35 minutes and ~$21 notional each, and
// produced nothing either time; the second run started after its blocker had merged, so
// the failure was the issue's size, not its preconditions. A re-run of an issue that
// exhausted its cap is deterministic failure at the cap's price. `classify-agent-result`
// names that verdict `exhausted` (RA-1781 criterion 1), and RA-2312's crash job already
// stopped retrying it. What was missing was somewhere for it to GO other than a human.
//
// WHERE IT GOES. A project member that exhausts is labelled `qa:needs-split`, and
// the Lead's split lane (`agent-lead-split.yml`) proposes replacing its brief item with
// smaller children, as a PR against `docs/projects/<n>.md`. A human reviews the split
// rather than authoring it; nothing is filed until it merges, and the reconciler then
// files the children exactly as it files any other brief item.
//
// ONE SPLIT PER LINEAGE. Each child's brief item carries `<!-- qa:split-of #N -->` on a
// line of its own, and the file arm copies the item body verbatim, so the filed child
// carries it too. A child that exhausts again goes to a human with that record, never
// back to the split lane — a bad decomposition must not recurse at ~$21 a cycle.
//
// THE THREE WRITERS SHARE THIS MODULE — `implement-crash.mjs` (the crash job, the
// immediate path for a project member), `dispatch-sweep.mjs` (the daily sweep, which
// owns every issue the crash job leaves alone) and the split lane's own gate — so the
// routing is one function, not three copies that can disagree.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { splitBranch, splitBranches } from './lib/protocol-spellings.mjs';

const REPO = process.env.GITHUB_REPOSITORY;

/** The label that routes an exhausted issue to the Lead's split lane. Never dispatched:
 *  `lead-reconcile`'s `eligible` filter excludes it, and unlike `qa:needs-info` it does
 *  not park the project's other items — the split is the Lead's to propose, not a
 *  question a human owes the whole project. */
export const SPLIT_LABEL = 'qa:needs-split';
/** Where an exhausted issue goes when a split is not available. The same terminal label
 *  the sweep and the crash job already use for "a human decides". */
export const HUMAN_LABEL = 'qa:needs-info';
/** The split lane's workflow, named once. */
export const SPLIT_WORKFLOW = 'agent-lead-split.yml';

/** The lineage marker a child carries. A LINE OF ITS OWN, so prose quoting the
 *  convention inline — this comment, a brief discussing it — is not read as one. */
export const splitMarker = (parent) => `<!-- qa:split-of #${parent} -->`;
const SPLIT_OF_RE = /^[ \t]*<!-- qa:split-of #(\d+) -->[ \t]*$/m;

/** The parent this issue was split from, or null. */
export function splitOf(body) {
  const m = SPLIT_OF_RE.exec(String(body ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * The `### Issue` headings a split PR ADDS that carry no lineage marker (the Reviewer, RA-2407).
 * Pure; reads a unified diff. The one-split rule rests on every child carrying the
 * marker, and without this nothing but review checked that it does.
 *
 * @param {string} diff  `gh pr diff` output
 * @returns {string[]} the added headings whose added block has no marker line
 */
export function childrenMissingMarker(diff) {
  const missing = [];
  let current = null;
  const close = () => { if (current && !current.marked) missing.push(current.heading); };
  for (const raw of String(diff ?? '').split(/\r?\n/)) {
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff ') || raw.startsWith('@@')) continue;
    const line = raw.slice(1);
    if (/^#{1,3}\s/.test(line)) {
      close();
      current = raw.startsWith('+') && /^###\s+Issue\s+/.test(line) ? { heading: line.trim(), marked: false } : null;
      continue;
    }
    if (current && raw.startsWith('+') && SPLIT_OF_RE.test(line)) current.marked = true;
  }
  close();
  return missing;
}

/** The branch the split lane pushes to — one per parent, so a second run for the same
 *  issue finds the first one's PR instead of opening a rival. `splitBranches` adds the
 *  branch's old spelling, which a split opened before #53 is still on: a reader asks
 *  about every one, a writer pushes to `splitBranch`. */
export { splitBranch, splitBranches };

/**
 * Where an issue whose implementer run EXHAUSTED its cap goes. Pure.
 *
 * @param {{project: number|null, body?: string}} i
 * @returns {{label: string, why: string}}
 */
export function exhaustedRoute({ project, body }) {
  const parent = splitOf(body);
  if (parent != null) {
    return {
      label: HUMAN_LABEL,
      why: `this issue is already a split of #${parent}, and a split is allowed ONCE per lineage — a second split of a decomposition that did not fit is a human's call, not another ~$21 cycle (RA-1781)`,
    };
  }
  if (project == null) {
    return {
      label: HUMAN_LABEL,
      why: 'it belongs to no project, so there is no brief for the Lead to split — a human decomposes it into smaller issues (RA-1781)',
    };
  }
  return {
    label: SPLIT_LABEL,
    why: `routed to the Lead's split lane (\`${SPLIT_WORKFLOW}\`), which proposes smaller children as a PR against project #${project}'s brief (RA-1781)`,
  };
}

/**
 * Should the split lane run for this issue? Pure.
 *
 * `refuse` is a lineage or membership refusal: the issue must LEAVE the split lane for a
 * human, because no later event makes a split possible. `skip` is everything else — the
 * run has nothing to do right now and changes nothing.
 *
 * @param {object} i
 * @param {string} i.state         the issue's state
 * @param {string[]} i.labels
 * @param {number|null} i.project
 * @param {string} i.body
 * @param {boolean} i.briefExists  `docs/projects/<project>.md` is on the default branch
 * @param {boolean} [i.preStandard] that brief is pre-standard (`isPreStandard`, from the
 *   adopter's `docs/qa/exemptions.md`, `K-LAYOUT-15`), and stays byte-identical (§5.3)
 * @param {string|null} [i.preStandardUnread] why the exemptions file couldn't be read, when
 *   it couldn't: the brief MIGHT be pre-standard, so it is refused to a human, never split
 * @param {number|null} i.openPr   an open PR already on `splitBranch(issue)`
 * @returns {{act: 'split'|'skip'|'refuse', why: string}}
 */
export function splitGate({ state, labels, project, body, briefExists, preStandard = false, preStandardUnread = null, openPr }) {
  if (state !== 'OPEN') return { act: 'skip', why: 'the issue is closed' };
  if (!labels.includes(SPLIT_LABEL)) return { act: 'skip', why: `the issue does not carry \`${SPLIT_LABEL}\`` };
  // Someone chose to RE-RUN it instead: a split PR and an implementer PR that both close
  // the same issue leave whichever merges second orphaned.
  if (labels.includes('agent:implement')) return { act: 'skip', why: 'the issue carries `agent:implement` — a re-run is under way, so it is not split' };
  const route = exhaustedRoute({ project, body });
  if (route.label !== SPLIT_LABEL) return { act: 'refuse', why: route.why };
  if (!briefExists) return { act: 'refuse', why: `project #${project} has no brief on the default branch (\`docs/projects/${project}.md\`), so there is nothing to split — a human decomposes it` };
  // AN UNREADABLE EXEMPTIONS FILE IS A REFUSAL, NOT A CRASH (kanon#54). Whether the brief may
  // be edited is unknown, so the lane doesn't edit it, and the issue leaves the split label
  // with the file's problem named, rather than sitting there with no verdict.
  if (preStandardUnread) return { act: 'refuse', why: `whether project #${project}'s brief is pre-standard can't be decided (${preStandardUnread}), so the split lane does not edit it — fix the file, or split this item by hand` };
  // PRE-STANDARD BRIEFS STAY BYTE-IDENTICAL (`isPreStandard`, `K-LAYOUT-15`; §5.3;
  // the developer's ruling on RA-2407). A split is the second sanctioned post-approval
  // edit for a post-standard brief only, so an oversized item in one of these goes to a
  // human, who splits it by hand as RA-1966 did for RA-1019.
  if (preStandard) return { act: 'refuse', why: `project #${project}'s brief predates the RA-1742 standard and stays byte-identical (§5.3), so the split lane does not edit it — a human splits this item by hand` };
  if (openPr != null) return { act: 'skip', why: `split PR #${openPr} is already open for this issue` };
  return { act: 'split', why: `project #${project}'s brief item for this issue is to be split` };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}
const ghJson = (args) => JSON.parse(gh(args));

/** The project an issue belongs to — the marker must be the LAST non-empty line, the
 *  rule `declaresMembership` in `lead-reconcile.mjs` applies (RA-1066) — or null. The
 *  three writers above share this copy; `split-lineage.test.ts` holds it to
 *  `declaresMembership` over the same bodies, so the two cannot drift apart silently. */
export function projectOf(body) {
  const last = String(body ?? '').split(/\r?\n/).filter((l) => l.trim() !== '').at(-1)?.trim() ?? '';
  const m = /^<!-- qa:project (\d+) -->$/.exec(last);
  return m ? Number(m[1]) : null;
}

/**
 * Is the project's brief pre-standard? A missing or malformed exemptions file is returned as
 * `preStandardUnread`, its one-line reason, for `splitGate` to refuse on (kanon#54).
 * @param {number|null} project
 */
async function preStandardOf(project) {
  if (project == null) return { preStandard: false, preStandardUnread: null };
  // Imported HERE, not at the top: `brief-guard.mjs` imports `lead-reconcile.mjs`,
  // which imports this module, and a static import would close that cycle — so would
  // awaiting `gate` at top level (see the CLI line below).
  const { isPreStandard } = await import('./brief-guard.mjs');
  try {
    return { preStandard: isPreStandard(`docs/projects/${project}.md`), preStandardUnread: null };
  } catch (e) {
    if (e?.name !== 'DeclarationError') throw e;
    return { preStandard: false, preStandardUnread: e.message };
  }
}

/** The workflow's pre-filter: decide, act on a refusal, and publish the verdict. */
async function gate() {
  const issue = String(process.env.ISSUE ?? '');
  const out = (k, v) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
  if (!/^\d+$/.test(issue)) {
    console.log('::notice title=split-lineage::no issue number on this run — nothing to split');
    out('act', 'skip');
    return;
  }
  const view = ghJson(['issue', 'view', issue, '--repo', REPO, '--json', 'state,labels,body']);
  const project = projectOf(view.body);
  const branch = splitBranch(issue);
  const prs = splitBranches(issue).flatMap((head) =>
    ghJson(['pr', 'list', '--repo', REPO, '--state', 'open', '--head', head, '--json', 'number']));
  const verdict = splitGate({
    state: view.state,
    labels: (view.labels ?? []).map((l) => l.name),
    project,
    body: view.body,
    briefExists: project != null && existsSync(`docs/projects/${project}.md`),
    ...(await preStandardOf(project)),
    openPr: prs[0]?.number ?? null,
  });
  console.log(`#${issue}: ${verdict.act} — ${verdict.why}`);
  if (verdict.act === 'refuse' && process.env.APPLY === '1') {
    // The human label FIRST, as the crash job and the sweep order it: if the removal
    // then failed the issue is still parked for a human, not carrying neither label.
    gh(['issue', 'edit', issue, '--repo', REPO, '--add-label', HUMAN_LABEL]);
    gh(['issue', 'edit', issue, '--repo', REPO, '--remove-label', SPLIT_LABEL]);
    gh(['issue', 'comment', issue, '--repo', REPO, '--body', [
      `**Not splitting this issue** — moving it from \`${SPLIT_LABEL}\` to \`${HUMAN_LABEL}\` for a human.`,
      '',
      `- ${verdict.why}.`,
      '',
      '_Posted by `scripts/split-lineage.mjs` (RA-1781)._',
    ].join('\n')]);
    console.log(`::warning title=split-lineage::#${issue} handed to a human (${HUMAN_LABEL}) — ${verdict.why}`);
  }
  out('act', verdict.act);
  out('project', project ?? '');
  out('branch', branch);
}

const IS_CLI = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (IS_CLI && !REPO) {
  console.error('split-lineage: GITHUB_REPOSITORY must be set');
  process.exit(2);
}
// NO TOP-LEVEL `await` (the Reviewer, RA-2407): `gate` imports `brief-guard.mjs`, whose graph
// leads back here through `lead-reconcile.mjs`. Suspending THIS module's evaluation on
// that import deadlocks it (Node exits 13, "unsettled top-level await"); a floating
// promise lets this module finish evaluating first. `split-lineage.test.ts` runs the
// gate as a CLI to hold that.
if (IS_CLI && process.argv[2] === 'gate') gate().catch((e) => { console.error(e); process.exitCode = 1; });
if (IS_CLI && process.argv[2] === 'check-pr') {
  // Warn-only: a split PR is still reviewed by the Reviewer and merged by a human.
  const pr = String(process.env.PR ?? '');
  if (/^\d+$/.test(pr)) {
    const missing = childrenMissingMarker(gh(['pr', 'diff', pr, '--repo', REPO]));
    for (const h of missing) console.log(`::warning title=agent-lead-split::PR #${pr} adds \`${h}\` with no \`qa:split-of\` marker line — without it a child that exhausts is split AGAIN (RA-1781)`);
    if (!missing.length) console.log(`every child PR #${pr} adds carries its lineage marker`);
  }
}
