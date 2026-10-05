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

  it("lists every lane of docs/lanes.md's table, and no other workflow", () => {
    const table = [...readFileSync(join(ROOT, 'docs/lanes.md'), 'utf8').split('## Which lanes are available')[1]!.split('\n## ')[0]!.matchAll(/^\| [^|]+\| `(agent-[a-z-]+\.yml)` \|/gm)].map((m) => m[1]);
    expect(table.length).toBe(18);
    expect(laneFiles(ROOT)).toEqual([...table].sort());
  });

  it("names each lane's identities from its App secrets, and its review caller's fixed name and run-name", () => {
    expect(built.lanes['agent-review']).toMatchObject({
      identities: ['reviewer'],
      secrets: ['CLAUDE_CODE_OAUTH_TOKEN', 'REVIEWER_APP_ID', 'REVIEWER_APP_PRIVATE_KEY'],
      readsWorkflows: ['ci.yml'],
      callerRunNameEndsWith: '${{ github.event.workflow_run.head_sha || github.event.pull_request.head.sha || inputs.pr_number }}',
    });
    expect(built.lanes['agent-merge']).toMatchObject({ callerName: 'Merge (Merger)', identities: ['merger'] });
    expect(built.lanes['agent-weekly-digest']).toMatchObject({ identities: [] });
    expect(built.hook.inputs).toEqual(['app-slug', 'browsers', 'database', 'github-token', 'install', 'issue-number', 'lane']);
  });
});
