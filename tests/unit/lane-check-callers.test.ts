import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { ROOT, TRIAGE, adopter, check, red, job, laneCheck } from './helpers/lane-check.js';

/**
 * `actions/lane-check` (plan 0001 §6): which files are callers.
 *
 * One of the lane-check files split by area (kanon#381); `tests/unit/helpers/lane-check.ts`
 * says how every case runs and holds the helpers they share.
 */
laneCheck(() => {
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
