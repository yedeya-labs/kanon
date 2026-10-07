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

  it("names the telemetry collector and the variables its documented caller passes (#428)", () => {
    // `kanon init --telemetry` writes that caller, and `kanon doctor` lists its job as Kanon's
    // id-token holder and reports either variable unset: both read these names from here.
    expect(built.telemetry).toEqual({ collector: 'telemetry-collect', variables: ['KANON_TELEMETRY_URL', 'KANON_TELEMETRY_WRITER_ROLE'] });
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
      expect(l.optionalSecrets, name).toEqual(coupled.includes(name) ? ['QA_STORE_BUCKET', 'QA_STORE_ROLE_ARN'] : undefined);
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
    type Entry = { name: string; group: string; does: string; needs: string[]; cost: string; recommend: 'always' | string[]; when: string; mergeQueue?: string };
    const cat = built.catalogue as { groups: Array<{ id: string; title: string; header: string }>; lanes: Record<string, Entry> };
    const lanes = built.lanes as Record<string, { secrets: string[] }>;
    const groupOf = (lane: string) => cat.groups.findIndex((g) => g.id === cat.lanes[lane]!.group);

    it('has an entry for every lane, and none for a lane Kanon does not ship', () => {
      expect(Object.keys(cat.lanes).sort()).toEqual(Object.keys(lanes).sort());
    });

    it('fills in every field of every entry', () => {
      for (const [lane, e] of Object.entries(cat.lanes)) {
        // `mergeQueue` only on a lane a merge queue changes (#452).
        expect(Object.keys(e).filter((k) => k !== 'mergeQueue').sort(), lane).toEqual(['cost', 'does', 'group', 'name', 'needs', 'recommend', 'when']);
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
  });
});
