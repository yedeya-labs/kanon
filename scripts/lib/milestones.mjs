// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// The one definition of "roadmap milestone" (RA-1638), shared by the weekly digest and
// scripts/label-guard.mjs (RA-1633). It lives here, not in weekly-digest.mjs, so a
// guard can import the rule without loading a CLI script and its dependencies — and
// so the classifier RA-1616 proposes has one place to take it from.

/**
 * Is this a **roadmap milestone** — finite, completable, and therefore entitled
 * to "N of M done" — rather than a bucket?
 *
 * **Derived, not enumerated (RA-1638).** This used to be
 * `GATE_MILESTONES = ['Production Ready']`, a hardcoded title list. `AGENTS.md`
 * defines the two kinds by their nature: a bucket takes an ongoing stream and
 * never completes, a roadmap milestone is a container of work representing a big
 * feature, prioritised with the stakeholder and closed when finished. The
 * observable difference is a **due date**, and GitHub already reports it.
 *
 * Why the list had to go rather than gain an entry: a title list is wrong the
 * moment the roadmap changes, and it fails *silently*. It already had — with
 * `AI Capabilities` (due 2026-12-31) absent, it rendered as a bucket, so the
 * only weekly report of milestone progress showed it as flow or, at 1 open /
 * 0 closed, as nothing at all. The next roadmap milestone would have inherited
 * exactly that, and RA-724/RA-737 is what the *previous* transition cost: when
 * `Development Ready` was met and removed, this file's search failed open and
 * the digest posted with no Progress section.
 *
 * **A CLOSED milestone is not one, however dated it is.** The loop fetches
 * `?state=all`, so met gates are in scope, and `Development Ready` is closed
 * (2026-08-05) with `due_on: 2026-08-31`. On the due date alone it would take
 * the search branch and render `11 of 11 done` in *Progress* **every week from
 * now on** — a static line describing a gate met a month ago, in the section a
 * reader takes for this week's movement, plus two wasted searches a week. That
 * is precisely what `AGENTS.md` means by *"a met gate is not a destination"*,
 * and it is the wallpaper `renderCompletions` is designed to avoid; it would
 * also accrete a permanent line per future met gate. Excluding closed restores
 * exactly the prior behaviour for them, which was to fall through as a bucket.
 *
 * The celebration week is unaffected: `completedInWindow` independently forces a
 * just-closed milestone into the search branch, so 🎉 still fires, and such a
 * milestone renders as flow beside it exactly as it did before RA-1638.
 *
 * Accepts both the REST shape (`due_on` / `state`) and a camelCase caller.
 * `state` is absent on hand-built callers, which default to open.
 *
 * ⚠️ The `due_on` convention is a WRITTEN RULE in AGENTS.md since 2026-09-24
 * ("Each carries a due date"), but no check enforces it — a roadmap milestone
 * created without a due date reads as a bucket here, in the digest and in
 * label-guard's Explorer check (RA-1633) alike, because nothing mechanical can
 * tell an undated roadmap milestone from a bucket without naming one.
 */
export const isRoadmapMilestone = (m) => isDatedMilestone(m) && (m?.state ?? 'open') !== 'closed';

/**
 * Was this ever a roadmap milestone — does it carry a due date, open or met? The half of the
 * rule a brief needs (kanon#54): a brief that named a gate while it was open is a record, and
 * must not turn red when the gate is met, so `brief-guard` accepts a closed one that
 * `isRoadmapMilestone` excludes. One definition of "dated", shared by both.
 */
export const isDatedMilestone = (m) => Boolean(m?.due_on ?? m?.dueOn);

/**
 * The number of the open milestone titled `title`, or null when none is open or the listing can't
 * be read (kanon#1600). A filer on the REST API names a milestone by number, never by title, so a
 * script that files with `plan()`'s bucket looks it up here. Null files the issue bare rather than
 * not at all: an issue with no milestone is still an issue someone can act on.
 *
 * @param {(path: string) => unknown} api a REST GET, as `deploy-gate.mjs`'s `ghApi`
 * @param {string} repo `owner/name`
 * @param {string} title
 * @returns {number | null}
 */
export function openMilestoneNumber(api, repo, title) {
  try {
    for (let page = 1; page <= 10; page += 1) {
      const list = api(`repos/${repo}/milestones?state=open&per_page=100&page=${page}`);
      const items = Array.isArray(list) ? list : [];
      const hit = items.find((m) => m?.title === title);
      if (hit) return typeof hit.number === 'number' ? hit.number : null;
      if (items.length < 100) return null;
    }
  } catch {
    return null;
  }
  return null;
}
