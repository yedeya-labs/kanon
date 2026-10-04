import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { laneBlockOf, readBlock, readSpine } from '../unit/helpers/spine.js';
import {
  CRASH_AUTHOR, CRASH_MARKER, EMPTY_KIND, MAX_CRASH_RETRIES, STOP_LABEL,
  agentSpokeSince, branchPattern, decide, emptyRun, plan, priorCrashes, projectOf, renderComment,
} from '../../scripts/implement-crash.mjs';
import { writeStub } from '../unit/helpers/stub-bin.js';
import { SPLIT_LABEL, splitMarker } from '../../scripts/split-lineage.mjs';
import { AGENT_LOGIN } from '../../scripts/dispatch-sweep.mjs';
import { ROOT } from './helpers/adopter.js';

/**
 * RA-2118 — a crashed implementer run must not hold a WIP slot for 48 hours.
 *
 * The three acceptance criteria that are branches of `decide`, each asserted both ways,
 * plus the wiring that makes the script run at all: a decision that nothing calls is
 * the "guard that cannot fail" this repo keeps finding.
 */

const IMPL = 'agent:implement';
// The RA-2118 shape: a project member, a run that reached the model and died, no comment,
// no PR, no earlier crash.
const crashed = { kind: 'failed', labels: [IMPL], project: 27, spoke: false, hasPr: false, crashes: 0 };

describe('decide — AC1: a crash that produced nothing is released for re-dispatch', () => {
  it('retries the measured RA-2072/RA-2077/RA-2079 shape', () => {
    expect(decide(crashed).act).toBe('retry');
  });

  it('retries when the classifier never ran (a timeout) — unknown is not a pass', () => {
    expect(decide({ ...crashed, kind: '' }).act).toBe('retry');
  });
});

describe('decide — AC2: a run that DID say something keeps its label', () => {
  it('a SCOPE-FIRST BAIL that then crashed is parked, not crashed', () => {
    expect(decide({ ...crashed, spoke: true })).toMatchObject({ act: 'none' });
  });

  it('a PR is work, whatever the run did after', () => {
    expect(decide({ ...crashed, hasPr: true }).act).toBe('none');
  });
});

describe('decide — AC3: the cap', () => {
  it(`hands the issue to a human after ${MAX_CRASH_RETRIES} retried crashes`, () => {
    expect(decide({ ...crashed, crashes: MAX_CRASH_RETRIES - 1 }).act).toBe('retry');
    const v = decide({ ...crashed, crashes: MAX_CRASH_RETRIES });
    expect(v.act).toBe('stop');
    expect(v.label).toBe(STOP_LABEL);
    expect(v.why).toMatch(/loop/);
  });

  it('the stop label is one `lead-reconcile` will NOT re-dispatch', () => {
    // `needs:human` is what the issue body proposed, and on a project member it is
    // re-dispatched on the next tick: the `eligible` filter excludes `qa:needs-info`
    // and not `needs:human`. Asserted against the filter's source, not restated.
    expect(STOP_LABEL).toBe('qa:needs-info');
    const src = readFileSync(join(ROOT, 'scripts/lead-reconcile.mjs'), 'utf8');
    expect(src).toMatch(/\.filter\(\(i\) => !i\.labels\.includes\(IMPLEMENT\) && !i\.labels\.includes\(NEEDS_INFO\)\)/);
  });
});

describe('decide — what it deliberately leaves alone', () => {
  it('an EXHAUSTED project member is routed to the split lane — a retry repeats the cap (RA-1781)', () => {
    const v = decide({ ...crashed, kind: 'exhausted' });
    expect(v.act).toBe('stop');
    expect(v.label).toBe(SPLIT_LABEL);
    expect(v.why).toMatch(/DECOMPOSING/);
  });

  it('an EXHAUSTED run that spoke early is still split — it ran out, it did not park (RA-1781)', () => {
    const v = decide({ ...crashed, kind: 'exhausted', spoke: true });
    expect(v).toMatchObject({ act: 'stop', label: SPLIT_LABEL });
    // …while a non-exhausted crash after a comment is still parked on what it said.
    expect(decide({ ...crashed, kind: 'failed', spoke: true }).act).toBe('none');
  });

  it('the split comment tells a human how to re-run instead — remove the split label first', () => {
    const body = renderComment({ act: 'stop', why: 'w', label: SPLIT_LABEL }, { runUrl: 'u', kind: 'exhausted' });
    expect(body).toContain(`remove \`${SPLIT_LABEL}\``);
  });

  it('an EXHAUSTED split child goes to a human — one split per lineage (RA-1781)', () => {
    const body = `work\n\n${splitMarker(1694)}\n\n<!-- qa:project 27 -->`;
    const v = decide({ ...crashed, kind: 'exhausted', body });
    expect(v.act).toBe('stop');
    expect(v.label).toBe(STOP_LABEL);
    expect(v.why).toMatch(/already a split of #1694/);
  });

  it('the split comment names the split lane, and the human one the human label', () => {
    expect(renderComment({ act: 'stop', why: 'w', label: SPLIT_LABEL }, { runUrl: 'u', kind: 'exhausted' })).toContain(`\`${SPLIT_LABEL}\`, so the Lead proposes a split`);
    expect(renderComment({ act: 'stop', why: 'w', label: STOP_LABEL }, { runUrl: 'u', kind: 'failed' })).toContain(`labelling \`${STOP_LABEL}\` for a human`);
  });

  it('a run that never reached the model is the sweep’s (RA-1517)', () => {
    expect(decide({ ...crashed, kind: 'unavailable' }).act).toBe('none');
    expect(decide({ ...crashed, kind: 'not-reached' }).act).toBe('none');
  });

  it('an issue no tick would re-dispatch keeps its label', () => {
    // Dropping `agent:implement` is only a retry because `lead-reconcile` re-dispatches
    // brief items. A hand-labelled issue would be stranded.
    expect(decide({ ...crashed, project: null }).act).toBe('none');
  });

  it('an issue already off the label holds no slot', () => {
    expect(decide({ ...crashed, labels: [] }).act).toBe('none');
  });
});

describe('the inputs', () => {
  it('projectOf reads membership by POSITION, as `declaresMembership` does (RA-1066)', () => {
    expect(projectOf('work\n\n<!-- qa:project 27 -->\n')).toBe(27);
    expect(projectOf('<!-- qa:project 27 -->\n\nappended below')).toBeNull();
    expect(projectOf('no marker')).toBeNull();
  });

  it('counts only markers this workflow wrote — a human quoting one is not a crash', () => {
    const c = [
      { login: CRASH_AUTHOR, body: `${CRASH_MARKER}\nx` },
      { login: `${CRASH_AUTHOR}[bot]`, body: `${CRASH_MARKER}\nx` },
      { login: 'a-human', body: `quoting ${CRASH_MARKER}` },
      { login: CRASH_AUTHOR, body: 'some other bot note' },
    ];
    expect(priorCrashes(c)).toBe(2);
  });

  it('agentSpokeSince counts only the implementer, only during this run', () => {
    const since = '2026-09-19T18:06:00Z';
    expect(agentSpokeSince([{ login: AGENT_LOGIN, createdAt: '2026-09-18T00:00:00Z' }], since), 'an older comment').toBe(false);
    expect(agentSpokeSince([{ login: 'example-reviewer', createdAt: '2026-09-19T19:00:00Z' }], since), 'another bot').toBe(false);
    expect(agentSpokeSince([{ login: `${AGENT_LOGIN}[bot]`, createdAt: '2026-09-19T19:00:00Z' }], since)).toBe(true);
    expect(agentSpokeSince([], null), 'no start time keeps the label').toBe(true);
  });

  it('the comment carries the marker, the run and the verdict', () => {
    const body = renderComment({ act: 'retry', why: 'because' }, { runUrl: 'https://x/runs/1', kind: 'failed' });
    expect(body.startsWith(CRASH_MARKER), 'the marker is what the count reads').toBe(true);
    expect(body).toContain('https://x/runs/1');
    expect(body).toContain('`failed`');
  });
});

describe('which token each edit rides (plan 0001 decision 21)', () => {
  const issue = '4242';
  it('an exhausted project member: the split label as the App, everything else as the workflow', () => {
    const calls = plan({ act: 'stop', label: SPLIT_LABEL }, issue, 'body');
    expect(calls.map((c) => [c.args.slice(0, 2).join(' '), c.args.includes('--add-label') ? 'add' : c.args.includes('--remove-label') ? 'remove' : 'comment', c.token])).toEqual([
      ['issue edit', 'add', 'app'],
      ['issue edit', 'remove', 'workflow'],
      ['issue comment', 'comment', 'workflow'],
    ]);
    expect(calls[0]!.args).toContain(SPLIT_LABEL);
  });
  it('a stop to a human, and a retry: nothing rides the App', () => {
    expect(plan({ act: 'stop', label: STOP_LABEL }, issue, 'b').map((c) => c.token)).toEqual(['workflow', 'workflow', 'workflow']);
    expect(plan({ act: 'retry' }, issue, 'b').map((c) => c.token)).toEqual(['workflow', 'workflow']);
    expect(plan({ act: 'none' }, issue, 'b')).toEqual([]);
  });

  // THE SCRIPT, RUN: a stub `gh` records the token of every call it receives.
  const run = (env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'implement-crash-'));
    const log = join(dir, 'calls');
    writeFileSync(log, '');
    const view = JSON.stringify({ state: 'OPEN', labels: [{ name: IMPL }], comments: [], body: 'work\n\n<!-- qa:project 27 -->' });
    writeStub(join(dir, 'gh'), [
      '#!/usr/bin/env bash',
      `printf '%s|%s\\n' "$GH_TOKEN" "$*" >> '${log}'`,
      'case "$1 $2" in',
      `  "api "*) echo '{"run_started_at":"2026-10-02T00:00:00Z"}' ;;`,
      `  "issue view") printf '%s' '${view}' ;;`,
      `  "pr list") echo '[]' ;;`,
      'esac',
      '',
    ].join('\n'));
    const r = spawnSync('node', [join(ROOT, 'scripts/implement-crash.mjs')], {
      encoding: 'utf8', timeout: 30_000,
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'example-org/example-repo',
        ISSUE: '4242', RUN_ID: '7', KIND: 'exhausted', APPLY: '1', GH_TOKEN: 'workflow-token', ...env,
      },
    });
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
      const [token, ...rest] = l.split('|');
      return { token, args: rest.join('|') };
    });
    return { status: r.status, out: r.stdout + r.stderr, calls };
  };

  it('labels with the App token, comments with the workflow token, and never dispatches', () => {
    const r = run({ LABEL_TOKEN: 'app-token' });
    expect(r.status, r.out).toBe(0);
    const writes = r.calls.filter((c) => /^issue (edit|comment)|^workflow/.test(c.args));
    expect(writes.map((c) => `${c.token} ${c.args.split(' --repo')[0]!.split(' --body')[0]}`)).toEqual([
      `app-token issue edit 4242 --add-label ${SPLIT_LABEL}`,
      `workflow-token issue edit 4242 --remove-label ${IMPL}`,
      'workflow-token issue comment 4242',
    ]);
    expect(r.calls.some((c) => /^workflow /.test(c.args))).toBe(false);
  });

  it('changes nothing, by name, when the App token is missing — never a label that starts nothing', () => {
    const r = run({ LABEL_TOKEN: '' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('LABEL_TOKEN');
    expect(r.calls.filter((c) => /^issue (edit|comment)|^workflow/.test(c.args))).toEqual([]);
  });

  // #78: a failed mint (the step is `continue-on-error`) hands the script an EMPTY token.
  // Only the split route needs the App, so a plain crash still frees the slot on the
  // workflow token — the retry a crashed run is owed whatever state the App is in.
  it('still frees the slot on the workflow token when the App token is missing and no split is due', () => {
    const r = run({ LABEL_TOKEN: '', KIND: 'crashed' });
    expect(r.status, r.out).toBe(0);
    const writes = r.calls.filter((c) => /^issue (edit|comment)|^workflow/.test(c.args));
    expect(writes.map((c) => `${c.token} ${c.args.split(' --repo')[0]!.split(' --body')[0]}`)).toEqual([
      'workflow-token issue comment 4242',
      `workflow-token issue edit 4242 --remove-label ${IMPL}`,
    ]);
  });
});

describe('the wiring', () => {
  const wf = parse(readFileSync(join(ROOT, '.github/workflows/agent-implement.yml'), 'utf8')) as {
    jobs: Record<string, { needs?: string; if?: string; permissions?: Record<string, string>; steps?: Array<{ run?: string; uses?: string; env?: Record<string, string> }> }>;
  };
  const job = wf.jobs['crash-recovery'];

  it('runs after a FAILED implement job, with the classifier verdict', () => {
    expect([job?.needs].flat()).toEqual(expect.arrayContaining(['implement']));
    expect(job?.if).toMatch(/failure\(\)/);
    const step = job?.steps?.find((s) => (s.run ?? '').includes('implement-crash.mjs'));
    expect(step, 'the script is actually run').toBeTruthy();
    // Kanon's copy, from the action cache at the tag the caller pinned (plan 0001 §3), after
    // the step that finds it — never the checkout's.
    expect(step?.run?.trim()).toBe('node "$KANON/scripts/implement-crash.mjs"');
    const steps = job?.steps ?? [];
    expect(steps.slice(0, steps.indexOf(step!)).some((s) => s.uses === '$/actions/kanon-path')).toBe(true);
    expect(step?.env?.KIND).toContain('needs.implement.outputs.kind');
    expect(step?.env?.GH_TOKEN, 'the default token — its comments read as a bot, never as the Implementer').toBe('${{ github.token }}');
    expect(job?.permissions?.issues).toBe('write');
    // Decision 21: the split lane is started by the Implementer's label, never by a
    // dispatch, so the default token needs no Actions write — only the run's start time.
    expect(job?.permissions?.actions).toBe('read');
    // The App token is minted in this job, narrowed to Issues write, and handed to the
    // script as LABEL_TOKEN — never as GH_TOKEN, which would put the comment on it.
    const mint = steps.find((s) => (s.uses ?? '').startsWith('actions/create-github-app-token')) as
      { id?: string; with?: Record<string, string> } | undefined;
    expect(mint?.with?.['client-id']).toBe('${{ secrets.IMPLEMENTER_APP_ID }}');
    expect(mint?.with?.['permission-issues']).toBe('write');
    expect(Object.keys(mint?.with ?? {}).filter((k) => k.startsWith('permission-'))).toEqual(['permission-issues']);
    expect(steps.indexOf(mint as never)).toBeLessThan(steps.indexOf(step!));
    // After the checkout, so the checkout never persists the App's token as git's credential.
    expect(steps.findIndex((s) => (s.uses ?? '').startsWith('actions/checkout'))).toBeLessThan(steps.indexOf(mint as never));
    expect(step?.env?.LABEL_TOKEN).toBe(`\${{ steps.${mint?.id}.outputs.token }}`);
    // #78: a failed mint must not stop the job before the script runs, or a misconfigured
    // App strands every crashed issue on its label. The script, not the mint, refuses the
    // split route by name; nothing after the mint may be gated on it succeeding.
    expect((mint as { 'continue-on-error'?: boolean })['continue-on-error']).toBe(true);
    expect((step as { if?: string }).if).toBeUndefined();
    const src = readFileSync(join(ROOT, 'scripts/implement-crash.mjs'), 'utf8');
    expect(src).not.toMatch(/'workflow', 'run'/);
    // `main` hands `decide` the BODY — without it every split child reads as a first
    // exhaustion and is split again, which is the recursion the lineage marker bounds.
    expect(src).toMatch(/crashes: priorCrashes\(comments\),\s*body: view\.body,/);
  });

  it('the spine exports the verdict the job branches on', () => {
    // Kanon's spine, from this tree.
    const lane = readSpine() as unknown as {
      on: { workflow_call: { outputs?: Record<string, { value: string }> } };
      jobs: { run: { outputs?: Record<string, string>; steps: Array<{ id?: string; run?: string }> } };
    };
    expect(lane.on.workflow_call.outputs?.kind?.value).toContain('jobs.run.outputs.kind');
    // THROUGH THE FINISH BLOCK (RA-2666): the job output reads the block call's output, and
    // the block's output reads its classify step — each hop followed, so an output wired
    // to the wrong step at either level is red here.
    const hop = /steps\.([\w-]+)\.outputs\.kind/.exec(String(lane.jobs.run.outputs?.kind))?.[1];
    const call = lane.jobs.run.steps.find((s) => s.id === hop) as { uses?: string } | undefined;
    const block = laneBlockOf(call);
    expect(block, 'the job output must read the finish block call').toBe('agent-finish');
    const def = readBlock(String(block));
    expect(def.outputs?.kind?.value).toContain('steps.classify.outputs.kind');
    // …AND ONE HOP FURTHER (RA-2691): that step is the call to `agent-classify`, whose `kind`
    // output reads the step that runs the classifier.
    const classify = def.runs.steps.find((s) => s.id === 'classify');
    expect(laneBlockOf(classify), 'the finish block classifies through agent-classify').toBe('agent-classify');
    const inner = readBlock('agent-classify');
    const innerHop = /steps\.([\w-]+)\.outputs\.kind/.exec(String(inner.outputs?.kind?.value))?.[1];
    expect(inner.runs.steps.find((s) => s.id === innerHop)?.run).toContain('classify-agent-result.mjs');
  });
});

/**
 * kanon#181 — an implementer run that ends `success` with no branch, PR or comment.
 *
 * The Owner's ruling (2026-10-04): red the run, comment as `github-actions`, and reuse the
 * crash retry above rather than a new sweep path. So the detection is asserted here, and
 * then the SAME recovery is asserted to take an empty run exactly as it takes a crash.
 */
describe('emptyRun — a green run that left nothing (kanon#181)', () => {
  const since = '2026-09-29T10:00:00Z';
  const during = '2026-09-29T11:30:00Z';
  const nothing = { issue: 181, branches: [] as { name: string; committedAt?: string }[], hasPr: false, spoke: false, since };

  it('no PR, no branch, no comment is empty', () => {
    expect(emptyRun(nothing).empty).toBe(true);
  });

  it('an open PR is output', () => {
    expect(emptyRun({ ...nothing, hasPr: true }).empty).toBe(false);
  });

  it('a GENUINE BAIL is not empty — the agent said why it stopped', () => {
    // Read through the same `agentSpokeSince` the script uses, from a real-shaped comment.
    const bail = { login: `${AGENT_LOGIN}[bot]`, createdAt: during, body: 'SCOPE-FIRST BAIL: this needs a data migration. Plan: …' };
    const spoke = agentSpokeSince([bail], since);
    expect(spoke).toBe(true);
    expect(emptyRun({ ...nothing, spoke })).toMatchObject({ empty: false, why: expect.stringMatching(/commented/) });
    // …while a comment from before the run, or from another bot, is not this run's.
    expect(emptyRun({ ...nothing, spoke: agentSpokeSince([{ ...bail, createdAt: '2026-09-28T00:00:00Z' }], since) }).empty).toBe(true);
    expect(emptyRun({ ...nothing, spoke: agentSpokeSince([{ ...bail, login: CRASH_AUTHOR }], since) }).empty).toBe(true);
  });

  it('a branch of the issue\'s shape pushed during the run is output', () => {
    expect(emptyRun({ ...nothing, branches: [{ name: 'feat/181-empty-runs', committedAt: during }] })).toMatchObject({ empty: false, why: expect.stringContaining('feat/181-empty-runs') });
  });

  it('a branch from an EARLIER run is not this run\'s output', () => {
    expect(emptyRun({ ...nothing, branches: [{ name: 'feat/181-empty-runs', committedAt: '2026-09-28T00:00:00Z' }] }).empty).toBe(true);
  });

  it('another issue\'s branch is not this one\'s — the number is delimited', () => {
    for (const name of ['feat/1810-other', 'feat/18-other', 'worktree-issue-181-x', 'Feat/181-x']) {
      expect(emptyRun({ ...nothing, branches: [{ name, committedAt: during }] }).empty, name).toBe(true);
    }
    expect(branchPattern(181).test('fix/181-x')).toBe(true);
  });

  it('every unknown reads as output, never as empty', () => {
    expect(emptyRun({ ...nothing, branches: [{ name: 'fix/181-x', committedAt: '' }] }).empty, 'an undated branch').toBe(false);
    expect(emptyRun({ ...nothing, branches: [{ name: 'fix/181-x' }] }).empty, 'a branch with no date at all').toBe(false);
    expect(emptyRun({ ...nothing, since: '' }).empty, 'no start time').toBe(false);
  });
});

describe('an empty run takes the crash path — retry, marker and cap (kanon#181)', () => {
  const empty = { ...crashed, kind: EMPTY_KIND };

  it('a project member is released for re-dispatch, as a crash is', () => {
    expect(decide(empty).act).toBe('retry');
    expect(plan(decide(empty), '181', 'b').map((c) => [c.args.slice(0, 2).join(' '), c.token])).toEqual([
      ['issue comment', 'workflow'],
      ['issue edit', 'workflow'],
    ]);
  });

  it('the cap is the crash cap, counted from the same markers', () => {
    expect(decide({ ...empty, crashes: MAX_CRASH_RETRIES })).toMatchObject({ act: 'stop', label: STOP_LABEL });
  });

  it('a non-member is left to the sweep, with no comment to mask its `answered` reading', () => {
    expect(decide({ ...empty, project: null }).act).toBe('none');
  });

  it('the comment says the run completed and left nothing — not that it crashed — and carries the marker', () => {
    const body = renderComment(decide(empty), { runUrl: 'https://x/runs/1', kind: EMPTY_KIND });
    expect(body.startsWith(CRASH_MARKER)).toBe(true);
    expect(body).toContain('completed but left no PR, no pushed branch and no comment');
    expect(body).not.toContain('crashed');
    expect(body).toContain('`empty`');
    const stop = renderComment({ act: 'stop', why: 'w', label: STOP_LABEL }, { runUrl: 'u', kind: EMPTY_KIND });
    expect(stop).toContain('left no PR, no pushed branch and no comment, and retrying will not help');
    // A crash still reads as a crash.
    expect(renderComment({ act: 'retry', why: 'w' }, { runUrl: 'u', kind: 'failed' })).toContain('crashed and produced nothing');
  });
});

describe('MODE=detect, run (kanon#181)', () => {
  const SINCE = '2026-10-02T00:00:00Z';
  const run = ({ comments = [] as unknown[], branches = [] as string[], dates = {} as Record<string, string>, prs = [] as unknown[], state = 'OPEN', mode = 'detect', kind = '' } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'implement-empty-'));
    const log = join(dir, 'calls');
    const out = join(dir, 'output');
    writeFileSync(log, '');
    writeFileSync(out, '');
    const view = JSON.stringify({ state, labels: [{ name: IMPL }], comments, body: 'work\n\n<!-- qa:project 27 -->' });
    const dateCases = Object.entries(dates).map(([b, d]) => `  *"commits/${encodeURIComponent(b)} "*) echo '${d}' ;;`);
    writeStub(join(dir, 'gh'), [
      '#!/usr/bin/env bash',
      `printf '%s|%s\\n' "$GH_TOKEN" "$*" >> '${log}'`,
      'case "$* " in',
      `  *"actions/runs/"*) echo '{"run_started_at":"${SINCE}"}' ;;`,
      `  *"/branches"*) printf '%s\\n' ${branches.map((b) => `'${b}'`).join(' ')} ;;`,
      ...dateCases,
      `  *"commits/"*) exit 1 ;;`,
      `  "issue view "*) printf '%s' '${view}' ;;`,
      `  "pr list "*) printf '%s' '${JSON.stringify(prs)}' ;;`,
      'esac',
      '',
    ].join('\n'));
    const r = spawnSync('node', [join(ROOT, 'scripts/implement-crash.mjs')], {
      encoding: 'utf8', timeout: 30_000,
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'example-org/example-repo',
        ISSUE: '181', RUN_ID: '7', MODE: mode, KIND: kind, APPLY: '1', GH_TOKEN: 'workflow-token', LABEL_TOKEN: 'app-token', GITHUB_OUTPUT: out,
      },
    });
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    return { status: r.status, out: r.stdout + r.stderr, output: readFileSync(out, 'utf8'), calls };
  };
  const writes = (calls: string[]) => calls.filter((c) => /\|issue (edit|comment)/.test(c));

  it('fails an empty run BY NAME, says so in its output, and changes nothing itself', () => {
    const r = run({ branches: ['main', 'feat/1810-other'] });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('::error title=implement run left nothing::#181');
    expect(r.output).toBe('empty=true\n');
    expect(writes(r.calls)).toEqual([]);
  });

  it('passes a run that left a genuine bail comment', () => {
    const r = run({ comments: [{ author: { login: `${AGENT_LOGIN}[bot]` }, createdAt: '2026-10-02T01:00:00Z', body: 'Stopping: the acceptance criteria are ambiguous about X.' }] });
    expect(r.status, r.out).toBe(0);
    expect(r.output).toBe('');
  });

  it('passes a run that pushed its branch, and dates only the candidates', () => {
    const r = run({ branches: ['main', 'feat/181-x'], dates: { 'feat/181-x': '2026-10-02T02:00:00Z' } });
    expect(r.status, r.out).toBe(0);
    expect(r.output).toBe('');
    expect(r.calls.filter((c) => c.includes('commits/')).map((c) => c.split('|')[1]!.split(' ')[1])).toEqual(['repos/example-org/example-repo/commits/feat%2F181-x']);
  });

  it('fails a run whose only branch predates it', () => {
    const r = run({ branches: ['feat/181-x'], dates: { 'feat/181-x': '2026-10-01T00:00:00Z' } });
    expect(r.status, r.out).toBe(1);
  });

  it('passes a run that opened a PR', () => {
    const r = run({ prs: [{ number: 9, headRefName: 'elsewhere', closingIssuesReferences: [{ number: 181 }] }] });
    expect(r.status, r.out).toBe(0);
  });

  it('leaves a closed issue alone', () => {
    expect(run({ state: 'CLOSED' }).status).toBe(0);
  });

  it('the recovery then retries it on the default token, as `github-actions` would comment', () => {
    const r = run({ mode: '', kind: EMPTY_KIND });
    // Without MODE the same stubbed issue is a crash-recovery run; with KIND=empty its
    // comment and label removal ride the workflow token and the App token is never used.
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('released for re-dispatch');
    // The body spans lines of the call log; the comment is the only write that carries one.
    expect(r.calls.join('\n')).toContain('completed but left no PR');
    const w = writes(r.calls);
    expect(w.map((c) => `${c.split('|')[0]} ${c.split('|')[1]!.split(' --')[0]}`)).toEqual([
      'workflow-token issue comment 181',
      'workflow-token issue edit 181',
    ]);
  });
});

describe('the empty-run wiring (kanon#181)', () => {
  type Step = { id?: string; run?: string; uses?: string; env?: Record<string, string> };
  type Job = { needs?: string | string[]; if?: string; outputs?: Record<string, string>; permissions?: Record<string, string>; steps?: Step[] };
  const wf = parse(readFileSync(join(ROOT, '.github/workflows/agent-implement.yml'), 'utf8')) as { jobs: Record<string, Job> };
  const check = wf.jobs['empty-check'];
  const recovery = wf.jobs['crash-recovery'];

  it('checks only a GREEN implement run, with Kanon\'s script in detect mode, on a read-only default token', () => {
    expect(check?.needs).toBe('implement');
    expect(check?.if).toBe("needs.implement.result == 'success'");
    const step = check?.steps?.find((s) => (s.run ?? '').includes('implement-crash.mjs'));
    expect(step?.run?.trim()).toBe('node "$KANON/scripts/implement-crash.mjs"');
    expect(step?.env?.MODE).toBe('detect');
    expect(step?.env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(check?.outputs?.empty).toBe(`\${{ steps.${step?.id}.outputs.empty }}`);
    expect(Object.values(check?.permissions ?? {}).every((p) => p === 'read'), 'it decides; it changes nothing').toBe(true);
    const steps = check?.steps ?? [];
    expect(steps.slice(0, steps.indexOf(step!)).some((s) => s.uses === '$/actions/kanon-path')).toBe(true);
  });

  it('the recovery runs on an empty run\'s OUTPUT, not on the check job merely failing', () => {
    expect([recovery?.needs].flat()).toEqual(['implement', 'empty-check']);
    expect(recovery?.if?.replace(/\s+/g, ' ')).toBe("failure() && (needs.implement.result == 'failure' || needs.empty-check.outputs.empty == 'true')");
    const step = recovery?.steps?.find((s) => (s.run ?? '').includes('implement-crash.mjs'));
    expect(step?.env?.KIND).toBe("${{ needs.empty-check.outputs.empty == 'true' && 'empty' || needs.implement.outputs.kind }}");
    expect(step?.env?.KIND).toContain(`'${EMPTY_KIND}'`);
  });
});
