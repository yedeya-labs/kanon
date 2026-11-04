import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { workflowFiles } from './helpers/workflows.js';

/**
 * kanon#1598 — GitHub runs a workflow file ending in `.yaml` as it runs one ending in `.yml`. The
 * guards that hold a rule on Kanon's own workflows (`workflow-security.test.ts` for K-AGENT-47 and
 * K-AGENT-48, `self-pinning.test.ts` for plan 0001 §4) listed `.github/workflows` with
 * `endsWith('.yml')`, so a `.yaml` workflow passed them unread. They list it with `workflowFiles`.
 */
describe('workflowFiles lists every workflow GitHub runs, in either spelling (kanon#1598)', () => {
  const root = mkdtempSync(join(tmpdir(), 'kanon-workflow-files-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const plant = (rel: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), 'name: planted\n');
  };
  for (const rel of [
    '.github/workflows/short.yml',
    '.github/workflows/long.yaml',
    // Not workflows: GitHub runs only the directory's own YAML files, not a subdirectory's.
    '.github/workflows/README.md',
    '.github/workflows/nested/inner.yml',
  ]) plant(rel);

  it('finds a workflow spelled `.yml` and one spelled `.yaml`, and nothing else', () => {
    expect(workflowFiles(root)).toEqual(['.github/workflows/long.yaml', '.github/workflows/short.yml']);
  });

  it('reads Kanon\'s own workflows, from the working directory by default', () => {
    expect(workflowFiles()).toContain('.github/workflows/ci.yml');
  });
});
