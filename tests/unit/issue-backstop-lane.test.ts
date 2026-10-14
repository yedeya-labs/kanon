import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { BUCKET_MILESTONES, DEFAULT_MILESTONE, GATE_CANDIDATE_LABEL, NEEDS_SEVERITY_LABEL, PIPELINE_MILESTONE } from '../../scripts/issue-triage-defaults.mjs';
import { liveOf, plannedWrites, run } from '../../scripts/issue-backstop.mjs';
import { realGroup } from './helpers/smoke-group.js';
import { writeStub } from './helpers/stub-bin.js';

/**
 * kanon#768: the issue-opened backstop (`K-WORK-1`), a Kanon lane at last. `decide()` in
 * `issue-triage-defaults.mjs` was moved from the reference adopter with its tests, but no lane
 * ran it. `scripts/issue-backstop.mjs` reads the live issue, asks `decide()`, and writes only
 * what is missing; `agent-issue-backstop.yml` runs it on `issues: opened`, as the Lead.
 */

const REPO = 'acme/widgets';
const reviewer = (...more: string[]) => ['follow-up', 'agent:reviewer', ...more];
const issue = (labels: string[], milestone = '') => ({ labels: labels.map((name) => ({ name })), milestone: milestone ? { title: milestone } : null });
const writesFor = (labels: string[], milestone = '') => plannedWrites(7, REPO, liveOf(issue(labels, milestone))).writes.map((w) => w.args);
const edit = (...rest: string[]) => ['issue', 'edit', '7', '--repo', REPO, ...rest];

describe('the writes the backstop makes (K-WORK-1, K-WORK-4, K-WORK-5, K-WORK-9, K-WORK-10)', () => {
  it('gives a bare issue the product bucket, and pipeline work the platform bucket', () => {
    expect(writesFor(['enhancement'])).toEqual([edit('--milestone', DEFAULT_MILESTONE)]);
    expect(writesFor([])).toEqual([edit('--milestone', DEFAULT_MILESTONE)]);
    expect(writesFor(['pipeline-improvement'])).toEqual([edit('--milestone', PIPELINE_MILESTONE)]);
  });

  it('never changes a milestone the issue has, a roadmap one included', () => {
    expect(writesFor(['enhancement'], 'Launch')).toEqual([]);
    expect(writesFor(['pipeline-improvement'], DEFAULT_MILESTONE)).toEqual([]);
  });

  it('writes only a bucket, whatever the labels', () => {
    for (const labels of [reviewer('sev:critical'), ['bug', 'agent:explorer', 'qa:needs-triage', 'sev:high'], ['pipeline-improvement', 'sev:low'], []]) {
      const milestones = writesFor(labels).filter((a) => a.includes('--milestone')).map((a) => a.at(-1));
      expect(milestones).toHaveLength(1);
      expect(BUCKET_MILESTONES).toContain(milestones[0]);
    }
  });

  it('adds gate-candidate to a gate-severity reviewer follow-up, which stays on its bucket', () => {
    expect(writesFor(reviewer('sev:high'))).toEqual([edit('--milestone', DEFAULT_MILESTONE), edit('--add-label', GATE_CANDIDATE_LABEL)]);
    expect(writesFor(reviewer('sev:critical'), DEFAULT_MILESTONE)).toEqual([edit('--add-label', GATE_CANDIDATE_LABEL)]);
    expect(writesFor(reviewer('sev:medium'))).toEqual([edit('--milestone', DEFAULT_MILESTONE)]);
  });

  it('flags a reviewer follow-up with no severity, with the label and the rubric comment', () => {
    const writes = writesFor(reviewer(), PIPELINE_MILESTONE);
    expect(writes[0]).toEqual(edit('--add-label', NEEDS_SEVERITY_LABEL));
    expect(writes[1]!.slice(0, 5)).toEqual(['issue', 'comment', '7', '--repo', REPO]);
    expect(writes[1]![6]).toContain('<!-- qa:needs-severity -->');
    // Signed as the Lead, whose token posts it (plan 0005 §3.3).
    expect(writes[1]![6]).toMatch(/^\*\*Lead\*\* <!-- kanon:role=lead -->/);
    expect(writes).toHaveLength(2);
  });

  it('writes nothing new on an issue it has already handled: a re-run is idempotent', () => {
    expect(writesFor(reviewer(NEEDS_SEVERITY_LABEL), DEFAULT_MILESTONE)).toEqual([]);
    expect(writesFor(reviewer('sev:high', GATE_CANDIDATE_LABEL), DEFAULT_MILESTONE)).toEqual([]);
  });
});

/** A fake `gh`: the issue it answers `issue view` with, and every call. */
const fakeGh = (state: ReturnType<typeof issue>, fail?: RegExp) => {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    if (fail?.test(args.join(' '))) throw new Error('HTTP 403: Resource not accessible by integration');
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify(state);
    return '';
  };
  return { gh, calls };
};

describe('run: read live, then write', () => {
  it('reads the issue itself, never a payload, and writes in order on apply', () => {
    const { gh, calls } = fakeGh(issue(reviewer('sev:high')));
    let summary = '';
    const r = run({ repo: REPO, number: 7, apply: true, gh, summary: (t) => { summary = t; } });
    expect(calls[0]).toEqual(['issue', 'view', '7', '--repo', REPO, '--json', 'milestone,labels,state']);
    expect(calls.slice(1)).toEqual([edit('--milestone', DEFAULT_MILESTONE), edit('--add-label', GATE_CANDIDATE_LABEL)]);
    expect(r.written).toHaveLength(2);
    expect(summary).toContain('wrote milestone "Product Backlog"');
  });

  it('writes nothing on a dry run, and says what it would write', () => {
    const { gh, calls } = fakeGh(issue(['bug']));
    let summary = '';
    run({ repo: REPO, number: 7, apply: false, gh, summary: (t) => { summary = t; } });
    expect(calls).toHaveLength(1);
    expect(summary).toContain('would write milestone "Product Backlog"');
  });

  it('says there is nothing to write on a placed issue, and logs the filer shadow', () => {
    const { gh, calls } = fakeGh(issue(['enhancement'], 'Launch'));
    const logged: string[] = [];
    let summary = '';
    run({ repo: REPO, number: 7, apply: true, gh, log: (l) => logged.push(l), summary: (t) => { summary = t; } });
    expect(calls).toHaveLength(1);
    expect(summary).toContain('Nothing to write.');
    expect(logged.join()).toContain('shadow (writes nothing)');
  });

  it('throws on a failed write, so the run goes red rather than leaving the issue bare in silence', () => {
    const { gh } = fakeGh(issue([]), /--milestone/);
    expect(() => run({ repo: REPO, number: 7, apply: true, gh })).toThrow(/403/);
  });
});

describe('the script, run as the lane runs it', () => {
  const runScript = (env: Record<string, string>, state = issue(['pipeline-improvement'])) => {
    const dir = mkdtempSync(join(tmpdir(), 'issue-backstop-'));
    const log = join(dir, 'calls');
    writeFileSync(join(dir, 'issue.json'), JSON.stringify(state));
    writeStub(join(dir, 'gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
if [ "$1 $2" = "issue view" ]; then cat "${join(dir, 'issue.json')}"; fi
if [ "$1 $2" = "label list" ]; then echo '[]'; fi
exit 0
`);
    const r = spawnSync(process.execPath, ['scripts/issue-backstop.mjs'], {
      encoding: 'utf8',
      env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: REPO, ...env },
    });
    let calls = '';
    try { calls = readFileSync(log, 'utf8'); } catch { /* no call */ }
    return { ...r, calls };
  };

  it('applies on APPLY=1: reads the issue, then sets the bucket', () => {
    const r = runScript({ ISSUE_NUMBER: '7', APPLY: '1' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.calls).toContain('issue view 7 --repo acme/widgets --json milestone,labels,state');
    expect(r.calls).toContain('issue edit 7 --repo acme/widgets --milestone Development Automation');
  });

  it('creates a label the repository lacks before adding it (K-WORK-12)', () => {
    const r = runScript({ ISSUE_NUMBER: '7', APPLY: '1' }, issue(reviewer('sev:high'), DEFAULT_MILESTONE));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const lines = r.calls.trim().split('\n');
    const create = lines.findIndex((l) => l.startsWith(`label create ${GATE_CANDIDATE_LABEL}`));
    const add = lines.findIndex((l) => l.includes(`--add-label ${GATE_CANDIDATE_LABEL}`));
    expect(create).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(create);
  });

  it('is a dry run without APPLY', () => {
    const r = runScript({ ISSUE_NUMBER: '7' });
    expect(r.status).toBe(0);
    expect(r.calls).not.toContain('issue edit');
    expect(r.stdout).toContain('dry run');
  });

  it('fails by name with no issue number', () => {
    const r = runScript({ ISSUE_NUMBER: '' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('needs an issue number in ISSUE_NUMBER');
    expect(r.calls).toBe('');
  });
});

// ── The lane ──────────────────────────────────────────────────────────────────────────────

type Step = { id?: string; name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, string> };
type Lane = {
  on: { workflow_call: { inputs: Record<string, { type: string; required?: boolean }>; secrets: Record<string, { required?: boolean }> } };
  concurrency: { group: string; 'cancel-in-progress': boolean };
  permissions: Record<string, string>;
  jobs: Record<string, { if?: string; permissions?: Record<string, string>; steps?: Step[] }>;
};
const LANE_TEXT = readFileSync('.github/workflows/agent-issue-backstop.yml', 'utf8');
const lane = parse(LANE_TEXT) as Lane;
const steps = lane.jobs.backstop!.steps!;
const apply = steps.find((s) => s.run === 'node "$KANON/scripts/issue-backstop.mjs"')!;

describe('agent-issue-backstop.yml', () => {
  it('runs one job, on an opened issue or a dispatch only', () => {
    expect(Object.keys(lane.jobs)).toEqual(['backstop']);
    expect(lane.jobs.backstop!.if).toBe("(github.event_name == 'issues' && github.event.action == 'opened') || github.event_name == 'workflow_dispatch'");
  });

  it('is the Lead\'s, runs no model, and checks out the App register alone, with no credential left behind', () => {
    expect(LANE_TEXT).toMatch(/^# KANON ROLE: Lead$/m);
    expect(steps.map((s) => s.uses).filter(Boolean)).toEqual(['$/actions/kanon-path', 'actions/checkout@v7', 'actions/create-github-app-token@v3']);
    const checkout = steps.find((s) => s.uses === 'actions/checkout@v7')!;
    expect(checkout.with).toEqual({ 'persist-credentials': false, 'sparse-checkout': 'docs/qa/agent-identities.md', 'sparse-checkout-cone-mode': false });
  });

  it('holds only contents: read on the workflow token, and narrows the App token to Issues write', () => {
    expect(lane.permissions).toEqual({ contents: 'read' });
    expect(lane.jobs.backstop!.permissions).toEqual({ contents: 'read' });
    const mint = steps.find((s) => s.id === 'app-token')!;
    expect(Object.keys(mint.with!).filter((k) => k.startsWith('permission-'))).toEqual(['permission-issues']);
    expect(mint.with!['permission-issues']).toBe('write');
  });

  it('writes with the App token, on the opened issue or the dispatched one, and applies on the opened event alone unless ticked', () => {
    expect(apply.env).toEqual({
      GH_TOKEN: '${{ steps.app-token.outputs.token }}',
      GITHUB_REPOSITORY: '${{ github.repository }}',
      ISSUE_NUMBER: '${{ github.event.issue.number || inputs.issue_number }}',
      APPLY: "${{ (github.event_name == 'issues' || inputs.apply == 'true') && '1' || '' }}",
    });
  });

  it('keeps one run per issue at a time, and never cancels one', () => {
    expect(realGroup(lane.concurrency.group)).toBe('agent-issue-backstop-${{ github.event.issue.number || inputs.issue_number }}');
    expect(lane.concurrency['cancel-in-progress']).toBe(false);
  });

  it('takes the Lead\'s two secrets and the dispatch inputs its caller passes, as strings', () => {
    expect(Object.keys(lane.on.workflow_call.secrets)).toEqual(['AUTHOR_APP_ID', 'AUTHOR_APP_PRIVATE_KEY']);
    for (const k of ['issue_number', 'apply']) expect(lane.on.workflow_call.inputs[k]).toMatchObject({ type: 'string', required: false });
  });
});
