# Implementer playbook: Kanon

This is how the Implementer builds an issue on Kanon's own repository, and how it revises its own pull request. Kanon calls its implement lanes at its last release, never through `$/` ([ADR 0011](../decisions/0011-kanon-runs-its-own-lanes.md)), and no agent merges here: the Owner merges every pull request.

The rules live in the [rulebook](../../rulebook/README.md), and this playbook only says where to look. Cite a rule by its id; don't restate it (`K-PRIN-2`). The [reviewer playbook](reviewer-playbook.md) lists what the Reviewer checks on every Kanon pull request, and yours is reviewed against it, so read its `## What to check` before you start. Kanon's gates are in the [stack document](stack.md).

Kanon runs no bug-fix (triage) lane, no Lead and no reconciler yet. You are started by a member's `agent:implement` label or a dispatch, and by a changes-request on a pull request you opened.

## Implementer mode

1. **The issue is the specification.** Build to its acceptance criteria, and to the rules it cites. An issue's "possible approach" section is unverified, never a criterion (`K-WORK-14`). If the criteria are too vague to build safely, comment with exactly what needs clarifying and stop.
2. **A rule is written in the rulebook's shape.** A new or changed rule has its Rule, Why, Enforced by and Class ([rulebook/README.md](../../rulebook/README.md)), keeps its id, and updates its Why. A change to a rule changes it for every adopter ([ADR 0002](../decisions/0002-standardise-dont-parameterise.md)), so it is never a setting.
3. **Test first, and prove a guard can fail.** Write the test from the criteria and see it red before you build. A new or changed check shows, in the test or in the PR body, the mutation that turns each assertion red (`K-PRIN-11`, `K-SELF-7`). Restore a mutated file from a copy, never with `git checkout <file>`, which takes HEAD's copy and hides an unfixed file.
4. **The public tree names nothing private** ([`tests/unit/public-tree.test.ts`](../../tests/unit/public-tree.test.ts)). Cite the reference adopter's issues only as `RA-<n>`.
5. **Self-pinning.** Kanon reaches its own files only through `$/`. The exemptions are exactly the set in [`tests/unit/self-pinning.test.ts`](../../tests/unit/self-pinning.test.ts); adding one needs a reason.
6. **No stack opinion.** A lane, rule or guard names no language, database or cloud; a prompt reads the project's commands through its stack document and playbooks (`K-LAYOUT-17`).
7. **Run every gate** in the stack document's `## Gates` before each push, and read the real exit codes.
8. **The pull request.** A conventional title with one of Kanon's types and no trailing `(#n)` (`K-SHIP-4`); `Closes #n` in the body's first paragraph; Kanon's pull-request template, with the acceptance criteria you built to and how each was checked.
9. **Your commits are signed off for you.** Kanon's project-setup hook authors them as your App and adds the delegate's `Signed-off-by:` from [the delegation record](sign-off-delegation.md) (`K-AGENT-44`). Don't add a sign-off of your own, never pass `--no-verify`, and never add an AI or bot `Signed-off-by:`. If the `dco` check fails on your pull request, say so in a comment and stop: the fix is the Owner's.
10. **Name the pull request that introduced a bug.** When you fix a defect and find the pull request whose change caused it, write `Introduced by #<n>` in your pull request's body. GitHub records that as a cross-reference on #<n>, which is the link the metrics count an escaped defect by ([plan 0003](../plans/0003-metrics.md) §3.5). Name it on evidence, such as the blame or bisect that shows its change made the code wrong, never a guess: a wrong name counts an escape against work that had none.

### Stop and hand it to the Owner

Besides the lane's own bail list, stop with a plan comment, keeping the label, when the issue needs a change the [reviewer playbook](reviewer-playbook.md) escalates to the Owner (its `## What escalates to the Owner`): a principle, the licence, security (workflow `permissions:`, the App register, the membership gate, the `dco` action, the sign-off delegation, the judging inputs), or a release or a pin of Kanon at a release tag. Those are the Owner's to decide, not only to merge.

## Follow-ups: branch off the open parent

A follow-up says where it came from ("Surfaced by PR #n"). If that pull request is still open, branch off its head and open yours with `--base <its branch>`, so it stacks on the work it follows rather than diverging from `main`. Say so in your body. When the parent merges, GitHub retargets yours to `main`. If the parent is merged or closed, branch off `main` as usual.

## Revise mode

You are on your own pull request's branch, answering a changes-request.

- **Verify each finding before you fix it.** Reproduce it against the code. A finding you can't reproduce is answered with the evidence, not "fixed" by a guess.
- **A finding doesn't widen the issue.** Work beyond the issue's criteria is a follow-up you propose, not something you absorb.
- **A finding that touches the Owner's list above** is the Owner's: say so in your reply and stop.
- **Leave the lane's marker in a top-level comment** on every exit, as the lane's prompt says. It is how the round cap counts.
