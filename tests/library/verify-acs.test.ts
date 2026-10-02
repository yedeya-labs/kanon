import { describe, expect, it } from 'vitest';

import { citations } from '../../scripts/spec-coverage.mjs';
import { acsFromBrief, applyRuns, runnerFor, summarise, verdicts } from '../../scripts/verify-acs.mjs';

/**
 * RA-1068 — resolving a project's acceptance criteria to executable evidence.
 *
 * The rule the whole file exists to enforce: an AC with no citing test is
 * `unverifiable`, NEVER `passed`. Folding "no evidence" into "verified" makes
 * phase 5 a rubber stamp reporting green on a project where nothing was checked —
 * silent-absence (§12.7) on the artifact that CLOSES the project.
 */
const BRIEF = `# Brief

## 3. Decomposition

### Issue A — Reconcile the area
**Milestone:** Development Automation · **Labels:** \`pipeline-improvement\`

- \`[PAY-1]\` — a required from-set at every call site.
- \`[PAY-2]\` — terminal is terminal.
- Deliverable: the six call sites match the table.

### Issue B — Move the guard
**Milestone:** Production Ready · **Labels:** \`sev:critical\`

- \`[PAY-2]\` — refused by the callee whatever the caller declares.
- \`[ESCAPE-5]\` — a cross-area citation is still an acceptance criterion.

## 4. Sequencing
`;

describe('acsFromBrief', () => {
  it('reads the IDs each issue cites, and which issue cited them', () => {
    expect(acsFromBrief(BRIEF).filter((a) => a.declared)).toEqual([
      { id: 'PAY-1', issue: 'A', title: 'Reconcile the area', declared: true },
      { id: 'PAY-2', issue: 'A', title: 'Reconcile the area', declared: true },
      { id: 'PAY-2', issue: 'B', title: 'Move the guard', declared: true },
      { id: 'ESCAPE-5', issue: 'B', title: 'Move the guard', declared: true },
    ]);
  });

  it('sees a BOLDED leading declaration', () => {
    // The pilot brief already contains one, in Issue C (961.md:474):
    //   - **`[PAY-3]` is pinned here (decision 4), and this is new scope…**
    // An issue explicitly taking a criterion on. The un-emphasised regex dropped
    // it, and a DROPPED criterion cannot block the verdict — so a project could
    // report VERIFIED with it never checked. Over-capture only ever added a noisy
    // `unverifiable`; omission is silent, which is why the two are not symmetric.
    const bolded = `# Brief

## 3. Decomposition

### Issue C — Take one on in bold
**Milestone:** Development Automation · **Labels:** \`pipeline-improvement\`

- **\`[PAY-3]\` is pinned here (decision 4), and this is new scope for this issue.**
1. \`[PAY-8]\` — an ordered-list declaration counts too.

## 4. Sequencing
`;
    const ids = acsFromBrief(bolded).filter((a) => a.declared).map((a) => a.id);
    expect(ids).toEqual(['PAY-3', 'PAY-8']);
  });

  it('reports a repeated mention once, not once per occurrence', () => {
    // An ID argued about repeatedly in one issue is ONE mention. Five identical
    // rows would drown the table the `mentioned` mechanism exists to make readable.
    const repeated = `# Brief

## 3. Decomposition

### Issue E — Argue at length
**Milestone:** Product Backlog · **Labels:** \`question\`

- Deliberating \`[PAY-9]\` here, and \`[PAY-9]\` again, and once more \`[PAY-9]\`.

## 4. Sequencing
`;
    expect(acsFromBrief(repeated).filter((a) => a.id === 'PAY-9')).toHaveLength(1);
  });

  it('reports an ID it did not recognise as a declaration, never drops it', () => {
    // The guard behind the guard: a declaration form the regex does not yet know
    // about becomes VISIBLE as `mentioned` instead of vanishing. Omission is the
    // dangerous direction precisely because nothing downstream can see it.
    const odd = `# Brief

## 3. Decomposition

### Issue D — An unrecognised form
**Milestone:** Product Backlog · **Labels:** \`question\`

> \`[PAY-9]\` — declared inside a blockquote, which the regex does not match.

## 4. Sequencing
`;
    const row = acsFromBrief(odd).find((a) => a.id === 'PAY-9');
    expect(row).toBeDefined();
    expect(row?.declared).toBe(false);
  });

  it('takes a LEADING declaration only, never an ID used in argument', () => {
    // The defect this replaced: scanning the whole body reported 13 criteria for
    // the pilot where its own falsifiability table commits to seven. The extras
    // were a parenthetical, an italic aside, an ANALOGY (`[ESCAPE-5]` — "the model
    // is…") and a justification. Issue A is the unambiguous case: its section says
    // "Not in this issue: writing tests", and the whole-body scan gave it two.
    const arguing = `# Brief

## 3. Decomposition

### Issue A — Argue, commit to nothing
**Milestone:** Development Automation · **Labels:** \`pipeline-improvement\`

- Deliverable: the six call sites match the table (that is the whole point of \`[PAY-3]\`).
- The model is \`[ESCAPE-5]\` — lint-enforced, and the analogy ends there.
- \`[PAY-9]\` — this one IS a commitment, because it leads its bullet.

## 4. Sequencing
`;
    expect(acsFromBrief(arguing).filter((a) => a.declared).map((a) => a.id)).toEqual(['PAY-9']);
  });

  it('reads issue BODIES, not the whole brief', () => {
    // A brief's prose cites IDs while ARGUING — §1 of the real one discusses PAY-3
    // at length before the decomposition exists. Only the decomposition's ACs are
    // commitments, so an ID mentioned in the argument must not become one.
    const withProse = BRIEF.replace('# Brief', '# Brief\n\nThe problem is best seen through `[PAY-99]`, which nothing here commits to.');
    expect(acsFromBrief(withProse).filter((a) => a.declared).map((a) => a.id)).not.toContain('PAY-99');
  });

  it('does not double-count an ID cited twice by one issue', () => {
    const twice = BRIEF.replace('- Deliverable: the six call sites match the table.', '- `[PAY-1]` — restated later in the same issue.');
    expect(acsFromBrief(twice).filter((a) => a.issue === 'A' && a.id === 'PAY-1')).toHaveLength(1);
  });
});

describe('verdicts — exactly three answers, never a default', () => {
  const known = new Set(['PAY-1', 'PAY-2', 'ESCAPE-5']);

  it('an AC with a citing test has evidence', () => {
    const cited = new Map([['PAY-1', new Set(['tests/unit/payments.test.ts'])]]);
    const [row] = verdicts([{ id: 'PAY-1', issue: 'A', title: 't' }], cited, known);
    expect(row.status).toBe('has-test');
    expect(row.tests).toEqual(['tests/unit/payments.test.ts']);
  });

  it('an AC with NO citing test is unverifiable, not passed', () => {
    // Measured on the pilot the day this was written: all 13 of RA-961's AC citations
    // resolved to zero tests, because the tests are written DURING implementation.
    // A project verified that day must read as "nothing was checked".
    const [row] = verdicts([{ id: 'PAY-2', issue: 'A', title: 't' }], new Map(), known);
    expect(row.status).toBe('unverifiable');
  });

  it('an ID no spec declares is not-an-invariant, not a failure', () => {
    // §6.2: not every AC maps to an invariant and forcing it is a mistake. A cited
    // ID that no spec declares is a typo or a deleted invariant — blaming the
    // PROJECT for a bookkeeping error would send an implementer after nothing.
    const [row] = verdicts([{ id: 'PAY-404', issue: 'A', title: 't' }], new Map(), known);
    expect(row.status).toBe('not-an-invariant');
  });
});

describe('summarise — a project is not verified by default', () => {
  const rows = (statuses: string[]) => statuses.map((status, i) => ({ id: `X-${i}`, issue: 'A', title: 't', status, tests: [] }));

  it('counts a not-run criterion as evidence that EXISTS but was not executed', () => {
    // The evidence exists; the tool declined to run it. Excluding it made an
    // all-`not-run` report print "every acceptance criterion lacks an executable
    // test" — false, and a collapse of exactly the distinction the four outcomes
    // were built to keep apart, in the sentence a human reads before closing a
    // project. (The VERIFIED verdict was never affected — it fails closed.)
    expect(summarise(rows(['not-run', 'not-run'])).anyEvidence).toBe(true);
    expect(summarise(rows(['not-run'])).verified).toBe(false);
  });

  it('reports no evidence when nothing has a test', () => {
    const s = summarise(rows(['unverifiable', 'unverifiable']));
    expect(s.anyEvidence).toBe(false);
    expect(s.fullyCovered).toBe(false);
  });

  it('partial coverage is not full coverage', () => {
    const s = summarise(rows(['has-test', 'unverifiable']));
    expect(s.anyEvidence).toBe(true);
    expect(s.fullyCovered).toBe(false);
  });

  it('an empty AC list is NOT fully covered', () => {
    // A brief citing no invariants at all would otherwise satisfy `every()`
    // vacuously and read as fully verified — the emptiest possible rubber stamp.
    expect(summarise([]).fullyCovered).toBe(false);
  });

  it('is fully covered only when every criterion has evidence', () => {
    expect(summarise(rows(['has-test', 'has-test'])).fullyCovered).toBe(true);
  });

  it('a not-an-invariant citation does not hold the project un-coverable', () => {
    // A typo or a deleted invariant is a BOOKKEEPING error. Counting it against the
    // project leaves it permanently un-coverable for a reason it cannot fix — and
    // it is already reported separately and loudly.
    expect(summarise(rows(['has-test', 'not-an-invariant'])).fullyCovered).toBe(true);
  });

  it('but a project whose citations are ALL bookkeeping errors is not covered', () => {
    expect(summarise(rows(['not-an-invariant'])).fullyCovered).toBe(false);
  });
});


describe("this file's own fixtures are not evidence (RA-1068)", () => {
  it('does not count as a citing test for the IDs it quotes', () => {
    // Found live: the moment this file existed, five of project RA-961's acceptance
    // criteria read `has-test` with THIS FILE as the evidence, because `citations()`
    // scans test files for ID patterns and the brief fixture below quotes
    // [PAY-1], [PAY-2] and [ESCAPE-5] as sample data.
    //
    // Same class as everything else this mechanism keeps hitting: a document
    // CONTAINING a token treated as USING it. `spec-coverage.mjs`'s NOT_COVERAGE
    // list exists for exactly this and its guard says so — "until then the ID
    // tooling's fixtures are counted as real coverage".
    //
    // Asserted here rather than trusted to the list, because the failure is silent:
    // a tool reporting its own test as proof of the thing it tests.
    const cited = citations();
    for (const id of ['PAY-1', 'PAY-2', 'ESCAPE-5']) {
      const files = [...(cited.get(id) ?? [])];
      expect(files, `${id} cited by this test file`).not.toContain('tests/unit/verify-acs.test.ts');
    }
  });
});


describe('applyRuns — executed, or not checked (RA-1068)', () => {
  const row = (tests: string[]) => ({ id: 'PAY-1', issue: 'B', title: 't', status: 'has-test', tests });

  it('passes only when every citing test passed', () => {
    const r = applyRuns([row(['tests/a.test.ts', 'tests/b.test.ts'])], new Map([['tests/a.test.ts', true], ['tests/b.test.ts', true]]));
    expect(r[0].status).toBe('passed');
  });

  it('one failing citation fails the criterion, however many passed', () => {
    // An invariant cited by two tests is claimed by both. One passing does not
    // excuse the other failing.
    const r = applyRuns([row(['tests/a.test.ts', 'tests/b.test.ts'])], new Map([['tests/a.test.ts', true], ['tests/b.test.ts', false]]));
    expect(r[0].status).toBe('failed');
  });

  it('a test that was never executed is not-run, NOT passed', () => {
    // The whole point of the file: "no evidence" and "verified" must never be the
    // same answer. A criterion whose evidence exists but was not executed has not
    // been checked.
    const r = applyRuns([row(['e2e/thing.spec.ts'])], new Map());
    expect(r[0].status).toBe('not-run');
  });

  it('leaves unverifiable and not-an-invariant alone', () => {
    const rows = [
      { id: 'A-1', issue: 'B', title: 't', status: 'unverifiable', tests: [] },
      { id: 'A-2', issue: 'B', title: 't', status: 'not-an-invariant', tests: [] },
    ];
    expect(applyRuns(rows, new Map()).map((r) => r.status)).toEqual(['unverifiable', 'not-an-invariant']);
  });
});

describe('runnerFor — a file this tool cannot run is not evidence it can read', () => {
  it.each([
    ['tests/unit/x.test.ts', 'vitest'],
    ['e2e/storefront.spec.ts', 'playwright'],
    ['scripts/qa/x.mjs', 'unknown'],
  ])('%s -> %s', (file, expected) => {
    expect(runnerFor(file)).toBe(expected);
  });
});

describe('the verdict phase 5 acts on', () => {
  const rows = (statuses: string[]) => statuses.map((status, i) => ({ id: `X-${i}`, issue: 'A', title: 't', status, tests: [] }));

  it('verified only when every judgeable criterion PASSED', () => {
    expect(summarise(rows(['passed', 'passed'])).verified).toBe(true);
  });

  it.each([
    ['unverifiable'],
    ['not-run'],
    ['failed'],
    ['has-test'],
  ])('a single %s criterion blocks the verdict', (status) => {
    // `has-test` blocks too: resolved but never executed is not checked either.
    expect(summarise(rows(['passed', status])).verified).toBe(false);
  });

  it('a bookkeeping error does not block it', () => {
    expect(summarise(rows(['passed', 'not-an-invariant'])).verified).toBe(true);
  });

  it('a mere mention does not block it, and does not count as one either', () => {
    expect(summarise(rows(['passed', 'mentioned'])).verified).toBe(true);
    expect(summarise(rows(['mentioned'])).verified).toBe(false);
  });

  it('an empty criteria list is NOT verified', () => {
    expect(summarise([]).verified).toBe(false);
  });
});
