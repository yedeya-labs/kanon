import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { laneBlockOf, readBlock, readSpine } from '../unit/helpers/spine.js';
import {
  CRASH_AUTHOR, CRASH_MARKER, MAX_CRASH_RETRIES, STOP_LABEL,
  agentSpokeSince, decide, plan, priorCrashes, projectOf, renderComment,
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
});

describe('the wiring', () => {
  const wf = parse(readFileSync(join(ROOT, '.github/workflows/agent-implement.yml'), 'utf8')) as {
    jobs: Record<string, { needs?: string; if?: string; permissions?: Record<string, string>; steps?: Array<{ run?: string; uses?: string; env?: Record<string, string> }> }>;
  };
  const job = wf.jobs['crash-recovery'];

  it('runs after a FAILED implement job, with the classifier verdict', () => {
    expect(job?.needs).toBe('implement');
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
    expect(mint?.with?.['app-id']).toBe('${{ secrets.IMPLEMENTER_APP_ID }}');
    expect(mint?.with?.['permission-issues']).toBe('write');
    expect(Object.keys(mint?.with ?? {}).filter((k) => k.startsWith('permission-'))).toEqual(['permission-issues']);
    expect(steps.indexOf(mint as never)).toBeLessThan(steps.indexOf(step!));
    // After the checkout, so the checkout never persists the App's token as git's credential.
    expect(steps.findIndex((s) => (s.uses ?? '').startsWith('actions/checkout'))).toBeLessThan(steps.indexOf(mint as never));
    expect(step?.env?.LABEL_TOKEN).toBe(`\${{ steps.${mint?.id}.outputs.token }}`);
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
