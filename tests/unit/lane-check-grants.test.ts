import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { ROOT, TRIAGE, IMPL, adopter, check, red, job, type Tree, type Caller, laneCheck } from './helpers/lane-check.js';

/**
 * `actions/lane-check` (plan 0001 §6): what a caller grants and pins, the files it cannot parse,
 * and which files are callers.
 *
 * One of the lane-check files split by area (kanon#381); `tests/unit/helpers/lane-check.ts`
 * says how every case runs and holds the helpers they share.
 */
laneCheck(() => {
  describe('the caller grants at least what the lane declares (§3)', () => {
    it('refuses a caller with no explicit permissions', () =>
      red((t) => t.edit(IMPL, (d) => { delete d.permissions; }), 'grants no explicit permissions'));
    it('refuses a narrower grant', () =>
      red((t) => t.edit(IMPL, (d) => { (d as Caller).permissions = { contents: 'read', 'pull-requests': 'read' }; }), 'grants issues: none; the Kanon lane agent-implement-revise needs issues: read'));
    it('refuses read where the lane needs write', () =>
      red((t) => t.edit('.github/workflows/agent-lead-revise.yml', (d) => { (d as Caller).permissions!['pull-requests'] = 'read'; }), 'needs pull-requests: write'));
    // A job-level grant inside a called workflow is held to the caller's ceiling too, so the
    // implement lane's crash recovery (issues, pull requests and actions, on the default
    // token) is part of what its caller must grant.
    it('counts a grant the lane makes on one of its jobs, not only at its top level', () =>
      red((t) => t.edit('.github/workflows/agent-implement.yml', (d) => { delete (d as Caller).permissions!.actions; }), 'grants actions: none; the Kanon lane agent-implement needs actions: read'));
    it('takes the wider of a top-level and a job-level grant of one scope', () =>
      red((t) => t.edit('.github/workflows/agent-implement.yml', (d) => { (d as Caller).permissions!.issues = 'read'; }), 'needs issues: write'));
    it('reads the calling job\'s own grant over the workflow\'s', () => {
      const t = adopter();
      t.edit(IMPL, (d) => {
        (d as Caller).permissions = {};
        job(d).permissions = { contents: 'read', 'pull-requests': 'read', issues: 'read', statuses: 'read' };
      });
      expect(check(t).status).toBe(0);
    });
  });

  describe('every Kanon reference pins one exact version (K-ADOPT-11)', () => {
    const retag = (t: Tree, rel: string, tag: string) => t.write(rel, t.read(rel).replace(/@v1\.2\.3/g, `@${tag}`));
    it('refuses the moving major tag', () => red((t) => retag(t, TRIAGE, 'v1'), "pins 'v1', not an exact version"));
    it('refuses two versions', () => red((t) => retag(t, TRIAGE, 'v1.2.4'), 'pin v1.2.3,v1.2.4'));
    it('refuses a version other than the one lane-check runs at', () =>
      red(() => {}, 'lane-check runs at v9.9.9, but the Kanon references pin v1.2.3', { ACTION_REF: 'v9.9.9' }));
    it('accepts the version lane-check runs at', () => expect(check(adopter(), { ACTION_REF: 'v1.2.3' }).status).toBe(0));
    it('counts a pin in any workflow, not only in a caller', () =>
      red((t) => t.write('.github/workflows/other.yml', 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: yedeya-labs/kanon/actions/pr-title@v1.0.0\n'), 'pin v1.0.0,v1.2.3'));
    it('ignores a commented-out reference, which is not a pin', () => {
      const t = adopter();
      t.write(TRIAGE, `${t.read(TRIAGE)}#    uses: yedeya-labs/kanon/.github/workflows/agent-triage.yml@v0.0.1\n`);
      expect(check(t).status).toBe(0);
    });
  });

  describe('a file it cannot parse is a red, never a file it skips', () => {
    const BROKEN = 'jobs: [unclosed\n';
    it('a workflow', () => red((t) => t.write('.github/workflows/broken.yml', BROKEN), '.github/workflows/broken.yml,title=lane-check::is not valid YAML'));
    it('the hook', () => red((t) => t.write('.github/actions/project-setup/action.yml', BROKEN), 'project-setup/action.yml,title=lane-check::is not valid YAML'));
    it('the Dependabot file', () => red((t) => t.write('.github/dependabot.yml', BROKEN), 'dependabot.yml,title=lane-check::is not valid YAML'));
  });

  describe('which files are callers', () => {
    it('refuses a call to a lane this Kanon version does not ship', () =>
      red((t) => t.write(TRIAGE, t.read(TRIAGE).replace('workflows/agent-triage.yml@', 'workflows/agent-nope.yml@')), "calls Kanon lane 'agent-nope', which this Kanon version does not ship"));
    it('holds a call to the spine to no caller rule: it is not a lane', () => {
      const t = adopter();
      t.write('.github/workflows/agent-implement.yml', stringify({
        on: { issues: { types: ['labeled'] } },
        concurrency: { group: 'x' },
        jobs: { implement: { if: 'true', uses: 'yedeya-labs/kanon/.github/workflows/agent-lane.yml@v1.2.3', with: { agent: 'implementer' } } },
      }));
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('3 lane caller(s) pass');
    });
    // A caller of one of Kanon's other reusable workflows exactly as its doc gives it,
    // retagged to the fixture's pin, so the doc and this check can't drift apart (kanon#152).
    const docCaller = (doc: string, workflow: string) => {
      const marker = `yedeya-labs/kanon/.github/workflows/${workflow}.yml@`;
      const block = [...readFileSync(join(ROOT, doc), 'utf8').matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!).find((b) => b.includes(marker));
      if (!block) throw new Error(`${doc} gives no caller of ${workflow}.yml; update this test`);
      return block.replace(/@v\d+\.\d+\.\d+/g, '@v1.2.3');
    };
    const releaseCaller = () => docCaller('docs/release.md', 'release');
    it('holds the release caller docs/release.md gives to no caller rule: it is not a lane', () => {
      const t = adopter();
      t.write('.github/workflows/release.yml', releaseCaller());
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('4 lane caller(s) pass');
    });
    it('holds the apps-check caller docs/apps.md gives to no caller rule either (kanon#154)', () => {
      const t = adopter();
      t.write('.github/workflows/apps-check.yml', docCaller('docs/apps.md', 'apps-check'));
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('4 lane caller(s) pass');
    });
    it.each([
      ['docs/release.md', 'release'],
      ['docs/apps.md', 'apps-check'],
    ])('still refuses `secrets: inherit` on the %s caller of Kanon\'s %s workflow (decision 7)', (doc, wf) => {
      red((t) => {
        const f = `.github/workflows/${wf}.yml`;
        t.write(f, docCaller(doc, wf));
        t.edit(f, (d) => { job(d).secrets = 'inherit'; });
      }, new RegExp(`${wf}\\.yml,title=lane-check::the job \`[a-z]+\` calls Kanon's ${wf} workflow with \`secrets: inherit\``));
    });
    it('still pins the release caller to the one version', () =>
      red((t) => t.write('.github/workflows/release.yml', releaseCaller().replace('@v1.2.3', '@v1.2.4')), 'pin v1.2.3,v1.2.4'));
    it('still refuses a lane caller beside it that maps no secrets', () =>
      red((t) => { t.write('.github/workflows/release.yml', releaseCaller()); t.edit(TRIAGE, (d) => { delete job(d).secrets; }); }, 'agent-triage.yml,title=lane-check::maps no secrets explicitly'));
    it('refuses a repository with no lane caller at all', () =>
      red((t) => { for (const f of ['agent-triage', 'agent-implement', 'agent-implement-revise', 'agent-lead-revise']) t.rm(`.github/workflows/${f}.yml`); }, 'no workflow calls a Kanon lane'));
  });
});
