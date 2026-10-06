import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, REGISTER, TRIAGE, IMPL, adopter, check, red, type Tree, laneCheck } from './helpers/lane-check.js';

/**
 * `actions/lane-check` (plan 0001 §6): the repository's layout: caller file names, the project-
 * setup hook, the App register and the Dependabot entry.
 *
 * One of the lane-check files split by area (kanon#381); `tests/unit/helpers/lane-check.ts`
 * says how every case runs and holds the helpers they share.
 */
laneCheck(() => {
  describe('each caller has its lane\'s file name, and CI is ci.yml (K-LAYOUT-18, kanon#207)', () => {
    const EXTRA = join(ROOT, 'tests/fixtures/lane-check/extra');
    const fixture = (lane: string) => readFileSync(join(EXTRA, lane), 'utf8');
    const reviewer = (t: Tree) => t.write(REGISTER, `${t.read(REGISTER)}| Reviewer | \`example-judge\` | Read | Read & write | Read & write | No access |\n`);
    /** A caller of `lane`, written at `.github/workflows/<file>` instead of its own name. */
    const at = (t: Tree, file: string, lane: string) => t.write(`.github/workflows/${file}`, fixture(lane));

    it('refuses a caller of the review lane named as Kanon names its own, `review.yml`', () =>
      red((t) => { reviewer(t); at(t, 'review.yml', 'agent-review.yml'); },
        'review.yml,title=lane-check::calls the Kanon lane agent-review, so it lives at .github/workflows/agent-review.yml'));
    it('refuses a revise caller under another name: the reconciler lists that file\'s runs', () =>
      red((t) => { const body = t.read(IMPL); t.rm(IMPL); t.write('.github/workflows/implement-revise.yml', body); },
        'calls the Kanon lane agent-implement-revise, so it lives at .github/workflows/agent-implement-revise.yml'));
    it('refuses the project digest under the reference adopter\'s old name: the health check watches agent-*.yml', () =>
      red((t) => at(t, 'project-digest.yml', 'agent-project-digest.yml'),
        'calls the Kanon lane agent-project-digest, so it lives at .github/workflows/agent-project-digest.yml'));
    it('refuses the right name with the other extension', () =>
      red((t) => { const body = t.read(TRIAGE); t.rm(TRIAGE); t.write('.github/workflows/agent-triage.yaml', body); },
        'agent-triage.yaml,title=lane-check::calls the Kanon lane agent-triage, so it lives at .github/workflows/agent-triage.yml'));
    /** A reusable workflow at the lane's path: the lane itself, as only Kanon's own tree holds it. */
    const STUB_LANE = 'name: Review (Reviewer)\non:\n  workflow_call:\njobs:\n  review:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n';
    /** The two files that make a checkout Kanon's own source tree. */
    const kanonTree = (t: Tree) => {
      mkdirSync(join(t.dir, 'actions/lane-check'), { recursive: true });
      t.write('actions/lane-check/lane-check.sh', '#!/usr/bin/env bash\n');
      t.write('.github/workflows/agent-lane.yml', 'name: Agent lane\non:\n  workflow_call:\njobs:\n  run:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n');
    };
    it('exempts a caller whose lane\'s path holds the lane itself, in Kanon\'s own tree', () => {
      const t = adopter();
      reviewer(t);
      kanonTree(t);
      at(t, 'review.yml', 'agent-review.yml');
      t.write('.github/workflows/agent-review.yml', STUB_LANE);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('5 lane caller(s) pass');
    });
    // kanon#217, part 1: the exemption was any reusable workflow at the lane's path.
    it('does not exempt an adopter whose own reusable workflow has the lane\'s name', () =>
      red((t) => { reviewer(t); at(t, 'review.yml', 'agent-review.yml'); t.write('.github/workflows/agent-review.yml', STUB_LANE); },
        'review.yml,title=lane-check::calls the Kanon lane agent-review, so it lives at .github/workflows/agent-review.yml'));
    it('needs both marks of Kanon\'s tree: lane-check\'s own script alone is not one', () =>
      red((t) => {
        reviewer(t);
        kanonTree(t);
        t.rm('.github/workflows/agent-lane.yml');
        at(t, 'review.yml', 'agent-review.yml');
        t.write('.github/workflows/agent-review.yml', STUB_LANE);
      }, 'review.yml,title=lane-check::calls the Kanon lane agent-review, so it lives at'));
    it('needs both marks of Kanon\'s tree: a reusable spine alone is not one', () =>
      red((t) => {
        reviewer(t);
        kanonTree(t);
        t.rm('actions/lane-check/lane-check.sh');
        at(t, 'review.yml', 'agent-review.yml');
        t.write('.github/workflows/agent-review.yml', STUB_LANE);
      }, 'review.yml,title=lane-check::calls the Kanon lane agent-review, so it lives at'));
    it('does not exempt a caller whose lane\'s path holds another caller, even in Kanon\'s tree', () =>
      red((t) => { reviewer(t); kanonTree(t); at(t, 'review.yml', 'agent-review.yml'); at(t, 'agent-review.yml', 'agent-review.yml'); },
        'review.yml,title=lane-check::calls the Kanon lane agent-review, so it lives at'));
    // kanon#217, part 2: a wrapper at the right path has its runs filed under its caller's name.
    it.each([
      ['as a key', (d: Record<string, unknown>) => { (d.on as Record<string, unknown>).workflow_call = null; }],
      ['as the only event', (d: Record<string, unknown>) => { d.on = 'workflow_call'; }],
      ['in a list', (d: Record<string, unknown>) => { d.on = ['workflow_dispatch', 'workflow_call']; }],
    ])('refuses a caller that is itself a reusable workflow (%s)', (_how, wrap) => {
      red((t) => { reviewer(t); at(t, 'agent-review.yml', 'agent-review.yml'); t.edit('.github/workflows/agent-review.yml', wrap); },
        'agent-review.yml,title=lane-check::calls the Kanon lane agent-review but is itself a reusable workflow');
    });
    it('refuses a review caller when the project has no ci.yml', () =>
      red((t) => { reviewer(t); at(t, 'agent-review.yml', 'agent-review.yml'); t.rm('.github/workflows/ci.yml'); },
        '.github/workflows/ci.yml,title=lane-check::is missing; the Kanon lane(s) agent-review read its runs by that file name (K-LAYOUT-18)'));
    it('refuses a reconciler caller when the project has no ci.yml', () =>
      red((t) => { at(t, 'agent-lead-reconcile.yml', 'agent-lead-reconcile.yml'); t.rm('.github/workflows/ci.yml'); },
        'is missing; the Kanon lane(s) agent-lead-reconcile read its runs'));
    it('asks for ci.yml only of a project that runs a lane reading it', () => {
      const t = adopter();
      t.rm('.github/workflows/ci.yml');
      const r = check(t);
      expect(r.status, r.out).toBe(0);
    });
  });

  describe('the project-setup hook (§5)', () => {
    const HOOK = '.github/actions/project-setup/action.yml';
    it('refuses a missing hook', () => red((t) => t.rm(HOOK), 'the project-setup hook is missing'));
    it('refuses a hook that does not declare an input Kanon passes', () =>
      red((t) => t.edit(HOOK, (d) => { delete (d.inputs as Record<string, unknown>)['github-token']; }), 'does not declare the input `github-token`'));
    it('refuses a hook that is not a composite action', () =>
      red((t) => t.edit(HOOK, (d) => { (d.runs as Record<string, unknown>).using = 'node24'; }), 'must be a composite action'));
  });

  describe('the App register has a slug for every role a caller\'s lane runs as (K-LAYOUT-6)', () => {
    const REG = 'docs/qa/agent-identities.md';
    it('refuses a missing register', () => red((t) => t.rm(REG), 'the App register is missing'));
    it('refuses a register without the role', () =>
      red((t) => t.write(REG, t.read(REG).replace(/^\| Lead .*\n/m, '')), 'lists the role Lead 0 times, not once'));
    it('does not ask for a role no caller runs as', () => {
      const t = adopter();
      t.rm('.github/workflows/agent-lead-revise.yml');
      t.write(REG, t.read(REG).replace(/^\| Lead .*\n/m, ''));
      expect(check(t).status).toBe(0);
    });
    it('refuses a slug that is not in backticks', () =>
      red((t) => t.write(REG, t.read(REG).replace('`example-author`', 'example-author')), 'gives the role Implementer no App slug in backticks'));

    // The optional `Persona` column (plan 0005 §3.3): blank is the role's name, and a
    // malformed persona fails by name, on the pull request that wrote it.
    const withPersonas = (t: Tree, implementer: string, lead = '') => t.write(REG, t.read(REG)
      .replace('| Role | App slug |', '| Role | App slug | Persona |').replace(/^\|---\|/m, '|---|---|')
      .replace(/^(\| Implementer \| [^|]+\|)/m, `$1 ${implementer} |`).replace(/^(\| Lead \| [^|]+\|)/m, `$1 ${lead} |`));
    it('passes a register with a Persona column, declared or blank', () => {
      const t = adopter();
      withPersonas(t, 'The Builder', '');
      const r = check(t);
      expect(r.status, r.out).toBe(0);
    });
    it('refuses a malformed persona, by row and name', () =>
      red((t) => withPersonas(t, '<b>Builder</b>'), /agent-identities\.md:\d+: the Implementer row's persona `<b>Builder<\/b>` is malformed/));
    it('refuses a persona that is another role\'s name', () =>
      red((t) => withPersonas(t, 'Reviewer'), "the Implementer row's persona `Reviewer` is another role's name"));
  });

  describe('the Dependabot entry that proposes Kanon upgrades (K-ADOPT-11)', () => {
    const DEP = '.github/dependabot.yml';
    type Dep = { updates: Record<string, unknown>[] };
    it('refuses a missing file', () => red((t) => t.rm(DEP), 'is missing; it holds the entry'));
    it('refuses an entry with no Kanon group', () =>
      red((t) => t.edit(DEP, (d) => { delete (d as Dep).updates[0]!.groups; }), 'has no github-actions entry'));
    it('refuses an entry that is not titled `ci`', () =>
      red((t) => t.edit(DEP, (d) => { (d as Dep).updates[0]!['commit-message'] = { prefix: 'build' }; }), 'has no github-actions entry'));
    // Dependabot applies its default 3-day cooldown to an entry that sets none, and Kanon's
    // own entry held 13 releases back that way (#233): no `cooldown` is not no cooldown.
    it('refuses an entry with no cooldown, which Dependabot gives its default', () =>
      red((t) => t.edit(DEP, (d) => { delete (d as Dep).updates[0]!.cooldown; }), 'excludes yedeya-labs/kanon* from its cooldown'));
    it('refuses a cooldown that holds Kanon back', () =>
      red((t) => t.edit(DEP, (d) => { (d as Dep).updates[0]!.cooldown = { 'default-days': 3 }; }), 'has no github-actions entry'));
    it('accepts a cooldown that excludes Kanon', () => {
      const t = adopter();
      t.edit(DEP, (d) => { (d as Dep).updates[0]!.cooldown = { 'default-days': 3, exclude: ['yedeya-labs/kanon*'] }; });
      expect(check(t).status).toBe(0);
    });
  });
});
