import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers/adopter.js';
const {
  HELD_LABEL, IMPLEMENTER_LOGIN, MAX_PER_RUN, PIPELINE_LABELS, PR_FIELDS,
  attemptComment, ineligible, isResolveJob, marker, rebaseDecision, report,
} = await import('../../scripts/rebase-lane.mjs');
const { ConflictFieldsUnread } = await import('../../scripts/conflict-state.mjs');
import { blockOf, effectiveSteps, laneBlockOf } from '../unit/helpers/spine.js';
import { readFlattened, workflowText } from '../unit/helpers/called-workflow.js';

/**
 * RA-2150 — something finally resolves the conflict the five RA-1722 lanes only report.
 *
 * THE FAILURE MODE HERE IS NOT "FAILED TO ACT". A PR left conflicting is exactly the
 * state before this lane existed, and RA-1722 already makes it visible. It is **handing a
 * branch to an agent with `contents: write` that should not have been handed over** —
 * so every test below is about a refusal, and each control exists to stop a refusal
 * from becoming universal (the inertness RA-1594 measured one lane over, where a guard
 * blocked everything and the suite stayed green).
 *
 * Two designs died before this one, and their gravestones are in the module header: a
 * label churn cannot reach a conflicting PR at all (RA-1722), and a scripted merge cannot
 * succeed because `git merge` has already resolved everything resolvable (RA-2164).
 */

const HEAD = 'cafed00dbeef0000000000000000000000000000';
const pr = ({
  number = 55,
  login = IMPLEMENTER_LOGIN,
  state = 'OPEN',
  isDraft = false,
  labels = ['agent:implement'],
  headRefOid = HEAD,
  headRefName = 'fix/55-thing',
  // Declared on every fixture: `conflictState` throws rather than answering "clear" for
  // an object that never asked (RA-1722), so a fixture cannot skip the gate silently.
  mergeStateStatus = 'DIRTY',
  mergeable = 'CONFLICTING',
} = {}) => ({
  number, author: { login }, state, isDraft, headRefOid, headRefName,
  labels: labels.map((name) => ({ name })), mergeStateStatus, mergeable,
});

const decide = (prs: unknown[], opts = {}) => rebaseDecision(prs, opts);

describe('whose branches reach the agent at all', () => {
  it('hands over a conflicting pipeline PR', () => {
    const out = decide([pr()]);
    expect(out.resolve).toHaveLength(1);
    expect(out.resolve[0]).toMatchObject({ number: 55, branch: 'fix/55-thing' });
    expect(out.noted).toEqual([]);
  });

  it('never hands over a PR carrying `needs:human`', () => {
    // The developer's explicit decision. The Merger's escalation marker is keyed on
    // `(rule, head SHA)`, so a moved head mints a duplicate escalation comment on a PR
    // a human is already reading.
    const out = decide([pr({ labels: ['agent:implement', HELD_LABEL] })]);
    expect(out.resolve).toEqual([]);
    expect(out.noted[0].why).toContain(HELD_LABEL);
  });

  it('never hands over a branch this pipeline did not author', () => {
    const out = decide([pr({ login: 'some-human' })]);
    expect(out.resolve).toEqual([]);
    expect(out.noted[0].why).toMatch(/not this pipeline/);
  });

  it.each([
    ['a draft', { isDraft: true }],
    ['a closed PR', { state: 'CLOSED' }],
    ['a PR no lane is waiting on', { labels: ['documentation'] }],
  ])('leaves %s alone', (_label, over) => {
    expect(decide([pr(over)]).resolve).toEqual([]);
  });

  it('ignores a PR that does not conflict', () => {
    // Acting on a clean PR would dismiss a standing approval and re-run CI for nothing.
    expect(decide([pr({ mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' })]))
      .toEqual({ resolve: [], noted: [] });
  });

  it('ignores a PR whose mergeability GitHub has not computed yet', () => {
    expect(decide([pr({ mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN' })]).resolve).toEqual([]);
  });

  it('throws rather than assuming a PR that never declared mergeability is clean', () => {
    expect(() => decide([{ number: 1, author: { login: IMPLEMENTER_LOGIN }, state: 'OPEN', labels: [] }]))
      .toThrow(ConflictFieldsUnread);
  });

  it('reports the MOST SPECIFIC reason when several apply', () => {
    const out = decide([pr({ isDraft: true, labels: ['agent:implement', HELD_LABEL] })]);
    expect(out.noted[0].why).toContain(HELD_LABEL);
  });
});

describe('one attempt per head', () => {
  it('does not re-hand a head already attempted', () => {
    // `main` moves hourly; without this the same unchanged PR goes to the agent all day.
    const out = decide([pr()], { hasMarker: () => true });
    expect(out.resolve).toEqual([]);
    expect(out.noted[0].reason).toBe('attempted');
  });

  it('keys the marker on the head, so a push re-opens the lane', () => {
    expect(marker(HEAD)).not.toBe(marker('0'.repeat(40)));
    expect(marker(HEAD)).toContain(HEAD.slice(0, 12));
  });

  it('says an actor is on it, and names the one thing that would escalate', () => {
    // A human reading the PR during the session should see an actor, not silence.
    const body = attemptComment(HEAD);
    expect(body).toContain(marker(HEAD));
    expect(body).toMatch(/product decision/);
    expect(body).toContain(HELD_LABEL);
    expect(body).toMatch(/RA-1722/);
  });
});

describe('the cap, and what it must not do quietly', () => {
  const five = [1, 2, 3, 4, 5].map((n) => pr({ number: n }));

  it('hands over at most `MAX_PER_RUN`', () => {
    expect(decide(five).resolve).toHaveLength(MAX_PER_RUN);
  });

  it('REPORTS the remainder rather than dropping it', () => {
    // A silent truncation is the one thing that would make this lane's own summary
    // untrustworthy — the `silent-absence` class this pipeline keeps producing.
    const out = decide(five);
    const deferred = out.noted.filter((n: { reason: string }) => n.reason === 'deferred');
    expect(deferred).toHaveLength(5 - MAX_PER_RUN);
    expect(out.resolve.length + deferred.length).toBe(5);
  });

  it('writes no marker for a deferred PR, so the next run still sees it', () => {
    // The marker is written by the WORKFLOW, only for PRs in `resolve` — asserted here
    // because a deferred PR that got one would be skipped forever.
    const out = decide(five);
    const deferred = out.noted.filter((n: { reason: string }) => n.reason === 'deferred');
    // ASSERT THE SET IS NON-EMPTY FIRST. A `for` over an empty array asserts nothing and
    // passes, which is how this test survived the mutation that deleted the whole
    // deferral arm — it caught one of the three cap tests, not this one.
    expect(deferred.length).toBeGreaterThan(0);
    for (const d of deferred) expect(d.why).toMatch(/no marker was written/);
  });
});

describe('the report says what it examined', () => {
  it('calls an empty world a finding rather than printing nothing', () => {
    expect(report({ resolve: [], noted: [] })).toMatch(/That is a finding, not an absence/);
  });

  it('names every PR it declined and why', () => {
    const text = report(decide([pr({ number: 7, login: 'a-human' })]));
    expect(text).toContain('#7');
    expect(text).toMatch(/not this pipeline/);
  });
});

describe('the workflow wiring', () => {
  const wf = readFlattened(join(ROOT, '.github/workflows/agent-rebase.yml'));
  // What the job RUNS (RA-2659): the lane calls the agent-lane blocks directly, so its agent,
  // classifier and telemetry steps live inside `agent-run` / `agent-finish`, and each block
  // call is read as the block's own steps with the call's inputs substituted.
  const steps = effectiveSteps(wf.jobs.resolve.steps);
  const step = (re: RegExp) => steps.find((s: { name?: string }) => re.test(s.name ?? ''))!;

  // A KANON LANE is called, never triggered (plan 0001 step 5): its caller holds the
  // triggers, which the lane states as its contract above `on:`, and the filter job admits
  // exactly those events, since a called workflow runs on whatever its caller is called on.
  const text = workflowText(join(ROOT, '.github/workflows/agent-rebase.yml'));
  const contract = text.slice(text.indexOf("# THE CALLER'S TRIGGERS"), text.indexOf('\non:\n'));

  it('is NOT triggered by a label, which could never fire on a conflicting PR', () => {
    // The whole finding of RA-1722, and the reason this lane departs from the route every
    // other re-delivery here takes.
    expect(Object.keys(wf.on)).toEqual(['workflow_call']);
    const events = [...contract.matchAll(/^#\s{3}(\w+)/gm)].map((m) => m[1]).sort();
    expect(events).toEqual(['schedule', 'workflow_dispatch', 'workflow_run']);
    const admits = String(wf.jobs.filter.if);
    expect([...admits.matchAll(/github\.event_name == '(\w+)'/g)].map((m) => m[1]).sort()).toEqual(events);
    expect(admits).not.toContain('pull_request');
  });

  it('fires on the event that CREATES the condition', () => {
    expect(contract).toMatch(/^#\s+workflow_run: CI, \[completed\], branches \[main\]$/m);
    // A cancelled CI run is a superseded one: still turned away, as before.
    expect(wf.jobs.filter.if).toContain("github.event.workflow_run.conclusion != 'cancelled'");
  });

  it('grants the filter job the scope its `gh pr list` needs', () => {
    // A JOB BLOCK REPLACES THE WORKFLOW BLOCK — it does not merge — so the
    // workflow-level `contents: read` leaves `pull-requests` at `none` unless restated.
    // A denied scope does NOT error: `gh` prints the 403 body to STDOUT, so the value
    // reads as DATA and the matrix is fed an error message. CI's `permissions-guard`
    // caught exactly this on the first push of this lane.
    expect(wf.jobs.filter.permissions).toMatchObject({ 'pull-requests': 'read' });
  });

  it('refuses a filter output that is not a JSON array', () => {
    // The sibling of the above: a 403 body is non-empty, so an emptiness check passes
    // and `fromJson` receives prose. The step asserts the shape, not merely arrival.
    const run = wf.jobs.filter.steps.find((s: { id?: string }) => s.id === 'decide').run;
    expect(run).toMatch(/type == "array"/);
    expect(run).toMatch(/is not a JSON array/);
  });

  it('gates the expensive job behind a cheap default-token filter', () => {
    // A `main` merge that conflicts with nothing is the common case and must cost one
    // `gh pr list`, not an App token, a database and an agent session.
    expect(wf.jobs.filter.steps.some((s: { uses?: string }) => (s.uses ?? '').startsWith('actions/create-github-app-token'))).toBe(false);
    expect(wf.jobs.resolve.if).toContain("needs.filter.outputs.prs != '[]'");
    // And behind the membership gate, read FIRST: a refusal leaves `prs` empty, which
    // passes `!= '[]'` (K-AGENT-45).
    expect(wf.jobs.resolve.if).toBe("needs.filter.outputs.member == 'true' && needs.filter.outputs.prs != '[]'");
    const filter = wf.jobs.filter.steps as { id?: string; uses?: string; if?: string }[];
    expect(filter.slice(0, 2).map((s) => s.id ?? s.uses)).toEqual(['$/actions/kanon-path', 'gate']);
    for (const s of filter.slice(2)) expect(s.if, s.id ?? s.uses).toBe("steps.gate.outputs.member == 'true'");
  });

  it('writes the attempt marker BEFORE invoking the agent', () => {
    // A crashed or capped session writes nothing, so a marker only a successful run
    // left would re-hand the same commit forever. Ordering is the guarantee.
    const markerIdx = steps.findIndex((s: { name?: string }) => /Record the attempt/.test(s.name ?? ''));
    const agentIdx = steps.findIndex((s: { uses?: string }) => (s.uses ?? '').startsWith('anthropics/claude-code-action'));
    expect(markerIdx).toBeGreaterThan(-1);
    expect(markerIdx).toBeLessThan(agentIdx);
  });

  it('writes it INSIDE the matrix job, after its checkout, as a step of the lane\'s own', () => {
    // NOT in an earlier job (RA-2659). `resolve` is a `max-parallel: 1` matrix over PRs, so
    // a job that pre-recorded every PR would mark one "attempted on this head" even when
    // its turn never came (a cancel, a timeout) — and a conflicting PR's head never moves,
    // so that PR would never be retried. Nor inside a block, whose steps no lane controls.
    const own: { name?: string; uses?: string }[] = wf.jobs.resolve.steps;
    const markerIdx = own.findIndex((s) => /Record the attempt/.test(s.name ?? ''));
    const checkoutIdx = own.findIndex((s) => (s.uses ?? '').startsWith('actions/checkout'));
    const runIdx = own.findIndex((s) => laneBlockOf(s) === 'agent-run');
    expect(wf.jobs.resolve.strategy.matrix.pr).toBeDefined();
    expect(markerIdx).toBeGreaterThan(checkoutIdx);
    expect(markerIdx).toBeLessThan(runIdx);
    expect(blockOf(steps.find((s: { name?: string }) => /Record the attempt/.test(s.name ?? ''))!)).toBeUndefined();
    for (const [name, job] of Object.entries<{ steps?: { run?: string }[] }>(wf.jobs)) {
      if (name === 'resolve') continue;
      expect((job.steps ?? []).some((s) => /attemptComment|gh pr comment/.test(s.run ?? '')), name).toBe(false);
    }
  });

  it('asserts the App slug before the first push', () => {
    const assertIdx = steps.findIndex((s: { name?: string }) => /Assert the minted App/.test(s.name ?? ''));
    const agentIdx = steps.findIndex((s: { uses?: string }) => (s.uses ?? '').startsWith('anthropics/claude-code-action'));
    expect(assertIdx).toBeLessThan(agentIdx);
    expect(step(/Assert the minted App/).run).toContain('IMPLEMENTER_LOGIN');
  });

  it('checks out with the App token and full history', () => {
    // `github.token` cannot push, and a push by it would trigger nothing downstream —
    // CI would never re-run and the PR would stay unreviewed for a different reason.
    // `fetch-depth: 0` because the agent merges `main` into a branch.
    const checkout = steps.find((s: { uses?: string }) => (s.uses ?? '').startsWith('actions/checkout'))!;
    expect(checkout.with!.token).toContain('app-token');
    expect(checkout.with!['fetch-depth']).toBe(0);
  });

  it('resolves one PR at a time and lets one failure not cancel the rest', () => {
    expect(wf.jobs.resolve.strategy['max-parallel']).toBe(1);
    expect(wf.jobs.resolve.strategy['fail-fast']).toBe(false);
  });

  it('never cancels a run mid-resolution', () => {
    expect(wf.concurrency['cancel-in-progress']).toBe(false);
  });

  it('measures itself under its own name, not the implementer\'s', () => {
    const tel = steps.find((s: { uses?: string }) => (s.uses ?? '').includes('agent-telemetry'))!;
    expect(tel.with!.agent).toBe('rebase-lane');
    expect(tel.if).toBe('always()');
  });

  it('classifies a red run, so a quota cap is not a bare failure', () => {
    expect(step(/model was unreachable/).run).toContain('classify-agent-result.mjs');
  });
});

describe('the prompt carries the rules that keep a resolution honest', () => {
  const wf = readFlattened(join(ROOT, '.github/workflows/agent-rebase.yml'));
  const prompt: string = effectiveSteps(wf.jobs.resolve.steps)
    .find((s: { uses?: string }) => (s.uses ?? '').startsWith('anthropics/claude-code-action'))!.with!.prompt as string;

  it('says merge, never rebase', () => {
    // A rebase force-pushes, which detaches the Reviewer's review from the commits it cites.
    expect(prompt).toMatch(/a MERGE,\s+never a rebase/);
  });

  it('forbids redeciding either side', () => {
    // The failure this mode is most likely to produce, and the one reviewers skim past
    // because the diff is a merge commit.
    expect(prompt).toMatch(/RESOLVE, DO NOT REDECIDE/);
    expect(prompt).toMatch(/keeps BOTH/);
  });

  it('carries the how-to for every file a script had to refuse', () => {
    // The inversion this design turns on: what a script must refuse, an agent is told
    // how to do. A path dropped from here silently becomes a guess.
    for (const f of ['_id-registry.json', '_locked-floor.json', 'CHANGELOG.md']) {
      expect(prompt).toContain(f);
    }
    // The project's own generated files (a lockfile, a migration sequence) are named by
    // the project, in its stack document (K-LAYOUT-17, kanon#36), not by Kanon.
    expect(prompt).toContain("every file the stack document's `## Generated files` section names");
    expect(prompt).toMatch(/spec-ids\.mjs"? --apply/);
    expect(prompt).toContain('--write-locked');
  });

  it('requires the gates to be run on the MERGED tree before pushing', () => {
    expect(prompt).toMatch(/VERIFY BEFORE YOU PUSH/);
    expect(prompt).toMatch(/not your side of it/);
    expect(prompt).toMatch(/every command the stack document's `## Gates` section lists/);
    expect(prompt).toMatch(/`## Schema changes`/);
    expect(prompt).toMatch(/`## Data isolation`/);
  });

  it('names the ONE thing that reaches the developer, and calls it the only one', () => {
    // The escalation boundary: a code question is the agent's, a product question is
    // the developer's. Anything wider re-creates the human bottleneck this replaces.
    expect(prompt).toMatch(/ONLY thing that reaches the developer/);
    expect(prompt).toMatch(/PRODUCT decision/);
    expect(prompt).toContain('needs:human');
    expect(prompt).toMatch(/do NOT guess/);
  });

  it('forbids pushing conflict markers or an unverified tree', () => {
    expect(prompt).toMatch(/[Nn]ever push a tree\s+with conflict markers/);
  });

  it('never merges the PR', () => {
    expect(prompt).toMatch(/NEVER: merge the PR/);
    expect(prompt).toMatch(/a human merges/);
  });
});

describe('which job of a run is this PR’s (RA-2519, plan 0001 step 5)', () => {
  // The retry reads one PR's matrix job by its NAME. Called from an adopter's caller, the
  // jobs API prefixes the caller's job id, so the bare name would match no Kanon run.
  it('reads the lane’s own name and the name a caller’s job prefixes', () => {
    expect(isResolveJob('resolve (55)', 55)).toBe(true);
    expect(isResolveJob('rebase / resolve (55)', 55)).toBe(true);
    // The agent's job, below the per-PR call since kanon#279, which holds the breadcrumbs.
    expect(isResolveJob('rebase / resolve (55) / resolve / resolve', 55)).toBe(true);
    expect(isResolveJob('rebase / resolve (55) / mint', 55)).toBe(true);
    expect(isResolveJob('rebase / resolve (155) / resolve / resolve', 55)).toBe(false);
  });
  it('never another PR’s job, nor another job', () => {
    expect(isResolveJob('rebase / resolve (155)', 55)).toBe(false);
    expect(isResolveJob('resolve (5)', 55)).toBe(false);
    expect(isResolveJob('rebase / filter', 55)).toBe(false);
    expect(isResolveJob('xresolve (55)', 55)).toBe(false);
  });
  it('is what the CLI reads each PR’s retry evidence with', () => {
    // The decision is pure and takes its reader as an argument, so only the CLI's wiring
    // says which predicate runs: a bare `name === …` there would pass every test above.
    expect(readFileSync(join(ROOT, 'scripts/rebase-lane.mjs'), 'utf8'))
      .toMatch(/evidenceOf: \(runId, pr\) => readRetry\(runId, \{ job: \(name\) => isResolveJob\(name, pr\.number\) \}\)/);
  });
  it('the lane’s matrix job is the one it names', () => {
    const wf = readFlattened(join(ROOT, '.github/workflows/agent-rebase.yml'));
    expect(wf.jobs.resolve.strategy.matrix.pr).toBeDefined();
    expect(wf.jobs.resolve.name).toBeUndefined();
  });
});

describe('the constants the workflow and the docs depend on', () => {
  it('asks for every field the decision reads', () => {
    for (const f of ['number', 'author', 'state', 'isDraft', 'labels', 'headRefOid', 'headRefName', 'mergeable', 'mergeStateStatus']) {
      expect(PR_FIELDS.split(',')).toContain(f);
    }
  });

  it('keeps the pipeline label set the one every other lane reads', () => {
    expect(PIPELINE_LABELS).toEqual(['agent:implement', 'agent:triage', 'review:please']);
  });

  it('reports no reason for an eligible PR', () => {
    expect(ineligible(pr())).toBeNull();
  });
});
