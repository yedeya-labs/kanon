import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { actionFiles } from './helpers/actions.js';

/**
 * kanon#927 — the guards that hold every action under `actions/` to a rule list the actions with
 * `actionFiles`. Plan 0011 puts Kanon's prebuilt hooks' actions one level down
 * (`actions/notify/slack/action.yml`), and a guard that listed only `actions/<dir>/action.yml`
 * skipped them without a word.
 */
describe('actionFiles lists every action under actions/, nested ones too (kanon#927)', () => {
  const root = mkdtempSync(join(tmpdir(), 'kanon-action-files-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const plant = (rel: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), 'name: planted\n');
  };
  for (const rel of [
    'actions/top/action.yml',
    'actions/spelled/action.yaml',
    'actions/notify/planted/action.yml',
    'actions/notify/deeper/still/action.yml',
    // Not actions: the hook files `kanon init` writes, a README, a script beside an action.
    'actions/notify/hooks/planted.yml',
    'actions/top/README.md',
    'actions/top/run.mjs',
    'actions/top/not-action.yml',
  ]) plant(rel);

  it('finds a top-level action, a nested one at any depth, and either spelling', () => {
    expect(actionFiles(root)).toEqual([
      'actions/notify/deeper/still/action.yml',
      'actions/notify/planted/action.yml',
      'actions/spelled/action.yaml',
      'actions/top/action.yml',
    ]);
  });

  it('reaches Kanon\'s own nested action, from the working directory by default', () => {
    expect(actionFiles()).toContain('actions/notify/slack/action.yml');
    expect(actionFiles()).toContain('actions/agent-run/action.yml');
    expect(actionFiles().some((f) => f.startsWith('actions/notify/hooks/'))).toBe(false);
  });
});
