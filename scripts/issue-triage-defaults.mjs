// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
/**
 * Milestone default + severity presence check for `issues: [opened]` (RA-729,
 * extending RA-601's safety net).
 *
 * WHAT RA-729 FOUND: 2 of 149 reviewer-filed follow-ups carried any `sev:*` label
 * and 2 of 149 ever reached the launch gate, so a hole letting anyone register
 * for free (RA-585) was indistinguishable, on every surface, from a stale doc
 * comment. Three separable parts fix that; this file is parts 2 and 3.
 *
 *   1. EMIT    — the filer applies a `sev:*` (prompt text in agent-review.yml /
 *                agent-merge-reconcile.yml, rubric in explorer-playbook.md).
 *   2. ENFORCE — a `follow-up` + `agent:reviewer` issue arriving with no `sev:*`
 *                is flagged HERE, on the issue itself.
 *   3. SUGGEST — `sev:critical` / `sev:high` in that cohort carry the
 *                `gate-candidate` label, and stay on their BUCKET (RA-1616).
 *
 * RA-1616 REPLACED RA-729'S DIRECT GATE ROUTE. Until 2026-09-25 part 3 wrote the
 * launch gate itself — the one place an agent decided a roadmap placement.
 * The developer's decision (2026-09-24, on RA-1616) is that agents SUGGEST and
 * only the developer places work on a roadmap milestone. So nothing here ever
 * proposes a milestone other than a bucket; the RA-729 signal survives as a
 * label a human acts on, which is where a human step is cheapest to justify.
 *
 * SEVERITY IS READ, NEVER DERIVED. Nothing here looks at the issue title or
 * body. Severity is a claim about reachability and impact that lives in the diff
 * and its callers — RA-585 ("a public/student caller can select gateway:'fake'",
 * critical) and RA-622 ("kiosk_code has no unique index", correctly low) have the
 * same title shape, and what separates them is the auth wrapper the reviewer
 * read. A keyword rule mislabels exactly that pair; so would a second model pass
 * working from a lossy summary. This function's only input is a label the filer
 * already chose.
 *
 * THE WRITE IS BUCKET-ONLY AGAIN, which is what makes the read/write race
 * tolerable. The workflow's ordering 3 (an edit landing between the re-read and
 * the write) can overwrite a deliberately chosen milestone, and `gh issue edit`
 * has no compare-and-swap. That was tolerable before RA-729 because the damage
 * was bucket -> bucket; RA-729 sharpened it by making a destination the gate, and
 * RA-1616 un-sharpens it: `decide()` proposes only `BUCKET_MILESTONES`, and only
 * when the live re-read says the issue is still bare.
 *
 * `gate-candidate` is an ADDITIVE label, so it has no such race: adding it never
 * displaces anything the filer chose. It is proposed only when missing, only for
 * the reviewer cohort, and never for `pipeline-improvement` work (row 3 wins —
 * QA-pipeline work is not launch-gating however severe) — so it cannot become a
 * back door for an Explorer bug either.
 *
 * A missing severity degrades to the DEFAULT bucket and no candidacy: absence is
 * not a severity claim.
 *
 * Exercised by tests/unit/issue-triage-defaults.test.ts. Run it locally exactly
 * as the workflow does:
 *   gh issue view <n> --json milestone,labels | node scripts/issue-triage-defaults.mjs
 */

/** Product outputs and anything without an unambiguous home. */
export const DEFAULT_MILESTONE = 'Product Backlog';
/** Engineering-platform / QA-pipeline work (AGENTS.md row 3). */
export const PIPELINE_MILESTONE = 'Development Automation';
// THE LAUNCH GATE IS NOT NAMED HERE (kanon#54). It is a roadmap milestone, so its name is
// the Stakeholder's (`K-WORK-5`, `K-WORK-6`), and a constant would be one project's gate on
// every repository. The needs-severity comment says "the launch gate"; which milestone that is
// today is visible on the repository, and `decide()` never writes it anyway: placing work on
// the roadmap is a person's call (RA-1616).

/**
 * Every milestone `decide()` may write. Buckets only — undated, ongoing, and the
 * only rows of AGENTS.md's table an agent may route to on its own (rows 1 and 3).
 */
export const BUCKET_MILESTONES = [DEFAULT_MILESTONE, PIPELINE_MILESTONE];

/**
 * The filer's claim that a follow-up is launch-gating (RA-1616). A SUGGESTION: the
 * issue stays on its bucket until the developer moves it to the gate.
 */
export const GATE_CANDIDATE_LABEL = 'gate-candidate';

/** The rubric in docs/qa/explorer-playbook.md, most severe first. */
export const SEVERITY_LABELS = ['sev:critical', 'sev:high', 'sev:medium', 'sev:low'];

/**
 * The tiers that make a reviewer follow-up a gate CANDIDATE: `critical` is
 * data loss / security / tenant-isolation / outage, `high` is a core flow broken
 * with no workaround. `medium` has a workaround by definition, which is exactly
 * the line between work that gates a pilot and work that doesn't.
 */
export const GATE_SEVERITIES = ['sev:critical', 'sev:high'];

/** Applied to a reviewer follow-up filed without a severity (part 2). */
export const NEEDS_SEVERITY_LABEL = 'qa:needs-severity';

const FOLLOW_UP = 'follow-up';
const REVIEWER = 'agent:reviewer';
const PIPELINE_IMPROVEMENT = 'pipeline-improvement';

/**
 * The severity the filer applied, or null. Ties break toward the MOST severe:
 * routing a critical hole into a bucket because a stray `sev:low` sorted first
 * is the failure mode this whole issue is about.
 */
export function severityOf(labels) {
  const set = new Set(labels);
  return SEVERITY_LABELS.find((sev) => set.has(sev)) ?? null;
}

/**
 * The narrow cohort this rule governs. BOTH labels are required, which is what
 * keeps the Explorer's bug stream out of gate candidacy — `explorer-playbook.md` is
 * explicit that an incoming bug stream would wreck the burndown, and its bugs
 * are `agent:explorer` + `qa:needs-triage` however severe.
 */
export function isReviewerFollowUp(labels) {
  const set = new Set(labels);
  return set.has(FOLLOW_UP) && set.has(REVIEWER);
}

/** Part 2: a reviewer follow-up that arrived with no severity judgment on it. */
export function severityGap(labels) {
  return isReviewerFollowUp(labels) && severityOf(labels) === null;
}

/**
 * Should this issue carry `gate-candidate`? A reviewer follow-up at a gate
 * severity that sits — or is about to be defaulted — on the PRODUCT bucket.
 *
 * The milestone matters, not just the labels. Row 3 wins over the gate, and a
 * filer routes QA-pipeline work to Development Automation by MILESTONE, usually
 * with no `pipeline-improvement` label — so a label-only test would put a CI-guard
 * follow-up in the developer's gate queue. And an issue already on a roadmap
 * milestone has been placed; suggesting it again only dilutes the queue.
 *
 * @param {string[]} labels
 * @param {string} [milestone] the live milestone, '' when bare
 */
export function isGateCandidate(labels, milestone = '') {
  const set = new Set(labels);
  const destination = milestone || (set.has(PIPELINE_IMPROVEMENT) ? PIPELINE_MILESTONE : DEFAULT_MILESTONE);
  return (
    isReviewerFollowUp(labels) &&
    GATE_SEVERITIES.includes(severityOf(labels)) &&
    !set.has(PIPELINE_IMPROVEMENT) &&
    destination === DEFAULT_MILESTONE
  );
}

/**
 * Decide what (if anything) to write.
 *
 * @param {{labels: string[], milestone?: string}} issue — the LIVE re-read, not
 *   the webhook payload. An agent that creates then edits opens the issue bare,
 *   so the payload says null while its real milestone is landing concurrently.
 * @returns {{milestone: string|null, reason: string, needsSeverity: boolean, addGateCandidate: boolean, severity: string|null}}
 *   `milestone: null` means leave it alone; otherwise it is always one of
 *   `BUCKET_MILESTONES`. `needsSeverity` and `addGateCandidate` are independent
 *   of the milestone decision — the filer sets the milestone at creation, so
 *   riding either on the bare-issue branch would never fire it on the path it
 *   exists to serve.
 */
export function decide({ labels = [], milestone = '' } = {}) {
  const severity = severityOf(labels);
  const needsSeverity = severityGap(labels);
  const set = new Set(labels);
  const addGateCandidate = isGateCandidate(labels, milestone) && !set.has(GATE_CANDIDATE_LABEL);
  const flags = { needsSeverity, addGateCandidate, severity };

  if (milestone) {
    return { milestone: null, reason: `already carries "${milestone}"`, ...flags };
  }

  // Subject beats provenance (AGENTS.md: "row 3 wins").
  if (set.has(PIPELINE_IMPROVEMENT)) {
    return { milestone: PIPELINE_MILESTONE, reason: `labelled ${PIPELINE_IMPROVEMENT}`, ...flags };
  }

  // A gate-severity reviewer follow-up lands HERE too, on the bucket, with the
  // `gate-candidate` flag above. There is deliberately no gate branch (RA-1616).
  return { milestone: DEFAULT_MILESTONE, reason: 'no unambiguous destination', ...flags };
}

/**
 * The comment the presence check leaves on the issue. It lives here rather than
 * in the workflow's bash for the same reason the routing table does: it restates
 * the rubric and the gate-candidate rule, and a second copy of either is a copy that can
 * drift (RA-636 is what that costs). It also has to be worth reading — the point
 * of RA-729 is that this lands on a surface a person actually opens, so it says
 * what to do and why nothing did it automatically.
 */
export function needsSeverityComment() {
  return [
    '<!-- qa:needs-severity -->',
    'This `follow-up` + `agent:reviewer` issue arrived with no `sev:*` label, so its impact is',
    'unrecorded and it sorts identically to every other follow-up — the gap RA-729 closed.',
    '',
    '**Apply one**, using the rubric in `docs/qa/explorer-playbook.md`:',
    '',
    '| label | means |',
    '|---|---|',
    '| `sev:critical` | data loss, security, tenant-isolation breach, or outage |',
    '| `sev:high` | core flow broken, no workaround |',
    '| `sev:medium` | flow degraded, workaround exists |',
    '| `sev:low` | cosmetic / minor |',
    '',
    `\`sev:critical\` and \`sev:high\` on a reviewer follow-up mean *launch-gating*: **also apply**`,
    `\`${GATE_CANDIDATE_LABEL}\` (nothing re-runs to add it once this issue is open), and leave it on`,
    `its bucket — a person decides whether it joins the launch gate. QA-pipeline`,
    `work is never a candidate, and the rest are not gating.`,
    '',
    'Severity is a judgment about **reachability and impact** — it lives in the diff and its',
    'callers, which is why nothing here infers it from this issue\'s text. Only the filer, who',
    `read them, can make it. Remove \`${NEEDS_SEVERITY_LABEL}\` once you have set one.`,
  ].join('\n');
}

/**
 * CLI: `gh issue view … --json milestone,labels` on stdin, one JSON decision on
 * stdout. Keeping the routing table out of the workflow's bash means there is
 * only one copy of it, and it is the copy under test (the drift argument
 * pr-title.yml settled for the commit-taxonomy pattern).
 */
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const issue = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const decision = decide({
    labels: (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
    milestone: issue.milestone?.title ?? '',
  });
  process.stdout.write(
    JSON.stringify({
      ...decision,
      needsSeverityLabel: NEEDS_SEVERITY_LABEL,
      gateCandidateLabel: GATE_CANDIDATE_LABEL,
      comment: decision.needsSeverity ? needsSeverityComment() : '',
    }),
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
