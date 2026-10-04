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
// - a bare issue reference (`#233`);
// - a path into the repository's own tests, workflows or scripts (`tests/…`, `.github/…`,
//   `scripts/…`), or into `docs/` other than the three places a Why may cite.
// What it allows: another rule's id; a rulebook chapter; an ADR (`docs/decisions/`) or a plan
// (`docs/plans/`), which record Kanon's reasoning rather than an incident; the `docs/qa/`
// layout every adopter has; and the word "Kanon", since a Why about the framework has to
// name it. Whether Kanon is named as the framework or as the place an incident happened
// can't be told by reading, so that is left to the Reviewer.

const ISSUE_OR_FILE_LINK = /github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull|commit|blob|tree)\//;
const BARE_ISSUE = /(?<![\w&/])#\d+\b/;
const OWN_PATH = /(?<![\w-])(?:\.github|tests|scripts)\/[\w./-]+|(?<![\w-])docs\/(?!decisions\/|plans\/|qa\/)[\w./-]+/;

/** The reasons a Why's text names the project's issues or files, one per kind found. */
const projectReferences = (why: string): string[] =>
  ([
    ['links an issue, pull request, commit or file', ISSUE_OR_FILE_LINK],
    ['cites a bare issue number', BARE_ISSUE],
    ["names one of the repository's own files", OWN_PATH],
  ] as const).flatMap(([what, re]) => {
    const m = re.exec(why);
    return m ? [`${what}: ${m[0]}`] : [];
  });

/** Each **Why.** in a chapter, from its line to the next **Enforced by.**, **Class.** or heading. */
const whysOf = (text: string): { line: number; why: string }[] => {
  const lines = text.split('\n');
  return lines.flatMap((l, i) => {
    if (!l.startsWith('**Why.**')) return [];
    let end = i + 1;
    while (end < lines.length && !/^\*\*(?:Enforced by|Class)\.\*\*|^#/.test(lines[end] ?? '')) end++;
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
