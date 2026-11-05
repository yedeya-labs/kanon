import { describe, expect, it, vi } from 'vitest';
import { checkout as doctorCheckout, fakeGitHub as doctorGitHub, healthyFiles, REPO, run as doctor, type Result } from './helpers/doctor.js';
import { checkout as initCheckout, fakeGitHub as initGitHub, read, run as init } from './helpers/kanon-init.js';
import { SPAWNS } from './helpers/spawns.js';

// Both commands run against real git checkouts (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

/**
 * #1607 point 14: the record `init` writes for `--keep-default-labels` and `--deploy-environments
 * none` waives the two notes doctor would raise for those choices, so doctor's first run on the
 * install reports neither.
 */
const RECORD = 'docs/qa/adoption.md';
const DEFAULTS = ['bug', 'documentation', 'enhancement', 'question'];
const recordFor = async (flags: string[]) => {
  const dir = initCheckout();
  // The repository's labels: the defaults init's fake holds, which doctor's fake holds too below.
  await init(dir, initGitHub({ labels: new Set(DEFAULTS) }), ['--yes', '--json', '--no-apps', '--lanes', 'review', '--deploy-environments', 'none', ...flags]);
  return read(dir, RECORD);
};
const check = async (record: string) => {
  const files = healthyFiles();
  files[RECORD] = record;
  const github = doctorGitHub();
  for (const l of DEFAULTS) github.st.labels.add(l);
  return doctor(doctorCheckout(files), github, ['--json']);
};
const ids = (r: Result, key: 'findings' | 'waived') => (r.json[key] as Array<{ id: string }>).map((f) => f.id).filter((id) => ['label.github-default', 'deploy.reference-undeclared'].includes(id)).sort();

describe("kanon doctor on the record init writes for the install's choices", () => {
  it('reports neither choice as a finding, and lists both as waived', async () => {
    const r = await check(await recordFor(['--keep-default-labels']));
    expect(ids(r, 'findings')).toEqual([]);
    expect(ids(r, 'waived')).toEqual(['deploy.reference-undeclared', 'label.github-default']);
    expect(r.json.findings.map((f: { id: string }) => f.id)).not.toContain('waiver.stale');
    expect(r.json.findings.map((f: { id: string }) => f.id)).not.toContain('declaration.malformed');
  });

  it('still reports the labels where the person chose to delete them and they remain', async () => {
    const r = await check(await recordFor(['--delete-default-labels']));
    expect(ids(r, 'findings')).toEqual(['label.github-default']);
    expect(r.json.findings.find((f: { id: string }) => f.id === 'label.github-default').subject).toBe(REPO);
  });
});
