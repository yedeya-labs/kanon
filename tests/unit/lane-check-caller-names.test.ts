import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ROOT, REGISTER, IMPL, adopter, check, type Tree, type Caller, laneCheck } from './helpers/lane-check.js';
import { FAILS_FROM, FIXED_CALLERS, callerNameFindings, failsAt, kanonVersion } from '../../actions/lane-check/caller-names.mjs';
import { IMPLEMENT_REVISE_CALLER, LEGACY, MERGE_RECONCILE_CALLER, REVIEW_CALLER, REVIEW_EVENT_CHECKS, SELF_CHECKS } from '../../scripts/lib/protocol-spellings.mjs';
import { TRIGGERS } from '../../cli/callers.mjs';

/**
 * `actions/lane-check`: the review, implement-revise and merge-reconcile callers' names and job
 * ids, which the Merger tells their checks apart by (kanon#728). A warning until `FAILS_FROM`,
 * then a failure.
 */
const BEFORE = '0.40.0';
const LANES = Object.keys(FIXED_CALLERS);

describe('the fixed caller names and job ids (kanon#728)', () => {
  it('are the merge gate\'s own, and the ones `kanon init` writes', () => {
    expect(FIXED_CALLERS['agent-review']).toEqual({ name: REVIEW_CALLER });
    expect(FIXED_CALLERS['agent-implement-revise']).toEqual({ name: IMPLEMENT_REVISE_CALLER, job: 'revise' });
    expect(FIXED_CALLERS['agent-merge-reconcile']).toEqual({ name: MERGE_RECONCILE_CALLER, job: 'reconcile' });
    expect(SELF_CHECKS).toContain(REVIEW_CALLER);
    for (const [lane, want] of Object.entries(FIXED_CALLERS)) {
      expect(TRIGGERS[lane]?.name).toBe(want.name);
      if (want.job) {
        expect(TRIGGERS[lane]?.job).toBe(want.job);
        expect(REVIEW_EVENT_CHECKS).toContainEqual({ workflow: want.name, job: `${want.job} / filter` });
      }
    }
  });

  it('pass silently when right, and for a lane with no fixed name', () => {
    for (const [lane, want] of Object.entries(FIXED_CALLERS)) expect(callerNameFindings(lane, want.name, want.job ?? 'anything', BEFORE)).toEqual([]);
    expect(callerNameFindings('agent-triage', 'Triage & Fix', 'triage', BEFORE)).toEqual([]);
  });

  it.each(LANES)('warn on a wrong name for %s, saying how to rename and when it fails', (lane) => {
    const want = FIXED_CALLERS[lane]!;
    const f = callerNameFindings(lane, 'Something else', want.job ?? 'x', BEFORE);
    expect(f).toHaveLength(1);
    expect(f[0]!.level).toBe('warning');
    expect(f[0]!.message).toContain(`its name must be \`${want.name}\`, not \`Something else\``);
    expect(f[0]!.message).toContain(`Rename it with \`name: ${want.name}\``);
    expect(f[0]!.message).toContain(`a warning until Kanon ${FAILS_FROM}, and a failure from it`);
  });

  it.each(LANES.filter((l) => FIXED_CALLERS[l]!.job))('warn on a wrong job id for %s', (lane) => {
    const want = FIXED_CALLERS[lane]!;
    const f = callerNameFindings(lane, want.name, 'other', BEFORE);
    expect(f).toHaveLength(1);
    expect(f[0]!.level).toBe('warning');
    expect(f[0]!.message).toContain(`its job must have the id \`${want.job}\`, not \`other\``);
    expect(f[0]!.message).toContain(`Rename the job to \`${want.job}:\``);
  });

  it('hold a caller with more than one job (`null`) to its name only: that fails on its own', () => {
    expect(callerNameFindings('agent-implement-revise', IMPLEMENT_REVISE_CALLER, null, BEFORE)).toEqual([]);
  });

  it('warn on the old spellings the gate still reads, naming them as such', () => {
    const old = [...LEGACY.selfChecks.filter((n) => n.startsWith('Review ')).map((n) => ['agent-review', n]),
      ...LEGACY.reviewEventChecks.map((c) => [c.workflow.startsWith('Implement') ? 'agent-implement-revise' : 'agent-merge-reconcile', c.workflow])];
    expect(old).toHaveLength(3);
    for (const [lane, name] of old) {
      const f = callerNameFindings(lane!, name!, FIXED_CALLERS[lane!]!.job ?? 'review', BEFORE);
      expect(f).toHaveLength(1);
      expect(f[0]!.level).toBe('warning');
      expect(f[0]!.message).toContain(`not \`${name}\` (an earlier release's spelling): `);
    }
  });

  it('fail each one from FAILS_FROM on', () => {
    for (const lane of LANES) {
      const want = FIXED_CALLERS[lane]!;
      const f = callerNameFindings(lane, 'Something else', want.job ? 'other' : 'x', FAILS_FROM);
      expect(f.map((x) => x.level)).toEqual(want.job ? ['error', 'error'] : ['error']);
      expect(f[0]!.message).toContain(`since Kanon ${FAILS_FROM} this fails`);
      expect(callerNameFindings(lane, want.name, want.job ?? 'x', FAILS_FROM)).toEqual([]);
    }
    const old = LEGACY.reviewEventChecks[0]!.workflow;
    expect(callerNameFindings('agent-implement-revise', old, 'revise', FAILS_FROM)[0]!.level).toBe('error');
  });

  it('switch at exactly FAILS_FROM, by version order, and warn on an unreadable version', () => {
    expect(failsAt('0.40.9', '0.41.0')).toBe(false);
    expect(failsAt('0.41.0', '0.41.0')).toBe(true);
    expect(failsAt('v0.41.1', '0.41.0')).toBe(true);
    expect(failsAt('0.100.0', '0.41.0')).toBe(true);
    expect(failsAt('1.0.0', '0.41.0')).toBe(true);
    expect(failsAt('0.39.0', '0.41.0')).toBe(false);
    expect(failsAt('', '0.41.0')).toBe(false);
  });

  it('is a version after the one Kanon is at, so this release warns', () => {
    expect(failsAt(kanonVersion(ROOT))).toBe(false);
  });
});

laneCheck(() => {
  describe('the review, implement-revise and merge-reconcile callers\' names (kanon#728)', () => {
    const REVIEW = '.github/workflows/agent-review.yml';
    const RECONCILE = '.github/workflows/agent-merge-reconcile.yml';
    const extra = (t: Tree, f: string) => t.write(f, readFileSync(join(ROOT, 'tests/fixtures/lane-check/extra', f.split('/').pop()!), 'utf8'));
    const all = (t: Tree) => {
      extra(t, REVIEW);
      extra(t, RECONCILE);
      t.write(REGISTER, `${t.read(REGISTER)}| Reviewer | \`example-judge\` | Read | Read & write | Read & write | No access |\n`);
    };
    /** A Kanon tree that is this one at version `v`. */
    const roots: string[] = [];
    const kanonAt = (v: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'kanon-at-'));
      for (const e of readdirSync(ROOT)) if (e !== 'package.json') symlinkSync(join(ROOT, e), join(dir, e));
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: v }));
      roots.push(dir);
      return dir;
    };
    afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });
    const run = (change: (t: Tree) => void, env: Record<string, string> = {}) => {
      const t = adopter();
      all(t);
      change(t);
      return check(t, env);
    };

    it('passes the three callers under their fixed names with no warning', () => {
      const r = run(() => {});
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('6 lane caller(s) pass');
      expect(r.out).not.toContain('::warning');
    });

    const cases: Array<[string, (t: Tree) => void, string]> = [
      ['the review caller\'s name', (t) => t.edit(REVIEW, (d) => { d.name = 'Review'; }), 'agent-review.yml,title=lane-check::its name must be `Review (Reviewer)`, not `Review`'],
      ['the revise caller\'s name', (t) => t.edit(IMPL, (d) => { d.name = 'Implement — revise'; }), 'agent-implement-revise.yml,title=lane-check::its name must be `Implement (Implementer) — revise`, not `Implement — revise`'],
      ['the reconcile caller\'s name', (t) => t.edit(RECONCILE, (d) => { d.name = 'Merge Reconcile'; }), 'agent-merge-reconcile.yml,title=lane-check::its name must be `Merge Reconcile (Reviewer)`'],
      ['the revise caller\'s old spelling', (t) => t.edit(IMPL, (d) => { d.name = LEGACY.reviewEventChecks[0]!.workflow; }), `agent-implement-revise.yml,title=lane-check::its name must be \`Implement (Implementer) — revise\`, not \`${LEGACY.reviewEventChecks[0]!.workflow}\` (an earlier release's spelling)`],
      ['the revise job\'s id', (t) => t.edit(IMPL, (d) => { const c = d as Caller; c.jobs = { other: c.jobs.revise! }; }), 'agent-implement-revise.yml,title=lane-check::its job must have the id `revise`, not `other`'],
      ['the reconcile job\'s id', (t) => t.edit(RECONCILE, (d) => { const c = d as Caller; c.jobs = { other: c.jobs.reconcile! }; }), 'agent-merge-reconcile.yml,title=lane-check::its job must have the id `reconcile`, not `other`'],
    ];
    it.each(cases)('warns on %s in this release, and passes', (_what, change, message) => {
      const r = run(change);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain(`::warning file=.github/workflows/${message}`);
      expect(r.out).toContain(`a warning until Kanon ${FAILS_FROM}`);
      expect(r.out).toContain('and 1 warning(s) that fail in a later release');
      expect(r.out).not.toContain('::error');
    });
    it.each(cases)('fails on %s from FAILS_FROM on', (_what, change, message) => {
      const r = run(change, { KANON_ROOT: kanonAt(FAILS_FROM) });
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain(`::error file=.github/workflows/${message}`);
      expect(r.out).not.toContain('::warning');
    });
    it('passes the fixed names at FAILS_FROM too', () => {
      const r = run(() => {}, { KANON_ROOT: kanonAt(FAILS_FROM) });
      expect(r.status, r.out).toBe(0);
    });
  });
});
