import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { SMOKE_SUFFIX as SUFFIX } from './helpers/smoke-group.js';

/**
 * No lane's concurrency group can be shared by an `agent-lanes-smoke.yml` run and a real run.
 *
 * WHY. Each lane holds a concurrency group that serialises its real runs, and GitHub keeps one
 * pending run per group: a newer one cancels it. The smoke calls every lane on pull_request,
 * merge_group and push, so while the groups were the lanes' own (`agent-code-audit`, one for
 * the repository) every PR's smoke joined the group of the lane's real runs, and of every
 * other PR's smoke. A newer smoke replaced an older one in the queue, and the cancelled lane
 * turned the older smoke red (kanon#309's smoke, `code-audit / gate` cancelled). A smoke on
 * PR 7 also joined the real review and merge groups of PR 7.
 *
 * So the smoke passes `smoke`, and each group ends with SUFFIX, which is `-smoke-<run id>`
 * when it is set and nothing when it is not. This file evaluates every group in every lane
 * the smoke calls, and in every workflow those call through `$/`, under real events and
 * smoke events, and checks three things: no smoke group equals a real one, no two smoke runs
 * share a group, and a real run's group is the one it was without the suffix.
 */
const WF = join(process.cwd(), '.github/workflows');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = any;
const read = (file: string): Doc => parse(readFileSync(join(WF, file), 'utf8')) as Doc;
const CALL = /^\$\/\.github\/workflows\/([\w.-]+\.ya?ml)$/;

const smoke = read('agent-lanes-smoke.yml');
const calls = Object.entries(smoke.jobs as Record<string, Doc>)
  .filter(([, j]) => typeof j.uses === 'string' && CALL.test(j.uses))
  .map(([name, j]) => ({ name, file: CALL.exec(j.uses)![1]!, with: (j.with ?? {}) as Record<string, string> }));

/** Every concurrency group in a file and in each file it calls through `$/`, with where it sits. */
function groupsOf(file: string, seen = new Set<string>()): { where: string; group: string }[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const doc = read(file);
  const out: { where: string; group: string }[] = [];
  const add = (where: string, c: Doc) => {
    if (c === undefined) return;
    out.push({ where, group: typeof c === 'string' ? c : String(c.group) });
  };
  add(file, doc.concurrency);
  for (const [name, job] of Object.entries((doc.jobs ?? {}) as Record<string, Doc>)) {
    add(`${file}, job ${name}`, job.concurrency);
    const m = typeof job.uses === 'string' ? CALL.exec(job.uses) : null;
    if (m) out.push(...groupsOf(m[1]!, seen));
  }
  return out;
}

/** A context in which every property GitHub would leave unset reads as '', as GitHub's do. */
const ctx = (o: Record<string, unknown>): Doc =>
  new Proxy(o, {
    get: (t, k) => {
      const v = (t as Record<string | symbol, unknown>)[k];
      if (v === undefined || v === null) return '';
      return typeof v === 'object' ? ctx(v as Record<string, unknown>) : v;
    },
  });

/**
 * Evaluates a concurrency group the way GitHub does for the expressions the lanes use:
 * `&&`, `||`, `==`, `!=`, `!`, property access, single-quoted strings, `format()`.
 */
function evaluate(group: string, c: { github: Doc; inputs: Doc; needs: Doc }): string {
  const format = (f: string, ...a: unknown[]) => f.replace(/\{(\d+)\}/g, (_, i: string) => String(a[Number(i)]));
  return group.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expr: string) => {
    const js = expr.replace(/\s!=\s/g, ' !== ').replace(/\s==\s/g, ' === ');
    const v = new Function('github', 'inputs', 'needs', 'format', `return (${js});`)(
      ctx(c.github), ctx(c.inputs), ctx(c.needs), format,
    ) as unknown;
    return v === '' || v === null || v === undefined ? '' : String(v);
  });
}

/** The events a lane's real caller can run on, for one PR and one issue, numbered 7. */
const PR = { number: 7, head: { sha: 'abc' } };
const REAL: Doc[] = [
  { event_name: 'schedule', ref: 'refs/heads/main', event: {} },
  { event_name: 'workflow_dispatch', ref: 'refs/heads/main', event: { inputs: {} } },
  { event_name: 'workflow_run', ref: 'refs/heads/main', event: { workflow_run: { head_sha: 'abc' } } },
  { event_name: 'issues', ref: 'refs/heads/main', event: { action: 'labeled', issue: { number: 7 }, label: { name: 'qa:verify' } } },
  { event_name: 'issues', ref: 'refs/heads/main', event: { action: 'closed', issue: { number: 7 } } },
  ...['opened', 'labeled', 'synchronize', 'reopened', 'closed'].map((action) => ({
    event_name: 'pull_request', ref: 'refs/pull/7/merge', event: { action, pull_request: PR, label: { name: 'agent:reviewer' } },
  })),
  { event_name: 'pull_request_review', ref: 'refs/pull/7/merge', event: { action: 'submitted', pull_request: PR } },
];
/** The events the smoke runs on (`agent-lanes-smoke.yml`'s `on:`), on PR 7 too. */
const SMOKE: Doc[] = [
  ...['opened', 'synchronize', 'reopened', 'labeled'].map((action) => ({
    event_name: 'pull_request', ref: 'refs/pull/7/merge', event: { action, pull_request: PR, label: { name: 'agent:reviewer' } },
  })),
  { event_name: 'merge_group', ref: 'refs/heads/gh-readonly-queue/main/pr-7-abc', event: {} },
  { event_name: 'push', ref: 'refs/heads/main', event: {} },
];
/** Every lane input a real run can carry, set or empty. */
const REAL_INPUTS = [{}, { pr_number: '7', issue_number: '7', project: 'p', issue: '7' }];
const NEEDS = { filter: { outputs: { pr: '7', head_sha: 'abc' } } };

const realGroups = (group: string) =>
  REAL.flatMap((g, i) => REAL_INPUTS.map((inputs) => evaluate(group, { github: { ...g, run_id: 1000 + i }, inputs, needs: NEEDS })));
const smokeGroups = (group: string, withInputs: Record<string, string>, runId: number) =>
  SMOKE.map((g) => evaluate(group, { github: { ...g, run_id: runId }, inputs: withInputs, needs: NEEDS }));

describe('no lane concurrency group is shared by a smoke run and a real run', () => {
  it('the smoke calls lanes, and every one of them holds a concurrency group', () => {
    expect(calls.length).toBeGreaterThan(10);
    for (const c of calls) expect(groupsOf(c.file), c.file).not.toEqual([]);
  });

  const cases = calls.flatMap((c) => groupsOf(c.file).map((g) => ({ ...g, call: c })));

  it.each(cases.map((c) => [c.where, c] as const))('%s', (_, { group, call }) => {
    // The suffix is the group's last token, so nothing after it can make two runs equal again.
    expect(group.endsWith(SUFFIX), `${group} must end with ${SUFFIX}`).toBe(true);

    // A real run's group is the one it had before: the suffix adds nothing to it.
    const base = group.slice(0, -SUFFIX.length);
    expect(realGroups(group)).toEqual(realGroups(base));

    // A smoke run, with the inputs the smoke actually passes, is in no real run's group ...
    const real = new Set(realGroups(group));
    const one = smokeGroups(group, call.with, 1);
    for (const s of one) expect(real.has(s), `smoke group ${s} is also a real run's`).toBe(false);

    // ... nor in another smoke run's, from another PR or the same one.
    const two = new Set(smokeGroups(group, call.with, 2));
    for (const s of one) expect(two.has(s), `smoke group ${s} is shared by two smoke runs`).toBe(false);
  });
});
