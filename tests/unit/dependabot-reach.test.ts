import { describe, expect, it } from 'vitest';
import { directoriesLine, kanonEntries, proposesKanon, unreached, updatedFrom } from '../../actions/lane-check/dependabot-reach.mjs';

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

/**
 * Which entries are held to that reach (kanon#1111): each one that would open a Kanon upgrade pull
 * request. lane-check held only an entry that passed its whole Kanon-entry test, so it missed a
 * second entry without a cooldown, and doctor held every entry with a Kanon group, so it reported
 * one for a directory that pins nothing. Both now ask this one question.
 */
describe('the Dependabot entries that propose Kanon upgrades (K-ADOPT-11, kanon#1111)', () => {
  const WORKFLOW = '.github/workflows/ci.yml';
  const HOOK = '.github/actions/project-setup/action.yml';
  const FILES = [WORKFLOW, HOOK];
  const entry = (more: Record<string, unknown> = {}) => ({ 'package-ecosystem': 'github-actions', directory: '/', ...more });

  it('holds a github-actions entry that reaches a pin, with no Kanon group, allow or cooldown', () => {
    expect(proposesKanon(entry(), FILES)).toBe(true);
    expect(proposesKanon(entry({ directory: undefined, directories: ['/.github/actions/*'] }), FILES)).toBe(true);
  });

  it('leaves out an entry that reaches no file pinning Kanon, though it groups Kanon', () => {
    const copied = entry({ directory: '/infra', groups: { kanon: { patterns: ['yedeya-labs/kanon*'] } } });
    expect(proposesKanon(copied, FILES)).toBe(false);
    expect(proposesKanon(entry(), [])).toBe(false);
    expect(proposesKanon(entry({ directories: ['/', '/**'] }), ['.github/kanon.yml'])).toBe(false);
  });

  it('leaves out another ecosystem, and anything that is not an entry', () => {
    expect(proposesKanon(entry({ 'package-ecosystem': 'npm' }), FILES)).toBe(false);
    for (const e of [null, undefined, 'github-actions', ['/'], 3]) expect(proposesKanon(e, FILES)).toBe(false);
  });

  it('leaves out an entry whose `allow` names no Kanon dependency', () => {
    expect(proposesKanon(entry({ allow: [{ 'dependency-name': 'actions/*' }] }), FILES)).toBe(false);
    expect(proposesKanon(entry({ allow: [{ 'dependency-name': 'yedeya-labs/other' }] }), FILES)).toBe(false);
  });

  it('holds an entry whose `allow` takes in Kanon, by its name, a wildcard, or a dependency type', () => {
    for (const name of ['yedeya-labs/kanon*', 'yedeya-labs/kanon', 'yedeya-labs/*', '*', 'Yedeya-Labs/Kanon', 'yedeya-labs/kanon/actions/lane-check']) {
      expect(proposesKanon(entry({ allow: [{ 'dependency-name': 'actions/*' }, { 'dependency-name': name }] }), FILES), name).toBe(true);
    }
    expect(proposesKanon(entry({ allow: [{ 'dependency-type': 'all' }] }), FILES)).toBe(true);
  });

  it('leaves out an entry that ignores every Kanon update, and holds one that ignores only some', () => {
    expect(proposesKanon(entry({ ignore: [{ 'dependency-name': 'yedeya-labs/kanon*' }] }), FILES)).toBe(false);
    expect(proposesKanon(entry({ ignore: [{ 'dependency-name': '*' }] }), FILES)).toBe(false);
    expect(proposesKanon(entry({ ignore: [{ 'dependency-name': 'yedeya-labs/kanon', 'update-types': ['version-update:semver-major', 'version-update:semver-minor', 'version-update:semver-patch'] }] }), FILES)).toBe(false);
    expect(proposesKanon(entry({ ignore: [{ 'dependency-name': 'yedeya-labs/kanon*', versions: ['1.2.3'] }] }), FILES)).toBe(true);
    expect(proposesKanon(entry({ ignore: [{ 'dependency-name': 'yedeya-labs/kanon*', 'update-types': ['version-update:semver-major'] }] }), FILES)).toBe(true);
    expect(proposesKanon(entry({ ignore: [{ 'dependency-name': 'actions/*' }] }), FILES)).toBe(true);
  });

  it('leaves out an entry with version updates turned off, `open-pull-requests-limit: 0`', () => {
    expect(proposesKanon(entry({ 'open-pull-requests-limit': 0 }), FILES)).toBe(false);
    expect(proposesKanon(entry({ 'open-pull-requests-limit': 5 }), FILES)).toBe(true);
  });

  it('lists them from the parsed file, in order, and none from a file Dependabot would refuse', () => {
    const a = entry({ directories: ['/', '/.github/actions/*'] });
    const b = entry({ 'target-branch': 'release' });
    const c = entry({ directory: '/infra', groups: { kanon: { patterns: ['yedeya-labs/kanon*'] } } });
    expect(kanonEntries({ version: 2, updates: [a, c, b] }, FILES)).toEqual([a, b]);
    for (const doc of [null, undefined, 'x', { updates: { a } }, { updates: null }]) expect(kanonEntries(doc, FILES)).toEqual([]);
  });
});
