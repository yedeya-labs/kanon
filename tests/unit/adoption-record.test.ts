import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fencedLines } from '../../scripts/spec-lib.mjs';
import { linesOf } from '../../scripts/lib/declarations.mjs';
import { parseYaml } from '../../cli/workflow-yaml.mjs';

/**
 * `docs/qa/adoption.md` is Kanon's own adoption record (`K-LAYOUT-10`). This test checks the
 * parts of its format a machine can read one way: the five headings in order, the bootstrap
 * line, and a mechanism list (`K-ADOPT-9`) that names every rule whose "Enforced by" line
 * names something, with each mechanism marked `installed YYYY-MM-DD` or `not yet installed`.
 * The required rules come from the rulebook, never from a list kept here, so a new rule with
 * a mechanism fails this test until the record says whether it is installed.
 */
const ROOT = process.cwd();
const RECORD = join(ROOT, 'docs/qa/adoption.md');
const HEADINGS = ['People', 'Plan', 'Bootstrap', 'Mechanisms', 'Choices'];
const STATUS = /^(installed \d{4}-\d{2}-\d{2}|not yet installed)$/;
const RULE_ID = /K-[A-Z]+-\d+/g;
const TABLE_HEADER = '| Mechanism | Rules | Status |';
const PROSE_ANCHOR = "These rules' lines are prose only with a note, and name nothing to install:";

/** Every rule of the numbered chapters, with its "Enforced by" line (absent on a retired rule). */
const rulebookRules = (
  chapters: string[] = readdirSync(join(ROOT, 'rulebook'))
    .filter((f) => /^\d\d-.*\.md$/.test(f))
    .map((f) => readFileSync(join(ROOT, 'rulebook', f), 'utf8')),
): Map<string, string | undefined> => {
  const rules = new Map<string, string | undefined>();
  for (const text of chapters) {
    let id: string | undefined;
    for (const line of text.split('\n')) {
      const heading = /^### `(K-[A-Z]+-\d+)`/.exec(line);
      if (heading?.[1]) {
        id = heading[1];
        rules.set(id, undefined);
        continue;
      }
      const enforced = /^\*\*Enforced by\.\*\* (.*)$/.exec(line);
      if (enforced?.[1] && id) rules.set(id, enforced[1].trim());
    }
  }
  return rules;
};

/** A rule names a mechanism unless its line is exactly "Prose only." (or it has none). */
const rulesNamingAMechanism = (rules: Map<string, string | undefined>): string[] =>
  [...rules].filter(([, line]) => line !== undefined && line !== 'Prose only.').map(([id]) => id);

/** The record's `## ` sections, in order, keyed by heading. */
const sections = (text: string): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  for (const part of text.split(/^## /m).slice(1)) {
    const [head, ...body] = part.split('\n');
    out.push([(head ?? '').trim(), body.join('\n')]);
  }
  return out;
};

/** Every problem with a record, as readable strings. An empty list means it passes. */
const recordProblems = (text: string, rules: Map<string, string | undefined>): string[] => {
  const problems: string[] = [];
  const found = sections(text);
  const heads = found.map(([h]) => h).filter((h) => HEADINGS.includes(h));
  if (heads.join('|') !== HEADINGS.join('|')) problems.push(`headings are ${heads.join(', ')}, not ${HEADINGS.join(', ')}`);
  const body = (h: string): string => found.find(([head]) => head === h)?.[1] ?? '';

  for (const role of ['Owner', 'Maintainer', 'Stakeholder']) {
    if (!new RegExp(`^\\| ${role} \\| \\S`, 'm').test(body('People'))) problems.push(`People names no ${role}`);
  }

  const bootstrap = /`(in bootstrap since|ended) \d{4}-\d{2}-\d{2}`/.exec(body('Bootstrap'));
  if (!bootstrap) problems.push('Bootstrap has no `in bootstrap since YYYY-MM-DD` or `ended YYYY-MM-DD`');

  // Only the table, and the one anchored prose-only list, can list a rule. An id anywhere else
  // in the section (the intro, the reasons) lists nothing, so a deleted row can't hide behind it.
  const lines = body('Mechanisms').split('\n');
  const head = lines.indexOf(TABLE_HEADER);
  if (head < 0 || !/^\|(\s*-+\s*\|){3}$/.test(lines[head + 1] ?? '')) {
    throw new Error(`Mechanisms has no table headed "${TABLE_HEADER}": the anchor moved, so the check would go blind`);
  }
  const rows: string[] = [];
  for (const line of lines.slice(head + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line);
  }
  if (rows.length === 0) problems.push('Mechanisms has no table rows');
  const listed = new Set<string>();
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length !== 3) {
      problems.push(`mechanism row "${row}" has ${cells.length} cells, not 3`);
      continue;
    }
    const status = (cells[2] ?? '').replace(/`/g, '');
    if (!STATUS.test(status)) problems.push(`mechanism "${cells[0]}" is marked "${status}"`);
    for (const id of cells[1]?.match(RULE_ID) ?? []) listed.add(id);
  }
  const proseLine = lines.find((l) => l.startsWith(PROSE_ANCHOR)) ?? '';
  const prose = new Set(proseLine.match(RULE_ID) ?? []);
  for (const id of prose) {
    if (!rules.get(id)?.startsWith('Prose only')) problems.push(`${id} is listed as prose only, but its line names a mechanism`);
  }
  for (const id of rulesNamingAMechanism(rules)) {
    if (!listed.has(id) && !prose.has(id)) problems.push(`Mechanisms leaves out ${id}`);
  }
  for (const id of [...listed, ...prose]) if (!rules.has(id)) problems.push(`Mechanisms cites ${id}, which the rulebook has no rule for`);
  return problems;
};

/**
 * The install's choices plan 0007 adds (step G1): the feature and the review trigger under
 * `## Choices`, and whether the repository holds private or sensitive material under `## Data`.
 * Each is one bullet, its value one code span and nothing after it, and each has a meaning when
 * absent: the record means what it meant before the choice existed (plan 0005 §5.2). The release
 * cadence (`K-SHIP-7`, plan 0009 S1) has the same shape, so the same parser reads it: `every merge`
 * when absent, or `weekly, ` and the day the release pull request merges.
 */
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const INSTALL_CHOICES = [
  { key: 'feature', label: 'Feature', heading: '## Choices', values: ['review', 'build', 'full', 'custom'], absent: 'custom' },
  { key: 'reviewTrigger', label: 'Review trigger', heading: '## Choices', values: ['labelled', 'every pull request'], absent: 'labelled' },
  { key: 'sensitiveMaterial', label: 'Private or sensitive material', heading: '## Data', values: ['yes', 'no', 'not declared'], absent: 'not declared' },
  { key: 'releaseCadence', label: 'Release cadence', heading: '## Choices', values: ['every merge', ...WEEKDAYS.map((day) => `weekly, ${day}`)], absent: 'every merge' },
] as const;
const RECORD_PATH = 'docs/qa/adoption.md';

/** The install's choices a record declares, or their meaning when absent. Throws naming the line of a malformed one. */
const installChoices = (text: string): Record<(typeof INSTALL_CHOICES)[number]['key'], string> => {
  const lines = linesOf(text);
  const fenced = fencedLines(lines);
  if (fenced.unclosed !== -1) throw new Error(`${RECORD_PATH}:${fenced.unclosed + 1} opens a code fence that never closes`);
  const headingAt = (heading: string): number => {
    const at = lines.flatMap((l, i) => (!fenced.has(i) && l.trimEnd() === heading ? [i] : []));
    if (at.length > 1) throw new Error(`${RECORD_PATH} has the \`${heading}\` heading ${at.length} times, on lines ${at.map((i) => i + 1).join(', ')}`);
    return at[0] ?? -1;
  };
  const endOf = (start: number): number => {
    for (let i = start + 1; i < lines.length; i += 1) if (!fenced.has(i) && /^#{1,2}\s/.test(lines[i] ?? '')) return i;
    return lines.length;
  };
  const starts: Record<string, number> = { '## Choices': headingAt('## Choices'), '## Data': headingAt('## Data') };
  const [choices = -1, data = -1] = [starts['## Choices'], starts['## Data']];
  if (choices !== -1 && data !== -1 && data < choices) throw new Error(`${RECORD_PATH}:${data + 1} puts \`## Data\` before \`## Choices\`: it comes after`);

  const out = {} as Record<(typeof INSTALL_CHOICES)[number]['key'], string>;
  for (const { key, label, heading, values, absent } of INSTALL_CHOICES) {
    const mention = new RegExp(`^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)?\\*\\*${label}:\\*\\*`);
    const at = lines.flatMap((l, i) => (!fenced.has(i) && mention.test(l) ? [i] : []));
    const [first, second] = at;
    if (first === undefined) {
      out[key] = absent;
      continue;
    }
    if (second !== undefined) throw new Error(`${RECORD_PATH}:${second + 1} repeats \`${label}\`, already declared on line ${first + 1}`);
    const start = starts[heading] ?? -1;
    if (start === -1 || first < start || first >= endOf(start)) throw new Error(`${RECORD_PATH}:${first + 1} declares \`${label}\` outside \`${heading}\``);
    const entry = new RegExp(`^[-*] \\*\\*${label}:\\*\\* \`([^\`]*)\`\\s*$`).exec(lines[first] ?? '');
    if (!entry) throw new Error(`${RECORD_PATH}:${first + 1}, under \`${heading}\`, isn't a declaration: write \`- **${label}:** \` and the value as one code span, nothing after it`);
    const value = entry[1] ?? '';
    if (!(values as readonly string[]).includes(value)) throw new Error(`${RECORD_PATH}:${first + 1}: \`${label}\` is \`${value}\`; write ${values.map((v) => `\`${v}\``).join(', ')}`);
    out[key] = value;
  }
  return out;
};

describe("Kanon's adoption record (K-LAYOUT-10, K-ADOPT-9)", () => {
  const rules = rulebookRules();

  it('reads the rulebook, so the checks below are not vacuous', () => {
    expect(rules.size).toBeGreaterThan(200);
    expect(rulesNamingAMechanism(rules).length).toBeGreaterThan(150);
    expect(rulesNamingAMechanism(rules)).toContain('K-MERGE-6');
    expect(rulesNamingAMechanism(rules)).not.toContain('K-AGENT-17');
  });

  it('has the five headings, the bootstrap line and every mechanism, each marked', () => {
    expect(recordProblems(readFileSync(RECORD, 'utf8'), rules)).toEqual([]);
  });
});

describe('the record check fails on each broken shape', () => {
  const rules = new Map<string, string | undefined>([
    ['K-A-1', 'The guard.'],
    ['K-A-2', 'Prose only.'],
    ['K-A-3', 'Prose only; a guard is planned.'],
    ['K-A-4', undefined],
    ['K-A-5', 'Prose only, in the agent instructions.'],
  ]);
  const good = [
    '# Adoption record',
    '## People',
    '| Role | Who |',
    '|---|---|',
    '| Owner | A |',
    '| Maintainer | A |',
    '| Stakeholder | A |',
    '## Plan',
    'Free.',
    '## Bootstrap',
    '`ended 2026-10-02`',
    '## Mechanisms',
    '| Mechanism | Rules | Status |',
    '|---|---|---|',
    '| The guard | `K-A-1` | installed 2026-10-02 |',
    '| A planned guard | `K-A-3` | not yet installed |',
    '',
    "These rules' lines are prose only with a note, and name nothing to install: `K-A-5`.",
    '## Choices',
    'None yet.',
    '',
  ].join('\n');

  it('passes the good record', () => {
    expect(recordProblems(good, rules)).toEqual([]);
  });

  const broken: Array<[string, string, RegExp]> = [
    ['a heading is missing', good.replace('## Plan\n', ''), /headings are/],
    ['two headings swap', good.replace('## Plan', '## TMP').replace('## People', '## Plan').replace('## TMP', '## People'), /headings are/],
    ['a role is unnamed', good.replace('| Stakeholder | A |\n', ''), /no Stakeholder/],
    ['the bootstrap line has no date', good.replace('`ended 2026-10-02`', '`ended soon`'), /Bootstrap has no/],
    ['a mechanism has another status', good.replace('installed 2026-10-02', 'installed'), /is marked "installed"/],
    ['a mechanism is left out', good.replace('| A planned guard | `K-A-3` | not yet installed |\n', ''), /leaves out K-A-3/],
    ['a rule is cited only outside the table and the list', good.replace('| The guard | `K-A-1` | installed 2026-10-02 |\n', '').replace('# Adoption record', '# Adoption record\n\nSee `K-A-1`.').replace('## Mechanisms\n', '## Mechanisms\nThe guard is `K-A-1`.\n'), /leaves out K-A-1/],
    ['a mechanism is moved to the prose-only list', good.replace('| The guard | `K-A-1` | installed 2026-10-02 |\n', '').replace('`K-A-5`.', '`K-A-5`, `K-A-1`.'), /K-A-1 is listed as prose only/],
    ['a row has the wrong number of cells', good.replace('| `K-A-3` | not yet installed |', '| `K-A-3` |'), /has 2 cells/],
    ['a cited rule does not exist', good.replace('`K-A-3`', '`K-A-3`, `K-A-9`'), /K-A-9, which the rulebook/],
  ];
  it('throws when the table header moves, rather than going blind', () => {
    expect(() => recordProblems(good.replace('| Mechanism | Rules | Status |', '| What | Rules | Status |'), rules)).toThrow(/anchor moved/);
  });

  for (const [what, text, problem] of broken) {
    it(`fails when ${what}`, () => {
      expect(recordProblems(text, rules).join('\n')).toMatch(problem);
    });
  }
});

describe("the record's choices: feature, review trigger, data and release cadence (K-LAYOUT-10, plan 0007 G1, plan 0009 S1)", () => {
  const RULEBOOK = readFileSync(join(ROOT, 'rulebook/11-repository-layout.md'), 'utf8');
  const rule = RULEBOOK.slice(RULEBOOK.indexOf('### `K-LAYOUT-10`'), RULEBOOK.indexOf('### `K-LAYOUT-14`'));
  const record = (choices: string[], tail: string[] = []): string =>
    ['# Adoption record', '', '## Choices', '', '- **Overseer:** `installed`', ...choices, '', ...tail, ''].join('\n');
  const DATA = (line: string): string[] => ['## Data', '', 'What the lanes read here.', '', line];

  it("parses Kanon's own record", () => {
    expect(() => installChoices(readFileSync(RECORD, 'utf8'))).not.toThrow();
  });

  it('K-LAYOUT-10 writes each bullet, its values and its section, as this check reads them', () => {
    expect(rule.length).toBeGreaterThan(1000);
    expect(rule).toMatch(/^- `## Data`: /m);
    for (const { label, values } of INSTALL_CHOICES) {
      expect(rule).toContain(`- **${label}:** \``);
      for (const value of values) expect(rule).toContain(`\`${value}\``);
    }
  });

  it('means custom, labelled and not declared without the bullets', () => {
    expect(installChoices(record([]))).toEqual({ feature: 'custom', reviewTrigger: 'labelled', sensitiveMaterial: 'not declared', releaseCadence: 'every merge' });
  });

  it('reads every value of each bullet, beside the other choices', () => {
    for (const { key, label, heading, values } of INSTALL_CHOICES) {
      for (const value of values) {
        const line = `- **${label}:** \`${value}\``;
        const text = heading === '## Data' ? record([], DATA(line)) : record([line]);
        expect(installChoices(text)[key]).toBe(value);
      }
    }
    expect(installChoices(record(['- **Feature:** `review`', '- **Review trigger:** `labelled`'], DATA('- **Private or sensitive material:** `yes`')))).toEqual({
      feature: 'review',
      reviewTrigger: 'labelled',
      sensitiveMaterial: 'yes',
      releaseCadence: 'every merge',
    });
  });

  it("reads Kanon's own release cadence from `## Choices`: weekly, on Monday (K-SHIP-7, plan 0009 S1)", () => {
    expect(installChoices(readFileSync(RECORD, 'utf8')).releaseCadence).toBe('weekly, Monday');
  });

  it('K-SHIP-7 names the cadence bullet K-LAYOUT-10 defines', () => {
    const shipping = readFileSync(join(ROOT, 'rulebook/06-shipping.md'), 'utf8');
    const ship7 = shipping.slice(shipping.indexOf('### `K-SHIP-7`'), shipping.indexOf('### `K-SHIP-8`'));
    expect(ship7).toContain('`` - **Release cadence:** `weekly, Monday` ``');
    expect(ship7).toContain('`K-LAYOUT-10`');
  });

  it('reads nothing inside a code fence', () => {
    expect(installChoices(record(['```markdown', '- **Feature:** `full`', '```'])).feature).toBe('custom');
  });

  it.each([
    ['a `Review trigger:` of `sometimes`', record(['- **Review trigger:** `sometimes`']), /adoption\.md:6: `Review trigger` is `sometimes`; write `labelled`, `every pull request`/],
    ['a feature of another value', record(['- **Feature:** `everything`']), /adoption\.md:6: `Feature` is `everything`/],
    ['a feature in another case', record(['- **Feature:** `Review`']), /`Feature` is `Review`/],
    ['the feature twice', record(['- **Feature:** `review`', '- **Feature:** `review`']), /adoption\.md:7 repeats `Feature`, already declared on line 6/],
    ['the review trigger twice', record(['- **Review trigger:** `labelled`', '* **Review trigger:** `labelled`']), /adoption\.md:7 repeats `Review trigger`/],
    ['the feature outside `## Choices`', `- **Feature:** \`review\`\n${record([])}`, /adoption\.md:1 declares `Feature` outside `## Choices`/],
    ['the review trigger under `## Data`', record([], ['## Data', '', '- **Review trigger:** `labelled`']), /adoption\.md:9 declares `Review trigger` outside `## Choices`/],
    ['the feature with no value span', record(['- **Feature:** review']), /adoption\.md:6, under `## Choices`, isn't a declaration/],
    ['the feature with something after it', record(['- **Feature:** `review` for now']), /isn't a declaration/],
    ['the feature as a numbered item', record(['1. **Feature:** `review`']), /isn't a declaration/],
    ['the data bullet under `## Choices`', record(['- **Private or sensitive material:** `yes`']), /adoption\.md:6 declares `Private or sensitive material` outside `## Data`/],
    ['the data bullet with no `## Data`', record([], ['## Mechanisms', '', '- **Private or sensitive material:** `no`']), /outside `## Data`/],
    ['the data bullet twice', record([], [...DATA('- **Private or sensitive material:** `yes`'), '- **Private or sensitive material:** `no`']), /repeats `Private or sensitive material`/],
    ['the data bullet with another value', record([], DATA('- **Private or sensitive material:** `some`')), /`Private or sensitive material` is `some`; write `yes`, `no`, `not declared`/],
    ['`## Data` twice', record([], [...DATA('- **Private or sensitive material:** `yes`'), '## Data']), /has the `## Data` heading 2 times/],
    ['`## Data` before `## Choices`', `# Adoption record\n\n## Data\n\n- **Private or sensitive material:** \`no\`\n\n${record([]).replace('# Adoption record\n', '')}`, /adoption\.md:3 puts `## Data` before `## Choices`/],
    ['a cadence with no day', record(['- **Release cadence:** `weekly`']), /adoption\.md:6: `Release cadence` is `weekly`; write `every merge`, `weekly, Monday`/],
    ['a cadence on a day that is not one', record(['- **Release cadence:** `weekly, Funday`']), /`Release cadence` is `weekly, Funday`/],
    ['a cadence in another case', record(['- **Release cadence:** `weekly, monday`']), /`Release cadence` is `weekly, monday`/],
    ['a cadence as plain text', record(['- **Release cadence:** weekly, Monday']), /adoption\.md:6, under `## Choices`, isn't a declaration/],
    ['the cadence twice', record(['- **Release cadence:** `weekly, Monday`', '- **Release cadence:** `every merge`']), /adoption\.md:7 repeats `Release cadence`/],
    ['the cadence under `## Data`', record([], ['## Data', '', '- **Release cadence:** `weekly, Monday`']), /adoption\.md:9 declares `Release cadence` outside `## Choices`/],
    ['a fence that never closes', record(['```', '- **Feature:** `review`']), /opens a code fence that never closes/],
  ])('fails %s, by line', (_name, text, message) => {
    expect(() => installChoices(text)).toThrow(message);
  });
});

/**
 * The mechanism row on `lane-check`'s caller file names lists Kanon's callers, and says the
 * lookup finds them through their `caller.misplaced` waivers. So the list and the waivers name
 * the same files (#864): a caller waived but not listed, or listed but not waived, is a row one
 * short of what its own sentence relies on.
 */
const CALLERS_LIST = /Kanon's callers are (.*?), because /;
const CALLER_WAIVER = /^- \*\*Waived doctor finding:\*\* `caller\.misplaced` on `\.github\/workflows\/([^`]+)`/;

/** The caller files the row lists, and the ones a `caller.misplaced` waiver names. */
const callerLists = (text: string): { listed: string[]; waived: string[] } => {
  const rows = text.split('\n').filter((l) => l.startsWith('|') && CALLERS_LIST.test(l));
  if (rows.length !== 1) throw new Error(`${RECORD_PATH} has ${rows.length} rows saying "Kanon's callers are …", not 1`);
  const list = CALLERS_LIST.exec(rows[0] ?? '')?.[1] ?? '';
  const listed = [...list.matchAll(/`([^`]+\.yml)`/g)].map((m) => m[1] ?? '');
  const waived = text.split('\n').flatMap((l) => CALLER_WAIVER.exec(l)?.[1] ?? []);
  return { listed: listed.sort(), waived: waived.sort() };
};

describe("the record's list of Kanon's callers", () => {
  it('names every caller a `caller.misplaced` waiver names, and no other', () => {
    const { listed, waived } = callerLists(readFileSync(RECORD, 'utf8'));
    expect(waived.length).toBeGreaterThan(10);
    expect(listed).toEqual(waived);
  });

  it('fails a waiver the list leaves out', () => {
    const text = [
      "| `lane-check`'s caller file names. Kanon's callers are `review.yml` and `merge.yml`, because x | `K-X-1` | installed 2026-10-04 |",
      '- **Waived doctor finding:** `caller.misplaced` on `.github/workflows/review.yml` (why)',
      '- **Waived doctor finding:** `caller.misplaced` on `.github/workflows/merge.yml` (why)',
      '- **Waived doctor finding:** `caller.misplaced` on `.github/workflows/project-digest.yml` (why)',
    ].join('\n');
    const { listed, waived } = callerLists(text);
    expect(listed).toEqual(['merge.yml', 'review.yml']);
    expect(listed).not.toEqual(waived);
  });

  it('throws when the row moves, rather than going blind', () => {
    expect(() => callerLists('- **Waived doctor finding:** `caller.misplaced` on `.github/workflows/review.yml`')).toThrow(/0 rows/);
  });
});

/**
 * The record's `Accepted id-token holder` bullets are what `kanon doctor` reads to tell an
 * accepted holder from the blocking `id-token.unaccepted` (#1056). Kanon's lane definitions and
 * its own workflows live in `.github/workflows/`, where doctor scans every job, so each one that
 * holds the grant needs its bullet, and a bullet whose job no longer holds it is
 * `id-token.stale-acceptance`. Doctor's own reader and holder scan judge Kanon's tree here, with
 * every pin taken as the callers', so a lane caller is exempt as doctor exempts it on `main`.
 */
describe("the record's accepted id-token holders (#1056)", () => {
  const WORKFLOWS = join(ROOT, '.github/workflows');
  const holders = async () => {
    const { idTokenHolders, readHolderAcceptances } = await import('../../cli/doctor.mjs');
    const { loadRequirements } = await import('../../cli/callers.mjs');
    const { parseYaml } = await import('../../cli/workflow-yaml.mjs');
    const workflows = new Map<string, Record<string, unknown>>();
    for (const f of readdirSync(WORKFLOWS).filter((x) => /\.ya?ml$/.test(x))) {
      workflows.set(`.github/workflows/${f}`, parseYaml(readFileSync(join(WORKFLOWS, f), 'utf8')) as Record<string, unknown>);
    }
    const record = readHolderAcceptances(readFileSync(RECORD, 'utf8'));
    const found = idTokenHolders({ workflows, accepted: record.accepted, pinned: () => true, req: loadRequirements() }) as Array<{ workflow: string; job: string; status: string }>;
    return { record, found };
  };

  it("accepts every job of Kanon's workflows that holds the grant, so doctor reports none unaccepted", async () => {
    const { record, found } = await holders();
    expect(record.errors).toEqual([]);
    expect(found.filter((h) => h.status === 'accepted').length).toBeGreaterThan(10);
    expect(found.filter((h) => h.status === 'unaccepted').map((h) => `${h.workflow}#${h.job}`)).toEqual([]);
  });

  it('accepts no job that no longer holds it', async () => {
    const { record, found } = await holders();
    const held = new Set(found.map((h) => `${h.workflow.slice('.github/workflows/'.length)}#${h.job}`));
    expect([...record.accepted.keys()].filter((k) => !held.has(k))).toEqual([]);
  });
});

/**
 * Kanon calls the Lead's lane, so `kanon init` would have written its brief template beside the
 * caller, and doctor reports `lead.template-missing` or `lead.template-stale` until Kanon's own
 * copy is the one init writes (K-LAYOUT-11, #1064). The copy is compared with init's own source,
 * never with a second copy kept here.
 */
describe("Kanon's own brief template (K-LAYOUT-11, #1064)", () => {
  it('is the template kanon init writes, unchanged', async () => {
    const { BRIEF_TEMPLATE_PATH, briefTemplate } = await import('../../cli/init.mjs');
    const copy = join(ROOT, BRIEF_TEMPLATE_PATH);
    expect(existsSync(copy), `${BRIEF_TEMPLATE_PATH} is missing`).toBe(true);
    expect(readFileSync(copy, 'utf8')).toBe(briefTemplate());
  });
});

/**
 * Since plan 0008's J5 the telemetry read jobs request an OIDC token for the hosted store's
 * audience and send it to the store's token URL; they assume no cloud role. Their record entries
 * say what they do now (#1064). Since J7 (§9 step 4a) the metrics page's read job does too, so no
 * job of Kanon's assumes a role any more.
 */
describe("the record's id-token holders say how each one reads (#1064)", () => {
  type Step = { env?: Record<string, unknown>; with?: Record<string, unknown>; run?: unknown };
  const jobs = () => {
    const out: Array<{ key: string; holds: boolean; steps: Step[] }> = [];
    const dir = join(ROOT, '.github/workflows');
    for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
      const wf = parseYaml(readFileSync(join(dir, f), 'utf8')) as { jobs?: Record<string, { permissions?: unknown; steps?: Step[] }> };
      for (const [name, j] of Object.entries(wf.jobs ?? {})) {
        const holds = typeof j.permissions === 'object' && j.permissions !== null && (j.permissions as Record<string, unknown>)['id-token'] === 'write';
        out.push({ key: `${f}#${name}`, holds, steps: j.steps ?? [] });
      }
    }
    return out;
  };
  // A gate job reads the URL too, to tell whether the store is configured, but holds no grant.
  // The metrics page's read names no URL variable: it reads Kanon's hosted store alone (J7).
  const readsTokenUrl = (j: { holds: boolean; steps: Step[] }) => j.holds && j.steps.some((s) => Object.keys(s.env ?? {}).some((k) => /_TOKEN_URL$/.test(k))
    || String(s.run ?? '').trim() === 'node "$KANON/scripts/aggregate-read.mjs" page');
  const assumesRole = (steps: Step[]) => steps.some((s) => 'role-to-assume' in (s.with ?? {}));
  const accepted = async () => {
    const { readHolderAcceptances } = await import('../../cli/doctor.mjs');
    return readHolderAcceptances(readFileSync(RECORD, 'utf8')).accepted as Map<string, string>;
  };

  it("finds Kanon's three token-URL read jobs, so the check below is not vacuous", () => {
    expect(jobs().filter((j) => readsTokenUrl(j)).map((j) => j.key).sort())
      .toEqual(['agent-explore-telemetry.yml#aggregate', 'agent-overseer.yml#telemetry', 'metrics-page.yml#aggregate']);
  });

  it('says a job that reads through a token URL requests an OIDC token for the audience and calls it, and assumes no role', async () => {
    const record = await accepted();
    for (const { key } of jobs().filter((j) => readsTokenUrl(j))) {
      const why = record.get(key) ?? '';
      expect(why, key).toMatch(/OIDC token/);
      expect(why, key).toMatch(/audience/);
      expect(why, key).toMatch(/token URL/);
      expect(why, key).not.toMatch(/\brole\b/);
    }
  });

  it('finds no job that assumes a cloud role: the metrics page moved to the token too (plan 0008 §9 step 4a)', async () => {
    const record = await accepted();
    expect(jobs().filter((j) => assumesRole(j.steps)).map((j) => j.key)).toEqual([]);
    expect(record.get('metrics-page.yml#aggregate') ?? '').not.toMatch(/invoker role/);
  });
});
