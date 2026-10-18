import { describe, expect, it } from 'vitest';
import { directoriesLine, unreached, updatedFrom } from '../../actions/lane-check/dependabot-reach.mjs';

/**
 * Which Kanon references the Dependabot entry that proposes Kanon upgrades reaches (K-ADOPT-11,
 * kanon#1105). Dependabot reads `.github/workflows/` from `/`, and a composite action's
 * `action.yml` only from the action's own directory, so an entry for `/` alone left an adopter's
 * project-setup hook at the old release on every upgrade pull request, and lane-check's
 * one-version rule failed it. lane-check and `kanon doctor` both read the entry through this.
 */
describe('the files a Dependabot entry reaches (K-ADOPT-11, kanon#1105)', () => {
  const WORKFLOW = '.github/workflows/ci.yml';
  const HOOK = '.github/actions/project-setup/action.yml';

  it('reads a workflow from `/` and a composite action from its own directory, and nothing else', () => {
    expect(updatedFrom(WORKFLOW)).toBe('');
    expect(updatedFrom('.github/workflows/ci.yaml')).toBe('');
    expect(updatedFrom(HOOK)).toBe('.github/actions/project-setup');
    expect(updatedFrom('.github/actions/notify/action.yaml')).toBe('.github/actions/notify');
    expect(updatedFrom('.github/kanon.yml')).toBeNull();
    expect(updatedFrom('.github/workflows/old/ci.yml')).toBeNull();
  });

  it('leaves a composite action out of an entry for `/` alone, which is the entry kanon init wrote before', () => {
    expect(unreached({ directory: '/' }, [WORKFLOW, HOOK])).toEqual([HOOK]);
    expect(unreached({ directories: ['/'] }, [WORKFLOW, HOOK])).toEqual([HOOK]);
  });

  it("reaches it from the action's directory, written out or by a glob in `directories`", () => {
    expect(unreached({ directories: ['/', '/.github/actions/*'] }, [WORKFLOW, HOOK])).toEqual([]);
    expect(unreached({ directories: ['/', '/.github/actions/project-setup'] }, [WORKFLOW, HOOK])).toEqual([]);
    expect(unreached({ directories: ['/', '/.github/**'] }, [WORKFLOW, HOOK])).toEqual([]);
    expect(unreached({ directories: ['/', '.github/actions/project-setup/'] }, [WORKFLOW, HOOK])).toEqual([]);
  });

  it('reaches no other action from a glob or a directory that names another', () => {
    expect(unreached({ directories: ['/', '/.github/actions/notify'] }, [WORKFLOW, HOOK])).toEqual([HOOK]);
    expect(unreached({ directories: ['/', '/actions/*'] }, [WORKFLOW, HOOK])).toEqual([HOOK]);
    // `*` is one directory deep.
    expect(unreached({ directories: ['/', '/.github/*'] }, [WORKFLOW, HOOK])).toEqual([HOOK]);
  });

  it('takes `directory` as written: Dependabot reads a glob only in `directories`', () => {
    expect(unreached({ directory: '/.github/actions/*' }, [HOOK])).toEqual([HOOK]);
  });

  it('reaches a workflow only from `/`', () => {
    expect(unreached({ directories: ['/.github/actions/*'] }, [WORKFLOW, HOOK])).toEqual([WORKFLOW]);
  });

  it('never reaches a file that is neither a workflow nor an action', () => {
    expect(unreached({ directories: ['/', '/**'] }, ['.github/kanon.yml'])).toEqual(['.github/kanon.yml']);
  });

  it('writes the `directories` line that reaches every action it leaves out, keeping the directories it has', () => {
    expect(directoriesLine({ directory: '/' }, [WORKFLOW, HOOK])).toBe('directories: ["/", "/.github/actions/*"]');
    expect(directoriesLine({ directories: ['/', '/infra'] }, [HOOK, '.github/actions/notify/action.yml'])).toBe('directories: ["/", "/infra", "/.github/actions/*"]');
    expect(directoriesLine({ directory: '/' }, ['.github/tools/wrap/action.yml'])).toBe('directories: ["/", "/.github/tools/wrap"]');
    // A file no directory reaches adds nothing.
    expect(directoriesLine({ directory: '/' }, [HOOK, '.github/kanon.yml'])).toBe('directories: ["/", "/.github/actions/*"]');
  });
});
