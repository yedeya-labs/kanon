import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { forkOf, main, noticeFor } from '../../scripts/fork-event.mjs';
import { evaluate } from './helpers/expression.js';
import { runWorkflowStep } from './helpers/workflow-step.js';

/**
 * kanon#1331: a fork's `pull_request` (and `pull_request_review`) event runs in the fork's
 * context, with no secrets. Merge reconcile and the Lead reconcile skip it after the membership
 * gate and before any App token is minted, with a notice naming how the merge is still
 * reconciled; a same-repository pull request goes on exactly as before.
 *
 * `scripts/fork-event.mjs` decides, and each lane's `fork` step runs it; the cases below run the
 * shipped step, then evaluate every later step's condition on each answer.
 */

const REPO = 'example-org/example-repo';
const WF = '.github/workflows';
type Step = { id?: string; name?: string; if?: string; run?: string; uses?: string };
type Job = { if?: string; needs?: string | string[]; outputs?: Record<string, string>; steps?: Step[] };
const read = (file: string) => parse(readFileSync(join(WF, file), 'utf8')) as { jobs: Record<string, Job> };
const prEvent = (head: string | null, number = 42) => ({ pull_request: { number, head: { repo: head === null ? null : { full_name: head } } } });

describe('forkOf: which pull request events are a fork\'s', () => {
  it('names the fork a pull_request or pull_request_review head is on', () => {
    expect(forkOf('pull_request', prEvent('someone/example-repo'), REPO)).toBe('someone/example-repo');
    expect(forkOf('pull_request_review', prEvent('someone/example-repo'), REPO)).toBe('someone/example-repo');
  });
  it('says a deleted fork when the head repository is gone', () => {
    expect(forkOf('pull_request', prEvent(null), REPO)).toBe('a deleted fork');
  });
  it('is null for a head on this repository, compared without case', () => {
    expect(forkOf('pull_request', prEvent(REPO), REPO)).toBeNull();
    expect(forkOf('pull_request', prEvent('Example-Org/Example-Repo'), REPO)).toBeNull();
    expect(forkOf('pull_request_review', prEvent(REPO), REPO)).toBeNull();
  });
  it('is null on every other event, whatever its payload', () => {
    for (const e of ['workflow_dispatch', 'schedule', 'issues', 'workflow_run', 'pull_request_target']) {
      expect(forkOf(e, prEvent('someone/example-repo'), REPO), e).toBeNull();
    }
    expect(forkOf('pull_request', {}, REPO)).toBeNull();
  });
});

describe('the notice names how the merge is still reconciled', () => {
  it('merge reconcile: a dispatch with pr_number from the default branch', () => {
    const n = noticeFor('merge-reconcile', { fork: 'someone/example-repo', number: 42, caller: 'merge-reconcile.yml' });
    expect(n).toContain('The head of #42 is on a fork, someone/example-repo');
    expect(n).toContain('no secrets');
    expect(n).toContain('before minting any App token');
    expect(n).toContain('dispatch merge reconcile from the default branch');
    expect(n).toContain('gh workflow run merge-reconcile.yml -f pr_number=42');
  });
  it('the Lead reconcile: the hourly schedule', () => {
    const n = noticeFor('lead-reconcile', { fork: 'a deleted fork', number: 42, caller: 'lead-reconcile.yml' });
    expect(n).toContain('The head of #42 is on a deleted fork');
    expect(n).toContain("hourly schedule picks the merge up from the default branch");
    expect(n).toContain('gh workflow run lead-reconcile.yml');
    expect(n).not.toContain('pr_number');
  });
});

describe('main', () => {
  const run = (eventName: string, event: unknown, argv = ['merge-reconcile']) => {
    const dir = mkdtempSync(join(tmpdir(), 'fork-event-'));
    const path = join(dir, 'event.json');
    writeFileSync(path, JSON.stringify(event));
    const out = join(dir, 'out');
    const sum = join(dir, 'sum');
    writeFileSync(out, '');
    writeFileSync(sum, '');
    const logs: string[] = [];
    const log = console.log;
    console.log = (l: string) => { logs.push(l); };
    let status: number;
    try {
      status = main({
        GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: path, GITHUB_REPOSITORY: REPO,
        GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/merge-reconcile.yml@refs/heads/main`,
        GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum,
      }, argv);
    } finally {
      console.log = log;
    }
    return { status, output: readFileSync(out, 'utf8'), summary: readFileSync(sum, 'utf8'), logs };
  };
  it('a fork: fork=true, a notice and a summary line', () => {
    const r = run('pull_request', prEvent('someone/example-repo'));
    expect(r.status).toBe(0);
    expect(r.output).toBe('fork=true\n');
    expect(r.logs.join('\n')).toMatch(/^::notice title=Fork pull request::The head of #42 is on a fork, someone\/example-repo.*gh workflow run merge-reconcile\.yml -f pr_number=42$/m);
    expect(r.summary).toMatch(/\*\*Skipped: a fork's pull request\*\*/);
  });
  it('this repository\'s pull request: fork=false, and nothing said', () => {
    const r = run('pull_request', prEvent(REPO));
    expect(r.status).toBe(0);
    expect(r.output).toBe('fork=false\n');
    expect(r.logs).toEqual([]);
    expect(r.summary).toBe('');
  });
  it('refuses an unknown lane', () => {
    expect(run('pull_request', prEvent(REPO), ['other']).status).toBe(2);
  });
});

/** Run a lane's shipped `fork` step on an event, and return what it said. */
const runForkStep = (step: Step, eventName: string, event: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'fork-step-'));
  const path = join(dir, 'event.json');
  writeFileSync(path, JSON.stringify(event));
  const r = runWorkflowStep(step, { dir, env: { PATH: process.env.PATH ?? '', KANON: process.cwd(), GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: path, GITHUB_REPOSITORY: REPO } });
  return /^fork=(\w+)$/m.exec(r.outputFile)?.[1] ?? null;
};

describe.each([
  ['agent-merge-reconcile.yml', 'filter'],
  ['agent-lead-reconcile.yml', 'tick'],
])('%s skips a fork\'s pull request before any mint', (file, jobId) => {
  const steps = read(file).jobs[jobId]!.steps!;
  const at = steps.findIndex((s) => s.id === 'fork');
  const fork = steps[at]!;

  it('runs the check right after the membership gate, once the gate admits', () => {
    expect(steps[at - 1]!.id).toBe('gate');
    expect(fork.if).toBe("steps.gate.outputs.member == 'true'");
    expect(fork.run).toBe(`node "$KANON/scripts/fork-event.mjs" ${file.replace(/^agent-|\.yml$/g, '')}`);
  });

  it('the shipped step says fork=true for a fork\'s head, and fork=false for this repository\'s', () => {
    expect(runForkStep(fork, 'pull_request', prEvent('someone/example-repo'))).toBe('true');
    expect(runForkStep(fork, 'pull_request', prEvent(REPO))).toBe('false');
  });

  // Every step after the check: what it decides on `fork=true` (nothing runs) and on `fork=false`
  // (each runs as it did before the check existed, with the check's condition taken out).
  const later = steps.slice(at + 1).filter((s) => s.if);
  const ctx = (said: string, outputs: Record<string, string> = {}) => ({
    github: { event_name: 'pull_request' },
    steps: {
      gate: { outputs: { member: 'true' } },
      fork: { outputs: { fork: said } },
      reask: { outputs: { due: '' } },
      scope: { outputs: { project: outputs.project ?? '' } },
      briefs: { outputs: { parked: outputs.parked ?? '' } },
      unreviewed: { outputs: { parked: outputs.parked ?? '' } },
    },
  });

  it('on fork=true, no later step runs, so no token is minted', () => {
    // A step that reads only earlier steps' outputs is skipped because those steps were: their
    // outputs are empty, which `ctx` gives them.
    for (const s of later) expect(evaluate(s.if!.replace(/^\$\{\{\s*!cancelled\(\)\s*&&\s*|\s*\}\}$/g, ''), ctx('true')), s.name).toBe(false);
  });

  it('on fork=false, every step gated on the gate runs as before', () => {
    const gated = later.filter((s) => s.if!.includes('steps.gate.outputs.member'));
    expect(gated.length).toBeGreaterThan(0);
    for (const s of gated) {
      expect(s.if, s.name).toContain("steps.fork.outputs.fork == 'false'");
      const before = s.if!.replace(" && steps.fork.outputs.fork == 'false'", '');
      for (const event of ['pull_request', 'workflow_run']) {
        const c = { ...ctx('false'), github: { event_name: event } };
        expect(evaluate(s.if!, c), `${s.name} on ${event}`).toBe(evaluate(before, c));
      }
    }
  });
});
