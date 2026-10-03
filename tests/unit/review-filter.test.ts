import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runWorkflowStep } from './helpers/workflow-step.js';
import { writeStub } from './helpers/stub-bin.js';

/**
 * RA-1028 / RA-1090 / RA-378 — which pushes get reviewed, and WHEN.
 *
 * The rule "a docs-only push on a code PR needs no review" is right for a feature
 * PR and inverted for a brief PR, and ONE code file is enough to flip the
 * classification. The pilot brief RA-964 carried a 2-line edit to
 * `scripts/spec-lib.mjs` beside a 640-line brief, so it counted as a code PR
 * and every later docs push was skipped — twice in two hours, including the
 * 564-line commit applying the developer's six decisions.
 *
 * The failure is quiet in the worst way: the skipped run reports SUCCESS, so the
 * PR shows a green rollup and an APPROVED that belongs to an earlier SHA. RA-964
 * merged in exactly that state.
 *
 * The trigger since RA-965 is CI's COMPLETION, not the push (RA-378) — so the filter
 * now resolves the PR from a commit SHA before any rule can run, and the "what
 * changed" question is anchored to the last commit the Reviewer reviewed rather than to
 * a push's before/after, which a `workflow_run` payload does not carry.
 *
 * These EXECUTE the step. Every prior assertion about this workflow was a string
 * match on its source, and RA-1032 is what that costs — a workflow that had never
 * once succeeded while its tests were green.
 */
const wf = parse(readFileSync(join(process.cwd(), '.github/workflows/agent-review.yml'), 'utf8'));
const LANE_TEXT = readFileSync(join(process.cwd(), '.github/workflows/agent-review.yml'), 'utf8');
// The triggers are the CALLER's (plan 0001 §3): the lane states them as its contract in a
// comment, and the fixture caller is that contract as an adopter writes it.
const CALLER = parse(readFileSync(join(process.cwd(), 'tests/fixtures/lane-check/extra/agent-review.yml'), 'utf8'));
const CONTRACT = LANE_TEXT.slice(LANE_TEXT.indexOf("# THE CALLER'S TRIGGERS"), LANE_TEXT.indexOf('\non:\n'));
const filterIf = String(wf.jobs.filter.if);
const decide = wf.jobs.filter.steps.find((s: { id?: string }) => s.id === 'decide');

const HEAD = 'b'.repeat(40);
const DEFAULT_TREE: Record<string, string> = {
  'AGENTS.md': 'Read [the pipeline](docs/agentic-qa-pipeline.md) and [the lead](docs/agentic-lead-engineer.md).\n',
  'CLAUDE.md': '@AGENTS.md\n',
  'docs/qa/reviewer-playbook.md': 'Review.\n',
  'docs/qa/agent-identities.md': '| Role | App slug |\n|---|---|\n| Reviewer | `example-reviewer` |\n',
  'docs/agentic-qa-pipeline.md': 'The pipeline.\n',
  'docs/agentic-lead-engineer.md': 'The green zone.\n',
  'docs/observability.md': 'Signals.\n',
  'docs/email.md': 'Email.\n',
  'README.md': 'Readme.\n',
  '.claude/settings.json': '{}\n',
};
const LAST = 'a'.repeat(40);

type Opts = {
  pushed?: string[];        // changed between LAST and HEAD
  prFiles?: string[];       // the whole PR
  message?: string;
  event?: 'workflow_run' | 'pull_request' | 'pull_request_target' | 'workflow_dispatch';
  action?: string;
  labels?: string[];
  lastReviewed?: string | null;
  headSha?: string;
  wfSha?: string;
  prForSha?: string;        // what commits/<sha>/pulls resolves to
  // RA-1413: what Actions says about CI's runs for the HEAD SHA. `true` = a run is
  // in flight; `false` = one finished. `ciRuns: []` is the third state the rollup
  // could not express — no CI run registered for this commit yet.
  ciPending?: boolean;
  ciRuns?: unknown[] | null;   // null = the `gh run list` read itself failed
  prViewFails?: boolean;    // the fail-safe arm: the identity read flaked
  rollupFails?: boolean;    // only the OPTIONAL CI-completion read flaked
  // RA-1093: `gh api --paginate` emitted pages 1..n and THEN failed. The fragment looks
  // exactly like a complete answer; only the exit status separates them.
  partialFiles?: string[];
  fork?: string;            // RA-1117: the head lives on a fork owned by this login
  // RA-1133: what the EVENT PAYLOAD said the head repository was, independently of what
  // `gh pr view` answers. `null` models the paths that carry none — a dispatch, and
  // any payload field GitHub leaves unset — which is the case the fork gate has to
  // survive without an API read.
  payloadHeadRepo?: string | null;
  // RA-1351: who applied a label, and which. A human's `review:please` is a request;
  // an App's is an echo of the run already happening.
  sender?: string;
  label?: string;
  // `github.actor`, which the step compares against the Reviewer's App: the job's `if` can
  // no longer name it, so the step skips the Reviewer's own events.
  actor?: string;
  // The default branch's tree, which `judging-inputs.mjs select` reads over the API.
  treeFails?: boolean;
  reviewsFail?: boolean;    // kanon#88: the PR's reviews read failed
};

const runDecide = ({
  pushed = [],
  prFiles = [],
  message = 'fix: something',
  event = 'workflow_run',
  action = 'completed',
  labels = ['review:please'],
  lastReviewed = LAST,
  headSha = HEAD,
  wfSha = HEAD,
  prForSha = '964',
  ciPending = false,
  ciRuns,
  prViewFails = false,
  rollupFails = false,
  partialFiles,
  fork,
  payloadHeadRepo,
  sender = 'example-reviewer[bot]',
  label = '',
  actor = 'a-member',
  treeFails = false,
  reviewsFail = false,
}: Opts) => {
  // The payload agrees with the API read unless a test deliberately splits them.
  const headRepo =
    payloadHeadRepo !== undefined
      ? (payloadHeadRepo ?? '')
      : fork
        ? `${fork}/example-repo`
        : 'example-org/example-repo';
  const dir = mkdtempSync(join(tmpdir(), 'review-filter-'));
  const list = (xs: string[]) => (xs.length ? xs.map((f) => `'${f}'`).join(' ') : "''");
  const meta = JSON.stringify({
    headRefOid: headSha,
    labels: labels.map((name) => ({ name })),
    isCrossRepository: Boolean(fork),
    headRepositoryOwner: { login: fork ?? 'example-org' },
  });
  // THE CI-COMPLETION READ IS `gh run list --workflow ci.yml --commit <sha>` (RA-1413).
  // The rollup could not express "no CI entries registered yet" — it returned the same
  // empty answer for that, for a finished CI and for a failed read — so the filter now
  // asks Actions about the SHA. `--workflow ci.yml` is also what keeps this workflow's
  // OWN in-progress run out of the answer, which the rollup needed `workflowName` for.
  const ciList = JSON.stringify(
    ciRuns !== undefined
      ? (ciRuns ?? [])
      : [{ headSha, status: ciPending ? 'in_progress' : 'completed', conclusion: ciPending ? null : 'success', databaseId: 42 }],
  );
  const reviews = JSON.stringify(
    lastReviewed === null ? [] : [{ user: { login: 'example-reviewer[bot]' }, commit_id: lastReviewed, state: 'APPROVED' }],
  );
  // Order matters: `/commits/<sha>/pulls` also matches `*commits*`.
  writeStub(join(dir, 'gh'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/calls"
case "$*" in
  *"/git/trees/main?recursive=1"*) ${treeFails ? `echo 'HTTP 403' >&2; exit 1` : `cat "${dir}/tree.json"`} ;;
  *"/contents/"*) p="\${2#repos/*/*/contents/}"; cat "${dir}/tree/\${p%%\\?*}" ;;
  "run list"*) ${rollupFails || ciRuns === null ? `printf '%s' '{"message":"Resource not accessible","status":"403"}'; exit 1` : `printf '%s' ${JSON.stringify(ciList)}`} ;;
  "pr view"*)             ${prViewFails ? `printf '%s' '{"message":"Server Error","status":"500"}'; exit 1` : `printf '%s' ${JSON.stringify(meta)}`} ;;
  *"/commits/"*"/pulls"*) printf '%s\\n' ${JSON.stringify(prForSha)} ;;
  *"/pulls/"*"/files"*)   ${partialFiles ? `printf '%s\\n' ${list(partialFiles)}; exit 1` : `printf '%s\\n' ${list(prFiles)}`} ;;
  *"/pulls/"*"/reviews"*) ${reviewsFail ? `printf '%s' '{"message":"Server Error","status":"500"}'; exit 1` : `printf '%s' ${JSON.stringify(reviews)}`} ;;
  *compare*)              printf '%s\\n' ${list(pushed)} ;;
  *commits*)              cat "${dir}/message" ;;
esac
`);
  // THE MESSAGE GOES IN A FILE, never inlined into the stub. Embedded via
  // JSON.stringify it lands inside a DOUBLE-quoted bash string, where backticks are
  // command substitution — so a fixture containing `[skip-review]` had the marker
  // executed and removed before the script ever saw it, and the test that asserted on
  // it passed against a message that did not contain what it said. Escaped newlines
  // stayed literal for the same reason, so `head -1` saw the whole body.
  writeFileSync(join(dir, 'message'), message);
  // THE DEFAULT BRANCH'S JUDGING INPUTS (`K-MERGE-17`), read over the API by the filter's
  // carve-out. `AGENTS.md` delegates to the two pipeline documents the reference adopter's
  // filter named by pattern, so here they are inputs by delegation.
  for (const [p, body] of Object.entries(DEFAULT_TREE)) {
    mkdirSync(join(dir, 'tree', p, '..'), { recursive: true });
    writeFileSync(join(dir, 'tree', p), body);
  }
  writeFileSync(join(dir, 'tree.json'), JSON.stringify({ tree: Object.keys(DEFAULT_TREE).map((path) => ({ path, type: 'blob', mode: '100644' })) }));
  const r = runWorkflowStep(decide, {
    dir,
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      REPO: 'example-org/example-repo',
      EVENT: event,
      IS_DISPATCH: String(event === 'workflow_dispatch'),
      ACTION: action,
      INPUT_PR: event === 'workflow_dispatch' ? '964' : '',
      EVENT_PR: event.startsWith('pull_request') ? '964' : '',
      WF_EVENT: 'pull_request',
      WF_SHA: wfSha,
      // GitHub renders an unset expression as the empty string, which is exactly what
      // a `workflow_dispatch` gets for both of these — so the empty default is the
      // real payload, not a fixture shortcut.
      WF_HEAD_REPO: event === 'workflow_run' ? headRepo : '',
      PR_HEAD_REPO: event.startsWith('pull_request') ? headRepo : '',
      SENDER: sender,
      LABEL: label,
      REVIEWER_LOGIN: 'example-reviewer',
      ACTOR: actor,
      DEFAULT_REF: 'main',
      KANON: process.cwd(),
    },
  });
  const out = r.outputFile;
  const stdout = r.stdout;
  return {
    calls: (() => { try { return readFileSync(join(dir, 'calls'), 'utf8'); } catch { return ''; } })(),
    review: /^review=(\w+)$/m.exec(out)?.[1] ?? null,
    pr: /^pr=(.*)$/m.exec(out)?.[1] ?? null,
    headSha: /^head_sha=(.*)$/m.exec(out)?.[1] ?? null,
    explicit: /^explicit=(.*)$/m.exec(out)?.[1] ?? null,
    stdout,
    summary: r.summary,
    status: r.status,
  };
};

const evidenceOf = (stdout: string) =>
  Object.fromEntries([...stdout.matchAll(/^\s*(\w+): \[([\s\S]*?)\]$/gm)].map((m) => [m[1], m[2]]));

describe('the trigger is CI finishing, not the branch changing (RA-378, RA-965)', () => {
  /**
   * The Reviewer raced CI: forbidden to wait on a pending check, he posted a `COMMENT`
   * verdict carrying an approve in its prose, and nothing re-fired him when the
   * check went green. Three of seven consecutive PRs ended in that state and were
   * merged by hand. Anything reading review EVENTS — a merging agent above all —
   * stalls on them forever.
   */
  it('subscribes to CI completion, and no longer to a push', () => {
    // A called workflow holds no triggers of its own; its contract names the caller's.
    expect(Object.keys(wf.on)).toEqual(['workflow_call']);
    expect(CONTRACT).toMatch(/#\s+workflow_run:\n#\s+workflows: \[CI\]\n#\s+types: \[completed\]/);
    expect(CONTRACT).toMatch(/#\s+types: \[opened, labeled\]/);
    expect(CALLER.on.workflow_run).toEqual({ workflows: ['CI'], types: ['completed'] });
    // `synchronize` is the trigger this change exists to remove; `opened` survives
    // only for `notify-unlabeled`, and the filter defers it (asserted below).
    expect(CALLER.on.pull_request_target.types).toEqual(['opened', 'labeled']);
  });

  it('never runs a PR-supplied copy of its caller on an automatic trigger (RA-1415)', () => {
    // Under `pull_request` GitHub runs the PR's OWN caller, so on the label path a PR
    // could pin another lane and be reviewed on its own playbook. `pull_request_target`
    // runs the base branch's copy, as `workflow_run` runs the default branch's.
    expect(CONTRACT).not.toMatch(/^#\s+pull_request:/m);
    expect(Object.keys(CALLER.on).sort()).toEqual(['pull_request_target', 'workflow_dispatch', 'workflow_run']);
  });

  it('treats a pull_request_target event exactly as the PR-payload path (RA-1415)', () => {
    // The script's arms say `pull_request`; the event is now `pull_request_target`. If
    // the normalisation went, every arm would fall to `unrecognised event` and review.
    const fork = runDecide({ event: 'pull_request_target', action: 'labeled', fork: 'someone-else' });
    expect(fork.review, 'the payload fork gate must still refuse').toBe('false');
    expect(fork.stdout).toMatch(/FORK|not `example-org\/example-repo`/);
    const opened = runDecide({ event: 'pull_request_target', action: 'opened', prFiles: ['src/a.ts'], pushed: ['src/a.ts'] });
    expect(opened.review).toBe('false');
    expect(opened.stdout).toContain('CI is starting');
    const pending = runDecide({ event: 'pull_request_target', action: 'labeled', ciPending: true, prFiles: ['src/a.ts'], pushed: ['src/a.ts'] });
    expect(pending.review, 'and the CI-pending defer still applies').toBe('false');
  });

  it('gives only the Reviewer’s own label a concurrency group of its own, so two labellers collapse (RA-1334)', () => {
    // MEASURED on PR RA-1708: six runs dispatched within four seconds, two surviving because
    // they had different actors, and both reviewed the same commit. RA-1376's guarantee must
    // survive too: the Reviewer applies `agent:reviewer` MID-review, and concurrency is
    // evaluated BEFORE any job `if`, so without a group of its own that event cancels the
    // in-flight review. A Kanon lane cannot name the Reviewer's App in an expression, so the
    // key separates that one label instead of that one actor.
    const g = wf.concurrency.group as string;
    expect(g, 'the Reviewer’s label keeps a group of its own — RA-1376').toContain("github.event.label.name == 'agent:reviewer' && 'reviewer-label'");
    expect(g, 'and everyone else shares one, so two labellers do not buy two reviews').toContain("|| 'other'");
    expect(g, 'a bare actor is what bought the second concurrent review').not.toContain('github.actor');
    expect(wf.concurrency['cancel-in-progress']).toBe(true);
  });

  it('starts no filter for the Reviewer’s own label, and skips any other event of its App', () => {
    expect(filterIf).toMatch(/^!\(github\.event\.action == 'labeled' && github\.event\.label\.name == 'agent:reviewer'\)/);
    const r = runDecide({ actor: 'example-reviewer[bot]', pushed: ['src/a.ts'], prFiles: ['src/a.ts'] });
    expect(r.review).toBe('false');
    expect(r.stdout).toContain("the Reviewer's own event");
    expect(r.calls, 'decided before any read').toBe('');
    // A login merely PREFIXED like the Reviewer's is not it.
    expect(runDecide({ actor: 'example-reviewer-2[bot]', pushed: ['src/a.ts'], prFiles: ['src/a.ts'] }).review).toBe('true');
  });

  it('counts only the Reviewer’s exact login as a prior review', () => {
    // The reference adopter matched a prefix; the login now comes from the register, and an
    // account merely named like it must not supply "already reviewed".
    const decideRun = String(decide.run);
    expect(decideRun).toContain('select(.user.login == $login)');
    expect(decideRun).not.toContain('startswith(');
  });

  it('tells the Reviewer no COMMENT verdict is ever correct now', () => {
    const prompt: string = wf.jobs.review.steps.find((s: { with?: { prompt?: string } }) => s.with?.prompt).with.prompt;
    expect(prompt).toContain('There is NO case in which `COMMENT` is the');
    // The old escape hatch, gone: its survival is what would silently restore RA-378.
    expect(prompt).not.toContain('post a `COMMENT` now stating your verdict');
  });

  it('checks out the PR head — a workflow_run checkout gets `main` otherwise', () => {
    const checkout = wf.jobs.review.steps.find((s: { uses?: string }) => s.uses?.startsWith('actions/checkout'));
    expect(checkout.with.ref).toBe('${{ needs.filter.outputs.head_sha }}');
  });

  it('resolves the PR from the commit, because a workflow_run payload has no PR', () => {
    const r = runDecide({ pushed: ['src/app/page.tsx'], prFiles: ['src/app/page.tsx'] });
    expect(r.pr).toBe('964');
    expect(r.headSha).toBe(HEAD);
    expect(r.review).toBe('true');
  });

  it('skips a CI run whose commit is no longer the head', () => {
    // A newer push started its own CI run; THAT completion fires the review. Without
    // this, the Reviewer reviews a superseded commit and approves a SHA nobody will merge.
    const r = runDecide({ wfSha: 'c'.repeat(40), pushed: ['src/app/page.tsx'], prFiles: ['src/app/page.tsx'] });
    expect(r.review).toBe('false');
    expect(r.stdout).toContain('superseded');
  });

  it('skips a commit that belongs to no open PR', () => {
    const r = runDecide({ prForSha: '' });
    expect(r.review).toBe('false');
    expect(r.stdout).toContain('no open PR');
  });

  it('treats a 403 body from the PR lookup as no PR, not as a PR number', () => {
    // `gh api` prints its error body to STDOUT, so `2>/dev/null || true` yields a
    // non-empty string that passes an emptiness test. RA-1090 was exactly this shape;
    // the numeric guard, not the emptiness guard, is what holds.
    const r = runDecide({ prForSha: '{"message":"Resource not accessible","status":"403"}' });
    expect(r.review).toBe('false');
  });

  it('skips a PR with no review label, which only the payload used to gate', () => {
    // The `if:` expression reads labels from the pull_request payload. A
    // `workflow_run` payload has none, so the gate has to exist in the script too —
    // otherwise CI completing on ANY PR in the repo starts a review.
    const r = runDecide({ labels: ['documentation'], pushed: ['src/a.ts'], prFiles: ['src/a.ts'] });
    expect(r.review).toBe('false');
    expect(r.stdout).toContain('no review label');
  });

  it('reviews on agent:implement and agent:triage as well', () => {
    for (const label of ['agent:implement', 'agent:triage']) {
      const r = runDecide({ labels: [label], pushed: ['src/a.ts'], prFiles: ['src/a.ts'] });
      expect(r.review, label).toBe('true');
    }
  });

  it('does not review the same commit twice', () => {
    // The `labeled` path can fire on a commit CI already fired for.
    const r = runDecide({ lastReviewed: HEAD, pushed: ['src/a.ts'], prFiles: ['src/a.ts'] });
    expect(r.review).toBe('false');
    expect(r.stdout).toContain('already reviewed');
  });

  it('reviews when the Reviewer has never reviewed the PR', () => {
    const r = runDecide({ lastReviewed: null, prFiles: ['src/a.ts'] });
    expect(r.review).toBe('true');
    expect(r.stdout).toContain('no prior Reviewer review');
  });
});

describe('the label path defers to CI rather than racing it', () => {
  it('defers a label added while CI is still running', () => {
    const r = runDecide({ event: 'pull_request', action: 'labeled', ciPending: true, prFiles: ['src/a.ts'], pushed: ['src/a.ts'] });
    expect(r.review).toBe('false');
    expect(r.stdout).toContain('CI still running');
  });

  it('reviews a label added after CI settled — the case CI completion cannot cover', () => {
    // No CI run fires, so no workflow_run ever arrives; without this path the PR is
    // never reviewed at all.
    const r = runDecide({ event: 'pull_request', action: 'labeled', ciPending: false, prFiles: ['src/a.ts'], pushed: ['src/a.ts'] });
    expect(r.review).toBe('true');
  });

  it('defers when NO CI run has registered for the head yet — absence is not completion', () => {
    // RA-1413, measured twice on PR RA-1400's `labeled` events. `gh pr view --json
    // statusCheckRollup` returned NO CI entries at all just after a push: at 10:29:34Z
    // it printed `CI_PENDING: []` AND `CI_DONE: [0]` while `Build`, `E2E`, `Integration`
    // and `Lint·Typecheck·Unit` were `in_progress`, started 30 seconds earlier. Empty on
    // BOTH sides is the tell — a rollup anchored to a stale head returns COMPLETED
    // entries — so absence was read as completion and the review raced four required
    // checks. It does not self-correct: CI's completion then hits the already-reviewed
    // skip, so the racing review is the only one that SHA ever gets.
    const r = runDecide({ event: 'pull_request', action: 'labeled', ciRuns: [], prFiles: ['src/a.ts'], pushed: ['src/a.ts'] });
    expect(r.review).toBe('false');
    expect(r.stdout).toMatch(/no CI run has registered/);
    expect(evidenceOf(r.stdout).CI_STATE).toBe('not-started');
  });

  it('does not defer on an unreadable CI listing, and does not call it finished either', () => {
    // THREE STATES, and this is the third. Deferring on a read failure means the review
    // never happens on this path and nothing says why; reviewing early is merely
    // wasteful — so it falls through. But `CI_DONE` must stay 0, because "CI finished"
    // is a claim a failed read cannot support, and the human-relabel arm below gates on
    // it (asserted separately in the RA-1400 block).
    const r = runDecide({ event: 'pull_request', action: 'labeled', ciRuns: null, prFiles: ['src/a.ts'], pushed: ['src/a.ts'] });
    expect(evidenceOf(r.stdout).CI_STATE).toBe('unknown');
    expect(evidenceOf(r.stdout).CI_DONE).toBe('0');
    expect(r.stdout).not.toMatch(/CI still running/);
  });

  it('reports a finished CI as done, with the count as positive evidence', () => {
    const r = runDecide({ event: 'pull_request', action: 'labeled', prFiles: ['src/a.ts'], pushed: ['src/a.ts'] });
    expect(evidenceOf(r.stdout).CI_STATE).toBe('done');
    expect(evidenceOf(r.stdout).CI_DONE).toBe('1');
  });

  it('ignores a CI run belonging to a different commit', () => {
    // `--commit` is the server-side filter and the client-side one is belt-and-braces:
    // a listing that stopped honouring it would otherwise report another head's
    // finished CI as this head's.
    const r = runDecide({
      event: 'pull_request', action: 'labeled',
      ciRuns: [{ headSha: 'c'.repeat(40), status: 'completed', conclusion: 'success', databaseId: 7 }],
      prFiles: ['src/a.ts'], pushed: ['src/a.ts'],
    });
    expect(r.review).toBe('false');
    expect(evidenceOf(r.stdout).CI_STATE).toBe('not-started');
  });

  it('never gates on the whole rollup, which always contains its own running check', () => {
    // `Review (Reviewer)` is IN_PROGRESS in every fixture above — it is this very run.
    // A filter that asked "is anything pending?" would answer yes forever and the Reviewer
    // would skip himself on every event. Passing the previous case proves it asks
    // only about CI's own check runs.
    const r = runDecide({ event: 'pull_request', action: 'labeled', prFiles: ['src/a.ts'], pushed: ['src/a.ts'] });
    expect(r.review).toBe('true');
  });

  it('defers `opened`, which is subscribed to only for notify-unlabeled', () => {
    const r = runDecide({ event: 'pull_request', action: 'opened', prFiles: ['src/a.ts'], pushed: ['src/a.ts'] });
    expect(r.review).toBe('false');
    expect(r.stdout).toContain('CI is starting');
  });

  it('keeps notify-unlabeled alive on both its events, behind the membership gate', () => {
    // It fires on `opened` and `labeled` (RA-876/RA-893). Dropping either from the caller's
    // triggers while narrowing the review trigger would silently retire the RA-679 guard.
    const notify = wf.jobs['notify-unlabeled'];
    expect(notify).toBeDefined();
    expect(CALLER.on.pull_request_target.types).toEqual(expect.arrayContaining(['opened', 'labeled']));
    expect(notify.if, 'and its `if` names the event that now fires').toContain("github.event_name == 'pull_request_target'");
    // The gate is `filter`'s first step (K-AGENT-45), so `filter` must start on notify's
    // events too, and notify must wait for its verdict.
    expect(notify.needs).toBe('filter');
    expect(notify.if).toMatch(/^needs\.filter\.outputs\.member == 'true'/);
    expect(filterIf).toMatch(/\|\| \(github\.event_name == 'pull_request_target'\s+&& \(github\.event\.action == 'opened' \|\| github\.event\.action == 'labeled'\)/);
    // …while the decide step leaves those events undecided, so no review starts.
    expect(String(decide.if)).toContain("github.event.action != 'opened'");
    expect(String(decide.if)).toMatch(/^steps\.login\.outputs\.login != ''/);
  });

  it('still reviews on an explicit dispatch, whatever the state', () => {
    const r = runDecide({ event: 'workflow_dispatch', labels: [], prFiles: [] });
    expect(r.review).toBe('true');
    expect(r.pr).toBe('964');
  });
});

describe('a 403 is not an empty file list (RA-1090, RA-1097)', () => {
  it("grants the scope the filter's gh calls need", () => {
    // The actual fix for RA-1090. `checks: read` joined it for statusCheckRollup, and
    // `contents` is restated because an explicit block sets every unlisted scope to
    // `none` — the bug class behind RA-957, RA-1013, RA-1087 and RA-1090 itself.
    expect(wf.jobs.filter.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
      // RA-1413 — the CI-completion read is `gh run list`, an ACTIONS read. Without it
      // `gh` prints a 403 body to stdout and the filter reads "CI has not registered",
      // which defers the review forever instead of erroring.
      actions: 'read',
    });
    // `checks` and `statuses` are GONE with the read that needed them (RA-1413). They
    // existed only for `statusCheckRollup`, which merges CHECK RUNS with STATUS
    // CONTEXTS — a GraphQL query that fails WHOLE when either is inaccessible, which is
    // how a scope used by one branch once took `headRefOid` down for every branch (run
    // 33106210633). The filter no longer asks for the rollup at all, and a scope no call
    // needs is a scope no mutation test can prove is load-bearing. Pinned as ABSENT so
    // this is a deliberate re-grant rather than a silent one.
    // CODE, NOT PROSE: the step still EXPLAINS what the rollup used to do, so a
    // whole-body match would be satisfied by the sentence saying it is gone — the
    // position-not-presence trap this file records six instances of.
    const code = (decide.run as string).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code, 'nothing here reads the rollup any more').not.toContain('statusCheckRollup');
  });

  it('a 403 body reaching PR_FILES is classified as a code file, and is now VISIBLE', () => {
    const { stdout, review } = runDecide({
      // ORDINARY docs, not a spec: since RA-860/RA-1040 a spec push is reviewed on its own
      // merits, which would decide this fixture before the 403 could be classified.
      pushed: ['docs/observability.md'],
      prFiles: ['{"message":"Resource not accessible by integration","status":"403"}'],
    });
    expect(review).toBe('false');
    expect(stdout).toContain('Resource not accessible by integration');
  });

  it('and the same push with a real docs-only list reviews', () => {
    const { review } = runDecide({
      pushed: ['docs/observability.md'],
      prFiles: ['docs/observability.md'],
    });
    expect(review).toBe('true');
  });
});

describe('it shows its evidence, not only its verdict (RA-1090)', () => {
  it('prints every value it decides from', () => {
    // A CODE PR, deliberately: a docs-only PR is decided before the later rules run,
    // so it can never print LAST_REVIEWED or FILES. Asserting the full set on that
    // fixture would only be asserting where the script exits.
    const { stdout } = runDecide({
      pushed: ['docs/observability.md'],
      prFiles: ['docs/payment-state-machine.md', 'docs/observability.md', 'src/app/page.tsx'],
    });
    const e = evidenceOf(stdout);
    expect(Object.keys(e)).toEqual(
      expect.arrayContaining([
        'PR', 'HEAD_REPO', 'HEAD', 'FILES', 'GUARDED_DOCS', 'NONDOCS', 'PR_FILES', 'PR_NONDOCS', 'LAST_REVIEWED',
      ]),
    );
    expect(e.PR_FILES).toContain('docs/payment-state-machine.md');
  });

  it("decides review=true on RA-1057's real shape", () => {
    const r = runDecide({
      pushed: ['docs/payment-state-machine.md', 'docs/qa/specs/payments.md'],
      prFiles: ['docs/payment-state-machine.md', 'docs/qa/specs/payments.md'],
    });
    expect(r.review).toBe('true');
    expect(r.stdout).toContain('docs-only PR');
  });

  it('shows a NON-EMPTY PR_NONDOCS when the PR really does carry code', () => {
    const { stdout } = runDecide({
      pushed: ['docs/qa/specs/payments.md'],
      prFiles: ['docs/qa/specs/payments.md', 'scripts/spec-lib.mjs'],
    });
    expect(evidenceOf(stdout).PR_NONDOCS).toContain('scripts/spec-lib.mjs');
  });

  it("writes the evidence to the STEP SUMMARY, which is this PR's whole claim", () => {
    const { summary } = runDecide({
      pushed: ['docs/qa/specs/payments.md'],
      prFiles: ['docs/qa/specs/payments.md', 'scripts/spec-lib.mjs'],
    });
    expect(summary).toContain('Review filter — what it read');
    expect(summary).toContain('PR_NONDOCS');
    expect(summary).toContain('scripts/spec-lib.mjs');
    expect(summary).toMatch(/\*\*review=(true|false)\*\* —/);
  });

  it('an unreadable PR file list is visibly empty, not silently empty', () => {
    const { stdout, review } = runDecide({ pushed: ['docs/x.md'], prFiles: [] });
    expect(review).toBe('true');
    expect(evidenceOf(stdout)).toHaveProperty('PR_FILES', '');
  });
});

describe('a brief PR is always reviewed', () => {
  it('reviews a docs-only push on RA-964, which carried one code file', () => {
    const r = runDecide({
      pushed: ['docs/projects/961.md', 'docs/qa/specs/payments.md'],
      prFiles: ['docs/projects/961.md', 'docs/qa/specs/payments.md', 'docs/qa/specs/_id-registry.json', 'scripts/spec-lib.mjs'],
    });
    expect(r.review).toBe('true');
    expect(r.stdout).toContain('brief PR');
  });

  it('still skips a docs-only push on an ordinary code PR', () => {
    const r = runDecide({ pushed: ['README.md'], prFiles: ['README.md', 'src/app/page.tsx'] });
    expect(r.review).toBe('false');
  });

  it('still reviews a push that changes code', () => {
    const r = runDecide({ pushed: ['src/app/page.tsx'], prFiles: ['src/app/page.tsx'] });
    expect(r.review).toBe('true');
  });

  it('decides against the PR\'s whole file list, not only the push diff (RA-950)', () => {
    // Moved here from tests/unit/agent-lead.test.ts (RA-960), where three source-string
    // assertions about THIS workflow lived inside a file named for agent-lead, under a
    // docblock about the Lead's brief mode. Someone changing the review filter looked
    // for a file named after the workflow, found none, and concluded it was untested.
    // Kept as behaviour rather than as `expect(run).toContain(...)`: the point of RA-950
    // is what the filter DECIDES, and the source form passed against RA-1032's workflow
    // that had never once succeeded.
    const r = runDecide({
      pushed: ['docs/observability.md'],
      prFiles: ['docs/observability.md', 'src/a.ts'],
    });
    expect(evidenceOf(r.stdout).PR_FILES, 'the whole PR, not the push').toContain('src/a.ts');
    expect(r.review, 'a docs push on a code PR is still skipped').toBe('false');
  });

  it('still reviews every push on a docs-only PR (RA-950)', () => {
    const r = runDecide({ pushed: ['docs/qa/specs/payments.md'], prFiles: ['docs/qa/specs/payments.md'] });
    expect(r.review).toBe('true');
  });

  it('still honours [skip-review]', () => {
    const r = runDecide({
      pushed: ['docs/projects/961.md'],
      prFiles: ['docs/projects/961.md'],
      message: 'docs: typo [skip-review]',
    });
    expect(r.review).toBe('false');
  });

  it('anchors "what changed" to the last REVIEWED commit, not to one push', () => {
    // A code push followed by a docs push: the old before/after basis compared only
    // the second and skipped, so the code was never reviewed. Both files appear in
    // the LAST...HEAD range, so the code is seen.
    const r = runDecide({
      pushed: ['src/app/page.tsx', 'README.md'],
      prFiles: ['src/app/page.tsx', 'README.md'],
    });
    expect(r.review).toBe('true');
    expect(r.stdout).toContain('code changed since');
  });
});

describe('every exit path carries the identity the review job checks out', () => {
  /**
   * `decide` ends in `exit 0`, and `head_sha` used to be written on a LATER line than
   * the fail-safe `decide` for an unreadable PR. So that arm emitted `review=true`
   * with `head_sha` EMPTY — and `actions/checkout` treats an empty `ref` as unset and
   * takes GITHUB_REF, which on a `workflow_run` event is the DEFAULT BRANCH.
   *
   * The Reviewer would then review `main` while being told he was reviewing PR #N, and post
   * a review event on the PR that the Merger merges on. The fail-safe for a flaky `gh`
   * failed unsafe.
   */
  it('emits a head SHA even when `gh pr view` flakes', () => {
    const r = runDecide({ prViewFails: true, pushed: ['src/a.ts'], prFiles: ['src/a.ts'] });
    expect(r.review).toBe('true');
    expect(r.stdout).toContain('reviewing to be safe');
    expect(r.headSha, 'an empty ref makes checkout take the default branch').toBe(HEAD);
    // RA-1133: it is only safe BECAUSE provenance was settled from the payload first.
    // The message says which repository it settled on, so a run that fails open still
    // records what it believed it was about to check out.
    expect(r.stdout).toContain('example-org/example-repo');
  });

  it('emits one on every other exit path too, not only the repaired one', () => {
    const cases: [string, Parameters<typeof runDecide>[0]][] = [
      ['superseded CI', { wfSha: 'c'.repeat(40) }],
      ['no review label', { labels: ['documentation'] }],
      ['already reviewed', { lastReviewed: HEAD }],
      ['skip-review', { message: 'docs: x [skip-review]', prFiles: ['docs/x.md'] }],
      ['docs-only push', { pushed: ['README.md'], prFiles: ['README.md', 'src/a.ts'] }],
      ['code changed', { pushed: ['src/a.ts'], prFiles: ['src/a.ts'] }],
    ];
    for (const [name, over] of cases) {
      const r = runDecide({ pushed: ['src/a.ts'], prFiles: ['src/a.ts'], ...over });
      expect(r.headSha, name).toBeTruthy();
    }
  });

  it('the review job refuses rather than checking out the default branch', () => {
    // Belt and braces: the guard is a hard stop, because refusing to review is
    // recoverable and reviewing `main` under a PR's name is not.
    const guard = wf.jobs.review.steps.find((s: { name?: string }) => s.name?.startsWith('Refuse to review'));
    expect(guard).toBeDefined();
    expect(guard.if).toBe("needs.filter.outputs.head_sha == ''");
  });
});

describe('an optional read cannot break the essential one', () => {
  /**
   * MEASURED, run 33106210633. `statusCheckRollup` merges CHECK RUNS with STATUS
   * CONTEXTS, and the job had `checks: read` but not `statuses: read`. A single
   * inaccessible field fails the WHOLE GraphQL query, so `gh` exited non-zero and
   * `headRefOid` and `labels` came back empty too — a scope needed by ONE branch
   * broke identity resolution for EVERY branch, and the review job refused.
   *
   * The permission is now granted AND the rollup is read separately, so the essential
   * fields cannot be taken down by the optional ones a second time.
   */
  it('resolves the head SHA even when the rollup read is forbidden', () => {
    const r = runDecide({ rollupFails: true, pushed: ['src/a.ts'], prFiles: ['src/a.ts'] });
    expect(r.headSha).toBe(HEAD);
    expect(r.review).toBe('true');
  });

  it('reviews rather than deferring when the rollup cannot be read on the label path', () => {
    // Deferring on a read failure means the review never happens on this path and
    // nothing says why. Reviewing early is merely wasteful — fail towards the loud
    // outcome.
    const r = runDecide({
      event: 'pull_request', action: 'labeled', rollupFails: true,
      pushed: ['src/a.ts'], prFiles: ['src/a.ts'],
    });
    expect(r.review).toBe('true');
    expect(r.headSha).toBe(HEAD);
  });

  it('does not ask about CI\'s runs at all when no branch needs it', () => {
    // It is only consulted on the `labeled` path. Fetching it everywhere is what gave
    // its permissions the power to break everything else.
    //
    // ASSERTS THE CALL, not the outcome. The first version of this test checked only
    // `review` and `headSha` — which pass whether or not the rollup is fetched, so it
    // proved nothing its name claimed.
    const r = runDecide({ event: 'workflow_run', pushed: ['src/a.ts'], prFiles: ['src/a.ts'] });
    expect(r.review).toBe('true');
    expect(r.headSha).toBe(HEAD);
    expect(r.calls, 'CI\'s runs were fetched on a path that never reads them').not.toContain('run list');
  });

  it('DOES ask for it on the one path that reads it', () => {
    // The other half of the claim: narrowing the fetch must not have removed it.
    const r = runDecide({ event: 'pull_request', action: 'labeled', pushed: ['src/a.ts'], prFiles: ['src/a.ts'] });
    expect(r.calls).toContain('run list');
    expect(r.calls, 'keyed on the workflow FILE and the SHA, not on the PR').toMatch(/--workflow ci\.yml --commit b{40}/);
  });
});

describe('a partial read is not a short answer (RA-1093)', () => {
  /**
   * `X="$(gh api … 2>/dev/null || true)"` throws away the exit status, so three
   * different worlds arrive as the same string: the call succeeded and returned
   * nothing, the call 403'd, and — with `--paginate` — the call returned pages 1 and 2
   * and then failed on page 3.
   *
   * The last is the nastiest: the FRAGMENT looks exactly like a complete answer, the
   * evidence line prints it as data, and a filter deciding "docs-only" from half a file
   * list decides wrongly while looking right. RA-1090 was this class one layer up.
   */
  it('reviews when pagination dies partway, instead of judging the fragment', () => {
    // The fragment alone is docs-only, so a filter that trusted it would SKIP. The
    // truncated code file is what it never got to see.
    const r = runDecide({
      partialFiles: ['docs/a.md', 'docs/b.md'],
      pushed: ['docs/a.md'],
    });
    expect(r.review, 'a truncated file list was treated as complete').toBe('true');
    expect(r.stdout).toContain('could not read');
  });

  it('marks the failed read in the evidence, rather than printing it as a value', () => {
    const r = runDecide({ partialFiles: ['docs/a.md'], pushed: ['docs/a.md'] });
    expect(r.stdout).toContain('PR_FILES_READ_FAILED');
    expect(r.summary).toContain('PR_FILES_READ_FAILED');
  });

  it('still distinguishes a genuinely EMPTY list from a failed one', () => {
    // Both fail towards review, but for different stated reasons — the distinction is
    // the whole point, and collapsing them is what this fixes.
    const r = runDecide({ prFiles: [], pushed: ['src/a.ts'] });
    expect(r.review).toBe('true');
    expect(r.stdout).toContain('is empty');
    expect(r.stdout).not.toContain('PR_FILES_READ_FAILED');
  });
});

describe('a fork head never reaches the privileged job (RA-1117)', () => {
  /**
   * `workflow_run` changed this job's security context, and the change is invisible in
   * the diff that made it. Under `pull_request` GitHub WITHHOLDS secrets from a fork
   * PR; under `workflow_run` it does not — while the job still checks out the PR head
   * and runs `npm ci` on it, executing lifecycle scripts from the checked-out
   * `package.json` as the runner user, in a job whose later steps receive
   * QA_REVIEWER_APP_PRIVATE_KEY and CLAUDE_CODE_OAUTH_TOKEN.
   *
   * "The secret is only in a later step" is not a boundary: that process can tamper
   * with $RUNNER_TEMP/_actions and the workspace between steps.
   *
   * Not reachable today — the repo is private and both collaborators are admin, so
   * there is no read-without-write principal. The gate exists because what makes it
   * reachable is an ordinary admin action (a read-only collaborator, or going public)
   * that nobody would connect back to this workflow.
   */
  it('refuses a fork head, and says so rather than skipping silently', () => {
    const r = runDecide({ fork: 'someone-else', pushed: ['src/a.ts'], prFiles: ['src/a.ts'] });
    expect(r.review).toBe('false');
    expect(r.stdout, 'the refusal must name the repository it refused').toContain('someone-else/example-repo');
  });

  it('refuses on a manual dispatch too, which names an arbitrary PR number', () => {
    // The dispatch path takes a PR number from an input; nothing stops that being a
    // fork PR, so the gate cannot sit behind the dispatch short-circuit. It also
    // carries NO head repository in its payload, so this is the one path still
    // relying on the API read — and the only one that can.
    const r = runDecide({ fork: 'someone-else', event: 'workflow_dispatch', labels: [] });
    expect(r.review).toBe('false');
    expect(r.stdout).toContain('FORK');
  });

  it('lets a same-repo head through', () => {
    const r = runDecide({ pushed: ['src/a.ts'], prFiles: ['src/a.ts'] });
    expect(r.review).toBe('true');
  });
});

describe('the fork gate does not depend on a read that can fail (RA-1133)', () => {
  /**
   * THE GATE ABOVE WAS UNREACHABLE ON ONE PATH, and it was the path where least was
   * known. `META` is read with `|| true`, the probe below it fires `decide true
   * "could not read PR"`, and `decide` ends in `exit 0` — so a PR whose metadata read
   * flaked skipped the fork check entirely, then handed the review job
   * `head_sha=$WF_SHA` from the workflow_run payload: the fork's commit, checked out
   * and `npm ci`-ed in a job holding QA_REVIEWER_APP_PRIVATE_KEY.
   *
   * Two correct pieces in the wrong order — the same shape as the read-status bugs in
   * RA-1093 and RA-1090, one level up. The fix is not to reorder them: a gate whose input
   * can fail needs an input that cannot, and `head_repository.full_name` arrives in
   * the event payload.
   */
  it('refuses a fork head whose metadata read failed, on workflow_run', () => {
    const r = runDecide({ fork: 'someone-else', prViewFails: true, pushed: ['src/a.ts'], prFiles: ['src/a.ts'] });
    expect(r.review, 'the fail-open must not outrank the fork gate').toBe('false');
    expect(r.stdout).toContain('someone-else/example-repo');
  });

  it('refuses a fork head whose metadata read failed, on pull_request', () => {
    const r = runDecide({ fork: 'someone-else', prViewFails: true, event: 'pull_request', action: 'labeled' });
    expect(r.review).toBe('false');
    expect(r.stdout).toContain('someone-else/example-repo');
  });

  it('settles provenance from the payload BEFORE reading the API at all', () => {
    // The API would have caught this one too, via `isCrossRepository`. The point is
    // that it never got asked: nothing this gate depends on can 403.
    const r = runDecide({ fork: 'someone-else', pushed: ['src/a.ts'], prFiles: ['src/a.ts'] });
    expect(r.review).toBe('false');
    expect(r.calls, 'the refusal must not have needed `gh pr view` to happen').not.toContain('pr view');
    expect(evidenceOf(r.stdout).HEAD_REPO).toBe('someone-else/example-repo');
  });

  it('refuses rather than reviewing when NOTHING can establish provenance', () => {
    // A dispatch carries no payload head repository, so if the API read also fails
    // there is no source left. "Review to be safe" inverts here: reviewing means
    // checking out a head whose repository is unknown.
    const r = runDecide({ event: 'workflow_dispatch', prViewFails: true, labels: [] });
    expect(r.review).toBe('false');
    expect(r.stdout).toContain('provenance cannot be established');
  });

  it('still fails OPEN for an unreadable same-repo PR — the RA-1090 direction is intact', () => {
    // The gate must not have turned every flaked read into a silent skip; that trades
    // this bug for the pipeline's dominant failure class.
    const r = runDecide({ prViewFails: true, pushed: ['src/a.ts'], prFiles: ['src/a.ts'] });
    expect(r.review).toBe('true');
  });

  it('trusts the payload over a same-repo API answer, not the reverse', () => {
    // If the two ever disagree, the unfailable one wins. `isCrossRepository: false`
    // cannot talk the gate into a head that the payload places elsewhere.
    const r = runDecide({
      payloadHeadRepo: 'someone-else/example-repo',
      pushed: ['src/a.ts'],
      prFiles: ['src/a.ts'],
    });
    expect(r.review).toBe('false');
  });
});

describe('docs whose review IS reading them are never skipped (RA-860, RA-1040)', () => {
  /**
   * The docs-only skip is written for a README tweak: the push cannot change the code
   * verdict, so re-running the reviewer buys nothing. For the reviewer's own
   * instructions and for the L2 oracle that premise is false — reading the docs is
   * the entire review — and the skip fires on exactly the push that delivers them.
   *
   * RA-860 is the sharp one: open a PR with code, collect the Reviewer's approval, then push a
   * lone rewrite of `docs/qa/reviewer-playbook.md`. The filter skipped it, the approval
   * stood, and a gate rewrite reached the merge unread. RA-848 stopped the Reviewer EXECUTING a
   * PR's playbook; this is the half where he never sees it.
   *
   * MEASURED before widening (RA-1040 asked for exactly this): across 120 `Review
   * (the Reviewer)` runs, 47 reaching a decision, the docs-only-push-on-a-code-PR branch
   * fired ZERO times. The carve-out cannot cost what never happens.
   */
  const codePr = (push: string[]) =>
    runDecide({ pushed: push, prFiles: ['src/a.ts', ...push], lastReviewed: LAST });

  it.each([
    ['the reviewer playbook', 'docs/qa/reviewer-playbook.md'],
    ['another instruction doc', 'docs/qa/agent-identities.md'],
    ['the pipeline doc', 'docs/agentic-qa-pipeline.md'],
    ['the repo-root agent rules', 'AGENTS.md'],
    ['its CLAUDE.md alias', 'CLAUDE.md'],
    ['the L2 oracle', 'docs/qa/specs/payments.md'],
    // RA-1148 — the file carrying the GREEN ZONE, which decides what merges unattended.
    ['the lead-engineer doc', 'docs/agentic-lead-engineer.md'],
    // ...and the subdirectory that did not exist when the first pattern was written.
    ['a future docs/qa subdirectory', 'docs/qa/playbooks/whatever.md'],
  ])('reviews a docs-only push that touches %s', (_label, file) => {
    const r = codePr([file]);
    expect(r.review).toBe('true');
    expect(r.stdout).toContain('guarded doc');
  });

  it('reviews a docs push to a document an input delegates to, read from the default branch', () => {
    // `docs/agentic-*.md` are not named anywhere in the lane: `AGENTS.md` links them in
    // the fixture's default branch, which makes them inputs (`K-MERGE-17`).
    const r = codePr(['docs/agentic-lead-engineer.md']);
    expect(r.review).toBe('true');
    expect(r.calls).toMatch(/git\/trees\/main\?recursive=1/);
  });

  it('reviews, rather than judging the push, when the default branch cannot be read', () => {
    const r = runDecide({ pushed: ['docs/observability.md'], prFiles: ['src/a.ts', 'docs/observability.md'], treeFails: true });
    expect(r.review).toBe('true');
    expect(r.stdout).toContain('INPUTS_READ_FAILED');
  });

  it('still skips an ORDINARY docs-only push on a code PR — the rule survives its carve-out', () => {
    // The carve-out must not have swallowed the thing it carves out of. `docs/` files
    // outside the guarded set, and a nested `.md` that is not an instruction doc, stay
    // skippable.
    // NOTE the third path: since RA-1148 the pattern is `^docs/qa/`, so ANY path under
    // docs/qa is guarded. An "ordinary" docs file has to live outside it.
    const r = codePr(['docs/observability.md', 'README.md', 'docs/email.md']);
    expect(r.review).toBe('false');
    expect(r.stdout).toContain('only docs changed');
  });

  it('reviews when a guarded doc rides ALONG with ordinary docs', () => {
    // The gate is "any guarded file in the push", not "every file guarded" — the
    // attack in RA-860 is one playbook edit buried in a docs sweep.
    const r = codePr(['docs/observability.md', 'docs/qa/reviewer-playbook.md']);
    expect(r.review).toBe('true');
  });

  it('names the guarded files it found, so a skip decision can be audited', () => {
    expect(evidenceOf(codePr(['docs/qa/specs/payments.md']).stdout).GUARDED_DOCS)
      .toBe('docs/qa/specs/payments.md');
  });
});

describe("the header describes every carve-out the step implements (RA-1043)", () => {
  /**
   * RA-1039 added the brief-PR carve-out and updated the playbook, correctly — and left
   * the workflow's own docblock 120 lines above describing only the RA-950 one. Third
   * instance on this file (RA-959, RA-821): a doc edit that leaves the text around it
   * stale. A test is the only thing that makes the next one impossible rather than
   * merely regrettable.
   */
  const header = readFileSync(join(process.cwd(), '.github/workflows/agent-review.yml'), 'utf8')
    .split(/^name:/m)[0];

  it.each([
    ['the docs-only PR case', 'RA-950'],
    ['the brief PR case', 'docs/projects/'],
    ['the instruction-docs case', 'RA-860'],
    ['the L2 oracle case', 'docs/qa/**'],
    ['the lead-engineer doc case', 'RA-1148'],
    // RA-1400 review: the header gained a fifth carve-out and this list did not, so
    // deleting either the header paragraph or the arm left the suite green — the
    // fourth instance of exactly the drift RA-1043 wrote this guard for.
    ['the human-relabel case', 'RA-1351'],
  ])('enumerates %s', (_label, needle) => {
    expect(header).toContain(needle);
  });

  it('describes the skip marker as positional, with BOTH positions the code accepts', () => {
    // The header said "tagged `[skip-review]`" while the code checks position — a reader
    // would conclude a message discussing the marker suppresses itself. `skips_review`
    // accepts two positions: the SUBJECT LINE, and the marker alone on a line of its own
    // anywhere in the message (RA-1150). Pinning only the first let the header describe
    // half of the rule and stay green.
    expect(header).toMatch(/SUBJECT LINE/);
    expect(header).toMatch(/ALONE ON A LINE OF ITS OWN/);
  });
});

describe('the skip marker is decided by POSITION, not presence', () => {
  /**
   * MEASURED, live on PR RA-1130. `grep -F '[skip-review]'` matches the token anywhere
   * in the commit message, so a message that merely TALKS about the marker suppresses
   * its own review — and the commit that fixed this marker being inert (RA-1113) did
   * exactly that, skipping itself with the sentence "`[skip-review]` has been silently
   * inert since the job was written".
   *
   * Sixth instance of the shape in this repo (RA-957, RA-1013, RA-1066, RA-1068, RA-1089): a
   * document CONTAINING a token read as USING it. The remedy is always the same —
   * decide by WHERE the token sits.
   */
  const REAL_COMMIT_BODY = [
    'fix(qa): harden the review/merge surface',
    '',
    'Closes RA-1113 — `notify-unlabeled` could not read the head commit, so',
    '`[skip-review]` has been silently inert since the job was written: a deliberate',
    'skip got nagged anyway.',
  ].join('\n');

  it('does NOT skip on a message that merely discusses the marker', () => {
    const r = runDecide({ message: REAL_COMMIT_BODY, pushed: ['src/a.ts'], prFiles: ['src/a.ts'] });
    expect(r.review, 'a commit ABOUT the marker suppressed its own review').toBe('true');
  });

  it('still skips when the marker is on the subject line', () => {
    const r = runDecide({
      message: 'docs: fix a typo [skip-review]\n\nNothing for a reviewer here.',
      pushed: ['docs/x.md'], prFiles: ['docs/x.md'],
    });
    expect(r.review).toBe('false');
  });

  it('still skips when the marker is a line of its own', () => {
    const r = runDecide({
      message: 'docs: regenerate the changelog\n\nMachine-generated.\n\n[skip-review]',
      pushed: ['docs/x.md'], prFiles: ['docs/x.md'],
    });
    expect(r.review).toBe('false');
  });

  it('does not count a backticked mention on its own line', () => {
    // The form prose actually takes when documenting the marker.
    const r = runDecide({
      message: 'docs: explain the marker\n\n`[skip-review]`\n',
      pushed: ['src/a.ts'], prFiles: ['src/a.ts'],
    });
    expect(r.review).toBe('true');
  });
});

describe('a human re-applying the review label outranks the already-reviewed skip (RA-1351)', () => {
  /**
   * The skip is keyed on the head SHA, and a reviewer finding whose remedy is a
   * PR-BODY edit produces no new commit — so the fix could never be re-reviewed, and
   * every attempt reported SUCCESS having posted nothing.
   *
   * Measured on PR RA-1327: three attempts over 23 hours (label churn, then a
   * `pull_request` event) all decided `review=false (already reviewed e3797bb)`, and
   * only a manual `workflow_dispatch` broke it. PR RA-1376 hit the same wall. The escape
   * existed and was documented for a MACHINE — `agent-identities.md:28` grants the Merger
   * `actions: write` so his recover path can dispatch past this — and nowhere for an
   * author.
   */
  // `pushed`/`prFiles` so the flow reaches the dedup rather than short-circuiting on
  // "the PR's file list is empty — review to be safe", which is a different arm.
  const relabel = (o: Partial<Opts> = {}) =>
    runDecide({ event: 'pull_request', action: 'labeled', lastReviewed: HEAD,
                pushed: ['src/a.ts'], prFiles: ['src/a.ts'], ...o });

  it('reviews again when a person re-applies `review:please` on an already-reviewed SHA', () => {
    const r = relabel({ sender: 'a-member', label: 'review:please' });
    expect(r.review).toBe('true');
    expect(r.stdout).toMatch(/human/);
  });

  it('marks that review EXPLICIT, and no other (RA-2026)', () => {
    // Only this arm may re-review a head the Reviewer already reviewed, so only it is
    // marked. The `claim` step reads the mark to word its decline: since kanon#88 a
    // verdict posted after the request answers it, whichever run posted it.
    expect(relabel({ sender: 'a-member', label: 'review:please' }).explicit).toBe('true');
    expect(relabel({ event: 'pull_request_target', sender: 'a-member', label: 'review:please' }).explicit).toBe('true');
    const bot = runDecide({ event: 'workflow_run', prFiles: ['src/a.ts'], pushed: ['src/a.ts'], lastReviewed: null });
    expect(bot.review).toBe('true');
    expect(bot.explicit, 'a CI completion is not an explicit request').toBe('false');
    expect(runDecide({ event: 'workflow_dispatch', labels: [], prFiles: [] }).explicit,
      'nor is a dispatch — the recovery dispatches exist to get A verdict, which a sibling supplies').toBe('false');
  });

  it('is not vacuous: the same event from a bot still hits the skip', () => {
    // THE PROPERTY THAT MAKES THIS SAFE. The Lead churns labels deliberately to avoid
    // needing `actions: write`, and the Reviewer applies `agent:reviewer` mid-review. If
    // either forced a run, this would re-open the dispatch loop those choices avoid.
    for (const bot of ['example-lead[bot]', 'example-implementer[bot]']) {
      const r = relabel({ sender: bot, label: 'review:please' });
      expect(r.review, `${bot} must not force a review`).toBe('false');
      expect(r.stdout).toMatch(/already reviewed/);
    }
  });

  it('spends nothing on an unrelated label a human adds', () => {
    // A `sev:*` or milestone label is not a request for another look.
    const r = relabel({ sender: 'a-member', label: 'sev:medium' });
    expect(r.review).toBe('false');
    expect(r.stdout).toMatch(/already reviewed/);
  });

  it('does not fire on a human label event that is not `labeled`', () => {
    const r = relabel({ sender: 'a-member', label: 'review:please', action: 'unlabeled' });
    expect(r.review).toBe('false');
  });

  it('leaves the skip intact for the ordinary CI-completion path', () => {
    // The cost control exists for a reason (RA-378): an unchanged SHA with no human
    // asking must still be skipped, or every CI completion re-reviews.
    const r = runDecide({ event: 'workflow_run', lastReviewed: HEAD, sender: '', label: '',
                          pushed: ['src/a.ts'], prFiles: ['src/a.ts'] });
    expect(r.review).toBe('false');
    expect(r.stdout).toMatch(/already reviewed/);
  });
});

describe('the human-relabel arm must not pre-empt the CI-pending defer (RA-1400 review)', () => {
  /**
   * `decide` ends in `exit 0`, so an arm placed above the CI-pending gate wins
   * outright. Above it, a human adding `review:please` while CI ran got an immediate
   * review that raced Build/Integration/E2E — on a PR nothing had reviewed yet, so
   * the already-reviewed skip RA-1351 is about was never even in play.
   *
   * It does not self-correct either: CI's completion then hits the already-reviewed
   * skip, so the only review the PR ever gets is the one that raced CI.
   */
  it('defers to CI when a human labels a PR that has never been reviewed', () => {
    const r = runDecide({
      event: 'pull_request', action: 'labeled', sender: 'a-member', label: 'review:please',
      lastReviewed: null, ciPending: true, pushed: ['src/a.ts'], prFiles: ['src/a.ts'],
    });
    expect(r.review).toBe('false');
    expect(r.stdout).toMatch(/CI still running/);
  });

  it('defers to CI even on an already-reviewed SHA', () => {
    // The residue, asserted rather than left implicit: this request IS dropped, and
    // the escape is the dispatch the reconcile step's annotation prints. It needs a
    // manual CI re-run on an unchanged already-reviewed commit; a PR-BODY edit — the
    // case RA-1351 is about — starts no CI run and cannot reach it.
    const r = runDecide({
      event: 'pull_request', action: 'labeled', sender: 'a-member', label: 'review:please',
      lastReviewed: HEAD, ciPending: true, pushed: ['src/a.ts'], prFiles: ['src/a.ts'],
    });
    expect(r.review).toBe('false');
    expect(r.stdout).toMatch(/CI still running/);
  });

  it('needs POSITIVE evidence CI finished, not merely the absence of a pending check', () => {
    // RA-1400 review, reproduced on this PR's own filter job. `CI_PENDING` is
    // absence-based, so three states give the same empty answer: CI finished, the
    // rollup read FAILED (swallowed and substituted with `[]`), and the check runs
    // have not registered yet. The `labeled` event fired 13s after the push,
    // `CI_PENDING` read empty, and four required checks were still IN_PROGRESS three
    // minutes later — the review raced Build, E2E, Integration and Lint.
    //
    // Survivable for every other path, because a `labeled` event slipping past the
    // defer still hit the already-reviewed skip. This arm exists to override that
    // skip, which is what made the defer load-bearing.
    const r = runDecide({
      event: 'pull_request', action: 'labeled', sender: 'a-member', label: 'review:please',
      lastReviewed: HEAD, rollupFails: true, pushed: ['src/a.ts'], prFiles: ['src/a.ts'],
    });
    expect(r.review, 'an unreadable rollup is not evidence that CI finished').toBe('false');
  });

  it('still outranks the already-reviewed skip once CI has settled', () => {
    // NON-VACUITY: moving the arm must not have disabled it. This is RA-1351's actual
    // case — a body edit, so CI completed long ago on this SHA.
    const r = runDecide({
      event: 'pull_request', action: 'labeled', sender: 'a-member', label: 'review:please',
      lastReviewed: HEAD, ciPending: false, pushed: ['src/a.ts'], prFiles: ['src/a.ts'],
    });
    expect(r.review).toBe('true');
    expect(r.stdout).toMatch(/human/);
  });
});

/**
 * kanon#88 — one commit gets one verdict, on a docs-only PR too.
 *
 * The `already reviewed <sha>` skip sat below the docs-only-PR and brief-PR arms, which
 * decide `true` and exit, so a PR made only of docs re-reviewed an already-reviewed head
 * on every event. Kanon PR #80's CI completion on `623b92a` decided `review=true (docs-only
 * PR …)`; the PR carries three APPROVEDs on that commit.
 */
describe('an already-reviewed head is not reviewed again, whatever the PR contains (kanon#88)', () => {
  it('skips a reviewed head on a docs-only PR', () => {
    const r = runDecide({ lastReviewed: HEAD, pushed: ['docs/plans/0002.md'], prFiles: ['docs/plans/0002.md'] });
    expect(r.review).toBe('false');
    expect(r.stdout).toContain('already reviewed');
  });

  it('skips a reviewed head on a brief PR', () => {
    const r = runDecide({ lastReviewed: HEAD, pushed: ['docs/projects/x.md'], prFiles: ['docs/projects/x.md', 'src/a.ts'] });
    expect(r.review).toBe('false');
    expect(r.stdout).toContain('already reviewed');
  });

  it('still reviews a NEW head on a docs-only PR, and still lets a person ask again', () => {
    expect(runDecide({ lastReviewed: LAST, pushed: ['docs/a.md'], prFiles: ['docs/a.md'] }).review).toBe('true');
    const again = runDecide({ event: 'pull_request', action: 'labeled', sender: 'a-member', label: 'review:please',
      lastReviewed: HEAD, pushed: ['docs/a.md'], prFiles: ['docs/a.md'] });
    expect(again.review).toBe('true');
    expect(again.explicit).toBe('true');
  });

  it('acts on a failed reviews read where it always did, after the skip marker', () => {
    // Reading the reviews earlier must not let a flaky read pre-empt `[skip-review]`.
    const r = runDecide({ lastReviewed: HEAD, message: '[skip-review] docs', reviewsFail: true,
      pushed: ['src/a.ts'], prFiles: ['src/a.ts'] });
    expect(r.review).toBe('false');
    expect(r.stdout).toContain('skip marker');
    const flaky = runDecide({ lastReviewed: HEAD, reviewsFail: true, pushed: ['src/a.ts'], prFiles: ['src/a.ts'] });
    expect(flaky.review, 'a failed read still reviews to be safe').toBe('true');
    expect(flaky.stdout).toContain("could not read this PR's reviews");
  });
});
