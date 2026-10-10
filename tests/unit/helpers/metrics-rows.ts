import { LANE_ROLES } from '../../../actions/agent-telemetry/schema.mjs';

/**
 * Fixture rows for `kanon metrics report` (plan 0003 M6): a run row (plan 0002 §2.1, version 2)
 * and a work-item row (plan 0003 §3.3, version 1), each valid against the telemetry schema, with
 * only the fields the report reads set beyond the required ones.
 */

export const DAY = 86_400_000;
/** The report's window ends here in every test: 2026-10-10 00:00 UTC. */
export const UNTIL = new Date('2026-10-10T00:00:00Z');
/** A time `days` before UNTIL (fractions allowed), as the store has it. */
export const ago = (days: number) => new Date(UNTIL.getTime() - days * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Changed lines that land in each band under version 1, with one file in one directory. */
export const LINES = { S: 100, M: 300, L: 800, XL: 2000 } as const;
export type Band = keyof typeof LINES;

let runId = 1_000;

export function runRow(lane: string, opts: { pr?: number; issue?: number; at: string; cost?: number; tag?: string }) {
  runId += 1;
  return {
    schema_version: 2,
    row_kind: 'run',
    tag: opts.tag ?? 'run',
    recorded_at: opts.at,
    run_id: runId,
    run_attempt: 1,
    role: LANE_ROLES[lane],
    lane,
    outcome: 'ok',
    reason: 'none',
    kanon_version: '0.38.0',
    ...(opts.pr !== undefined ? { pr_number: opts.pr } : {}),
    ...(opts.issue !== undefined ? { issue_number: opts.issue } : {}),
    ...(opts.cost !== undefined ? { total_cost_usd: opts.cost } : {}),
  };
}

export function itemRow(pr: number, opts: {
  closed: string;
  fate?: 'merged' | 'closed_unmerged';
  band?: Band;
  issues?: number[];
  author?: string;
  revertDays?: number;
  fixDays?: number;
  verdict?: 'approved' | 'changes_requested' | 'none';
  humanCommits?: number;
  humanCr?: number;
  tag?: string;
}) {
  return {
    schema_version: 1,
    row_kind: 'work_item',
    tag: opts.tag ?? 'run',
    recorded_at: opts.closed,
    pr_number: pr,
    closed_at: opts.closed,
    fate: opts.fate ?? 'merged',
    ...(opts.issues ? { closing_issues: opts.issues.join(',') } : {}),
    ...(opts.band ? { changed_lines: LINES[opts.band], changed_files: 1, changed_dirs: 1, band: opts.band, band_version: 1 } : {}),
    author_kind: opts.author ?? 'implementer',
    ...(opts.revertDays !== undefined ? { revert_pr: pr + 10_000, revert_days: opts.revertDays } : {}),
    ...(opts.fixDays !== undefined ? { fix_prs: String(pr + 20_000), first_fix_days: opts.fixDays } : {}),
    ...(opts.verdict ? { first_verdict: opts.verdict } : {}),
    ...(opts.humanCommits !== undefined ? { human_commits: opts.humanCommits } : {}),
    ...(opts.humanCr !== undefined ? { human_cr_after_approval: opts.humanCr } : {}),
  };
}

/**
 * A merged item in a band and its delivery runs: an implement run and a review run naming the PR,
 * costing `cost` together.
 */
export function mergedWithRuns(pr: number, band: Band, cost: number, closedDaysAgo: number, extra: Partial<Parameters<typeof itemRow>[1]> = {}) {
  const closed = ago(closedDaysAgo);
  return [
    itemRow(pr, { closed, band, ...extra }),
    runRow('implement', { pr, at: ago(closedDaysAgo + 1), cost: cost * 0.75 }),
    runRow('review', { pr, at: ago(closedDaysAgo + 0.5), cost: cost * 0.25 }),
  ];
}

/**
 * A window's rows where cost RISES with the band: in each band, `counts[band]` merged items,
 * costing about S $1, M $3, L $6, XL $10, with a spread inside each band, all with a Reviewer
 * verdict. Closed inside the 28-day window.
 */
export function risingRows(counts: Record<Band, number>, start = 1) {
  const base = { S: 1, M: 3, L: 6, XL: 10 } as const;
  const rows: Record<string, unknown>[] = [];
  let pr = start;
  for (const band of Object.keys(counts) as Band[]) {
    for (let k = 0; k < counts[band]; k += 1) {
      rows.push(...mergedWithRuns(pr, band, base[band] * (0.8 + (k % 5) * 0.1), 1 + (k % 25), { verdict: k % 4 === 0 ? 'changes_requested' : 'approved', humanCommits: k % 6 === 0 ? 1 : 0, humanCr: 0 }));
      pr += 1;
    }
  }
  return rows;
}
