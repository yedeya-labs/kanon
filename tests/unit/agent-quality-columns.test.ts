import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { readFiled, readVerdict, tallySeverities } from '../../scripts/agent-quality-columns.mjs';
import { readOpenedPrs } from '../../actions/agent-finish/agent-quality-prs.mjs';
import { blockOf, callsSpine, effectiveSteps, readBlock, readSpine } from './helpers/spine.js';
import { writeStub } from './helpers/stub-bin.js';
import { agentStep, telemetryStep, type WorkflowStep } from './helpers/workflow-step.js';

/**
 * RA-1504 — the quality half of the telemetry row.
 *
 * A cost alone cannot judge the changes it is collected for: dropping `--effort`, or
 * moving an arm to a cheaper model, reduces spend either way. Whether it SHOULD ship
 * depends on whether high-severity recall held — and a saving with a recall regression
 * looks like a win in every cost column.
 */

describe('the severity tally is defined in one place', () => {
  it('counts by band, in a fixed order', () => {
    expect(tallySeverities([['sev:high', 'follow-up'], ['sev:medium'], ['sev:high']]))
      .toBe('high:2,medium:1');
    expect(tallySeverities([['sev:low'], ['sev:critical']])).toBe('critical:1,low:1');
  });

  it('emits an empty string rather than a row of zeros', () => {
    // A tally of `critical:0,high:0,…` reads as a MEASURED absence. Empty is how the
    // emitter knows to leave the column unset, which is how the store records unknown.
    expect(tallySeverities([['follow-up'], []])).toBe('');
  });

  it('ignores labels that are not severities', () => {
    expect(tallySeverities([['sev:highish', 'severity:high', 'sev:']])).toBe('');
  });
});

describe('a failed read is absent, never zero', () => {
  // THE THREE-STATE DISCIPLINE RA-1485 APPLIES TO COST, APPLIED HERE. "No issues were
  // filed" and "we could not tell" are different facts; a row that conflates them
  // cannot be used to judge recall, which is the only reason these columns exist.
  const throws = () => { throw new Error('403'); };

  it('returns null when the verdict cannot be read', () => {
    expect(readVerdict({ pr: '1', head: 'abc', reviewer: 'x' }, throws)).toBeNull();
  });

  it('returns null when the issue search cannot be read', () => {
    expect(readFiled({ marker: 'Surfaced by PR #1' }, throws)).toBeNull();
  });

  it('asks for every state, so a closed artifact still counts', () => {
    // `gh issue list --search` folds `state:open` into the query unless told otherwise.
    // Measured 2026-09-05: `label:agent:explorer` returns 5 open and 61 across all
    // states, and PR RA-1596's marker returned [1597] where the truth is [1597, 1604].
    // A row re-derivable only until someone closes an issue is not durable — which is
    // the premise RA-1504 deferred this half of the row on.
    let argv: string[] = [];
    readFiled({ marker: 'x' }, (a: string[]) => { argv = a; return '[]'; });
    expect(argv).toContain('--state');
    expect(argv).toContain('all');
  });

  it('bounds the marker by this run, so a re-review does not inherit the last one', () => {
    let argv: string[] = [];
    readFiled({ marker: 'Surfaced by PR #1', since: '2026-09-05T00:00:00Z' }, (a: string[]) => { argv = a; return '[]'; });
    const q = argv[argv.indexOf('--search') + 1];
    expect(q).toContain('"Surfaced by PR #1" in:body');
    expect(q).toContain('created:>=2026-09-05T00:00:00Z');
  });

  it('distinguishes "read fine, found none" from "could not read"', () => {
    const empty = readFiled({ marker: 'x' }, () => '[]');
    expect(empty).toEqual({ count: 0, severities: '' });
    expect(readFiled({ marker: 'x' }, throws)).toBeNull();
  });

  it('reads the LAST matching verdict, so a re-review supersedes', () => {
    expect(readVerdict({ pr: '1', head: 'abc', reviewer: 'x' }, () => 'APPROVED\n')).toBe('APPROVED');
  });
});

describe('a PR-shaped arm counts the PR it opened (RA-1627)', () => {
  const SINCE = '2026-09-22T13:00:00Z';
  const pr = (n: number, created: string, labels: string[], body: string) =>
    ({ number: n, created_at: created, labels: labels.map((name) => ({ name })), body });
  const list = (...prs: unknown[]) => () => JSON.stringify(prs);
  const opts = { label: 'agent:triage', since: SINCE, issue: '2258' };

  it('counts this run\'s own PR: labelled, opened after the agent started, naming its issue', () => {
    expect(readOpenedPrs(opts, list(pr(2260, '2026-09-22T13:18:23Z', ['agent:triage'], 'Closes #2258.'))))
      .toEqual({ count: 1 });
  });

  it('records a bail as a measured 0, not absent', () => {
    // Scope-first, `qa:cannot-reproduce` and `qa:false-positive` all open no PR. That is
    // an outcome the column exists to make visible — absent is reserved for a failed read.
    expect(readOpenedPrs(opts, list())).toEqual({ count: 0 });
  });

  it('does not count a CONCURRENT run\'s PR, which a time window alone would', () => {
    // RA-1389/RA-1390 were opened 80s apart by two overlapping triage runs.
    const other = pr(2261, '2026-09-22T13:19:43Z', ['agent:triage'], 'Closes #2259, see also #22580.');
    expect(readOpenedPrs(opts, list(other))).toEqual({ count: 0 });
  });

  it('does not count an earlier PR, or one another arm labelled', () => {
    expect(readOpenedPrs(opts, list(
      pr(2200, '2026-09-22T12:59:59Z', ['agent:triage'], 'Closes #2258.'),
      pr(2262, '2026-09-22T13:30:00Z', ['agent:implement'], 'Closes #2258.'),
    ))).toEqual({ count: 0 });
  });

  it('reads the pulls LIST, never the search API, which lags the PR it is here to count', () => {
    let argv: string[] = [];
    readOpenedPrs(opts, (a) => { argv = a; return '[]'; });
    expect(argv[0]).toBe('api');
    expect(argv[1]).toMatch(/\/pulls\?state=all&sort=created&direction=desc/);
    expect(argv.join(' ')).not.toMatch(/search/);
  });

  it('is absent, never 0, when the read fails or the scope is unknown', () => {
    expect(readOpenedPrs(opts, () => { throw new Error('401'); })).toBeNull();
    expect(readOpenedPrs(opts, () => '{"message":"Bad credentials"}')).toBeNull();
    expect(readOpenedPrs({ ...opts, issue: '' }, list())).toBeNull();
    expect(readOpenedPrs({ ...opts, since: '' }, list())).toBeNull();
  });
});

describe('every filing arm is wired, and cannot red its own run', () => {
  // The smokes run the blocks on fixtures and file nothing, so they are not filing arms.
  const files = readdirSync('.github/workflows').filter((f) => f.endsWith('.yml') && !f.endsWith('-smoke.yml'));
  // Each job's steps as the job RUNS them — through the spine's blocks (RA-2666), where the
  // quality and telemetry steps now live — or the spine would drop out of `wired` and
  // every per-file check below would skip it without a word.
  const jobsOf = (f: string) =>
    Object.entries<{ steps?: WorkflowStep[]; uses?: string }>(parse(readFileSync(join('.github/workflows', f), 'utf8'))?.jobs ?? {})
      .map(([job, def]) => [job, { ...def, steps: def?.steps && effectiveSteps(def.steps) }] as [string, { steps?: WorkflowStep[] }]);

  const wired = files.flatMap((f) =>
    jobsOf(f).filter(([, def]) => (def?.steps ?? []).some((s) => s.id === 'quality')).map(([job]) => `${f}:${job}`));

  it('finds the wired arms, so the assertions below are not vacuous', () => {
    expect(wired.length).toBeGreaterThanOrEqual(3);
  });

  it('wires the triage arm through the spine, with a PR count and no severities (RA-1627)', () => {
    // The triage/fix agent files no ISSUE — its artifact is a PR labelled `agent:triage`.
    // So it opts into the spine's PR-shaped quality step rather than the issue query,
    // which read a hard 0 forever: the not-observable case wearing a measured value.
    const lane = parse(readFileSync('.github/workflows/agent-triage.yml', 'utf8')).jobs['triage-fix'] as { uses?: string; with: Record<string, unknown> };
    expect(lane.uses).toBe('$/.github/workflows/agent-lane.yml');
    expect(lane.with['quality-pr-label']).toBe('agent:triage');
    // A dispatched run must be scoped too, or its column is always unset.
    expect(String(lane.with?.['issue-number'])).toContain('inputs.issue_number');

    const spine = readSpine();
    // Through the blocks (RA-2666): the quality step and the telemetry step sit in the
    // `agent-finish` block, the start stamp in `agent-run`.
    const steps: WorkflowStep[] = effectiveSteps(spine.jobs.run.steps);
    const q = steps.find((s) => s.id === 'quality') as WorkflowStep & { if?: string; run?: string; env?: Record<string, string> };
    expect(q, 'the spine has no quality step').toBeTruthy();
    // OPT-IN: a lane that does not set the input gains no column — the block's input,
    // which the spine hands straight through from its own.
    expect(String(q.if)).toContain("inputs.quality-pr-label != ''");
    expect(blockOf(q)?.call.with?.['quality-pr-label']).toBe('${{ inputs.quality-pr-label }}');
    expect(String(q.run)).toContain('agent-quality-prs.mjs');
    const t = telemetryStep(steps);
    expect(String(t?.with?.artifacts_filed)).toContain('steps.quality.outputs');
    // …and `steps.quality` means THIS step: a step output is visible only inside the
    // block that ran it, so the two must share one.
    expect(blockOf(t!)?.call, 'the telemetry step reads a quality step in another block').toBe(blockOf(q)?.call);
    // `severities` stays empty on this arm: a fix PR carries no `sev:*`. The finish block
    // forwards its empty default (RA-2608), and the telemetry action omits an empty column.
    expect(t?.with?.severities).toBe('');
    // The window's lower bound is stamped BEFORE the agent runs.
    const started = steps.findIndex((s) => s.id === 'started');
    expect(started).toBeGreaterThanOrEqual(0);
    expect(started).toBeLessThan(steps.findIndex((s) => /claude-code-action/.test(String(s.uses))));
    // …and it reaches the quality step across the block boundary: the run block exports
    // it, and the finish call hands that export in as the window's lower bound.
    const runCall = blockOf(steps[started]!)!.call;
    expect(readBlock('agent-run').outputs?.['started-at']?.value).toBe('${{ steps.started.outputs.at }}');
    expect(q.env?.SINCE).toBe(`\${{ steps.${runCall.id}.outputs.started-at }}`);
  });

  it('scopes a dispatched implement run by its dispatch input (RA-2306)', () => {
    // The same gap RA-2291 closed for triage: a `workflow_dispatch` payload has no
    // `event.issue`, so the event's number alone left a dispatched run's row unscoped.
    // The caller passes its dispatch input through (docs/lanes.md), and the lane scopes by it.
    const wf = parse(readFileSync('.github/workflows/agent-implement.yml', 'utf8'));
    expect(Object.keys(wf.on.workflow_call.inputs)).toContain('issue_number');
    const lane = wf.jobs.implement;
    expect(callsSpine(lane)).toBe(true);
    expect(String(lane.with?.['issue-number'])).toContain('github.event.issue.number');
    expect(String(lane.with?.['issue-number'])).toContain('inputs.issue_number');
  });

  it('leaves every other spine caller unopted', () => {
    // the Implementer also opens the implementer's PRs; they are `agent:implement`, and that lane
    // has no measured question here. Opting in is a decision, not a default.
    const optedIn = files.flatMap((f) => jobsOf(f)
      // A literal label is an opt-in; the spine's own call to its agent job (kanon#274) only
      // passes the caller's input through, and opts nothing in.
      .filter(([, d]) => { const v = (d as { with?: Record<string, unknown> })?.with?.['quality-pr-label']; return v && v !== '${{ inputs.quality-pr-label }}'; })
      .map(([job]) => `${f}:${job}`));
    expect(optedIn).toEqual(['agent-triage.yml:triage-fix']);
  });

  it.each(files)('%s: any quality step runs BEFORE telemetry and swallows its own failure', (file) => {
    for (const [job, def] of jobsOf(file)) {
      const steps = def?.steps ?? [];
      const qi = steps.findIndex((s) => s.id === 'quality');
      if (qi < 0) continue;
      const ti = steps.findIndex((s) => String(s.uses ?? '').includes('actions/agent-telemetry'));
      // Ordering is load-bearing: outputs read by a step that ran earlier are empty.
      expect(ti, `${file}:${job} has a quality step but no telemetry step`).toBeGreaterThanOrEqual(0);
      expect(qi, `${file}:${job} reads quality AFTER telemetry`).toBeLessThan(ti);
      // An observer must never red a good agent run — docs/observability.md §8.
      expect((steps[qi] as { 'continue-on-error'?: boolean })['continue-on-error'],
        `${file}:${job}'s quality step can red its caller`).toBe(true);
      // And the telemetry step must actually consume it, or the wiring is decorative.
      // THROUGH THE FINISH CALL when the quality step is the job's own and the telemetry
      // step is inside `agent-finish` (RA-2608, the reviewer): `steps.quality` inside the
      // block names the BLOCK's quality step, so only the call's `artifacts-filed` can
      // carry the job's — and reading the block's own expression would pass on a lane
      // that never hands its count in.
      const tCall = blockOf(steps[ti]!)?.call;
      const viaCall = tCall !== undefined && blockOf(steps[qi]!)?.call !== tCall;
      const consumed = viaCall ? tCall.with?.['artifacts-filed'] : steps[ti]!.with?.artifacts_filed;
      expect(String(consumed ?? ''),
        `${file}:${job} does not pass artifacts_filed`).toContain('steps.quality.outputs');
    }
  });

  it('gives every wired job the scopes those gh reads need', () => {
    // `gh` prints a 403 body to STDOUT, so a missing scope reads as an empty result
    // rather than an error — five occurrences of that shape in this repo. The
    // permissions guard enforces this in lint; this states the property it enforces.
    for (const entry of wired) {
      const [file, job] = entry.split(':');
      const doc = parse(readFileSync(join('.github/workflows', file!), 'utf8'));
      const def = doc.jobs[job!];
      // EXCEPT a step that reads with the App token (RA-1627): the spine cannot hold a
      // default-token grant its callers do not all give, and the permissions guard skips
      // App-token steps for the same reason. Asserted, so the exemption cannot widen: it
      // is the `agent-finish` block's quality step, handed the job's minted token — the
      // spine's, or a lane's that calls the block itself (RA-2669) — and nothing else.
      const q = effectiveSteps(def.steps as WorkflowStep[]).find((s) => s.id === 'quality') as WorkflowStep & { env?: Record<string, string> };
      if (/steps\.app-token\.outputs\.token/.test(String(q?.env?.GH_TOKEN ?? ''))) {
        expect(blockOf(q)?.block, `${entry} reads with an App token outside the finish block`).toBe('agent-finish');
        expect(blockOf(q)?.call.with?.['github-token']).toBe('${{ steps.app-token.outputs.token }}');
        continue;
      }
      const perms = def.permissions ?? doc.permissions ?? {};
      expect(perms.issues, `${entry} cannot read the issues it filed`).toBe('read');
    }
  });

  it('carries the reviewer\'s own columns to its row through the finish block (RA-2608)', () => {
    // The reviewer derives its verdict, filed count and severities in a step of its OWN
    // (RA-1504), and records the row through `agent-finish`. Inside the block `steps.quality`
    // names the block's quality step, so the call must hand all three in, and the block
    // must forward each to the telemetry action — or the row loses a column silently.
    const job = parse(readFileSync('.github/workflows/agent-review.yml', 'utf8')).jobs.review;
    const steps = effectiveSteps(job.steps);
    const own = (job.steps as WorkflowStep[]).find((s) => s.id === 'quality');
    expect(own, 'the reviewer\'s own quality step').toBeTruthy();
    const t = telemetryStep(steps)!;
    const call = blockOf(t)?.call;
    expect(call && blockOf(t)?.block, 'the row is recorded by the finish block').toBe('agent-finish');
    expect(t.with?.agent).toBe('reviewer');
    expect(t.with?.outcome_label).toBe('${{ steps.quality.outputs.outcome_label }}');
    expect(t.with?.severities).toBe('${{ steps.quality.outputs.severities }}');
    expect(call?.with?.['artifacts-filed']).toBe('${{ steps.quality.outputs.artifacts_filed }}');
    // Not a whole-value substitution — the block prefers its own opt-in count — so the
    // forward is asserted on the expression itself.
    expect(String(t.with?.artifacts_filed)).toContain('inputs.artifacts-filed');
    expect(call?.with?.['quality-pr-label'], 'the block\'s own count stays off').toBeUndefined();
  });

  it('leaves every agent arm still measured', () => {
    // Moving the telemetry step to sit after the verdict must not drop it anywhere.
    for (const file of files) {
      for (const [job, def] of jobsOf(file)) {
        if (!agentStep(def?.steps)) continue;
        expect(telemetryStep(def?.steps), `${file}:${job} lost its telemetry step`).toBeTruthy();
      }
    }
  });
});

describe('--no-filed suppresses both filed columns through the real CLI (RA-1631)', () => {
  // The review lane re-invokes the script with `--no-filed` when it cannot read its own
  // run's start time. The flag reaches the `args.no_filed ? null : readFiled(...)` branch
  // only through the script's private argv parser. If that branch ever stops seeing the
  // flag, `readFiled` runs with `since: undefined` — the unbounded, PR-cumulative count —
  // and the row gets a plausible, larger integer instead of an unset column. So this
  // drives the script as the lane does: a subprocess, a stubbed `gh`, `GITHUB_OUTPUT`.
  const runCli = (extra: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'quality-cols-'));
    const log = join(dir, 'gh.log');
    const output = join(dir, 'out');
    writeFileSync(output, '');
    writeStub(join(dir, 'gh'), [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$*" >> '${log}'`,
      'case "$1" in',
      '  api) echo APPROVED ;;',
      `  issue) echo '[{"number":7,"labels":[{"name":"sev:high"}]}]' ;;`,
      'esac',
      '',
    ].join('\n'));
    execFileSync(process.execPath, ['scripts/agent-quality-columns.mjs',
      '--pr', '5', '--head', 'abc', '--reviewer', 'kanon-reviewer', ...extra], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, REPO: 'o/r', GITHUB_OUTPUT: output },
    });
    return {
      out: readFileSync(output, 'utf8'),
      calls: existsSync(log) ? readFileSync(log, 'utf8') : '',
    };
  };

  it('counts the filed columns without the flag, so the stub is live', () => {
    const { out, calls } = runCli([]);
    expect(out).toContain('outcome_label=APPROVED');
    expect(out).toContain('artifacts_filed=1');
    expect(out).toContain('severities=high:1');
    expect(calls).toMatch(/^issue list /m);
  });

  it.each([
    ['last', ['--no-filed']],
    ['before another flag', ['--no-filed', '--marker', 'x']],
  ])('with --no-filed %s it emits the verdict and neither filed column, and never searches', (_, extra) => {
    const { out, calls } = runCli(extra);
    expect(out).toContain('outcome_label=APPROVED');
    expect(out).not.toMatch(/^artifacts_filed=/m);
    expect(out).not.toMatch(/^severities=/m);
    expect(calls).not.toMatch(/^issue /m);
  });
});
