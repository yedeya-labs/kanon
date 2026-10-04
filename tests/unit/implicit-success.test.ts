import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { hasStatusFunction, startsDespite } from './helpers/job-condition.js';

/**
 * kanon#261: no lane job is silently skipped by GitHub's TRANSITIVE implicit `success()`.
 *
 * A job whose `if:` has no status function starts only when every job in its `needs` chain
 * succeeded, grandparents included, even when the job between them ran under `!cancelled()` or
 * `always()` (actions/runner#491, GitHub's behaviour, not fixed). So a job `B` written to run
 * although an ancestor `A` was skipped or failed, followed by a job `C` that needs `B` with no
 * status function, gives a `C` that never runs in exactly the worlds `B` was written for. PR #259
 * shipped that shape: `explore` needed `change` (`!cancelled()`), which needs `last-green`, skipped
 * on every dispatch, so `explore` never ran on one; its tests read the `if:` as text and passed.
 *
 * The check: for every job `C` with no status function, and every job `B` it needs, `B`'s `if:`
 * is EVALUATED (`startsDespite`) for the ancestors whose skip or failure it starts despite. Any
 * such ancestor fails here, by name. The fix is a status function in `C`'s `if:`, usually
 * `!cancelled() && needs.B.result == 'success' && …`. A `C` that is meant to run only when every
 * ancestor succeeded says so with an explicit `success()`, which GitHub reads the same way and
 * this check accepts as the declaration.
 */

const WORKFLOWS = join(process.cwd(), '.github/workflows');
type Job = { needs?: string | string[]; if?: string };
type Workflow = { jobs?: Record<string, Job> };

const needsOf = (job: Job | undefined): string[] => [job?.needs ?? []].flat();

/** Every `C` that the transitive implicit `success()` skips while a job it needs runs. */
const silentlySkipped = (wf: Workflow): string[] => {
  const jobs = wf.jobs ?? {};
  const ancestorsOf = (id: string, seen = new Set<string>()): string[] => {
    for (const n of needsOf(jobs[id])) if (!seen.has(n)) { seen.add(n); ancestorsOf(n, seen); }
    return [...seen];
  };
  return Object.entries(jobs).flatMap(([id, job]) => {
    if (hasStatusFunction(job.if)) return [];
    return needsOf(job).flatMap((b) => {
      const tolerated = startsDespite(jobs[b]?.if, ancestorsOf(b));
      return tolerated.length === 0 ? [] : [
        `\`${id}\` has no status function in its \`if:\`, so GitHub skips it whenever ${tolerated.map((a) => `\`${a.job}\` ${a.results.map((r) => (r === 'failure' ? 'fails' : 'is skipped')).join(' or ')}`).join(', or ')}, although \`${b}\`, which it needs, runs then (\`${String(jobs[b]!.if).trim()}\`)`,
      ];
    });
  });
};

const LANES = readdirSync(WORKFLOWS).filter((f) => /^agent-.*\.yml$/.test(f)).sort();

describe('kanon#261: no lane job is silently skipped by the transitive implicit success()', () => {
  it('reads lanes', () => {
    expect(LANES.length).toBeGreaterThan(10);
  });

  it.each(LANES)('%s', (file) => {
    const wf = parse(readFileSync(join(WORKFLOWS, file), 'utf8')) as Workflow;
    expect(silentlySkipped(wf), `${file}:\n${silentlySkipped(wf).join('\n')}`).toEqual([]);
  });
});

/** The Explorer lane's job graph as PR #259 first shipped it, `explore`'s `if:` replaceable. */
const explorer = (exploreIf: string, recordSkipIf = "!cancelled() && needs.change.result == 'success' && needs.change.outputs.sweep == 'false'"): Workflow => ({
  jobs: {
    gate: { if: "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'" },
    'last-green': { needs: 'gate', if: "needs.gate.outputs.member == 'true' && github.event_name == 'schedule'" },
    change: { needs: ['gate', 'last-green'], if: "${{ !cancelled() && needs.gate.outputs.member == 'true' }}" },
    'record-skip': { needs: 'change', if: `\${{ ${recordSkipIf} }}` },
    explore: { needs: 'change', if: exploreIf },
    put: { needs: 'explore', if: "${{ !cancelled() && needs.explore.outputs.summary-artifact != '' }}" },
  },
});

describe('the check, on real lane shapes', () => {
  it("fails PR #259's first `explore`, naming the job, the job it needs and the skipped ancestor", () => {
    const found = silentlySkipped(explorer("needs.change.outputs.sweep == 'true'"));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^`explore` has no status function .* whenever `gate` fails, or `last-green` is skipped or fails, although `change`, which it needs, runs then/);
  });

  it('fails `record-skip` the same way when it loses its status function', () => {
    const found = silentlySkipped(explorer("${{ !cancelled() && needs.change.outputs.sweep == 'true' }}", "needs.change.outputs.sweep == 'false'"));
    expect(found.map((f) => f.split(' ')[0])).toEqual(['`record-skip`']);
  });

  it("passes PR #259's fixed `explore`", () => {
    expect(silentlySkipped(explorer("${{ !cancelled() && needs.change.result == 'success' && needs.change.outputs.sweep == 'true' }}"))).toEqual([]);
  });

  it('passes an explicit `success()`, the declaration that every ancestor must succeed', () => {
    expect(silentlySkipped(explorer("${{ success() && needs.change.outputs.sweep == 'true' }}"))).toEqual([]);
  });

  it('passes a plain chain, where every skip is visible in the direct `needs`', () => {
    // The implement lane's shape: filter (an `if:`) -> implement -> empty-check.
    expect(silentlySkipped({
      jobs: {
        filter: { if: "github.event_name != 'issues' || github.event.label.name == 'agent:implement'" },
        implement: { needs: 'filter', if: "needs.filter.outputs.act == 'true'" },
        'empty-check': { needs: 'implement', if: "needs.implement.result == 'success'" },
      },
    })).toEqual([]);
  });

  it("fails a job after a revise lane's `always()` record-round", () => {
    // The revise lanes' shape: record-round runs after revise whatever its result.
    const found = silentlySkipped({
      jobs: {
        filter: {},
        revise: { needs: 'filter', if: "needs.filter.outputs.act == 'true'" },
        'record-round': { needs: ['filter', 'revise'], if: "always() && needs.filter.outputs.act == 'true'" },
        after: { needs: 'record-round', if: "needs.record-round.result == 'success'" },
      },
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^`after` .* whenever `filter` fails, or `revise` is skipped or fails, although `record-round`/);
  });

  it("names an ancestor only when the job between can start despite it", () => {
    // `mid` reads `up`'s output, which is empty when `up` was skipped, so a skipped `up` holds
    // `mid` too, and only `up`'s failure is one `mid` starts despite.
    const found = silentlySkipped({
      jobs: {
        up: { if: "github.event_name == 'schedule'" },
        mid: { needs: 'up', if: "!cancelled() && needs.up.outputs.go == 'true'" },
        down: { needs: 'mid' },
      },
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/whenever `up` fails, although/);
    expect(silentlySkipped({
      jobs: {
        up: { if: "github.event_name == 'schedule'" },
        mid: { needs: 'up', if: "!cancelled() && needs.up.result == 'success'" },
        down: { needs: 'mid' },
      },
    })).toEqual([]);
  });

  it('reads `success()` and `failure()` in the job between transitively', () => {
    // `success()` there holds only when every ancestor succeeded, so `mid` tolerates nothing;
    // `failure()` holds when one failed, so `mid` tolerates `up`'s failure and not its skip.
    const chain = (midIf: string): Workflow => ({
      jobs: {
        up: { if: "github.event_name == 'schedule'" },
        mid: { needs: 'up', if: midIf },
        down: { needs: 'mid' },
      },
    });
    expect(silentlySkipped(chain("success() && github.event_name != 'push'"))).toEqual([]);
    const found = silentlySkipped(chain('failure()'));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/whenever `up` fails, although `mid`/);
  });
});
