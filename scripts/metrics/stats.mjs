// The report's statistics (plan 0003 §2, decision 11): point estimates with their 95% intervals.
//
// - A median or a p90 of skewed cost: the distribution-free ORDER-STATISTIC interval, the ranks
//   around the quantile that the binomial says cover it 95% of the time (§2.2).
// - A ratio of sums (yield): a BOOTSTRAP over work items, every item's runs resampled together,
//   2,000 resamples from a FIXED SEED, so the same rows always give the same interval (§2.3).
// - A proportion (escape rate, approval, correction): the WILSON score interval, which behaves
//   at zero: 0 of 50 gives 0% to 7.1% (§2.4).
// - The band validity check (§3.6): Kendall's τ-b between band and cost, its interval by the same
//   seeded bootstrap.
//
// Pure, and imports nothing (`K-SELF-8`).

/** Every interval is 95% (§2.1). */
export const LEVEL = 0.95;
/** The normal quantile for a two-sided 95% interval. */
export const Z = 1.959963984540054;
/** The resamples a bootstrap draws (§2.3). */
export const RESAMPLES = 2000;
/** The bootstrap's fixed seed, so a report is reproducible (§2.3). */
export const SEED = 0x4b414e4f;

/**
 * A small, fast, seeded generator (mulberry32): the same seed gives the same sequence, so every
 * bootstrap is reproducible. Returns numbers in [0, 1).
 * @param {number} seed
 */
export function seededRandom(seed = SEED) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The median: the middle value, or the mean of the two middle values.
 * @param {readonly number[]} sorted ascending, not empty
 */
export function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? /** @type {number} */ (sorted[mid]) : (/** @type {number} */ (sorted[mid - 1]) + /** @type {number} */ (sorted[mid])) / 2;
}

/**
 * The q-quantile by nearest rank: the smallest value with at least a share q of the values at or
 * below it, so it is always a value some item cost (as the store's aggregate has its p90).
 * @param {readonly number[]} sorted ascending, not empty @param {number} q in (0, 1]
 */
export function quantile(sorted, q) {
  return /** @type {number} */ (sorted[Math.max(0, Math.ceil(q * sorted.length - 1e-9) - 1)]);
}

/**
 * The binomial CDF of Bin(n, p), F(k) = P(B ≤ k) for k = 0…n, computed in log space so a large n
 * doesn't underflow.
 * @param {number} n @param {number} p in (0, 1)
 * @returns {number[]}
 */
export function binomialCdf(n, p) {
  const lp = Math.log(p);
  const lq = Math.log(1 - p);
  let logC = 0;
  /** @type {number[]} */
  const cdf = [];
  let sum = 0;
  for (let k = 0; k <= n; k += 1) {
    if (k > 0) logC += Math.log(n - k + 1) - Math.log(k);
    sum += Math.exp(logC + k * lp + (n - k) * lq);
    cdf.push(Math.min(sum, 1));
  }
  return cdf;
}

/**
 * The distribution-free interval for the q-quantile of `sorted` (§2.2): the order statistics
 * X(l) and X(u), 1-based, with P(X(l) ≤ ξq ≤ X(u)) = P(l ≤ B ≤ u − 1) ≥ 95%, where B ~ Bin(n, q)
 * counts the values below ξq. Of the pairs that cover, the one with the fewest ranks between
 * them, then the one whose two tails are closest. Null when no pair covers: a median below n = 6,
 * a p90 below n = 29.
 * @param {readonly number[]} sorted ascending @param {number} q in (0, 1)
 * @returns {{ low: number, high: number, coverage: number, ranks: [number, number] } | null}
 */
export function orderStatisticInterval(sorted, q) {
  const n = sorted.length;
  if (n < 2) return null;
  const F = binomialCdf(n, q);
  /** P(B ≤ k), 0 below k = 0. @param {number} k */
  const cdf = (k) => (k < 0 ? 0 : /** @type {number} */ (F[k]));
  /** @type {{ l: number, u: number, coverage: number, imbalance: number } | null} */
  let best = null;
  // For each l, the smallest u that covers is the narrowest; it never falls as l rises, so one
  // pointer walks it.
  let u = 2;
  for (let l = 1; l < n; l += 1) {
    if (u <= l) u = l + 1;
    while (u <= n && cdf(u - 1) - cdf(l - 1) < LEVEL - 1e-12) u += 1;
    if (u > n) break;
    const coverage = cdf(u - 1) - cdf(l - 1);
    const imbalance = Math.abs(cdf(l - 1) - (1 - cdf(u - 1)));
    if (!best || u - l < best.u - best.l || (u - l === best.u - best.l && imbalance < best.imbalance)) best = { l, u, coverage, imbalance };
  }
  if (!best) return null;
  return { low: /** @type {number} */ (sorted[best.l - 1]), high: /** @type {number} */ (sorted[best.u - 1]), coverage: best.coverage, ranks: [best.l, best.u] };
}

/**
 * The Wilson score interval for x successes in n trials, 95%.
 * @param {number} x @param {number} n > 0
 * @returns {{ low: number, high: number }}
 */
export function wilson(x, n) {
  const p = x / n;
  const z2 = Z * Z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/**
 * The 2.5th and 97.5th percentiles of a statistic over `RESAMPLES` bootstrap resamples of
 * `units`, drawn with a generator seeded with `SEED`. A resample whose statistic is not a finite
 * number (a ratio with nothing below it) is drawn again, not counted.
 * @template T
 * @param {readonly T[]} units @param {(sample: T[]) => number} statistic
 * @param {{ resamples?: number, seed?: number }} [opts]
 * @returns {{ low: number, high: number } | null}
 */
export function bootstrap(units, statistic, { resamples = RESAMPLES, seed = SEED } = {}) {
  const n = units.length;
  if (n === 0) return null;
  const rand = seededRandom(seed);
  /** @type {number[]} */
  const stats = [];
  let tries = 0;
  while (stats.length < resamples && tries < resamples * 10) {
    tries += 1;
    /** @type {T[]} */
    const sample = [];
    for (let i = 0; i < n; i += 1) sample.push(/** @type {T} */ (units[Math.floor(rand() * n)]));
    const s = statistic(sample);
    if (Number.isFinite(s)) stats.push(s);
  }
  if (stats.length < resamples) return null;
  stats.sort((a, b) => a - b);
  const alpha = (1 - LEVEL) / 2;
  return { low: /** @type {number} */ (stats[Math.floor(alpha * resamples)]), high: /** @type {number} */ (stats[Math.ceil((1 - alpha) * resamples) - 1]) };
}

/**
 * Pairs below, equal and above between two ascending arrays: how many (x in a, y in b) have
 * x < y, x = y and x > y.
 * @param {readonly number[]} a @param {readonly number[]} b
 */
function crossPairs(a, b) {
  let less = 0;
  let equal = 0;
  // For each x in a, the count of y in b above x and equal to x, by two pointers.
  let i = 0; // b[0..i) ≤ x
  let j = 0; // b[0..j) < x
  for (const x of a) {
    while (j < b.length && /** @type {number} */ (b[j]) < x) j += 1;
    while (i < b.length && /** @type {number} */ (b[i]) <= x) i += 1;
    less += b.length - i;
    equal += i - j;
  }
  return { less, equal, more: a.length * b.length - less - equal };
}

/** Pairs tied within one ascending array. @param {readonly number[]} sorted */
function tiedPairs(sorted) {
  let ties = 0;
  let run = 1;
  for (let k = 1; k <= sorted.length; k += 1) {
    if (k < sorted.length && sorted[k] === sorted[k - 1]) run += 1;
    else { ties += (run * (run - 1)) / 2; run = 1; }
  }
  return ties;
}

/**
 * Kendall's τ-b between an ordinal group (a band, 0 = S … 3 = XL) and a value (cost), with ties on
 * both. NaN when either has no spread.
 * @param {readonly { group: number, value: number }[]} points
 */
export function kendallTauB(points) {
  const n = points.length;
  /** @type {Map<number, number[]>} */
  const byGroup = new Map();
  for (const p of points) {
    const g = byGroup.get(p.group);
    if (g) g.push(p.value);
    else byGroup.set(p.group, [p.value]);
  }
  const groups = [...byGroup.keys()].sort((a, b) => a - b).map((g) => /** @type {number[]} */ (byGroup.get(g)).sort((a, b) => a - b));
  let concordant = 0;
  let discordant = 0;
  let groupTies = 0;
  for (let a = 0; a < groups.length; a += 1) {
    const ga = /** @type {number[]} */ (groups[a]);
    groupTies += (ga.length * (ga.length - 1)) / 2;
    for (let b = a + 1; b < groups.length; b += 1) {
      const c = crossPairs(ga, /** @type {number[]} */ (groups[b]));
      concordant += c.less; // a lower band with a lower value
      discordant += c.more;
    }
  }
  const all = points.map((p) => p.value).sort((a, b) => a - b);
  const n0 = (n * (n - 1)) / 2;
  const denom = Math.sqrt((n0 - groupTies) * (n0 - tiedPairs(all)));
  return denom > 0 ? (concordant - discordant) / denom : Number.NaN;
}
