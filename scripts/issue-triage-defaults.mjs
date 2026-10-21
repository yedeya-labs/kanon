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
 * proposes a milestone other than a bucket, except a roadmap milestone `plan()`
 * transcribes as given from an approved brief (`K-WORK-5`); the RA-729 signal
 * survives as a label a human acts on, which is where a human step is cheapest
 * to justify.
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
 * ONE MODULE, TWO CALLERS (kanon#164, `K-WORK-8`). `decide()` is the backstop's, for
 * an issue that arrives bare. `plan()` is the filer's: it takes the labels the filer
 * chose (its severity among them) and an explicit milestone transcribed from an
 * approved brief, and returns the exact `--label` and `--milestone` arguments of one
 * atomic `gh issue create` (`K-WORK-2`). They do not yet keep to separate issues:
 * `decide()` writes a milestone only on a bare issue, but on a filed one it still adds
 * `gate-candidate` and `qa:needs-severity` until the filers move to `plan()`, which
 * leaves neither to add. Retiring those writes is migration step 2's to decide.
 *
 * THE SHADOW (kanon#164, migration step 1). Until the filers move to `plan()`, the
 * backstop logs what `plan()` would have chosen for each filed issue next to what its
 * filer chose, and writes nothing from it, so a week of real filings shows where the
 * two disagree before any prompt's routing prose is deleted. That week's commonest disagreement
 * was a filer's subject (`K-WORK-4`), which `plan()` now takes from the filer (migration step 2).
 *
 * THE FILING SKILL (kanon#164, migration step 2): `skills/file-issue/SKILL.md` is how a filer
 * asks `plan()`. The Explorer's sweep, the code audit, verify-acs, merge-reconcile and the Reviewer file through it; the Lead's reconciler moves last.
 *
 * Exercised by tests/unit/issue-triage-defaults.test.ts. Run it locally exactly
 * as the workflow does:
 *   gh issue view <n> --json milestone,labels | node scripts/issue-triage-defaults.mjs
 * and as a filer does:
 *   node scripts/issue-triage-defaults.mjs plan --label follow-up --label agent:reviewer --label sev:high
 */

import { isCliEntry } from './lib/cli-entry.mjs';

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
const EXPLORER = 'agent:explorer';
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

/** What `plan()` throws for a filing it won't plan: the filer fixes its labels and asks again. */
export class PlanRefusal extends Error {}

/**
 * The two subjects a filer may name (`K-WORK-4`): product work, or engineering-platform and
 * pipeline work. Like severity it is the filer's judgment, read and never derived.
 */
export const SUBJECTS = ['product', 'pipeline'];

/**
 * The stream an issue belongs to, which never takes a roadmap milestone or a candidacy
 * (`K-WORK-11`), or null.
 */
function streamOf(set, pipeline) {
  if (set.has(EXPLORER)) return 'an Explorer bug';
  if (pipeline) return 'pipeline work';
  return null;
}

/**
 * Plan one filing: the labels and the milestone a filer passes to a single `gh issue create`.
 *
 * It owns the rule `decide()` applies to a bare issue, and adds what only a filer can be held
 * to: a reviewer follow-up names its severity (`K-WORK-9`), a candidacy is the rule's and never
 * the filer's (`K-WORK-10`), and neither stream goes on a roadmap milestone (`K-WORK-11`). Each
 * of those REFUSES rather than corrects, so the filer sees its mistake instead of an issue filed
 * as something it didn't mean.
 *
 * A stream's explicit milestone is held to the BUCKETS by name, not to "not dated": the bucket
 * names are fixed (`K-WORK-4`), so anything else is a roadmap milestone or a typo, and telling
 * which would need a read of the repository this function doesn't make.
 *
 * THE SUBJECT IS THE FILER'S, as the severity is (kanon#164's shadow). Routing is by subject
 * (`K-WORK-4`), and a review follow-up that asks for a CI guard is pipeline work with no
 * `pipeline-improvement` label on it: that label marks a proposal to improve the pipeline, not
 * every issue whose subject is the pipeline. The shadow's replay over a week of real filings
 * found filers routing exactly those to the platform bucket, rightly, where a label-only rule
 * sent them to the product one. So the filer names the subject, `pipeline` or `product`, and
 * this function maps it to the bucket. The label still implies `pipeline`, and naming `product`
 * beside it is refused.
 *
 * @param {string[]} labels the filer's choice, its `sev:*` included
 * @param {{explicitMilestone?: string, subject?: string}} [options] `explicitMilestone`: a
 *   milestone transcribed from an approved brief (`K-WORK-5`), passed through as given, never an
 *   agent's own routing choice. `subject`: one of `SUBJECTS`, the filer's judgment of what the
 *   issue is about; absent, it is read from the labels.
 * @returns {{milestone: string, labels: string[], severity: string|null, gateCandidate: boolean, reason: string, args: string[]}}
 */
export function plan(labels = [], { explicitMilestone = '', subject = '' } = {}) {
  const set = new Set(labels);
  const explicit = String(explicitMilestone ?? '').trim();
  const named = String(subject ?? '').trim();
  if (named && !SUBJECTS.includes(named)) {
    throw new PlanRefusal(`subject "${named}" is neither ${SUBJECTS.join(' nor ')} (K-WORK-4)`);
  }
  if (named === 'product' && set.has(PIPELINE_IMPROVEMENT)) {
    throw new PlanRefusal(`carries ${PIPELINE_IMPROVEMENT}, which is pipeline work, yet names the subject product (K-WORK-4)`);
  }
  const pipeline = named === 'pipeline' || set.has(PIPELINE_IMPROVEMENT);

  const severities = SEVERITY_LABELS.filter((sev) => set.has(sev));
  if (severities.length > 1) {
    throw new PlanRefusal(`carries ${severities.join(' and ')}: a filer applies exactly one sev:* (K-WORK-9)`);
  }
  if (isReviewerFollowUp(labels) && severities.length === 0) {
    throw new PlanRefusal('a follow-up + agent:reviewer issue needs its sev:*, which only its filer can judge (K-WORK-9)');
  }

  const stream = streamOf(set, pipeline);
  if (explicit && stream && !BUCKET_MILESTONES.includes(explicit)) {
    throw new PlanRefusal(`"${explicit}" is not a bucket, and ${stream} never goes on a roadmap milestone (K-WORK-11)`);
  }

  const milestone = explicit || (pipeline ? PIPELINE_MILESTONE : DEFAULT_MILESTONE);
  let reason = 'no unambiguous destination';
  if (explicit) reason = 'transcribed from an approved brief';
  else if (set.has(PIPELINE_IMPROVEMENT)) reason = `labelled ${PIPELINE_IMPROVEMENT}`;
  else if (pipeline) reason = 'the filer named the subject pipeline';

  // Pipeline work is never a candidate (`K-WORK-11`), on whichever bucket a brief put it.
  const gateCandidate = !pipeline && isGateCandidate(labels, milestone);
  if (set.has(GATE_CANDIDATE_LABEL) && !gateCandidate) {
    throw new PlanRefusal(
      `carries ${GATE_CANDIDATE_LABEL}, which K-WORK-10 gives only a sev:critical or sev:high follow-up + agent:reviewer issue on the product bucket: drop it, plan() adds it where the rule does`,
    );
  }

  const planned = [...set];
  if (gateCandidate && !set.has(GATE_CANDIDATE_LABEL)) planned.push(GATE_CANDIDATE_LABEL);
  const args = [...planned.flatMap((label) => ['--label', label]), '--milestone', milestone];
  return { milestone, labels: planned, severity: severities[0] ?? null, gateCandidate, reason, args };
}

/**
 * The backstop's shadow of `plan()` (kanon#164, migration step 1): what it would have chosen
 * for a filed issue next to what the filer chose. Null on a bare issue, which has no filer's
 * choice and is the backstop's own.
 *
 * @param {{labels: string[], milestone?: string}} issue the live re-read, as `decide()` takes it
 */
export function shadow({ labels = [], milestone = '' } = {}) {
  if (!milestone) return null;
  const filed = { milestone, gateCandidate: labels.includes(GATE_CANDIDATE_LABEL) };
  // A filer that chose the platform bucket named the subject pipeline, which is its judgment to
  // make (`plan()`'s `subject`), so the shadow asks with it and compares the rest. A roadmap
  // milestone is still compared as it was: the backstop can't tell a brief's from a filer's own.
  const subject = milestone === PIPELINE_MILESTONE ? 'pipeline' : '';
  try {
    const p = plan(labels, { subject });
    const planned = { milestone: p.milestone, gateCandidate: p.gateCandidate };
    const agrees = planned.milestone === filed.milestone && planned.gateCandidate === filed.gateCandidate;
    return { planned, filed, agrees, refused: null };
  } catch (err) {
    if (!(err instanceof PlanRefusal)) throw err;
    return { planned: null, filed, agrees: false, refused: err.message };
  }
}

/** The shadow's one log line. */
export function shadowLine(s) {
  const candidate = (yes) => (yes ? ' with gate-candidate' : '');
  const would = s.refused ? `plan() would refuse: ${s.refused}` : `plan() would file on "${s.planned.milestone}"${candidate(s.planned.gateCandidate)}`;
  return `shadow (writes nothing): ${would}; the filer chose "${s.filed.milestone}"${candidate(s.filed.gateCandidate)} — ${s.agrees ? 'agrees' : 'differs'}`;
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
    '| `sev:critical` | data loss, a security or isolation breach, or an outage |',
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

/** One argument as a POSIX shell reads it back: bare when it is safe, single-quoted when not. */
const shellQuote = (arg) => (/^[\w.:/@=+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`);

/** The flags `plan` takes, each with a value. The filing skill passes only these. */
export const PLAN_FLAGS = ['--label', '--subject', '--explicit-milestone'];

const PLAN_USAGE = 'usage: issue-triage-defaults.mjs plan --label <name>... [--subject product|pipeline] [--explicit-milestone <title>]';

/**
 * `plan --label <name>... [--subject product|pipeline] [--explicit-milestone <title>]`: one JSON
 * plan on stdout, with `ghArgs`, the arguments as one shell-quoted string. A refusal exits 1 and
 * prints only `{refused}`, so no arguments exist to file with. There is no `--milestone`: a
 * filer's own routing choice is exactly what this replaces. The filer names the subject, and only
 * a brief's milestone is explicit.
 */
function planCli(argv) {
  const labels = [];
  let explicitMilestone = '';
  let subject = '';
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined || !PLAN_FLAGS.includes(flag)) {
      return { code: 2, out: '', err: `${PLAN_USAGE}\n` };
    }
    if (flag === '--label') labels.push(value);
    else if (flag === '--subject') subject = value;
    else explicitMilestone = value;
  }
  try {
    const p = plan(labels, { explicitMilestone, subject });
    return { code: 0, out: JSON.stringify({ ...p, ghArgs: p.args.map(shellQuote).join(' ') }), err: '' };
  } catch (err) {
    if (!(err instanceof PlanRefusal)) throw err;
    return { code: 1, out: JSON.stringify({ refused: err.message }), err: `plan refused: ${err.message}\n` };
  }
}

/**
 * CLI. With no arguments it is the backstop: `gh issue view … --json milestone,labels` on
 * stdin, one JSON decision on stdout, and the shadow's line on stderr. Keeping the routing
 * table out of the workflow's bash means there is only one copy of it, and it is the copy
 * under test (the drift argument pr-title.yml settled for the commit-taxonomy pattern).
 *
 * @param {string[]} argv
 * @param {string} stdin
 * @returns {{code: number, out: string, err: string}}
 */
export function cli(argv, stdin) {
  if (argv[0] === 'plan') return planCli(argv.slice(1));
  const issue = JSON.parse(stdin || '{}');
  const live = {
    labels: (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
    milestone: issue.milestone?.title ?? '',
  };
  const decision = decide(live);
  const s = shadow(live);
  const out = JSON.stringify({
    ...decision,
    needsSeverityLabel: NEEDS_SEVERITY_LABEL,
    gateCandidateLabel: GATE_CANDIDATE_LABEL,
    comment: decision.needsSeverity ? needsSeverityComment() : '',
    shadow: s,
  });
  return { code: 0, out, err: s ? `${shadowLine(s)}\n` : '' };
}

if (isCliEntry(import.meta.url)) {
  const argv = process.argv.slice(2);
  let stdin = '';
  if (argv[0] !== 'plan') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    stdin = Buffer.concat(chunks).toString('utf8');
  }
  const { code, out, err } = cli(argv, stdin);
  process.stdout.write(out);
  process.stderr.write(err);
  process.exitCode = code;
}
