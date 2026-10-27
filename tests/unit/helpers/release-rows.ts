/**
 * Store-shaped rows of one Kanon release for the page view's release comparison (kanon#1453): `n`
 * merged items of adopter `key`, closed evenly between `days[1]` and `days[0]` days before `now`,
 * each pinned to `version`, with one costed implement run. Cost grows with the diff, times
 * `scale`, with a spread, so the size-controlled fit has something to control for.
 */
export type StoredRow = Record<string, string | number>;

const DAY = 86_400_000;
const SIZES = [100, 300, 800, 2000];

export function releaseRows(key: string, version: string, prFrom: number, n: number, o: { now: number; days: [number, number]; scale: number; escaped?: (k: number) => boolean }): StoredRow[] {
  const live = Math.floor(o.now / 1000) + 86_400;
  const at = (daysAgo: number) => new Date(Math.floor(o.now / DAY) * DAY - daysAgo * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return Array.from({ length: n }, (_, k) => {
    const pr = prFrom + k;
    const closed = o.days[0] + ((o.days[1] - o.days[0]) * k) / n;
    const lines = SIZES[k % 4] as number;
    const cost = (o.scale * Math.sqrt(1 + lines) * (0.8 + (k % 5) * 0.1)) / 10;
    const item: StoredRow = {
      pk: `${key}#work`, row_kind: 'work_item', tag: 'run', recorded_at: at(closed), expires_at: live, pr_number: pr, closed_at: at(closed),
      fate: 'merged', changed_lines: lines, changed_files: 1, changed_dirs: 1, author_kind: 'implementer', first_verdict: 'approved',
      human_commits: 0, human_cr_after_approval: 0, kanon_version: version,
    };
    if (o.escaped?.(k)) item.first_fix_days = 5;
    return [
      item,
      {
        pk: `${key}#implement`, row_kind: 'run', tag: 'run', recorded_at: at(closed + 1), expires_at: live, lane: 'implement',
        model: 'claude-opus-5-5', total_cost_usd: cost, outcome: 'ok', pr_number: pr, kanon_version: version,
      },
    ];
  }).flat();
}

/** Two releases of 100 items each, the newer 30% cheaper at equal size with quality held: a win. */
export const winRows = (key: string, now: number): StoredRow[] => [
  ...releaseRows(key, '0.39.0', 1, 100, { now, days: [100, 160], scale: 1, escaped: (k) => k % 5 === 0 }),
  ...releaseRows(key, '0.40.0', 1001, 100, { now, days: [31, 95], scale: 0.7 }),
];
