// The report's views beyond the headline (plan 0003 §6.1, kanon#669): the trend, the by-version
// view and the configuration A/B. Rows in, views out, pure, like the report (`K-SELF-8`); each
// cell is the headline's, from the same units (`measure`), so a view never computes an indicator
// another way.
//
// THE SPAN. Every view reads the `windows` windows of `days` days (28 by default) that end at
// `until`: the trend shows each, oldest first; the by-version and A/B views read them as one span.
//
// POOLED, WITH THE BAND MIX (§2.1). A view's cells are pooled across bands with the band mix
// beside them: the banded cells are the headline's, for the latest window, where the validity
// check has judged them.
//
// THE THREE STAY TOGETHER (§2.1, decision 5): every trend window, every version and every A/B arm
// shows cost, yield and the escape rate, with first-review approval and the human-correction rate
// where the view has them.
//
// THE A/B VIEW DECIDES ONLY AS §6.1 SAYS. A configuration change in a lane is a WIN only if its
// cost difference, at equal size (the reference adopter's log-linear fit, `fitPeriodEffect`), has
// an interval entirely below zero, AND its quality holds within decision 11's margins, new minus
// old: yield's lower bound above −5 points, the 30-day escape rate's upper bound below +2 points.
// A cheaper configuration whose quality isn't shown to hold is "cheaper, quality not shown to
// hold", never a win.
//
// THE RELEASE COMPARISON (kanon#1451), computed in `compare.mjs`, which the aggregate function's
// page view links too (kanon#1453), is the A/B's method with the Kanon release as the arm: each
// release with at least the median's minimum of merged items in the span against the one before it
// that has as many, an item in the arm of the version its lanes pinned at its merge, as the
// by-version view has it. Its verdicts split the A/B's "not shown cheaper" in two: "dearer" when
// the cost interval sits entirely above zero, "no measurable change" when it holds zero. A release
// with fewer items is skipped and listed, never pooled with a neighbour (the lead's decision on
// kanon#1451). Like the A/B, it reads whatever else changed between the releases (the model, the
// configuration, the work mix beyond diff size) as the release's: it says whether a release was
// cheaper at equal size, not that the release made it so.
//
// THE DEPLOY VIEWS (plan 0010 §11, decision 12): deployment frequency, change-failure rate, time
// to restore and release lead time, on production's deploy rows alone (`deployMetricsOf`), over
// the 13 weeks that end at `until`. They are shown only for an adopter with deploy rows.

import { DELIVERY_LANES, WINDOW_DAYS, cellText, dollars, measure, mixText, notEnough, percent, pooledHeadline, prepareRows } from './report.mjs';
import { DEPLOY_WEEKS, TREND_WINDOWS, byVersionOf, compareVersions, deployMetricsOf, trendOf } from './indicators.mjs';
import { fitPeriodEffect } from '../lib/token-trend.mjs';
import { AB_MARGINS, RELEASE_VERDICTS, armDifferences, qualityHolds, releaseComparisonOf } from './compare.mjs';

export { AB_MARGINS, DEPLOY_WEEKS, RELEASE_VERDICTS, TREND_WINDOWS, compareVersions };

/** What the A/B view calls a comparison. */
export const AB_VERDICTS = Object.freeze({
  win: 'win',
  'cheaper-quality-not-shown': 'cheaper, quality not shown to hold',
  'not-shown-cheaper': 'not shown cheaper',
  'not-enough-data': 'not enough data',
});

const DAY_MS = 86_400_000;
const date = (/** @type {number} */ t) => new Date(t).toISOString().slice(0, 10);

/** @typedef {import('./report.mjs').RunRow} RunRow @typedef {import('./report.mjs').ItemRow} ItemRow */

/**
 * The views.
 * @param {readonly unknown[]} rows one adopter's stored rows, as `metricsReport` reads them
 * @param {{ until: Date, days?: number, windows?: number }} opts
 */
export function metricsViews(rows, { until, days = WINDOW_DAYS, windows = TREND_WINDOWS }) {
  const ctx = prepareRows(rows);
  const end = until.getTime();
  const width = days * DAY_MS;
  const start = end - windows * width;
  const trend = trendOf(ctx, { end, days, windows });
  const byVersion = byVersionOf(ctx, { start, end });

  return {
    span: { from: date(start), until: date(end), windows, days },
    trend,
    byVersion,
    releaseComparison: releaseComparisonOf(ctx, { start, end, fit: fitPeriodEffect }),
    ab: { margins: AB_MARGINS, lanes: abLanes(ctx, start, end) },
    deploy: hasDeployRows(rows) ? deployMetricsOf(rows, { end }) : null,
  };
}

/** @typedef {ReturnType<typeof metricsViews>} Views */

/** Whether any row is a deploy row: an adopter without the deploy lane gets no deploy view. @param {readonly unknown[]} rows */
const hasDeployRows = (rows) => rows.some((r) => r !== null && typeof r === 'object' && /** @type {Record<string, unknown>} */ (r).row_kind === 'deploy');

/**
 * The configuration A/B, per delivery lane that ran on two or more `config_fingerprint`s in the
 * span: its newest fingerprint (by first run) against the one before it. An item is in an arm when
 * every run of the lane joined to it ran on that arm's fingerprint; one whose runs in the lane ran
 * on two is left out, and counted. Each arm's cost is its items' whole delivery cost, the
 * headline's, so a change that is cheaper in its own lane and dearer downstream is not cheaper.
 * @param {import('./report.mjs').Prepared} ctx @param {number} start @param {number} end
 */
function abLanes(ctx, start, end) {
  const inSpan = (/** @type {number} */ t) => t >= start && t < end;
  const fingerprint = (/** @type {RunRow} */ r) => (typeof r.config_fingerprint === 'string' ? r.config_fingerprint : null);
  const lanes = [];
  for (const lane of DELIVERY_LANES) {
    /** @type {Map<string, { first: string, last: string }>} */
    const seen = new Map();
    for (const run of ctx.runs) {
      const fp = fingerprint(run);
      if (run.lane !== lane || fp === null || !inSpan(Date.parse(run.recorded_at))) continue;
      const s = seen.get(fp);
      if (!s) seen.set(fp, { first: run.recorded_at, last: run.recorded_at });
      else {
        if (run.recorded_at < s.first) s.first = run.recorded_at;
        if (run.recorded_at > s.last) s.last = run.recorded_at;
      }
    }
    if (seen.size < 2) continue;
    const byFirst = [...seen].sort(([, a], [, b]) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
    const [oldFp, oldSeen] = /** @type {[string, { first: string, last: string }]} */ (byFirst[byFirst.length - 2]);
    const [newFp, newSeen] = /** @type {[string, { first: string, last: string }]} */ (byFirst[byFirst.length - 1]);
    /** The lane's fingerprint on these runs: one, `mixed`, or null when none ran in the lane on one. @param {readonly RunRow[]} rs */
    const armOf = (rs) => {
      const fps = new Set(rs.filter((r) => r.lane === lane).map(fingerprint).filter((f) => f !== null));
      return fps.size === 1 ? [...fps][0] : fps.size > 1 ? 'mixed' : null;
    };
    const itemArm = (/** @type {ItemRow} */ i) => armOf(ctx.runsOf.get(i.pr_number) ?? []);
    const closedInSpan = ctx.items.filter((i) => inSpan(Date.parse(i.closed_at)));
    const arm = (/** @type {string} */ fp, /** @type {{ first: string, last: string }} */ s) => {
      const m = measure(ctx, { start, end, keepItem: (i) => itemArm(i) === fp, keepRuns: (rs) => armOf(rs) === fp });
      const h = pooledHeadline(m);
      return {
        m,
        summary: { fingerprint: fp, firstRun: s.first, lastRun: s.last, items: closedInSpan.filter((i) => itemArm(i) === fp).length, cost: h.cost, yield: h.yield, escape: { rate: h.escape.d30 } },
      };
    };
    const older = arm(oldFp, oldSeen);
    const newer = arm(newFp, newSeen);
    const d = armDifferences(older.m, newer.m, { noun: 'configuration', fit: fitPeriodEffect });
    /** @type {keyof typeof AB_VERDICTS} */
    let verdict = 'not-enough-data';
    if (d.costAtEqualSize.ok) verdict = !(d.costAtEqualSize.hiPct < 0) ? 'not-shown-cheaper' : qualityHolds(d) ? 'win' : 'cheaper-quality-not-shown';
    lanes.push({
      lane,
      old: older.summary,
      new: newer.summary,
      mixed: closedInSpan.filter((i) => itemArm(i) === 'mixed').length,
      ...d,
      verdict,
    });
  }
  return lanes;
}

// ── The views as Markdown ────────────────────────────────────────────────────────────────────

/** A signed percentage, a true minus sign below zero. @param {number} v */
const signedPct = (v) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)}%`;
/** A difference of shares in percentage points. @param {number} v */
const points = (v) => `${v < 0 ? '−' : '+'}${Math.abs(v * 100).toFixed(1)} points`;
/** Milliseconds as hours. @param {number} v */
const hours = (v) => `${(v / 3_600_000).toFixed(1)} h`;
/** A count per week. @param {number} v */
const perWeek = (v) => `${v % 1 === 0 ? v : v.toFixed(1)} a week`;

/**
 * The deploy views as Markdown lines (plan 0010 §11), or none for an adopter without deploy rows.
 * @param {NonNullable<Views['deploy']>} d
 * @returns {string[]}
 */
function renderDeploy(d) {
  return [
    '',
    `### Deploys to production, ${d.window.from} to ${d.window.until}`,
    '',
    `Measured on production, the last environment of the declared chain (\`role: production\`), over ${d.window.weeks} weeks; ${d.rows.production} production rows in the span. Pre-production rows count in none of these: ${d.rows.preProduction} in the span, left out. Deploy rows not \`tag: run\`: ${d.rows.notRun}; unreadable: ${d.rows.unreadable}.`,
    '',
    '| Metric | Value | What it counts |',
    '|---|---|---|',
    `| Deployment frequency | ${cellText(d.frequency.median, perWeek)} | Forward \`ok\` deploys (not rollbacks or redeploys) per week, the median over ${d.window.weeks} weeks: ${d.frequency.perWeek.join(', ')}, oldest first |`,
    `| Change-failure rate | ${cellText(d.changeFailure.rate, percent)} | ${d.changeFailure.failed} of ${d.changeFailure.reached} forward deploys (not rollbacks or redeploys) that reached the deploy stage failed there, failed their smoke check, or were rolled back (${d.changeFailure.rolledBack}) |`,
    `| Time to restore | ${cellText(d.restore.median, hours)} | From a deploy that failed at the deploy stage or its smoke check to the next \`ok\`, a rollback's or redeploy's included, the median; ${d.restore.unrestored} not restored yet |`,
    `| Release lead time | ${cellText(d.leadTime.median, hours)} | From the release's publication to its forward \`ok\` deploy to production, the median, including the time in pre-production and waiting for approval; ${d.leadTime.withoutLeadTime} without the time |`,
    '',
    'What they can\'t see: a production fault found days later and fixed forward, with no rollback and no failed smoke check. A deploy row carries no commit, so it can\'t be joined to the reverts and linked fixes the escape rate counts.',
    '',
    'A lane failure before the deploy hook counts as a change failure, and as one to restore, though nothing changed in production: a `declare` job, or a step of the `deploy` job before the hook, that failed without refusing records `failed` at `deploy`, as the hook\'s own failure does. The run\'s log tells them apart.',
  ];
}

/**
 * The release comparison as Markdown lines (kanon#1451).
 * @param {Views} v
 * @returns {string[]}
 */
function renderReleases(v) {
  const r = v.releaseComparison;
  /** @param {{ status: string, value?: number, low?: number, high?: number, n?: number }} d */
  const diff = (d) => (d.status === 'ok' ? `${points(/** @type {number} */ (d.value))} (${points(/** @type {number} */ (d.low))} to ${points(/** @type {number} */ (d.high))})` : d.status === 'no-spend' ? `no spend (${d.n})` : notEnough(d.n ?? 0));
  /** @param {(typeof r.comparisons)[number]['costAtEqualSize']} c */
  const cost = (c) => (c.ok ? `${signedPct(c.pct)} (${signedPct(c.loPct)} to ${signedPct(c.hiPct)}), n ${c.n}` : c.reason);
  const arms = r.comparisons.flatMap((c, k) => (k === 0 ? [c.old, c.new] : [c.new]));
  return [
    '',
    `### Release comparison, ${v.span.from} to ${v.span.until}`,
    '',
    `Each Kanon release with at least ${r.minimum} merged items in the span, against the one before it that has as many; an item is in the release its lanes pinned at its merge. The configuration A/B's method: a release is a **win** only if its cost at equal size (the log-linear fit of log cost on log(1 + changed lines) and the release) has an interval entirely below zero, and its quality holds within decision 11's margins, new minus old: yield's lower bound above ${points(r.margins.yield)}, the 30-day escape rate's upper bound below ${points(r.margins.escape30)}. A cost interval entirely above zero is **dearer**; one that holds zero, **no measurable change**. Whatever else changed between two releases, the model, a lane's configuration or the work mix beyond diff size, is read as the release's: compare the dates each release's items closed between.`,
    '',
    ...(r.comparisons.length
      ? [
        '| Old → new | Cost at equal size, new against old | Yield, new − old | Escapes at 30 days, new − old | Verdict |',
        '|---|---|---|---|---|',
        ...r.comparisons.map((c) => `| ${c.old.version} → ${c.new.version} | ${cost(c.costAtEqualSize)} | ${diff(c.yieldDifference)} | ${diff(c.escapeDifference)} | ${RELEASE_VERDICTS[c.verdict]} |`),
        '',
        '| Kanon release | Merged items | Closed from | Closed until | Cost, median | Yield | Escapes, 30 days |',
        '|---|---|---|---|---|---|---|',
        ...arms.map((a) => `| ${a.version} | ${a.items} | ${a.from} | ${a.until} | ${cellText(a.cost.median, dollars)} | ${cellText(a.yield, percent)} | ${cellText(a.escape.rate, percent)} |`),
      ]
      : [`Fewer than two Kanon releases have ${r.minimum} merged items in the span, so none is compared.`]),
    '',
    `Releases with fewer than ${r.minimum} merged items, not compared and not pooled: ${r.fewer.length ? r.fewer.map((x) => `${x.version} (${x.items})`).join(', ') : 'none'}. Merged items on \`dev\`, not a release: ${r.dev}.`,
  ];
}

/**
 * The views as Markdown lines, after the headline's.
 * @param {Views} v
 * @returns {string[]}
 */
export function renderViews(v) {
  /** @param {ReturnType<typeof pooledHeadline>} h */
  const headCells = (h) => [
    cellText(h.cost.median, dollars), cellText(h.cost.p90, dollars), cellText(h.yield, percent),
    cellText(h.escape.d30, percent), cellText(h.escape.d90, percent), cellText(h.approval, percent), cellText(h.correction, percent),
    mixText(h.bandMix),
  ];
  const columns = '| Cost, median | Cost, p90 | Yield | Escapes, 30 days | Escapes, 90 days | First-review approval | Human correction | Band mix |';
  const rule = '|---|---|---|---|---|---|---|---|';
  /** @param {{ status: string, value?: number, low?: number, high?: number, n?: number }} d */
  const diff = (d) => (d.status === 'ok' ? `${points(/** @type {number} */ (d.value))} (${points(/** @type {number} */ (d.low))} to ${points(/** @type {number} */ (d.high))})` : d.status === 'no-spend' ? `no spend (${d.n})` : notEnough(d.n ?? 0));
  return [
    '',
    `### Trend, ${v.span.windows} windows of ${v.span.days} days`,
    '',
    'Pooled across bands, with the band mix; each window by close date, its escape rates over the items merged that far before it. A Kanon version starts in the window its first item closed in.',
    '',
    `| Window ${columns} Kanon version |`,
    `|---${rule}---|`,
    ...v.trend.map((t) => `| ${t.window.from} to ${t.window.until} | ${headCells(t).join(' | ')} | ${t.versionsIntroduced.length ? t.versionsIntroduced.map((x) => `Kanon ${x} starts`).join(', ') : '—'} |`),
    '',
    `### By Kanon version, ${v.span.from} to ${v.span.until}`,
    '',
    `The version each item's lanes pinned at its merge; a version is shown from ${v.byVersion.minimum} merged items in the span. Pooled across bands, with the band mix.`,
    '',
    ...(v.byVersion.versions.length
      ? [`| Kanon version | Merged items ${columns}`, `|---|---${rule}`, ...v.byVersion.versions.map((x) => `| ${x.version} | ${x.items} | ${headCells(x).join(' | ')} |`)]
      : ['No version has enough merged items in the span.']),
    '',
    `Versions with fewer merged items: ${v.byVersion.fewer.length ? v.byVersion.fewer.map((x) => `${x.version} (${x.items})`).join(', ') : 'none'}. Merged items with no \`kanon_version\`: ${v.byVersion.unversioned}.`,
    '',
    ...renderReleases(v),
    '',
    `### Configuration A/B, ${v.span.from} to ${v.span.until}`,
    '',
    ...(v.ab.lanes.length
      ? [
        `Per delivery lane, its newest \`config_fingerprint\` (model, effort, turn cap) against the one before it; an item is in an arm when its runs in the lane ran on that fingerprint. A change is a **win** only if its cost at equal size (the log-linear fit of log cost on log(1 + changed lines) and the configuration) has an interval entirely below zero, and its quality holds within decision 11's margins, new minus old: yield's lower bound above ${points(v.ab.margins.yield)}, the 30-day escape rate's upper bound below ${points(v.ab.margins.escape30)}.`,
        '',
        '| Lane | Old → new | Cost at equal size, new against old | Yield, new − old | Escapes at 30 days, new − old | Verdict |',
        '|---|---|---|---|---|---|',
        ...v.ab.lanes.map((l) => `| ${l.lane} | ${l.old.fingerprint} → ${l.new.fingerprint} | ${l.costAtEqualSize.ok ? `${signedPct(l.costAtEqualSize.pct)} (${signedPct(l.costAtEqualSize.loPct)} to ${signedPct(l.costAtEqualSize.hiPct)}), n ${l.costAtEqualSize.n}` : l.costAtEqualSize.reason} | ${diff(l.yieldDifference)} | ${diff(l.escapeDifference)} | ${AB_VERDICTS[l.verdict]} |`),
        '',
        '| Lane | Configuration | Runs from | Runs until | Items | Cost, median | Yield | Escapes, 30 days |',
        '|---|---|---|---|---|---|---|---|',
        ...v.ab.lanes.flatMap((l) => [l.old, l.new].map((a) => `| ${l.lane} | ${a.fingerprint} | ${a.firstRun.slice(0, 10)} | ${a.lastRun.slice(0, 10)} | ${a.items}${l.mixed ? ` (${l.mixed} on both, left out)` : ''} | ${cellText(a.cost.median, dollars)} | ${cellText(a.yield, percent)} | ${cellText(a.escape.rate, percent)} |`)),
      ]
      : ['No delivery lane ran on two configurations (`config_fingerprint`) in the span.']),
    ...(v.deploy ? renderDeploy(v.deploy) : []),
  ];
}
