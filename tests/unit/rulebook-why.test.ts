import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #249: a rule's **Why.** describes the incident that taught it in general terms, "without
// naming the project it happened in, its issues or its files" (rulebook/README.md, the shape
// every rule follows). An adopter reads the rule, not Kanon's tracker, so a Why that points
// at an issue or a test file explains nothing to them.
//
// What this can decide by reading, and so what it fails on:
// - a link to an issue, a pull request, a commit or a file on GitHub (`github.com/o/r/issues/n`);
// - a bare issue reference (`#233`), or the reference adopter's (`RA-936`, #345);
// - a path into the repository's own tests, workflows, scripts, CLI or infrastructure
//   (`tests/…`, `.github/…`, `scripts/…`, `cli/…`, `infra/…`), or into `docs/` other than the
//   three places a Why may cite. `actions/` is left out on purpose: an action's README is a
//   contract an adopter reads, so a Why may point at it.
// What it allows: another rule's id; a rulebook chapter; an ADR (`docs/decisions/`) or a plan
// (`docs/plans/`), which record Kanon's reasoning rather than an incident; the `docs/qa/`
// layout every adopter has; and the word "Kanon", since a Why about the framework has to
// name it. Whether Kanon is named as the framework or as the place an incident happened
// can't be told by reading, so that is left to the Reviewer.
//
// A Why is every paragraph a rule opens with a bold label starting "Why": `**Why.**`, and a
// further labelled one such as `**Why the default branch, not the base.**` (#345). Each runs to
// the next bold-labelled paragraph or heading, so a rule's `**Not covered.**` or `**Enforced
// by.**` is not read as part of it.

const ISSUE_OR_FILE_LINK = /github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull|commit|blob|tree)\//;
const BARE_ISSUE = /(?<![\w&/])#\d+\b/;
const ADOPTER_ISSUE = /\bRA-\d+\b/;
const OWN_PATH = /(?<![\w-])(?:\.github|tests|scripts|cli|infra)\/[\w./-]+|(?<![\w-])docs\/(?!decisions\/|plans\/|qa\/)[\w./-]+/;

/** The reasons a Why's text names the project's issues or files, one per kind found. */
const projectReferences = (why: string): string[] =>
  ([
    ['links an issue, pull request, commit or file', ISSUE_OR_FILE_LINK],
    ['cites a bare issue number', BARE_ISSUE],
    ["cites the reference adopter's issue", ADOPTER_ISSUE],
    ["names one of the repository's own files", OWN_PATH],
  ] as const).flatMap(([what, re]) => {
    const m = re.exec(why);
    return m ? [`${what}: ${m[0]}`] : [];
  });

/** Each Why in a chapter, `**Why.**` or a labelled `**Why …**`, from its line to the next bold label or heading. */
const whysOf = (text: string): { line: number; why: string }[] => {
  const lines = text.split('\n');
  return lines.flatMap((l, i) => {
    if (!/^\*\*Why\b/.test(l)) return [];
    let end = i + 1;
    while (end < lines.length && !/^\*\*[^*]+\*\*|^#/.test(lines[end] ?? '')) end++;
    return [{ line: i + 1, why: lines.slice(i, end).join('\n') }];
  });
};

describe('#249 the guard fails a Why that names the project\'s issues or files', () => {
  // The form that reached a PR: an incident told with the project's own issue link.
  const MUST_FAIL = [
    "**Why.** Its own entry held its pins on one release through 13 later ones ([#233](https://github.com/example-org/example/issues/233)).",
    '**Why.** The run went red twice (#233).',
    '**Why.** See https://github.com/example-org/example/pull/12 for the incident.',
    '**Why.** A test (`tests/unit/public-tree.test.ts`) missed it.',
    '**Why.** The workflow `.github/workflows/ci.yml` ran it twice.',
    '**Why.** The script `scripts/lane-gate.mjs` read it wrong.',
    '**Why.** As [the runbook](../docs/runbook.md) records.',
    '**Why.** The CLI `cli/apps.mjs` read it wrong.',
    '**Why.** See `infra/telemetry/collector.mjs`.',
    '**Why.** The reference adopter decided this in RA-936.',
  ];
  it.each(MUST_FAIL)('%s', (why) => {
    expect(projectReferences(why)).not.toEqual([]);
  });

  const MUST_PASS = [
    '**Why.** A copied check is a private fork (`K-ADOPT-10`); see [ADR 0002](../docs/decisions/0002-standardise-dont-parameterise.md).',
    '**Why.** The store is planned in [plan 0002](../docs/plans/0002-hosted-telemetry-store.md).',
    '**Why.** An adopter keeps its specs under `docs/qa/specs/`.',
    '**Why.** Every Kanon release has already passed Kanon\'s own review.',
    '**Why.** Chapter [10](10-adoption.md) explains the bootstrap; a heading link (#bootstrap) is not an issue.',
    '**Why.** The `actions/test-database/README.md` contract says so.',
  ];
  it.each(MUST_PASS)('allows %s', (why) => {
    expect(projectReferences(why)).toEqual([]);
  });

  it('reads a labelled Why, and stops each Why at the next bold label', () => {
    const text = [
      '### `K-X-1` T', '', '**Rule.** r', '',
      '**Why the default.** decided in RA-936', '',
      '**Not covered.** see (#47)', '',
      '**Why.** one', '', '**Why it widens.** two (#7)', '', '**Enforced by.** e',
    ].join('\n');
    expect(whysOf(text)).toEqual([
      { line: 5, why: '**Why the default.** decided in RA-936\n' },
      { line: 9, why: '**Why.** one\n' },
      { line: 11, why: '**Why it widens.** two (#7)\n' },
    ]);
    expect(whysOf(text).flatMap(({ why }) => projectReferences(why))).toEqual([
      "cites the reference adopter's issue: RA-936",
      'cites a bare issue number: #7',
    ]);
  });

  it('reads a Why up to the next Enforced by, Class or heading, across paragraphs', () => {
    const text = ['### `K-X-1` T', '', '**Rule.** r', '', '**Why.** one', '', 'two (#7)', '', '**Enforced by.** e', '', '**Class.** c'].join('\n');
    expect(whysOf(text)).toEqual([{ line: 5, why: '**Why.** one\n\ntwo (#7)\n' }]);
    expect(projectReferences(whysOf(text)[0]!.why)).toEqual(['cites a bare issue number: #7']);
  });
});

describe('#249 no rule\'s Why names the project\'s issues or files', () => {
  const chapters = readdirSync('rulebook').filter((f) => /^\d\d-.*\.md$/.test(f));

  it('finds the chapters, and Whys in each', () => {
    expect(chapters.length).toBeGreaterThanOrEqual(12);
    for (const f of chapters) expect(whysOf(readFileSync(join('rulebook', f), 'utf8')).length, f).toBeGreaterThan(0);
  });

  it('none does', () => {
    const bad = chapters.flatMap((f) =>
      whysOf(readFileSync(join('rulebook', f), 'utf8')).flatMap(({ line, why }) =>
        projectReferences(why).map((r) => `rulebook/${f}:${line} ${r}`)));
    expect(bad).toEqual([]);
  });
});
