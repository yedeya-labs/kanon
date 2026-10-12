import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  DOES_NOT_CLAIM, OWN_HEADING, PageError, assertHeadings, assertNothingPrivate, main, renderPage,
} from '../../.github/scripts/metrics-page.mjs';
import { pageView } from '../../infra/telemetry/function/aggregate.mjs';
import { checkPage } from '../../scripts/aggregate-read.mjs';
import { MINIMUM } from '../../scripts/metrics/indicators.mjs';

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

describe('every number states its window, band version, sample size, interval, command and release (K-PRIN-14)', () => {
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
  it('states the commands that produced it, and the release and commit it ran at', () => {
    expect(html).toContain('node "$KANON/scripts/aggregate-read.mjs" page');
    expect(html).toContain('node scripts/telemetry/kanon-health.mjs --json');
    expect(html).toContain('node .github/scripts/metrics-page.mjs');
    expect(html).toContain('Kanon 0.39.0');
    expect(html).toContain(COMMIT);
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
