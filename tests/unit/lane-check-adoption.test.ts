import { describe, expect, it } from 'vitest';
import { adopter, check, red, laneCheck } from './helpers/lane-check.js';

/**
 * `actions/lane-check` (plan 0001 §6): the adoption record's reference deploy, weekly digest
 * audience and production promotion.
 *
 * One of the lane-check files split by area (kanon#381); `tests/unit/helpers/lane-check.ts`
 * says how every case runs and holds the helpers they share.
 */
laneCheck(() => {
  describe("the adoption record's reference-deploy declaration, read by the library's reader (K-LAYOUT-10, plan 0004 P6)", () => {
    const REC = 'docs/qa/adoption.md';
    const DECLARED = '## Choices\n\n- **Overseer:** `not installed`\n- **Reference environment:** `preview`\n- **Reference deploy workflow:** `deploy-preview.yml`\n- **Reference deploy job:** `ship`\n';
    const passes = (body: string | null) => {
      const t = adopter();
      if (body !== null) t.write(REC, body);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
    };
    it('passes no record, a record that declares no reference environment, and a whole declaration', () => {
      passes(null);
      passes('# Adoption record\n\n## Choices\n\n- **Chat channel:** none yet.\n- **Overseer:** `not installed`\n');
      passes(`# Adoption record\n\n${DECLARED}`);
    // Three whole lane-check runs, at about a second each alone: under a loaded full run that
    // reached the default 5s once the register's persona check was added (plan 0005 §3.3).
    }, 15_000);
    it('refuses a declaration missing its job, with the reader\'s own message', () =>
      red((t) => t.write(REC, `# Adoption record\n\n${DECLARED.replace(/^- \*\*Reference deploy job.*\n/m, '')}`),
        /adoption\.md,title=lane-check::docs\/qa\/adoption\.md declares the reference environment's deploy without `Reference deploy job`: declare all three, or none \(K-LAYOUT-10\)/));
    it('refuses a workflow written as a path', () =>
      red((t) => t.write(REC, `# Adoption record\n\n${DECLARED.replace('`deploy-preview.yml`', '`.github/workflows/deploy-preview.yml`')}`),
        /adoption\.md,title=lane-check::docs\/qa\/adoption\.md:7: `\.github\/workflows\/deploy-preview\.yml` isn't a workflow file name/));
  });

  describe("the adoption record's weekly digest audience (K-LAYOUT-10, kanon#218)", () => {
    const REC = 'docs/qa/adoption.md';
    const AUDIENCE = '- **Weekly digest audience:** a co-founder tracking runway\n';
    it('passes a declared audience beside the reference deploy', () => {
      const t = adopter();
      t.write(REC, `# Adoption record\n\n## Choices\n\n${AUDIENCE}- **Overseer:** \`not installed\`\n- **Reference environment:** \`preview\`\n- **Reference deploy workflow:** \`deploy-preview.yml\`\n- **Reference deploy job:** \`ship\`\n`);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
    });
    it('refuses one declared twice, by name', () =>
      red((t) => t.write(REC, `# Adoption record\n\n## Choices\n\n${AUDIENCE}${AUDIENCE}`),
        /adoption\.md,title=lane-check::docs\/qa\/adoption\.md:6 repeats `Weekly digest audience`, already declared on line 5 \(K-LAYOUT-10\)/));
    it('refuses one outside `## Choices`, by name', () =>
      red((t) => t.write(REC, `# Adoption record\n\n${AUDIENCE}\n## Choices\n`),
        /adoption\.md,title=lane-check::docs\/qa\/adoption\.md:3 declares the weekly digest's audience outside `## Choices`/));
  });

  describe("the adoption record's production promotion (K-MERGE-4, K-LAYOUT-10, kanon#158)", () => {
    const REC = 'docs/qa/adoption.md';
    const GATED = "- **Production promotion:** human-gated (the `production` environment's required reviewer)\n";
    it('passes a declared human-gated promotion', () => {
      const t = adopter();
      t.write(REC, `# Adoption record\n\n## Choices\n\n${GATED}- **Overseer:** \`not installed\`\n`);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
    });
    it('refuses one in another shape, by name, with the reader\'s own message', () =>
      red((t) => t.write(REC, '# Adoption record\n\n## Choices\n\n- **Production promotion:** `human-gated`\n'),
        /adoption\.md,title=lane-check::docs\/qa\/adoption\.md:5, under `## Choices`, isn't a declaration: .*human-gated/));
    it('refuses one outside `## Choices`, by name', () =>
      red((t) => t.write(REC, `# Adoption record\n\n${GATED}\n## Choices\n`),
        /adoption\.md,title=lane-check::docs\/qa\/adoption\.md:3 declares the production promotion outside `## Choices`/));
  });
});
