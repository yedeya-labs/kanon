// The metrics module's input shape (plan 0003 §3.3, M2): what the work-item step, and the dry
// run before it, hand the pure functions in `scripts/metrics/`. Types only, no code.
//
// ONE PLAIN SHAPE, FILLED BY WHOEVER READS GITHUB. The functions here make no network call and
// read no file. The dry run (`kanon metrics dry-run`, M2 part C) and, later, the collector's
// work-item step (M4) read GitHub with the adopter's token and build these objects. The revert
// and linked-fix detectors (`detectors.mjs`, M2 part B) read the same pull requests through one
// adapter, `toDetectorPr` (`adapter.mjs`), which is the only place the two spellings meet, so a
// reader fills this shape once and both get what they read. Field names follow the GitHub REST
// API where one exists, so a reader can copy a response field for field.
//
// WHAT THE SHAPE HOLDS IS ADOPTER CONTENT: logins, paths, label names, issue bodies, commit
// messages. It never leaves the adopter. Only the row `workItemRow` returns does, and that row
// is validated against the telemetry schema (`actions/agent-telemetry/schema.mjs`), which has
// no field that can hold any of it (ADR 0007, `K-OBS-16`).
//
// TIMES are ISO-8601 strings as GitHub returns them. ABSENT MEANS UNKNOWN: a list the reader
// couldn't fetch is left out (undefined), never sent as `[]`, and every field derived from it
// is left out of the row too (plan 0003 §3.1). An empty list means "fetched, and there were
// none".

/**
 * A GitHub account, as the REST API's `user` objects carry it. `type` is GitHub's: `User`,
 * `Bot`, `Organization` or `Mannequin`. A GraphQL `author` gives `__typename` instead; the
 * reader maps it to `type`. `null` is a deleted account, or a commit whose email GitHub links
 * to no account.
 * @typedef {{ login: string, type?: string }} Actor
 */

/**
 * One file of the pull request's diff (REST `pulls/{n}/files`). `path` is the file's name
 * after the change (`filename`); a rename's old name is `previous_path`.
 * @typedef {{
 *   path: string,
 *   status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged',
 *   additions: number,
 *   deletions: number,
 *   previous_path?: string,
 *   patch?: string | null,
 *   old_ranges?: { start: number, count: number }[],
 * }} ChangedFile
 *
 * `patch` (REST's unified diff) or `old_ranges` (the old side's hunks, `-start,count`) give the
 * lines SZZ blames (`detectors.mjs`); a reader that runs no SZZ leaves both out.
 */

/**
 * One timeline event (REST `issues/{n}/timeline`), flattened. `label` is the label's name for
 * `labeled` and `unlabeled`; `commit_id` is set for `merged`, `closed` and
 * `head_ref_force_pushed`; `source` for `cross-referenced` (the issue or PR that mentioned this
 * one, and its repository as `owner/name`, REST's `source.issue.repository.full_name`). A reader
 * always fills `repository`: the linked-fix detector reads a source without one as this
 * repository, so another repository's issue #7 would pass for this one's (kanon#527). Other
 * events may be passed and are ignored.
 * @typedef {{
 *   event: string,
 *   created_at: string,
 *   actor?: Actor | null,
 *   label?: string,
 *   commit_id?: string,
 *   source?: { type: 'issue' | 'pull_request', number: number, repository?: string },
 * }} TimelineEvent
 */

/**
 * One commit of the pull request (REST `pulls/{n}/commits`). `author` and `committer` are the
 * GitHub accounts the commit's emails resolve to, or `null`; `committed_at` is the committer
 * date, which a rebase or an amend moves.
 * @typedef {{
 *   sha: string,
 *   message: string,
 *   committed_at: string,
 *   author: Actor | null,
 *   committer: Actor | null,
 *   parents?: string[],
 * }} Commit
 */

/**
 * One review (REST `pulls/{n}/reviews`). `commit_id` is the head it reviewed. `body` is read
 * for the role marker only (`scripts/lib/role-marker.mjs`), when one App plays two roles.
 * @typedef {{
 *   state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING',
 *   submitted_at: string,
 *   author: Actor | null,
 *   commit_id: string,
 *   body?: string | null,
 * }} Review
 */

/**
 * One issue the PR closes (GraphQL `closingIssuesReferences`), in the order GitHub lists them:
 * the first is "the first closing issue" of plan 0003 §3.3. `timeline` gives `dispatched_at`
 * (the dispatch label's first `labeled` event); `blocked_by` is the number of its GitHub
 * blocked-by relationships. `created_at` bounds which items the linked-fix detectors may call
 * the PR's cause (`detectors.mjs`, kanon#563).
 * @typedef {{
 *   number: number,
 *   created_at?: string,
 *   labels: string[],
 *   body?: string | null,
 *   author?: Actor | null,
 *   timeline?: TimelineEvent[],
 *   blocked_by?: number,
 * }} ClosingIssue
 */

/**
 * The pull request. `state` is GitHub's (`open` or `closed`); a merged PR is `closed` with
 * `merged_at` set. `merged_by` is the account that merged it, when known; the `merged` timeline
 * event's actor is read when it isn't. `title` is read only for whether the PR is a `fix`
 * (`isFixPr`), and `parent_sha`, the merge commit's first parent, only as SZZ's blame point.
 * @typedef {{
 *   number: number,
 *   title?: string,
 *   state: 'open' | 'closed',
 *   created_at: string,
 *   closed_at: string | null,
 *   merged_at: string | null,
 *   merge_commit_sha?: string | null,
 *   parent_sha?: string | null,
 *   author: Actor | null,
 *   merged_by?: Actor | null,
 *   body?: string | null,
 *   labels: string[],
 *   files?: ChangedFile[],
 *   closing_issues?: ClosingIssue[],
 *   timeline?: TimelineEvent[],
 *   commits?: Commit[],
 *   reviews?: Review[],
 * }} PullRequest
 */

/**
 * One workflow run of a Kanon lane joined to the item (the Actions API): the lane's name, as
 * the telemetry schema's `LANES` spells it, and the run's start and end. The Reviewer's runs
 * (`review`, `merge-reconcile`) open the `review` stage; every other lane's open `agent`.
 * @typedef {{ lane: string, started_at: string, completed_at: string }} LaneRun
 */

/**
 * One check run on one of the PR's head commits (REST `commits/{sha}/check-runs`), with
 * whether the base branch's protection requires it.
 * @typedef {{
 *   name: string,
 *   head_sha: string,
 *   started_at: string,
 *   completed_at: string | null,
 *   conclusion: string | null,
 *   required: boolean,
 * }} CheckRun
 */

/**
 * A Reviewer follow-up: an issue labelled `follow-up` and `agent:reviewer` that
 * cross-references the PR (plan 0003 §3.3, group 4). `state_reason` is GitHub's.
 * @typedef {{
 *   labels: string[],
 *   state: 'open' | 'closed',
 *   state_reason?: 'completed' | 'not_planned' | 'reopened' | 'duplicate' | null,
 * }} FollowUp
 */

/**
 * What the revert and linked-fix detectors found for the item (`detectors.mjs`, §3.5): the
 * numbers and days only, which go into the row as they are.
 * @typedef {{
 *   revert_pr?: number,
 *   revert_days?: number,
 *   fix_prs?: number[],
 *   first_fix_days?: number,
 * }} Links
 */

/**
 * The adopter's declarations the functions read, already parsed: the App register
 * (`parseAppRegister`, role name → App slug), the code areas (`parseCodeAreas`) and the
 * escalation file (`parseEscalationFile`). A declaration the reader couldn't read is left out,
 * and the fields that need it are left out of the row (`knownAreas`, the escalation booleans).
 * One the adopter doesn't make is not left out: the reader passes Kanon's default for it
 * (`UNDECLARED`, `defaultEscalationFile`), as `readCodeAreas` and `readEscalationFile` do.
 * @typedef {{
 *   register: Map<string, string>,
 *   codeAreas?: import('../lib/code-areas.mjs').CodeAreas,
 *   escalationFile?: import('../lib/escalation-paths.mjs').EscalationFile,
 * }} Declarations
 */

/**
 * Everything `workItemRow` takes: the PR, the adopter's declarations, what the reader fetched
 * beside the PR, and the row's own metadata.
 *
 * `merger_blocked`: the Merger may not merge this item (it escalated it, or the item is
 * outside the green zone), so an approved, green item waits for a human (§3.3's stage 1). The
 * reader knows it from the Merger's escalation comment or the `needs:human` label; left out,
 * that half of the `human` stage isn't opened.
 * @typedef {{
 *   pr: PullRequest,
 *   declarations: Declarations,
 *   tag: 'run' | 'smoke' | 'test',
 *   recorded_at: string,
 *   kanon_version?: string,
 *   runs?: LaneRun[],
 *   check_runs?: CheckRun[],
 *   followups?: FollowUp[],
 *   links?: Links,
 *   merger_blocked?: boolean,
 *   wip_at_dispatch?: number,
 * }} WorkItemInput
 */

export {};
