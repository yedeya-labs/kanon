import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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

  it("lists every lane of docs/lanes.md's table, and no other workflow", () => {
    const table = [...readFileSync(join(ROOT, 'docs/lanes.md'), 'utf8').split('## Which lanes are available')[1]!.split('\n## ')[0]!.matchAll(/^\| [^|]+\| `(agent-[a-z-]+\.yml)` \|/gm)].map((m) => m[1]);
    expect(table.length).toBe(18);
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
});
