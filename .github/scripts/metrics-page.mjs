// The public metrics page's generator (plan 0003 M7, §6, kanon#661). It turns two documents
// into `docs/metrics/index.html`, which GitHub Pages serves from Kanon's own repository (§6.4,
// option A):
//
// 1. THE PAGE VIEW: the store's aggregate function's `?view=page` answer, read by
//    `scripts/aggregate-read.mjs page`. The headline, trend, Kanon-version views and release
//    comparison (kanon#1453) of each project that declared its figures publishable, each one adopter's own, under the label the
//    project chose. Nothing in it names a project, a person or an account.
// 2. KANON'S HEALTH: `scripts/telemetry/kanon-health.mjs --json`. Disputed rules and the time
//    to fix #41's bugs, read from Kanon's own issues.
//
// THE HEADING IS GENERATED, NEVER CHOSEN (§6.3). Every section of figures states how many
// adopters it combines in `data-adopters`. While that is fewer than three, the section opens
// with "Measured on Kanon's own projects", how many projects that is, and that Kanon's Owner
// runs all of them. `assertHeadings` refuses a page that breaks this, and `renderPage` runs it
// on its own output, so a page without the heading is never written.
//
// THE MINIMUM SAMPLES ARE CHECKED AGAIN HERE (§2.1). The function computes every estimate
// below its minimum as "not enough data (N)". This file holds each `ok` estimate to Kanon's
// own minimums once more, and refuses an answer computed with other minimums, so a function
// deployed from another release cannot publish a number from too few items. The release
// comparison is held to them too, to the A/B's margins, and to its verdict: each verdict must be
// the one `releaseVerdict` (`scripts/metrics/compare.mjs`, the report's own rule) gives its
// figures, so a function from another release can't publish a "win" its figures don't make.
//
// NOTHING PRIVATE. The page holds labels, numbers, dates, versions and rule ids, all checked
// against their patterns before they are written, and `assertNothingPrivate` refuses the
// written page if it holds an address, a login, a repository URL, a role ARN or an account id.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { RULE_IDS } from '../../actions/agent-telemetry/schema.mjs';
import { checkPage } from '../../scripts/aggregate-read.mjs';
import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';
import { AB_MARGINS, RELEASE_VERDICTS, releaseVerdict } from '../../scripts/metrics/compare.mjs';
import { IDLE_DAYS, MINIMUM } from '../../scripts/metrics/indicators.mjs';

/** The generated heading every section of figures from fewer than three adopters opens with (§6.3). */
export const OWN_HEADING = "Measured on Kanon's own projects";
/** Under this many adopters a section of figures is one project's own (plan 0002 decision 7). */
const MIN_ADOPTERS = 3;

/**
 * What each headline indicator does not claim, word for word from plan 0003 §2's tables. A test
 * compares them with the plan, so the page cannot drift from it.
 */
export const DOES_NOT_CLAIM = {
  cost: "What the adopter paid: on a subscription that is a different number, and decision 1 forbids translating. Nor the spend on work that never merged (that is efficiency, §2.3), the Explorer's, Overseer's and digests' spend (shown as **overhead**, beside, never inside), or the cost of human time. Items with no run row at all (human-authored, §1.2) have no cost and are excluded, never counted as zero.",
  yield: 'That unmerged spend was worthless: a bail that led to a split, or a PR closed because the plan changed, is still counted as not merged. Nor that the merged work was right (accuracy, §2.4).',
  escape: 'That an item with no link had no defect. Detection needs a link someone made (§3.5), so the rate is a **lower bound**. Nor does approval measure correctness: a lenient reviewer raises it. That is why approval is never shown without the escape rate and the human-correction rate.',
};

/** A page this file will not write, and why. Never holds a value from the inputs. */
export class PageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PageError';
  }
}

const RELEASE = /^\d+\.\d+\.\d+$/;
const COMMIT = /^[0-9a-f]{40}$/;
const LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// ── Checks ────────────────────────────────────────────────────────────────────────────────────

/**
 * The minimum an estimate is held to, from where it sits in the page view: its indicator, and
 * for cost its quantile. Null for a place no estimate goes.
 * @param {string[]} path
 */
function minimumAt(path) {
  const last = path[path.length - 1];
  // The release comparison's fit needs the median's minimum in each release, so twice it in all.
  if (path.includes('costAtEqualSize')) return 2 * MINIMUM.median;
  if (path.includes('yieldDifference')) return MINIMUM.yield;
  if (path.includes('escapeDifference')) return MINIMUM.escape;
  if (path.includes('validity')) return MINIMUM.validity;
  if (path.includes('cost')) return last === 'median' ? MINIMUM.median : last === 'p90' ? MINIMUM.p90 : null;
  if (path.includes('yield')) return MINIMUM.yield;
  if (path.includes('escape')) return MINIMUM.escape;
  if (path.includes('approval') || path.includes('correction')) return MINIMUM.proportion;
  return null;
}

/**
 * Every `ok` estimate's sample against Kanon's minimum for its indicator (§2.1). Throws on one
 * below it, or on an `ok` estimate where the page view has none.
 * @param {unknown} v @param {string[]} path
 */
function assertMinimums(v, path) {
  if (Array.isArray(v)) { v.forEach((x, k) => assertMinimums(x, [...path, String(k)])); return; }
  if (v === null || typeof v !== 'object') return;
  const o = /** @type {Record<string, unknown>} */ (v);
  const at = path.join('.');
  if (o.status === 'ok' || o.status === 'valid' || o.status === 'invalid') {
    const min = minimumAt(path);
    if (min === null) throw new PageError(`${at}: an estimate where the page view has none`);
    if (typeof o.n !== 'number' || o.n < min) throw new PageError(`${at}: an estimate from ${String(o.n)} items is below its minimum of ${min}`);
  }
  for (const [k, x] of Object.entries(o)) assertMinimums(x, [...path, k]);
}

/**
 * The page view, checked: the reader's strict shape, Kanon's own minimums and threshold, and
 * every estimate at or above its minimum.
 * @param {unknown} raw
 */
function checkedPage(raw) {
  /** @type {any} */
  let page;
  try {
    page = checkPage(raw);
  } catch (e) {
    throw new PageError(`the page view: ${/** @type {Error} */ (e).message}`);
  }
  if (!isDeepStrictEqual(page.minimum, { ...MINIMUM })) throw new PageError('the page view was computed with other minimum samples than this release holds (§2.1)');
  if (page.min_adopters < MIN_ADOPTERS) throw new PageError(`the page view's threshold is below ${MIN_ADOPTERS} adopters`);
  for (const [k, entry] of page.own.entries()) {
    if (!LABEL.test(entry.label)) throw new PageError(`own[${k}].label is not a label`);
    if (entry.by_version.minimum !== MINIMUM.median) throw new PageError(`own[${k}].by_version: computed with another minimum`);
    for (const v of entry.by_version.versions) {
      if (v.items < MINIMUM.median) throw new PageError(`own[${k}].by_version: a version from ${v.items} items is below its minimum of ${MINIMUM.median}`);
    }
    if (entry.release_comparison) checkComparison(entry.release_comparison, `own[${k}].release_comparison`);
    assertMinimums(entry, [`own[${k}]`]);
  }
  return page;
}

/**
 * A release comparison held to this release's minimum and margins, each release to the median's
 * minimum of items, and each verdict to the one its figures give (kanon#1453).
 * @param {any} rc @param {string} at
 */
function checkComparison(rc, at) {
  if (rc.minimum !== MINIMUM.median) throw new PageError(`${at}: computed with another minimum`);
  if (!isDeepStrictEqual(rc.margins, { ...AB_MARGINS })) throw new PageError(`${at}: computed with other margins than this release holds (decision 11)`);
  for (const [i, c] of rc.comparisons.entries()) {
    for (const r of [c.old, c.new]) {
      if (r.items < MINIMUM.median) throw new PageError(`${at}.comparisons[${i}]: a release from ${r.items} items is below its minimum of ${MINIMUM.median}`);
    }
    const cost = c.costAtEqualSize;
    const given = releaseVerdict({
      costAtEqualSize: cost.status === 'ok' ? { ok: true, loPct: cost.low, hiPct: cost.high } : { ok: false },
      yieldDifference: c.yieldDifference,
      escapeDifference: c.escapeDifference,
    });
    if (c.verdict !== given) throw new PageError(`${at}.comparisons[${i}]: its verdict is not the one its figures give`);
  }
}

/** @param {unknown} v */
const isCount = (v) => Number.isInteger(v) && /** @type {number} */ (v) >= 0;
/** @param {unknown} d */
const isDist = (d) => d === null || (typeof d === 'object' && isDeepStrictEqual(Object.keys(d).sort(), ['median_days', 'n', 'p90_days'])
  && isCount(/** @type {any} */ (d).n) && Number.isFinite(/** @type {any} */ (d).median_days) && Number.isFinite(/** @type {any} */ (d).p90_days));

/**
 * Kanon's health document, checked: its schema, counts that are counts, distributions that are
 * distributions, and rule ids the rulebook has.
 * @param {any} h
 */
function checkedHealth(h) {
  if (!h || h.schema !== 'kanon-health/v1') throw new PageError('the health document is not kanon-health/v1');
  if (typeof h.computed_at !== 'string' || !INSTANT.test(h.computed_at)) throw new PageError('the health document has no time it was computed');
  const d = h.disputes;
  if (!d || !isCount(d.disputes) || !isCount(d.unreadable) || !Array.isArray(d.rules)) throw new PageError('the health document\'s disputes are not counts');
  for (const r of d.rules) {
    if (!RULE_IDS.includes(r?.rule)) throw new PageError('the health document holds a rule id the rulebook does not have');
    if (!isCount(r.open) || !isCount(r.closed)) throw new PageError('the health document\'s disputes are not counts');
  }
  const f = h.fixes;
  if (!f || !['filed', 'open', 'fixed', 'closed_unfixed', 'unreleased', 'no_fix_link'].every((k) => isCount(f[k]))) throw new PageError('the health document\'s fixes are not counts');
  if (!isDist(f.to_close) || !isDist(f.to_release)) throw new PageError('the health document\'s times to fix are not distributions');
  return h;
}

/**
 * Throws unless every section of figures says how many adopters it combines, and every one of
 * fewer than three opens with the generated heading and says how many projects that is and that
 * Kanon's Owner runs all of them. A table of figures outside such a section throws too (§6.3).
 * @param {string} html
 */
export function assertHeadings(html) {
  let rest = html;
  for (const [whole, attrs, body] of html.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/g)) {
    if (!/\bclass="figures"/.test(/** @type {string} */ (attrs))) continue;
    const said = /\bdata-adopters="(\d+)"/.exec(/** @type {string} */ (attrs));
    if (!said) throw new PageError('a section of figures does not say how many adopters it combines');
    const adopters = Number(said[1]);
    if (adopters < MIN_ADOPTERS) {
      if (!/** @type {string} */ (body).trimStart().startsWith(`<h2 id="own-projects">${OWN_HEADING}</h2>`)) {
        throw new PageError(`a section of figures from fewer than ${MIN_ADOPTERS} adopters (${adopters}) is published without the heading "${OWN_HEADING}"`);
      }
      if (!/\b\d+ projects?, and Kanon's Owner runs all of them\b/.test(/** @type {string} */ (body))) {
        throw new PageError("a section of Kanon's own projects does not say how many projects it is and that Kanon's Owner runs them");
      }
    }
    rest = rest.replace(whole, '');
  }
  if (/<table\b[^>]*\bclass="figures"/.test(rest)) throw new PageError('a table of figures sits outside a section that says how many adopters it combines');
}

/** What the page must never hold: an address or login, a repository URL, a function URL, an ARN, an account id. */
const PRIVATE = [
  [/@/, 'an @'],
  [/\[bot\]/, 'a bot login'],
  [/github\.com/i, 'a GitHub URL'],
  [/lambda-url/i, 'a function URL'],
  [/\barn:/i, 'an ARN'],
  [/(?<![0-9a-f])\d{12}(?![0-9a-f])/, 'an account id'],
];

/** Throws if the page holds anything `PRIVATE` names. Names the kind, never the text. @param {string} html */
export function assertNothingPrivate(html) {
  for (const [re, what] of /** @type {[RegExp, string][]} */ (PRIVATE)) if (re.test(html)) throw new PageError(`the page would hold ${what}`);
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────

/** Text content, escaped. Values never go in attributes. @param {string | number} s */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** The plan's text, escaped, with its `**bold**` as `<strong>`. @param {string} s */
const prose = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

/** @param {number} v */
const dollars = (v) => `$${v.toFixed(2)}`;
/** @param {number} v */
const percent = (v) => `${(v * 100).toFixed(1)}%`;
/** @param {number} v */
const days = (v) => v.toFixed(1);

/**
 * One estimate as a cell: the value, its 95% interval and its sample, or why there is none.
 * @param {any} e @param {(v: number) => string} fmt
 */
function cell(e, fmt) {
  if (!e) return '—';
  if (e.status === 'not-enough-data') return `not enough data (${e.n})`;
  if (e.status === 'no-spend') return `no spend (${e.n})`;
  const ci = e.low !== null && e.high !== null ? ` (${fmt(e.low)} to ${fmt(e.high)})` : ' (no interval)';
  return `${fmt(e.value)}${ci}, n ${e.n}`;
}

/** @param {string[]} cells */
const tr = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
/** @param {string[]} head @param {string[][]} body */
const table = (head, body) => `<table class="figures"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>\n${body.map(tr).join('\n')}\n</tbody></table>`;

const BANDS = ['pooled', 'S', 'M', 'L', 'XL', 'none', 'noPr'];
/** @param {string} b */
const bandName = (b) => (b === 'pooled' ? 'all bands' : b === 'noPr' ? 'no PR' : b === 'none' ? 'no band' : `band ${b}`);
/** @param {Record<string, number>} mix */
const mixText = (mix) => Object.entries(mix).filter(([, n]) => n > 0).map(([b, n]) => `${b === 'noPr' ? 'no PR' : b} ${n}`).join(', ') || 'none';

/** The headline of one project: each indicator by band (or pooled), with approval and correction beneath. @param {any} h */
function headlineTable(h) {
  /** @type {string[][]} */
  const body = [];
  /** @param {string} name @param {Record<string, any>} cells @param {(c: any) => any} pick @param {(v: number) => string} fmt */
  const rows = (name, cells, pick, fmt) => {
    for (const b of BANDS) if (cells[b]) body.push([esc(name), esc(bandName(b)), esc(cell(pick(cells[b]), fmt)), esc(mixText(cells[b].bandMix ?? {}))]);
  };
  rows('Cost per merged item, median', h.cost, (c) => c.median, dollars);
  rows('Cost per merged item, p90', h.cost, (c) => c.p90, dollars);
  rows('Yield, share of delivery spend merged', h.yield, (c) => c.yield, percent);
  for (const d of ['d30', 'd90']) {
    const e = h.escape[d];
    rows(`Escape rate, ${d.slice(1)} days (merged ${e.merged_from} to ${e.merged_until})`, e.cells, (c) => c.rate, percent);
  }
  rows('Approval rate', h.approval, (c) => c.rate, percent);
  rows('Human-correction rate', h.correction, (c) => c.rate, percent);
  return table(['Indicator', 'Band', 'Value (95% interval), sample', 'Band mix'], body);
}

/** The columns the trend and the version views share. @param {any} r */
const indicatorCells = (r) => [
  cell(r.cost.median, dollars), cell(r.cost.p90, dollars), cell(r.yield, percent),
  cell(r.escape.d30, percent), cell(r.escape.d90, percent), cell(r.approval, percent), cell(r.correction, percent),
].map(esc);
const INDICATOR_HEAD = ['Cost, median', 'Cost, p90', 'Yield', 'Escape, 30 d', 'Escape, 90 d', 'Approval', 'Correction'];

/** @param {any} validity */
function validityText(validity) {
  if (validity.status === 'not-enough-data') return `The band validity check has not enough data (${validity.n}), so the figures are pooled across bands.`;
  const tau = `τ ${validity.tau} (${validity.low} to ${validity.high}), n ${validity.n}`;
  return validity.status === 'valid'
    ? `The band validity check passed: cost rises with band, ${tau}. The figures are shown by band.`
    : `The band validity check did not show cost rising with band, ${tau}, so the figures are pooled across bands.`;
}

/** A signed percentage, a true minus sign below zero. @param {number} v */
const signedPct = (v) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)}%`;
/** A difference of shares in percentage points. @param {number} v */
const points = (v) => `${v < 0 ? '−' : '+'}${Math.abs(v * 100).toFixed(1)} points`;

/**
 * One difference of the release comparison as a cell: the value, its 95% interval and its
 * sample, or why there is none.
 * @param {any} d @param {(v: number) => string} fmt
 */
function differenceCell(d, fmt) {
  if (d.status === 'ok') return `${fmt(d.value)} (${fmt(d.low)} to ${fmt(d.high)}), n ${d.n}`;
  if (d.status === 'not-enough-data') return `not enough data (${d.n} of ${d.minimum})`;
  if (d.status === 'no-spend') return `no spend (${d.n})`;
  return `no fit (${d.n})`;
}

/** One project's release comparison (kanon#1453). @param {any} rc @param {any} page */
function releaseComparison(rc, page) {
  const head = `<h4>Release comparison, over the trend's ${esc(page.trend_windows * page.window_days)} days</h4>`;
  if (!rc) return `${head}\n<p>This page view has no release comparison: the store's function was deployed from an earlier release.</p>`;
  const fewer = `Releases with fewer than ${esc(rc.minimum)} merged items, not compared and not pooled: ${esc(rc.fewer.length ? rc.fewer.map((/** @type {any} */ f) => `${f.version} (${f.items})`).join(', ') : 'none')}. Merged items on dev, not a release: ${esc(rc.dev)}.`;
  if (!rc.comparisons.length) return `${head}\n<p>Fewer than two Kanon releases have ${esc(rc.minimum)} merged items in the span, so none is compared. ${fewer}</p>`;
  const rows = rc.comparisons.map((/** @type {any} */ c) => [
    esc(`${c.old.version} → ${c.new.version}`), esc(differenceCell(c.costAtEqualSize, signedPct)), esc(differenceCell(c.yieldDifference, points)),
    esc(differenceCell(c.escapeDifference, points)), esc(RELEASE_VERDICTS[/** @type {keyof typeof RELEASE_VERDICTS} */ (c.verdict)]),
  ]);
  const releases = rc.comparisons.flatMap((/** @type {any} */ c, /** @type {number} */ k) => (k === 0 ? [c.old, c.new] : [c.new]))
    .map((/** @type {any} */ r) => [esc(r.version), esc(r.items), esc(r.from), esc(r.until)]);
  return `${head}
${table(['Old → new', 'Cost at equal size, new against old', 'Yield, new − old', 'Escapes at 30 days, new − old', 'Verdict'], rows)}
${table(['Kanon release', 'Merged items', 'Closed from', 'Closed until'], releases)}
<p>${fewer}</p>`;
}

/** One project's own figures: the headline, the trend, the Kanon-version view and the release comparison. @param {any} p @param {any} page */
function project(p, page) {
  const trend = p.trend.map((/** @type {any} */ w) => [esc(`${w.window.from} to ${w.window.until}`), ...indicatorCells(w), esc(mixText(w.bandMix)), esc(w.versionsIntroduced.join(', ') || '—')]);
  const bv = p.by_version;
  const versions = bv.versions.map((/** @type {any} */ v) => [esc(v.version), esc(v.items), ...indicatorCells(v)]);
  const fewer = bv.fewer.length ? ` Versions with fewer than ${bv.minimum} items are not shown alone: ${esc(bv.fewer.map((/** @type {any} */ v) => `${v.version} (${v.items})`).join(', '))}.` : '';
  return `<article>
<h3>Project: ${esc(p.label)}</h3>
<p>Window ${esc(p.window.from)} to ${esc(p.window.until)} (${esc(p.window.days)} days). Band version ${esc(page.band_version)}. Cost at ${esc(page.cost_basis)}. ${esc(validityText(p.headline.validity))}</p>
<h4>Headline</h4>
${headlineTable(p.headline)}
<h4>Trend, ${esc(page.trend_windows)} windows of ${esc(page.window_days)} days</h4>
${table(['Window', ...INDICATOR_HEAD, 'Band mix', 'Versions first seen'], trend)}
<h4>By Kanon version, over the trend's ${esc(page.trend_windows * page.window_days)} days</h4>
${versions.length ? table(['Kanon version', 'Items', ...INDICATOR_HEAD], versions) : '<p>No Kanon version has enough items to show alone.</p>'}
<p>${esc(bv.unversioned)} items carry no Kanon version.${fewer}</p>
${releaseComparison(p.release_comparison, page)}
</article>`;
}

/** The figures of every declared project, under the generated heading while fewer than three adopters exist. @param {any} page */
function figures(page) {
  if (!page.own.length) return '<p>No project has declared its figures publishable yet.</p>';
  const n = page.own.length;
  // Each entry is one adopter's own figures (`adopters: 1`, checked by the reader), and no
  // figure on this page combines adopters, so the section is as many adopters as its largest
  // entry: one.
  const adopters = Math.max(...page.own.map((/** @type {any} */ p) => p.adopters));
  const heading = adopters < MIN_ADOPTERS
    ? `<h2 id="own-projects">${OWN_HEADING}</h2>
<p>These figures come from ${n} project${n === 1 ? '' : 's'}, and Kanon's Owner runs all of them. Each project is shown alone, under the label it chose; no figure combines projects. Figures across adopters are published only once at least ${page.min_adopters} adopters declare theirs.</p>`
    : '<h2>Across adopters</h2>';
  return `<section class="figures" data-adopters="${adopters}">
${heading}
${page.own.map((/** @type {any} */ p) => project(p, page)).join('\n')}
</section>`;
}

/** @param {any} d */
const distCells = (d) => (d ? [esc(d.n), esc(days(d.median_days)), esc(days(d.p90_days))] : ['0', '—', '—']);

/** Kanon's health: disputed rules and the time to fix #41's bugs (§6.2). @param {any} h */
function health(h) {
  const rules = h.disputes.rules.map((/** @type {any} */ r) => `<tr><td><code>${esc(r.rule)}</code></td><td>${esc(r.open)}</td><td>${esc(r.closed)}</td></tr>`).join('\n');
  const f = h.fixes;
  return `<section id="health">
<h2>Kanon's health</h2>
<p>Read from Kanon's own issues at ${esc(h.computed_at)}.</p>
<h3>Disputed rules</h3>
<p>${esc(h.disputes.disputes)} disputes filed with the "Dispute a rule" form; ${esc(h.disputes.unreadable)} name no rule the rulebook has.</p>
${rules ? `<table class="health"><thead><tr><th>Rule</th><th>Open</th><th>Closed</th></tr></thead><tbody>\n${rules}\n</tbody></table>` : '<p>No rule is disputed.</p>'}
<h3>Time to fix a bug reported against Kanon</h3>
<p>${esc(f.filed)} filed: ${esc(f.open)} open, ${esc(f.fixed)} fixed, ${esc(f.closed_unfixed)} closed unfixed; ${esc(f.unreleased)} fixed but not yet released; ${esc(f.no_fix_link)} closed with no linked fix.</p>
<table class="health"><thead><tr><th>Interval</th><th>Bugs</th><th>Median, days</th><th>p90, days</th></tr></thead><tbody>
<tr><td>To the fix closing it</td><td>${distCells(f.to_close).join('</td><td>')}</td></tr>
<tr><td>To the first release with the fix</td><td>${distCells(f.to_release).join('</td><td>')}</td></tr>
</tbody></table>
<h3>Upgrade lag</h3>
<p>Not on this page. It is read from adopters' rows, and is published only once at least 3 adopters declare theirs.</p>
</section>`;
}

/** How the numbers are made, what they do not claim, and how to reproduce them (§6.3). @param {any} page @param {string} release @param {string} commit */
function transparency(page, release, commit) {
  const m = page.minimum;
  return `<section id="transparency">
<h2>How these numbers are made</h2>
<h3>Where they come from</h3>
<p>Each project's runs and work items, as Kanon's telemetry store holds them. The store's aggregate function reads the rows and answers estimates and counts, never a row. A project appears here only when its operator declared its figures publishable under a label of their choosing; the label is the only name this page holds.</p>
<h3>What cost means</h3>
<p>Cost is the ${esc(page.cost_basis)} of the tokens a run reported, not what anyone paid. On a subscription the amount paid is a different number, and there is no translation to a subscription.</p>
<h3>What each indicator does not claim</h3>
<dl>
<dt>Cost per merged item</dt><dd>${prose(DOES_NOT_CLAIM.cost)}</dd>
<dt>Yield</dt><dd>${prose(DOES_NOT_CLAIM.yield)}</dd>
<dt>Escape rates</dt><dd>${prose(DOES_NOT_CLAIM.escape)}</dd>
</dl>
<h3>The detection gap</h3>
<p>An escape is counted only when someone linked a revert or a fix to the item. A defect nobody linked is not counted, so the escape rates are lower bounds.</p>
<h3>When a bail counts against yield</h3>
<p>A merged item counts in the window it closes in. A run that stopped before opening a pull request counts only once its issue has had no run for ${esc(IDLE_DAYS)} days, so that a run still being retried isn't counted as abandoned. So in a project's first ${esc(IDLE_DAYS)} days, and for ${esc(IDLE_DAYS)} days after any burst of such runs, yield reads high, and the "no PR" figure has few or no items, until they settle.</p>
<h3>The release comparison</h3>
<p>Each Kanon release with at least ${esc(m.median)} merged items over the trend's span is compared with the one before it that has as many; an item is in the release its lanes pinned at its merge. A release with fewer items is listed, and pooled with no other. Cost is compared at equal size: a log-linear fit of log cost on log(1 + changed lines) and the release, which needs ${esc(m.median)} merged items with a cost and a diff size in each release, and gives the newer release's cost change in percent with its 95% interval. A release is a <strong>win</strong> only if that interval is entirely below zero and its quality holds within the margins, new minus old: yield's lower bound above ${esc(points(AB_MARGINS.yield))} and the 30-day escape rate's upper bound below ${esc(points(AB_MARGINS.escape30))} (a bootstrap interval for yield from ${esc(m.yield)} items in each release, Newcombe's for escapes from ${esc(m.escape)}). Cheaper without that is "cheaper, quality not shown to hold"; an interval entirely above zero is "dearer"; one that holds zero, "no measurable change". It says whether a release was cheaper at equal size, not that the release caused the difference: anything else that changed between the two releases' items, the model, a lane's configuration or the kind of work beyond its size, is read as the release's. A release whose items merged less than 30 days ago has too few matured items for the escape difference, so it reads "cheaper, quality not shown to hold" until they mature.</p>
<h3>Bands, windows, samples and intervals</h3>
<p>Band version ${esc(page.band_version)}. Each window is ${esc(page.window_days)} days and ends at the start of the UTC day the page was computed. The figures are shown by band only when the band validity check finds cost rising with band (a Kendall τ-b interval above zero, from at least ${esc(m.validity)} items); otherwise they are pooled, with the band mix beside them.</p>
<p>Each figure shows its value, its 95% interval and its sample (n). Medians and p90s use an order-statistic interval, rates a Wilson interval, and yield a bootstrap of ${esc(page.bootstrap.resamples)} resamples with seed ${esc(page.bootstrap.seed)}. A figure from fewer items than its minimum shows "not enough data (N)": ${esc(m.median)} for a median, ${esc(m.p90)} for a p90, ${esc(m.proportion)} for approval and correction, ${esc(m.yield)} for yield, and ${esc(m.escape)} for an escape rate.</p>
<h3>How to reproduce them</h3>
<p>Computed at ${esc(page.computed_at)}, and generated by Kanon ${esc(release)} at commit <code>${esc(commit)}</code>. The store's operator regenerates the page each week from the store's aggregate function, which only the operator can call. The commands are in Kanon's repository, in <code>docs/metrics.md</code> under "Reproduce a page", and the method is above.</p>
</section>`;
}

const STYLE = 'body{font-family:system-ui,sans-serif;max-width:72rem;margin:2rem auto;padding:0 1rem;line-height:1.5}table{border-collapse:collapse;margin:0.5rem 0 1rem;font-size:0.9rem}th,td{border:1px solid #ccc;padding:0.25rem 0.5rem;text-align:left;vertical-align:top}th{background:#f4f4f4}code,pre{font-size:0.85rem}pre{overflow-x:auto;background:#f4f4f4;padding:0.5rem}dt{font-weight:bold}';

/**
 * The page, as HTML. Checks its inputs, and its own output with `assertHeadings` and
 * `assertNothingPrivate`, before it returns: a page that fails is never returned.
 * @param {{ page: unknown, health: unknown, release: string, commit: string }} input
 */
export function renderPage({ page: rawPage, health: rawHealth, release, commit }) {
  if (typeof release !== 'string' || !RELEASE.test(release)) throw new PageError('the release is not a Kanon version');
  if (typeof commit !== 'string' || !COMMIT.test(commit)) throw new PageError('the commit is not a full commit sha');
  const page = checkedPage(rawPage);
  const h = checkedHealth(rawHealth);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kanon metrics</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Kanon metrics</h1>
<p>Cost per merged item, yield and escape rates, always shown together, with approval and the human-correction rate beneath (plan 0003). Computed at ${esc(page.computed_at)}; generated by Kanon ${esc(release)} at commit <code>${esc(commit)}</code>. How each number is made, and how to reproduce it, is <a href="#transparency">below</a>.</p>
${figures(page)}
${health(h)}
${transparency(page, release, commit)}
</main>
</body>
</html>
`;
  assertHeadings(html);
  assertNothingPrivate(html);
  return html;
}

// ── The command ───────────────────────────────────────────────────────────────────────────────

const USAGE = 'usage: node .github/scripts/metrics-page.mjs --page <page.json> --health <health.json> --release <x.y.z> --commit <sha> --out <index.html>';

/**
 * Reads the two documents, renders the page and writes it. Writes nothing on any error.
 * @param {string[]} argv
 * @returns {{ code: number, message: string }}
 */
export function main(argv) {
  /** @type {Record<string, string>} */
  const opts = {};
  for (let k = 0; k < argv.length; k += 2) {
    const flag = argv[k] ?? '';
    const value = argv[k + 1];
    if (!['--page', '--health', '--release', '--commit', '--out'].includes(flag) || value === undefined) return { code: 2, message: USAGE };
    opts[flag.slice(2)] = value;
  }
  const { page, health: healthFile, release, commit, out } = opts;
  if (!page || !healthFile || !release || !commit || !out) return { code: 2, message: USAGE };
  let html;
  try {
    html = renderPage({
      page: JSON.parse(readFileSync(page, 'utf8')),
      health: JSON.parse(readFileSync(healthFile, 'utf8')),
      release,
      commit,
    });
  } catch (e) {
    // A PageError's message names a place, never a value; a read or parse error names a path
    // the caller gave.
    return { code: 2, message: `metrics-page: ${/** @type {Error} */ (e).message}` };
  }
  // The first run has no docs/metrics/ yet.
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  return { code: 0, message: `metrics-page: wrote ${out}` };
}

if (isCliEntry(import.meta.url)) {
  const { code, message } = main(process.argv.slice(2));
  (code ? console.error : console.log)(message);
  process.exit(code);
}
