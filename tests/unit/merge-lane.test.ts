import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { MERGE_CALLER, SELF_CHECKS } from '../../scripts/lib/protocol-spellings.mjs';
import { ownRegister, runRegisterStep, withSlug, withoutRole } from './helpers/register-step.js';
import { runWorkflowStep, type WorkflowStep } from './helpers/workflow-step.js';
import { SPAWNS } from './helpers/spawns.js';

/**
 * The Merger's lane, `agent-merge.yml` (plan 0004 step 7), moved from the reference adopter
 * with its job conditions (RA-2596, RA-2741) and its tests of them.
 *
 * A decision the event payload already carries must not cost a runner minute: Actions bills
 * every job rounded UP to a whole minute on a private repository, so a two-second job costs
 * what a sixty-second one does. Measured on the reference adopter over Sept 1-27 2026, this
 * workflow spent 1,166 minutes, 758 of them one-minute review runs that concluded the PR was
 * not the Merger's. A job whose `if:` is false concludes `skipped` and bills nothing.
 *
 * WHAT THIS FILE HOLDS is the direction of each condition, not merely its presence. Every
 * role-neutral clause skips on POSITIVE PAYLOAD EVIDENCE that there is nothing to do, so a
 * field GitHub leaves unset runs the job exactly as before — the failure these conditions
 * keep producing is one that silently matches nothing, and an `if:` is the one place where
 * that failure leaves no log line at all.
 *
 * EVALUATED, NOT STRING-MATCHED: a tiny evaluator for the expression subset these conditions
 * use, run over every event shape the pipeline produces. It throws on anything unmodelled.
 */

const ROOT = process.cwd();
type Job = { if?: string; needs?: string | string[]; outputs?: Record<string, string>; steps?: WorkflowStep[] };
const LANE_FILE = join(ROOT, '.github/workflows/agent-merge.yml');
const LANE_TEXT = readFileSync(LANE_FILE, 'utf8');
const wf = parse(LANE_TEXT) as { name?: string; on: { workflow_call: { inputs: Record<string, unknown>; secrets: Record<string, unknown> } }; jobs: Record<string, Job> };
const { logins, merge } = wf.jobs as { logins: Job; merge: Job };

/** The fixture adopter's App register, which names a Merger and an Implementer. */
const REGISTER = ownRegister();
const IMPLEMENTER_LOGIN = 'example-implementer';
const MERGER_LOGIN = 'example-merger';
const REVIEWER = 'example-reviewer[bot]';
const MERGER = `${MERGER_LOGIN}[bot]`;
const IMPLEMENTER = `${IMPLEMENTER_LOGIN}[bot]`;
const IMPLEMENTER_LABELS = ['agent:implement', 'agent:triage'];

type Labels = string[];
type Ctx = {
  event_name: string;
  needs?: Record<string, { result?: string; outputs: Record<string, string> }>;
  inputs?: Record<string, string>;
  actor?: string;
  event?: {
    action?: string;
    review?: { state: string };
    pull_request?: { number?: number; state?: string; draft?: boolean; user?: { login: string }; labels?: Labels };
    workflow_run?: { event?: string; conclusion?: string | null; head_sha?: string };
  };
};

/** Walk a `github.<a>.<b>` path. Absent resolves to `''`, as GitHub renders an unset value. */
const resolve = (path: string, ctx: Ctx): unknown => {
  let node: unknown = ctx;
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object') return '';
    node = (node as Record<string, unknown>)[key];
  }
  return node === undefined || node === null ? '' : node;
};

/**
 * GitHub expression subset → JS, over one event payload. THROWS on anything unmodelled, so a
 * new construct in one of these conditions fails here rather than being silently mis-read.
 */
const evaluate = (expr: string, ctx: Ctx): unknown => {
  const js = String(expr)
    .replace(/contains\(fromJSON\('(\[[^\]]*\])'\),\s*github\.event_name\)/g, (_m, list: string) =>
      JSON.stringify((JSON.parse(list) as string[]).includes(ctx.event_name)))
    .replace(/contains\(github\.event\.pull_request\.labels\.\*\.name,\s*'([^']+)'\)/g, (_m, label: string) => {
      const labels = ctx.event?.pull_request?.labels;
      return JSON.stringify(Array.isArray(labels) && labels.includes(label));
    })
    .replace(/github\.((?:[a-z_]+\.)*[a-z_]+)/g, (_m, path: string) => JSON.stringify(resolve(path, ctx)))
    // The run is not cancelled in any case below.
    .replace(/!cancelled\(\)/g, 'true')
    .replace(/needs\.([a-z_]+)\.result\b/g, (_m, job: string) => JSON.stringify(ctx.needs?.[job]?.result ?? ''))
    .replace(/needs\.([a-z_]+)\.outputs\.([a-z_]+)/g, (_m, job: string, key: string) => JSON.stringify(ctx.needs?.[job]?.outputs?.[key] ?? ''))
    .replace(/inputs\.([a-z_]+)/g, (_m, key: string) => JSON.stringify(ctx.inputs?.[key] ?? ''))
    // `format('{0}[bot]', <string>)`, the one format this subset uses.
    .replace(/format\('\{0\}\[bot\]',\s*("(?:[^"\\]|\\.)*")\)/g, (_m, arg: string) => JSON.stringify(`${JSON.parse(arg)}[bot]`))
    .replace(/'([^']*)'/g, (_m, str: string) => JSON.stringify(str))
    .replace(/!=/g, '!==')
    .replace(/([^!=])==(?!=)/g, '$1===');
  if (/github\.|needs\.|inputs\.|\w+\s*\(/.test(js)) throw new Error(`unmodelled expression: ${js}`);
  return new Function(`return (${js});`)();
};
const holds = (expr: string | undefined, ctx: Ctx): boolean => Boolean(evaluate(String(expr), ctx));

/** The register-read step EXECUTED against a register, as the default branch would serve it. */
const READ = logins.steps!.find((s) => s.id === 'read')!;
const runRead = (register: string | null) => runRegisterStep(READ, register);

describe('the Merger lane is called, with its caller’s name fixed (plan 0004 step 7)', () => {
  it('names the caller `lane-check` holds it to, which is the one `merge-gate.mjs` excludes as itself', () => {
    // `lane-check` reads this line; `merge-gate.mjs` tells its own checks from the rest by the
    // same name. Two copies of one fact, so they are held to each other here.
    expect(LANE_TEXT).toMatch(new RegExp(`^# CALLER NAME: ${MERGE_CALLER.replace(/[()]/g, '\\$&')}$`, 'm'));
    expect(SELF_CHECKS).toContain(MERGE_CALLER);
    expect(wf.name).toBe(MERGE_CALLER);
  });

  it('takes the Merger’s two secrets and no Claude token: it runs no model', () => {
    expect(Object.keys(wf.on.workflow_call.secrets).sort()).toEqual(['JUDGE_APP_ID', 'JUDGE_APP_PRIVATE_KEY']);
    expect(LANE_TEXT).not.toMatch(/claude-code-action|agent-run|CLAUDE_CODE_OAUTH_TOKEN:/);
  });

  it('runs the library from Kanon’s tree, and no script of the adopter’s', () => {
    const runs = [logins, merge].flatMap((j) => j.steps ?? []).map((s) => s.run ?? '').join('\n');
    expect(runs).toContain('node "$KANON/scripts/merge-gate.mjs"');
    expect(runs).toContain('"$KANON/actions/lane-check/app-register.awk"');
    expect(runs).not.toMatch(/\bnode (?!"\$KANON|-e)/);
  });
});

describe('the dispatch is the only dry run', () => {
  const APPLY = String(merge.steps!.find((s) => s.name === 'Consider the PR(s)')!.env!.APPLY).replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  it.each([
    ['a review', { event_name: 'pull_request_review' }, '--apply'],
    ['a CI completion', { event_name: 'workflow_run' }, '--apply'],
    ['the schedule', { event_name: 'schedule' }, '--apply'],
    ['a dispatch that asks to apply', { event_name: 'workflow_dispatch', inputs: { apply: 'true' } }, '--apply'],
    ['a dispatch that does not', { event_name: 'workflow_dispatch', inputs: { apply: 'false' } }, ''],
    ['a dispatch with the input left blank', { event_name: 'workflow_dispatch' }, ''],
  ] as const)('%s', (_name, ctx, want) => {
    expect(evaluate(APPLY, ctx as Ctx)).toBe(want);
  });
  it('takes `apply` as an optional string, which every trigger of the caller can pass', () => {
    expect(wf.on.workflow_call.inputs.apply).toMatchObject({ type: 'string', required: false });
  });
});

describe("a review on a PR that was never the Merger's starts no runner (RA-2596, RA-2741)", () => {
  /**
   * TWO PATHS (plan 0004 P5, decision 8 as the Owner decided it on 2026-10-04). A review
   * starts `logins`, which holds the membership gate, reads the Merger's and the Implementer's
   * logins from the App register on the default branch, and carries the role-neutral clauses,
   * so a review failing them starts no runner. `merge` needs it, keeps EVERY clause, and
   * compares the identities against its outputs. The sweep — CI completing, the schedule, a
   * dispatch — skips `logins` and starts `merge` alone, behind its own gate.
   *
   * `!cancelled()` lets `merge` start with `logins` skipped, so `runs` models GitHub: `logins`
   * concludes `skipped` when its `if:` is false, `success` when it ran and read the register,
   * `failure` when it could not, and `merge.if` is evaluated over that result and its outputs.
   * `startsRunner` is `logins` alone.
   */
  let own: Record<string, string>;
  beforeAll(() => {
    const r = runRead(REGISTER);
    expect(r.status, r.output).toBe(0);
    own = { ...r.outputs, member: 'true' };
  });

  const startsRunner = (ctx: Ctx) => holds(logins.if, ctx);
  /** `merge.if` given how `logins` ended: `outputs` when it succeeded, nothing otherwise. */
  // An `if:` with no status function is GitHub's implicit `success() && …`: it starts only
  // when every needed job succeeded, so a skipped `logins` would skip the sweep too.
  const mergeRuns = (ctx: Ctx, result: string, outputs: Record<string, string> = {}) =>
    (/\b(?:always|cancelled|failure|success)\(\)/.test(String(merge.if)) || result === 'success')
    && holds(merge.if, { ...ctx, needs: { logins: { result, outputs } } });
  const runs = (ctx: Ctx, outputs: Record<string, string> = own) =>
    startsRunner(ctx) ? mergeRuns(ctx, 'success', outputs) : mergeRuns(ctx, 'skipped');

  type PrShape = { login?: string; labels?: Labels; state?: string; draft?: boolean };
  const review = ({ login = IMPLEMENTER, labels = ['agent:implement'], state = 'open', draft = false }: PrShape = {}): Ctx => ({
    event_name: 'pull_request_review',
    actor: REVIEWER,
    event: { action: 'submitted', review: { state: 'approved' }, pull_request: { number: 1, state, draft, user: { login }, labels } },
  });
  const ci = (conclusion: string | null): Ctx => ({ event_name: 'workflow_run', actor: MERGER, event: { workflow_run: { event: 'push', conclusion, head_sha: 'a'.repeat(40) } } });
  const SWEEPS: [string, Ctx][] = [
    ['a CI completion', ci('success')],
    ['a red CI completion', ci('failure')],
    ['the schedule', { event_name: 'schedule', actor: MERGER }],
    ['a dispatch', { event_name: 'workflow_dispatch', actor: 'a-member', inputs: { pr_number: '7' } }],
  ];

  it('reads the logins merge-gate.mjs uses, from the default branch, with no checkout', () => {
    expect({ merger: own.merger, implementer: own.implementer }).toEqual({ merger: MERGER_LOGIN, implementer: IMPLEMENTER_LOGIN });
    const r = runRead(REGISTER);
    expect(r.ghArgs).toHaveLength(1);
    expect(r.ghArgs[0]).toContain('repos/owner/repo/contents/docs/qa/agent-identities.md');
    // No `ref`, so the contents API answers from the default branch: a PR cannot choose the
    // logins it is judged by.
    expect(r.ghArgs[0]).not.toMatch(/ref=/);
    expect(logins.steps!.some((s) => /actions\/checkout/.test(String(s.uses ?? '')))).toBe(false);
  });

  it('checks out the default branch for merge-gate.mjs, never the PR’s merge ref (K-MERGE-17, kanon#210)', () => {
    // `merge-gate.mjs` reads `REVIEWER_LOGIN`, whose approval merges, from this checkout. With
    // no `ref` a review event checks out `refs/pull/<n>/merge`, and a stacked PR's merge ref
    // carries its base branch's register.
    const checkouts = merge.steps!.filter((s) => /^actions\/checkout@/.test(String(s.uses ?? '')));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]!.with?.ref).toBe('${{ github.event.repository.default_branch }}');
  });

  it('runs for an approval on an open, labelled implementer PR — the green zone', () => {
    expect(runs(review())).toBe(true);
    expect(runs(review({ labels: ['agent:triage'] }))).toBe(true);
  });

  it('accepts both renderings of the one identity (RA-1007)', () => {
    expect(runs(review({ login: IMPLEMENTER }))).toBe(true);
    expect(runs(review({ login: IMPLEMENTER_LOGIN }))).toBe(true);
  });

  it("declines a review on somebody else's PR, which most review events are, with no runner", () => {
    for (const ctx of [review({ login: 'a-member', labels: ['review:please'] }), review({ login: 'example-lead[bot]', labels: ['review:please'] })]) {
      expect(startsRunner(ctx)).toBe(false);
      expect(runs(ctx)).toBe(false);
    }
  });

  it('declines a labelled PR the Implementer did not author — the one review that now costs a runner', () => {
    // Plan 0004 §8's cost: only the login clause can decline this, so `logins` starts and the
    // Merger job skips.
    const ctx = review({ login: 'a-member', labels: ['agent:implement'] });
    expect(startsRunner(ctx)).toBe(true);
    expect(runs(ctx)).toBe(false);
  });

  it('declines an implementer PR carrying neither lane label, with no runner', () => {
    for (const ctx of [review({ labels: ['review:please'] }), review({ labels: [] })]) {
      expect(startsRunner(ctx)).toBe(false);
      expect(runs(ctx)).toBe(false);
    }
  });

  it('declines a closed or draft PR, with no runner', () => {
    for (const ctx of [review({ state: 'closed' }), review({ draft: true })]) {
      expect(startsRunner(ctx)).toBe(false);
      expect(runs(ctx)).toBe(false);
    }
  });

  it('runs a review whose payload omits `draft` — a missing `draft` is not a draft', () => {
    expect(runs(review({ draft: undefined }))).toBe(true);
  });

  it.each(SWEEPS)('runs the Merger on %s with `logins` skipped, and starts no `logins` runner', (_name, ctx) => {
    // The Owner's decision (2026-10-04): the sweep needs no login to decide whether to run.
    expect(startsRunner(ctx)).toBe(false);
    expect(mergeRuns(ctx, 'skipped')).toBe(true);
    expect(runs(ctx)).toBe(true);
  });

  it('never runs the sweep past a `logins` that did run: only a skipped one is the sweep’s', () => {
    for (const [, ctx] of SWEEPS) {
      for (const result of ['success', 'failure', 'cancelled', '']) expect(mergeRuns(ctx, result, own), `${ctx.event_name} ${result}`).toBe(false);
    }
  });

  it('skips a superseded (cancelled) CI run with no runner at all', () => {
    expect(startsRunner(ci('cancelled'))).toBe(false);
    expect(runs(ci('cancelled'))).toBe(false);
  });

  it('keeps the sweep the backstop: a review declined here is re-judged by the next sweep', () => {
    // Every sweep reaches `merge-gate.mjs` with no PR, which re-evaluates every open PR.
    expect(runs(ci(null))).toBe(true);
  });

  it('never runs the Merger for a review whose `logins` failed, was cancelled or was skipped', () => {
    // Review-event safety is unchanged by the sweep's path: a review needs `logins` to have
    // read the register, and is compared against what it read.
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      expect(mergeRuns(review(), result, own), result).toBe(false);
      expect(mergeRuns(review(), result), result).toBe(false);
    }
    expect(mergeRuns(review(), 'success', own)).toBe(true);
  });

  it('starts nothing on an event that is not one of its caller’s four triggers', () => {
    // A called lane runs on whatever its caller is called on; Kanon's smoke calls it on pull
    // requests, pushes and the merge queue.
    for (const event_name of ['pull_request', 'pull_request_target', 'push', 'merge_group', 'issues']) {
      expect(startsRunner({ event_name, actor: 'a-member' }), event_name).toBe(false);
      expect(mergeRuns({ event_name, actor: 'a-member' }, 'skipped'), event_name).toBe(false);
    }
  });

  it('starts the review path for a review from the Judge App, which the Merger shares with the Reviewer (plan 0005 L4)', () => {
    // The register gives both roles one slug; a review's actor is that App. The actor clause
    // that used to decline the Merger's own App would decline every Reviewer review.
    expect(runs({ ...review(), actor: MERGER })).toBe(true);
    expect(String(merge.if)).not.toMatch(/github\.actor/);
  });

  it('submits no review, so no review event is its own (plan 0005 L4)', () => {
    // Why the actor clause could go: the merge lane's code calls no review-submission
    // endpoint, neither `gh pr review` nor a POST to a pull request's reviews.
    const gate = readFileSync(join(process.cwd(), 'scripts/merge-gate.mjs'), 'utf8');
    for (const [name, text] of [['merge-gate.mjs', gate], ['agent-merge.yml', LANE_TEXT]] as const) {
      expect(text, name).not.toMatch(/\bpr['",\s]+review\b/);
      expect(text, name).not.toMatch(/(-X|--method)['",\s]+POST[^\n]*\/reviews|\/reviews[^\n]*(-X|--method)['",\s]+POST/);
      expect(text, name).not.toMatch(/\/reviews\/[^\n]*\/(events|dismissals)/);
    }
  });

  it('never runs past a refusal of the membership gate, whose outputs are all empty', () => {
    // A refused event leaves `logins` green with every output empty, and the actor clause
    // compares with `!=`, which an empty login passes. So the verdict comes first.
    expect(mergeRuns(review(), 'success', { member: 'false' })).toBe(false);
    expect(mergeRuns(review(), 'success', {})).toBe(false);
    expect(String(merge.if)).toMatch(/needs\.logins\.result == 'success'\s+&& needs\.logins\.outputs\.member == 'true'\s+&&/);
    expect(logins.outputs?.member).toBe('${{ steps.gate.outputs.member }}');
    expect(READ.if).toBe("steps.gate.outputs.member == 'true'");
    // On the sweep the Merger job's own gate is the only one, so every step after it skips
    // on its refusal (`lane-gate.test.ts` holds the shape; this, that it is the same gate).
    const gates = [logins, merge].map((j) => j.steps!.find((st) => st.id === 'gate')!);
    expect(gates[1]).toEqual(gates[0]);
    expect(merge.steps!.findIndex((st) => st.id === 'gate')).toBe(1);
  });

  it('keeps every clause on the Merger job: it never runs where `logins` would not start', () => {
    // Decision 8: the Merger's `if:` keeps all its clauses. Over every combination of the
    // role-neutral fields, with the logins the register gives, a clause dropped from
    // `merge.if` turns a row of this grid red.
    const events: Ctx[] = [];
    for (const state of ['open', 'closed', undefined])
      for (const draft of [false, true, undefined])
        for (const labels of [['agent:implement'], ['agent:triage'], ['review:please'], []])
          for (const login of [IMPLEMENTER, IMPLEMENTER_LOGIN, 'a-member'])
            for (const actor of [REVIEWER, MERGER]) events.push({ ...review({ login, labels, state, draft }), actor });
    let merged = 0;
    for (const ctx of events) {
      // Had `logins` succeeded whatever its own `if:` said, the Merger still runs only where
      // that `if:` would have started it.
      const mergeAlone = mergeRuns(ctx, 'success', own);
      if (mergeAlone) merged++;
      expect(!mergeAlone || startsRunner(ctx), JSON.stringify(ctx)).toBe(true);
    }
    expect(merged).toBeGreaterThan(0);
    expect(merged).toBeLessThan(events.length);
  });

  it('needs `logins`, and reads the identities from its outputs and no literal', () => {
    expect(merge.needs).toBe('logins');
    expect(logins.outputs).toEqual({
      member: '${{ steps.gate.outputs.member }}',
      merger: '${{ steps.read.outputs.merger }}',
      implementer: '${{ steps.read.outputs.implementer }}',
    });
    expect(String(merge.if)).toContain("format('{0}[bot]', needs.logins.outputs.implementer)");
    expect(String(merge.if)).toContain('== needs.logins.outputs.implementer');
    // No login of any kind outside a comment.
    const code = LANE_TEXT.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).not.toMatch(/'[a-z0-9-]+\[bot\]'|-the-|example-/);
  });

  it('spells the green zone’s labels in both jobs, so a rename cannot split them', () => {
    // Read from the source: importing `merge-gate.mjs` reads an App register from the working
    // directory, and this unit test runs in Kanon's tree (the library tests run it in the
    // fixture adopter).
    const decl = /^export const IMPLEMENTER_LABELS = (\[[^\]]*\]);$/m.exec(readFileSync(join(ROOT, 'scripts/merge-gate.mjs'), 'utf8'));
    expect(decl, 'merge-gate.mjs declares IMPLEMENTER_LABELS on one line').not.toBeNull();
    expect((JSON.parse(decl![1]!.replace(/'/g, '"')) as string[]).sort()).toEqual(IMPLEMENTER_LABELS);
    for (const label of IMPLEMENTER_LABELS) {
      expect(String(logins.if)).toContain(`'${label}'`);
      expect(String(merge.if)).toContain(`'${label}'`);
    }
  });

  // ── MUTATIONS OF THE REGISTER (plan 0004 P5) ─────────────────────────────────
  it("follows a renamed Implementer App: that App's PR now skips the Merger, the renamed one runs", () => {
    const r = runRead(withSlug(REGISTER, 'Implementer', 'example-implementer-renamed'));
    expect(r.status, r.output).toBe(0);
    const renamed: Record<string, string> = { ...r.outputs, member: 'true' };
    expect(renamed.implementer).toBe('example-implementer-renamed');
    expect(startsRunner(review())).toBe(true);
    expect(runs(review(), renamed)).toBe(false);
    expect(runs(review({ login: 'example-implementer-renamed[bot]' }), renamed)).toBe(true);
  });

  it('fails `logins` by name when the register has no Merger row, so the Merger job cannot start', () => {
    const r = runRead(withoutRole(REGISTER, 'Merger'));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('::error title=App register::');
    expect(r.output).toContain('lists the role Merger 0 times');
    expect(r.outputs.merger).toBeUndefined();
  });

  it('fails `logins` by name when the register is not on the default branch', () => {
    const r = runRead(null);
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('could not read docs/qa/agent-identities.md from the default branch');
  });
});

// Its cases run the step in `bash`, so the block takes the spawn budget (#436).
describe('the Merger job asserts the App it minted is the one it guards on', SPAWNS, () => {
  const SLUG = merge.steps!.find((st) => st.id === 'slug')!;
  /** The step, executed in a checkout holding the fixture register, as `merge-gate.mjs` reads it. */
  const assertSlug = (env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'merge-slug-'));
    cpSync(join(ROOT, 'tests/fixtures/adopter/docs'), join(dir, 'docs'), { recursive: true });
    return runWorkflowStep(SLUG, { dir, cwd: dir, env: { KANON: ROOT, ...env } });
  };

  it('passes a review whose minted App is the register’s Merger in both reads', () => {
    const r = assertSlug({ MINTED_SLUG: MERGER_LOGIN, GUARD_SLUG: MERGER_LOGIN, EVENT: 'pull_request_review' });
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.verified).toBe('true');
  });

  it.each(['workflow_run', 'schedule', 'workflow_dispatch'])('passes the sweep on %s, which has no actor guard, against MERGER_LOGIN', (EVENT) => {
    const r = assertSlug({ MINTED_SLUG: MERGER_LOGIN, GUARD_SLUG: '', EVENT });
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.verified).toBe('true');
  });

  it('fails a review that reached it without the guard’s login, rather than acting unguarded', () => {
    const r = assertSlug({ MINTED_SLUG: MERGER_LOGIN, GUARD_SLUG: '', EVENT: 'pull_request_review' });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('without the Merger');
    expect(r.outputs.verified).toBeUndefined();
  });

  it('fails a renamed App on either path, naming both reads', () => {
    for (const [GUARD_SLUG, EVENT] of [[MERGER_LOGIN, 'pull_request_review'], ['', 'schedule']] as const) {
      const r = assertSlug({ MINTED_SLUG: 'example-merger-renamed', GUARD_SLUG, EVENT });
      expect(r.status, EVENT).not.toBe(0);
      expect(r.output).toContain('App slug mismatch');
    }
    const r = assertSlug({ MINTED_SLUG: MERGER_LOGIN, GUARD_SLUG: 'example-merger-renamed', EVENT: 'pull_request_review' });
    expect(r.status).not.toBe(0);
  });

  it('runs the merge only once the assertion passed', () => {
    expect(merge.steps!.find((st) => st.name === 'Consider the PR(s)')!.if).toBe("steps.slug.outputs.verified == 'true'");
  });
});

describe('the evaluator discriminates — the tables above are vacuous otherwise', () => {
  it('reads both truth values out of every condition it is given', () => {
    const openReview = (login: string, state = 'open'): Ctx => ({
      event_name: 'pull_request_review',
      actor: REVIEWER,
      event: { action: 'submitted', review: { state: 'approved' }, pull_request: { number: 1, state, draft: false, user: { login }, labels: ['agent:implement'] } },
    });
    const outputs = { member: 'true', merger: MERGER_LOGIN, implementer: IMPLEMENTER_LOGIN };
    const cases: [string, Job, Ctx][] = [
      ['merge', merge, openReview('some-human')],
      ['logins', logins, openReview(IMPLEMENTER, 'closed')],
    ];
    for (const [name, job, falseCtx] of cases) {
      expect(holds(job.if, { ...openReview(IMPLEMENTER), needs: { logins: { result: 'success', outputs } } }), name).toBe(true);
      expect(holds(job.if, { ...falseCtx, needs: { logins: { result: 'success', outputs } } }), name).toBe(false);
    }
  });

  it('refuses an expression it does not model, rather than guessing', () => {
    expect(() => evaluate("success() && github.event_name == 'push'", { event_name: 'push' })).toThrow(/unmodelled/);
  });
});
