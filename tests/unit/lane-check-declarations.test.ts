import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, FIXTURE, adopter, check, red, defaulted, laneCheck } from './helpers/lane-check.js';

/**
 * `actions/lane-check` (plan 0001 §6): the project's declarations: the test database, the
 * escalation and exemptions files, and the adoption record's reference deploy, digest audience and
 * production promotion.
 *
 * One of the lane-check files split by area (kanon#381); `tests/unit/helpers/lane-check.ts`
 * says how every case runs and holds the helpers they share.
 */
laneCheck(() => {
  describe('the test-database declaration (K-LAYOUT-16, kanon#18)', () => {
    const DB = 'docs/qa/test-database.md';
    const STANDARD = readFileSync(join(ROOT, 'tests/fixtures/test-database/postgres', DB), 'utf8');
    it('accepts no declaration: the project has no database', () => {
      const t = adopter();
      t.rm(DB);
      expect(check(t).status).toBe(0);
    });
    it.each(['none', 'hook'])('accepts `%s`', (kind) => {
      const t = adopter();
      t.write(DB, STANDARD.replace('`hook`', `\`${kind}\``));
      const r = check(t);
      expect(r.status, r.out).toBe(0);
    });
    it('refuses a kind Kanon does not know, with the block\'s own reason', () =>
      red((t) => t.write(DB, STANDARD.replace('`hook`', '`mysql`')), /test-database\.md,title=lane-check::declares `mysql`, which is not a kind Kanon knows.*\(K-LAYOUT-16\)/));
    it('refuses an engine named as the kind: the hook starts it, Kanon names none (K-LAYOUT-16)', () =>
      red((t) => t.write(DB, STANDARD.replace('`hook`', '`postgres`')), /declares `postgres`, which is not a kind Kanon knows.*Kanon names no engine/));
    it('refuses a declaration file that declares nothing', () =>
      red((t) => t.write(DB, '# Test database\n'), /has no `\*\*Test database:\*\* `<kind>`` line/));
    it('refuses two declarations', () =>
      red((t) => t.write(DB, `${STANDARD}**Test database:** \`none\`\n`), /has 2 `\*\*Test database:\*\*` lines/));
  });

  describe('the escalation and exemptions files, read by the library\'s own readers (kanon#153)', () => {
    const ESC = 'docs/qa/escalation-paths.md';
    const EXE = 'docs/qa/exemptions.md';
    // The fixture adopter carries both, well formed, so the whole-fixture case above passes them.
    const ESC_OK = readFileSync(join(FIXTURE, ESC), 'utf8');
    const EXE_OK = readFileSync(join(FIXTURE, EXE), 'utf8');
    it("reads a missing file as Kanon's default, and names the default (plan 0005 §5.2)", () => {
      const r = defaulted((t) => { t.rm(ESC); t.rm(EXE); },
        /::notice file=docs\/qa\/escalation-paths\.md,title=lane-check::docs\/qa\/escalation-paths\.md doesn't exist, so Kanon's default applies: only the pipeline's own paths escalate/);
      expect(r.out).toMatch(/::notice file=docs\/qa\/exemptions\.md,title=lane-check::docs\/qa\/exemptions\.md doesn't exist, so Kanon's default applies: nothing is exempt \(K-LAYOUT-15\)/);
    });
    it("reads an escalation file without `## Pipeline code` as the default for that section, with the reader's own line", () =>
      defaulted((t) => t.write(ESC, ESC_OK.replace(/## Pipeline code[\s\S]*?(?=## Bail list)/, '')),
        /::notice file=docs\/qa\/escalation-paths\.md,title=lane-check::docs\/qa\/escalation-paths\.md has no `## Pipeline code` heading, so Kanon's default applies: the project declares no pipeline code of its own \(K-LAYOUT-8\)/));
    it('refuses an escalation file with `## Pipeline code` twice, with the reader\'s own message', () =>
      red((t) => t.write(ESC, `${ESC_OK}\n## Pipeline code\n`), /escalation-paths\.md,title=lane-check::docs\/qa\/escalation-paths\.md has the `## Pipeline code` heading 2 times/));
    it('refuses an escalation pattern that is not a regular expression', () =>
      red((t) => t.write(ESC, ESC_OK.replace('`^migrations/`', '`^migrations/(`')), /escalation-paths\.md,title=lane-check::docs\/qa\/escalation-paths\.md:5/));
    it('reads an exemptions file without `## Path mentions` as the default for that section', () =>
      defaulted((t) => t.write(EXE, EXE_OK.replace(/## Path mentions[\s\S]*/, '')), /::notice file=docs\/qa\/exemptions\.md,title=lane-check::docs\/qa\/exemptions\.md has no `## Path mentions` heading, so Kanon's default applies: no path mention is exempt/));
    it('refuses an exemptions file with `## Path mentions` twice', () =>
      red((t) => t.write(EXE, `${EXE_OK}\n## Path mentions\n`), /exemptions\.md,title=lane-check::docs\/qa\/exemptions\.md has the `## Path mentions` heading 2 times/));
    it('refuses an exemptions entry listed twice', () =>
      red((t) => t.write(EXE, EXE_OK.replace('## Path mentions', '- `docs/projects/1.md` — old\n- `docs/projects/1.md` — old\n\n## Path mentions')), /exemptions\.md,title=lane-check::docs\/qa\/exemptions\.md:6 repeats the entry/));
  });

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
