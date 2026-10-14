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
//
// #578: a rule says what holds now, and its history lives in `rulebook/CHANGES.md`, grouped by
// rule id. So the whole of a rule's text, outside fenced examples and code spans, fails on a
// dated decision note (`(Owner decision 2026-10-12, …)`), an issue or pull-request link, a bare
// or repository-qualified issue number (`#728`, `kanon#471`), or a "Premise changed" paragraph.
// A rule keeps its ADR and plan links, which say where it came from. And every entry of
// `CHANGES.md` names a rule the chapters have.

const ISSUE_OR_FILE_LINK = /github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull|commit|blob|tree)\//;
const BARE_ISSUE = /(?<![\w&/])#\d+\b/;
const ADOPTER_ISSUE = /\bRA-\d+\b/;
// A link to an issue or a pull request, a bare or repository-qualified issue number (`kanon#471`,
// never a heading anchor such as `0009-x.md#15-rules`), an ISO date, or a "Premise changed" label.
const ISSUE_OR_PR_LINK = /github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+/;
const ISSUE_NUMBER = /(?<![\w&/.#-])(?:[\w-]+)?#\d+(?![\w-])/;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const PREMISE_CHANGED = /\bPremise changed\b/i;
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

/** A rule's text as a reader reads it: fenced examples and code spans removed, since a fixture there is not the rule's history. */
const proseOf = (text: string): string => {
  let fenced = false;
  return text.split('\n').map((l) => {
    if (/^\s*```/.test(l)) { fenced = !fenced; return ''; }
    return fenced ? '' : l.replace(/``[^`]*``|`[^`]*`/g, '``');
  }).join('\n');
};

/** The history a rule's text carries, one reason per kind found; each belongs in rulebook/CHANGES.md. */
const historyNotes = (rule: string): string[] => {
  const prose = proseOf(rule);
  return ([
    ['links an issue or pull request', ISSUE_OR_PR_LINK],
    ['cites an issue number', ISSUE_NUMBER],
    ['carries a dated note', DATE],
    ['carries a "Premise changed" paragraph', PREMISE_CHANGED],
  ] as const).flatMap(([what, re]) => {
    const m = re.exec(prose);
    return m ? [`${what}: ${m[0]}; record it in rulebook/CHANGES.md`] : [];
  });
};

/** Each rule in a chapter, from its `### \`K-…\`` heading to the next heading outside a fenced block. */
const rulesOf = (text: string): { id: string; line: number; text: string }[] => {
  const rules: { id: string; line: number; lines: string[] }[] = [];
  let fenced = false;
  let rule: { id: string; line: number; lines: string[] } | undefined;
  text.split('\n').forEach((l, i) => {
    if (/^\s*```/.test(l)) fenced = !fenced;
    if (!fenced && /^#/.test(l)) {
      const m = /^### `(K-[A-Z]+-\d+)`/.exec(l);
      rule = m ? { id: m[1]!, line: i + 1, lines: [] } : undefined;
      if (rule) rules.push(rule);
    }
    rule?.lines.push(l);
  });
  return rules.map(({ id, line, lines }) => ({ id, line, text: lines.join('\n') }));
};

const CHAPTERS = readdirSync('rulebook').filter((f) => /^\d\d-.*\.md$/.test(f));
const chapterText = (f: string) => readFileSync(join('rulebook', f), 'utf8');

/** The rule ids `CHANGES.md` groups its entries under, and every line that is not a well-formed entry. */
const changesOf = (text: string): { ids: string[]; malformed: string[] } => {
  const ids: string[] = [];
  const malformed: string[] = [];
  for (const l of text.split('\n')) {
    const h = /^## (.*)$/.exec(l);
    if (h) {
      const m = /^`(K-[A-Z]+-\d+)`$/.exec(h[1]!);
      if (m) ids.push(m[1]!); else malformed.push(l);
    } else if (/^- /.test(l) && !(ids.length && /^- \*\*\d{4}-\d{2}-\d{2}\.\*\* .*\]\((?:https:\/\/github\.com\/|\.\.\/docs\/)/.test(l))) {
      malformed.push(l);
    }
  }
  return { ids, malformed };
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
  const chapters = CHAPTERS;

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

describe('#578 the guard fails a rule that carries its own history', () => {
  const MUST_FAIL = [
    '**Rule.** Retry once (Owner decision 2026-10-12, [#759](https://github.com/example-org/example/pull/759)).',
    '**Enforced by.** `kanon doctor` reports it ([#459](https://github.com/example-org/example/issues/459)).',
    '**Rule.** The lane drafts it (the decision of 2026-10-07).',
    '**Enforced by.** The spine turns symlinks off (kanon#327).',
    '**Rule.** It admits the opener (#768).',
    '**Premise changed.** The scripts now look the caller up.',
  ];
  it.each(MUST_FAIL)('%s', (rule) => {
    expect(historyNotes(rule)).not.toEqual([]);
  });

  const MUST_PASS = [
    '**Rule.** Never require it. ([ADR 0004 §2](../docs/decisions/0004-disputed-rules.md), amended by [ADR 0008 §2](../docs/decisions/0008-installation-test-decisions.md))',
    '**Rule.** On the cadence ([plan 0009](../docs/plans/0009-release-channels-and-api-key.md)), as [§15](../docs/plans/0009-release-channels-and-api-key.md#15-rules-and-docs-that-change) says.',
    '**Enforced by.** [`docs/doctor.md`](../docs/doctor.md#what-it-checks) item 7.',
    '**Rule.** The bootstrap line reads `ended 2026-10-02`.',
    '**Rule.** The table:\n\n```markdown\n| Ada | ada@example.com | 2026-10-02 |\n```\n\nand the line\n\n  ```text\n  **Closes #12**\n  ```',
  ];
  it.each(MUST_PASS)('allows %s', (rule) => {
    expect(historyNotes(rule)).toEqual([]);
  });

  it('reads a rule to the next heading, and not a heading inside a fenced example', () => {
    const text = ['## Section', 'intro (#1)', '### `K-X-1` T', '**Rule.** r', '```markdown', '## Data', '```', 'tail (#2)', '### `K-X-2` U', '**Rule.** s', '## After', 'out (#3)'].join('\n');
    expect(rulesOf(text).map(({ id, line, text: body }) => [id, line, historyNotes(body).length])).toEqual([['K-X-1', 3, 1], ['K-X-2', 9, 0]]);
  });
});

describe('#578 no rule carries its own history, and CHANGES.md holds it', () => {
  const changes = readFileSync('rulebook/CHANGES.md', 'utf8');
  const ids = new Set(CHAPTERS.flatMap((f) => rulesOf(chapterText(f)).map((r) => r.id)));

  it('finds every rule, and the chapter guards leave CHANGES.md out', () => {
    expect(ids.size).toBeGreaterThan(200);
    expect(CHAPTERS).not.toContain('CHANGES.md');
  });

  it('no rule does', () => {
    const bad = CHAPTERS.flatMap((f) =>
      rulesOf(chapterText(f)).flatMap(({ id, line, text }) =>
        historyNotes(text).map((r) => `rulebook/${f}:${line} ${id} ${r}`)));
    expect(bad).toEqual([]);
  });

  // The three mutations: each kind of note, put back into a real rule, turns the chapter guard red.
  it.each([
    ['a dated decision note', ' (Owner decision 2026-10-12).'],
    ['an issue link', ' ([#728](https://github.com/yedeya-labs/kanon/issues/728)).'],
    ['a "Premise changed" paragraph', '\n\n**Premise changed.** The scripts now look the caller up.'],
  ])('re-adding %s turns it red', (_kind, note) => {
    const chapter = chapterText('11-repository-layout.md');
    const rule = rulesOf(chapter).find((r) => r.id === 'K-LAYOUT-18')!;
    expect(historyNotes(rule.text)).toEqual([]);
    const mutated = chapter.replace(/(### `K-LAYOUT-18`[^\n]*\n\n\*\*Rule\.\*\*[^\n]*)/, `$1${note}`);
    expect(mutated).not.toBe(chapter);
    const hit = rulesOf(mutated).find((r) => r.id === 'K-LAYOUT-18')!;
    expect(historyNotes(hit.text)).not.toEqual([]);
    expect(historyNotes(hit.text).join()).toContain('rulebook/CHANGES.md');
  });

  it('every entry is under a rule the chapters have, once, with a date and a link', () => {
    const { ids: named, malformed } = changesOf(changes);
    expect(named.length).toBeGreaterThan(0);
    expect(malformed).toEqual([]);
    expect(named.filter((id) => !ids.has(id))).toEqual([]);
    expect(named.filter((id, i) => named.indexOf(id) !== i)).toEqual([]);
  });

  it('fails an entry for a rule that does not exist, or one without a date or a link', () => {
    const { ids: named } = changesOf(`${changes}\n## \`K-NOPE-1\`\n\n- **2026-10-14.** Made up. [#1](https://github.com/example-org/example/issues/1)\n`);
    expect(named.filter((id) => !ids.has(id))).toEqual(['K-NOPE-1']);
    expect(changesOf('## `K-PRIN-13`\n\n- Retried once. [#759](https://github.com/example-org/example/pull/759)\n').malformed).toHaveLength(1);
    expect(changesOf('## `K-PRIN-13`\n\n- **2026-10-12.** Retried once.\n').malformed).toHaveLength(1);
    expect(changesOf('## K-PRIN-13\n').malformed).toHaveLength(1);
  });
});
