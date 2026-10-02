// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
/**
 * Weekly dev-activity digest for the stakeholder Slack channel (RA-502).
 *
 * AUDIENCE: a co-founder tracking runway — someone who is not in the day-to-day
 * and is asking one question, "is the money turning into progress toward the
 * thing that makes money?". That is why the headline is MILESTONE BURNDOWN and
 * not activity volume: PR and issue counts go up whether the week was good or
 * bad, so they appear once, at the bottom, as texture.
 *
 * This is an ADDITION to the per-release announcements, not a replacement
 * — those double as deploy-failure alerting (announce-deploy.mjs). It posts to
 * the same webhook, once a week.
 *
 * DELIBERATELY ABSENT:
 * - **Environment vocabulary.** With CD, delivered work lands on staging
 *   automatically and promoting to production is a separate choice; neither
 *   distinction means anything to this reader. The digest says "delivered".
 * - **Round-number celebrations.** At ~49 merged PRs and ~24 releases a week, a
 *   multiple of 100 is crossed every fortnight — a metronome, not an event. The
 *   celebration fires on MILESTONE COMPLETION, of which there are four, ever.
 * - **Open/remaining counts framed as to-dos.** Remaining work is stated as
 *   burndown ("27 of 38 done"), never as a list of things awaiting someone.
 *   ONE deliberate exception (RA-2399, the developer's decision of 2026-09-25):
 *   the *Gate candidates* list, because since RA-1616 whether a launch-gating
 *   follow-up joins the gate is a human decision and this is its only
 *   scheduled surface. See `renderGateCandidates`.
 *
 * COUNTING RULE (AGENTS.md): issue counts come from `is:issue` searches, NEVER
 * from milestone.open_issues/closed_issues — those silently include pull
 * requests (Production Ready reads 44 through that API but is 38 real issues).
 *
 * Dependency-free (Node 20+: global fetch), and exercised locally exactly as CI
 * runs it:
 *   GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=<owner>/<repo> \
 *   DRY_RUN=1 node scripts/weekly-digest.mjs
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, SLACK_RELEASE_WEBHOOK, NARRATIVE
 * (optional prose from the model step — the post degrades to numbers-only when
 * absent), WEEK_END (optional ISO date, defaults to now; for reproducible runs),
 * DRY_RUN (print instead of posting).
 */

import { parseSections, scopeOf, cleanBullet, dropScopePrefix, INTERNAL_SCOPES } from './lib/release-notes.mjs';
import { isRoadmapMilestone } from './lib/milestones.mjs';
import { GATE_CANDIDATE_LABEL, SEVERITY_LABELS, severityOf as severityOfLabels } from './issue-triage-defaults.mjs';

/**
 * Scopes that are real engineering work but have no stakeholder-facing surface.
 * Rolled into ONE honest line rather than hidden — the week is mostly this, and
 * pretending otherwise would undersell it as badly as listing it would bore.
 *
 * Kept separate from the shared INTERNAL_SCOPES (which announce-deploy also
 * uses) so widening it here can never change what the release announcement
 * calls a Feature.
 */
export const INTERNAL_AREAS = new Set([
  ...INTERNAL_SCOPES,
  'infra', 'observability', 'dev', 'ops', 'seed', 'deploy', 'deps',
  'process', 'lint',
]);
// `security` and `jobs` are deliberately NOT internal. No visible surface is not
// the same as not worth telling this reader: a security fix is worth hearing, and
// this repo's `jobs:` commits are product behaviour, not cron plumbing — dunning
// partially-paid students is money being chased, and course-completion rolling
// enrollments is the core lifecycle.

/**
 * Internal scopes → a handful of plain-English buckets. Dumping raw scopes gave
 * "plus ci, deploy, deps dev, observability, qa, release, test work", which is
 * both unreadable and jargon; this reader wants to know the shape of the effort,
 * not its commit taxonomy.
 */
const INTERNAL_PHRASES = new Map([
  ['ci', 'deployment & CI'], ['cd', 'deployment & CI'], ['build', 'deployment & CI'],
  ['release', 'deployment & CI'], ['deploy', 'deployment & CI'],
  ['qa', 'automated testing'], ['test', 'automated testing'], ['tests', 'automated testing'],
  ['deps', 'dependency updates'], ['deps-dev', 'dependency updates'],
  ['infra', 'infrastructure'], ['observability', 'infrastructure'], ['ops', 'infrastructure'],
  ['docs', 'documentation'], ['doc', 'documentation'],
]);
/** Anything unmapped is internal tooling — a catch-all beats leaking a raw scope. */
export const internalPhrases = (scopes) => [
  ...new Set(scopes.map((s) => INTERNAL_PHRASES.get(s) ?? 'internal tooling')),
].sort();

/**
 * Strip the trailing `(<url|RA-123>)` reference cleanBullet appends. The release
 * announcement keeps it — its readers follow PR links. This reader does not, and
 * a line of URLs per item makes the section unreadable at a glance.
 */
export const dropRef = (s) => s.replace(/\s*\(<https?:[^|]*\|[^>]*>\)\s*$/, '').trim();

/** Re-exported: the definition and its reasoning live in ./lib/milestones.mjs (RA-1633). */
export { isRoadmapMilestone };

/** Display name for a conventional-commit scope. */
export const areaLabel = (scope) =>
  scope.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Group release-note bullets by product area (the commit scope), splitting off
 * internal work. Returns { areas: [{area, items}], internalScopes: [...] }.
 *
 * Ordering is by item count then name, so the areas that actually moved lead —
 * and it is stable, which matters because an unstable order makes two adjacent
 * weeks look more different than they were.
 */
export function groupByArea(bullets) {
  const byScope = new Map();
  const internalScopes = new Set();
  for (const raw of bullets) {
    const scope = scopeOf(raw);
    if (!scope) continue;
    if (INTERNAL_AREAS.has(scope)) {
      internalScopes.add(scope);
      continue;
    }
    if (!byScope.has(scope)) byScope.set(scope, new Set());
    byScope.get(scope).add(dropRef(dropScopePrefix(cleanBullet(raw))));
  }
  const areas = [...byScope.entries()]
    .map(([area, items]) => ({ area, items: [...items] }))
    .sort((a, b) => b.items.length - a.items.length || a.area.localeCompare(b.area));
  return { areas, internalScopes: [...internalScopes].sort() };
}

/**
 * Render the delivered-work section. AGGREGATES, never enumerates: at ~49
 * merged PRs a week a full list is unreadable, and a truncated one is worse
 * because the tail is where most of it ends up.
 */
export function renderDelivered({ areas, internalScopes }, { maxAreas = 6, maxPerArea = 3 } = {}) {
  if (areas.length === 0 && internalScopes.length === 0) return '';
  let out = '\n*Delivered*\n';
  for (const { area, items } of areas.slice(0, maxAreas)) {
    const shown = items.slice(0, maxPerArea).join(' · ');
    const extra = items.length - Math.min(items.length, maxPerArea);
    out += `• *${areaLabel(area)}* — ${shown}${extra > 0 ? ` _(+${extra} more)_` : ''}\n`;
  }
  const hiddenAreas = areas.length - Math.min(areas.length, maxAreas);
  if (hiddenAreas > 0) out += `• _…and ${hiddenAreas} other area${hiddenAreas === 1 ? '' : 's'}_\n`;
  if (internalScopes.length) {
    const phrases = internalPhrases(internalScopes);
    const list = phrases.length > 1
      ? `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}`
      : phrases[0];
    out += `• _plus ${list} behind the scenes_\n`;
  }
  return out;
}

/**
 * Render milestone progress. Gates get a burndown; buckets get flow (what moved
 * this week), because a bucket has no meaningful denominator — quoting one
 * would invent a finish line that doesn't exist.
 */
export function renderProgress(milestones) {
  const gates = milestones.filter(isRoadmapMilestone);
  const buckets = milestones.filter((m) => !isRoadmapMilestone(m) && m.closedThisWeek > 0);
  if (!gates.length && !buckets.length) return '';
  let out = '\n*Progress*\n';
  for (const m of gates) {
    const total = m.open + m.closed;
    const moved = m.closedThisWeek > 0 ? ` _(+${m.closedThisWeek} this week)_` : '';
    out += `• *${m.title}* — ${m.closed} of ${total} done${moved}\n`;
  }
  for (const m of buckets) {
    out += `• *${m.title}* — ${m.closedThisWeek} closed this week\n`;
  }
  return out;
}

/**
 * The celebration. Fires only on a milestone that COMPLETED — rare by
 * construction (there are four, ever), which is what keeps it from becoming
 * wallpaper.
 *
 * "Completed" is the week a HUMAN closed the milestone (its `closed_at`), not
 * the week its last issue closed. That is deliberate — closing it is the act
 * that declares the gate met — but it does mean a finished milestone left open
 * never announces itself.
 */
export function renderCompletions(milestones) {
  const done = milestones.filter((m) => m.open === 0 && m.closed > 0 && m.completedThisWeek);
  if (!done.length) return '';
  return done
    .map((m) => `\n:tada: *${m.title} is complete* — all ${m.closed} done.\n`)
    .join('');
}

/**
 * Sanity-check the counts against an invariant of this repo, and THROW rather
 * than post a wrong number.
 *
 * Every release packages at least one merged PR (release-please cuts nothing
 * when nothing releasable merged; since RA-2594 it runs on a schedule, in
 * batches), so releases without merged PRs means a query came back empty rather
 * than the week being quiet. That is exactly how the missing
 * `pull-requests: read` grant presented: the search API scopes results to what
 * the token can see, so `is:pr` returned an empty set with no 403 and no
 * warning, and the first live run reported "0 PRs merged · 25 releases".
 *
 * The one legitimate exception is a week whose ONLY release is a batch cut
 * after the week began from merges made before it, with nothing else merged all
 * week. At ~50 merged PRs a week that has not happened, and a red run for it is
 * the cheap direction to be wrong in.
 *
 * A digest that posts a confidently wrong number is worse than one that fails,
 * because the number is the product and nobody can tell it is wrong by reading
 * it. Failing here turns a silent misreport into a red run.
 */
export function assertCountsSane({ prsMerged, releases }) {
  if (releases > 0 && prsMerged === 0) {
    throw new Error(
      `Refusing to post: ${releases} releases but 0 merged PRs. Every release packages at least one merge, ` +
      'so this means the PR search returned nothing — most likely the workflow is missing `pull-requests: read`.',
    );
  }
}

/**
 * The issue-side equivalent, and the one that guards the HEADLINE.
 *
 * If the issue search fails open, `issuesClosed` is 0, every milestone drops out
 * as empty, and the post ships with **no Progress section at all** — the
 * burndown this digest exists to deliver, gone, presenting as a missing section
 * rather than a wrong number. `assertCountsSane` cannot see that: it keys on the
 * PR count, which is fine in that scenario.
 *
 * Guarding it needs something a quiet week can't imitate, because "0 issues
 * closed" is a perfectly legitimate week. The tell is a DISAGREEMENT BETWEEN TWO
 * INDEPENDENT APIs: the REST milestones endpoint reports its own totals without
 * going through search, so a milestone that REST says is populated while search
 * says is empty means search is returning nothing. A genuinely empty milestone
 * reads as empty on both, and no quiet week can produce the mismatch.
 *
 * This is also why the REST totals are safe to use HERE and nowhere else: we are
 * comparing shapes, not reporting a number, so the fact that they include pull
 * requests (`AGENTS.md`) does not matter — only whether they are non-zero.
 *
 * RETURNS whether the comparison was EFFECTIVE — whether it could have failed.
 * That is `restTotal > 0`: with nothing on the REST side there is no
 * disagreement to detect, so the call passes VACUOUSLY. Callers must count
 * effective checks, never invocations (see `assertGuardRan`); a fresh, still-
 * empty gate milestone is precisely the case where the two diverge, and treating
 * the call itself as coverage would put a green guard over the silent hole.
 */
export function assertMilestoneSearchSane(milestone, searchOpen, searchClosed, searchKind = 'issue') {
  const restTotal = (milestone.open_issues ?? 0) + (milestone.closed_issues ?? 0);
  if (restTotal === 0) return false;
  if (searchOpen + searchClosed === 0) {
    throw new Error(
      `Refusing to post: milestone "${milestone.title}" has ${restTotal} item(s) via the REST API but the ` +
      `${searchKind} search returned none — the search is failing open. Likely a malformed search qualifier (a ` +
      'milestone title containing a double quote breaks `milestone:"…"`) or a degraded search index. ' +
      'NOT a missing `issues: read`: on a private repo the REST milestones call would 403 first.',
    );
  }
  return true;
}

/** Does the REST milestones endpoint say this milestone holds anything at all? */
export const restPopulated = (m) => (m.open_issues ?? 0) + (m.closed_issues ?? 0) > 0;

/**
 * The anchor for the no-gate fallback: the milestone the REST API says holds the
 * MOST, so the cross-check runs against the strongest available evidence rather
 * than a one-item milestone. Deterministic on a tie (by title) so two runs of the
 * same week can't disagree about which milestone was checked.
 *
 * `null` when nothing is REST-populated — then there is genuinely nothing a
 * search could be failing open ABOUT, and the caller must not manufacture a
 * check (or a failure) out of it.
 */
export function pickCrossCheckMilestone(allMilestones) {
  const candidates = allMilestones.filter(restPopulated);
  if (!candidates.length) return null;
  const total = (m) => (m.open_issues ?? 0) + (m.closed_issues ?? 0);
  return candidates.reduce((best, m) => {
    const d = total(m) - total(best);
    return d > 0 || (d === 0 && m.title.localeCompare(best.title) < 0) ? m : best;
  });
}

/**
 * The no-gate fallback (RA-724). The in-loop guard only runs for milestones that
 * reach the per-milestone search branch — roadmap milestones, and anything that
 * completed this week. When none qualifies, a failing-open search reaches no
 * guard at all: every bucket drops out at `closedThisWeek === 0`, `milestones`
 * ends up empty, and the digest posts with no Progress section. Silent, and the
 * same shape as the bug the guard was added to fix. That is what the
 * `Development Ready` handover cost.
 *
 * **This is still reachable, and RA-1638 narrowed rather than closed it.** The
 * old wording rested on `GATE_MILESTONES` having exactly ONE entry, so the gap
 * opened the moment `Production Ready` was met and removed. Classifying by
 * `due_on` means every dated milestone qualifies, so a successor gate is picked
 * up the moment it is created rather than when someone edits this file — but
 * the window is not gone: it lasts from the old gate closing until a new dated
 * milestone exists, and a roadmap milestone created *without* a due date never
 * qualifies at all. Keep this fallback.
 *
 * Three constraints shaped this, and each is load-bearing:
 *
 *  1. **ONE search, only when nothing else covered it** (§12). The job is
 *     deliberately written to spend a handful of searches, not one per milestone,
 *     against a ~30 req/min limit. This adds exactly one request, and only in the
 *     no-effective-check case — with a populated gate present, as today, it never
 *     runs at all and the request count is unchanged.
 *  2. **It keeps the zero-vs-nonzero property.** The comparison is still two
 *     independent APIs disagreeing about EMPTY vs NON-EMPTY — never magnitudes,
 *     and never "issuesClosed === 0 is suspicious", which a genuinely quiet week
 *     imitates perfectly.
 *  3. **The query is deliberately NOT `is:issue`-scoped.** `restTotal` counts pull
 *     requests too (`AGENTS.md`: Production Ready reads 44 through REST but is 38
 *     real issues). An `is:issue` fallback landing on a milestone whose REST items
 *     happen to be all PRs would throw on a correct empty issue search. Searching
 *     issues AND PRs makes both sides count the same population, so the edge
 *     cannot arise — at the cost of one blind spot worth naming: if the token also
 *     lost `pull-requests: read` AND the anchor is all-PRs, this throws blaming
 *     the search. That is still a real fault, just misattributed, and
 *     `assertCountsSane` names the true cause on the same run.
 *
 * `search(q)` returns the total for a raw search qualifier; injected so the whole
 * fallback is testable without the network.
 */
export async function crossCheckFallback(allMilestones, search) {
  const anchor = pickCrossCheckMilestone(allMilestones);
  if (!anchor) return false;
  const found = await search(`milestone:"${anchor.title}"`);
  return assertMilestoneSearchSane(anchor, found, 0, 'PR-inclusive fallback');
}

/**
 * The backstop: refuse to post when nothing was EFFECTIVELY cross-checked but
 * something could have been.
 *
 * "Effectively" is the whole point. An earlier version counted guard
 * INVOCATIONS, which a milestone whose REST totals are zero satisfies while
 * being structurally incapable of catching a failing-open search — the call ran,
 * and could not have failed. A fresh, still-empty gate milestone (the natural
 * successor to a met `Production Ready`) is exactly that shape, so the green
 * guard would have sat over the silent hole it exists to close.
 *
 * The second argument is what stops the stricter reading from being WORSE than
 * the bug: when the REST API says no milestone holds anything, there is nothing
 * to cross-check and no search failure to detect, so hard-failing the digest
 * every week over it would trade a silent miss for a permanent red run.
 */
export function assertGuardRan(effectiveChecks, restPopulatedMilestones) {
  if (effectiveChecks === 0 && restPopulatedMilestones > 0) {
    throw new Error(
      `Refusing to post: ${restPopulatedMilestones} milestone(s) hold items per the REST API, but none was ` +
      'effectively cross-checked, so the issue-side search guard never ran. Either no OPEN milestone carries a ' +
      'due date (so none is treated as a roadmap milestone) AND the fallback found no anchor, or every checked ' +
      'milestone was REST-empty (a vacuous pass). See RA-724, RA-1638.',
    );
  }
}

/** Per-milestone closed-this-week counts, from the ONE window search's items. */
export function closedCountsByMilestone(items) {
  const byTitle = new Map();
  for (const it of items) {
    const t = it.milestone?.title;
    if (t) byTitle.set(t, (byTitle.get(t) ?? 0) + 1);
  }
  return byTitle;
}

/**
 * Turn the REST milestone list into what the renderers see, spending searches
 * only where a number needs a denominator. Exported with `count` INJECTED
 * (RA-1642), because this loop decides what the one weekly stakeholder report
 * says about progress and it used to sit inside the `c8 ignore` I/O block where
 * no test could reach it. RA-1641 changed its behaviour for a closed, dated
 * milestone and every test stayed green, because nothing exercised it.
 *
 * Milestone state is counted as ISSUES ONLY (AGENTS.md), never from
 * `milestone.open_issues`/`closed_issues`, which mix in pull requests.
 *
 * WHAT COSTS A SEARCH (RA-1648). A per-milestone PAIR of searches is spent on:
 *  - every OPEN ROADMAP milestone (`isRoadmapMilestone`: open and dated), which
 *    needs a real denominator for its burndown;
 *  - one that COMPLETED this week, which needs its final total for the
 *    celebration line.
 * Every other milestone is a bucket, reported as flow from the single
 * closed-this-week search, so adding a BUCKET costs nothing. Adding a roadmap
 * milestone costs a pair per run, against a ~30 req/min search limit.
 *
 * THE CROSS-CHECK ACCOUNTING LIVES HERE TOO, deliberately. `crossChecked`
 * counts EFFECTIVE comparisons only (a REST-empty milestone passes vacuously),
 * and the no-effective-check fallback runs from inside this function. Moving
 * the decision out without the counting is the "call site has been rewired"
 * case `docs/observability.md` §12 warns about, which is why the caller
 * receives the count rather than recomputing it.
 *
 * @param {object[]} allMilestones  REST `/milestones?state=all` objects
 * @param {{closedByMilestone: Map<string, number>, weekStart: Date, weekEnd: Date,
 *          count: (q: string) => Promise<number>}} deps
 * @returns {Promise<{milestones: {title: string, dueOn: string|null, state: string, open: number,
 *   closed: number, closedThisWeek: number, completedThisWeek: boolean}[], crossChecked: number,
 *   searches: number}>}
 */
export async function collectMilestones(allMilestones, { closedByMilestone, weekStart, weekEnd, count }) {
  let searches = 0;
  const counted = (q) => {
    searches += 1;
    return count(q);
  };
  const milestones = [];
  let crossChecked = 0;
  for (const m of allMilestones) {
    const closedThisWeek = closedByMilestone.get(m.title) ?? 0;
    const completedThisWeek = completedInWindow(m, weekStart, weekEnd);
    const isGate = isRoadmapMilestone(m);

    if (!isGate && !completedThisWeek) {
      if (closedThisWeek === 0) continue;
      milestones.push({ title: m.title, dueOn: m.due_on ?? null, state: m.state, open: 0, closed: 0, closedThisWeek, completedThisWeek: false });
      continue;
    }
    const t = `milestone:"${m.title}"`;
    const [open, closed] = await Promise.all([
      counted(`is:issue is:open ${t}`),
      counted(`is:issue is:closed ${t}`),
    ]);
    // Cross-check search against REST before trusting an empty result: an empty
    // gate is the shape a failing-open issue search takes, and it would silently
    // delete the Progress section rather than show a wrong number (RA-721). Counts
    // only when the comparison COULD have failed — a REST-empty milestone passes
    // vacuously and is not coverage.
    if (assertMilestoneSearchSane(m, open, closed)) crossChecked += 1;
    if (open + closed === 0) continue;
    milestones.push({ title: m.title, dueOn: m.due_on ?? null, state: m.state, open, closed, closedThisWeek, completedThisWeek });
  }

  // No effective in-loop check — no gate, nothing completed, or a REST-empty
  // gate. Spend ONE more search so the guard still covers the week (RA-724).
  if (crossChecked === 0 && await crossCheckFallback(allMilestones, counted)) crossChecked += 1;

  return { milestones, crossChecked, searches };
}

// ---------------------------------------------------------------------------
// Gate candidates (RA-2399, companion to RA-1616). The ONE deliberate exception to
// "remaining work is never a list" (header), decided by the developer 2026-09-25.
// ---------------------------------------------------------------------------

/**
 * Since RA-1616, a `sev:critical` / `sev:high` reviewer follow-up is no longer
 * routed onto the gate automatically: it is labelled `gate-candidate` and the
 * developer decides whether it joins. Without this section a critical candidate
 * surfaces only in a manual query, so the one decision the pipeline hands a
 * human would have no scheduled surface at all.
 *
 * Three states, and each renders VISIBLY:
 *  - candidates → one line each, severity then age;
 *  - none       → the word "none", because a missing section and an empty
 *                 queue must not look alike;
 *  - unreadable → says so, and names the query to run by hand. It does NOT fail
 *                 the job: the burndown is the product, and this list is
 *                 reachable by hand, so losing it must not cost the week's post.
 */
// The label and the severity rubric are OWNED by the triage module that applies
// them (RA-1616), so a rename there reaches this reader rather than leaving it
// querying the old name.
export { GATE_CANDIDATE_LABEL };
export const GATE_CANDIDATE_QUERY = `is:issue is:open label:${GATE_CANDIDATE_LABEL}`;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Label names, LOWERCASED: GitHub matches label names case-insensitively, so a
 * label recapitalised to `Gate-Candidate` still passes the label GET and the
 * `?labels=` filter — an exact-case match here would then drop every item and
 * post "none", the silent empty result the label GET exists to prevent.
 */
const labelNames = (issue) =>
  (issue.labels ?? []).map((l) => ((typeof l === 'string' ? l : l?.name) ?? '').toLowerCase());

/** `critical` from a `sev:critical` label (string or REST label object), else null. */
export function severityOf(issue) {
  return severityOfLabels(labelNames(issue))?.slice('sev:'.length) ?? null;
}

const isLabelledOpenIssue = (i) =>
  !i.pull_request && i.state === 'open' && labelNames(i).includes(GATE_CANDIDATE_LABEL.toLowerCase());

/**
 * A candidate the developer has already PLACED: it sits on a roadmap milestone.
 * Nothing removes the label on a decision, so without this a placed issue would
 * be re-offered every week and the queue would grow without bound. (A candidate
 * the developer declines has its label removed, and drops out of the read.)
 */
export const isPlacedCandidate = (i) => isLabelledOpenIssue(i) && isRoadmapMilestone(i.milestone);

/**
 * REST `/issues` items → the rows to render. Drops pull requests (the issues
 * endpoint returns both), anything not open or not labelled, and anything
 * already placed on a roadmap milestone, so the list is correct whatever the
 * caller fetched. Sorted by severity (no `sev:*` last), then OLDEST first.
 *
 * Age is from the issue's `created_at`, rendered as "opened N days ago" — NOT
 * from when the label was applied, which only the per-issue events API knows
 * (a request per candidate). For a reviewer follow-up the two coincide: the
 * filer applies the label at creation (AGENTS.md, RA-1616).
 *
 * @param {object[]} items  REST `/issues` objects
 * @param {Date} now
 * @returns {{number: number, title: string, url: string, sev: string|null, ageDays: number}[]}
 */
export function gateCandidatesFrom(items, now) {
  const rank = (sev) => (sev === null ? SEVERITY_LABELS.length : SEVERITY_LABELS.indexOf(`sev:${sev}`));
  return items
    .filter((i) => isLabelledOpenIssue(i) && !isRoadmapMilestone(i.milestone))
    .map((i) => ({
      number: i.number,
      title: i.title ?? '',
      url: i.html_url,
      sev: severityOf(i),
      ageDays: Math.max(0, Math.floor((now.getTime() - new Date(i.created_at).getTime()) / DAY_MS)),
    }))
    .sort((a, b) => rank(a.sev) - rank(b.sev) || b.ageDays - a.ageDays || a.number - b.number);
}

/** Slack mrkdwn treats `&`, `<` and `>` as control characters. */
const slackEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The failure reason, reduced to something fit for the stakeholder channel: the
 * HTTP status when there is one, never the raw response body. The full text
 * still reaches the run's `::warning::` annotation.
 */
export function shortReason(reason) {
  const status = String(reason ?? '').match(/→ (\d{3})\b/);
  return status ? `GitHub returned ${status[1]}` : 'the request failed';
}

/**
 * `result` is `{ ok: true, candidates, placed? }` or `{ ok: false, reason }`. Anything
 * else — including `undefined`, a caller that never read the list — renders as
 * UNREADABLE, never as "none", so the section is fail-closed.
 */
export function renderGateCandidates(result) {
  const out = '\n*Gate candidates*\n';
  if (!result || result.ok !== true || !Array.isArray(result.candidates)) {
    const reason = result && 'reason' in result ? shortReason(result.reason) : 'the list was not read';
    return `${out}• :warning: The gate-candidate list could not be read this week (${reason}). ` +
      `This is NOT an empty list — check \`${GATE_CANDIDATE_QUERY}\` by hand.\n`;
  }
  let body = '_Whether any of these joins the gate milestone is the developer’s call._\n';
  if (!result.candidates.length) body += '• none\n';
  for (const c of result.candidates) {
    const age = `opened ${c.ageDays} ${c.ageDays === 1 ? 'day' : 'days'} ago`;
    body += `• <${c.url}|#${c.number}> \`sev:${c.sev ?? '?'}\` ${slackEscape(c.title)} — ${age}\n`;
  }
  if (result.placed > 0) {
    body += `_${result.placed} more already placed on a roadmap milestone — not listed._\n`;
  }
  return out + body;
}

/**
 * Read every open `gate-candidate` issue. Never throws: a failure comes back as
 * `{ ok: false, reason }` for `renderGateCandidates` to say out loud.
 *
 * CORE REST, NOT SEARCH — so it spends nothing from the ~30/min search budget
 * (`docs/observability.md` §12). Two guards stand in for the REST-vs-search
 * cross-check the milestone side has:
 *  - the LABEL is fetched first. A renamed or deleted label makes
 *    `?labels=gate-candidate` return `[]` with a 200 — the failing-open shape —
 *    whereas the label GET 404s, so a missing label reads as unreadable;
 *  - pagination runs to the end, and a FULL last-allowed page reports
 *    unreadable rather than posting a list silently cut short.
 *
 * `api(path)` resolves the parsed JSON or throws, as the I/O half's does.
 */
export async function readGateCandidates({ api, repo, now, maxPages = 10 }) {
  try {
    await api(`/repos/${repo}/labels/${encodeURIComponent(GATE_CANDIDATE_LABEL)}`);
    const items = [];
    for (let page = 1; ; page++) {
      const r = await api(
        `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(GATE_CANDIDATE_LABEL)}&per_page=100&page=${page}`,
      );
      if (!Array.isArray(r)) throw new Error('the issues endpoint did not return a list');
      items.push(...r);
      if (r.length < 100) break;
      if (page >= maxPages) throw new Error(`more than ${maxPages * 100} open items carry the label`);
    }
    return { ok: true, candidates: gateCandidatesFrom(items, now), placed: items.filter(isPlacedCandidate).length };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

/** The one-line volume summary. Texture, not headline — hence last and terse. */
export function renderStats({ prsMerged, issuesClosed, releases }) {
  const n = (v, s, p = `${s}s`) => `${v} ${v === 1 ? s : p}`;
  return `\n_${n(prsMerged, 'PR')} merged · ${n(issuesClosed, 'issue')} closed · ${n(releases, 'release')}_`;
}

/** "week of 1 Aug" — the window's start, in the reader's terms rather than ISO. */
export const formatWeek = (start) =>
  start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** `2026-07-27T08:00:00Z` — second precision; search rejects nothing here but milliseconds add noise. */
const iso = (d) => `${d.toISOString().slice(0, 19)}Z`;

/**
 * The 7-day window, as both Dates and a GitHub search qualifier — ONE source of
 * truth, because the two halves of this post drifted apart when there were two.
 *
 * A search date qualifier written as bare dates (`closed:2026-07-31..2026-08-07`)
 * covers WHOLE UTC DAYS, inclusive at both ends. On the Monday 08:00 run that is
 * eight calendar days, while the release filter used exact timestamps and got
 * seven — so *Delivered* and *Progress* described different weeks, the Monday
 * boundary landed in two consecutive digests, and the counts ran ~19% high
 * (measured: 50 merged PRs reported for a week that actually had 42).
 *
 * Two things make this correct, and the second is not obvious:
 *  - full ISO timestamps, so the search matches the release filter's precision;
 *  - an end one second short of `weekEnd`, because `a..b` is inclusive at BOTH
 *    ends — without it the boundary instant is still counted twice.
 *
 * `x:>=a x:<b` is NOT an alternative. GitHub silently drops all but one repeated
 * qualifier and returns the UNFILTERED total (verified: 377 rather than 42), so
 * that form fails open — it looks like a working query and reports the whole
 * repo's history as one week's work.
 */
export function weekWindow(weekEnd) {
  const end = new Date(weekEnd);
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { weekStart: start, weekEnd: end, qualifier: `${iso(start)}..${iso(new Date(end.getTime() - 1000))}` };
}

/**
 * Did this milestone complete inside the window? HALF-OPEN [start, end), the
 * same boundary as the search qualifier and the release filter.
 *
 * The `<` is load-bearing and was `<=` until review caught it: a milestone
 * closed at exactly `weekEnd` would otherwise be celebrated in two consecutive
 * digests — the same double-count the window fix removed everywhere else, left
 * half-applied a few lines away.
 *
 * Completion is the week a HUMAN closed the milestone, not the week its last
 * issue closed. See renderCompletions.
 */
export function completedInWindow(milestone, weekStart, weekEnd) {
  if (milestone.state !== 'closed' || !milestone.closed_at) return false;
  const at = new Date(milestone.closed_at);
  return at >= weekStart && at < weekEnd;
}

/**
 * The editorial rules the NARRATIVE is screened against (RA-707).
 *
 * The digest's two hard editorial rules were, until this, enforced on the
 * deterministic half by tests and on the model-written half by PROMPT ALONE —
 * so a single bad generation could ship "now live on production" to the
 * co-founder with every step green and no test, monitor or red run to catch it.
 * The narrative step is `continue-on-error: true` precisely because it is the
 * untrusted component; its output was nonetheless trusted more than the numbers
 * beside it.
 *
 * THE LIST IS PHRASE-SCOPED, NOT WORD-SCOPED, and that is the whole difficulty.
 * A bare `/production/i` rejects "work on the production of certificates", and a
 * bare `/live/i` rejects "students can now book live classes" — in a training
 * business those are product vocabulary, not environment claims. A screen so
 * broad that ordinary prose trips it does not enforce the rule, it silently
 * deletes the feature: a prose-less digest every week, indistinguishable from
 * the model being down. So each pattern below targets the CLAIM (`in
 * production`, `went live`, `promoted to`) rather than the noun.
 *
 * Scoped to the NARRATIVE STRING ONLY, never the assembled post — the digest
 * legitimately renders the milestone title "Production Ready", and a check over
 * the whole message would blank the headline it exists to deliver.
 */
/**
 * The nouns that make a sentence a TO-DO REPORT rather than a product
 * description. `pending reviews` (moderation queue) and `pending review` (a PR
 * waiting on a human) differ only by this word, so it is the whole screen — see
 * the pattern comments in the `pending` rule below.
 *
 * Kept as one string interpolated into several patterns so the list cannot drift
 * between them, which is how `outstanding` ended up narrowed and `remaining` not.
 */
const TODO_OBJECT =
  'work|item|items|issue|issues|task|tasks|ticket|tickets|pr|prs|review|reviews|' +
  'bug|bugs|fix|fixes|feature|features|change|changes|follow-?ups?';

/**
 * The to-do objects that are also this app's PRODUCT nouns (RA-1377). `review(s)`,
 * `change(s)` and `fix(es)` are to-dos in a PR sentence and product nouns here too:
 * `admin/reviews/page.tsx` is customer-review moderation, so "Reviews awaiting
 * moderation now appear in a dedicated admin tab" is delivered-outcome prose.
 */
const AMBIGUOUS_OBJECT = /^(?:review|reviews|change|changes|fix|fixes)$/;
/** DERIVED from TODO_OBJECT, so a noun added there reaches every pattern. */
const TODO_OBJECT_UNAMBIGUOUS = TODO_OBJECT.split('|').filter((w) => !AMBIGUOUS_OBJECT.test(w)).join('|');
const TODO_OBJECT_AMBIGUOUS = TODO_OBJECT.split('|').filter((w) => AMBIGUOUS_OBJECT.test(w)).join('|');
/** The complements after `await` that make an ambiguous noun the PRODUCT reading. */
const PRODUCT_AWAIT_COMPLEMENT = 'moderation|publication|their\\s+answer|payment';

/**
 * The complements that make `remain` a to-do: *remain unreviewed*, *remains open*,
 * *remained unfinished*. ENUMERATED, not `un\\w+`, because "prices remain unchanged
 * for existing students" is delivered prose and `unchanged` has the same shape. The
 * time complement is scoped to a PLANNING unit (`for next month`), because "early-bird
 * pricing remains for the next cohort" is product prose.
 */
const REMAIN_TODO_COMPLEMENT =
  'unreviewed|unmerged|unfinished|undone|unresolved|unaddressed|untriaged|unassigned|' +
  'unimplemented|unshipped|untested|incomplete|open|outstanding|to\\s+be\\b|before|until|' +
  'for\\s+(?:the\\s+)?(?:next|later|a\\s+later|another)\\s+(?:week|sprint|month|milestone|release|pass|round)';

/**
 * What makes a bare clause-ending `remain` a to-do. A bare `remains.` needs a to-do
 * SUBJECT, because "the old price remains." is product prose. Two forms qualify:
 *  - an unambiguous to-do noun anywhere in the clause before it ("Some work remains",
 *    "Only three tasks remain (all reporting)");
 *  - a quantifier or `of <number>` IMMEDIATELY before the verb, with nothing else that
 *    could be the subject ("Some remain", "Eleven of thirty-eight remain").
 * A quantifier may NOT reach across a noun: "how many seats remain" and "a few seats
 * remain" are the shipped seat-availability surface (`src/lib/seats.ts`), and "most of
 * the discounts remain" is pricing prose (the Reviewer, PR RA-2350).
 */
const NUMBER_WORD =
  String.raw`\d+|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|` +
  String.raw`fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|` +
  String.raw`a\s+dozen|a\s+hundred)(?:-[a-z]+)?`;
const REMAIN_BARE_SUBJECT = String.raw`some|more|several|few|many|of\s+(?:${NUMBER_WORD})`;
/** A clause ends at any of . ! ; : , ( a dash, a newline, or the end of the text. */
const CLAUSE_END = String.raw`\s*(?:[.!;:,(\n\u2014\u2013-]|$)`;

export const NARRATIVE_RULES = [
  {
    // weekly-digest.yml: "NEVER claim something is live to customers, or name an
    // environment. Work is 'delivered'. Whether it has been promoted to
    // production is a separate decision this post does not speak to."
    rule: 'environment',
    why: 'claims something is live, or names an environment (weekly-digest.yml:79-81)',
    patterns: [
      /\b(?:to|in|on|onto|into|from|against)\s+(?:production|staging|prod)\b/i,
      /\b(?:production|staging)\s+(?:environment|server|instance|database|deploy\w*|release\w*)/i,
      /\bstaging\b/i,
      /\bprod\b/i,
      // "is/now/went live" — but not "live classes" or "live-streamed", which are
      // this product's own vocabulary.
      /\b(?:is|are|was|were|now|already|went|goes|going|go)\s+live(?![-\w])/i,
      /\blive\s+(?:to|for)\s+(?:customers|users|students|clients|the\s+public)/i,
      /\bpromot(?:e|es|ed|ing)\s+to\b/i,
      /\broll(?:s|ed|ing)?\s+out\s+to\s+(?:customers|users|students|clients|the\s+public)/i,
    ],
  },
  {
    // weekly-digest.yml: "Past tense. Never mention what is pending, awaited, or
    // remaining." This is the RA-166 line — RA-166 was REJECTED because it nagged
    // the human about their own backlog, and "3 PRs are still awaiting review"
    // in a narrative sentence reintroduces exactly that.
    rule: 'pending',
    why: 'frames work as pending, awaited or remaining (weekly-digest.yml:86)',
    patterns: [
      // EVERY word here is scoped to the to-do FRAMING, never the bare noun —
      // `upcoming`, `pending`, `awaiting` and `remaining` are all first-class
      // product vocabulary in this app (the instructor dashboard's "Upcoming
      // classes" tile, the review-moderation "Pending" tab, three `pending`
      // status enums, a student's "remaining balance"), so a bare pattern
      // deletes delivered-outcome prose — the exact silent failure this rule
      // exists to prevent, in the other direction. `outstanding` was narrowed
      // this way from the start; the rest now match it.
      new RegExp(String.raw`\bremain(?:s|ing|ed)?\s+(?:${TODO_OBJECT})\b`, 'i'),
      // POSTFIX `remain` (RA-1377): "Three PRs remain unreviewed", "Some work remains."
      // Scoped to a to-do COMPLEMENT, or to `remain` ending its clause, rather than to
      // a to-do object in front. An object-first `remain` pattern was measured to drop
      // "Admins can review a student remaining balance", because `review` sits within
      // reach of `remaining`. Neither form here matches `remaining`.
      new RegExp(String.raw`\bremain(?:s|ed)?\s+(?:${REMAIN_TODO_COMPLEMENT})\b`, 'i'),
      new RegExp(String.raw`\b(?:${TODO_OBJECT_UNAMBIGUOUS})\b[^.!?;\n]{0,40}?\bremain(?:s|ed)?${CLAUSE_END}`, 'i'),
      new RegExp(String.raw`\b(?:${REMAIN_BARE_SUBJECT})\s+remain(?:s|ed)?${CLAUSE_END}`, 'i'),
      /\bawait(?:s|ed|ing)?\s+(?:review|merge|approval|sign-?off|triage|a\s+decision)\b/i,
      new RegExp(String.raw`\b(?:${TODO_OBJECT_UNAMBIGUOUS})\b[^.]{0,40}?\bawait(?:s|ed|ing)?\b`, 'i'),
      // The ambiguous nouns reject too, UNLESS the complement is the product reading:
      // "Two fixes are awaiting deploy" is a to-do, "Reviews awaiting moderation" is not.
      new RegExp(String.raw`\b(?:${TODO_OBJECT_AMBIGUOUS})\b[^.]{0,40}?\bawait(?:s|ed|ing)?\b(?!\s+(?:${PRODUCT_AWAIT_COMPLEMENT})\b)`, 'i'),
      /\b(?:is|are|was|were|remains?|stays?)\s+(?:still\s+)?pending\b/i,
      // NO attributive `pending <noun>` pattern, deliberately. "pending reviews"
      // IS the review-moderation queue (`admin/reviews/page.tsx` labels the tab
      // "Pending") and "a pending payment" is a `paymentState` value, so the
      // to-do reading and the product reading are the same two words. Only the
      // PREDICATIVE form ("is still pending") reliably means a to-do, and the
      // two patterns above catch it.
      /\bstill\s+(?:open|to\b|being|under|in\s+progress|outstanding|awaiting|pending|need)/i,
      new RegExp(String.raw`\boutstanding\s+(?:${TODO_OBJECT})\b`, 'i'),
      // "there is more to do" is to-do framing; "nothing to do with billing" is an idiom.
      /\bto-?dos?\b|\bto\s+do\b(?!\s+with)/i,
      // "next week's classes" is a delivered storefront feature, not a plan.
      /\bnext\s+(?:week|sprint)\b(?!['\u2019]s)/i,
      /\bnext\s+up\b/i,
      /\byet\s+to\b|\bnot\s+yet\b/i,
      /\bin\s+progress\b/i,
      /\bunderway\b/i,
      /\bcoming\s+(?:weeks?|days?|soon)\b/i,
      // Future promises. Deliberately NOT a bare /will/: "customers will be able
      // to pay by card" describes a delivered feature's benefit, not a to-do.
      /\b(?:will|should|expects?\s+to|plans?\s+to|aims?\s+to)\s+(?:be\s+)?(?:land|ship|deliver|follow|complete|finish|arrive|go\s+live)/i,
    ],
  },
];

/**
 * Screen the model's narrative against the rules above.
 *
 * Returns `{ narrative, violations }` — the narrative to USE (empty when it
 * tripped anything) and what tripped it. Three decisions are baked in, and the
 * issue (RA-707) left all three open:
 *
 *  1. **Drop the WHOLE narrative, never the offending sentence.** Sentence-level
 *     surgery is the only option that can emit an incoherent fragment ("It was
 *     otherwise a quiet week." with no antecedent), and the fragment would post
 *     under the same implicit warranty as the rest.
 *  2. **Drop the narrative, never fail the job.** The numbers are the product;
 *     prose is a nice-to-have. This lands on exactly the degraded path the
 *     workflow already supports when `narrative.txt` is absent, honouring
 *     `docs/observability.md` §12's one exempt step. A bad generation must not
 *     cost the week's burndown.
 *  3. **Say what tripped, and where.** Silently discarding the model's work
 *     would make a persistently bad prompt indistinguishable from a model
 *     outage. The caller turns `violations` into a `::warning::` annotation, so
 *     the trace survives on a GREEN run's summary page (§12).
 *
 * Pure and idempotent, so `buildMessage` can call it for the fail-closed
 * guarantee while the I/O half calls it to emit the annotation.
 */
export function sanitiseNarrative(narrative) {
  const text = (narrative ?? '').trim();
  if (!text) return { narrative: '', violations: [] };
  const violations = [];
  for (const { rule, why, patterns } of NARRATIVE_RULES) {
    for (const pattern of patterns) {
      const m = text.match(pattern);
      if (m) violations.push({ rule, why, match: m[0] });
    }
  }
  return { narrative: violations.length ? '' : text, violations };
}

/**
 * Assemble the whole post. Pure, so the shape is testable without the network.
 *
 * The narrative is screened HERE rather than at the call site so the guarantee
 * is fail-closed: no caller can assemble a post that skipped the check.
 * `gateCandidates` is optional in the type for the same reason: omitting it
 * renders the section as UNREADABLE (see `renderGateCandidates`), never drops it.
 *
 * @param {{weekStart: Date, narrative?: string, milestones: any[], grouped: any, stats: any,
 *          gateCandidates?: {ok: boolean, candidates?: any[], reason?: string}}} args
 */
export function buildMessage({ weekStart, narrative, milestones, grouped, stats, gateCandidates }) {
  const { narrative: screened } = sanitiseNarrative(narrative);
  let text = `:bar_chart: *Week of ${formatWeek(weekStart)}*\n`;
  if (screened) text += `\n${screened}\n`;
  text += renderCompletions(milestones);
  text += renderProgress(milestones);
  text += renderGateCandidates(gateCandidates);
  // Over Slack's limit, DELIVERED gives way first: it is the one section that is
  // a summary of something reachable elsewhere (the releases), whereas a cut in
  // the gate-candidate list would silently drop candidates. Only a head that is
  // itself oversized falls back to the blunt cut.
  let delivered = renderDelivered(grouped);
  const tail = renderStats(stats);
  const room = 11800 - text.length - tail.length;
  if (text.length + delivered.length + tail.length > 12000 && room > 0) {
    delivered = `${delivered.slice(0, room).replace(/\n[^\n]*$/, '')}\n… _truncated_\n`;
  }
  text += delivered + tail;
  if (text.length > 12000) text = `${text.slice(0, 11800)}\n… _truncated_`;
  return text;
}

// ---------------------------------------------------------------------------
// I/O below this line. Everything above is pure and unit-tested.
// ---------------------------------------------------------------------------

/* c8 ignore start */
if (import.meta.url === `file://${process.argv[1]}`) {
  const {
    GITHUB_TOKEN,
    GITHUB_REPOSITORY: repo,
    SLACK_RELEASE_WEBHOOK: webhook,
    NARRATIVE,
    WEEK_END,
    DRY_RUN,
  } = process.env;

  if (!GITHUB_TOKEN || !repo) {
    console.error('Missing required env: GITHUB_TOKEN, GITHUB_REPOSITORY');
    process.exit(1);
  }
  if (!webhook && !DRY_RUN) {
    // Graceful no-op, matching announce-deploy: a missing webhook must not fail
    // a scheduled job whose output is a nice-to-have.
    console.warn('SLACK_RELEASE_WEBHOOK not set — skipping digest.');
    process.exit(0);
  }

  const HEADERS = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const api = async (path) => {
    const res = await fetch(`https://api.github.com${path}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`GitHub GET ${path} → ${res.status}: ${await res.text()}`);
    return res.json();
  };
  /** Issue/PR counts come from search so `is:issue` can exclude PRs (AGENTS.md). */
  const count = async (q) => (await api(`/search/issues?q=${encodeURIComponent(`repo:${repo} ${q}`)}&per_page=1`)).total_count;

  const { weekStart, weekEnd, qualifier: window } = weekWindow(WEEK_END ? new Date(WEEK_END) : new Date());

  /**
   * One search, ALL matching items. The search API allows only 30 requests per
   * minute — far tighter than the 5000/hr core limit — so this job is written to
   * spend a handful of searches, not one per milestone. An earlier version asked
   * for three counts per milestone and rate-limited itself on a repo with five.
   */
  const searchAll = async (q) => {
    const items = [];
    for (let page = 1; page <= 10; page++) {
      const r = await api(`/search/issues?q=${encodeURIComponent(`repo:${repo} ${q}`)}&per_page=100&page=${page}`);
      items.push(...r.items);
      if (items.length >= r.total_count || r.items.length === 0) break;
    }
    return items;
  };

  const [prsMerged, closedThisWeekItems, allReleases, allMilestones, gateCandidates] = await Promise.all([
    count(`is:pr is:merged merged:${window}`),
    // Fetching the ITEMS rather than a count gives every milestone's
    // closed-this-week figure from a single request, since each item carries its
    // own milestone. That is the whole reason this is one search and not five.
    searchAll(`is:issue is:closed closed:${window}`),
    api('/repos/' + repo + '/releases?per_page=100'),
    api('/repos/' + repo + '/milestones?state=all&per_page=100'),
    // Core REST, never throws — an unreadable list is rendered as such (RA-2399).
    // `now`, not `weekEnd`: the list is read LIVE, so a back-dated WEEK_END run
    // still shows today's queue, and its ages must be measured from today.
    readGateCandidates({ api, repo, now: new Date() }),
  ]);
  if (!gateCandidates.ok) {
    console.warn(
      `::warning title=gate candidates unreadable::The digest posts saying so. ${JSON.stringify(gateCandidates.reason)}`,
    );
  }

  const issuesClosed = closedThisWeekItems.length;
  const closedByMilestone = closedCountsByMilestone(closedThisWeekItems);

  // Half-open [weekStart, weekEnd) — matches the search qualifier's effective
  // range, so Delivered and Progress describe the same seven days.
  const releases = allReleases.filter(
    (r) => !r.draft && !r.prerelease && new Date(r.published_at) >= weekStart && new Date(r.published_at) < weekEnd,
  );

  // Delivered work: every bullet from this week's releases, grouped by scope.
  const bullets = releases.flatMap((r) =>
    Object.values(parseSections(r.body || '')).flat(),
  );
  const grouped = groupByArea(bullets);

  const { milestones, crossChecked } = await collectMilestones(allMilestones, {
    closedByMilestone, weekStart, weekEnd, count,
  });

  // Before rendering anything: refuse to post a number we can tell is wrong.
  assertGuardRan(crossChecked, allMilestones.filter(restPopulated).length);
  assertCountsSane({ prsMerged, releases: releases.length });

  /**
   * `buildMessage` screens the narrative itself (fail-closed), so this call is
   * purely for the SIGNAL: a rejection that left no trace would be
   * indistinguishable from the model being down, and a persistently bad prompt
   * would produce a prose-less digest every week with nobody the wiser.
   *
   * A `::warning::` annotation shows on the run summary page even when the run
   * is GREEN — which this one still is, deliberately (§12: prose is the one
   * best-effort component; the numbers are not). Its limit is worth naming:
   * nobody watches a green run's annotations weekly, so this is a trace to find
   * when asking "why is there no prose?", not a detector that will page anyone.
   */
  const { violations } = sanitiseNarrative(NARRATIVE);
  if (violations.length) {
    const tripped = violations.map((v) => `${v.rule}: "${v.match}" — ${v.why}`).join('; ');
    console.warn(
      `::warning title=digest narrative rejected::The model's narrative broke the digest's editorial rules and was ` +
      `dropped; the numbers still post. Tripped ${tripped}. Rejected text: ${JSON.stringify(NARRATIVE)}`,
    );
  }

  const text = buildMessage({
    weekStart,
    narrative: NARRATIVE,
    milestones,
    grouped,
    stats: { prsMerged, issuesClosed, releases: releases.length },
    gateCandidates,
  });

  if (DRY_RUN) {
    console.log(`DRY RUN — window ${window}\n--- Slack message ---\n${text}`);
    process.exit(0);
  }

  const slack = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!slack.ok) throw new Error(`Slack webhook → ${slack.status}: ${await slack.text()}`);
  console.log(`Posted the week-of-${formatWeek(weekStart)} digest to Slack.`);
}
/* c8 ignore stop */
