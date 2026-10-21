import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runWorkflowStep } from './helpers/workflow-step.js';
import { writeStub } from './helpers/stub-bin.js';
import { IMPLEMENTER_LOGIN, REGISTER_FIXTURE, registerEnv } from './helpers/register.js';
import { SPAWNS } from './helpers/spawns.js';
import { filter, prompt, mandateStep, runMandate, GH_STUB, runFilter } from './helpers/implement-revise.js';

// Its cases run the lane's steps in `bash` against a stub `gh`, so every case takes the spawn
// budget (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

// Which PR it revises, the mandate a run receives, and the login it reads from the App register.
// Split out of agent-implement-revise.test.ts (#1204); the fixtures are in
// tests/unit/helpers/implement-revise.ts.

describe('plan 0005 L4: it revises only a PR in the implementer-status chain', () => {
  const status = (creator: string, state = 'success') =>
    JSON.stringify([{ context: 'kanon/role: implementer', state, creator: { login: creator } }]);

  it('acts on a head that carries the Author App\'s implementer status (the control)', () => {
    expect(runFilter({ statuses: status('example-author[bot]') }).act).toBe(true);
  });

  it('refuses a FORGED one by name: the Author\'s login, the label, and no status on its head', () => {
    const r = runFilter({ statuses: '[]' });
    expect(r.act).toBe(false);
    expect(r.summary).toMatch(/not provably the Implementer's: it carries no `kanon\/role: implementer` status/);
  });

  it('refuses one whose newest status another App created, or failed', () => {
    expect(runFilter({ statuses: status('example-ci[bot]') }).act).toBe(false);
    expect(runFilter({ statuses: status('example-author[bot]', 'failure') }).act).toBe(false);
  });

  it('refuses when the statuses can\'t be read, rather than revising on an unread answer', () => {
    const r = runFilter({ statuses: 'fail' });
    expect(r.act).toBe(false);
    expect(r.summary).toMatch(/could not be read/);
  });
});
describe('the mandate a reset run receives (RA-1023, RA-1024)', () => {
  /**
   * THE GATE IS ONLY HALF OF IT. A reset run handed the ordinary "the Reviewer requested
   * changes" instructions is sent to re-read the review it already answered twice,
   * and spends the one authorised revision doing it.
   *
   * That defect took four review rounds to get right in `agent-lead-revise.yml`,
   * and this file reintroduced it verbatim by copying the skeleton without what the
   * skeleton had learned. These execute the shipped step.
   */
  it('tells him it is a developer decision, not another review round', () => {
    const m = runMandate({ reset: true });
    expect(m).toContain('APPLYING A DEVELOPER DECISION');
    expect(m).not.toContain('requested changes. This is round');
  });

  it('points a reset run at PR issue comments, where a decision lives', () => {
    // Not `.reviews[-1].body` — that is the Reviewer's review, which the reset exists to
    // move past.
    const m = runMandate({ reset: true });
    expect(m).toContain('--json comments');
    expect(m.indexOf('--json comments')).toBeLessThan(m.indexOf('--json reviews'));
  });

  it('never claims a round number on a reset run', () => {
    // `round` is ROUNDS+1 and unbounded past a cleared cap, so the ordinary text
    // renders "round 4 of at most 2" — telling him he is over a cap the workflow
    // just deliberately cleared.
    expect(runMandate({ reset: true, round: '4' }).replace(/\s+/g, ' ')).not.toContain('of at most 2');
  });

  it('warns that the standing review may not be an unanswered changes-request', () => {
    // A reset below the cap is permitted, so `.reviews[-1]` can be an APPROVE or
    // nothing at all (RA-971).
    expect(runMandate({ reset: true }).replace(/\s+/g, ' ')).toContain('CHECK WHAT YOU GET BACK');
  });

  it.each([[true], [false]])('sends him to the CHECKS on a reset=%s run too', (reset) => {
    // The file's own header says WHY a code PR is not a brief: it has CI, and a red
    // check is a different instruction from a review. That applied to one branch
    // only — the reset branch never mentioned the build, so the one revision a
    // developer authorises could be spent applying a decision onto a broken tree.
    //
    // Round 2's fix added it and NOT this assertion: deleting the paragraph again
    // still passed 53 tests. Coverage tracked the gap, which is what the reviewer
    // said about round 1.
    expect(runMandate({ reset })).toContain('gh pr checks');
  });

  it('gives the ordinary run checks-then-review, in that order', () => {
    const m = runMandate({ reset: false, round: '2' });
    expect(m.replace(/\s+/g, ' ')).toContain('round 2 of at most 2');
    expect(m.indexOf('gh pr checks')).toBeLessThan(m.indexOf('--json reviews'));
    expect(m).not.toContain('DEVELOPER DECISION');
  });

  it('is wired into the prompt, and wired to the filter', () => {
    // The chain is four links and only the middle one is executed above.
    expect(prompt).toContain('needs.filter.outputs.mandate');
    expect(mandateStep.env.RESET).toContain('steps.filter.outputs.reset');
  });

  it.each([
    [{ isDispatch: true, reset: true, rounds: 3 }, 'true'],
    [{ isDispatch: true, reset: false, rounds: 1 }, 'false'],
    [{ isDispatch: false, rounds: 1 }, 'false'],
  ])('the filter tells the mandate whether this is a reset: %j', (args, expected) => {
    expect(runFilter(args).outputs.reset).toBe(expected);
  });
});
describe('the mandate points at the review that requested changes (RA-1215)', () => {
  // RA-1205 fixed the READ at both sites — `.reviews[-1].body` selects whatever landed
  // last, which since RA-965 is routinely a `COMMENT` or an `APPROVE` — but shipped no
  // assertion covering it. Verified by mutation at filing: reverting BOTH sites to
  // `.reviews[-1].body` left this file at 66 passed.
  //
  // The sibling `agent-lead-revise.yml` IS guarded, at
  // `tests/unit/agent-lead-revise.test.ts` ("selects the latest CHANGES_REQUESTED, not the
  // latest review"), in the same commit that fixed this
  // file. One side got the lock and the other did not — so this mirrors it deliberately
  // rather than inventing a different shape.

  it('the ordinary round selects the latest CHANGES_REQUESTED', () => {
    // This is the branch that runs on every review-triggered revision.
    const m = runMandate({ reset: false });
    expect(m).toMatch(/select\(\.state == "CHANGES_REQUESTED"\)/);
    expect(m, '`.reviews[-1]` takes whatever landed last').not.toMatch(/reviews\[-1\]/);
  });

  it('the reset round reads it the same way', () => {
    const m = runMandate({ reset: true });
    expect(m).toMatch(/select\(\.state == "CHANGES_REQUESTED"\)/);
    expect(m).not.toMatch(/reviews\[-1\]/);
  });

  it('neither branch is left reading the last review anywhere', () => {
    // Both sites, asserted over the whole step rather than per-branch: the defect was
    // that ONE of the two was fixed and the other was not, and a per-branch check that
    // happens to render the fixed branch would pass over exactly that.
    const raw = JSON.stringify(mandateStep);
    expect(raw, 'no mandate site may read .reviews[-1]').not.toMatch(/reviews\\?\[-1\\?\]/);
    expect((raw.match(/CHANGES_REQUESTED/g) ?? []).length,
      'both mandate sites must select it').toBeGreaterThanOrEqual(2);
  });
});
describe('the login is read from the App register (plan 0001 §5)', () => {
  // A Kanon lane cannot name an adopter's App, so the filter reads the Implementer's slug
  // from `docs/qa/agent-identities.md` on the default branch. These run the shipped step
  // against the fixture register, and against registers that are wrong in each way.
  const runWith = (register: string | undefined, author = `app/${IMPLEMENTER_LOGIN}`) => {
    const dir = mkdtempSync(join(tmpdir(), 'impl-revise-register-'));
    writeStub(join(dir, 'gh'), GH_STUB);
    return runWorkflowStep(filter, {
      dir,
      env: {
        PATH: `${dir}:${process.env.PATH}`, KANON: process.cwd(),
        REPO: 'r', ...registerEnv(filter, register ?? ''), PR: '1',
        STATE: 'changes_requested', IS_DISPATCH: 'false', RESET: '',
        STUB_META: JSON.stringify({ author: { login: author }, state: 'OPEN', headRefName: 'b', labels: [{ name: 'agent:implement' }] }),
        STUB_REVIEWS: JSON.stringify({ reviews: [{ state: 'CHANGES_REQUESTED' }] }),
        STUB_COMMENTS: JSON.stringify({ comments: [] }),
      },
    });
  };

  it('names the role, and carries the shared parser verbatim', () => {
    expect(filter.env.ROLE).toBe('Implementer');
    expect(filter.env.REGISTER_AWK).toBe(readFileSync(join(process.cwd(), 'actions/lane-check/app-register.awk'), 'utf8'));
  });

  it('acts for the slug the register gives, and publishes it for the round record', () => {
    const r = runWith(REGISTER_FIXTURE);
    expect(r.status, r.output).toBe(0);
    expect(r.outputFile).toContain('act=true');
    expect(r.outputFile).toContain(`login=${IMPLEMENTER_LOGIN}`);
  });

  it('publishes the persona header the register declares, for the round record (plan 0005 §3.3)', () => {
    // A Persona column at the end of the table: the Implementer's declared, every other row blank.
    const withPersona = REGISTER_FIXTURE.split('\n').map((l) => (!l.startsWith('|') ? l
      : l.startsWith('| Role ') ? `${l} Persona |` : /^\|[-| ]+\|$/.test(l) ? `${l}---|`
        : l.startsWith('| Implementer ') ? `${l} The Builder |` : `${l}  |`)).join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'impl-revise-persona-'));
    writeStub(join(dir, 'gh'), GH_STUB);
    const r = runWorkflowStep(filter, {
      dir,
      env: {
        PATH: `${dir}:${process.env.PATH}`, KANON: process.cwd(),
        REPO: 'r', ...registerEnv(filter, withPersona), PR: '1',
        STATE: 'changes_requested', IS_DISPATCH: 'false', RESET: '',
        STUB_META: JSON.stringify({ author: { login: `app/${IMPLEMENTER_LOGIN}` }, state: 'OPEN', headRefName: 'b', labels: [{ name: 'agent:implement' }] }),
        STUB_REVIEWS: JSON.stringify({ reviews: [{ state: 'CHANGES_REQUESTED' }] }),
        STUB_COMMENTS: JSON.stringify({ comments: [] }),
      },
    });
    expect(r.status, r.output).toBe(0);
    expect(r.outputFile).toContain('header=**The Builder (Implementer)** <!-- kanon:role=implementer -->');
  });

  it('follows the register, not a constant: another slug there turns the same author away', () => {
    const r = runWith(REGISTER_FIXTURE.replaceAll(`\`${IMPLEMENTER_LOGIN}\``, '`someone-else`'));
    expect(r.status, r.output).toBe(0);
    expect(r.outputFile).toContain('act=false');
    expect(r.stdout).toContain('not someone-else');
  });

  it.each([
    ['no register at all', ''],
    ['no row for the role', REGISTER_FIXTURE.replace(/^\| Implementer .*\n/m, '')],
    ['a row with no slug in backticks', REGISTER_FIXTURE.replace(`\`${IMPLEMENTER_LOGIN}\``, IMPLEMENTER_LOGIN)],
  ])('fails the job by name on %s, never skips silently', (_, register) => {
    const r = runWith(register);
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('::error title=App register::');
    expect(r.outputFile).not.toContain('act=');
  });

  it('reads nothing for a review it turns away on the event alone', () => {
    // No register at all, and a COMMENT verdict: the skip comes first, so the job is green.
    const dir = mkdtempSync(join(tmpdir(), 'impl-revise-register-'));
    writeStub(join(dir, 'gh'), GH_STUB);
    const r = runWorkflowStep(filter, {
      dir,
      env: { PATH: `${dir}:${process.env.PATH}`, KANON: process.cwd(), REPO: 'r', ...registerEnv(filter, ''), PR: '1', STATE: 'commented', IS_DISPATCH: 'false', RESET: '' },
    });
    expect(r.status, r.output).toBe(0);
    expect(r.outputFile).toContain('act=false');
  });
});
