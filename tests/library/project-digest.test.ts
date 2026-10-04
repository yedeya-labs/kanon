import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers/adopter.js';
const {
  BAIL_RE,
  BRIEF_DIR,
  QUIET_AFTER_DAYS,
  closesIssue,
  briefTitle,
  buildMessage,
  narrativeMissing,
  classifyDispatch,
  classifyProject,
  readBrief,
  renderMember,
  renderProject,
  holdReason,
  holdReasonOf,
  dispatchCommentsOf,
  membersOf,
  HELD_MARKER,
} = await import('../../scripts/project-digest.mjs');
const { CONFLICT_SHORT } = await import('../../scripts/conflict-state.mjs');
const reconciler = await import('../../scripts/lead-reconcile.mjs');
const closure = await import('../../scripts/project-closure.mjs');
const { carriedOut: reconcilerCarriedOut, openGatingWork, parseProposed, renderHoldComment } = await import('../../scripts/lead-reconcile.mjs');

/**
 * RA-1438 — the daily project digest. Moved from the reference adopter with the digest's lane
 * (plan 0004 step 10). The adopter keeps the case that holds its own on-demand skill to this
 * script; the lane's own wiring is tested in `tests/unit/digest-lanes.test.ts`.
 *
 * The defect this digest exists to prevent is a HUMAN one: RA-1305 bailed awaiting
 * a decision and sat for three days. So the tests that matter are not about
 * formatting, they are about the two derivations that decide whether the post
 * sends the reader to the right action:
 *
 *   1. bail vs stall — opposite responses, identical labels and PR state;
 *   2. unfiled vs active vs complete — all three are facts about the project
 *      alone. There used to be a fourth, `starved`, derived from the project's
 *      POSITION relative to its neighbours; RA-1483 deleted the pick rule it read
 *      and RA-1490 deleted the classification.
 *
 * Getting either backwards is worse than posting nothing, so both are pinned.
 */

const member = (over = {}) => ({
  number: 1305,
  title: 'Delete the Authorize.net gateway',
  url: 'https://github.com/o/r/issues/1305',
  state: 'OPEN',
  ageDays: 3,
  waitedDays: 3,
  disposition: 'bail',
  ...over,
});

const NOW = new Date('2026-09-02T12:00:00Z');
/** A comment the way the API returns it, oldest first. */
const c = (body: string, createdAt = '2026-09-02T12:00:00Z') => ({ body, createdAt });
const BAIL = '## SCOPE-FIRST BAIL — credential change. Plan below; label kept; no PR opened.';

describe('readBrief — the digest counts what the reconciler would file (cleanup round 5)', () => {
  const D = '## 5. Decomposition\n';

  it('counts `### Issue X —` items in the decomposition, two-character keys included', () => {
    expect(readBrief(`${D}### Issue A — one\n### Issue A2 — two\n`).proposed).toBe(2);
  });

  it('does not count prose headings, or deeper headings beneath an item', () => {
    // 961.md really has `### The class, and the evidence that it is one class`.
    expect(readBrief('### The class, and the evidence that it is one\n' +
      `${D}### Issue A — real\n#### Issue A.1 — detail\n`).proposed).toBe(1);
  });

  it('handles a brief that decomposes into nothing', () => {
    expect(readBrief('# A brief\n## 1. Scope\n').proposed).toBe(0);
  });

  // THE DISAGREEMENTS THE OLD WHOLE-FILE COUNT HAD. Each of these read as one size in the
  // "unfiled" line and the fallback denominator and another in the closure join.
  it.each([
    ['an item heading OUTSIDE the decomposition', `### Issue Z — in the rationale\n${D}### Issue A — real\n`],
    ['an item heading with the wrong separator', `${D}### Issue A — real\n### Issue B: not taken\n`],
    ['item headings with no decomposition section at all', '### Issue A — one\n### Issue B — two\n'],
  ])('%s: `proposed` is exactly the parse the closure join uses', (_why, md) => {
    const { proposed, briefItems } = readBrief(md);
    expect(briefItems).toEqual(parseProposed(md));
    expect(proposed).toBe(parseProposed(md).length);
  });
});

describe('ONE brief grammar, ONE closure rule — the digest and the reconciler share them', () => {
  // Identity, not equality: the same function object, so there is no second copy that
  // could drift, and the reconciler re-exports rather than re-defines.
  it.each(['parseProposed', 'openGatingWork', 'carriedOut', 'itemSatisfied', 'declaresMembership'] as const)(
    '`%s` is the shared module\'s own function in the reconciler', (name) => {
      expect(typeof closure[name]).toBe('function');
      expect(reconciler[name]).toBe(closure[name]);
    });

  it('the digest imports them from the shared module and keeps no grammar of its own', () => {
    const src = readFileSync(join(ROOT, 'scripts/project-digest.mjs'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toMatch(/import \{[^}]*\bparseProposed\b[^}]*\} from '\.\/project-closure\.mjs'/);
    // Not the reconciler: importing it pulls its CLI's top level into the digest job.
    expect(code).not.toMatch(/from '[^']*lead-reconcile\.mjs'/);
    // No second reader of item headings — the old `countProposed` regex, or any other.
    expect(code).not.toMatch(/Issue \[A-Z/);
    expect(code).not.toMatch(/\bcountProposed\b/);
  });

  it('the shared module is pure — it imports nothing', () => {
    const src = readFileSync(join(ROOT, 'scripts/project-closure.mjs'), 'utf8');
    // Any static import, re-export-from, or dynamic import — a re-export from the reconciler
    // would load its CLI top level into the digest just as surely as an import.
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/\bfrom\s*['"]/);
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });
});

describe('membersOf — membership by the reconciler\'s position rule (kanon#174)', () => {
  const marker = '<!-- qa:project 12 -->';
  const hit = (number: number, body: string) => ({ number, body });

  it('counts an issue whose LAST non-empty line is the marker', () => {
    expect(membersOf([hit(1, `Part of #12.\n\n${marker}\n\n`)], 12).map((i: { number: number }) => i.number)).toEqual([1]);
  });

  it('does not count a body that QUOTES the marker mid-body, which the reconciler does not either', () => {
    const quote = hit(2, `The filer appends \`${marker}\` as the last line.\n${marker}\nMore prose after it.`);
    expect(membersOf([quote], 12)).toEqual([]);
    expect(reconciler.declaresMembership(quote.body, 12)).toBe(false);
  });

  it('does not count another project\'s marker, or a spacing variant the reconciler rejects', () => {
    expect(membersOf([hit(3, '<!-- qa:project 120 -->'), hit(4, '<!--qa:project 12-->')], 12)).toEqual([]);
  });

  it('the I/O path selects members with it, and keeps no marker regex of its own', () => {
    const src = readFileSync(join(ROOT, 'scripts/project-digest.mjs'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toMatch(/const members = membersOf\(hits, b\.number\);/);
    expect(code).not.toMatch(/<!--[^`'"]*qa:project/);
  });
});

describe('briefTitle', () => {
  it('strips the "Project brief —" boilerplate', () => {
    expect(briefTitle('# Project brief — make the credential surfaces safe', 'x'))
      .toBe('make the credential surfaces safe');
  });

  it('strips the "Project #N —" form', () => {
    expect(briefTitle('# Project #961 — close the order-settlement class', 'x'))
      .toBe('close the order-settlement class');
  });

  it('falls back to the tracking issue title when there is no H1', () => {
    expect(briefTitle('no heading here', 'Fallback')).toBe('Fallback');
  });
});

describe('classifyDispatch — the classification the digest must not get wrong', () => {
  const d = (over = {}) => classifyDispatch({ now: NOW, ...over });

  it('reads a scope-first bail as awaiting a DECISION, not as a stall', () => {
    expect(d({ comments: [c(BAIL)], hasPr: false, ageDays: 99 }).disposition).toBe('bail');
  });

  it('does not let age alone turn a bail into a stall', () => {
    expect(d({ comments: [c(BAIL)], hasPr: false, ageDays: 365 }).disposition).not.toBe('stall');
  });

  it('reads an answered bail as awaiting a RE-DISPATCH, not another decision', () => {
    const comments = [c(BAIL, '2026-08-30T20:10:00Z'), c('AUTHORISED — proceed.')];
    expect(d({ comments, hasPr: false, ageDays: 3 }).disposition).toBe('authorised');
  });

  it('reads silence past the quiet threshold as a stall', () => {
    expect(d({ comments: [], hasPr: false, ageDays: QUIET_AFTER_DAYS }).disposition).toBe('stall');
  });

  it('does not call a fresh dispatch a stall', () => {
    expect(d({ comments: [], hasPr: false, ageDays: 0 }).disposition).toBe('dispatched');
  });

  it('an open PR that CLOSES the issue outranks everything — it is being built', () => {
    expect(d({ comments: [c(BAIL)], hasPr: true, ageDays: 99 }).disposition).toBe('building');
  });

  it('counts a bail comment from any author, so a human restating one cannot flip it', () => {
    expect(d({ comments: [c('quoting the scope-first bail above')], ageDays: 9 }).disposition).toBe('bail');
  });

  it("BAIL_RE matches agent-implement.yml's marker as the prompt spells it", () => {
    // Guards the coupling: the workflow prompt says "SCOPE-FIRST BAIL", and if
    // that wording changes this regex must change with it.
    expect(readFileSync(join(ROOT, '.github/workflows/agent-implement.yml'), 'utf8')).toMatch(BAIL_RE);
  });

  // ---- RA-1443 review, finding 2 --------------------------------------------
  it('A BAIL NEVER CLEARS A BAIL — a re-dispatch that bails again still wants a decision', () => {
    // The failure this pins: keying off the FIRST bail made the second bail look
    // answered by the first one's reply, and the issue went silent while still
    // unambiguously awaiting a decision.
    const comments = [c(BAIL, '2026-08-25T10:00:00Z'), c('AUTHORISED'), c(BAIL, '2026-08-30T20:10:00Z')];
    expect(d({ comments, ageDays: 3 }).disposition).toBe('bail');
  });

  it('clears a bail only with a comment that is not itself a bail', () => {
    const twoBails = [c(BAIL, '2026-08-25T10:00:00Z'), c(BAIL, '2026-08-30T20:10:00Z')];
    expect(d({ comments: twoBails, ageDays: 3 }).disposition).toBe('bail');
    expect(d({ comments: [...twoBails, c('go ahead')], ageDays: 3 }).disposition).toBe('authorised');
  });

  it("reproduces RA-1305's real comment shape — implementer, human, implementer", () => {
    // The Implementer (bail) -> a person (authorisation) -> the Implementer (progress). Answered.
    const comments = [c(BAIL, '2026-08-30T20:10:00Z'), c('AUTHORISED — proceed.'), c('Building now.')];
    expect(d({ comments, ageDays: 0 }).disposition).toBe('authorised');
  });

  // ---- RA-1443 review, finding 4 --------------------------------------------
  it('reports the wait from the BAIL COMMENT, not from updatedAt', () => {
    // RA-1305: bail at 2026-08-30T20:10Z, updatedAt bumped to 2026-09-02T19:37Z by a
    // later label change. Reporting `ageDays` printed 0d for a three-day-old bail,
    // and that number is the only urgency on the line.
    const { waitedDays } = d({ comments: [c(BAIL, '2026-08-30T20:10:00Z')], ageDays: 0 });
    expect(waitedDays).toBe(2);
  });

  it('falls back to the silence age when the bail comment carries no timestamp', () => {
    expect(d({ comments: [{ body: BAIL }], ageDays: 7 }).waitedDays).toBe(7);
  });

  it('never reports a negative wait', () => {
    expect(d({ comments: [c(BAIL, '2027-01-01T00:00:00Z')], ageDays: 0 }).waitedDays).toBe(0);
  });
});

// ---- RA-1443 review, finding 1 ----------------------------------------------
describe('closesIssue — a closing reference, never a prose mention', () => {
  it('matches every closing keyword GitHub honours', () => {
    for (const kw of ['Closes', 'closed', 'Fixes', 'fixed', 'Resolves', 'resolve']) {
      expect(closesIssue(`${kw} #1305`, 1305)).toBe(true);
    }
  });

  it('rejects a prose mention — the exact failure RA-1443 demonstrated', () => {
    // This PR's own body names RA-1305 without implementing it. Reported as
    // "building", it would have SUPPRESSED the bail line entirely.
    expect(closesIssue('#1305 bailed on 2026-08-30 awaiting a human decision', 1305)).toBe(false);
  });

  it('does not match a different issue number sharing a prefix', () => {
    expect(closesIssue('Closes #13050', 1305)).toBe(false);
    expect(closesIssue('Closes #1305', 130)).toBe(false);
  });

  it('tolerates the colon form and an empty body', () => {
    expect(closesIssue('Closes: #1305', 1305)).toBe(true);
    expect(closesIssue(null, 1305)).toBe(false);
  });

  it('recognises every spelling GitHub\'s linker acts on, not only #N (RA-1733)', () => {
    const repo = 'owner/repo';
    for (const ref of ['#1305', `${repo}#1305`, 'GH-1305', `https://github.com/${repo}/issues/1305`]) {
      expect(closesIssue(`Closes ${ref}`, 1305, repo), ref).toBe(true);
    }
  });

  it('does not count a closing ref to ANOTHER repository (RA-1733)', () => {
    expect(closesIssue('Closes other/repo#1305', 1305, 'owner/repo')).toBe(false);
    expect(closesIssue('Closes https://github.com/other/repo/issues/1305', 1305, 'owner/repo')).toBe(false);
  });
});

describe('classifyProject', () => {
  const members = [{ state: 'OPEN' }, { state: 'CLOSED' }];

  it('calls a brief with proposals and nothing filed NEVER RECONCILED', () => {
    expect(classifyProject({ proposed: 9, members: [], held: false }))
      .toMatchObject({ status: 'unfiled', filed: 0 });
  });

  // ---- RA-1490 -------------------------------------------------------------
  // These two WERE the `starved` cases. `agent-lead-reconcile.yml` reconciled one
  // project per tick, lowest-numbered first, so every other open project was
  // classified `starved` — and RA-1483 deleted that rule. The 07:35 digest was
  // posting a red stall line about RA-1291 and RA-1292 while their issues were being
  // dispatched normally, in the report whose job is saying what is stopped.
  it('does not call a project starved for having a lower-numbered neighbour', () => {
    // The old fixture, asserting the opposite of what it used to.
    expect(classifyProject({ proposed: 9, members: [], held: false }).status)
      .toBe('unfiled');
    expect(classifyProject({ proposed: 5, members, held: false }).status)
      .toBe('active');
  });

  it('no classification depends on any other project', () => {
    // The property, not an example: `classifyProject` takes nothing about the rest
    // of the fleet any more, so there is no argument through which position could
    // re-enter. A reinstated `isNext` would be ignored rather than honoured.
    expect(classifyProject({ proposed: 5, members, held: false, isNext: false } as never).status)
      .toBe('active');
    expect(classifyProject({ proposed: 9, members: [], held: false, isNext: false } as never).status)
      .toBe('unfiled');
  });

  it('never emits `starved` at all', () => {
    const every = [
      classifyProject({ proposed: 9, members: [], held: false }),
      classifyProject({ proposed: 5, members, held: false }),
      classifyProject({ proposed: 2, members: [{ state: 'CLOSED' }], held: false }),
      classifyProject({ proposed: 5, members, held: true }),
    ];
    expect(every.map((c) => c.status)).toEqual(['unfiled', 'active', 'complete', 'held']);
  });

  it('calls a project with open members ACTIVE', () => {
    expect(classifyProject({ proposed: 5, members, held: false }))
      .toMatchObject({ status: 'active', open: 1, closed: 1 });
  });

  it('calls every-member-closed COMPLETE', () => {
    expect(classifyProject({ proposed: 2, members: [{ state: 'CLOSED' }], held: false }))
      .toMatchObject({ status: 'complete', open: 0, closed: 1 });
  });

  it('HELD outranks active — the tracking issue needs a human', () => {
    expect(classifyProject({ proposed: 5, members, held: true }))
      .toMatchObject({ status: 'held' });
  });

  // ---- RA-1462 -------------------------------------------------------------
  // `needs:human` stops the tick entirely, so every other status names an action
  // the reconciler cannot take. These pin that `held` outranks ALL of them.
  it('HELD outranks unfiled — a project held before its first filing is not "never reconciled"', () => {
    // The reported shape: hold() fires on a FAILED action, and the canonical
    // example (a brief naming a nonexistent milestone) fails in the file phase,
    // i.e. with zero members. This printed the digest's loudest line for a
    // project the Lead stopped on purpose.
    expect(classifyProject({ proposed: 9, members: [], held: true }))
      .toMatchObject({ status: 'held' });
  });

  it('HELD outranks complete — a held project cannot be verified or closed either', () => {
    // Decided explicitly rather than inherited from the reordering (RA-1462 asked
    // for it): the tick that would run verification is stopped, so "ready to
    // verify and close" is the same wrong instruction. Nothing is lost — the
    // header still carries the counts.
    const allClosed = [{ state: 'CLOSED' }, { state: 'CLOSED' }];
    expect(classifyProject({ proposed: 2, members: allClosed, held: true }))
      .toMatchObject({ status: 'held', closed: 2, filed: 2 });
  });

  it('a held project still reports its real progress, so ranking held first loses nothing', () => {
    const mixed = [{ state: 'CLOSED' }, { state: 'CLOSED' }, { state: 'OPEN' }];
    expect(classifyProject({ proposed: 3, members: mixed, held: true }))
      .toMatchObject({ status: 'held', open: 1, closed: 2, filed: 3 });
  });

  it('leaves every UNHELD classification exactly as it was', () => {
    // The reorder must be inert when `held` is false — this is the regression
    // surface of moving a branch to the top.
    expect(classifyProject({ proposed: 9, members: [], held: false }).status).toBe('unfiled');
    expect(classifyProject({ proposed: 2, members: [{ state: 'CLOSED' }], held: false }).status).toBe('complete');
    expect(classifyProject({ proposed: 5, members, held: false }).status).toBe('active');
  });

  it('does not call an unfiled project complete just because it has no open members', () => {
    // `members.length === 0` must not satisfy "every member closed".
    expect(classifyProject({ proposed: 4, members: [], held: false }).status)
      .not.toBe('complete');
  });
});

describe('renderMember', () => {
  it('asks for a decision on a bail, and says how long it has waited', () => {
    const line = renderMember(member({ disposition: 'bail', waitedDays: 3 }));
    expect(line).toContain('awaiting your decision');
    expect(line).toContain('3d');
  });

  it('reports an authorised bail as decided-and-PR-less, and asserts no action', () => {
    // It must NOT say "needs a re-dispatch": without `actions: read` the script
    // cannot see a run already in flight, and telling the reader to redo
    // something they just did is the same error class as calling a bail a stall.
    const line = renderMember(member({ disposition: 'authorised', waitedDays: 2 }));
    expect(line).toContain('authorised');
    expect(line).toContain('no PR yet');
    expect(line).not.toContain('awaiting your decision');
    expect(line).not.toMatch(/re-dispatch/i);
  });

  it('says "stalled" only for a stall', () => {
    expect(renderMember(member({ disposition: 'stall' }))).toContain('stalled dispatch');
    expect(renderMember(member({ disposition: 'bail' }))).not.toContain('stalled');
  });

  it('stays silent about issues needing nothing', () => {
    expect(renderMember(member({ disposition: null }))).toBeNull();
    expect(renderMember(member({ disposition: 'dispatched' }))).toBeNull();
  });

  // ---- RA-1443 review, finding 3 -------------------------------------------
  it('surfaces qa:needs-info — a member parked on a human, same shape as a bail', () => {
    const line = renderMember(member({ disposition: 'needs-info' }));
    expect(line).toContain('awaiting your answer');
  });

  it('surfaces qa:needs-split — a member awaiting the Lead’s split PR (RA-1781)', () => {
    expect(renderMember(member({ disposition: 'needs-split' }))).toContain('awaiting a split');
    const src = readFileSync(join(ROOT, 'scripts/project-digest.mjs'), 'utf8');
    expect(src, 'the label maps to the disposition').toMatch(/labels\.includes\('qa:needs-split'\) \? 'needs-split'/);
  });

  it('surfaces a verification member rather than dropping it', () => {
    expect(renderMember(member({ disposition: 'verify' }))).toContain('verification');
  });

  it('truncates a long title rather than breaking the line', () => {
    const line = renderMember(member({ title: 'x'.repeat(200) }));
    expect(line).toContain('…');
    expect(line!.length).toBeLessThan(200);
  });
});

describe('renderProject', () => {
  const base = { number: 1291, url: 'u', title: 't', proposed: 9, filed: 0, closed: 0, open: 0, members: [] };

  it('emits the brief path, per amended AC 4', () => {
    expect(renderProject({ ...base, status: 'active' })).toContain(`${BRIEF_DIR}/1291.md`);
  });

  it('has no `starved` arm to render (RA-1490)', () => {
    // The status is gone from `classifyProject`, so `renderProject` must not carry a
    // branch for it either — a dead arm here is how a deleted concept comes back.
    const out = renderProject({ ...base, status: 'starved' } as never);
    expect(out, 'an unknown status falls through to the grey marker').toContain(':grey_question:');
    expect(out).not.toContain('lowest-numbered');
    expect(out, 'and no neighbour is named as the reason').not.toContain('#1015');
  });

  it('says never reconciled, with the proposal count, when nothing is filed', () => {
    const out = renderProject({ ...base, status: 'unfiled' });
    expect(out).toContain('never reconciled');
    expect(out).toContain('9 issues');
  });
});

// ---- RA-2414 ---------------------------------------------------------------
// Since RA-1783 a project closes when its GATING members are done, and the rest are
// CARRIED OUT: reported, never waited on. The digest counted every open member as
// outstanding, so a project the reconciler was about to close read `active`, with a
// `sev:low` follow-up in its remaining work. These pin both halves of the fix:
// a carried-out member is NOT outstanding, and it does NOT vanish from the post.
describe('carried-out members (RA-2414)', () => {
  const briefItems = [{ title: 'Item A', closes: [] }, { title: 'Item B', closes: [900] }];
  const m = (number: number, over: Record<string, unknown> = {}) => ({
    number, title: `issue ${number}`, url: `https://github.com/o/r/issues/${number}`,
    state: 'OPEN', labels: [] as string[], body: '', ageDays: 0, waitedDays: 0, disposition: null, ...over,
  });
  const itemA = m(901, { title: 'Item A', state: 'CLOSED' });
  const adopted = m(900, { state: 'CLOSED' }); // adopted via **Closes #900**
  const followUp = m(950, { labels: ['follow-up', 'sev:low'] });
  const render = (members: ReturnType<typeof m>[]) => {
    const c = classifyProject({ proposed: 2, members, held: false, briefItems });
    return { c, out: renderProject({ number: 1015, url: 'u', title: 't', proposed: 2, members, ...c }) };
  };

  it('does not count a carried-out follow-up as outstanding — the project reads COMPLETE', () => {
    const { c, out } = render([itemA, adopted, followUp]);
    expect(c).toMatchObject({ status: 'complete', open: 0, closed: 2, filed: 3 });
    expect(out, 'the fraction leaves it out of the denominator').toContain('2/2 done');
    expect(out).toContain('ready to verify and close');
  });

  it('still reports it, on its own line with a link', () => {
    const { c, out } = render([itemA, adopted, followUp]);
    expect(c.carriedOut).toEqual([{ number: 950, url: followUp.url }]);
    expect(out).toContain('carried out: 1');
    expect(out).toContain(`<${followUp.url}|#950>`);
  });

  it('agrees with the reconciler on WHICH members are carried out', () => {
    // The digest must not re-derive the set: this is the reconciler's own function on
    // the same members, and the two lists must be identical.
    const members = [itemA, adopted, followUp,
      m(951, { labels: ['follow-up', 'sev:high'] }),
      m(952, { labels: ['signal:spec-violation'], body: 'env: staging (targeted-invariant mode)' }),
      m(953, { labels: ['signal:spec-violation'], body: 'general sweep' }),
      m(954, { labels: ['qa:verify'] }),
      m(955, { title: 'Item A' })];
    const { c } = render(members);
    const theirs = reconcilerCarriedOut({ open: members.filter((x) => x.state === 'OPEN'), proposed: briefItems });
    expect(c.carriedOut.map((x: { number: number }) => x.number)).toEqual(theirs.map((x: { number: number }) => x.number));
    expect(c.carriedOut.map((x: { number: number }) => x.number)).toEqual([950, 953]);
    expect(c.open).toBe(openGatingWork(members.filter((x) => x.state === 'OPEN'), briefItems).length);
  });

  it('a CLOSED carried-out member moves neither half of the fraction', () => {
    const { out } = render([itemA, adopted, m(951, { labels: ['follow-up', 'sev:high'] }),
      m(960, { labels: ['follow-up', 'sev:low'], state: 'CLOSED' })]);
    expect(out).toContain('2/3 done');
  });

  it('an UNFILED brief item is outstanding — one closed item of two is not complete', () => {
    const { c, out } = render([itemA, followUp]);
    expect(c).toMatchObject({ status: 'active', open: 0, total: 2 });
    expect(out).toContain('1/2 done');
    expect(out).toContain('carried out: 1');
  });

  it('the open QA issue does not hide "ready to verify" — the reconciler excludes it too', () => {
    const { c } = render([itemA, adopted, followUp, m(954, { labels: ['qa:verify'] })]);
    expect(c).toMatchObject({ status: 'complete', open: 0, total: 2 });
  });

  it('an UNPARSED brief counts every member, as before — never "complete" by an empty join', () => {
    const unparsed = parseProposed('# Brief\n\n## Plan\n\n### Issue A — x\n');
    expect(unparsed).toHaveLength(0);
    const members = [m(970), m(971, { state: 'CLOSED' })];
    const c = classifyProject({ proposed: 1, members, held: false, briefItems: unparsed });
    expect(c).toMatchObject({ status: 'active', open: 1, closed: 1, carriedOut: [] });
    // A PARTLY parsed brief: the one item it did read names neither member, so without
    // the `residue` guard RA-970 would read carried out.
    const residue = Object.defineProperty([{ title: 'Item Z', closes: [] }], 'residue', { value: ['### Issue ?'] });
    expect(classifyProject({ proposed: 1, members, held: false, briefItems: residue }))
      .toMatchObject({ status: 'active', open: 1, carriedOut: [] });
    // A decomposition with no items and no `reason` — the same empty join.
    expect(classifyProject({ proposed: 0, members, held: false, briefItems: [] }))
      .toMatchObject({ status: 'active', open: 1, carriedOut: [] });
  });

  it('an UNPARSED brief with nothing filed is unfiled, naming the reason — never a quiet `active`', () => {
    // One parse means an unparseable brief proposes 0. The old whole-file count still
    // found its headings and said "unfiled"; this keeps that loud, and says why.
    const md = '# Brief\n\n## Decomposition\n\n### Issue A: wrong separator\n';
    const { proposed, briefItems } = readBrief(md);
    expect(proposed).toBe(0);
    const c = classifyProject({ proposed, members: [], held: false, briefItems });
    expect(c.status).toBe('unfiled');
    const out = renderProject({ number: 1, url: 'u', title: 't', proposed, briefItems, ...c });
    expect(out).toContain('does not parse');
    expect(out).toContain('no `### Issue X — …` headings');
    expect(out).toMatch(/^:red_circle:/);
    // A brief with NO decomposition section at all is unparsed too — it used to read `active`
    // on a count of 0, and the reconciler stops on it (`brief-unparseable`), so it is red now.
    // Measured: every brief in docs/projects/ parses, so no live project changes colour.
    expect(classifyProject({ proposed: 0, members: [], held: false, briefItems: readBrief('# x\n').briefItems }).status)
      .toBe('unfiled');
    expect(classifyProject({ proposed: 0, members: [], held: false }).status).toBe('active');
  });

  it('a PARTLY parsed brief with nothing filed names the parse failure, not a count', () => {
    const md = '## Decomposition\n\n### Issue A — a\n\n### Issue B — b\n\n### Issue C: wrong separator\n';
    const { proposed, briefItems } = readBrief(md);
    expect(proposed).toBe(2);
    const c = classifyProject({ proposed, members: [], held: false, briefItems });
    expect(c.status).toBe('unfiled');
    const out = renderProject({ number: 1, url: 'u', title: 't', proposed, briefItems, ...c });
    expect(out).toContain('only partly parses (2 read, 1 not recognised)');
    expect(out).not.toContain('proposes 2 issues');
  });

  it('keeps a GATING open member outstanding — sev:high holds the project open', () => {
    const { c, out } = render([itemA, adopted, followUp, m(951, { labels: ['follow-up', 'sev:high'] })]);
    expect(c).toMatchObject({ status: 'active', open: 1 });
    expect(out).toContain('2/3 done');
    expect(out).toContain('carried out: 1');
  });

  it('prints no carried-out line when there are none', () => {
    const { out } = render([itemA, adopted]);
    expect(out).not.toContain('carried out');
    expect(out).toContain('every filed issue closed');
  });

  it('the I/O path hands classifyProject the parsed brief — without it every member gates', () => {
    // `classifyProject` falls back to "every member gates" when `briefItems` is absent,
    // so dropping the wiring would silently restore RA-2414 with every unit test green.
    const src = readFileSync(join(ROOT, 'scripts/project-digest.mjs'), 'utf8');
    const io = src.slice(src.indexOf('/* c8 ignore start */'));
    // `readBrief` sets `briefItems` (and `proposed` from the same parse) — see its tests.
    expect(io).toMatch(/\.\.\.readBrief\(b\.markdown\)/);
    expect(io).toMatch(/classifyProject\(\{[^}]*briefItems:\s*p\.briefItems/);
  });
});

describe('buildMessage', () => {
  const today = new Date('2026-09-02T07:35:00Z');
  const project = {
    number: 1015, url: 'u', title: 'Decommission Authorize.net', status: 'active',
    proposed: 5, filed: 5, open: 4, closed: 1, members: [member()],
  };

  it('posts the numbers when the narrative is absent — prose is the degraded path', () => {
    const text = buildMessage({ today, narrative: '', projects: [project] });
    expect(text).toContain('Decommission Authorize.net');
    expect(text).toContain('1/5 done');
  });

  it('includes the narrative when present', () => {
    const text = buildMessage({ today, narrative: 'One project is waiting on you.', projects: [project] });
    expect(text).toContain('One project is waiting on you.');
  });

  it('does NOT screen the narrative for pending language, unlike the weekly digest', () => {
    // weekly-digest.mjs drops a narrative that mentions anything remaining (RA-166).
    // Here that language is the entire point, so it must survive.
    const text = buildMessage({ today, narrative: '#1305 is still awaiting your decision.', projects: [project] });
    expect(text).toContain('awaiting your decision');
  });

  it('marks a missing narrative IN THE POST, linking the run (RA-1476)', () => {
    // Every cause of a missing narrative (denied tools, a bad model id, turn or quota
    // exhaustion, an outage) used to produce the same silent, green, prose-less post.
    for (const narrative of ['', '   ', null, undefined]) {
      expect(narrativeMissing({ narrative, projects: [project] })).toBe(true);
    }
    const text = buildMessage({ today, narrative: '', projects: [project], runUrl: 'https://gh/r/1' });
    expect(text).toMatch(/No narrative today[^\n]*<https:\/\/gh\/r\/1\|the run>/);
    expect(text, 'the numbers still post').toContain('1/5 done');
  });

  it('adds no marker when the narrative is present, or on a no-projects day', () => {
    expect(buildMessage({ today, narrative: 'One project is waiting on you.', projects: [project] }))
      .not.toMatch(/No narrative today/);
    // Nothing to narrate: a marker every quiet day would train the reader to skip it.
    expect(narrativeMissing({ narrative: '', projects: [] })).toBe(false);
    expect(buildMessage({ today, narrative: '', projects: [] })).not.toMatch(/No narrative today/);
  });

  it('says so plainly when no project is open', () => {
    expect(buildMessage({ today, narrative: '', projects: [] })).toContain('No open projects');
  });

  it('caps the message so Slack never rejects it', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ ...project, number: i }));
    expect(buildMessage({ today, narrative: '', projects: many }).length).toBeLessThanOrEqual(12000);
  });
});

describe('a held project says WHY it is held (RA-1469)', () => {
  // `held` was the only loud status that named the state and stopped, and the one whose
  // cause is least guessable — a brief naming a nonexistent milestone, an unparseable
  // decomposition, a dependency matching nothing, or a terminal phase-5 stop. The
  // reader should be able to tell what has to be fixed without leaving Slack.
  const holdComment = (reason: string) => ({
    body: [
      '🛑 **The Lead is holding this project.** A tick took an action that failed…',
      '',
      `- ${reason}`,
      '',
      'Ticks take no actions while `needs:human` is on this issue.',
      '',
      HELD_MARKER,
    ].join('\n'),
  });

  it('reads the reason off the hold comment, not off prose', () => {
    expect(holdReason([{ body: 'unrelated' }, holdComment('`file` for “Issue B” — HTTP 422: milestone not found')]))
      .toBe('`file` for “Issue B” — HTTP 422: milestone not found');
  });

  it('takes the LAST marked comment, because a project can be held twice', () => {
    expect(holdReason([holdComment('the old cause'), holdComment('the live cause')])).toBe('the live cause');
  });

  it('degrades to nothing rather than guessing', () => {
    expect(holdReason([])).toBeNull();
    expect(holdReason([{ body: 'a human wrote this' }])).toBeNull();
    // Marked, but no bullet — a hand-edited comment. Say nothing rather than scrape.
    expect(holdReason([{ body: `no bullets here\n\n${HELD_MARKER}` }])).toBeNull();
  });

  it('the marker this file filters on is the one the RECONCILER writes (RA-1673)', () => {
    // Two hand-kept copies of a string a writer and a reader in a DIFFERENT PROCESS
    // must agree on, and nothing asserted it: the synthetic `holdComment` above builds
    // its comment from the digest's own copy, so it stays green whichever way the pair
    // drifts. The failure mode is RA-1469 disappearing with a clean test run — a null
    // reason and a degraded `*held*` line, no error anywhere.
    //
    // Asserted against what `renderHoldComment` ACTUALLY writes rather than against the
    // reconciler's constant, because the constant is not the contract: the comment is.
    expect(renderHoldComment(['because'])).toContain(HELD_MARKER);
    expect(holdReason([{ body: renderHoldComment(['because']) }])).toBe('because');
  });

  it('escapes what Slack would read as markup, and bounds the length', () => {
    expect(holdReason([holdComment('a <b> & c')])).toBe('a &lt;b&gt; &amp; c');
    const long = holdReason([holdComment('x'.repeat(400))]);
    expect(long!.length).toBe(160);
    expect(long!.endsWith('…')).toBe(true);
  });

  it('renders the cause beside the state', () => {
    const p = {
      number: 961, url: 'u', title: 't', status: 'held', proposed: 5, filed: 5, closed: 1,
      heldReason: 'HTTP 403: Resource not accessible by integration',
    };
    expect(renderProject(p)).toContain('*held* — the tracking issue carries `needs:human`: HTTP 403');
  });

  it('still renders the bare line when the cause cannot be read', () => {
    const p = { number: 961, url: 'u', title: 't', status: 'held', proposed: 5, filed: 5, closed: 1 };
    expect(renderProject(p)).toContain('*held* — the tracking issue carries `needs:human`');
    expect(renderProject(p)).not.toContain('needs:human`:');
  });
});

describe('the digest reads the NEWEST hold comment, not the newest of the first page (RA-1673)', () => {
  const held = (reason: string) => ({ body: `x\n\n- ${reason}\n\n${HELD_MARKER}` });
  const plain = { body: 'a human wrote this' };

  /** Pages as the API serves them: ascending, `page=1` oldest. */
  const apiOver = (pages: { body: string }[][]) => {
    const seen: number[] = [];
    const api = async (path: string) => {
      const page = Number(new URL(path, 'https://api.github.com').searchParams.get('page'));
      seen.push(page);
      return pages[page - 1] ?? [];
    };
    return { api, seen };
  };

  it('starts at the LAST page, so a superseded cause on page 1 cannot win', async () => {
    // The whole defect: `?per_page=100` with no `page` is the OLDEST hundred, so a
    // project held twice across 200+ comments reported the cause that was replaced.
    const { api, seen } = apiOver([[held('the old cause')], [plain], [held('the live cause')]]);
    expect(await holdReasonOf(api, 'o/r', 7, 250)).toBe('the live cause');
    // And it costs ONE request, not three — the reconciler's hold comment is newest.
    expect(seen).toEqual([3]);
  });

  it('walks back when the newest pages carry no hold comment at all', async () => {
    const { api, seen } = apiOver([[held('the only cause')], [plain], [plain]]);
    expect(await holdReasonOf(api, 'o/r', 7, 250)).toBe('the only cause');
    expect(seen).toEqual([3, 2, 1]);
  });

  it('stops at the newest HOLD comment, not at the newest readable one', async () => {
    // A hand-edited newest hold comment says nothing rather than resurrecting the
    // cause it replaced — `holdReason`'s own "degrade to nothing rather than guessing",
    // which a walk that stopped at the first non-null reason would have quietly undone.
    const { api } = apiOver([[held('the old cause')], [{ body: `no bullets here\n\n${HELD_MARKER}` }]]);
    expect(await holdReasonOf(api, 'o/r', 7, 150)).toBeNull();
  });

  it('reads page 1 when the issue has no comments at all', async () => {
    const { api, seen } = apiOver([]);
    expect(await holdReasonOf(api, 'o/r', 7, 0)).toBeNull();
    expect(seen).toEqual([1]);
  });

  it('asks for the API maximum per page, so the page count it computes is the real one', async () => {
    const paths: string[] = [];
    const api = async (path: string) => { paths.push(path); return []; };
    await holdReasonOf(api, 'o/r', 7, 101);
    expect(paths[0]).toContain('per_page=100');
    expect(paths[0]).toContain('page=2');
  });
});

describe('classifyDispatch is fed the NEWEST comments, not the oldest hundred (RA-1705)', () => {
  /**
   * The sibling of the RA-1673 defect, one screen down and untouched by it. Every
   * derivation `classifyDispatch` performs is about the newest state — the LAST bail,
   * and whether anything follows it — so reading the oldest hundred reports `dispatched`
   * for a member that is bailed and waiting on a human, which is the one thing the
   * digest exists to make visible.
   */
  const bail = { body: 'SCOPE-FIRST BAIL — awaiting your decision', created_at: '2026-09-01T00:00:00Z' };
  const chat = (n: number) => ({ body: `comment ${n}`, created_at: '2026-09-02T00:00:00Z' });

  /** Pages as the API serves them: ascending, `page=1` oldest. */
  const apiOver = (pages: { body: string; created_at: string }[][]) => {
    const seen: number[] = [];
    const api = async (path: string) => {
      const page = Number(new URL(path, 'https://api.github.com').searchParams.get('page'));
      seen.push(page);
      return pages[page - 1] ?? [];
    };
    return { api, seen };
  };

  it('sees a bail past comment 100, which the oldest-hundred read reported as dispatched', async () => {
    const { api } = apiOver([[chat(1)], [chat(2)], [bail]]);
    const comments = await dispatchCommentsOf(api, 'o/r', 1305, 250);
    expect(classifyDispatch({ comments, now: new Date('2026-09-04T00:00:00Z') }).disposition).toBe('bail');
  });

  it('costs ONE request when the newest page carries the bail', async () => {
    const { api, seen } = apiOver([[chat(1)], [chat(2)], [bail]]);
    await dispatchCommentsOf(api, 'o/r', 1305, 250);
    expect(seen).toEqual([3]);
  });

  it('keeps the run CONTIGUOUS when the answer sits on a later page than the bail', async () => {
    // `answered` is "anything after the LAST bail", which a page-at-a-time walk splits.
    // Accumulating every page newer than the one carrying the bail is what makes the
    // predicate whole — a single-page read of page 3 would report `bail`, not `authorised`.
    const { api, seen } = apiOver([[chat(1)], [bail], [chat(2)]]);
    const comments = await dispatchCommentsOf(api, 'o/r', 1305, 250);
    expect(seen).toEqual([3, 2]);
    expect(classifyDispatch({ comments, now: new Date('2026-09-04T00:00:00Z') }).disposition).toBe('authorised');
  });

  it('walks the whole issue when no page carries a bail, and reports the un-bailed state', async () => {
    const { api, seen } = apiOver([[chat(1)], [chat(2)]]);
    const comments = await dispatchCommentsOf(api, 'o/r', 1305, 150);
    expect(seen).toEqual([2, 1]);
    expect(classifyDispatch({ comments, ageDays: 0 }).disposition).toBe('dispatched');
  });

  it('reads page 1 when the member has no comments at all', async () => {
    const { api, seen } = apiOver([]);
    expect(await dispatchCommentsOf(api, 'o/r', 1305, 0)).toEqual([]);
    expect(seen).toEqual([1]);
  });
});

/**
 * RA-1722 — "building" is the most misleading word available for a conflicting PR.
 *
 * GitHub dispatches no `pull_request` events for one, so CI, review, revise and every
 * label churn the reconciler owns are unreachable. The 2026-09-09 digest reported PR
 * RA-1708 as a normal in-progress member for 36 hours while nothing in the pipeline
 * could touch it — the same defect one level up that this script exists to prevent.
 */
describe('a member whose PR conflicts is stopped, not building (RA-1722)', () => {
  const d = (over = {}) => classifyDispatch({ now: NOW, ...over });

  it('outranks `building`, which is the same PR and the opposite report', () => {
    expect(d({ hasPr: true, prConflicting: true }).disposition).toBe('conflicting');
  });

  it('leaves an ordinary PR building — the control', () => {
    expect(d({ hasPr: true, prConflicting: false }).disposition).toBe('building');
    expect(d({ hasPr: true }).disposition).toBe('building');
  });

  it('says nothing about a conflict when there is no PR to conflict', () => {
    // `prConflicting` cannot be true without `hasPr` in the caller, but a classifier
    // that trusted it alone would report a conflict for an undispatched member.
    expect(d({ hasPr: false, prConflicting: true }).disposition).not.toBe('conflicting');
  });

  it('renders the stop loudly, because the rebase lane can still refuse it', () => {
    const line = renderMember(member({ disposition: 'conflicting' }));
    // The SHARED short form, not this file's own words — the digest was a seventh
    // reader of the same fact, which is what RA-2154 was filed about one layer down.
    expect(line).toContain(CONFLICT_SHORT);
    expect(line).toContain('no CI, no review, no churn can move it');
    // Not the word the reader would otherwise act on.
    expect(line).not.toContain('building');
  });
});
