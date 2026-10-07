// What did this repository's agent lanes spend this week, and did anything it changed actually
// move it? The Overseer's weekly token-efficiency report (`token-trend.md`), moved from the
// reference adopter's `token-trend.mjs` (RA-2081) with plan 0002 §6's changes for the hosted
// store (kanon#470):
//
//   - the partition is `<key>#<lane>`, read with the adopter's reader role, instead of
//     `COST#<agent>` in its own table; an arm is a lane;
//   - the sort key's first 16 characters are the old whole sort key, the run's timestamp;
//   - the lane list is Kanon's lane enum (`infra/telemetry/function/schema.mjs`), not a scan of
//     the workflows for `agent:`;
//   - only `tag: run` rows count: the store also holds smoke and test rows (plan 0002 §2.4).
//
// AND ONE THING LEFT BEHIND, said in the report: the reference adopter's cutover ledger, a file of
// its own that dated the configuration changes `config_fingerprint` can't see. Kanon has no such
// file for an adopter, so the report names that blind spot instead of listing cutovers. The query
// lives in `scripts/overseer-telemetry.mjs`; this file is arithmetic only.
//
// WHY THIS IS A STANDING REPORT. A sequence of changes each meant to move a number needs
// something that watches those numbers on a schedule. An effect established weeks later, against
// a baseline that has since moved, is not a measurement: it is a story fitted to whatever the
// rows happen to say.
//
// THE ONE THING THIS FILE EXISTS TO PREVENT is the report that finds a win every week. On the
// reference adopter the reviewer's median cost per run once read 6% lower after a change, and it
// looked like the optimisation working. It was not: the bootstrap 95% interval on the median
// delta was [-$0.30, +$0.10] at n=79, and the whole drop was a WORK-SIZE artifact. Median
// `changed_lines` per review had fallen 478 -> 302 over the same window. At equal diff size,
// cost went UP 6%. So a raw median delta is never reported as a finding here. `costAtEqualSize`
// is the headline and the raw figures are context. An arm with no size signal says so rather
// than quietly falling back to the number that misleads.
//
// AND IT STATES ITS OWN DETECTION FLOOR. Every delta carries an interval, and one spanning zero
// prints as NOT DETECTED rather than as a number a reader will anchor on.
//
// NO MODEL, AND `node:` BUILT-INS ONLY (`K-SELF-8`). A token-efficiency report that spends tokens
// to produce itself is self-defeating, and a model narrating statistics is a hallucination
// surface over exactly the figures being trusted. Every number here is arithmetic.

export const DAY_MS = 86_400_000;

/** The store's sort key starts with the run's time, compact ISO: `20260919T161052Z`. */
const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/;

/**
 * A sort key's time, in epoch ms: its first 16 characters (plan 0002 §6), or `null`.
 * @param {string | null | undefined} sk
 * @returns {number | null}
 */
export const parseSk = (sk) => {
  const m = STAMP.exec(sk ?? '');
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return Date.UTC(+(/** @type {string} */ (y)), +(/** @type {string} */ (mo)) - 1, +(/** @type {string} */ (d)), +(/** @type {string} */ (h)), +(/** @type {string} */ (mi)), +(/** @type {string} */ (s)));
};

/** @typedef {Record<string, { N?: string, S?: string, BOOL?: boolean } | undefined>} Item a DynamoDB item, as `aws dynamodb query` prints it */

/** @param {Item} item @param {string} key @returns {number | null} */
export const N = (item, key) => (item?.[key]?.N === undefined ? null : Number(item[key]?.N));
/** @param {Item} item @param {string} key @returns {string | null} */
export const S = (item, key) => item?.[key]?.S ?? null;

/**
 * Only a real run counts: the store also holds `smoke` and `test` rows (plan 0002 §2.4).
 * @param {Item} item
 */
export const isRun = (item) => S(item, 'tag') === 'run';

/**
 * @typedef {{ ts: number | null, outcome: string | null, model: string | null, effort: string | null,
 *   fingerprint: string | null, cost: number | null, lines: number | null, output: number | null,
 *   thinking: number | null, cacheRead: number | null, cacheWrite: number | null,
 *   durationMs: number | null, apiMs: number | null, issueChars: number | null,
 *   issuePaths: number | null, produced: number | null, current?: boolean }} Row
 */

/** @param {Item} item @returns {Row} */
export const toRow = (item) => ({
  ts: parseSk(S(item, 'sk')),
  outcome: S(item, 'outcome'),
  model: S(item, 'model'),
  effort: S(item, 'effort'),
  fingerprint: S(item, 'config_fingerprint'),
  cost: N(item, 'total_cost_usd'),
  lines: N(item, 'changed_lines'),
  output: N(item, 'output_tokens'),
  thinking: N(item, 'thinking_tokens'),
  cacheRead: N(item, 'cache_read_tokens'),
  cacheWrite: N(item, 'cache_write_tokens'),
  durationMs: N(item, 'duration_ms'),
  // Absence is not zero: a run whose idle time was never recorded has not been measured as busy.
  apiMs: N(item, 'duration_api_ms'),
  // THE ISSUE-SIDE SIZE: what an issue-triggered run was asked to do. A CANDIDATE control, used
  // only through `validateSizeRegressor`.
  issueChars: N(item, 'issue_body_chars'),
  issuePaths: N(item, 'issue_paths_named'),
  // THE RUN'S OWN DIFF. Read so it can be reported, and deliberately named in no regressor below:
  // on the Implementer the agent WRITES this diff, so a fit on it absorbs the effect being
  // measured, the same objection as `num_turns`, only weaker.
  produced: N(item, 'produced_lines'),
});

/** The store attributes `toRow` reads, plus the tag: the query projects only these. */
export const TREND_ATTRIBUTES = /** @type {const} */ ([
  'sk', 'tag', 'outcome', 'model', 'effort', 'config_fingerprint', 'total_cost_usd', 'changed_lines',
  'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'cache_write_tokens', 'duration_ms',
  'duration_api_ms', 'issue_body_chars', 'issue_paths_named', 'produced_lines',
]);

/** @param {number[]} xs @returns {number | null} */
export const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? /** @type {number} */ (s[m]) : (/** @type {number} */ (s[m - 1]) + /** @type {number} */ (s[m])) / 2;
};
/** @param {number[]} xs */
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/**
 * Two-sided 95% t quantile by degrees of freedom.
 *
 * A LOOKUP, because the alternative is a dependency this file may not have or a
 * continued-fraction approximation whose own error would need its own test. Exact to three
 * decimals for df <= 30 and 1.96 beyond, where the normal limit is within ~2%.
 *
 * WHAT THIS DOES AND DOES NOT FIX. A t interval is the right correction under normal residuals;
 * `log(cost)` is the scale that makes that plausible, which is why the fit is in logs. It does
 * not rescue a fit from df = 2: it makes the interval honest ENOUGH THAT df = 2 announces itself,
 * as a band so wide nothing can be "detected".
 * @param {number} df
 */
export const tQuantile95 = (df) => {
  const table = [
    12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
    2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
  ];
  if (!Number.isFinite(df) || df < 1) return /** @type {number} */ (table[0]);
  return df <= table.length ? /** @type {number} */ (table[df - 1]) : 1.96;
};

/**
 * THE SIZE REGRESSORS A FIT MAY KEY ON: two, and the list is closed on purpose.
 *
 * `diff` is the original control: `changed_lines` of a pull request the agent was HANDED.
 * `issue` is `issue_body_chars`, the size of the request an issue-triggered arm was handed, and
 * it is admitted per arm only by `validateSizeRegressor`. `issue_paths_named` is recorded but is
 * not a second issue regressor: trying two candidates and keeping whichever happens to clear the
 * bar is a multiple-comparisons machine.
 *
 * WHAT IS NOT HERE, and a unit test holds it out: `num_turns` and `produced_lines`. Both are
 * OUTCOMES of the run, so regressing cost on either absorbs the very effect being measured and
 * reports a confident ~0 every week.
 */
/** @param {number | null | undefined} v */
const logSize = (v) => (v === null || v === undefined || v < 0 ? null : Math.log(1 + v));
/** @typedef {{ name: string, label: string, need: string, x: (r: Row) => number | null }} Regressor */
export const REGRESSORS = Object.freeze({
  diff: /** @type {Regressor} */ (Object.freeze({ name: 'diff', label: 'diff size', need: 'a diff size', x: (/** @type {Row} */ r) => logSize(r.lines) })),
  issue: /** @type {Regressor} */ (Object.freeze({ name: 'issue', label: 'issue size', need: 'an issue size', x: (/** @type {Row} */ r) => logSize(r.issueChars) })),
});

/**
 * THE ADOPTION RULE for the issue-size regressor, stated once, here, and quoted by the report.
 *
 * A size control is only a control if cost actually moves with it. If it does not, fitting on it
 * changes nothing but the label, and the report would print "at equal issue size" over what is
 * really a raw comparison. So an arm adopts it only when, over the comparable (`ok`) runs of both
 * compared periods, the OLS slope of `log(cost)` on `log(1 + issue_body_chars)`:
 *
 *   - rests on at least `minN` runs;
 *   - has a 95% interval entirely ABOVE zero; and
 *   - is at least `minSlope` at its point estimate: an elasticity of 0.1 means doubling the issue
 *     moves cost by ~7%, below which the control removes nothing worth its label.
 *
 * POOLED ACROSS THE TWO PERIODS WITH NO PERIOD TERM, knowingly: if cost shifted between periods
 * AND the issue-size mix differs between them, the slope absorbs part of that shift. Three
 * conjunctive tests make a false adoption the less likely error. All three, every week, re-judged
 * on that week's rows. Failing any of them, the arm stays NOT SIZE-CONTROLLABLE and nothing stands
 * in: no turns-based proxy, no raw delta.
 */
export const ADOPTION = Object.freeze({ minN: 30, minSlope: 0.1 });

/**
 * @param {Row[]} rows @param {Regressor} [regressor]
 * @returns {{ regressor: string, n: number, slope: number | null, lo: number | null, hi: number | null, adopted: boolean, reason: string }}
 */
export const validateSizeRegressor = (rows, regressor = REGRESSORS.issue) => {
  const pts = rows
    .filter((r) => (r.cost ?? 0) > 0)
    .map((r) => /** @type {[number | null, number]} */ ([regressor.x(r), Math.log(/** @type {number} */ (r.cost))]))
    .filter(([x]) => x !== null)
    .map(([x, y]) => /** @type {[number, number]} */ ([/** @type {number} */ (x), y]));
  const n = pts.length;
  const base = { regressor: regressor.name, n, slope: null, lo: null, hi: null, adopted: false };
  if (n < 3) return { ...base, reason: `${n} run(s) carry ${regressor.need}; ${ADOPTION.minN} are needed` };
  const mx = sum(pts.map(([x]) => x)) / n;
  const my = sum(pts.map(([, y]) => y)) / n;
  const sxx = sum(pts.map(([x]) => (x - mx) ** 2));
  if (sxx < 1e-12) return { ...base, reason: `every run carries the same ${regressor.label}, so no slope is identified` };
  const slope = sum(pts.map(([x, y]) => (x - mx) * (y - my))) / sxx;
  const rss = sum(pts.map(([x, y]) => (y - my - slope * (x - mx)) ** 2));
  const se = Math.sqrt(Math.max(rss / (n - 2) / sxx, 0));
  const t = tQuantile95(n - 2);
  const lo = slope - t * se;
  const hi = slope + t * se;
  /** @type {string[]} */
  const fails = [];
  if (n < ADOPTION.minN) fails.push(`n=${n} of the ${ADOPTION.minN} needed`);
  if (!(lo > 0)) fails.push('its 95% interval reaches zero or below');
  if (slope < ADOPTION.minSlope) fails.push(`the slope is under ${ADOPTION.minSlope}`);
  return {
    ...base, slope, lo, hi,
    adopted: fails.length === 0,
    reason: fails.length ? fails.join('; ') : 'passes all three tests',
  };
};

/**
 * @typedef {{ ok: false, reason: string } | { ok: true, n: number, regressor: string, pct: number, loPct: number, hiPct: number, detected: boolean }} Effect
 */

/**
 * OLS for `log(cost) ~ 1 + size + isCurrentPeriod`, returning the period coefficient with its
 * standard error. `size` is `regressor.x`: `log(1 + changed_lines)` by default, or the issue size
 * for an arm that has no diff and has passed `validateSizeRegressor`.
 *
 * THE SECOND REGRESSOR IS THE WHOLE POINT. Without `log(lines)` this collapses to a raw
 * before/after on log cost, which is the statistic that called a cost rise a 6% win. Solved by
 * explicit 3x3 elimination rather than a matrix library, because of the no-dependency rule above.
 * @param {Row[]} rows @param {Regressor} [regressor]
 * @returns {Effect}
 */
export const fitPeriodEffect = (rows, regressor = REGRESSORS.diff) => {
  const usable = rows.filter((r) => (r.cost ?? 0) > 0 && regressor.x(r) !== null);
  const k = 3;
  if (usable.length < k + 2) return { ok: false, reason: `only ${usable.length} row(s) carry both a cost and ${regressor.need}` };
  const X = usable.map((r) => [1, /** @type {number} */ (regressor.x(r)), r.current ? 1 : 0]);
  const y = usable.map((r) => Math.log(/** @type {number} */ (r.cost)));
  // Refuse a rank-deficient fit rather than returning a confident number from a singular matrix:
  // if every usable row sits in one period, the coefficient is not identified.
  const periods = new Set(usable.map((r) => (r.current ? 1 : 0)));
  if (periods.size < 2) return { ok: false, reason: 'all usable rows fall in one period' };

  /** @param {number[]} row @param {number} i */
  const at = (row, i) => /** @type {number} */ (row[i]);
  const XtX = Array.from({ length: k }, (_, p) => Array.from({ length: k }, (_, q) => sum(X.map((x) => at(x, p) * at(x, q)))));
  const Xty = Array.from({ length: k }, (_, p) => sum(X.map((x, i) => at(x, p) * at(y, i))));
  let A = XtX.map((row, i) => [...row, ...Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < k; c += 1) {
    let piv = c;
    for (let r = c; r < k; r += 1) if (Math.abs(at(/** @type {number[]} */ (A[r]), c)) > Math.abs(at(/** @type {number[]} */ (A[piv]), c))) piv = r;
    if (Math.abs(at(/** @type {number[]} */ (A[piv]), c)) < 1e-12) return { ok: false, reason: 'the design matrix is singular' };
    [A[c], A[piv]] = [/** @type {number[]} */ (A[piv]), /** @type {number[]} */ (A[c])];
    const pivot = /** @type {number[]} */ (A[c]);
    const d = at(pivot, c);
    A[c] = pivot.map((v) => v / d);
    const scaled = /** @type {number[]} */ (A[c]);
    A = A.map((row, r) => {
      if (r === c) return row;
      const f = at(row, c);
      return row.map((v, j) => v - f * at(scaled, j));
    });
  }
  const inv = A.map((row) => row.slice(k));
  const beta = inv.map((row) => sum(row.map((v, q) => v * at(Xty, q))));
  const resid = y.map((v, i) => v - sum(/** @type {number[]} */ (X[i]).map((x, p) => x * at(beta, p))));
  const s2 = sum(resid.map((e) => e * e)) / (usable.length - k);
  const se = Math.sqrt(Math.max(s2 * at(/** @type {number[]} */ (inv[2]), 2), 0));
  // THE T QUANTILE, NOT 1.96, AND THE DIFFERENCE IS NOT COSMETIC. The fit is admitted at
  // n = k + 2 = 5, i.e. df = 2, where the 95% quantile is 4.303 rather than 1.96. With the normal
  // quantile the printed interval was up to 2.2x too narrow and its true coverage ~78-89%, turning
  // `lo > 0 || hi < 0` into a false-positive machine on exactly the thin arms nobody has a prior
  // for: "the report that finds a win every week".
  const t = tQuantile95(usable.length - k);
  const b2 = at(beta, 2);
  const lo = b2 - t * se;
  const hi = b2 + t * se;
  /** @param {number} b */
  const pct = (b) => (Math.exp(b) - 1) * 100;
  return { ok: true, n: usable.length, regressor: regressor.name, pct: pct(b2), loPct: pct(lo), hiPct: pct(hi), detected: lo > 0 || hi < 0 };
};

/**
 * What to CALL the window the figures were computed over. DERIVED, NEVER ASSUMED: if the report
 * cannot state its own window it must not state a wrong one. At the default the noun is "week".
 * @param {number} weekMs
 */
export const windowLabel = (weekMs) => {
  const days = Math.max(1, Math.round(weekMs / DAY_MS));
  return { days, noun: days === 7 ? 'week' : `${days}-day period` };
};

/** @param {number | null} v */
const money = (v) => (v === null ? '—' : `$${v.toFixed(2)}`);
// ONE DECIMAL UNDER 10%, and that is a correctness fix rather than polish: a lower bound of +0.4%
// rendered as "+0%" reads as an interval containing zero, contradicting the DETECTED verdict
// printed beside it. The reader believes the number, not the verdict.
/** @param {number} v */
const signed = (v) => `${v >= 0 ? '+' : ''}${Math.abs(v) < 10 ? v.toFixed(1) : v.toFixed(0)}%`;

/**
 * WHICH SIZE CONTROL AN ARM GETS. A diff size wherever the rows carry one. Only an arm with NO
 * diff size at all and an issue size on its rows is offered the issue regressor, and only through
 * the adoption test; `sizeCheck` carries that test's result so the report can print it whichever
 * way it went. There is no third branch: an arm with neither stays untestable.
 * @param {Row[]} rows
 * @returns {{ effect: Effect, sizeCheck: ReturnType<typeof validateSizeRegressor> | null }}
 */
export const sizeControl = (rows) => {
  const hasDiff = rows.some((r) => REGRESSORS.diff.x(r) !== null);
  if (hasDiff || !rows.some((r) => REGRESSORS.issue.x(r) !== null)) {
    return { effect: fitPeriodEffect(rows), sizeCheck: null };
  }
  const sizeCheck = validateSizeRegressor(rows);
  const effect = sizeCheck.adopted
    ? fitPeriodEffect(rows, REGRESSORS.issue)
    : /** @type {Effect} */ ({ ok: false, reason: 'no diff size, and its issue size has not passed the adoption test' });
  return { effect, sizeCheck };
};

/**
 * @typedef {{ lane: string, items: Item[], error?: string }} Partition
 * @typedef {ReturnType<typeof summarize>} Summary
 */

/**
 * @param {Partition[]} partitions @param {number} now @param {number} [weekMs]
 */
export const summarize = (partitions, now, weekMs = 7 * DAY_MS) => {
  const arms = [];
  /** @type {Array<{ lane: string, error: string }>} */
  const unreadable = [];
  for (const { lane, items, error } of partitions) {
    if (error) { unreadable.push({ lane, error }); continue; }
    const rows = items.filter(isRun).map(toRow).filter((r) => r.ts !== null);
    /** @param {Row} r */
    const inCur = (r) => /** @type {number} */ (r.ts) > now - weekMs;
    /** @param {Row} r */
    const inPrev = (r) => /** @type {number} */ (r.ts) > now - 2 * weekMs && /** @type {number} */ (r.ts) <= now - weekMs;
    // TWO POPULATIONS, AND CONFLATING THEM IS THE BUG THIS SHAPE EXISTS TO AVOID. `ok` answers "is
    // this row COMPARABLE": a run that died partway is not a sample of the same thing, so it is
    // excluded from the size-controlled fit. It does NOT answer "did this arm run this week" or
    // "what did the week cost": the week an arm burns money and produces nothing is the week this
    // report is most useful.
    const ok = rows.filter((r) => r.outcome === 'ok');
    const cur = ok.filter(inCur).map((r) => ({ ...r, current: true }));
    const prev = ok.filter(inPrev).map((r) => ({ ...r, current: false }));
    const curAll = rows.filter(inCur);
    // EVERY non-ok row still counts as SPEND: `failed`, `exhausted`, and also `unavailable` and
    // `not-reached`, which can still bill. Anything that is not `ok` produced nothing, so its bill
    // is the number most worth fixing and the one a report must not quietly drop.
    const wasted = curAll.filter((r) => r.outcome !== 'ok');
    arms.push({
      lane,
      curN: cur.length,
      prevN: prev.length,
      curAllN: curAll.length,
      prevAllN: rows.filter(inPrev).length,
      // The arm's real bill for the week, every outcome included.
      spend: sum(curAll.map((r) => r.cost ?? 0)),
      // Median of the COMPARABLE runs only, and labelled as such in the table.
      perRun: median(cur.map((r) => r.cost).filter((v) => v !== null)),
      wastedN: wasted.length,
      wastedSpend: sum(wasted.map((r) => r.cost ?? 0)),
      fingerprints: [...new Set(cur.map((r) => r.fingerprint).filter(Boolean))].sort(),
      prevFingerprints: [...new Set(prev.map((r) => r.fingerprint).filter(Boolean))].sort(),
      models: [...new Set(cur.map((r) => r.model).filter(Boolean))].sort(),
      ...sizeControl([...prev, ...cur]),
    });
  }
  return { arms, unreadable, now, weekMs };
};

/**
 * The report, in Markdown, for `token-trend.md`, which the Overseer pastes verbatim.
 * @param {Summary} summary
 */
export const render = ({ arms, unreadable, now, weekMs = 7 * DAY_MS }) => {
  const { days, noun } = windowLabel(weekMs);
  // PRESENCE IS ANY OUTCOME, not `ok`. An arm whose every run failed still ran, still cost money,
  // and is exactly what a reader needs to see.
  const active = arms.filter((a) => a.curAllN > 0 || a.prevAllN > 0);
  const out = [];
  const when = new Date(now).toISOString().slice(0, 10);
  out.push(`## Token efficiency — ${days} days to ${when}`, '');

  // THE UNREADABLE LIST IS BUILT BEFORE THE EARLY RETURN, because a store-wide failure (a role
  // change) is the likeliest real one, and must never render as "0 lane partition(s)".
  const unavailableLine = unreadable.length
    ? `**UNAVAILABLE:** could not read ${unreadable.map((u) => `\`${u.lane}\` (${u.error})`).join(', ')}: these arms are missing from every figure above.`
    : null;

  if (!active.length) {
    // NOT "spend was zero". No rows means this report did not measure the week.
    out.push(`**NO ROWS IN EITHER ${noun.toUpperCase()}** across ${arms.length} readable lane partition(s) of ${arms.length + unreadable.length} attempted: this report looked and learned nothing. Treat it as UNAVAILABLE, not as a quiet ${noun}.`);
    if (unavailableLine) out.push('', unavailableLine);
    return out.join('\n');
  }

  // THE HEADLINE IS THE WEEK'S WHOLE BILL, and "of which" contains the subset it names.
  const total = sum(active.map((a) => a.spend));
  const waste = sum(active.map((a) => a.wastedSpend));
  const runsAll = sum(active.map((a) => a.curAllN));
  const runsOk = sum(active.map((a) => a.curN));
  out.push(`**$${total.toFixed(2)} across ${runsAll} run(s)**, of which **$${waste.toFixed(2)} produced nothing** (${sum(active.map((a) => a.wastedN))} failed, turn-capped, or never reached the model). ${runsOk} run(s) finished and are comparable below.`, '');

  out.push(`| arm | runs (ok/all) | spend (all) | $/run (ok) | cost at EQUAL SIZE vs prior ${noun} |`, '|---|---|---|---|---|');
  for (const a of [...active].sort((x, y) => y.spend - x.spend)) {
    let verdict;
    const e = a.effect;
    if (!e.ok) verdict = `not testable — ${e.reason}`;
    else if (!e.detected) verdict = `**not detected** (point ${signed(e.pct)}, 95% CI ${signed(e.loPct)}…${signed(e.hiPct)}, n=${e.n})`;
    else verdict = `**${signed(e.pct)}** (95% CI ${signed(e.loPct)}…${signed(e.hiPct)}, n=${e.n})`;
    // NAME THE CONTROL WHEN IT IS NOT THE DIFF, so an issue-sized figure is never read as though it
    // had the Reviewer's much stronger denominator behind it.
    if (e.ok && e.regressor === 'issue') verdict += ' — at equal ISSUE size';
    out.push(`| \`${a.lane}\` | ${a.curN}/${a.curAllN} | $${a.spend.toFixed(2)} | ${money(a.perRun)} | ${verdict} |`);
  }
  out.push('');

  // WHAT CHANGED, so a movement has somewhere to be attributed. A fingerprint is the hash of an
  // arm's claude_args, so a new one means its configuration moved this week.
  const changed = active.filter((a) => a.prevFingerprints.length && a.fingerprints.length
    && a.fingerprints.join() !== a.prevFingerprints.join());
  if (changed.length) {
    out.push(`**Configuration changed this ${noun}:** ${changed.map((a) => `\`${a.lane}\` (${a.prevFingerprints.join('/')} → ${a.fingerprints.join('/')})`).join(', ')}`, '');
  } else {
    out.push(`**No arm changed its \`claude_args\` this ${noun}**: every fingerprint matches the prior ${noun}.`, '');
  }

  // HOW MUCH OF THE BILL THIS REPORT CANNOT TEST AT ALL. The size control needs `changed_lines`,
  // which the issue-triggered lanes never have. Stating the share stops the table reading as
  // "nothing moved" when the largest mover is simply not in it. NO PROXY IS OFFERED ON PURPOSE:
  // `num_turns` is an OUTCOME, and regressing cost on it reports a confident ~0 every week.
  const untestable = active.filter((a) => !a.effect.ok);
  const untestableSpend = sum(untestable.map((a) => a.spend));
  if (untestableSpend > 0) {
    // GROUPED BY THE REASON THE FIT ACTUALLY GAVE, so the sentence never contradicts the table.
    /** @type {Map<string, string[]>} */
    const byReason = new Map();
    for (const a of untestable) {
      const key = a.effect.ok ? 'not testable' : a.effect.reason;
      if (!byReason.has(key)) byReason.set(key, []);
      byReason.get(key)?.push(a.lane);
    }
    const detail = [...byReason.entries()]
      .map(([reason, lanes]) => `${lanes.map((x) => `\`${x}\``).join(', ')} — ${reason}`)
      .join('; ');
    out.push(`**${(untestableSpend / total * 100).toFixed(0)}% of this ${noun}'s spend ($${untestableSpend.toFixed(2)}) cannot be size-controlled:** ${detail}. Their movements are invisible to the column above; judge them on the spend column alone. (The issue-triggered lanes carry no \`changed_lines\`, because they have no pull request. They record the issue's size, which becomes their control only once it passes the adoption test below; no turns-based proxy stands in meanwhile.)`, '');
  }

  // THE ADOPTION TEST'S RESULT, EVERY WEEK, WHICHEVER WAY IT WENT. A control that quietly switched
  // on would change what the column means with nothing to say so.
  const checked = active.filter((a) => a.sizeCheck);
  if (checked.length) {
    /** @param {number} v */
    const fmt = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;
    const each = checked.map((a) => {
      const c = /** @type {NonNullable<typeof a.sizeCheck>} */ (a.sizeCheck);
      const slope = c.slope === null ? 'no slope' : `slope ${fmt(c.slope)} (95% CI ${fmt(/** @type {number} */ (c.lo))}…${fmt(/** @type {number} */ (c.hi))})`;
      return `\`${a.lane}\` — ${slope}, n=${c.n}: ${c.adopted ? '**ADOPTED**' : `**not adopted** (${c.reason})`}`;
    }).join('; ');
    out.push(`**Issue-size control:** ${each}. An arm adopts it only with n ≥ ${ADOPTION.minN} \`ok\` runs, a 95% interval on the slope of log(cost) on log(1 + issue chars) entirely above zero, and a slope of at least ${ADOPTION.minSlope}.`, '');
  }

  // THE DETECTION FLOOR, STATED. Without this a reader anchors on the point estimate and reads
  // noise as a trend.
  const testable = active.filter((a) => a.effect.ok);
  if (testable.length) {
    const widths = testable.map((a) => (a.effect.ok ? Math.abs(a.effect.hiPct - a.effect.loPct) / 2 : 0));
    out.push(`**Detection floor this ${noun}:** the tightest arm resolves a change of about ±${Math.min(...widths).toFixed(0)}%, the loosest about ±${Math.max(...widths).toFixed(0)}%. A delta inside its own interval is noise, not a trend: do not act on one.`, '');
  } else {
    // UNCONDITIONAL, and a unit test holds it that way: where NOTHING is testable is exactly where
    // a reader most needs telling.
    out.push(`**Detection floor this ${noun}: NOTHING WAS TESTABLE.** No arm carried enough runs with a size signal in both ${days === 7 ? 'weeks' : 'periods'} to fit the size control, so nothing above is evidence of a change in either direction: do not act on the spend column as though it were a trend.`, '');
  }
  // WHAT THE FINGERPRINT CAN'T SEE, said rather than implied away.
  out.push('`config_fingerprint` cannot see a change made through a step\'s `env:` rather than `claude_args` (a prompt-cache TTL pin, for example), nor a prompt edit, nor a Kanon upgrade: a movement with no changed fingerprint above may still have a configuration cause.');

  if (unavailableLine) out.push('', unavailableLine);
  return out.join('\n');
};
