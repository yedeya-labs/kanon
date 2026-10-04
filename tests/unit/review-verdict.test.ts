import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runWorkflowStep } from './helpers/workflow-step.js';
import { writeStub } from './helpers/stub-bin.js';
import { trailerFor } from '../../scripts/review-trailer.mjs';

/**
 * RA-1351 — a review run that posts nothing must not read as normal.
 *
 * Two separate failures reached a PR on 2026-08-31 with the SAME surface — the PR at
 * `REVIEW_REQUIRED` while every signal read fine:
 *
 *   · PR RA-1376 — the action exited non-zero (`is_error:true`) five minutes in, after
 *     five concurrency-cancelled siblings. Six runs, zero verdicts. The check went
 *     red, which says "the job failed", not "your PR has no review".
 *   · RA-356 — a run that exited ZERO having posted nothing. Worse: green.
 *
 * The workflow already knew the second shape was real — the `--max-turns` comment says
 * a run can die "WITHOUT posting a verdict — indistinguishable from a crash" — and
 * answered it with more turns. Headroom makes it rarer; it cannot make it visible.
 *
 * These EXECUTE the step, per RA-1032: every prior assertion about this workflow was a
 * string match on its source, and that bought a workflow which had never once
 * succeeded while its tests were green.
 */
const wf = parse(readFileSync(join(process.cwd(), '.github/workflows/agent-review.yml'), 'utf8'));
const step = wf.jobs.review.steps.find(
  (s: { name?: string }) => s.name === "Reconcile the agent's exit with whether a verdict was posted");

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
// The Reviewer's login is the App register's (`K-LAYOUT-6`): the lane reads it in `filter` and
// hands it to this job as `REVIEWER_LOGIN`; every verdict selection matches it exactly.
const LOGIN = 'example-reviewer';
const REVIEWER = `${LOGIN}[bot]`;

type Review = { user: { login: string }; commit_id: string; state: string; body?: string };

const run = ({
  agent = 'success',
  reviews = [] as Review[],
  readFails = false,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'review-verdict-'));
  // THE STUB RUNS THE REAL `--jq` FILTER. Returning a pre-computed count would test a
  // copy of the selection rule rather than the shipped one — the mistake `exitCodeFor`
  // was extracted to fix on RA-1295 — so which reviews COUNT (this SHA, the Reviewer, a real
  // verdict event) would be asserted nowhere.
  writeStub(join(dir, 'gh'),
    `#!/usr/bin/env bash\n${
      readFails
        // `gh` prints its error body to STDOUT, so a 403 arrives as a NON-EMPTY string
        // that passes an emptiness test — the trap this repo has hit five times.
        ? `printf '%s' '{"message":"Resource not accessible","status":"403"}'; exit 1`
        : `filter=""; prev=""
for a in "$@"; do [ "$prev" = "--jq" ] && filter="$a"; prev="$a"; done
printf '%s' ${JSON.stringify(JSON.stringify(reviews))} | jq -r "$filter"`
    }\n`);
  const r = runWorkflowStep(step, {
    dir,
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      GH_TOKEN: 't', REVIEWER_LOGIN: LOGIN,
      REPO: 'example-org/example-repo',
      PR_NUMBER: '1376',
      HEAD_SHA: HEAD,
      AGENT: agent,
    },
  });
  return { status: r.status, stdout: r.stdout, summary: r.summary };
};

const verdict = (state: string, commit = HEAD, login = REVIEWER, body = '') =>
  ({ user: { login }, commit_id: commit, state, body });
/** A verdict whose run recorded which commit it actually read (RA-1680). */
const stamped = (state: string, filedUnder: string, read: string) =>
  verdict(state, filedUnder, REVIEWER, `Verdict.\n\n<!-- reviewed: sha=${read} run=1 -->`);

describe('the job fails unless a verdict was actually posted (RA-1351)', () => {
  it('is green when the agent succeeded and a verdict is on this SHA', () => {
    const r = run({ agent: 'success', reviews: [verdict('APPROVED')] });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/no verdict posted/);
  });

  it('REDS a run that exited zero and posted nothing — the RA-356 shape', () => {
    // This is the one that used to be GREEN, on an unreviewed PR. The whole reason
    // the step exists: a green check saying nothing happened is indistinguishable
    // from a green check saying it went fine.
    const r = run({ agent: 'success', reviews: [] });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/exited ZERO but posted no verdict/);
    expect(r.stdout, 'and it must say how to recover').toMatch(/gh workflow run agent-review\.yml -f pr_number=1376/);
  });

  it('REDS a crashed run that posted nothing — the RA-1376 shape', () => {
    const r = run({ agent: 'failure', reviews: [] });
    expect(r.status).not.toBe(0);
    // REWORDED BY RA-1408, deliberately. This said "FAILED and posted no verdict … Re-run
    // with: gh workflow run …". That instruction is wrong for the most common cause —
    // 3 of the 10 measured failures were a quota cap, where re-running immediately
    // fails the same way. The message now points at the classifier's annotation, which
    // says which it was. The property this case exists for is unchanged and is
    // asserted below: a crashed run that posted nothing must RED.
    expect(r.stdout).toMatch(/No verdict was posted for .* and the review agent did not finish/);
    expect(r.stdout, 'and it must route the reader to the cap-vs-crash annotation')
      .toMatch(/whether to re-run NOW or wait/);
    // AND CARRY THE COMMAND ITSELF (RA-1503 review, finding 2). Routing to the annotation
    // was made the ONLY carrier of the dispatch line for one round, and that annotation
    // is not guaranteed to exist — `renderNotice` omits `recover` on some paths and the
    // classify call is `|| true`, so a branch cut before RA-1408 merges prints nothing.
    expect(r.stdout, 'a pointer to an annotation is not a recovery command')
      .toMatch(/gh workflow run agent-review\.yml -f pr_number=1376/);
  });

  it('downgrades a crash that DID post to a warning', () => {
    // The RA-846 argument, applied here: the review is the durable artifact, and it
    // landed. Reding this teaches readers that red is negotiable.
    const r = run({ agent: 'failure', reviews: [verdict('CHANGES_REQUESTED')] });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/::warning title=reviewer overran after posting/);
  });

  describe('what counts as a verdict', () => {
    it('a review on an EARLIER commit does not', () => {
      // RA-964 merged carrying an APPROVED that belonged to the previous SHA. A stale
      // verdict says nothing about the commits this run was invoked to look at.
      const r = run({ agent: 'success', reviews: [verdict('APPROVED', OLD)] });
      expect(r.status).not.toBe(0);
    });

    it('a COMMENT does not', () => {
      // RA-378: a COMMENT carrying an approve in its prose is invisible to everything
      // downstream, all of which reads review EVENTS. Three of seven consecutive PRs
      // stalled on exactly that.
      const r = run({ agent: 'success', reviews: [verdict('COMMENT')] });
      expect(r.status).not.toBe(0);
    });

    it('a verdict GitHub filed under this SHA that the run read ELSEWHERE does not (RA-1680)', () => {
      // `commit_id` is the head at SUBMISSION time and `gh pr review` cannot pin it, so
      // a push landing mid-review re-attributes the verdict to a commit nothing read.
      // Measured on PR RA-1672: an `APPROVED` filed under `add9508` opening "First review
      // on this PR (single commit `effc0c9`)". This guard exists to prove THIS commit
      // was reviewed, and until now a review of another one satisfied it.
      const r = run({ agent: 'success', reviews: [stamped('APPROVED', HEAD, OLD)] });
      expect(r.status).not.toBe(0);
    });

    it('a verdict filed under an older SHA that the run DID read here does', () => {
      // The same race can file a review under the OLD head. What the run read is what
      // counts, in both directions — and without this the guard would red a run that
      // did exactly what it was asked to.
      const r = run({ agent: 'success', reviews: [stamped('APPROVED', OLD, HEAD)] });
      expect(r.status).toBe(0);
    });

    it('an UNSTAMPED verdict on this SHA still does — every review predating RA-1680 has none', () => {
      // NON-VACUITY IN THE OTHER DIRECTION. An absent stamp proves nothing either way,
      // so `commit_id` remains the fallback; otherwise this change would have redded
      // every in-flight review the day it merged.
      expect(run({ agent: 'success', reviews: [verdict('APPROVED')] }).status).toBe(0);
    });

    it('a body that QUOTES the trailer is still read from its APPENDED stamp (RA-1713)', () => {
      // the Reviewer writes about this mechanism in the body of every review of the PR that
      // introduced it. Taking the FIRST trailer-shaped match made a quoted example win
      // over the genuine one appended beneath, and this step then reported `POSTED = 0`
      // — redding a run whose verdict had landed.
      // NO BACKTICKS IN A FIXTURE BODY. The stub embeds it in a DOUBLE-quoted bash
      // string, where a backtick is command substitution — the same trap the filter
      // suite records against `[skip-review]`, which had the marker executed away
      // before the script ever saw it.
      const body = `Discussing <!-- reviewed: sha=${OLD} run=1 --> in prose.\n\n`
        + `<!-- reviewed: sha=${HEAD} run=9 -->`;
      expect(run({ agent: 'success', reviews: [verdict('APPROVED', HEAD, REVIEWER, body)] }).status).toBe(0);
    });

    it('a quoted trailer cannot make a MIS-ATTRIBUTED verdict look current either', () => {
      // NON-VACUITY the other way: taking the last match must not become "find any match
      // that equals the head". A verdict whose real stamp names another commit still
      // fails, even when its prose quotes the head.
      const body = `Discussing <!-- reviewed: sha=${HEAD} run=1 --> in prose.\n\n`
        + `<!-- reviewed: sha=${OLD} run=9 -->`;
      expect(run({ agent: 'success', reviews: [verdict('APPROVED', HEAD, REVIEWER, body)] }).status).not.toBe(0);
    });

    it("someone else's review does not", () => {
      // The job asserts THE REVIEWER reviewed. A human approving does not mean the reviewer
      // ran, and treating it as such would hide every crash on a PR someone approved.
      const r = run({ agent: 'success', reviews: [verdict('APPROVED', HEAD, 'someone-else')] });
      expect(r.status).not.toBe(0);
    });
  });

  it('only the Reviewer’s exact login counts — not an account merely named like it', () => {
    // The login is the App register's, matched exactly (`K-LAYOUT-6`): a prefix would let
    // `example-reviewer-impostor[bot]`, or a user called `example-reviewer`, post the verdict.
    for (const login of [`${LOGIN}-impostor[bot]`, LOGIN]) {
      expect(run({ agent: 'success', reviews: [verdict('APPROVED', HEAD, login)] }).status, login).not.toBe(0);
    }
  });

  it('fails CLOSED when the reviews cannot be read', () => {
    // RA-957's shape: a swallowed read deciding an outcome. `gh` prints its error body
    // to stdout, so the 403 arrives as a non-empty string — the numeric guard is what
    // actually holds here, not an emptiness test.
    const r = run({ agent: 'success', readFails: true });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/reviewer outcome unknown/);
    expect(r.stdout).toMatch(/Refusing to treat unknown as reviewed/);
  });
});

/**
 * RA-1680 / RA-1334 — the step that writes down which commit this run actually read.
 *
 * GitHub sets `commit_id` to the head AT SUBMISSION TIME, so a push landing while the
 * reviewer is working re-attributes the verdict to a commit nothing here saw. The job
 * knows the answer — `actions/checkout` was given `needs.filter.outputs.head_sha` — and
 * until now nothing wrote it down. These EXECUTE the step (RA-1032) rather than matching
 * its source, because the failure that matters is a stamp that silently never lands.
 */
describe('stamping the commit this run reviewed (RA-1680)', () => {
  const stampStep = wf.jobs.review.steps.find(
    (s: { name?: string }) => s.name === 'Stamp the commit this run reviewed onto the verdict it posted');

  const RUN_START = '2026-09-06T12:10:00Z';
  const stampRun = ({
    reviews = [] as Record<string, unknown>[],
    startedAt = RUN_START as string | null,
    readFails = false,
    putFails = false,
    // What this run's agent posted from (kanon#178). `undefined` writes the body `mine()`
    // carries by default; `null` leaves no file at all.
    posted = 'Approve.\n' as string | null,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), 'review-stamp-'));
    const verdictFile = join(dir, 'qa-review-verdict.md');
    if (posted !== null) writeFileSync(verdictFile, posted);
    // THE STUB RUNS THE REAL `--jq` FILTERS, so which reviews are selected is asserted
    // against the shipped expression rather than a copy of it.
    writeStub(join(dir, 'gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/calls"
for a in "$@"; do printf '%s\\n' "$a" >> "${dir}/args"; done
case "$1 $2" in
  "run view") ${startedAt === null ? 'exit 1' : `printf '%s' '${startedAt}'`} ;;
esac
case "$*" in
  # THE REAL API'S SHAPE, not a stub that accepts any verb (#2026). "Update a review"
  # is PUT; PATCH on that path is a 404 — measured, and it is why no stamp ever landed
  # while this suite, which accepted PATCH, stayed green.
  *"-X PATCH"*) printf '%s' '{"message":"Not Found","status":"404"}'; exit 1 ;;
  *"-X PUT"*) ${putFails ? `echo 'gh: Resource not accessible by integration (HTTP 403)' >&2; exit 1` : "printf '%s' '{}'"} ;;
  *"/reviews?per_page"*)
    ${readFails
      ? `printf '%s' '{"message":"Resource not accessible","status":"403"}'; exit 1`
      : `filter=""; prev=""
    for a in "$@"; do [ "$prev" = "--jq" ] && filter="$a"; prev="$a"; done
    if [ -n "$filter" ]; then printf '%s' ${JSON.stringify(JSON.stringify(reviews))} | jq -r "$filter"; else printf '%s' ${JSON.stringify(JSON.stringify(reviews))}; fi`} ;;
esac
`);
    const r = runWorkflowStep(stampStep, {
      dir,
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        GH_TOKEN: 't', REVIEWER_LOGIN: LOGIN,
        REPO: 'example-org/example-repo',
        PR_NUMBER: '1672',
        HEAD_SHA: HEAD,
        RUN_ID: '99',
        VERDICT_FILE: verdictFile,
      },
    });
    const args = (() => { try { return readFileSync(join(dir, 'args'), 'utf8'); } catch { return ''; } })();
    return { status: r.status, stdout: r.stdout, summary: r.summary, args };
  };

  const mine = (over: Record<string, unknown> = {}) => ({
    id: 500, user: { login: REVIEWER }, state: 'APPROVED', commit_id: HEAD,
    submitted_at: '2026-09-06T12:16:08Z', body: 'Approve.', ...over,
  });

  it('appends the checked-out SHA to the verdict this run posted', () => {
    const r = stampRun({ reviews: [mine()] });
    expect(r.status).toBe(0);
    // LANDED, not merely attempted (RA-2026). With the wrong verb every stamp 404'd into
    // the warning below and this case still passed on the arguments alone.
    expect(r.stdout, 'the update must succeed against the real verb').toMatch(/stamped review 500/);
    expect(r.stdout).not.toMatch(/Could not update review/);
    // AGAINST THE JS EMITTER, not a hand-written literal. The step builds the trailer in
    // bash (no Node on the path there) while `review-trailer.mjs` defines the same shape
    // for every reader — two writers of one format, which is precisely the drift worth
    // pinning. `trailerFor` is what the parser is tested against, so if the two ever
    // disagree, this is where it shows.
    expect(r.args, 'the stamp must name the commit the RUN read')
      .toContain(trailerFor({ sha: HEAD, runId: '99' }));
    expect(r.args, 'and it must be appended, not replace the review').toMatch(/Approve\./);
  });

  it('warns loudly when GitHub filed the verdict under a commit this run never read', () => {
    // PR RA-1672's exact shape: the review lands 18 seconds after a push, so `commit_id`
    // is the NEW head while the body describes the old one.
    const r = stampRun({ reviews: [mine({ commit_id: OLD })] });
    expect(r.stdout).toMatch(/::warning title=review mis-attributed/);
    expect(r.args, 'and the stamp still records what was actually read').toContain(`sha=${HEAD}`);
  });

  it('records the same-SHA verdicts it supersedes, and only the earlier ones (RA-1334)', () => {
    // A CI run only reaches the review job past the `already reviewed <sha>` skip, so a
    // same-SHA re-review from this workflow is the deliberate kind (RA-1351) and can name
    // what it replaces. A verdict submitted AFTER this run started is a sibling, not a
    // predecessor — claiming to supersede one would be the blind second opinion RA-1334 is
    // about rather than the cure for it.
    const r = stampRun({
      reviews: [
        mine({ id: 400, state: 'CHANGES_REQUESTED', submitted_at: '2026-09-06T09:00:00Z' }),
        mine({ id: 401, state: 'CHANGES_REQUESTED', submitted_at: '2026-09-06T12:11:00Z' }),
        mine({ id: 500 }),
      ],
    });
    expect(r.args).toContain('supersedes=400 -->');
    expect(r.args, 'a verdict from a sibling run is not superseded by this one').not.toContain('supersedes=400,401');
  });

  it('stamps a verdict whose prose merely QUOTES the format (RA-1713)', () => {
    // The idempotence test was "does the body contain the pattern", and the stamp is
    // APPENDED — so a review that quotes the format was treated as already stamped and
    // never got one. It is anchored to the END of the body instead.
    const body = `See <!-- reviewed: sha=${OLD} run=1 --> above, then real content.`;
    const r = stampRun({ reviews: [mine({ body })], posted: body });
    expect(r.args, 'the genuine stamp must still be appended').toContain(`<!-- reviewed: sha=${HEAD} run=99 -->`);
  });

  it('leaves a verdict that already carries a stamp alone', () => {
    // Idempotence, and the reason is a re-run: stamping twice would leave two trailers
    // and the parser takes the first, which after a re-run is the older claim.
    // Idempotence, checked at the END of the body — where the appended stamp actually
    // sits — so a re-run leaves one trailer rather than two.
    const r = stampRun({ reviews: [mine({ body: `Approve.\n\n<!-- reviewed: sha=${HEAD} run=1 -->\n` })] });
    expect(r.args).not.toContain('-X');
    expect(r.stdout).toMatch(/nothing to annotate/);
  });

  it('stamps nothing at all when the run start could not be read', () => {
    // NO BOUND, NO STAMP. Without a start time the newest verdict might belong to a
    // SIBLING run reviewing a different commit, and stamping it would write this run's
    // SHA onto somebody else's evidence — manufacturing exactly the lie RA-1680 is about.
    const r = stampRun({ reviews: [mine()], startedAt: null });
    expect(r.args).not.toContain('-X');
    expect(r.stdout).toMatch(/::warning title=reviewed-sha stamp/);
    expect(r.status, 'and it must not red a run whose verdict landed').toBe(0);
  });

  it('never reds the job, however the annotation goes', () => {
    // The review is the durable artifact and it has landed — the RA-846/RA-1351 argument.
    // A failure to annotate must warn; the reconcile step below is the hard gate.
    expect(stampRun({ reviews: [mine()], readFails: true }).status).toBe(0);
    expect(stampRun({ reviews: [mine()], putFails: true }).status).toBe(0);
    expect(stampRun({ reviews: [mine()], putFails: true }).stdout).toMatch(/Could not update review 500/);
  });

  it("says WHY a stamp did not land, and does not report it as stamped (RA-2281)", () => {
    // Every stamp failed for days behind `>/dev/null 2>&1`, which threw away the one
    // line that would have named the cause. The warning now carries GitHub's error.
    const failed = stampRun({ reviews: [mine()], putFails: true });
    // `gh api`'s real stderr shape on a denied write (the RA-2026 rule: the stub speaks
    // the real API's language, not an invented one).
    expect(failed.stdout).toMatch(/Could not update review 500's body \(gh: Resource not accessible by integration \(HTTP 403\)\)/);
    expect(failed.summary, 'the summary must not claim a stamp that failed').not.toMatch(/Stamped this run's verdict/);
    // The summary page carries the error itself — annotations are not on it.
    expect(failed.summary).toMatch(/\*\*Not stamped:\*\* review\(s\) 500 \(gh: Resource not accessible by integration \(HTTP 403\)\)/);
    // And a supersession the failed stamp would have recorded is not lost with it.
    const superseding = stampRun({
      reviews: [mine({ id: 400, state: 'CHANGES_REQUESTED', submitted_at: '2026-09-06T09:00:00Z' }), mine()],
      putFails: true,
    });
    expect(superseding.summary).toMatch(/supersession of review\(s\) 400 went unrecorded/);
    const ok = stampRun({ reviews: [mine()] });
    expect(ok.summary).toMatch(/Stamped this run's verdict/);
    expect(ok.summary).not.toMatch(/Not stamped/);
  });

  describe("only the verdict this run's agent posted (kanon#178)", () => {
    // Two runs on DIFFERENT heads of one PR: the sibling posted at 12:15:30 and has not
    // stamped yet (or its stamp failed) when this run's stamp step reads the reviews.
    const sibling = mine({ id: 450, commit_id: OLD, submitted_at: '2026-09-06T12:15:30Z',
      body: 'Request changes: the sibling read an older head.' });

    it("leaves a sibling's unstamped verdict alone and stamps this run's", () => {
      const r = stampRun({ reviews: [sibling, mine()] });
      expect(r.stdout).toMatch(/stamped review 500/);
      expect(r.stdout).not.toMatch(/stamped review 450/);
      expect(r.args, 'the sibling must not be given this run\'s SHA').not.toMatch(/sibling read an older head/);
    });

    it('stamps nothing when the only unstamped verdict is a sibling\'s — this run posted none', () => {
      const r = stampRun({ reviews: [sibling] });
      expect(r.args).not.toContain('-X');
      expect(r.stdout).toMatch(/::warning title=reviewed-sha stamp::No unstamped verdict since/);
      expect(r.status).toBe(0);
    });

    it('stamps nothing, and says so, when the agent left no verdict file', () => {
      const r = stampRun({ reviews: [sibling, mine()], posted: null });
      expect(r.args).not.toContain('-X');
      expect(r.stdout).toMatch(/left no verdict body/);
      expect(r.status).toBe(0);
    });

    it('matches the body across the whitespace a shell strips on the way to the API', () => {
      const r = stampRun({ reviews: [mine({ body: 'Approve.\r\n\nSecond line.' })], posted: '\nApprove.\n\nSecond line.\n\n' });
      expect(r.stdout).toMatch(/stamped review 500/);
    });

    it('does not match a body that differs inside, or a sibling sharing only a prefix', () => {
      const r = stampRun({ reviews: [mine({ body: 'Approve.\n\nSecond  line.' })], posted: 'Approve.\n\nSecond line.' });
      expect(r.args).not.toContain('-X');
      const prefix = stampRun({ reviews: [mine({ body: 'Approve. And more.' })], posted: 'Approve.' });
      expect(prefix.args).not.toContain('-X');
    });

    it('the prompt names the file the stamp reads, and a step clears it before the agent', () => {
      const steps = wf.jobs.review.steps as { name?: string; id?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> }[];
      const path = stampStep.env.VERDICT_FILE;
      expect(path).toBe('${{ runner.temp }}/qa-review-verdict.md');
      const agent = steps.find((s) => s.id === 'agent')!;
      expect(agent.with!.prompt).toContain(`\`${path}\``);
      expect(agent.with!.prompt).toMatch(/--body-file/);
      const clear = steps.findIndex((s) => s.name === 'Clear the verdict file before the agent writes it');
      expect(clear, 'the clearing step exists').toBeGreaterThan(-1);
      expect(steps[clear]!.env!.VERDICT_FILE).toBe(path);
      expect(steps[clear]!.run).toMatch(/rm -f -- "\$VERDICT_FILE"/);
      // After the scope is placed, and before the pin re-check, which only the token
      // step separates from the agent.
      const placed = steps.findIndex((s) => s.id === 'scope_place');
      const verify = steps.findIndex((s) => s.name === 'Re-verify the pin before the agent reads it');
      expect(placed, 'the place step exists').toBeGreaterThan(-1);
      expect(verify, 'the pin re-check exists').toBeGreaterThan(-1);
      expect(clear).toBeGreaterThan(placed);
      expect(clear).toBeLessThan(verify);
    });
  });

  it('runs before the reconcile step, which now reads the stamp it writes', () => {
    const names = wf.jobs.review.steps.map((s: { name?: string; uses?: string }) => s.name ?? s.uses);
    expect(names.indexOf(stampStep.name))
      .toBeLessThan(names.indexOf("Reconcile the agent's exit with whether a verdict was posted"));
    // Same guard as the reconcile step: a cancelled run was superseded, and a run that
    // never reached the agent has no verdict to annotate.
    expect(stampStep.if).toBe(step.if);
  });
});

describe('the step is wired so it can actually run (RA-1351)', () => {
  it('runs on !cancelled(), so a crashed agent cannot skip the check on its own crash', () => {
    // NOT `always()`. Under that, every concurrency-cancelled sibling emitted
    // `::error title=no verdict posted::` telling a reader to re-dispatch — noise in
    // the exact signal this step sharpens, and RA-1400's own rollup carried two. A
    // cancelled run was superseded; asserting a verdict on it asks the wrong question.
    // It must still run on FAILURE, which is the whole point.
    expect(step.if).toBe("${{ !cancelled() && steps.agent.conclusion != 'skipped' }}");
    expect(step.if, 'always() would fire on cancelled siblings').not.toBe('always()');
    expect(step.if, 'and it must still fire when the agent FAILED — the whole point').not.toMatch(/success\(\)/);
  });

  it('does not fire when the agent step never ran', () => {
    // Observed on this PR's own run: an earlier step failed, so the App token was
    // never minted, GH_TOKEN was empty, and this step reported `reviewer outcome
    // unknown` — fail-closed and technically true, but pointing a reader at the
    // reviews API when the real failure is four steps up and already red.
    expect(step.if).toContain("steps.agent.conclusion != 'skipped'");
  });

  it('reads the reviews without --paginate, which would emit one count per page', () => {
    // `gh api --paginate --jq` runs the filter ONCE PER PAGE, so the count arrives as
    // "0\n0\n1" — the newline trips the numeric guard and reds a PR that DOES carry a
    // verdict. Measured on PR RA-1327 with `?per_page=1`. The sibling read of the same
    // endpoint in the filter job already avoids this the same way.
    const ghCall = step.run.split('\n').find((l: string) => l.includes('gh api'));
    expect(ghCall).toContain('reviews?per_page=100');
    expect(ghCall, '--paginate re-runs --jq once per page').not.toContain('--paginate');
  });

  it('the agent step is continue-on-error, or the reconcile never runs', () => {
    const agent = wf.jobs.review.steps.find((s: { id?: string }) => s.id === 'agent');
    expect(agent, 'the action step needs an id for outcome to be readable').toBeTruthy();
    expect(agent['continue-on-error']).toBe(true);
  });

  it('reads the head SHA from the filter, not from the payload', () => {
    // A `workflow_run` payload carries no pull_request, so `github.event...head.sha`
    // is empty on the path this job most often runs from — which would make every
    // verdict look stale.
    expect(step.env.HEAD_SHA).toBe('${{ needs.filter.outputs.head_sha }}');
  });
});

/**
 * RA-2026 — at most one the Reviewer verdict per head.
 *
 * Measured on PR RA-2208, head `7135bb7`: a `workflow_run` and a `workflow_dispatch`
 * created in the same second landed in different workflow-level concurrency groups
 * (that key cannot know a `workflow_run`'s PR), both reviewed, and the PR carries two
 * `APPROVED` events on one commit. RA-2145/RA-2124 show the contradictory form. The job-level
 * group queues the second behind the first; the `claim` step then stands it down.
 * EXECUTED against a stub `gh` that runs the step's real `--jq` filter (RA-1032).
 */
describe('one review of a head at a time (RA-2026)', () => {
  const review = wf.jobs.review;
  const claim = review.steps.find((s: { id?: string }) => s.id === 'claim');
  const RUN_START = '2026-09-21T15:10:10Z';

  const claimRun = ({
    reviews = [] as Record<string, unknown>[],
    headNow = HEAD as string | null,
    startedAt = RUN_START as string | null,
    reviewsFail = false,
    explicit = 'false',
  }) => {
    const dir = mkdtempSync(join(tmpdir(), 'review-claim-'));
    const json = JSON.stringify(JSON.stringify(reviews));
    writeStub(join(dir, 'gh'), `#!/usr/bin/env bash
filter=""; prev=""
for a in "$@"; do [ "$prev" = "--jq" ] && filter="$a"; [ "$prev" = "-q" ] && filter="$a"; prev="$a"; done
case "$*" in
  "run view"*) ${startedAt === null ? 'exit 1' : `printf '%s' '${startedAt}'`} ;;
  *"/reviews?per_page"*)
    ${reviewsFail ? `printf '%s' '{"message":"Server Error","status":"500"}'; exit 1` : `printf '%s' ${json} | jq -r "$filter"`} ;;
  *"/pulls/"*) ${headNow === null ? `printf '%s' '{"message":"Server Error"}'; exit 1` : `printf '%s' '${headNow}'`} ;;
esac
`);
    const r = runWorkflowStep(claim, {
      dir,
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        GH_TOKEN: 't', REVIEWER_LOGIN: LOGIN, REPO: 'example-org/example-repo', PR_NUMBER: '2208',
        HEAD_SHA: HEAD, EXPLICIT: explicit, RUN_ID: '35617081885',
      },
    });
    return { status: r.status, stdout: r.stdout, proceed: /^proceed=(\w+)$/m.exec(r.outputFile)?.[1] ?? null };
  };
  const at = (state: string, submitted: string, over: Record<string, unknown> = {}) =>
    ({ ...verdict(state), submitted_at: submitted, ...over });

  it('stands down, GREEN, when a sibling posted a verdict on this head while it waited', () => {
    // PR RA-2208's second APPROVED, prevented.
    const r = claimRun({ reviews: [at('APPROVED', '2026-09-21T15:13:55Z')] });
    expect(r.proceed).toBe('false');
    expect(r.status, 'a correct decline must not red the job').toBe(0);
    expect(r.stdout).toMatch(/sibling run/);
  });

  it('stands down on a sibling CHANGES_REQUESTED too — the RA-2145 contradiction', () => {
    expect(claimRun({ reviews: [at('CHANGES_REQUESTED', '2026-09-21T15:12:00Z')] }).proceed).toBe('false');
  });

  it('reviews when the only verdict on this head PREDATES the run — the dispatch was past it on purpose', () => {
    // RA-1351's human re-label and every recovery dispatch are both "review again despite
    // the verdict already here"; `filter` decided that, and this step must not undo it.
    const r = claimRun({ reviews: [at('APPROVED', '2026-09-21T09:00:00Z')] });
    expect(r.proceed).toBe('true');
  });

  it('ignores verdicts that are not about this head, or are not verdicts', () => {
    const r = claimRun({ reviews: [
      at('APPROVED', '2026-09-21T15:13:55Z', { commit_id: OLD }),
      at('COMMENTED', '2026-09-21T15:13:55Z'),
      { ...at('APPROVED', '2026-09-21T15:13:55Z'), user: { login: 'someone-else' } },
    ] });
    expect(r.proceed).toBe('true');
  });

  it('reads the stamp over commit_id, as the reconcile step does (RA-1680)', () => {
    // Filed under this head by GitHub but READ against another commit: not a review of
    // this head, so it does not stand this run down…
    expect(claimRun({ reviews: [at('APPROVED', '2026-09-21T15:13:55Z', {
      body: `x\n\n<!-- reviewed: sha=${OLD} run=1 -->` })] }).proceed).toBe('true');
    // …while one filed under another commit but READ against this head does.
    expect(claimRun({ reviews: [at('APPROVED', '2026-09-21T15:13:55Z', {
      commit_id: OLD, body: `x\n\n<!-- reviewed: sha=${HEAD} run=1 -->` })] }).proceed).toBe('false');
  });

  it('selects exactly what the reconcile step counts, over the same reviews', () => {
    // Two spellings of one rule (the claim step's hex class is respelled for the
    // permissions guard). Run both over one population and compare, rather than trust
    // that `[[:xdigit:]]` and `[0-9a-fA-F]` agree.
    const population = [
      at('APPROVED', '2026-09-21T15:13:55Z'),
      at('CHANGES_REQUESTED', '2026-09-21T15:14:00Z', { commit_id: OLD }),
      at('APPROVED', '2026-09-21T15:15:00Z', { body: `<!-- reviewed: sha=${OLD} run=2 -->` }),
      at('APPROVED', '2026-09-21T15:16:00Z', { commit_id: OLD, body: `<!-- reviewed: sha=${HEAD.toUpperCase()} run=3 -->` }),
      at('COMMENTED', '2026-09-21T15:17:00Z'),
    ];
    const jqOf = (step: { run: string }) => /--jq "([\s\S]*?)" 2>\/dev\/null\)"/.exec(step.run)?.[1]
      ?.replace(/\\"/g, '"').replace(/\$HEAD_SHA/g, HEAD).replace(/\$\{REVIEWER_LOGIN\}/g, LOGIN).replace(/\$SINCE/g, '2000-01-01T00:00:00Z');
    const count = (filter: string) => Number(execFileSync('jq', ['-r', filter],
      { input: JSON.stringify(population), encoding: 'utf8' }).trim());
    const claimJq = jqOf(claim) as string;
    const reconcileJq = jqOf(step) as string;
    expect(claimJq, 'claim filter parsed').toBeTruthy();
    expect(reconcileJq, 'reconcile filter parsed').toBeTruthy();
    expect(count(reconcileJq), 'the population must exercise the rule').toBe(2);
    expect(count(claimJq)).toBe(count(reconcileJq));
  });

  it('stands down when the head moved — the RA-2009 ec3e6cf-read, 5729fc5-filed approval', () => {
    const r = claimRun({ headNow: OLD });
    expect(r.proceed).toBe('false');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/head moved/);
  });

  // kanon#88: the two sequences measured on 2026-10-02, replayed. An explicit request used
  // to bypass this step, so a person re-labelling while a review ran got a second verdict.
  it('answers an explicit request with the verdict posted after it — kanon PR #76 at 46d7984', () => {
    // CI's completion started a review at 18:34:05; `review:please` was re-applied at
    // 18:34:26 and started this run at 18:34:29; the first run APPROVED at 18:36:33. This
    // run, queued behind it, used to REQUEST CHANGES on the same commit at 18:39:55.
    const r = claimRun({ explicit: 'true', startedAt: '2026-10-02T18:34:29Z',
      reviews: [at('APPROVED', '2026-10-02T18:36:33Z')] });
    expect(r.proceed).toBe('false');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/answer it/);
  });

  it('reviews an explicit request made AFTER the verdict — a person asking again', () => {
    const r = claimRun({ explicit: 'true', startedAt: '2026-10-02T18:50:00Z',
      reviews: [at('APPROVED', '2026-10-02T18:36:33Z')] });
    expect(r.proceed).toBe('true');
  });

  it('declines an explicit request whose head moved — kanon PR #80, b9be2f1 then 623b92a', () => {
    // Run 37048367931 was a re-label on `b9be2f1`; `623b92a` was pushed while it queued,
    // and it APPROVED at 18:38:39 under the new head before CI's own review of it landed.
    const r = claimRun({ explicit: 'true', headNow: OLD });
    expect(r.proceed).toBe('false');
    expect(r.stdout).toMatch(/head moved/);
  });

  it('declines the third run on kanon PR #80 at 623b92a, re-labelled before two verdicts landed', () => {
    const r = claimRun({ explicit: 'true', startedAt: '2026-10-02T18:37:51Z', reviews: [
      at('APPROVED', '2026-10-02T18:38:39Z'), at('APPROVED', '2026-10-02T18:39:40Z')] });
    expect(r.proceed).toBe('false');
  });

  // kanon#167: Actions keeps one pending run per group, so a third arrival evicts a queued
  // explicit re-label before it reaches this step. That loses nothing only while `explicit`
  // decides nothing here, so that is what is asserted: the same decision for both, on
  // every shape above. If an exemption returns, this fails and the job's concurrency
  // comment has to be re-argued.
  it('decides an explicit run exactly as any other, so evicting one from the queue loses nothing (kanon#167)', () => {
    const shapes = [
      {},
      { reviews: [at('APPROVED', '2026-09-21T15:13:55Z')] },
      { reviews: [at('CHANGES_REQUESTED', '2026-09-21T15:13:55Z')] },
      { reviews: [at('APPROVED', '2026-09-21T15:00:00Z')] },
      { headNow: OLD },
      { headNow: null },
      { startedAt: null },
      { reviewsFail: true },
    ];
    for (const shape of shapes) {
      expect(claimRun({ ...shape, explicit: 'true' }).proceed, JSON.stringify(shape))
        .toBe(claimRun({ ...shape, explicit: 'false' }).proceed);
    }
    // And `explicit` is not in the key: a group of its own would not queue behind the
    // running review, which is RA-2208's two verdicts on one head.
    expect(review.concurrency.group).not.toContain('explicit');
  });

  it('reviews when any read fails — this is de-duplication, not a gate', () => {
    expect(claimRun({ reviewsFail: true, reviews: [at('APPROVED', '2026-09-21T15:13:55Z')] }).proceed).toBe('true');
    expect(claimRun({ startedAt: null }).proceed).toBe('true');
    const headUnknown = claimRun({ headNow: null });
    expect(headUnknown.proceed).toBe('true');
    expect(headUnknown.stdout).toMatch(/::warning title=review claim/);
  });

  it('queues a second review of the same head behind the first, whatever triggered either', () => {
    // `needs` is what makes this possible at JOB level and impossible at workflow level:
    // the PR is only known once `filter` has resolved it.
    expect(review.concurrency.group).toContain('${{ needs.filter.outputs.pr }}');
    expect(review.concurrency.group).toContain('${{ needs.filter.outputs.head_sha }}');
    // Queue, not cancel: cancelling kills a review mid-turn and pays for it twice.
    expect(review.concurrency['cancel-in-progress']).toBe(false);
  });

  it('gates EVERY later step on the claim, so a declined run spends nothing', () => {
    const steps = review.steps as { id?: string; name?: string; uses?: string; run?: string; if?: string }[];
    const from = steps.findIndex((s) => s.id === 'claim');
    expect(from, 'the claim step must exist').toBeGreaterThan(0);
    // Everything before it is the job's start stamp (a `date`, for the telemetry row's
    // `timed_out`) and the empty-head refusal, both of which must stay unconditional.
    expect(steps.slice(0, from).map((s) => s.name)).toEqual(['Record when the job started', 'Refuse to review without a head SHA']);
    expect(steps[0]?.run?.trim()).toBe('echo "started-at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$GITHUB_OUTPUT"');
    const after = steps.slice(from + 1);
    expect(after.length, 'a vacuous sweep proves nothing').toBeGreaterThan(10);
    for (const s of after) {
      const label = s.name ?? s.uses ?? s.run;
      const gated = String(s.if ?? '').includes("steps.claim.outputs.proceed == 'true'")
        // The stamp and reconcile steps key on the agent step, which is itself gated.
        || String(s.if ?? '').includes("steps.agent.conclusion != 'skipped'");
      expect(gated, `${label} runs on a run the claim stood down`).toBe(true);
    }
    expect(String(steps.find((s) => s.id === 'agent')?.if)).toContain("steps.claim.outputs.proceed == 'true'");
  });
});

/**
 * RA-2691 — the token-bearing reconcile step runs NO classifier any more. It used to run a
 * base copy, extracted and digested by hand (RA-1520/RA-1542); the `agent-classify` block now
 * runs in a step of its own, gated on the `verdict=none` this step writes. So these hold the
 * two halves of that hand-off: the step says "no verdict" exactly when it used to classify,
 * and executes nothing from `$RUNNER_TEMP`, where the extracted copy used to live.
 */
describe('the reconcile step hands the classifier its gate, and runs none itself (RA-2691)', () => {
  const runWith = ({ agent = 'failure', reviews = [] as Review[], readFails = false }) => {
    const dir = mkdtempSync(join(tmpdir(), 'review-classify-'));
    const temp = mkdtempSync(join(tmpdir(), 'review-classify-temp-'));
    const marker = join(dir, 'executed');
    // Where the extracted copy used to be: a step that still ran it would leave the marker.
    writeFileSync(join(temp, 'classify-agent-result.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    writeStub(join(dir, 'gh'),
      `#!/usr/bin/env bash\n${
        readFails
          ? `printf '%s' '{"message":"Resource not accessible","status":"403"}'; exit 1`
          : `filter=""; prev=""
for a in "$@"; do [ "$prev" = "--jq" ] && filter="$a"; prev="$a"; done
printf '%s' ${JSON.stringify(JSON.stringify(reviews))} | jq -r "$filter"`
      }\n`);
    const r = runWorkflowStep(step, {
      dir,
      env: {
        PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: 't', REVIEWER_LOGIN: LOGIN, REPO: 'r', PR_NUMBER: '1',
        HEAD_SHA: HEAD, AGENT: agent, RUNNER_TEMP: temp,
      },
    });
    let ran = false;
    try { ran = readFileSync(marker, 'utf8') === 'ran'; } catch { /* not executed */ }
    return { ...r, ran };
  };

  it('says `verdict=none` on both no-verdict branches — the runs it used to classify', () => {
    for (const agent of ['failure', 'success']) {
      const r = runWith({ agent });
      expect(r.status, agent).not.toBe(0);
      expect(r.outputs.verdict, agent).toBe('none');
      expect(r.stdout, `${agent}: and the recovery command still prints`).toMatch(/gh workflow run agent-review\.yml -f pr_number=1/);
    }
  });

  it('says nothing when a verdict was posted, or when the reviews could not be read', () => {
    // Neither path classified before: a posted verdict has nothing to explain, and an
    // unreadable answer is not "no verdict" (RA-957). The classify step's gate keeps it so.
    expect(runWith({ reviews: [verdict('APPROVED')] }).outputs.verdict).toBeUndefined();
    const unread = runWith({ readFails: true });
    expect(unread.status).not.toBe(0);
    expect(unread.outputs.verdict).toBeUndefined();
  });

  it('digests the result file on that path, and the check before the classifier refuses a changed one', () => {
    const pin = wf.jobs.review.steps.find((s: { id?: string }) => s.id === 'result_pin');
    const temp = mkdtempSync(join(tmpdir(), 'review-result-'));
    const file = join(temp, 'claude-execution-output.json');
    const check = (expected: string) => runWorkflowStep(pin, { env: { EXPECTED: expected, RUNNER_TEMP: temp } });
    // Absent when the reconcile step ran, absent now: intact (the classifier says not-reached).
    expect(runWith({}).outputs.result_sha256).toBe('absent');
    expect(check('absent').outputs.intact).toBe('true');
    writeFileSync(file, '{"type":"result","is_error":true}');
    const digest = execFileSync('sha256sum', [file], { encoding: 'utf8' }).split(' ')[0]!;
    expect(check(digest).outputs.intact, 'unchanged').toBe('true');
    writeFileSync(file, '{"type":"result","is_error":true,"modelUsage":{}}');
    const forged = check(digest);
    expect(forged.outputs.intact, 'changed after the reconcile read it').toBeUndefined();
    expect(forged.status, 'it explains, it does not red').toBe(0);
    expect(forged.stdout).toMatch(/result file changed/);
    expect(check('').outputs.intact, 'no digest recorded').toBeUndefined();
    expect(check('absent').outputs.intact, 'a file that appeared').toBeUndefined();
  });

  it('records the digest of the result file the classifier will read', () => {
    const r = (() => {
      const dir = mkdtempSync(join(tmpdir(), 'review-classify-'));
      const temp = mkdtempSync(join(tmpdir(), 'review-classify-temp-'));
      writeFileSync(join(temp, 'claude-execution-output.json'), 'x');
      writeStub(join(dir, 'gh'), `#!/usr/bin/env bash\nprintf '%s' '0'\n`);
      return runWorkflowStep(step, { dir, env: { PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: 't', REVIEWER_LOGIN: LOGIN, REPO: 'r', PR_NUMBER: '1', HEAD_SHA: HEAD, AGENT: 'failure', RUNNER_TEMP: temp } });
    })();
    expect(r.outputs.result_sha256).toBe('2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881');
  });

  it('executes no classifier itself, in a step that holds the App token', () => {
    const r = runWith({});
    expect(r.ran, 'nothing from $RUNNER_TEMP runs beside the App token').toBe(false);
    expect(step.env.GH_TOKEN).toMatch(/app-token/);
    expect(Object.keys(step.env)).not.toContain('CLASSIFY_SHA256');
    expect(String(step.run)).not.toMatch(/^\s*node\b/m);
  });
});

/**
 * kanon#185 — the Reviewer runs none of the PR's code (the Owner, 2026-10-04).
 *
 * The review job checks out the PR's head and later holds the reviewer App token, whose
 * approval the Merger acts on. It used to run the PR's install, migrations and seed there
 * through the project-setup hook, so a PR's `postinstall` ran in the workspace the token
 * and the agent later used. Test results come from CI's required checks instead. These
 * hold the job's STRUCTURE to that: what a step may call, and what a `run:` may execute.
 */
describe("the review job runs none of the PR's code (kanon#185)", () => {
  type S = { id?: string; name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
  const steps = wf.jobs.review.steps as S[];
  // The shell words that run a project's code, or fetch and run someone else's.
  const RUNNERS = /(^|[\s;&|(`])(npm|npx|pnpm|yarn|bun|corepack|make|pip3?|poetry|uv|cargo|go|gradle|gradlew|mvn|bundle|composer|deno|tsx|ts-node|playwright|docker)(\s|$)/m;
  // An interpreter, and the first thing it is handed.
  const INTERPRETED = /(?:^|[\s;&|(`])(node|bash|sh|zsh|python3?|ruby|perl)\s+("[^"]*"|\S+)/gm;
  const lines = (run: string) => run.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  it("calls only Kanon's blocks and pinned third-party actions — nothing from the PR's tree", () => {
    const uses = steps.map((x) => x.uses).filter((u): u is string => typeof u === 'string');
    expect(uses.length, 'the check is not vacuous').toBeGreaterThan(5);
    // `./` on this job is the PR's head: the checkout above is `needs.filter.outputs.head_sha`.
    expect(uses.filter((u) => u.startsWith('./'))).toEqual([]);
    for (const u of uses) expect(u, u).toMatch(/^(\$\/actions\/[a-z-]+|[a-z0-9-]+\/[a-z0-9-]+@v\d+(\.\d+)*)$/);
    // No database for a test tier that is no longer run, and no hook to hand one to.
    expect(uses).not.toContain('$/actions/test-database');
    expect(steps.some((x) => x.id === 'hook' || x.id === 'project' || x.id === 'database')).toBe(false);
  });

  it('runs no package manager or build tool in any step', () => {
    const found = steps.filter((x) => RUNNERS.test(lines(String(x.run ?? '')))).map((x) => x.name ?? x.id);
    expect(found).toEqual([]);
  });

  it('executes no file from the tree directly, nor sources one', () => {
    // `./x.sh` or `../x` in command position (after any `VAR=value` prefixes), or
    // `source`/`.` of any file.
    const DIRECT = /(?:^|[;&|(])\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:\.\.?\/|source\s|\.\s)/m;
    const found = steps.filter((x) => DIRECT.test(lines(String(x.run ?? '')))).map((x) => x.name ?? x.id);
    expect(found).toEqual([]);
  });

  it("hands every interpreter one of Kanon's own scripts, never a file from the tree", () => {
    const calls = steps.flatMap((x) => [...lines(String(x.run ?? '')).matchAll(INTERPRETED)]
      .map((m) => ({ step: x.name ?? x.id, cmd: m[1], arg: m[2]! })));
    expect(calls.length, 'the check is not vacuous').toBeGreaterThanOrEqual(4);
    const outside = calls.filter((c) => !/^"\$(KANON|KANON_PATH)\//.test(c.arg));
    expect(outside).toEqual([]);
  });

  it('tells the agent to run none of it, and offers no test run', () => {
    const prompt = String(steps.find((x) => x.id === 'agent')!.with!.prompt);
    expect(prompt).toContain("RUN NONE OF THE PR'S CODE (kanon#185)");
    expect(prompt).toMatch(/Do not install, build, migrate,\s+or run any test tier, script, binary or hook from this tree/);
    expect(prompt).toMatch(/take every test result from\s+CI/);
    expect(prompt).not.toMatch(/sanity-run|FAST tier|FOREGROUND blocking/i);
  });

  it("reports no stage for a hook it no longer calls", () => {
    const finish = steps.find((x) => x.uses === '$/actions/agent-finish')!;
    expect(String(finish.with!.stages)).not.toMatch(/hook=/);
  });
});
