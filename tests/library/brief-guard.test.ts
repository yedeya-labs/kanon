import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MIN_SECTION_CHARS,
  OBS_DECISION,
  OBS_VOCABULARY,
  ANSWERED_DECISION,
  DECISION_ITEM,
  OPEN_DECISION,
  REQUIRED_SECTIONS,
  ROUTING_BUCKETS,
  acBullets,
  measureBullets,
  briefCorpus,
  criteriaOrdinalGap,
  danglingCriterionRefs,
  omittedPredecessors,
  unparsedDecisionLines,
  briefSections,
  checkBrief,
  decisionsIn,
  isBrief,
  isPreStandard,
} from '../../scripts/brief-guard.mjs';
import { parseProposed } from '../../scripts/lead-reconcile.mjs';
import { ROOT } from './helpers/adopter.js';

/**
 * RA-949 — the project brief's required shape.
 *
 * THE MUTATION DISCIPLINE APPLIES HARDEST HERE. A brief is the developer's only gate
 * per project, so a guard over it that cannot fail is worse than none: it would print
 * an all-clear over exactly the artifact whose omissions are invisible. Every check in
 * `brief-guard.mjs` is therefore pinned by a test that BREAKS a passing brief and
 * asserts the specific finding, not merely that something was reported.
 */

/** Enough prose to clear `MIN_SECTION_CHARS`, since the guard's whole point is that a
 *  heading with nothing under it is not a statement. */
const PAD =
  'This section states a position rather than leaving a heading with a hole under it, ' +
  'because an omitted section reads exactly like a section with nothing to say, which ' +
  'is the silent-absence failure the standard exists to close on the one artifact the ' +
  'developer actually gates on.';

const SECTIONS: [string, string][] = [
  ['1. The real problem', PAD],
  ['2. Scope', `${PAD} What this is not: everything else.`],
  [
    '3. Decomposition',
    `${PAD}

### Issue A — Do the first thing
**Milestone:** Development Automation · **Labels:** \`pipeline-improvement\`

Acceptance criteria:

- \`[AREA-1]\` — the criterion this issue takes on.

### Issue B — Do the second thing
**Milestone:** Product Backlog · **Labels:** \`sev:high\`
**Depends on:** Issue A (its schema change is what this reads)

Acceptance criteria:

- \`[AREA-2]\` — the criterion this issue takes on.
`,
  ],
  ['4. AWS cost', `${PAD} The delta is $0 per stage.`],
  [
    '5. Observability',
    `${PAD} No \`businessEvent\` is added and no \`pagedBusinessEvents\` clause changes.`,
  ],
  ['6. Blast radius', `${PAD} Nothing on the SCOPE-FIRST BAIL list.`],
  ['7. Decisions', `${PAD} None outstanding.`],
  ['8. What I did not examine', `${PAD} The storefront, which this does not touch.`],
];

const brief = (sections = SECTIONS) =>
  `# Brief\n\nMeasured against \`abc1234\`.\n\n${sections
    .map(([title, body]) => `## ${title}\n\n${body}\n`)
    .join('\n')}`;

const problems = (markdown: string) => checkBrief('docs/projects/1.md', markdown).map((f) => f.problem);

/** Replace one section's body, keeping every other section intact. */
const withSection = (titleFragment: string, body: string) =>
  brief(SECTIONS.map(([t, b]) => (t.includes(titleFragment) ? [t, body] : [t, b])) as [string, string][]);

/** Drop one section entirely. */
const withoutSection = (titleFragment: string) =>
  brief(SECTIONS.filter(([t]) => !t.includes(titleFragment)) as [string, string][]);

describe('the fixture is a valid brief', () => {
  it('passes every check, so each mutation below isolates one rule', () => {
    expect(problems(brief())).toEqual([]);
  });
});

describe('required sections', () => {
  it('names eight, each with the reason it is required', () => {
    // The `why` is not decoration: it is what the failure message prints, and a rule
    // whose reason nobody wrote down is the one a future author deletes.
    expect(REQUIRED_SECTIONS).toHaveLength(8);
    for (const s of REQUIRED_SECTIONS) expect(s.why.length).toBeGreaterThan(20);
  });

  it("cites each reason by Kanon's rule id, not by a document only the reference adopter has", () => {
    // kanon#142: the reasons cited `AGENTS.md` and a pipeline design doc by section, which an
    // adopter doesn't have. A rule id resolves in Kanon's rulebook, on every repository.
    for (const s of REQUIRED_SECTIONS) {
      expect(s.why, s.key).toMatch(/`K-[A-Z]+-\d+`/);
      expect(s.why, s.key).not.toMatch(/AGENTS\.md|§|\.ya?ml\b|AWS/);
    }
  });

  it('requires none of the three RA-1742 cut, because each has a mechanical home', () => {
    // Sequencing → the `**Depends on:**` line the parser already reads and the
    // reconciler already enforces. Reconciliation state → spec-coverage, and
    // a gap it finds is ISSUE A rather than a paragraph (RA-932 unchanged). Definition of
    // done → identical for every project and executable: `lead-reconcile.mjs` phases
    // 4-6. Pinned so that re-adding one is a deliberate act with this note in front of
    // it, not a quiet restoration of the eleven.
    const keys = REQUIRED_SECTIONS.map((r) => r.key);
    expect(keys).not.toContain('sequencing');
    expect(keys).not.toContain('reconciliation');
    expect(keys).not.toContain('done');
  });

  it.each([
    ['The real problem', 'the real problem / the measurement'],
    ['Scope', 'scope'],
    ['cost', 'cost'],
    ['Observability', 'observability'],
    ['Blast radius', 'blast radius'],
    ['Decisions', 'decisions'],
    ['What I did not examine', 'what I did not examine'],
  ])('reports a missing %s section', (fragment, label) => {
    expect(problems(withoutSection(fragment)).join('\n')).toContain(`no **${label}** section`);
  });

  it('reports a missing Decomposition section as unparseable, not merely absent', () => {
    // Decomposition is the one section with a machine consumer, so its absence has a
    // second consequence the reader must see: the reconciler files NOTHING.
    const found = problems(withoutSection('Decomposition')).join('\n');
    expect(found).toContain('no **decomposition** section');
    expect(found).toContain('does not parse');
  });

  it('matches by MEANING, so numbering and trailing prose in a heading are free', () => {
    const renumbered = brief(
      SECTIONS.map(([t, b]) => [
        // Every heading but Decomposition, which the reconciler's own parser anchors
        // exactly — see the test below.
        t.includes('Decomposition') ? t : t.replace(/^\d+\. /, '').concat(' — and why'),
        b,
      ]) as [string, string][],
    );
    expect(problems(renumbered)).toEqual([]);
  });

  it('reports a Decomposition heading carrying a suffix, because the parser anchors it', () => {
    // THE ONE HEADING THAT IS NOT FREE. `parseProposed`'s section regex is
    // `^#{1,4}\s*(?:\d+[.)]\s*)?Decomposition\s*$` — anchored — so
    // `## 3. Decomposition — the five issues` reads as NO decomposition at all, and the
    // tick files nothing while reporting a healthy project. Every other section title
    // in this brief may carry an em-dash summary, which is exactly why an author would
    // give this one the same treatment. Lint says so now; before, a tick did, hours
    // after the brief was merged.
    const suffixed = brief(
      SECTIONS.map(([t, b]) => (t.includes('Decomposition') ? [`${t} — the two issues`, b] : [t, b])) as [string, string][],
    );
    const found = problems(suffixed).join('\n');
    // AND IT NAMES THE CAUSE. `parseProposed`'s own reason is "no Decomposition
    // heading", which reads as plainly false to an author looking straight at one —
    // right for its caller, useless here. The guard knows a title matched while the
    // anchored parse did not, and the only way both hold is a suffix (RA-1658 review).
    expect(found).toContain('carries a suffix');
    expect(found).toContain('reads as NO decomposition');
    expect(found).not.toContain('no Decomposition heading');
  });

  it('still reports a genuinely ABSENT decomposition in the parser\'s own words', () => {
    // The suffix message must not swallow the plain case: with no such heading at all
    // there is nothing to say about a suffix, and `parseProposed`'s reason is correct.
    const found = problems(withoutSection('Decomposition')).join('\n');
    expect(found).toContain('no Decomposition heading');
    expect(found).not.toContain('carries a suffix');
  });

  it('accepts a COMBINED heading as satisfying both sections', () => {
    // Real briefs combine sections where they are one story — `1015.md` and `284.md`
    // both write `## 9. Reconciliation state, and blast radius`. Splitting a section to
    // satisfy a guard would make the brief worse, so a heading matching two entries
    // answers both from its pooled body.
    const combined = brief(
      SECTIONS.filter(([t]) => !t.includes('Blast radius')).map(([t, b]) =>
        t.includes('Scope') ? ['2. Scope, and the blast radius it draws', b] : [t, b],
      ) as [string, string][],
    );
    expect(problems(combined)).toEqual([]);
  });

  it('does not accept a singular "the decision that…" heading as the Decisions section', () => {
    // `1292.md` has `## 3. The decision that sizes the project` — an argument, not
    // the list of questions the developer must answer. A loose match would let a brief
    // satisfy the section with a design digression and ask nothing.
    const renamed = brief(
      SECTIONS.map(([t, b]) => (t.includes('Decisions') ? ['7. The decision that sizes it', b] : [t, b])) as [string, string][],
    );
    expect(problems(renamed).join('\n')).toContain('no **decisions** section');
  });
});

describe('a section must state something', () => {
  it('reports a heading with a token under it', () => {
    expect(problems(withSection('Blast radius', 'N/A.')).join('\n')).toContain(
      'reads exactly like a section with nothing to say',
    );
  });

  it('is calibrated well below the corpus, so real prose can never trip it', () => {
    // The shortest section across the five real briefs is 924 characters.
    expect(MIN_SECTION_CHARS).toBeLessThan(924 / 4);
  });
});

describe('the cost section', () => {
  it('accepts a dollar figure — `$0` is a figure and the commonest answer', () => {
    expect(problems(withSection('AWS cost', `${PAD} The delta is $0.`))).toEqual([]);
  });

  it('accepts the explicit no-cost phrase', () => {
    expect(problems(withSection('AWS cost', `${PAD} There is no AWS cost, because nothing is provisioned.`))).toEqual([]);
  });

  it('accepts a "no delta" declaration, including one made in the HEADING', () => {
    // WIDENED BY A FALSE POSITIVE (RA-1656). That brief heads its section
    // `## 6. AWS cost — **no delta**` over 700 characters costing out Aurora wakes, DDL,
    // storage and Stripe Tax volume, and its body happens to carry no `$`. A body-only
    // read rejected it — demanding a ritual token from a section that had done the work,
    // which is the compliance theater RA-949 names as this standard's own risk. `284.md:519`
    // heads its section the same way, so the spelling is the corpus's, not an exception.
    const inHeading = brief(
      SECTIONS.map(([t, b]) =>
        t.includes('AWS cost')
          ? ['5. AWS cost — **no delta**', `${PAD} No new resource, no queue, no alarm, and no new recurring schedule.`]
          : [t, b],
      ) as [string, string][],
    );
    expect(problems(inHeading)).toEqual([]);
  });

  it('reports a cost section that neither prices nor declares', () => {
    // The widening must not make the check unfalsifiable: every alternative is a specific
    // declarative phrase, so a section that costed nothing and said nothing still fails.
    expect(
      problems(withSection('AWS cost', `${PAD} Cheap, probably. We can look at it later.`)).join('\n'),
    ).toContain('neither prices the change nor declares');
    // Cloud-neutral, and pointing at the rule rather than the reference adopter's AGENTS.md.
    const [message] = problems(withSection('AWS cost', `${PAD} Cheap, probably. We can look at it later.`));
    expect(message).toContain('the **cost** section');
    expect(message).toContain('`K-PROJ-6`');
    expect(message).not.toMatch(/AWS|AGENTS\.md/);
  });
});

describe('the observability section', () => {
  it('reports a decision word with no observability vocabulary behind it', () => {
    // Either half alone is trivially satisfiable by prose — "adds" appears in almost any
    // paragraph — so a section that never names what it is deciding about does not pass.
    expect(
      problems(withSection('Observability', `${PAD} This project adds a lot of value.`)).join('\n'),
    ).toContain('does not state an add-or-skip decision');
  });

  it('reports observability vocabulary with no decision in it', () => {
    // THIS TEST DID NOT TEST WHAT IT SAID (RA-1658 review). Its body was 57 characters, so
    // `MIN_SECTION_CHARS` tripped first and `checkBrief` never evaluated the decision
    // half at all — the assertion's `|nothing to say/` alternation is what let it pass on
    // the wrong branch. Isolating it needs a body that is BOTH over 200 characters and
    // free of every decision word, and `PAD` cannot be used because it contains the word
    // "nothing".
    const noDecision =
      'The CloudWatch alarm inventory for this area is listed in `docs/observability.md` ' +
      '§6.2, and the existing metric-filter clauses there remain exactly as they were ' +
      'before this project began; every one of them still refers to the same log line it ' +
      'always did, and the tax signals are untouched.';
    expect(noDecision.length).toBeGreaterThan(MIN_SECTION_CHARS);
    const found = problems(withSection('Observability', noDecision)).join('\n');
    expect(found).toContain('does not state an add-or-skip decision');
    // And it is failing for the RIGHT reason: not the length rule wearing the other
    // rule's name, which is the defect this replaced.
    expect(found).not.toContain('nothing to say');
  });

  it('is honest that the decision half is a weak backstop, not a second gate', () => {
    // Writing the test above took real effort, and that difficulty IS a finding. A
    // 200-character observability section containing none of add/skip/page/nothing is
    // close to unreachable in natural prose, so `OBS_DECISION` catches almost anything
    // while `OBS_VOCABULARY` does the actual work. Recorded as a test rather than only a
    // comment, so that widening the vocabulary later cannot quietly make the pair
    // unfalsifiable without someone reading this.
    const vocabularyOnly = 'This project changes no CloudWatch alarm whatsoever.';
    const decisionOnly = 'We add a great deal of value and skip a lot of toil.';
    expect(OBS_VOCABULARY.test(vocabularyOnly)).toBe(true);
    expect(OBS_DECISION.test(vocabularyOnly)).toBe(false);
    expect(OBS_DECISION.test(decisionOnly)).toBe(true);
    expect(OBS_VOCABULARY.test(decisionOnly)).toBe(false);
  });

  it('accepts a deliberate skip stated in the repo\'s terms', () => {
    expect(
      problems(
        withSection(
          'Observability',
          `${PAD} Skipped: this project emits no \`businessEvent\` and adds no \`pagedBusinessEvents\` clause.`,
        ),
      ),
    ).toEqual([]);
  });
});

describe('the decomposition, read as the reconciler reads it', () => {
  const decomposition = (extra: string) =>
    withSection('Decomposition', `${SECTIONS[2][1]}\n${extra}`);

  it('reports an issue heading the parser will not take', () => {
    // `### Issue C: a colon` is residue. The tick would file a PREFIX of the project
    // and report progress on it, which is the failure the residue guard exists for.
    expect(problems(decomposition('### Issue C: the wrong separator\n')).join('\n')).toContain(
      'not recognised as issues',
    );
  });

  it('reports a missing milestone', () => {
    const noMilestone = withSection(
      'Decomposition',
      SECTIONS[2][1].replace('**Milestone:** Development Automation · **Labels:** `pipeline-improvement`', 'no metadata here'),
    );
    expect(problems(noMilestone).join('\n')).toContain('carries no **Milestone:**');
  });

  /** The fixture with Issue A on `milestone`, checked against `list` as the repository's milestones. */
  const onMilestone = (milestone: string, list?: () => { title: string; due_on: string | null; state: string }[]) =>
    checkBrief(
      'docs/projects/1.md',
      withSection('Decomposition', SECTIONS[2][1].replace('Development Automation', milestone)),
      list ? { milestones: list } : undefined,
    ).map((f) => f.problem).join('\n');
  const repo = [
    { title: 'Launch', due_on: '2026-12-31T00:00:00Z', state: 'open' },
    { title: 'Met gate', due_on: '2026-08-31T00:00:00Z', state: 'closed' },
    { title: 'Someday', due_on: null, state: 'open' },
  ];

  it("accepts Kanon's two buckets without reading the repository (K-WORK-4)", () => {
    expect(ROUTING_BUCKETS).toEqual(['Product Backlog', 'Development Automation']);
    const never = () => {
      throw new Error('read');
    };
    expect(onMilestone('Product Backlog', never)).toBe('');
    expect(onMilestone('Development Automation', never)).toBe('');
  });

  it("accepts a roadmap milestone of this repository, open or met, and names none of its own (kanon#54)", () => {
    expect(onMilestone('Launch', () => repo)).toBe('');
    expect(onMilestone('Met gate', () => repo)).toBe('');
    // The reference adopter's gate and epic are its own: on another repository they are typos.
    expect(onMilestone('Production Ready', () => repo)).toContain("isn't a bucket (Product Backlog, Development Automation) or a milestone of this repository");
    expect(onMilestone('AI Capabilities', () => repo)).toContain('or a milestone of this repository');
  });

  it('reports a milestone with no due date, which is neither a bucket nor a roadmap milestone', () => {
    expect(onMilestone('Someday', () => repo)).toContain('has no due date, so it isn\'t a roadmap milestone');
  });

  it("reports, by name, a roadmap milestone it couldn't check", () => {
    expect(onMilestone('Launch')).toContain("the repository's milestones couldn't be read to check it is a roadmap milestone (no milestone list was read)");
    expect(onMilestone('Launch', () => {
      throw Object.assign(new Error('gh failed'), { stderr: 'HTTP 403: Resource not accessible\nmore' });
    })).toContain('(HTTP 403: Resource not accessible)');
  });

  it('reports an issue that would be filed with an empty body', () => {
    const emptied = withSection(
      'Decomposition',
      SECTIONS[2][1].replace('Acceptance criteria:\n\n- `[AREA-2]` — the criterion this issue takes on.\n', ''),
    );
    expect(problems(emptied).join('\n')).toContain('EMPTY body');
  });

  it('reports a label token welded to prose', () => {
    const welded = withSection(
      'Decomposition',
      SECTIONS[2][1].replace('**Labels:** `sev:high`', '**Labels:** `sev:high` and it is urgent because the gate depends on it'),
    );
    expect(problems(welded).join('\n')).toContain('not a label');
  });

  it('reports a `Closes #N` the parser will not adopt', () => {
    // RA-1303 / RA-1634: adopted ONLY from the metadata line. Elsewhere the tick files a
    // duplicate, and the original can never be closed, because the file phase dedups by
    // title and never re-files.
    const stray = decomposition('### Issue C — A third thing\n**Milestone:** Product Backlog\n\n**Closes #4321** — the one this supersedes.\n');
    expect(problems(stray).join('\n')).toContain('somewhere the parser does not read it');
  });

  it('reports a dependency on an issue the decomposition does not declare', () => {
    const dangling = withSection('Decomposition', SECTIONS[2][1].replace('Issue A (its schema', 'Issue Z (its schema'));
    expect(problems(dangling).join('\n')).toContain('does not declare');
  });

  it('reports a dependency cycle', () => {
    const cyclic = withSection(
      'Decomposition',
      SECTIONS[2][1].replace(
        '**Milestone:** Development Automation · **Labels:** `pipeline-improvement`',
        '**Milestone:** Development Automation · **Labels:** `pipeline-improvement`\n**Depends on:** Issue B (circularly)',
      ),
    );
    expect(problems(cyclic).join('\n')).toContain('dependency cycle');
  });
});

describe('a brief may not carry a `file:line` coordinate (RA-1742)', () => {
  /**
   * THE RULE REPLACES A GUARD RATHER THAN RELAXING ONE, and the measurement is the
   * argument. Six briefs carried 328 coordinates; keeping them honest took a
   * header-commit resolver in `citation-guard`, four PRs re-deriving `961.md` to keep
   * lint green, and three consecutive corrective batches. A document cannot be
   * falsifiable — only a test can — so the coordinate is refused at the source and the
   * machinery that policed it is gone.
   *
   * Every case below MUTATES A PASSING BRIEF and asserts the specific finding, because
   * a ban nobody can trip is the compliance theater this standard names as its own risk.
   */
  it.each([
    ['a source coordinate', 'The write happens in `src/server/services/payments.ts:180`.'],
    ['a range', 'See `scripts/lead-reconcile.mjs:100-140` for the parser.'],
    ['the same-line continuation shorthand', 'In `src/x.ts:12`, and also at `:44`.'],
    ['a coordinate into a document', 'Stated at `docs/observability.md:212`.'],
    // THE COMMONEST FORM IN THE CORPUS, AND THE ONE THE FIRST VERSION MISSED (RA-1744
    // review). A brief is wrapped prose, so the file is named on one line and the
    // continuations trail onto the next — 126 of the six briefs' coordinates are
    // written this way against 387 with a same-line file. `citation-guard` drops these
    // because it RESOLVES coordinates and cannot attribute one whose antecedent it
    // cannot see; this guard BANS THE FORM, so resolvability is not its question.
    ['a continuation whose file is on an EARLIER line', 'The gateway lives in `src/x.ts`\nand the write is at (`:180`).'],
    ['a bare coordinate with no file anywhere', 'The write is at (`:180`), as measured.'],
  ])('refuses %s', (_label, sentence) => {
    const found = problems(withSection('The real problem', `${PAD} ${sentence}`)).join('\n');
    expect(found).toContain('may not carry one');
    expect(found).toContain('Cite the invariant id');
  });

  it('leaves `:00` alone, the one clock form the corpus actually writes', () => {
    // `coordinatesIn` discards `a < 1` because files are 1-indexed, so the AWS-cost
    // idiom — "it rides the `:00` hourly tick" — survives the stricter mode. Measured:
    // across all six briefs and `docs/observability.md` the only backticked clock
    // tokens are `:00`. A `:15` past the hour WOULD fire, and the failure message says
    // to drop the backticks; the corpus's only `:15` is a real line number.
    expect(problems(withSection('AWS cost', `${PAD} $0 — it rides the \`:00\` hourly tick.`))).toEqual([]);
  });

  it('leaves a file named WITHOUT a line alone — naming the file is not the defect', () => {
    // The rot is the line number, which any insertion above invalidates. A path is a
    // name, and a name survives; banning it too would make the rule unusable and
    // therefore overridden.
    expect(problems(withSection('The real problem', `${PAD} It lives in \`scripts/lead-reconcile.mjs\`.`))).toEqual([]);
  });

  it('takes its definition of a coordinate from `citation-guard`, not a second copy', () => {
    // Same recogniser, so "what is a coordinate" cannot mean two things in one lint run
    // — the drift AGENTS.md names. The `.md` form is the one deliberate addition, since
    // that guard resolves claims about CODE and a coordinate into a doc rots identically.
    const src = readFileSync(join(ROOT, 'scripts/brief-guard.mjs'), 'utf8');
    expect(src).toContain("import { coordinatesIn } from './citation-guard.mjs'");
  });
});

describe('an acceptance criterion is a spec id, never restated prose (RA-1742)', () => {
  const withAcs = (acs: string) =>
    withSection(
      'Decomposition',
      SECTIONS[2][1].replace('- `[AREA-2]` — the criterion this issue takes on.', acs),
    );

  it('refuses a criterion written as prose', () => {
    const found = problems(withAcs('- Deliverable: add a CSV export to the admin roster.')).join('\n');
    expect(found).toContain('states an acceptance criterion in prose');
    expect(found).toContain('spec-ids.mjs --apply');
  });

  it('refuses an id that is argued rather than declared', () => {
    // Mid-sentence, an id is ARGUMENT — `verify-acs.mjs` reports it as `mentioned`, not
    // as a commitment. So a bullet that merely mentions one is a prose criterion with a
    // citation in it, and accepting it here would let a project commit to nothing while
    // reading as though it had committed to something.
    const found = problems(withAcs('- The exporter must satisfy `[AREA-9]` in every case.')).join('\n');
    expect(found).toContain('states an acceptance criterion in prose');
  });

  it('accepts the leading-id form, emphasis included', () => {
    expect(problems(withAcs('- **`[AREA-4]`** — taken on by this issue, in bold.'))).toEqual([]);
  });

  it('agrees with `verify-acs` about which bullet markers are bullets', () => {
    // The two recognisers disagreed about `+` (RA-1744 review): `acBullets` read it as a
    // bullet and `AC_DECL` did not, so a real commitment would have been reported as a
    // restatement — the failure message wrong about the thing it refuses. Pinned in
    // both directions rather than by reading one regex.
    for (const marker of ['-', '*', '+', '1.', '1)']) {
      expect(acBullets(`Acceptance criteria:\n\n${marker} \`[AREA-4]\` — one\n`)).toHaveLength(1);
      expect(problems(withAcs(`${marker} \`[AREA-4]\` — taken on by this issue.`))).toEqual([]);
    }
  });

  it('reports an issue that names no acceptance criteria at all', () => {
    const none = withSection(
      'Decomposition',
      SECTIONS[2][1].replace(
        'Acceptance criteria:\n\n- `[AREA-2]` — the criterion this issue takes on.',
        'This issue does the second thing, and it will be obvious when it is done.',
      ),
    );
    expect(problems(none).join('\n')).toContain('names no **Acceptance criteria**');
  });

  // K-PROJ-16: a measurement item's deliverable is a number and its command, not a spec
  // clause, so `**Measures:**` bullets stand in for the criteria.
  const withMeasures = (lines: string) =>
    withSection(
      'Decomposition',
      SECTIONS[2][1].replace('Acceptance criteria:\n\n- `[AREA-2]` — the criterion this issue takes on.', lines),
    );

  it('accepts a measurement item in place of acceptance criteria (K-PROJ-16)', () => {
    expect(problems(withMeasures('- **Measures:** the monthly cost at idle — `npm run cost:idle`'))).toEqual([]);
    expect(measureBullets('- **Measures:** p95 latency — `k6 run load.js`\n- other')).toEqual([
      { line: '- **Measures:** p95 latency — `k6 run load.js`', wellFormed: true },
    ]);
  });

  it('refuses a measurement line that names no command', () => {
    const found = problems(withMeasures('- **Measures:** the monthly cost at idle')).join('\n');
    expect(found).toContain('has a measurement line with no command');
    expect(found).not.toContain('names no **Acceptance criteria**');
  });

  it('still refuses an item with neither criteria nor measurements', () => {
    const found = problems(withMeasures('- **Measured** somewhere, somehow — `cmd`')).join('\n');
    expect(found).toContain('names no **Acceptance criteria** and no **Measures:** lines');
  });

  it('shares one definition of the form with `verify-acs.mjs`', () => {
    // What lint demands and what phase 5 counts as a commitment must be the same shape:
    // a guard accepting a form `verify-acs` reads as nothing produces a project
    // reporting "no criteria" over an issue that stated four.
    const src = readFileSync(join(ROOT, 'scripts/brief-guard.mjs'), 'utf8');
    expect(src).toContain("import { isAcDeclaration } from './verify-acs.mjs'");
  });

  it('reads the criteria list and stops where the prose resumes', () => {
    // `Not in this issue:` is a paragraph, not a criterion, and the template puts one
    // under every issue. Reading it as a criterion would make the template unwritable.
    expect(
      acBullets('Acceptance criteria:\n\n- `[A-1]` — one\n  continued here\n\nNot in this issue: widening.\n\n- a later bullet\n'),
    ).toEqual(['- `[A-1]` — one']);
    expect(acBullets('No criteria region here at all.')).toBeNull();
  });
});

describe('a pre-standard brief is exempt, and the adopter declares which (RA-1742, kanon#54)', () => {

  it('exempts it from the content rules and nothing else', () => {
    const withCoordinate = withSection('The real problem', `${PAD} It is at \`src/x.ts:12\`.`);
    expect(problems(withCoordinate).length).toBeGreaterThan(0);
    expect(checkBrief('docs/projects/2.md', withCoordinate)).toEqual([]);
    // Still held to every SHAPE check — exemption is about claims, not structure.
    expect(checkBrief('docs/projects/2.md', withoutSection('Scope')).map((f) => f.problem).join('\n'))
      .toContain('no **scope** section');
  });

  it("exempts exactly the briefs in the adopter's exemptions file, so a new brief is bound the day it is written", () => {
    expect(isPreStandard('docs/projects/2.md')).toBe(true);
    expect(isPreStandard('docs/projects/1.md')).toBe(false);
    // The reference adopter's six are its own: nothing in the library exempts them.
    expect(isPreStandard('docs/projects/961.md')).toBe(false);
    expect(isPreStandard('docs/projects/_template.md')).toBe(false);
  });
});

describe('which files are briefs', () => {
  it('is the numeric ones, because every consumer resolves a brief by its tracking number', () => {
    expect(isBrief('docs/projects/961.md')).toBe(true);
    expect(isBrief('docs/projects/_template.md')).toBe(false);
    expect(isBrief('docs/projects/payments.md')).toBe(false);
    expect(isBrief('docs/agentic-lead-engineer.md')).toBe(false);
  });
});

describe('briefSections', () => {
  it('reports the line each heading sits on, so a finding can be clicked', () => {
    const md = '# Title\n\nintro\n\n## 1. Scope\n\nbody\n';
    expect(briefSections(md)).toEqual([{ title: '1. Scope', line: 5, body: '\n\nbody\n' }]);
  });
});


describe('briefCorpus', () => {
  /**
   * RA-1663 — the corpus is the index UNION the directory, and the reason is the guard's
   * commonest invocation: `agent-lead.yml` tells a brief's author to run it BEFORE the
   * PR exists, when the file they just wrote is untracked. Reading the index alone
   * printed an affirmative sentence about eleven sections over a file with none.
   */
  const tracked = ['docs/projects/961.md', 'docs/projects/_template.md'];

  it('examines a brief that has not been `git add`ed yet', () => {
    const { briefs } = briefCorpus(tracked, [...tracked, 'docs/projects/99999.md']);
    expect(briefs).toContain('docs/projects/99999.md');
  });

  it('names the untracked briefs, so "examined" is legible and not inferred', () => {
    // The skip line was derived from the index too, so the bad file was not even named
    // as skipped — the failure was silent twice over.
    const { untracked } = briefCorpus(tracked, [...tracked, 'docs/projects/99999.md']);
    expect(untracked).toEqual(['docs/projects/99999.md']);
  });

  it('reports an untracked non-brief as skipped rather than dropping it', () => {
    const { briefs, skipped } = briefCorpus(tracked, [...tracked, 'docs/projects/notes.md']);
    expect(skipped).toContain('docs/projects/notes.md');
    expect(briefs).not.toContain('docs/projects/notes.md');
  });

  it('does not double-count a file that is both tracked and present', () => {
    expect(briefCorpus(tracked, tracked).briefs).toEqual(['docs/projects/961.md']);
    expect(briefCorpus(tracked, tracked).untracked).toEqual([]);
  });
});

describe('RA-1732 — an unanswered decision must not merge', () => {
  // THE CORPUS'S OWN VOCABULARY, not invented: these are the exact shapes
  // `git log -p --all -- docs/projects/` turns up.
  const openHeadlines = [
    '3. **`publicDescription`: global or tenant-editable? ⛔ OPEN — needed before Issue C.**',
    '9. **Are canonical slugs agency-qualified? ⛔ OPEN — gates Issues C and G.**',
    '11. **The hint moves to the course surface. ⚠️ PROPOSED — the developer may overrule.**',
    '4. **Which shape? TBD.**',
  ];
  const answeredHeadlines = [
    '4. **The field-by-field split stands. ✅ 2026-09-06.**',
    '11. **The hint is DROPPED, not relocated. ✅ ANSWERED 2026-09-09.**',
  ];

  it.each(openHeadlines)('flags %s', (h) => {
    expect(OPEN_DECISION.test(h) && !ANSWERED_DECISION.test(h)).toBe(true);
  });

  it.each(answeredHeadlines)('passes %s', (h) => {
    expect(OPEN_DECISION.test(h) && !ANSWERED_DECISION.test(h)).toBe(false);
  });

  it('reads a headline that WRAPS, which is how RA-1019 decision 11 was written', () => {
    // A one-line read missed this exact decision, and it is the incident the check exists
    // for: the marker sat on the SECOND line of a wrapped bold span.
    const body = [
      '11. **The "taxed as …" hint moves to the course surface; it is not fixed in place and not',
      '    silently dropped. ⚠️ PROPOSED — the developer may overrule.**',
      '    Recorded as a decision rather than left to the implementer.',
    ].join('\n');
    const [d] = decisionsIn(body);
    expect(d.n).toBe(11);
    expect(OPEN_DECISION.test(d.headline)).toBe(true);
  });

  it('does NOT flag a brief for narrating how a decision moved', () => {
    // The false positive that forced ANSWERED_DECISION's precedence. A brief recording
    // that a decision WAS open is doing what §11 is for; flagging it would punish the
    // behaviour the standard wants.
    const body = [
      '12. **Decision 3 was OPEN until 2026-09-06 and is now answered. ✅** Retrospective.',
      '    It is marked PROPOSED rather than answered: unlike the others it was reversed.',
    ].join('\n');
    const [d] = decisionsIn(body);
    expect(OPEN_DECISION.test(d.headline) && !ANSWERED_DECISION.test(d.headline)).toBe(false);
  });


  // THE THREE SHAPES THE FIRST TERMINATOR GOT WRONG, each falsified against a real brief
  // before being written as a test. `headline` must be the leading bold span and nothing
  // else, or every marker match is really a match against body prose.
  it('stops at the closing ** — same-line prose after it is NOT the headline', () => {
    // Every decision in 1015.md has this shape, and they passed only because ✅ was there.
    const body = '5. **Use Stripe Connect.** Answered 2026-09-01; the PROPOSED alternative was dropped.';
    const [d] = decisionsIn(body);
    expect(d.headline).toBe('Use Stripe Connect.');
    expect(OPEN_DECISION.test(d.headline)).toBe(false);
  });

  it('a stray * in the trailing prose does not defeat termination', () => {
    // `[^*]*$` in the first version required NO asterisk after the closing `**`, so an
    // italic span, a bullet or a glob appended up to five more lines of body. Measured on
    // the real corpus: 1291.md d4 captured 259 chars and 1015.md d7 captured 427.
    const body = [
      '4. **Keep the detector.** Answered — see *"Keep six issues"* and `docs/projects/*.md`.',
      '   The body below is NOT part of the headline, and it mentions PROPOSED on purpose.',
      '   Nor is this line, which says OPEN.',
    ].join('\n');
    const [d] = decisionsIn(body);
    expect(d.headline).toBe('Keep the detector.');
    expect(OPEN_DECISION.test(d.headline)).toBe(false);
  });



  it('reports the decision own line, not the one after it', () => {
    // briefSections().line is 1-based and body starts with the newline ENDING the heading,
    // so body line k is file line sec.line + k. The first version added 1 and pointed a
    // reader at the decision's second line — a guard emitting a wrong coordinate.
    const md = [
      '# Brief',
      '',
      '## 11. Decisions',
      '',
      '1. **Which shape? ⛔ OPEN.**',
      '',
      // Must clear MIN_SECTION_CHARS, or checkBrief reports the short section and
      // `continue`s before it ever reaches the decisions check.
      'Padding. '.repeat(30),
    ].join('\n');
    const [finding] = checkBrief('docs/projects/1.md', md).filter((x) => /still open/.test(x.problem));
    expect(finding.at).toBe('docs/projects/1.md:5');
    expect(md.split('\n')[4]).toContain('⛔ OPEN');
  });

  it('a decisions section of pure prose is NOT checked — the stated limit', () => {
    // A brief that writes its questions as prose rather than as numbered bold items gets
    // no open-decision check at all. Asserted on a SYNTHETIC section rather than on
    // `_template.md`, which used to be prose and now carries a worked example — the
    // template teaching the shape is the point of that change, so it can no longer stand
    // in for the prose case. The limit is real either way and is stated in §5.7.
    const prose = [
      'The questions that need the developer, numbered, each with the options and your',
      'recommendation. This merge is the only time they are asked.',
      '',
      'We still have to decide whether the settings table is per-tenant. It is OPEN.',
    ].join('\n');
    expect(decisionsIn(prose)).toEqual([]);
  });

  it('reads BOTH item arrangements — `N. **…**` and `**N. …**`', () => {
    // 961.md writes all six of its decisions with the number INSIDE the bold run, and an
    // earlier recogniser required it outside — so it saw ZERO of them, a 1-in-6 miss on
    // the corpus for the guard's own unit of work. The vocabulary and the terminator were
    // both falsified against the corpus; the item recogniser was not, and a parser nobody
    // counts is a parser that agrees with itself.
    const outside = decisionsIn('3. **Keep the fake gateway. ✅ ANSWERED.** Prose after.');
    const inside = decisionsIn('**3. Keep the fake gateway. ✅ ANSWERED.** Prose after.');
    expect(outside).toHaveLength(1);
    expect(inside).toHaveLength(1);
    expect(inside[0].n).toBe(3);
    expect(inside[0].headline).toBe(outside[0].headline);
  });

  it('DECISION_ITEM requires the bold — a fenced block is not a decision', () => {
    // The contract finding 1 broke. Making the LEADING `**` optional is what reads
    // `**N. …**`; relaxing the TRAILING one as well made every line starting `N. ` at
    // column zero a candidate, and the non-greedy capture then ran to the next unrelated
    // `**` up to six lines away. Asserted on the recogniser itself, not only end-to-end,
    // because that is the level the defect lived at.
    expect(DECISION_ITEM.test('1. **Bold follows the number.**')).toBe(true);
    expect(DECISION_ITEM.test('**1. Bold wraps the number.**')).toBe(true);
    expect(DECISION_ITEM.test('1. JobUpdateStatuses   hourly   — free')).toBe(false);
    expect(DECISION_ITEM.test('2. JobCourseReminders  15-min   — TBD, see RA-742')).toBe(false);
  });

  it('a fenced block inside a decisions section produces no phantom decisions', () => {
    // End-to-end for the same defect: an options list or a code fence carrying marker
    // words used to mint decisions of its own and fail a fully-answered brief.
    const body = [
      '2. **Which cron cadence? ✅ ANSWERED — hourly.** Measured:',
      '',
      '```',
      '1. JobUpdateStatuses   hourly   — free',
      '2. JobCourseReminders  15-min   — TBD, see #742',
      '```',
      '',
      '3. **Second decision. ✅ ANSWERED — keep it.** Prose.',
    ].join('\n');
    const ds = decisionsIn(body);
    expect(ds.map((d) => d.n)).toEqual([2, 3]);
    expect(ds.some((d) => OPEN_DECISION.test(d.headline) && !ANSWERED_DECISION.test(d.headline))).toBe(false);
  });

});


describe('RA-2153 — a blocking predecessor named in prose must be on the Depends on: line', () => {
  /** The fixture's decomposition with Issue A's body swapped for `prose`. */
  const withIssueAProse = (prose: string, depsB = 'Issue A (its schema change is what this reads)') =>
    withSection('Decomposition', `${PAD}

### Issue A — Do the first thing
**Milestone:** Development Automation · **Labels:** \`pipeline-improvement\`

${prose}

Acceptance criteria:

- \`[AREA-1]\` — the criterion this issue takes on.

### Issue B — Do the second thing
**Milestone:** Product Backlog · **Labels:** \`sev:high\`
**Depends on:** ${depsB}

Acceptance criteria:

- \`[AREA-2]\` — the criterion this issue takes on.

### Issue C1B — Do the third thing
**Milestone:** Development Automation · **Labels:** \`pipeline-improvement\`

Acceptance criteria:

- \`[AREA-3]\` — the criterion this issue takes on.
`);

  it.each([
    ['If Issue C1B has not landed, this cannot compile.'],
    ['Issue C1B must land first.'],
    ['This starts once Issue C1B lands.'],
    ['It is blocked on Issue C1B.'],
    ['It requires Issue C1B to have landed.'],
    ['It cannot start until Issue C1B is merged.'],
    ['If C1B has not landed, stop — a bare multi-character key, as 1019.md writes it.'],
  ])('refuses %s', (prose) => {
    const found = problems(withIssueAProse(prose)).filter((p) => /does not name Issue C1B/.test(p));
    expect(found, prose).toHaveLength(1);
    expect(found[0]).toMatch(/^Issue A's prose says it waits for Issue C1B/);
  });

  it('reads the reverse direction — “X follows this issue” — as X waiting on this one', () => {
    const found = problems(withIssueAProse('Issue B follows this issue immediately.', 'Issue C1B')).filter((p) => /does not name/.test(p));
    expect(found).toEqual([expect.stringMatching(/^Issue B's prose says it waits for Issue A/)]);
  });

  it('is satisfied by the line, and silent on prose that is not an edge', () => {
    expect(problems(withIssueAProse('It is blocked on data this repository does not have, unlike Issue C1B.'))).toEqual([]);
    expect(problems(withIssueAProse('Issue C1B is related background.'))).toEqual([]);
    // A bare single letter is too common a word to read as a key.
    expect(omittedPredecessors(parseProposed(withIssueAProse('If B has not landed, whatever.')))).toEqual([]);
  });

  // kanon#169: the phrases match the positive form, so a sentence DENYING the edge used to
  // read as one, and the guard's remedy then added an edge that does not exist.
  it.each([
    ['This issue is not blocked on Issue C1B.'],
    ['Unlike Issue B, this is NOT blocked by Issue C1B at all.'],
    ["It isn't blocked by Issue C1B, and never was."],
    ['Not in this issue: anything blocked on Issue C1B, or its follow-ups.'],
    ['Not in this issue: deciding whether Issue C1B follows this issue.'],
    ['Once Issue C1B lands in the future, a follow-up may extend this.'],
    ['It does not matter if Issue C1B has not landed.'],
  ])('lints clean on a denied edge: %s', (prose) => {
    expect(problems(withIssueAProse(prose))).toEqual([]);
  });

  it.each([
    // A negation elsewhere in the sentence is not this phrase's: the window stops at the clause.
    ['Issue C1B is not optional; this is blocked on Issue C1B.'],
    ['Issue B is not related, but this is blocked on Issue C1B.'],
    ['Issue B: not needed; blocked on Issue C1B instead.'],
    // Two words, not the whole clause: a negation further back is about something else.
    ['It is not surprising that this is blocked on Issue C1B.'],
    // The sentence after the boundary is the issue's own again, and so is the next paragraph,
    // even when the boundary line has no full stop.
    ['Not in this issue: widening. This is blocked on Issue C1B.'],
    ['Not in this issue: widening, or a rewrite\n\nThis starts once Issue C1B lands.'],
    // The clause after the edge is this issue, not a follow-up.
    ['Once Issue C1B lands, this starts.'],
  ])('still refuses a real edge beside a negation: %s', (prose) => {
    const found = problems(withIssueAProse(prose)).filter((p) => /does not name Issue C1B/.test(p));
    expect(found, prose).toHaveLength(1);
  });

  it('gives the reverse direction the same treatment', () => {
    expect(problems(withIssueAProse('Not in this issue: whether Issue B follows this issue.', 'Issue C1B'))).toEqual([]);
    expect(problems(withIssueAProse('Not in this issue: widening. Issue B follows this issue.', 'Issue C1B')))
      .toEqual([expect.stringMatching(/^Issue B's prose says it waits for Issue A/)]);
  });

});

describe('RA-2147 — criteria ordinals and `Issue X criterion N` references', () => {
  const numbered = (nums: number[]) => `Acceptance criteria:\n\n${nums.map((n) => `${n}. \`[AREA-${n}]\` — c.`).join('\n')}\n`;

  it('finds the first gap in a numbered list, and ignores unnumbered bullets', () => {
    expect(criteriaOrdinalGap(numbered([1, 2, 3]))).toBeNull();
    expect(criteriaOrdinalGap(numbered([1, 2, 3, 5, 6]))).toEqual({ expected: 4, found: 5 });
    expect(criteriaOrdinalGap(numbered([2, 3])), 'a list must start at 1').toEqual({ expected: 1, found: 2 });
    expect(criteriaOrdinalGap('Acceptance criteria:\n\n- `[AREA-1]` — c.\n- `[AREA-2]` — c.\n')).toBeNull();
  });

  it('refuses a gapped list in a standard brief', () => {
    const md = withSection('Decomposition', `${PAD}

### Issue A — Do the first thing
**Milestone:** Development Automation · **Labels:** \`pipeline-improvement\`

${numbered([1, 2, 4])}`);
    expect(problems(md)).toEqual([expect.stringMatching(/criterion 3 is written 4/)]);
  });

  it('resolves `Issue X criterion N` against X’s criteria', () => {
    const proposed = parseProposed(brief());
    expect(danglingCriterionRefs('see Issue A criterion 1', proposed)).toEqual([]);
    expect(danglingCriterionRefs('see Issue A criterion 2', proposed)).toEqual([{ ref: 'Issue A criterion 2', why: 'Issue A has 1 criteria' }]);
    expect(danglingCriterionRefs('see Issue Z criterion 1', proposed)[0].why).toMatch(/declares no Issue Z/);
    // Plural narration of a renumbering is not a reference (1019.md's own forms).
    expect(danglingCriterionRefs('criteria 3 and 4 moved to Issue A; Issue A criteria 5 and 7', proposed)).toEqual([]);
  });

  it('refuses a dangling reference in a standard brief', () => {
    const md = withSection('Scope', `${PAD} As Issue B criterion 9 says.`);
    expect(problems(md)).toEqual([expect.stringMatching(/“Issue B criterion 9” points at nothing/)]);
  });
});

describe('RA-1748 — a decisions section that parses to zero items is surfaced', () => {
  it.each([
    ['1. __Bold with underscores.__'],
    ['  1. **Indented item.**'],
    ['1.**NoSpace bold.**'],
  ])('flags %s', (line) => {
    expect(unparsedDecisionLines(`${PAD}\n\n${line}\n`)).toBe(1);
    expect(problems(withSection('Decisions', `${PAD}\n\n${line}\n`))).toEqual([expect.stringMatching(/parses to ZERO decisions/)]);
  });

  it('keeps PR RA-1736’s two reproductions green — a fence, and an options list beside real decisions', () => {
    const fenced = `${PAD}\n\n\`\`\`\n1. JobUpdateStatuses   hourly   — free\n2. JobCourseReminders  15-min   — TBD\n\`\`\`\n`;
    expect(unparsedDecisionLines(fenced)).toBe(0);
    const beside = `2. **Which cadence? ✅ ANSWERED — hourly.**\n\n1. hourly\n2. 15-min — TBD\n`;
    expect(unparsedDecisionLines(beside)).toBe(0);
    expect(problems(withSection('Decisions', fenced))).toEqual([]);
  });

  it('is silent on a section with no numbered lines at all', () => {
    expect(unparsedDecisionLines(`${PAD} None outstanding.`)).toBe(0);
  });
});

describe("Kanon's own brief template passes the brief guard (#55)", () => {
  // The template says the guard runs against it (`K-PRIN-11`). This is that run, so a
  // change to either side that breaks the other fails here, not in an adopter's first brief.
  it('has no findings', () => {
    const template = readFileSync(join(ROOT, 'rulebook/templates/brief.md'), 'utf8');
    expect(checkBrief('docs/projects/_template.md', template)).toEqual([]);
  });
});
