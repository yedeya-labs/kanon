import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRIGGERS } from '../../cli/callers.mjs';
import { buildRequirements, laneFiles } from './helpers/requirements.js';

/**
 * The requirements file each release ships (plan 0005 §5.4, §5.5, step L9): `requirements.json`
 * at the root of the tree, read at a release's tag. It is built from the lanes, so it can't say
 * what they don't: this test rebuilds it and fails on any difference. To refresh it after a lane
 * change: `KANON_WRITE_REQUIREMENTS=1 npx vitest run tests/unit/requirements.test.ts`.
 */
const ROOT = process.cwd();
const FILE = join(ROOT, 'requirements.json');

describe('requirements.json', () => {
  const built = buildRequirements(ROOT);
  if (process.env.KANON_WRITE_REQUIREMENTS) writeFileSync(FILE, `${JSON.stringify(built, null, 2)}\n`);

  it('is what the lanes say, byte for byte', () => {
    expect(readFileSync(FILE, 'utf8'), 'requirements.json is stale: rebuild it with KANON_WRITE_REQUIREMENTS=1 npx vitest run tests/unit/requirements.test.ts').toBe(
      `${JSON.stringify(built, null, 2)}\n`,
    );
  });

  it("says whether this release's dco check exempts the Releaser's release commits, from the action itself (#337, #49)", async () => {
    // `kanon doctor` asks an adopter to drop every bypass actor but the Releaser only against a
    // release that says so, so the claim must be the action's own.
    const { RELEASER_ROLE, parseRegister } = await import('../../actions/dco/dco.mjs');
    expect(RELEASER_ROLE).toBe('Releaser');
    expect(parseRegister('| Role | App slug |\n|---|---|\n| Releaser | `acme-releaser` |\n')).toMatchObject({ releaser: 'acme-releaser' });
    expect(built.release).toEqual({ dcoExemptsReleaser: true });
  });

  it("names the telemetry collector, the variables its documented caller passes (#428), and the grant its caller must make", () => {
    // `kanon init --telemetry` writes that caller, and `kanon doctor` lists its job as Kanon's
    // id-token holder and reports either variable unset: both read these names from here. Doctor
    // also names a caller whose permissions: lack the grant: `contents: read` reads the adoption
    // record's upstream-findings level (plan 0006 F4).
    expect(built.telemetry).toEqual({
      collector: 'telemetry-collect',
      variables: ['KANON_TELEMETRY_URL', 'KANON_TELEMETRY_WRITER_ROLE'],
      grant: { actions: 'read', contents: 'read', 'id-token': 'write' },
    });
  });

  it('names the repository variables a lane reads and a repository may leave unset: the backlog feeder\'s (#609)', () => {
    // `kanon doctor` reports QA_BACKLOG_FEED's state only against a release whose sweep reads it.
    const lanes = built.lanes as Record<string, { optionalVariables?: string[] }>;
    expect(lanes['agent-dispatch-sweep']?.optionalVariables).toEqual(['QA_BACKLOG_FEED', 'QA_BACKLOG_MILESTONES']);
    expect(Object.entries(lanes).filter(([, l]) => l.optionalVariables).map(([k]) => k)).toEqual(['agent-dispatch-sweep']);
  });

  it("names the QA store's hook and the secrets the store-coupled lanes take for it, which a caller may leave out (#433)", () => {
    // `secretsOnly` (#479): the block takes no `variables`, so doctor treats a store secret a
    // variable still holds as missing. Read from the block's own inputs.
    expect(built.qaStore).toEqual({ hook: '.github/actions/qa-store/action.yml', secrets: ['QA_STORE_BUCKET', 'QA_STORE_ROLE_ARN'], secretsOnly: true });
    const lanes = built.lanes as Record<string, { secrets: string[], optionalSecrets?: string[], qaStore: boolean }>;
    // The lanes that call the store (kanon#471's `qaStore`), not every lane holding id-token.
    const coupled = Object.entries(lanes).filter(([, l]) => l.qaStore).map(([n]) => n);
    expect(coupled).toEqual(['agent-code-audit', 'agent-dispatch-sweep', 'agent-explore', 'agent-overseer']);
    for (const [name, l] of Object.entries(lanes)) {
      // The Overseer also takes its telemetry reader role, optionally (kanon#470): not a store secret.
      const extra = name === 'agent-overseer' ? ['KANON_TELEMETRY_READER_ROLE'] : [];
      expect(l.optionalSecrets, name).toEqual(coupled.includes(name) ? [...extra, 'QA_STORE_BUCKET', 'QA_STORE_ROLE_ARN'] : undefined);
      for (const n of l.optionalSecrets ?? []) expect(l.secrets, name).toContain(n);
    }
  });

  it("lists every lane of docs/lanes.md's table, and no other workflow", () => {
    const table = [...readFileSync(join(ROOT, 'docs/lanes.md'), 'utf8').split('## Which lanes are available')[1]!.split('\n## ')[0]!.matchAll(/^\| [^|]+\| `(agent-[a-z-]+\.yml)` \|/gm)].map((m) => m[1]);
    expect(table.length).toBe(19);
    expect(laneFiles(ROOT)).toEqual([...table].sort());
  });

  it("names each lane's identities from its App secrets, and its review caller's fixed name and run-name", () => {
    expect(built.lanes['agent-review']).toMatchObject({
      // The Judge's, since plan 0005's L4: the Reviewer and the Merger share it (§3.5).
      identities: ['judge'],
      secrets: ['CLAUDE_CODE_OAUTH_TOKEN', 'JUDGE_APP_ID', 'JUDGE_APP_PRIVATE_KEY'],
      readsWorkflows: ['ci.yml'],
      callerRunNameEndsWith: '${{ github.event.workflow_run.head_sha || github.event.pull_request.head.sha || inputs.pr_number }}',
    });
    expect(built.lanes['agent-merge']).toMatchObject({ callerName: 'Merge (Merger)', identities: ['judge'] });
    expect(built.lanes['agent-implement']).toMatchObject({ identities: ['author'], grant: expect.objectContaining({ 'issues': 'write' }) });
    expect(built.lanes['agent-implement-revise']).toMatchObject({ identities: ['author'], grant: expect.objectContaining({ statuses: 'read' }) });
    expect(built.lanes['agent-rebase']).toMatchObject({ identities: ['author'], grant: expect.objectContaining({ statuses: 'read' }) });
    // Every lane's identity is one of Kanon's Apps, never a role, and none is the Releaser's.
    for (const [lane, l] of Object.entries(built.lanes as Record<string, { identities: string[] }>)) {
      for (const i of l.identities) expect(['author', 'judge'], lane).toContain(i);
    }
    expect((built.identities.apps as Record<string, { permissions: Record<string, string> }>).author!.permissions.statuses).toBe('write');
    expect(built.lanes['agent-weekly-digest']).toMatchObject({ identities: [] });
    expect(built.hook.inputs).toEqual(['app-slug', 'browsers', 'database', 'github-token', 'install', 'issue-number', 'lane']);
  });

  it("says which documents a lane reads have a baseline, and the stack document's sections without a default, as lane-check does", () => {
    expect(built.declarations['docs/qa/stack.md']).toEqual({ baseline: false, requiredSections: ['## Gates'] });
    expect(built.declarations['docs/qa/reviewer-playbook.md']).toEqual({ baseline: true, requiredSections: [] });
    expect(built.declarations['docs/qa/capability-ledger.md']).toEqual({ baseline: false, requiredSections: [] });
  });

  // THE LANE CATALOGUE (kanon#428): the one source of what each lane does, its group, its needs,
  // its cost and when it is recommended. `kanon init` prints it (--help, and its JSON's
  // `catalogue`), the adopt skill asks a question per group from it, and docs/lanes.md's table is
  // built from it, so a lane without an entry would be installed without anyone being told what
  // it does.
  describe('the lane catalogue (docs/lanes.json)', () => {
    type Entry = { name: string; group: string; does: string; needs: string[]; cost: string; recommend: 'always' | string[]; when: string; mergeQueue?: string; requires?: string[] };
    const cat = built.catalogue as { groups: Array<{ id: string; title: string; header: string }>; lanes: Record<string, Entry> };
    const lanes = built.lanes as Record<string, { secrets: string[] }>;
    const groupOf = (lane: string) => cat.groups.findIndex((g) => g.id === cat.lanes[lane]!.group);

    it('has an entry for every lane, and none for a lane Kanon does not ship', () => {
      expect(Object.keys(cat.lanes).sort()).toEqual(Object.keys(lanes).sort());
    });

    it('fills in every field of every entry', () => {
      for (const [lane, e] of Object.entries(cat.lanes)) {
        // `mergeQueue` only on a lane a merge queue changes (#452), `requires` only on a lane that
        // depends on another (plan 0007 §2.6).
        expect(Object.keys(e).filter((k) => k !== 'mergeQueue' && k !== 'requires').sort(), lane).toEqual(['cost', 'does', 'group', 'name', 'needs', 'recommend', 'when']);
        if ('requires' in e) expect(e.requires!.length, `${lane} requires`).toBeGreaterThan(0);
        for (const k of ['name', 'does', 'cost', 'when'] as const) expect(e[k].trim().length, `${lane} ${k}`).toBeGreaterThan(3);
        // One line each: --help prints it on one, and a question's option shows it as one.
        for (const k of ['does', 'cost', 'when'] as const) expect(e[k], `${lane} ${k}`).toMatch(/^[A-Z][^\n]*\.$/);
        if ('mergeQueue' in e) expect(e.mergeQueue, `${lane} mergeQueue`).toMatch(/^[A-Z][^\n]*\.$/);
        expect(Array.isArray(e.needs), lane).toBe(true);
      }
    });

    it("names each lane as docs/lanes.md's table does", () => {
      const table = new Map([...readFileSync(join(ROOT, 'docs/lanes.md'), 'utf8').split('## Which lanes are available')[1]!.split('\n## ')[0]!.matchAll(/^\| ([^|]+) \| `(agent-[a-z-]+)\.yml` \|/gm)].map((m) => [m[2]!, m[1]!]));
      for (const [lane, e] of Object.entries(cat.lanes)) expect(e.name, lane).toBe(table.get(lane));
    });

    it('puts each lane in a group, at most four to a group, and every group holds one', () => {
      // Four is what one multiple-choice question offers in Claude Code's question tool, which
      // the adopt skill asks a group with.
      for (const g of cat.groups) {
        const members = Object.values(cat.lanes).filter((e) => e.group === g.id);
        expect(members.length, g.id).toBeGreaterThanOrEqual(1);
        expect(members.length, g.id).toBeLessThanOrEqual(4);
        // A question's header in Claude Code's question tool holds twelve characters.
        expect(g.header.length, g.id).toBeLessThanOrEqual(12);
      }
      for (const [lane, e] of Object.entries(cat.lanes)) expect(cat.groups.map((g) => g.id), lane).toContain(e.group);
      expect(new Set(cat.groups.map((g) => g.id)).size).toBe(cat.groups.length);
    });

    it('recommends the review lane always and first, and no other lane always', () => {
      expect(Object.entries(cat.lanes).filter(([, e]) => e.recommend === 'always').map(([l]) => l)).toEqual(['agent-review']);
      expect(cat.lanes['agent-review']!.group).toBe(cat.groups[0]!.id);
    });

    it('recommends a lane only with lanes that are asked before it, or beside it', () => {
      // The adopt skill asks the groups in order, so a lane can be recommended for a choice
      // already made, never for one still to come.
      for (const [lane, e] of Object.entries(cat.lanes)) {
        if (e.recommend === 'always') continue;
        for (const w of e.recommend) {
          expect(Object.keys(lanes), `${lane} recommends with ${w}`).toContain(w);
          expect(w, lane).not.toBe(lane);
          expect(groupOf(w), `${lane} recommends with ${w}, asked after it`).toBeLessThanOrEqual(groupOf(lane));
        }
      }
    });

    // #452 (#79): a merge through a merge queue doesn't start a lane that runs on CI finishing on
    // the default branch, since the queue's push is the run's actor and the gate turns it away;
    // unless its caller also starts it on the merged pull request (#484), which the queue doesn't
    // change.
    it('says what a merge queue changes for exactly the lanes that run on CI finishing on the default branch and not on a merge', () => {
      const ciOnDefault = Object.entries(TRIGGERS).filter(([, t]) => t.ci === 'default' && !t.merged).map(([l]) => l).sort();
      expect(ciOnDefault.length).toBeGreaterThan(0);
      expect(Object.entries(TRIGGERS).filter(([, t]) => t.ci === 'default' && t.merged).map(([l]) => l)).toEqual(['agent-rebase']);
      expect(Object.entries(cat.lanes).filter(([, e]) => e.mergeQueue !== undefined).map(([l]) => l).sort()).toEqual(ciOnDefault);
    });

    it('says a lane runs no model exactly when it maps no Claude token', () => {
      for (const [lane, e] of Object.entries(cat.lanes)) {
        expect(e.cost.startsWith('No model'), lane).toBe(!lanes[lane]!.secrets.includes('CLAUDE_CODE_OAUTH_TOKEN'));
      }
    });

    it("records the five dependencies of plan 0007 §2.6 in `requires`, each a lane that acts only on what its base lane made", () => {
      const requires = Object.fromEntries(Object.entries(cat.lanes).filter(([, e]) => e.requires !== undefined).map(([l, e]) => [l, e.requires]));
      expect(requires).toEqual({
        'agent-implement-revise': ['agent-implement'],
        'agent-lead-revise': ['agent-lead'],
        'agent-lead-split': ['agent-lead'],
        'agent-lead-reconcile': ['agent-lead'],
        'agent-verify-acs': ['agent-lead-reconcile'],
      });
    });
  });

  // THE FEATURES (plan 0007 §2, step G2): a feature is a fixed set of lanes, with the Apps and the
  // person steps that follow from them, which `kanon init` and the adopt skill offer in place of a
  // choice per lane. Each contains the one before it. Hand-written in docs/lanes.json beside the
  // catalogue and copied here; §2.6 says what this guard holds them to.
  describe('the features (docs/lanes.json, plan 0007 §2)', () => {
    type Entry = { requires?: string[]; recommend: 'always' | string[] };
    const cat = built.catalogue as { lanes: Record<string, Entry> };
    const lanes = built.lanes as Record<string, { identities: string[]; secrets: string[]; hooks: string[] }>;
    const features = built.features as Feature[];

    it('copies them from docs/lanes.json, and keeps them out of the catalogue', () => {
      expect(features).toEqual(JSON.parse(readFileSync(join(ROOT, 'docs/lanes.json'), 'utf8')).features);
      expect(Object.keys(built.catalogue)).toEqual(['groups', 'lanes']);
    });

    it('are Review, Review + build and Full pipeline, in that order', () => {
      expect(features.map((f) => [f.feature, f.title])).toEqual([['review', 'Review'], ['build', 'Review + build'], ['full', 'Full pipeline']]);
    });

    it('fill in every field, and say what each does in one line a question can show', () => {
      for (const f of features) {
        expect(Object.keys(f).filter((k) => k !== 'leftOut').sort(), f.feature).toEqual(['apps', 'conditional', 'does', 'feature', 'lanes', 'steps', 'title']);
        // §9's budget for an option's consequence, which Q1 shows it as.
        expect(f.does, f.feature).toMatch(/^[A-Z][^\n]*\.$/);
        expect(f.does.length, f.feature).toBeLessThanOrEqual(100);
        for (const s of f.steps) expect(s.trim().length, f.feature).toBeGreaterThan(3);
        // A clause, which the features table and init's summary say after the lane.
        for (const c of Object.values(f.conditional)) expect(c.condition, f.feature).toMatch(/^when [^\n]*[^.]$/);
        for (const r of Object.values(f.leftOut ?? {})) expect(r, f.feature).toMatch(/^[A-Z][^\n]*\.$/);
      }
    });

    it('pass the guard of plan 0007 §2.6', () => {
      expect(featureProblems(features, cat.lanes, lanes)).toEqual([]);
    });

    it('put each lane where §2 does', () => {
      const [review, build, full] = features;
      expect(review!.lanes).toEqual(['agent-review']);
      expect(build!.lanes).toEqual(['agent-review', 'agent-implement', 'agent-implement-revise', 'agent-triage', 'agent-rebase', 'agent-dispatch-sweep', 'agent-merge-reconcile']);
      expect(full!.lanes).toEqual([...build!.lanes, 'agent-lead', 'agent-lead-revise', 'agent-lead-split', 'agent-lead-reconcile', 'agent-verify-acs', 'agent-merge', 'agent-overseer', 'agent-code-audit']);
      expect(Object.keys(full!.conditional).sort()).toEqual(['agent-explore', 'agent-project-digest', 'agent-weekly-digest']);
      expect(full!.conditional['agent-explore']).toMatchObject({ hook: '.github/actions/explore-sweep/action.yml' });
      expect(full!.conditional['agent-weekly-digest']).toMatchObject({ secret: 'DIGEST_WEBHOOK' });
      expect(full!.conditional['agent-project-digest']).toMatchObject({ secret: 'DIGEST_WEBHOOK' });
      expect(Object.keys(full!.leftOut ?? {})).toEqual(['agent-explore-telemetry']);
      expect(features.map((f) => f.apps)).toEqual([['judge'], ['author', 'judge'], ['author', 'judge']]);
    });

    // §2.6: the catalogue's `recommend` is a trigger, not a dependency. `agent-triage` is
    // recommended with the explore and code-audit lanes, and is in Review + build without them,
    // since it also triages the bugs people file (§2.2). A guard that read `recommend` as a
    // dependency would fail here.
    it('reads `requires`, never `recommend`, as a dependency: agent-triage is in Review + build without the lanes it is recommended with', () => {
      const build = features.find((f) => f.feature === 'build')!;
      expect(build.lanes).toContain('agent-triage');
      expect(cat.lanes['agent-triage']!.recommend).toEqual(['agent-explore', 'agent-code-audit']);
      for (const w of cat.lanes['agent-triage']!.recommend) expect(build.lanes).not.toContain(w);
      expect(featureProblems(features, cat.lanes, lanes)).toEqual([]);
    });

    // Each mutation §2.6 names, applied to a copy of the real data: the guard must name it.
    describe('fails each mutation §2.6 names', () => {
      const copy = () => structuredClone({ features, cat: cat.lanes, lanes });
      const at = (fs: Feature[], id: string) => fs.find((f) => f.feature === id)!;

      it('a new lane in the catalogue and in no feature', () => {
        const c = copy();
        c.cat['agent-new'] = { recommend: [] };
        c.lanes['agent-new'] = { identities: [], secrets: [], hooks: [] };
        expect(featureProblems(c.features, c.cat, c.lanes)).toEqual(['agent-new is in no feature, and not left out of Full']);
      });

      it('agent-implement-revise in Review', () => {
        const c = copy();
        at(c.features, 'review').lanes.push('agent-implement-revise');
        // Review's Apps are the Judge's, so the Author's lane also widens them.
        expect(featureProblems(c.features, c.cat, c.lanes)).toEqual([
          'review: agent-implement-revise requires agent-implement, which it lacks',
          'review: its Apps are judge, but its lanes take author, judge',
        ]);
      });

      it('agent-verify-acs in a feature without agent-lead-reconcile', () => {
        const c = copy();
        at(c.features, 'build').lanes.push('agent-verify-acs');
        expect(featureProblems(c.features, c.cat, c.lanes)).toEqual(['build: agent-verify-acs requires agent-lead-reconcile, which it lacks']);
      });

      it("author missing from Review + build's Apps", () => {
        const c = copy();
        at(c.features, 'build').apps = ['judge'];
        expect(featureProblems(c.features, c.cat, c.lanes)).toEqual(['build: its Apps are judge, but its lanes take author, judge']);
      });

      it('a feature without a lane of the one before it', () => {
        const c = copy();
        const build = at(c.features, 'build');
        build.lanes = build.lanes.filter((l) => l !== 'agent-review');
        expect(featureProblems(c.features, c.cat, c.lanes)).toEqual(['build: lacks agent-review, which review has']);
      });

      it('a lane both in Full and left out of it', () => {
        const c = copy();
        at(c.features, 'full').leftOut!['agent-merge'] = 'Left out.';
        expect(featureProblems(c.features, c.cat, c.lanes)).toEqual(['full: agent-merge is in it and also left out']);
      });

      it("a condition on a hook or a secret the lane doesn't take", () => {
        const c = copy();
        const full = at(c.features, 'full');
        full.conditional['agent-explore'] = { hook: '.github/actions/other/action.yml', condition: 'when it can be' };
        full.conditional['agent-weekly-digest'] = { secret: 'NO_SUCH_SECRET', condition: 'when it can be' };
        expect(featureProblems(c.features, c.cat, c.lanes)).toEqual([
          'full: agent-explore is conditional on the hook .github/actions/other/action.yml, which the lane does not call',
          'full: agent-weekly-digest is conditional on the secret NO_SUCH_SECRET, which the lane does not take',
        ]);
      });

      it('a `requires` naming no lane, or the lane itself', () => {
        const c = copy();
        c.cat['agent-merge']!.requires = ['agent-nowhere'];
        c.cat['agent-rebase']!.requires = ['agent-rebase'];
        expect(featureProblems(c.features, c.cat, c.lanes)).toEqual([
          'agent-merge requires agent-nowhere, which is no lane',
          'agent-rebase requires itself',
          'full: agent-merge requires agent-nowhere, which it lacks',
        ]);
      });
    });
  });
});

type Feature = {
  feature: string;
  title: string;
  does: string;
  lanes: string[];
  conditional: Record<string, { hook?: string; secret?: string; condition: string }>;
  leftOut?: Record<string, string>;
  apps: string[];
  steps: string[];
};

/**
 * Plan 0007 §2.6's guard: what is wrong with the features, one line each, or nothing. Every lane is
 * in Full, conditional in it, or left out of it with its reason; each feature contains the one
 * before it; a feature's Apps are exactly the union of its lanes' identities; a conditional lane's
 * condition names a hook it calls or a secret it takes; and a lane that `requires` a base lane is
 * in no feature without it. A conditional lane may require a lane that is conditional too.
 * `recommend` is never read: it is a trigger, not a dependency.
 */
function featureProblems(
  features: Feature[],
  cat: Record<string, { requires?: string[] }>,
  lanes: Record<string, { identities: string[]; secrets: string[]; hooks: string[] }>,
): string[] {
  const out: string[] = [];
  for (const [lane, e] of Object.entries(cat)) {
    for (const r of e.requires ?? []) {
      if (r === lane) out.push(`${lane} requires itself`);
      else if (!(r in cat)) out.push(`${lane} requires ${r}, which is no lane`);
    }
  }
  const full = features.at(-1);
  const placed = new Set(full ? [...full.lanes, ...Object.keys(full.conditional), ...Object.keys(full.leftOut ?? {})] : []);
  for (const lane of Object.keys(cat)) if (!placed.has(lane)) out.push(`${lane} is in no feature, and not left out of Full`);
  features.forEach((f, i) => {
    const conditional = Object.keys(f.conditional);
    const all = [...f.lanes, ...conditional];
    for (const l of [...all, ...Object.keys(f.leftOut ?? {})]) if (!(l in cat)) out.push(`${f.feature}: ${l} is no lane`);
    for (const l of Object.keys(f.leftOut ?? {})) if (all.includes(l)) out.push(`${f.feature}: ${l} is in it and also left out`);
    for (const l of f.lanes) if (conditional.includes(l)) out.push(`${f.feature}: ${l} is in it and also conditional`);
    const before = features[i - 1];
    if (before) {
      for (const l of before.lanes) if (!f.lanes.includes(l)) out.push(`${f.feature}: lacks ${l}, which ${before.feature} has`);
      for (const l of Object.keys(before.conditional)) if (!all.includes(l)) out.push(`${f.feature}: lacks ${l}, which ${before.feature} has`);
      for (const s of before.steps) if (!f.steps.includes(s)) out.push(`${f.feature}: lacks the step "${s}", which ${before.feature} has`);
    }
    for (const l of all) {
      // A lane in the feature needs its base lane in it; a conditional lane, at least beside it.
      const base = f.lanes.includes(l) ? f.lanes : all;
      for (const r of cat[l]?.requires ?? []) if (!base.includes(r)) out.push(`${f.feature}: ${l} requires ${r}, which it lacks`);
    }
    for (const [l, c] of Object.entries(f.conditional)) {
      if ((c.hook === undefined) === (c.secret === undefined)) out.push(`${f.feature}: ${l}'s condition names neither or both of a hook and a secret`);
      if (c.hook !== undefined && !lanes[l]?.hooks.includes(c.hook)) out.push(`${f.feature}: ${l} is conditional on the hook ${c.hook}, which the lane does not call`);
      if (c.secret !== undefined && !lanes[l]?.secrets.includes(c.secret)) out.push(`${f.feature}: ${l} is conditional on the secret ${c.secret}, which the lane does not take`);
    }
    const apps = [...new Set(all.flatMap((l) => lanes[l]?.identities ?? []))].sort();
    if (JSON.stringify([...f.apps].sort()) !== JSON.stringify(apps)) out.push(`${f.feature}: its Apps are ${f.apps.join(', ')}, but its lanes take ${apps.join(', ')}`);
  });
  return out;
}
