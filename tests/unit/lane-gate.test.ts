import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide, triggeringActor } from '../../scripts/lane-gate.mjs';
import { checkCallerPin, kanonRefsOf, localCallsOf, parseWorkflowRef } from '../../scripts/caller-pin.mjs';
import { runWorkflowStep, type WorkflowStep } from './helpers/workflow-step.js';
import { IMPLEMENTER_LOGIN } from './helpers/register.js';
import { type Workflow, read, LANES, TRIGGERS, gateOf, gateProblems, REPO, type Actor, pullsWith, eventsOf, runGate, MEMBER, STRANGER, caller, STACKED, REPOSITORY } from './helpers/lane-gate.js';
import { SPAWNS } from './helpers/spawns.js';

/**
 * kanon#46, `K-AGENT-45`: every lane starts real work only on a member's act, and checks it
 * before any App token is minted. Three halves:
 *
 *   1. every lane in Kanon carries the gate, first in its first job, and every later step
 *      and job waits for it (so a lane that moves later without it fails here);
 *   2. for each trigger of each lane, the lane's OWN gate step, executed, refuses a
 *      non-member and a bot outside the App register, and admits a member and a registered
 *      App, with the refusal visible in the step summary;
 *   3. the actor rules themselves, per event.
 *
 * Split by area across tests/unit/lane-gate*.test.ts (kanon#381), with the helpers they share in
 * tests/unit/helpers/lane-gate.ts. Half 2 is lane-gate-run.test.ts, and the same run from a
 * stacked base (kanon#69) is lane-gate-stacked.test.ts.
 */

describe('every lane carries the membership gate (K-AGENT-45)', () => {
  it('finds the lanes, and knows each one’s triggers', () => {
    expect(LANES.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(TRIGGERS).sort(), 'a lane added to Kanon needs its triggers listed here').toEqual(LANES);
  });

  it.each(LANES)('%s: the gate is first, and nothing runs past a refusal', (file) => {
    expect(gateProblems(read(file))).toEqual([]);
  });

  describe('the check fails a lane that lacks it, or lets something past it', () => {
    const lane = (file: string) => structuredClone(read(file));
    it('no gate step', () => {
      const wf = lane('agent-implement-revise.yml');
      wf.jobs.filter!.steps = wf.jobs.filter!.steps!.filter((s) => s.id !== 'gate');
      expect(gateProblems(wf)).toEqual(['no step with `id: gate`']);
    });
    it('a later step not gated', () => {
      const wf = lane('agent-lead-revise.yml');
      delete wf.jobs.filter!.steps!.find((s) => s.id === 'filter')!.if;
      expect(gateProblems(wf).join()).toContain('"Should this review be acted on?" runs whether or not');
    });
    it('a token minted before the gate', () => {
      const wf = lane('agent-merge-reconcile.yml');
      wf.jobs.filter!.steps!.unshift({ name: 'Mint', uses: 'actions/create-github-app-token@v3' });
      expect(gateProblems(wf)).toContain('something other than kanon-path runs before the gate');
    });
    it('an agent job that does not wait for the gate', () => {
      const wf = lane('agent-triage.yml');
      wf.jobs['triage-fix']!.if = "github.event.label.name == 'qa:needs-triage'";
      expect(gateProblems(wf)).toEqual(['job triage-fix can run without the gate admitting']);
    });
    it('a job that reads an empty, refused output as a value', () => {
      // The rebase lane's matrix job: `'' != '[]'` is true when the gate refused.
      const wf = lane('agent-rebase.yml');
      wf.jobs.resolve!.if = "needs.filter.outputs.prs != '[]'";
      expect(gateProblems(wf)).toEqual(['job resolve runs with no gate admitting, when filter success (member=false)']);
    });
    // kanon#238: GitHub's `==` is loose, so a refused gate's empty output equals `0`, `null`
    // and `false`, and a condition comparing one to them runs on a refused event.
    it.each(['0', 'null', 'false'])('a job that compares an empty, refused output to %s', (rhs) => {
      const wf = lane('agent-triage.yml');
      wf.jobs['triage-fix']!.if = `needs.filter.outputs.member == 'true' || needs.filter.outputs.count == ${rhs}`;
      expect(gateProblems(wf)).toEqual(['job triage-fix runs with no gate admitting, when filter success (member=false)']);
    });
    it('…but not one comparing it to a value an empty output never equals', () => {
      const wf = lane('agent-triage.yml');
      for (const rhs of ['1', 'true', "'0'"]) {
        wf.jobs['triage-fix']!.if = `needs.filter.outputs.member == 'true' || needs.filter.outputs.count == ${rhs}`;
        expect(gateProblems(wf), rhs).toEqual([]);
      }
    });
    /** The Merger lane with the `merge` job's own gate removed and its later steps ungated. */
    const mergeWithoutItsGate = () => {
      const wf = lane('agent-merge.yml');
      wf.jobs.merge!.steps = wf.jobs.merge!.steps!.filter((st) => st.id !== 'gate' && st.uses !== '$/actions/kanon-path');
      for (const st of wf.jobs.merge!.steps) if (st.if === "steps.gate.outputs.member == 'true'") delete st.if;
      return wf;
    };
    it('a job that can start with its gated job skipped, and holds no gate of its own', () => {
      // The Merger's sweep path: `merge` starts with `logins` skipped, so its own gate is the
      // only one that runs.
      const problems = gateProblems(mergeWithoutItsGate());
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^job merge runs with no gate admitting, when logins skipped; true: /);
    });
    // kanon#209: the verdict in one arm of an `||` is read, and is not required.
    it('a job whose if: ORs the verdict with a trigger, behind a status function', () => {
      const wf = mergeWithoutItsGate();
      wf.jobs.merge!.if = "!cancelled() && (needs.logins.outputs.member == 'true' || github.event_name == 'schedule')";
      expect(gateProblems(wf)).toEqual(["job merge runs with no gate admitting, when logins success (member=false); true: `github.event_name == 'schedule'`"]);
    });
    it('a job whose if: ORs the verdict with a trigger, with no status function', () => {
      const wf = lane('agent-triage.yml');
      wf.jobs['triage-fix']!.if = "needs.filter.outputs.member == 'true' || github.event_name == 'workflow_dispatch'";
      expect(gateProblems(wf)).toEqual(["job triage-fix runs with no gate admitting, when filter success (member=false); true: `github.event_name == 'workflow_dispatch'`"]);
    });
    it('…but not one that ANDs the verdict with a trigger', () => {
      const wf = lane('agent-triage.yml');
      wf.jobs['triage-fix']!.if = "needs.filter.outputs.member == 'true' && github.event_name == 'workflow_dispatch'";
      expect(gateProblems(wf)).toEqual([]);
      wf.jobs['triage-fix']!.if = "always() && (github.event_name == 'workflow_dispatch' && needs.filter.outputs.member == 'true')";
      expect(gateProblems(wf)).toEqual([]);
      wf.jobs['triage-fix']!.if = "!cancelled() && !(needs.filter.outputs.member != 'true')";
      expect(gateProblems(wf)).toEqual([]);
    });
    it('…nor one that GitHub’s implicit success() keeps from starting', () => {
      // No status function, so `implement` must have succeeded, which this `if:` then refuses.
      const wf = lane('agent-implement.yml');
      wf.jobs['crash-recovery']!.if = "needs.implement.result != 'success'";
      expect(gateProblems(wf)).toEqual([]);
    });
    it('a job that starts on the gate job’s own failure', () => {
      const wf = lane('agent-triage.yml');
      wf.jobs['triage-fix']!.if = "failure() || needs.filter.outputs.member == 'true'";
      expect(gateProblems(wf)).toEqual(['job triage-fix runs with no gate admitting, when filter failure']);
    });
    it('a job behind a held job that starts on its failure or skip anyway', () => {
      const wf = lane('agent-implement.yml');
      wf.jobs['crash-recovery']!.if = "always() && needs.implement.result != 'success'";
      // `empty-check` (kanon#181) is skipped too, behind the same held `implement`; the
      // witness names it, and the job that starts anyway is still the one caught.
      expect(gateProblems(wf)).toEqual(['job crash-recovery runs with no gate admitting, when implement skipped; empty-check skipped; filter success (member=false)']);
    });
    it('a condition it cannot read fails by name, never passes', () => {
      const wf = lane('agent-triage.yml');
      wf.jobs['triage-fix']!.if = "needs.filter.outputs.member == 'true' || hashFiles('x') != ''";
      expect(() => gateProblems(wf)).toThrow(/unmodelled function hashFiles/);
      // …including one that reads the event, which would otherwise be a free clause.
      wf.jobs['triage-fix']!.if = "needs.filter.outputs.member == 'true' && hashFiles(github.workspace) != ''";
      expect(() => gateProblems(wf)).toThrow(/unmodelled function hashFiles/);
    });
    it('a job that reads the verdict as anything but its admission', () => {
      // A gate's job that did not run, or failed, leaves `member` empty, not `false`.
      const wf = lane('agent-triage.yml');
      wf.jobs['triage-fix']!.if = "always() && needs.filter.outputs.member != 'false'";
      expect(gateProblems(wf)).toEqual(['job triage-fix runs with no gate admitting, when filter success']);
    });
    it('a job behind a job that runs ungated is not held by it', () => {
      const wf = lane('agent-implement.yml');
      wf.jobs.implement!.if = "needs.filter.outputs.member == 'true' || github.event_name == 'workflow_dispatch'";
      expect(gateProblems(wf)).toEqual([
        "job implement runs with no gate admitting, when filter success (member=false); true: `github.event_name == 'workflow_dispatch'`",
        // The taint reaches EVERY job downstream of the ungated one: `empty-check` (kanon#181)
        // directly, and `crash-recovery` through it as well as through `implement`.
        'job empty-check runs with no gate admitting, when implement success; filter success (member=false)',
        "job crash-recovery runs with no gate admitting, when implement success; empty-check success; filter failure; true: `needs.empty-check.outputs.empty == 'true'`",
      ]);
    });
    describe("the export's delete job runs past a refusal only while it is inert (plan 0004 §3.2)", () => {
      type W = { with?: Record<string, string>; run?: string };
      const del = (wf: Workflow) => wf.jobs['delete-export']!;
      it('a second step in it', () => {
        const wf = lane('agent-code-audit.yml');
        del(wf).steps!.push({ run: 'echo hi' } as WorkflowStep);
        expect(gateProblems(wf)).toEqual(['job delete-export can run without the gate admitting']);
      });
      it('an operation other than delete-export', () => {
        const wf = lane('agent-code-audit.yml');
        (del(wf).steps![0] as W).with!.operation = 'put';
        expect(gateProblems(wf)).toContain('job delete-export can run without the gate admitting');
      });
      it('an artifact id from a job it does not need', () => {
        const wf = lane('agent-code-audit.yml');
        del(wf).needs = ['audit'];
        expect(gateProblems(wf)).toContain('job delete-export can run without the gate admitting');
      });
      it('an artifact id that is not a gated job\'s output', () => {
        const wf = lane('agent-code-audit.yml');
        (del(wf).steps![0] as W).with!['artifact-id'] = '${{ github.event.inputs.id }}';
        expect(gateProblems(wf)).toContain('job delete-export can run without the gate admitting');
      });
    });
    it('a job reading a gated job it does not need', () => {
      const wf = lane('agent-implement.yml');
      wf.jobs.implement!.needs = [];
      expect(gateProblems(wf)).toContain('job implement can run without the gate admitting');
    });
  });
});

// Its cases run the gate step in `bash`, so the block takes the spawn budget (#436).
describe('the gate step’s failure paths', SPAWNS, () => {
  const file = 'agent-implement-revise.yml';
  it('fails the job, by name, when the permission lookup fails, rather than guessing', () => {
    const r = runGate(file, 'pr-label', MEMBER, { STUB_PERMISSION_FAILS: '1' });
    expect(r.status).toBe(1);
    expect(r.output).toContain("::error title=Membership gate::could not read a-member's permission");
    expect(r.outputs.member).toBeUndefined();
  });
  it('refuses a bot when the default branch has no App register', () => {
    const r = runGate(file, 'review', { login: `${IMPLEMENTER_LOGIN}[bot]` }, { STUB_REGISTER: '' });
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('false');
  });
  it('fails the job when the App register is malformed', () => {
    const r = runGate(file, 'review', { login: `${IMPLEMENTER_LOGIN}[bot]` }, { STUB_REGISTER: '# no table\n' });
    expect(r.status).toBe(1);
    expect(r.output).toContain('::error title=Membership gate::');
  });
  it('refuses, visibly, an event no lane acts on', () => {
    const wf = read(file);
    const { jobId, index } = gateOf(wf)!;
    const r = runWorkflowStep(wf.jobs[jobId]!.steps![index]!, {
      env: { KANON: process.cwd(), GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: '' },
    });
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('false');
    expect(r.summary).toContain('no lane acts on a push event');
  });
  it('admits a triager, who can apply a label, and does not read a public repository’s `read` as membership', () => {
    expect(runGate(file, 'pr-label', { login: 'a-triager' }).outputs.member).toBe('true');
    expect(runGate(file, 'pr-label', { login: 'a-stranger' }).outputs.member).toBe('false');
  });
});

// ── The actor rules ─────────────────────────────────────────────────────────────────────

describe('who the actor is', () => {
  const env = { GITHUB_ACTOR: 'the-actor', GITHUB_TRIGGERING_ACTOR: 'the-rerunner' };
  it('a review: the reviewer and their association, never the PR author or sender', () => {
    expect(triggeringActor('pull_request_review', {
      sender: { login: 'sender' }, review: { user: { login: 'reviewer' }, author_association: 'NONE' },
    }, env)).toEqual({ actor: { login: 'reviewer', association: 'NONE', source: 'reviewer' } });
  });
  it('a label: whoever applied it, with no association to trust', () => {
    expect(triggeringActor('issues', { action: 'labeled', sender: { login: 'labeller' } }, env))
      .toEqual({ actor: { login: 'labeller', source: 'user who applied the label' } });
  });
  it('a pull_request_target label or opening: the sender, as for pull_request', () => {
    expect(triggeringActor('pull_request_target', { action: 'labeled', sender: { login: 'labeller' } }, env))
      .toEqual({ actor: { login: 'labeller', source: 'user who applied the label' } });
    expect(triggeringActor('pull_request_target', { action: 'opened', sender: { login: 'opener' } }, env))
      .toEqual({ actor: { login: 'opener', source: 'user who opened it' } });
    expect(triggeringActor('issues', { action: 'opened', sender: { login: 'opener' } }, env)).toHaveProperty('refuse');
  });
  it('a finished workflow: whoever pushed the commit it ran on, never the sender', () => {
    expect(triggeringActor('workflow_run', { workflow_run: { triggering_actor: { login: 'pusher' }, actor: { login: 'a' } }, sender: { login: 's' } }, env))
      .toEqual({ actor: { login: 'pusher', source: 'user whose push the finished workflow ran on' } });
    expect(triggeringActor('workflow_run', { workflow_run: { actor: { login: 'a' } } }, env))
      .toEqual({ actor: { login: 'a', source: 'user whose push the finished workflow ran on' } });
  });
  it('a closed issue: whoever closed it, never anyone the payload names otherwise (plan 0004 step 8)', () => {
    expect(triggeringActor('issues', { action: 'closed', sender: { login: 'closer' }, pull_request: { merged_by: { login: 'not-on-an-issue' } } }, env))
      .toEqual({ actor: { login: 'closer', source: 'user who closed it' } });
    expect(triggeringActor('issues', { action: 'closed' }, env)).toHaveProperty('refuse');
    expect(triggeringActor('issues', { action: 'reopened', sender: { login: 'x' } }, env)).toHaveProperty('refuse');
  });
  it('a merge: whoever merged it', () => {
    expect(triggeringActor('pull_request', { action: 'closed', pull_request: { merged_by: { login: 'merger' } }, sender: { login: 'x' } }, env))
      .toEqual({ actor: { login: 'merger', source: 'user who merged it' } });
  });
  it('a dispatch: whoever ran it, re-runs included', () => {
    expect(triggeringActor('workflow_dispatch', {}, env)).toEqual({ actor: { login: 'the-rerunner', source: 'user who ran it' } });
    expect(triggeringActor('workflow_dispatch', {}, { GITHUB_ACTOR: 'the-actor' })).toEqual({ actor: { login: 'the-actor', source: 'user who ran it' } });
  });
  it('a schedule: the user GitHub runs it as, whoever last changed it', () => {
    expect(triggeringActor('schedule', { schedule: '50 5 * * *' }, env)).toEqual({ actor: { login: 'the-actor', source: 'user who last changed the schedule' } });
    expect(triggeringActor('schedule', {}, {})).toHaveProperty('refuse');
  });
  it('anything else is refused, as is an event with no actor', () => {
    for (const name of ['push', 'merge_group', 'workflow_run', 'issue_comment', '']) expect(triggeringActor(name, {}, env)).toHaveProperty('refuse');
    expect(triggeringActor('pull_request', { action: 'synchronize', sender: { login: 'a' } }, env)).toHaveProperty('refuse');
    expect(triggeringActor('pull_request_review', { review: {} }, env)).toHaveProperty('refuse');
  });
});

describe('what a member is', () => {
  const register = () => new Map([['Lead', 'example-author']]);
  const noLookup = () => {
    throw new Error('looked up a permission it did not need');
  };
  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])('association %s is a member', (association) => {
    expect(decide({ login: 'u', association, source: 'reviewer' }, { registeredApps: noLookup, permissionOf: noLookup }).member).toBe(true);
  });
  it.each(['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE', 'MANNEQUIN', ''])('association %s is not', (association) => {
    expect(decide({ login: 'u', association, source: 'reviewer' }, { registeredApps: noLookup, permissionOf: noLookup }).member).toBe(false);
  });
  it('a bot is judged by the register alone', () => {
    expect(decide({ login: 'example-author[bot]', association: 'NONE', source: 'reviewer' }, { registeredApps: register, permissionOf: noLookup }).member).toBe(true);
    expect(decide({ login: 'example-leader[bot]', association: 'MEMBER', source: 'reviewer' }, { registeredApps: register, permissionOf: noLookup }).member).toBe(false);
    // The slug, not the bare login: a user named like an App is not the App.
    expect(decide({ login: 'example-author', association: 'NONE', source: 'reviewer' }, { registeredApps: register, permissionOf: noLookup }).member).toBe(false);
  });
  it('a lookup admits triage or more, and nothing less', () => {
    const lookup = (permissions: Record<string, boolean>) => () => ({ permissions, role_name: 'custom' });
    for (const p of ['admin', 'maintain', 'push', 'triage']) {
      expect(decide({ login: 'u', source: 's' }, { registeredApps: noLookup, permissionOf: lookup({ [p]: true }) }).member).toBe(true);
    }
    expect(decide({ login: 'u', source: 's' }, { registeredApps: noLookup, permissionOf: lookup({ pull: true }) }).member).toBe(false);
    expect(decide({ login: 'u', source: 's' }, { registeredApps: noLookup, permissionOf: () => ({}) }).member).toBe(false);
  });
});

/**
 * kanon#81: on CI's completion the review lane judges whoever applied the review label, not
 * the pusher. A member labels a Dependabot PR while its CI runs; the lane defers to CI's
 * completion, whose pusher is `dependabot[bot]`, which is not the repository's App.
 */
// Its cases run the gate step in `bash`, so the block takes the spawn budget (#436).
describe('the review lane on CI completion judges the review label’s applier (kanon#81)', SPAWNS, () => {
  const DEPENDABOT: Actor = { login: 'dependabot[bot]' };
  const gate = (extra: Record<string, string>, pusher: Actor = DEPENDABOT) =>
    runGate('agent-review.yml', 'ci-finished', pusher, extra);

  it('reviews a Dependabot PR a member labelled before CI finished', () => {
    const r = gate({ STUB_EVENTS: eventsOf(['a-member', 'review:please']) });
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('true');
    expect(r.outputs.actor).toBe('a-member');
    expect(r.summary).toContain('applied the review label on #7');
  });

  it('refuses a PR whose review label a non-member applied, whoever pushed', () => {
    const r = gate({ STUB_EVENTS: eventsOf(['a-stranger', 'review:please']) }, MEMBER);
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('false');
    expect(r.summary).toContain('a-stranger');
  });

  it('judges the latest applier of a review label on the PR now, and no other label', () => {
    // A member re-applied it after a stranger; a stranger's later `sev:low` is not a review label;
    // and a label that was applied and then removed does not count.
    const r = gate({
      STUB_PULLS: pullsWith(['review:please', 'sev:low']),
      STUB_EVENTS: eventsOf(['a-stranger', 'review:please'], ['a-member', 'review:please'],
        ['a-stranger', 'sev:low'], ['a-stranger', 'agent:triage'], ['a-stranger', 'agent:triage', 'unlabeled']),
    });
    expect(r.outputs.member, r.output).toBe('true');
    expect(r.outputs.actor).toBe('a-member');
  });

  it('admits the Implementer App that opened its PR with `agent:implement`', () => {
    const r = gate({ STUB_PULLS: pullsWith(['agent:implement']),
      STUB_EVENTS: eventsOf([`${IMPLEMENTER_LOGIN}[bot]`, 'agent:implement']) });
    expect(r.outputs.member, r.output).toBe('true');
  });

  it('refuses, visibly, a PR with no review label, a closed PR and a commit no PR has', () => {
    const cases = [
      ['no label', pullsWith(['sev:low']), 'carries no review label'],
      ['closed', pullsWith(['review:please'], 'closed'), 'no open pull request'],
      ['no PR', '[]', 'no open pull request'],
    ] as const;
    for (const [name, pulls, why] of cases) {
      const r = gate({ STUB_PULLS: pulls, STUB_EVENTS: eventsOf(['a-member', 'review:please']) }, MEMBER);
      expect(r.status, `${name}: ${r.output}`).toBe(0);
      expect(r.outputs.member, name).toBe('false');
      expect(r.summary, name).toContain('Membership gate: refused.');
      expect(r.summary, name).toContain(why);
    }
  });

  it('fails the job by name when the read fails, rather than falling back to the pusher', () => {
    const r = gate({ STUB_PULLS_FAILS: '1' }, MEMBER);
    expect(r.status).toBe(1);
    expect(r.output).toContain('::error title=Membership gate::could not read who applied the review label');
    expect(r.outputs.member).toBeUndefined();
  });

  it('leaves the rebase lane judging the pusher of the default branch', () => {
    const r = runGate('agent-rebase.yml', 'ci-finished', MEMBER, { STUB_EVENTS: eventsOf(['a-stranger', 'review:please']) });
    expect(r.outputs.member, r.output).toBe('true');
    expect(r.outputs.actor).toBe('a-member');
  });
});

// Its cases run the pin check in `bash`, so the block takes the spawn budget (#436).
describe('the caller pin check (kanon#69)', SPAWNS, () => {
  const file = 'agent-review.yml';
  const gate = (extra: Record<string, string>, payload: object = REPOSITORY) => {
    const calls = join(mkdtempSync(join(tmpdir(), 'pin-calls-')), 'calls');
    writeFileSync(calls, '');
    const r = runGate(file, 'pr-target-label', MEMBER, { STUB_CALLS: calls, ...extra }, payload);
    return { ...r, calls: readFileSync(calls, 'utf8') };
  };

  it('reads the branch caller at the commit that ran, and the default branch by name', () => {
    const r = gate({ ...STACKED, STUB_CALLER_BRANCH: caller('v0.10.0'), STUB_CALLER_MAIN: caller('v0.10.0') });
    expect(r.calls).toContain(`contents/.github/workflows/review.yml?ref=${'f'.repeat(40)}`);
    expect(r.calls).toContain('contents/.github/workflows/review.yml?ref=main');
  });

  it('reads nothing on the default branch', () => {
    const r = gate({ GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/review.yml@refs/heads/main`, GITHUB_WORKFLOW_SHA: 'f'.repeat(40),
      STUB_CALLER_BRANCH: caller('v0.9.0'), STUB_CALLER_MAIN: caller('v0.10.0') });
    expect(r.outputs.member).toBe('true');
    expect(r.calls).toBe('');
  });

  // The Owner's decision on #112: a pull request never chooses the Kanon version that acts on it.
  const MERGE = { GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/review.yml@refs/pull/7/merge`, GITHUB_WORKFLOW_SHA: 'a'.repeat(40) };
  it('refuses a pull request’s merge ref whose caller changes the pin — a Dependabot bump', () => {
    const r = gate({ ...MERGE, STUB_CALLER_BRANCH: caller('v0.11.0'), STUB_CALLER_MAIN: caller('v0.10.0') });
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('false');
    expect(r.summary).toContain('Kanon pin: refused.');
    expect(r.summary).toContain('ran from `pull/7/merge`');
    expect(r.calls).toContain(`?ref=${'a'.repeat(40)}`);
  });
  it('admits a pull request’s merge ref whose caller keeps the pin', () => {
    const r = gate({ ...MERGE, STUB_CALLER_BRANCH: caller('v0.10.0'), STUB_CALLER_MAIN: caller('v0.10.0') });
    expect(r.outputs.member, r.output).toBe('true');
    expect(r.calls).toContain(`?ref=${'a'.repeat(40)}`);
  });

  it('refuses a caller the default branch does not have', () => {
    const r = gate({ ...STACKED, STUB_CALLER_BRANCH: caller('v0.10.0') });
    expect(r.outputs.member).toBe('false');
    expect(r.summary).toContain('has no such caller');
  });

  it('refuses a caller that calls a different lane at the same version', () => {
    const r = gate({ ...STACKED, STUB_CALLER_BRANCH: caller('v0.10.0', 'agent-triage.yml'), STUB_CALLER_MAIN: caller('v0.10.0') });
    expect(r.outputs.member).toBe('false');
  });

  it('checks a tag the same way: a dispatch with `--ref v1.2.0` runs that tag’s caller', () => {
    const tag = { GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/review.yml@refs/tags/v1.2.0`, GITHUB_WORKFLOW_SHA: 'f'.repeat(40) };
    const r = gate({ ...tag, STUB_CALLER_BRANCH: caller('v0.9.0'), STUB_CALLER_MAIN: caller('v0.10.0') });
    expect(r.outputs.member).toBe('false');
    expect(r.summary).toContain('ran from `v1.2.0`');
    expect(r.calls).toContain(`?ref=${'f'.repeat(40)}`);
    expect(gate({ ...tag, STUB_CALLER_BRANCH: caller('v0.10.0'), STUB_CALLER_MAIN: caller('v0.10.0') }).outputs.member).toBe('true');
  });

  it('refuses when the runner names no caller, rather than reading it as clear', () => {
    const r = gate({ GITHUB_WORKFLOW_REF: '' });
    expect(r.outputs.member).toBe('false');
    expect(r.summary).toContain('GITHUB_WORKFLOW_REF is not set');
  });

  it('refuses a caller of another repository', () => {
    const r = gate({ GITHUB_WORKFLOW_REF: 'yedeya-labs/kanon/.github/workflows/ci.yml@refs/pull/112/merge' });
    expect(r.outputs.member).toBe('false');
    expect(r.summary).toContain('is not a workflow of example-org/example-repo');
  });

  it('matches the Kanon owner and repository case-insensitively, as GitHub resolves them', () => {
    const sneaky = `${caller('v0.10.0')}  other:\n    uses: Yedeya-Labs/Kanon/.github/workflows/agent-triage.yml@v0.9.0\n`;
    const r = gate({ ...STACKED, STUB_CALLER_BRANCH: sneaky, STUB_CALLER_MAIN: caller('v0.10.0') });
    expect(r.outputs.member).toBe('false');
    expect(r.summary).toContain('agent-triage.yml@v0.9.0');
    const same = `${caller('v0.10.0')}`.replace('yedeya-labs/kanon', 'YEDEYA-LABS/kanon');
    expect(gate({ ...STACKED, STUB_CALLER_BRANCH: same, STUB_CALLER_MAIN: caller('v0.10.0') }).outputs.member).toBe('true');
  });

  it('refuses a caller that cannot be read at the commit that ran', () => {
    const r = gate({ ...STACKED, STUB_CALLER_MAIN: caller('v0.10.0') });
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('false');
    expect(r.summary).toContain('could not be found at `feature-a`');
  });

  it('refuses when the event names no default branch, rather than guessing', () => {
    const r = gate({ ...STACKED, STUB_CALLER_BRANCH: caller('v0.10.0'), STUB_CALLER_MAIN: caller('v0.10.0') }, { repository: {} });
    expect(r.outputs.member).toBe('false');
    expect(r.summary).toContain('no default branch');
  });

  it('fails the job by name when a read fails', () => {
    const r = gate({ ...STACKED, STUB_CALLER_FAILS: '1' });
    expect(r.status).toBe(1);
    expect(r.output).toContain('::error title=Membership gate::could not read the caller');
    expect(r.outputs.member).toBeUndefined();
  });

  it('never reads for a refused stranger', () => {
    const calls = join(mkdtempSync(join(tmpdir(), 'pin-calls-')), 'calls');
    writeFileSync(calls, '');
    const r = runGate(file, 'pr-target-label', STRANGER, { ...STACKED, STUB_CALLS: calls,
      STUB_CALLER_BRANCH: caller('v0.9.0'), STUB_CALLER_MAIN: caller('v0.10.0') }, REPOSITORY);
    expect(r.outputs.member).toBe('false');
    expect(r.summary).toContain('Membership gate: refused.');
    expect(readFileSync(calls, 'utf8')).toBe('');
  });

  it('follows a local wrapper to the pin it holds (kanon#118)', () => {
    const wrapper = 'name: Lanes\non: workflow_call\njobs:\n  review:\n    uses: ./.github/workflows/lanes.yml\n';
    const r = gate({ ...STACKED, STUB_CALLER_BRANCH: wrapper, STUB_CALLER_MAIN: wrapper,
      STUB_WRAPPER_BRANCH: caller('v0.9.0'), STUB_WRAPPER_MAIN: caller('v0.10.0') });
    expect(r.outputs.member).toBe('false');
    expect(r.summary).toContain('@v0.9.0');
    expect(r.calls).toContain(`contents/.github/workflows/lanes.yml?ref=${'f'.repeat(40)}`);
    expect(r.calls).toContain('contents/.github/workflows/lanes.yml?ref=main');
    const same = gate({ ...STACKED, STUB_CALLER_BRANCH: wrapper, STUB_CALLER_MAIN: wrapper,
      STUB_WRAPPER_BRANCH: caller('v0.10.0'), STUB_WRAPPER_MAIN: caller('v0.10.0') });
    expect(same.outputs.member).toBe('true');
  });

  it('refuses a caller whose pin it cannot find on either side, rather than reading no pins as equal (kanon#118)', () => {
    const remote = 'name: Lanes\non: [workflow_dispatch]\njobs:\n  review:\n    uses: some-org/shared/.github/workflows/lanes.yml@v1\n';
    const r = gate({ ...STACKED, STUB_CALLER_BRANCH: remote, STUB_CALLER_MAIN: remote });
    expect(r.outputs.member).toBe('false');
    expect(r.summary).toContain('no pin to compare');
  });

  describe('checkCallerPin through wrappers (kanon#118)', () => {
    const files = (tree: Record<string, Record<string, string>>) => (path: string, ref: string) => tree[ref]?.[path] ?? null;
    const run = { workflowRef: `${REPO}/.github/workflows/review.yml@refs/heads/feature-a`, workflowSha: 'sha', repo: REPO, defaultBranch: 'main' };
    const calls = (to: string) => `jobs:\n  a:\n    uses: ${to}\n`;
    const W = '.github/workflows/';

    it('follows `./` and `$/` calls to any depth, and compares every pin it reaches', () => {
      const side = (v: string) => ({
        [`${W}review.yml`]: calls(`./${W}lanes.yml`),
        [`${W}lanes.yml`]: `${calls(`$/${W}inner.yml`)}  b:\n    uses: ./${W}review.yml\n`,
        [`${W}inner.yml`]: caller(v),
      });
      expect(checkCallerPin(run, files({ sha: side('v0.10.0'), main: side('v0.10.0') })).ok).toBe(true);
      const differ = checkCallerPin(run, files({ sha: side('v0.9.0'), main: side('v0.10.0') }));
      expect(differ.ok).toBe(false);
      expect(differ.reason).toContain('@v0.9.0');
    });

    it('refuses by name a wrapper missing on either side', () => {
      const branch = { [`${W}review.yml`]: calls(`./${W}lanes.yml`), [`${W}lanes.yml`]: caller('v0.10.0') };
      const noWrapper = checkCallerPin(run, files({ sha: { [`${W}review.yml`]: calls(`./${W}lanes.yml`) }, main: branch }));
      expect(noWrapper).toEqual({ ok: false, reason: expect.stringContaining('`.github/workflows/lanes.yml`, which the caller') });
      const noDefault = checkCallerPin(run, files({ sha: branch, main: { [`${W}review.yml`]: calls(`./${W}lanes.yml`) } }));
      expect(noDefault).toEqual({ ok: false, reason: expect.stringContaining('the default branch `main` has no `.github/workflows/lanes.yml`') });
    });

    it('refuses when neither side holds a Kanon reference', () => {
      const none = { [`${W}review.yml`]: calls('some-org/shared/.github/workflows/lanes.yml@v1') };
      expect(checkCallerPin(run, files({ sha: none, main: none }))).toEqual({ ok: false, reason: expect.stringContaining('no pin to compare') });
    });

    it('reads only workflow calls of this repository as wrappers', () => {
      expect(localCallsOf([
        'jobs:',
        '  a:',
        `    uses: ./${W}lanes.yml`,
        `    uses: '$/${W}inner.yml' # quoted`,
        `    uses: ./${W}lanes.yml`,
        '    steps:',
        '      - uses: ./.github/actions/project-setup',
        `      # uses: ./${W}commented.yml`,
        `    uses: other/repo/${W}x.yml@v1`,
      ].join('\n'))).toEqual([`${W}inner.yml`, `${W}lanes.yml`]);
    });
  });

  it('reads every Kanon reference, and only real ones', () => {
    expect(kanonRefsOf([
      'jobs:',
      '  a:',
      '    uses: yedeya-labs/kanon/.github/workflows/agent-review.yml@v0.10.0',
      '  b:',
      "    uses: 'yedeya-labs/kanon/.github/workflows/agent-triage.yml@v0.10.0' # pinned",
      '    steps:',
      '      - uses: yedeya-labs/kanon/actions/lane-check@v0.10.0',
      '      # uses: yedeya-labs/kanon/actions/dco@v0.1.0',
      '      - uses: actions/checkout@v7',
      '    uses: yedeya-labs/kanon/.github/workflows/agent-review.yml@v0.10.0',
    ].join('\n'))).toEqual([
      'yedeya-labs/kanon/.github/workflows/agent-review.yml@v0.10.0',
      'yedeya-labs/kanon/.github/workflows/agent-triage.yml@v0.10.0',
      'yedeya-labs/kanon/actions/lane-check@v0.10.0',
    ]);
    expect(parseWorkflowRef(`${REPO}/.github/workflows/review.yml@refs/heads/a@b`, REPO))
      .toEqual({ path: '.github/workflows/review.yml', ref: 'refs/heads/a@b' });
    expect(parseWorkflowRef('other/repo/.github/workflows/review.yml@refs/heads/x', REPO)).toBeNull();
  });
});
