# The Actions minutes each lane costs

Every lane runs on GitHub Actions, and every run of a lane's caller is a workflow run, whether or not the lane does any work in it. On a public repository the runner-minutes are free. On a private one, GitHub bills each job that runs, rounded up to a whole minute, against your plan's included minutes and then by the minute ([#581](https://github.com/yedeya-labs/kanon/issues/581)). Kanon's jobs ask for `ubuntu-latest`, which GitHub bills at its base rate. A model run's own cost, the Claude credential's, is separate and isn't counted here.

This page gives, per lane, what starts it, what its runs cost in runner-minutes on Kanon's own repository, and which of its runs are the cheap ones. The figures come from [`scripts/actions-minutes.mjs`](../scripts/actions-minutes.mjs), so they can be refreshed (below). The catalogue's `minutes` ([`lanes.json`](lanes.json)) carries each lane's figure in one line, which [the lane catalogue](lanes.md#the-lane-catalogue) and the adopt skill show beside the lane. [`tests/unit/actions-minutes.test.ts`](../tests/unit/actions-minutes.test.ts) fails when this page's table and the catalogue disagree.

## Why a lane has so many runs, and why most cost nothing

A caller's triggers are GitHub events, and GitHub can't filter most of them by label or by author. So a lane starts on far more events than it acts on: the implement lane on every label put on any issue, the review lane on every CI run of every pull request. Its first job, or a job's `if:`, then decides. That gives three kinds of run:

- **A skipped run** bills nothing. Every job's `if:` was false, so no runner started. The implement, triage, split and verify lanes' runs for any other label are these, and so are merge reconcile's for a review on a pull request still open. They still count as runs in the Actions tab, which is most of the about 8,300 runs a week Kanon saw in the window the report below measures.
- **A short run** bills a minute or two. A gate or filter job ran, found nothing to do, and the lane's other jobs were skipped: the review lane on a head with no review label or one already reviewed, the revise lanes on a pull request that isn't their role's, merge reconcile on a merged pull request whose latest verdict declares nothing open ([#177](https://github.com/yedeya-labs/kanon/issues/177)). The lanes that run no model, the Merger, the reconciler, the dispatch sweep and the issue backstop, do their whole job in a short run.
- **A model run** bills for as long as the agent works, plus a few minutes of setup: checking out, minting the token, running your project-setup hook.

The report below counts a run as short when no job in it ran for more than a minute, which covers the first two kinds.

## What starts each lane

The "What starts it" column is each lane's caller triggers, `TRIGGERS` in [`cli/callers.mjs`](../cli/callers.mjs), in words. [`tests/unit/actions-minutes-triggers.test.ts`](../tests/unit/actions-minutes-triggers.test.ts) builds each row's phrases from that entry and fails when a lane gains or loses a trigger and its row doesn't follow ([#808](https://github.com/yedeya-labs/kanon/issues/808)).

The "Its short and skipped runs" column is held to the lanes' jobs by [`tests/unit/actions-minutes-skips.test.ts`](../tests/unit/actions-minutes-skips.test.ts) ([#837](https://github.com/yedeya-labs/kanon/issues/837)). It reads each lane's job conditions and fails when a row doesn't name every label the lane's jobs compare or names a label they don't, when a lane gains or loses a model run and its row's "runs no model" doesn't follow, when "(skipped, nothing billed)" appears without a filter job that skips the run, or when a lane's jobs start testing a filter output the test hasn't tied to a phrase in the row. The words between those anchors are still checked by hand. The "What its minutes grow with" column is read from the lanes' jobs by hand.

| Lane | What starts it | Its short and skipped runs | What its minutes grow with |
|---|---|---|---|
| `agent-review` | CI finishing on a pull request's head; a pull request opened or labelled; a dispatch | A head with no review label (`review:please`, `agent:implement` or `agent:triage`), or a head already reviewed; any other label, `agent:reviewer` among them (skipped, nothing billed) ([#627](https://github.com/yedeya-labs/kanon/issues/627)) | Pushes to pull requests that carry a review label |
| `agent-merge-reconcile` | A pull request closed; a review submitted; a dispatch | A review on a pull request still open, or a pull request closed unmerged (skipped, nothing billed); a merged one whose reviews are all the Reviewer's and whose latest verdict declares nothing open | Merged pull requests with an open review item |
| `agent-implement` | An issue labelled; a dispatch | Every label other than `agent:implement` (skipped, nothing billed) | Issues labelled `agent:implement` |
| `agent-implement-revise` | A review submitted; a pull request labelled; a dispatch | A label other than `agent:revise` (skipped, nothing billed); `agent:revise` on an approved head the Merger didn't hand back; a review that doesn't request changes, a review on a pull request that isn't the Implementer's, or a round past its cap; a hand-back whose failed checks all have a fix command Kanon knows, which runs it with no model run ([#1173](https://github.com/yedeya-labs/kanon/issues/1173)) | Change requests on the Implementer's pull requests |
| `agent-explore` | A daily schedule; a dispatch | A commit the QA store already holds a green sweep of | Days, and how long your sweep hook takes |
| `agent-code-audit` | A schedule every three days; a dispatch | None to speak of | Days, and the size of the code areas it reads |
| `agent-explore-telemetry` | A weekly schedule; a dispatch | An aggregate with no cell and no signal; no aggregate function configured, or a dispatch from a branch other than the default (a short job that says so) | Weeks |
| `agent-deploy-diagnose` | A run of the deploy caller completing | A deploy run that didn't fail (skipped, nothing billed); a failed run that filed no issue (a short gate job) | Failed deploys |
| `agent-triage` | An issue labelled; a dispatch | Every label other than `qa:needs-triage` (skipped, nothing billed) | Bugs filed for triage |
| `agent-issue-backstop` | An issue opened; a pull request put on a milestone; a dispatch | None: it runs no model, so every run is short | Issues opened, and pull requests put on a milestone, which it takes off (`K-WORK-7`) |
| `agent-lead` | A dispatch | None: it runs only when you dispatch it | Mandates you dispatch |
| `agent-lead-revise` | A review submitted; a pull request labelled; a dispatch | A label other than `agent:lead-revise`, or a review that doesn't request changes (skipped, nothing billed); a review or label on a pull request that isn't the Lead's brief, or a round past its cap | Change requests on briefs |
| `agent-lead-split` | An issue labelled; a dispatch | Every label other than `qa:needs-split` (skipped, nothing billed) | Issues labelled for a split |
| `agent-lead-reconcile` | A pull request or issue closed; an hourly schedule; a run of a lane it recovers completing; a dispatch | None: it runs no model, so every run is short | Closed pull requests and issues, hours, and the review, revise and implement runs that re-ask it ([Schedules are best effort](lanes.md#schedules-are-best-effort)) |
| `agent-verify-acs` | An issue labelled; a dispatch | Every label other than `qa:verify` (skipped, nothing billed) | Projects verified |
| `agent-overseer` | A weekly schedule; a merged change to its caller; a dispatch | A merged caller change that doesn't move the agent runtime forward (a short gate job) | Weeks |
| `agent-project-digest` | A daily schedule; a dispatch | A run without both the notify hook and `KANON_CHAT_PROJECT_DIGEST`: the gate skips the `digest` job and runs only the health job, at no model cost (plan 0011 §8) | Days, and open projects |
| `agent-weekly-digest` | A weekly schedule; a dispatch | No notify hook, or no `KANON_CHAT_WEEKLY_DIGEST`: a short gate job, and no model, since nothing would be posted (plan 0011 §8) | Weeks |
| `agent-release-announce` | A release published; a dispatch | None: it runs no model, so every run is short | Published releases |
| `agent-merge` | A review submitted; CI finishing on the default branch; an hourly schedule; a dispatch | None: it runs no model, so every run is short | Reviews, merges and hours |
| `agent-rebase` | CI finishing on the default branch; a pull request merged; a daily schedule; a dispatch | A check that finds no agent pull request in conflict | Merges, and conflicts on agent pull requests |
| `agent-dispatch-sweep` | A daily schedule; a run of a lane it recovers completing; a dispatch | None: it runs no model, so every run is short | Days, and the implement and triage runs that re-ask it ([Schedules are best effort](lanes.md#schedules-are-best-effort)) |

## Kanon's own runs

Kanon is a busy repository: about twenty-five pull requests a day, nearly all of them the agents'. The report says how busy it was over the days measured. Every lane Kanon called through the window has its 7 days measured ([#807](https://github.com/yedeya-labs/kanon/issues/807)), except the issue backstop, whose caller Kanon added on 2026-10-20: its "Days measured" under one rests on its first hours, so read it as rough until the figures are refreshed. A lane Kanon doesn't call is not measured, and one whose caller didn't run in the window shows no runs.

The triage lane shows how the sample is drawn ([#1211](https://github.com/yedeya-labs/kanon/issues/1211), below). Nearly all of its runs are skipped ones, about 600 in the window, and the 7 that lasted past a minute include its 6 model runs. The report reads all 7, so triage measures about 8.3 runner-minutes a day. Before #1211, one sample of 100 runs across both groups missed every triage model run and measured the lane at 0.

<!-- actions-minutes:report -->

Measured on `yedeya-labs/kanon` over the 7 days from 2026-10-14 08:43 to 2026-10-21 08:43 UTC, in which 187 pull requests were opened (27 a day), 185 merged (26 a day) and 183 issues opened (26 a day). Each lane's minutes come from the jobs of up to 100 of its runs that lasted past a minute and up to 100 of the rest, each spread evenly over the window and standing for its group's share of the runs; a lane whose caller is younger than the window is measured over the days it has existed.

| Lane | Caller | Days measured | Runs a day | Short runs | Minutes a short run | Minutes another run (median) | Minutes a day |
|---|---|---|---|---|---|---|---|
| `agent-review` | `review.yml` | 7 | 239 | 76% | 0.5 | 5 | 369 |
| `agent-merge-reconcile` | `merge-reconcile.yml` | 7 | 79 | 94% | 0.3 | 4 | 42 |
| `agent-implement` | `implement.yml` | 7 | 86 | 87% | 0 | 13 | 162 |
| `agent-implement-revise` | `implement-revise.yml` | 7 | 139 | 97% | 0.4 | 10 | 94 |
| `agent-explore` | none | — | — | — | — | — | not measured |
| `agent-code-audit` | `code-audit.yml` | 7 | 0.3 | 0% | — | 14 | 4 |
| `agent-explore-telemetry` | `explore-telemetry.yml` | 7 | 0.1 | 0% | — | 6 | 0.9 |
| `agent-deploy-diagnose` | none | — | — | — | — | — | not measured |
| `agent-triage` | `triage.yml` | 7 | 86 | 99% | 0 | 11 | 8.3 |
| `agent-issue-backstop` | `issue-backstop.yml` | 0.6 | 32 | 100% | 1 | — | 32 |
| `agent-lead` | `lead.yml` | 7 | 0.1 | 0% | — | 13 | 1.9 |
| `agent-lead-revise` | `lead-revise.yml` | 7 | 140 | 100% | 0.2 | 9.5 | 34 |
| `agent-lead-split` | `lead-split.yml` | 7 | 86 | 100% | 0 | — | 0 |
| `agent-lead-reconcile` | `lead-reconcile.yml` | 7 | 76 | 100% | 0.8 | — | 62 |
| `agent-verify-acs` | `verify-acs.yml` | 7 | 86 | 100% | 0 | — | 2.6 |
| `agent-overseer` | `overseer.yml` | 7 | 0.7 | 80% | 3.8 | 42 | 8.1 |
| `agent-project-digest` | `project-digest.yml` | 7 | 0.9 | 67% | 2 | 5 | 2.6 |
| `agent-weekly-digest` | none | — | — | — | — | — | not measured |
| `agent-release-announce` | none | — | — | — | — | — | not measured |
| `agent-merge` | `merge.yml` | 7 | 79 | 95% | 0.6 | 2 | 58 |
| `agent-rebase` | `rebase.yml` | 7 | 49 | 93% | 0.9 | 2 | 54 |
| `agent-dispatch-sweep` | `dispatch-sweep.yml` | 7 | 7.7 | 100% | 0.5 | — | 3.7 |

Together, the 18 lanes measured used about 939 runner-minutes a day.

Runs read, of those that lasted past a minute and of the rest: `agent-review` 100 of 438 and 100 of 1236; `agent-merge-reconcile` 46 of 46 and 100 of 504; `agent-implement` 83 of 83 and 100 of 520; `agent-implement-revise` 66 of 66 and 100 of 909; `agent-code-audit` 2 of 2 and 0 of 0; `agent-explore-telemetry` 1 of 1 and 0 of 0; `agent-triage` 7 of 7 and 100 of 596; `agent-issue-backstop` 0 of 0 and 18 of 18; `agent-lead` 1 of 1 and 0 of 0; `agent-lead-revise` 8 of 8 and 100 of 969; `agent-lead-split` 0 of 0 and 100 of 603; `agent-lead-reconcile` 100 of 122 and 100 of 408; `agent-verify-acs` 0 of 0 and 100 of 603; `agent-overseer` 1 of 1 and 4 of 4; `agent-project-digest` 3 of 3 and 3 of 3; `agent-merge` 98 of 98 and 100 of 453; `agent-rebase` 93 of 93 and 100 of 250; `agent-dispatch-sweep` 1 of 1 and 53 of 53.

<!-- /actions-minutes:report -->

## Estimating your own

The event-driven lanes grow with your activity: a repository with a tenth of Kanon's pull requests and issues can expect roughly a tenth of their minutes a day. The scheduled lanes cost the same at any size: the reconciler's and the Merger's hourly runs, about a minute each, are about 48 runner-minutes a day between them before any event, the daily and weekly lanes' a run each per tick. A skipped run costs nothing at any size.

## Refreshing the figures

From a checkout of Kanon, with a `gh` token that can read the repository's Actions:

```sh
GITHUB_REPOSITORY=yedeya-labs/kanon node scripts/actions-minutes.mjs --days 7 --sample 100
```

It only reads: the default branch's workflows, to find each lane's caller as the library does; each caller's completed runs in the window; the jobs of a sample of those runs; and three search counts for the report's first line, each read again when it answers 0 or says it is incomplete, since GitHub search can answer 0 for a query with matches ([kanon#1322](https://github.com/yedeya-labs/kanon/issues/1322)); counts that don't settle stop the script by name. It prints the report, which replaces the one between the markers above; `--json` prints the measurement instead. Then bring each lane's `minutes` in [`lanes.json`](lanes.json) to its new minutes a day, rebuild `requirements.json` and the lane catalogue table (`KANON_WRITE_REQUIREMENTS=1 KANON_WRITE_LANES_DOC=1 npx vitest run tests/unit/requirements.test.ts tests/unit/lanes-doc.test.ts`), and run `tests/unit/actions-minutes.test.ts`, which names any lane whose line still says the old figure. Run it on your own repository the same way, with its name, to measure yours.

How the sample is drawn ([#1211](https://github.com/yedeya-labs/kanon/issues/1211)): the run listing gives each run's start and last update, so the script splits the runs into those that lasted past a minute, which may have run a model, and the rest, without reading a job. It reads the jobs of up to `--sample` runs from each group, spread evenly over the window, and each run read stands for its group's share of the runs. A lane whose runs are nearly all skipped gate checks, like triage's, still has its few model runs read (all of them, while they are no more than `--sample`), rather than a sample of skipped runs that measures it at 0. The report ends by saying how many runs of each group it read per lane.
