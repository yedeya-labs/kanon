import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  DOES_NOT_CLAIM, OWN_HEADING, PageError, assertHeadings, assertNothingPrivate, main, renderPage,
} from '../../.github/scripts/metrics-page.mjs';
import { pageView } from '../../infra/telemetry/function/aggregate.mjs';
import { checkPage } from '../../scripts/aggregate-read.mjs';
import { IDLE_DAYS, MINIMUM } from '../../scripts/metrics/indicators.mjs';
import { releaseRows, winRows } from './helpers/release-rows.js';

/**
 * Plan 0003 M7 (kanon#661), §6.3: the public metrics page and its generator. The page shows the
 * headline, trend and Kanon-version views of each project that declared its figures publishable,
 * Kanon's health, and the transparency section. Every section of figures with fewer than three
 * adopters carries the generated heading "Measured on Kanon's own projects", with how many
 * projects that is and that the Owner runs all of them; the generator refuses a page that lacks
 * it, and a number below its minimum sample.
 */

const NOW = Date.parse('2026-10-07T12:00:00Z');
const LIVE = Math.floor(NOW / 1000) + 86_400;
const COMMIT = 'a'.repeat(40);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

const rows = (key: string, n: number) => Array.from({ length: n }, (_, k) => [
  { pk: `${key}#work`, row_kind: 'work_item', tag: 'run', recorded_at: '2026-10-01T10:00:00Z', expires_at: LIVE, pr_number: k + 1, closed_at: '2026-10-01T10:00:00Z', fate: 'merged', changed_lines: 100, author_kind: 'implementer', first_verdict: 'approved', human_commits: 0, human_cr_after_approval: 0, kanon_version: '0.39.0' },
  { pk: `${key}#implement`, row_kind: 'run', tag: 'run', recorded_at: '2026-09-30T10:00:00Z', expires_at: LIVE, lane: 'implement', total_cost_usd: k + 1, pr_number: k + 1 },
]).flat();
/** The page view as the read step hands it to the page job: computed by the function, checked by the reader. */
const pageOf = (n = 12): J => checkPage(JSON.parse(JSON.stringify(pageView([...rows('alpha', n), ...rows('beta', 3)], { now: NOW, own: { alpha: 'kanon', beta: 'second' } }))));
const health = (): J => ({
  schema: 'kanon-health/v1', computed_at: '2026-10-07T12:00:00.000Z',
  disputes: { disputes: 1, unreadable: 0, rules: [{ rule: 'K-PRIN-14', open: 1, closed: 0 }] },
  fixes: { filed: 3, open: 1, fixed: 2, closed_unfixed: 0, unreleased: 0, no_fix_link: 0, to_close: { n: 2, median_days: 1.5, p90_days: 2 }, to_release: { n: 2, median_days: 3, p90_days: 4 } },
  upgrade_lag: null,
});
const render = (page = pageOf(), h = health()) => renderPage({ page, health: h, release: '0.39.0', commit: COMMIT });

describe("the generator test (§6.3): a cell of fewer than three adopters carries the generated heading", () => {
  it("heads every section of figures from fewer than three adopters 'Measured on Kanon's own projects', with how many projects and that the Owner runs all of them", () => {
    const html = render();
    const section = /<section class="figures" data-adopters="1">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';
    expect(section.trimStart().startsWith(`<h2 id="own-projects">${OWN_HEADING}</h2>`)).toBe(true);
    expect(section).toContain("2 projects, and Kanon's Owner runs all of them");
    expect(section).toContain('kanon');
    expect(section).toContain('second');
    expect(() => assertHeadings(html)).not.toThrow();
  });

  it('fails a page whose section of figures from fewer than three adopters lacks the heading', () => {
    const html = render().replace(`<h2 id="own-projects">${OWN_HEADING}</h2>`, '<h2 id="own-projects">Figures</h2>');
    expect(() => assertHeadings(html)).toThrow(/fewer than 3 adopters.*without the heading/);
  });

  it('fails a page that drops the count of projects or who runs them', () => {
    expect(() => assertHeadings(render().replace("2 projects, and Kanon's Owner runs all of them", '2 projects'))).toThrow(/how many projects/);
  });

  it('fails a table of figures that sits in no section saying how many adopters it combines', () => {
    const html = render().replace('</main>', '<table class="figures"><tr><td>$1.00</td></tr></table></main>');
    expect(() => assertHeadings(html)).toThrow(/outside a section/);
    const unsaid = render().replace('data-adopters="1"', '');
    expect(() => assertHeadings(unsaid)).toThrow(/outside a section|how many adopters/);
  });

  it('asks the heading of a section only under three adopters: a cross-adopter section of three needs none', () => {
    const html = render().replace('data-adopters="1"', 'data-adopters="3"').replace(`<h2 id="own-projects">${OWN_HEADING}</h2>`, '<h2>Across adopters</h2>');
    expect(() => assertHeadings(html)).not.toThrow();
  });

  it('renders the heading from the data, never as a choice: the generator refuses its own page without it', () => {
    // renderPage runs assertHeadings on what it wrote, so a renderer that dropped the heading
    // would throw here rather than publish.
    expect(render()).toContain(OWN_HEADING);
    const noOwn = pageOf();
    noOwn.own = [];
    expect(render(noOwn)).not.toContain('data-adopters');
    expect(render(noOwn)).toContain('No project has declared its figures publishable');
  });
});

describe('the minimum samples on the page (§2.1, decision 11)', () => {
  it('shows a cell below its minimum as "not enough data (N)", never a number', () => {
    const html = render(pageOf(9));
    expect(html).toContain('not enough data (9)');
    expect(html).toContain('not enough data (3)');
  });

  it('refuses to publish a number from fewer items than its minimum, whatever the answer says', () => {
    const forged = pageOf(9);
    forged.own[0].headline.cost.pooled.median = { status: 'ok', n: 9, value: 5, low: 1, high: 9 };
    expect(() => render(forged)).toThrow(PageError);
    expect(() => render(forged)).toThrow(/below its minimum of 10/);
    const trend = pageOf(12);
    trend.own[0].trend[5].escape.d30 = { status: 'ok', n: 12, value: 0, low: 0, high: 0.2 };
    expect(() => render(trend)).toThrow(/below its minimum of 50/);
  });

  it('refuses an answer computed with other minimum samples than this release', () => {
    const other = pageOf();
    other.minimum = { ...other.minimum, median: 5 };
    expect(() => render(other)).toThrow(/minimum samples/);
  });
});

describe('every number states its window, band version, sample size, interval, release and where its command is (K-PRIN-14)', () => {
  let html = '';
  beforeAll(() => { html = render(); });
  it('states the window, the band version and the cost basis', () => {
    expect(html).toContain('2026-09-09 to 2026-10-07');
    expect(html).toContain('Band version 1');
    expect(html).toContain('API list price');
  });
  it('states each figure with its sample size and its 95% interval', () => {
    expect(html).toMatch(/\$6\.50 \(\$\d+\.\d{2} to \$\d+\.\d{2}\), n 12/);
  });
  it('states the release and commit it ran at, and where the commands are, without operator commands on the public page', () => {
    expect(html).toContain('Kanon 0.39.0');
    expect(html).toContain(COMMIT);
    expect(html).toContain('<code>docs/metrics.md</code> under "Reproduce a page"');
    expect(html).not.toMatch(/aggregate-read\.mjs|aws lambda|--function-name/);
  });
  it('says that a bail counts against yield only after the idle days, so a new project reads high', () => {
    expect(IDLE_DAYS).toBe(30);
    expect(html).toContain('<h3>When a bail counts against yield</h3>');
    expect(html).toContain('counts only once its issue has had no run for 30 days');
    expect(html).toContain("in a project's first 30 days");
    expect(html).toContain('the "no PR" figure has few or no items');
  });
  it('shows the trend and the by-version view', () => {
    expect(html).toContain('Trend, 6 windows of 28 days');
    expect(html).toMatch(/<td>0\.39\.0<\/td><td>12<\/td>/);
  });
});

describe('the transparency section (§6.3)', () => {
  let html = '';
  beforeAll(() => { html = render(); });
  it("says what each indicator doesn't claim, word for word from plan 0003 §2", () => {
    const plan = readFileSync('docs/plans/0003-metrics.md', 'utf8');
    const rowsOf = [...plan.matchAll(/^\| \*\*What it does not claim\*\* \| (.*) \|$/gm)].map((m) => m[1]);
    expect(rowsOf).toEqual([DOES_NOT_CLAIM.cost, DOES_NOT_CLAIM.yield, DOES_NOT_CLAIM.escape]);
    expect(html).toContain('Items with no run row at all (human-authored, §1.2) have no cost and are excluded, never counted as zero.');
    expect(html).toContain('so the rate is a <strong>lower bound</strong>.');
  });
  it('says what cost means, and that escape rates are lower bounds', () => {
    expect(html).toContain('not what anyone paid');
    expect(html).toContain('no translation to a subscription');
    expect(html).toMatch(/lower bounds/);
  });
});

describe('Kanon\'s health, as distributions and counts', () => {
  it('shows disputed rules and the time to fix #41\'s bugs, and says why upgrade lag is not here', () => {
    const html = render();
    expect(html).toContain('<td><code>K-PRIN-14</code></td><td>1</td><td>0</td>');
    expect(html).toMatch(/To the first release with the fix<\/td><td>2<\/td><td>3\.0<\/td><td>4\.0<\/td>/);
    expect(html).toContain('Upgrade lag');
  });
  it('refuses a health document of another schema, or a rule id the rulebook shape does not have', () => {
    expect(() => render(pageOf(), { ...health(), schema: 'kanon-health/v2' })).toThrow(/kanon-health\/v1/);
    const odd = health();
    odd.disputes.rules[0].rule = '<script>';
    expect(() => render(pageOf(), odd)).toThrow(/rule id/);
  });
});

describe('the page holds no key, login, repository name or account id', () => {
  it('names nothing but the labels the projects chose', () => {
    const html = render();
    for (const s of ['alpha', 'beta', 'github.com', '[bot]', 'arn:', 'lambda-url']) expect(html).not.toContain(s);
    expect(html).not.toMatch(/@/);
  });
  it('refuses a page that would', () => {
    // Built, not written out, so this file doesn't trip the public-tree guard. Each case holds
    // one kind alone, so each pattern has a case that only it refuses.
    const id = `${'123456'}${'789012'}`;
    expect(() => assertNothingPrivate(`<p>${id}</p>`)).toThrow(/account id/);
    expect(() => assertNothingPrivate('<p>arn:aws:s3:::bucket</p>')).toThrow(/ARN/);
    expect(() => assertNothingPrivate('<p>https://abc.lambda-url.eu-central-1.on.aws/</p>')).toThrow(/function URL/);
    expect(() => assertNothingPrivate('<p>someone[bot]</p>')).toThrow(PageError);
    expect(() => assertNothingPrivate('<p>https://github.com/o/r</p>')).toThrow(PageError);
    expect(() => assertNothingPrivate('<p>who@example.com</p>')).toThrow(PageError);
  });
  it('refuses a release or a commit that is not one', () => {
    expect(() => renderPage({ page: pageOf(), health: health(), release: 'v0.39.0; rm', commit: COMMIT })).toThrow(/release/);
    expect(() => renderPage({ page: pageOf(), health: health(), release: '0.39.0', commit: 'main' })).toThrow(/commit/);
  });
});

describe('the command', () => {
  it('writes nothing and says why on a bad input, and names its usage', () => {
    expect(main([]).code).toBe(2);
    expect(main(['--page', '/nonexistent/page.json', '--health', '/nonexistent/h.json', '--commit', COMMIT, '--out', '/tmp/x.html']).code).toBe(2);
  });
  it('writes the page into a directory that does not exist yet, as on the first run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metrics-page-'));
    writeFileSync(join(dir, 'page.json'), JSON.stringify(pageOf()));
    writeFileSync(join(dir, 'health.json'), JSON.stringify(health()));
    const out = join(dir, 'docs', 'metrics', 'index.html');
    const r = main(['--page', join(dir, 'page.json'), '--health', join(dir, 'health.json'), '--release', '0.39.0', '--commit', COMMIT, '--out', out]);
    expect(r.code).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(render());
  });
  it('reads the minimum samples it holds a page to from the report\'s own module', () => {
    expect(MINIMUM.median).toBe(10);
  });
});

describe('the release comparison on the page (kanon#1453)', () => {
  /** A page view whose project `kanon` has two releases, the newer a win, as the read hands it on. */
  const winPage = (): J => checkPage(JSON.parse(JSON.stringify(pageView(winRows('alpha', NOW), { now: NOW, own: { alpha: 'kanon' } }))));
  const rcOf = (p: J) => p.own[0].release_comparison;

  it('renders each comparison under its project, with its verdict wording, both releases and their item counts and dates', () => {
    const html = render(winPage());
    expect(html).toContain('<h4>Release comparison, over the trend\'s 168 days</h4>');
    expect(html).toMatch(/<td>0\.39\.0 → 0\.40\.0<\/td><td>−30\.\d% \(−\d+\.\d% to −\d+\.\d%\), n 200<\/td><td>[^<]+<\/td><td>[^<]+<\/td><td>win<\/td>/);
    expect(html).toMatch(/<td>0\.39\.0<\/td><td>100<\/td><td>\d{4}-\d{2}-\d{2}<\/td><td>\d{4}-\d{2}-\d{2}<\/td>/);
    expect(html).toContain('<h3>The release comparison</h3>');
    expect(html).toContain('not that the release caused the difference');
  });

  it('says so when fewer than two releases have enough items', () => {
    expect(render()).toContain('Fewer than two Kanon releases have 10 merged items in the span, so none is compared.');
  });

  it("reads a page view from a function that doesn't compute the comparison yet, and says so", () => {
    const raw = JSON.parse(JSON.stringify(pageView(winRows('alpha', NOW), { now: NOW, own: { alpha: 'kanon' } })));
    delete raw.own[0].release_comparison;
    const html = render(checkPage(raw));
    expect(html).toContain('This page view has no release comparison: the store\'s function was deployed from an earlier release.');
  });

  it('refuses, in the read, any field the comparison does not publish, and any verdict it does not have', () => {
    const raw = () => JSON.parse(JSON.stringify(pageView(winRows('alpha', NOW), { now: NOW, own: { alpha: 'kanon' } })));
    const reason = raw();
    reason.own[0].release_comparison.comparisons[0].costAtEqualSize.reason = 'text';
    expect(() => checkPage(reason)).toThrow(/costAtEqualSize holds `reason`/);
    const cells = raw();
    cells.own[0].release_comparison.comparisons[0].old.cost = 1;
    expect(() => checkPage(cells)).toThrow(/old holds `cost`/);
    const verdict = raw();
    verdict.own[0].release_comparison.comparisons[0].verdict = 'great';
    expect(() => checkPage(verdict)).toThrow(/verdict is not a verdict/);
    const dev = raw();
    dev.own[0].release_comparison.comparisons[0].old.version = 'dev';
    expect(() => checkPage(dev)).toThrow(/old\.version is not a release/);
    const status = raw();
    status.own[0].release_comparison.comparisons[0].escapeDifference = { status: 'no-fit', n: 3 };
    expect(() => checkPage(status)).toThrow(/escapeDifference is not an estimate/);
  });

  it('refuses a comparison that breaks a minimum, whatever the answer says', () => {
    const cases: [(rc: J) => void, RegExp][] = [
      [(rc) => { rc.comparisons[0].costAtEqualSize.n = 19; }, /costAtEqualSize: an estimate from 19 items is below its minimum of 20/],
      [(rc) => { rc.comparisons[0].yieldDifference.n = 19; }, /yieldDifference: an estimate from 19 items is below its minimum of 20/],
      [(rc) => { rc.comparisons[0].escapeDifference.n = 49; }, /escapeDifference: an estimate from 49 items is below its minimum of 50/],
      [(rc) => { rc.comparisons[0].new.items = 9; }, /a release from 9 items is below its minimum of 10/],
      [(rc) => { rc.minimum = 5; }, /release_comparison: computed with another minimum/],
      [(rc) => { rc.margins = { yield: -0.1, escape30: 0.02 }; }, /release_comparison: computed with other margins/],
    ];
    for (const [forge, refusal] of cases) {
      const p = winPage();
      forge(rcOf(p));
      expect(() => render(p), String(refusal)).toThrow(refusal);
    }
  });

  it('counts toward the fit\'s minimum only items with a cost above zero, as the fit does, so a $0 item never makes the page refuse (#1456)', () => {
    // Ten items in 0.39.0, three of them $0 (a delivery run that failed at its first turn), and
    // twelve in 0.40.0. Counting the $0 items, each release has its 10 and the fit runs on the 19
    // it can use, which the page refuses, writing no page. Counting usable rows, 0.39.0 has 7.
    const zero = new Set([1, 2, 3]);
    const stored = [
      ...releaseRows('alpha', '0.39.0', 1, 10, { now: NOW, days: [100, 160], scale: 1 }).map((r) => (r.row_kind === 'run' && zero.has(r.pr_number as number) ? { ...r, total_cost_usd: 0 } : r)),
      ...releaseRows('alpha', '0.40.0', 1001, 12, { now: NOW, days: [31, 95], scale: 0.7 }),
    ];
    const p = checkPage(JSON.parse(JSON.stringify(pageView(stored, { now: NOW, own: { alpha: 'kanon' } }))));
    expect(rcOf(p).comparisons[0].costAtEqualSize).toEqual({ status: 'not-enough-data', n: 7, minimum: MINIMUM.median });
    expect(rcOf(p).comparisons[0].verdict).toBe('not-enough-data');
    expect(() => render(p)).not.toThrow();
  });

  it("refuses a verdict its figures don't give: never a win without cost below zero and quality held", () => {
    const dearer = winPage();
    Object.assign(rcOf(dearer).comparisons[0].costAtEqualSize, { low: 5, high: 20 });
    expect(() => render(dearer)).toThrow(/verdict is not the one its figures give/);
    const quality = winPage();
    Object.assign(rcOf(quality).comparisons[0].escapeDifference, { high: 0.05 });
    expect(() => render(quality)).toThrow(/verdict is not the one its figures give/);
  });
});
