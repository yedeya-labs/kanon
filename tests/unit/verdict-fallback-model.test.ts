import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { calledFiles } from './helpers/called-workflow.js';

/**
 * `K-AGENT-38` and `K-OBS-15`: a run that produces a verdict (review, audit, oversight) has no
 * fallback model, because a fallback silently changes who judged (ADR 0004 §6).
 *
 * THE NO-FALLBACK LIST. Each lane below produces a verdict: the Reviewer's review, the Overseer's
 * oversight, and the Explorer's four audits (the code audit, the telemetry read, the runtime
 * sweep's pass or fail per route, and verify-acs's verdict on a project's acceptance criteria,
 * which lets the reconciler close the project). For each, every agent step across the lane and
 * the workflows it calls, the finish block's copy of the flags included, passes no
 * `--fallback-model` (kanon#1770: verify-acs and the sweep passed one).
 *
 * This is the no-fallback half of the test `K-AGENT-38` names. The other half, holding each
 * checked-output lane's fallback to the same tier or cheaper (`K-OBS-15`), is not built yet, so
 * the adoption record's row for the two lists stays `not yet installed`.
 */
const WF = join(process.cwd(), '.github/workflows');

const VERDICT_LANES = [
  'agent-review.yml',
  'agent-overseer.yml',
  'agent-code-audit.yml',
  'agent-explore-telemetry.yml',
  'agent-explore.yml',
  'agent-verify-acs.yml',
] as const;

type Args = { file: string; at: string; args: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = any;

/** Every `claude_args` a workflow file passes: on a job that calls a workflow, or on a step. */
const claudeArgsIn = (file: string, doc: Doc): Args[] =>
  Object.entries((doc?.jobs ?? {}) as Record<string, Doc>).flatMap(([name, job]) => [
    ...(typeof job?.with?.claude_args === 'string' ? [{ file, at: name, args: job.with.claude_args as string }] : []),
    ...((job?.steps ?? []) as Doc[]).flatMap((s, i) =>
      typeof s?.with?.claude_args === 'string' ? [{ file, at: `${name}.${s.id ?? i}`, args: s.with.claude_args as string }] : []),
  ]);

/** The flags a lane's agent steps pass, across the lane and every workflow it calls through `$/`. */
const laneArgs = (lane: string): Args[] =>
  calledFiles(join(WF, lane)).flatMap((path) => claudeArgsIn(basename(path), parse(readFileSync(path, 'utf8'))));

const FALLBACK = /(?:^|\s)--fallback-model(?:[\s=]|$)/;

describe('verdict-producing runs have no fallback model (K-AGENT-38, K-OBS-15)', () => {
  it.each(VERDICT_LANES)('%s: finds the agent steps it holds, the run and its finish block', (lane) => {
    // A lane renamed, or its flags moved somewhere this reader doesn't look, would pass the
    // assertion below with nothing to hold, so each lane must show its run and its finish block.
    expect(laneArgs(lane).length, lane).toBeGreaterThanOrEqual(2);
  });

  it.each(VERDICT_LANES)('%s: no agent step passes --fallback-model', (lane) => {
    expect(laneArgs(lane).filter((a) => FALLBACK.test(a.args)).map((a) => `${a.file} ${a.at}`), lane).toEqual([]);
  });

  it('the reader sees a fallback wherever an agent step declares one (mutation)', () => {
    const args = '--model claude-opus-5-5\n--effort high\n--fallback-model claude-opus-5\n';
    const doc = { jobs: { j: { steps: [{ id: 'agent', with: { claude_args: args } }] }, k: { uses: 'x', with: { claude_args: args } } } };
    expect(claudeArgsIn('x.yml', doc).filter((a) => FALLBACK.test(a.args)).map((a) => a.at)).toEqual(['j.agent', 'k']);
    expect(FALLBACK.test('--model claude-opus-5-5 --fallback-model=claude-opus-5')).toBe(true);
    expect(FALLBACK.test('--model claude-opus-5-5\n--effort high\n')).toBe(false);
  });
});
