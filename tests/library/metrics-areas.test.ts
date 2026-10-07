import { describe, expect, it } from 'vitest';
import { AREAS, areaCounts, areaOf, escalationFlags } from '../../scripts/metrics/areas.mjs';
import { UNDECLARED, parseCodeAreas } from '../../scripts/lib/code-areas.mjs';
import { ESCALATION_CATEGORIES, defaultEscalationFile, parseEscalationFile } from '../../scripts/lib/escalation-paths.mjs';
import { ESCALATION_CATEGORIES as SCHEMA_CATEGORIES } from '../../actions/agent-telemetry/schema.mjs';

/**
 * Plan 0003 §3.7: each changed file's area, first match wins, from the adopter's declared code
 * areas (`K-LAYOUT-17`) and escalation file (`K-LAYOUT-8`), with Kanon's defaults when they
 * declare nothing; and the escalation booleans, through the escalation module's own
 * `escalationCategories`.
 */

const STACK = (areas: string) => `# Stack\n\n## Code areas\n\n${areas}\n`;
const declared = parseCodeAreas(STACK([
  '- `app/` — code: the application',
  '- `.ci/scripts/` — code: the pipeline scripts',
  '- `checks/` `vitest` — tests: the suite',
].join('\n')));
const escalations = parseEscalationFile([
  '# Escalation paths', '', '## Escalation paths', '',
  '- `^db/changes/` `migrations` — schema changes',
  '- `^app/billing/` `payments` — billing',
  '- `^ops/` — operations',
  '', '## Pipeline code', '', '- `tools/pipeline/` — our pipeline', '',
].join('\n'));

describe('areaOf', () => {
  it('names eight areas, in the order §3.7 checks them', () => {
    expect(AREAS).toEqual(['deps', 'workflows', 'migrations', 'specs', 'tests', 'docs', 'config', 'code']);
  });

  it('reads dependency manifests and lockfiles at any depth as deps', () => {
    for (const p of ['package.json', 'web/package-lock.json', 'requirements.txt', 'svc/requirements-dev.txt', 'go.mod', 'go.sum', 'Cargo.toml', 'Gemfile.lock', 'pyproject.toml']) {
      expect(areaOf(p), p).toBe('deps');
    }
  });

  it("reads the JVM's, .NET's, Elixir's and Erlang's, Swift's and Dart's manifests and lockfiles as deps too, at any depth (#520)", () => {
    for (const p of [
      'pom.xml', 'svc/build.gradle', 'build.gradle.kts', 'settings.gradle.kts', 'gradle.lockfile', 'gradle/libs.versions.toml', 'build.sbt',
      'src/Api/Api.csproj', 'Lib.fsproj', 'Old.vbproj', 'packages.config', 'src/Api/packages.lock.json', 'Directory.Packages.props', 'paket.dependencies', 'paket.lock',
      'mix.exs', 'apps/web/mix.lock', 'rebar.config', 'rebar.lock',
      'Package.swift', 'Package.resolved', 'ios/Podfile', 'ios/Podfile.lock', 'Cartfile', 'Cartfile.resolved',
      'pubspec.yaml', 'app/pubspec.lock', 'deno.lock',
    ]) expect(areaOf(p), p).toBe('deps');
    // A project file's extension, not a name that only contains it.
    for (const p of ['src/csproj.ts', 'src/Api/Api.csproj.user.cs', 'src/pom.xml.ts']) expect(areaOf(p), p).toBe('code');
  });

  it('reads workflows and the repository\'s own actions as workflows, before anything else in .github', () => {
    expect(areaOf('.github/workflows/ci.yml')).toBe('workflows');
    expect(areaOf('.github/actions/setup/action.yml')).toBe('workflows');
    expect(areaOf('.github/workflows/README.md')).toBe('workflows');
  });

  it('reads any migrations directory as migrations, and the escalation file\'s migrations entries', () => {
    expect(areaOf('server/migrations/0001.sql')).toBe('migrations');
    expect(areaOf('migrations/0002.sql')).toBe('migrations');
    expect(areaOf('db/changes/0003.sql')).toBe('code');
    expect(areaOf('db/changes/0003.sql', { escalationFile: escalations })).toBe('migrations');
    // Another category's entry doesn't make a migration.
    expect(areaOf('ops/run.sh', { escalationFile: escalations })).toBe('code');
  });

  it('reads the spec corpus as specs, before docs', () => {
    expect(areaOf('docs/qa/specs/orders.md')).toBe('specs');
    expect(areaOf('docs/qa/stack.md')).toBe('docs');
  });

  it('reads tests by convention when no tests tree is declared', () => {
    expect(areaOf('lib/a.test.ts', { codeAreas: UNDECLARED })).toBe('tests');
    expect(areaOf('lib/a.spec.js')).toBe('tests');
    expect(areaOf('checks/helpers/fixture.ts')).toBe('code');
  });

  it('reads tests by the declared trees when there are some, and the convention no longer', () => {
    expect(areaOf('checks/helpers/fixture.ts', { codeAreas: declared })).toBe('tests');
    expect(areaOf('checks/notes.md', { codeAreas: declared })).toBe('tests');
    expect(areaOf('app/a.test.ts', { codeAreas: declared })).toBe('code');
  });

  it('reads markdown and the docs tree as docs', () => {
    expect(areaOf('README.md')).toBe('docs');
    expect(areaOf('app/NOTES.md')).toBe('docs');
    expect(areaOf('docs/diagram.png')).toBe('docs');
  });

  it('reads dotfiles, dot-directories and root-level configuration as config', () => {
    for (const p of ['.gitignore', '.github/CODEOWNERS', '.github/dependabot.yml', '.claude/settings.json', '.husky/pre-commit', 'tsconfig.json', 'vitest.config.ts', 'eslint.config.js', 'netlify.toml']) {
      expect(areaOf(p), p).toBe('config');
    }
  });

  it('reads a configuration file below the root as code, since only the root is the project\'s configuration', () => {
    expect(areaOf('app/settings.json')).toBe('code');
  });

  it('reads a dot-directory the adopter declares as code as code', () => {
    expect(areaOf('.ci/scripts/run.mjs')).toBe('config');
    expect(areaOf('.ci/scripts/run.mjs', { codeAreas: declared })).toBe('code');
  });

  it('reads everything else as code, inside a declared code tree or not', () => {
    expect(areaOf('app/server.ts', { codeAreas: declared })).toBe('code');
    expect(areaOf('lib/server.py', { codeAreas: declared })).toBe('code');
    expect(areaOf('Makefile')).toBe('code');
  });
});

describe('areaCounts', () => {
  it('counts every changed file in its area, lockfiles included, and the tests added and changed', () => {
    const files = [
      { path: 'package-lock.json', status: 'modified', additions: 900, deletions: 800 },
      { path: 'app/a.ts', status: 'modified', additions: 1, deletions: 1 },
      { path: 'app/b.ts', status: 'removed', additions: 0, deletions: 4 },
      { path: 'checks/a.test.ts', status: 'added', additions: 10, deletions: 0 },
      { path: 'checks/b.test.ts', status: 'modified', additions: 1, deletions: 0 },
      { path: 'checks/c.test.ts', status: 'renamed', additions: 0, deletions: 0, previous_path: 'checks/old.test.ts' },
      { path: 'checks/d.test.ts', status: 'removed', additions: 0, deletions: 3 },
      { path: 'README.md', status: 'modified', additions: 1, deletions: 0 },
    ] as const;
    expect(areaCounts(files, { codeAreas: declared })).toEqual({
      files_deps: 1, files_workflows: 0, files_migrations: 0, files_specs: 0, files_tests: 4, files_docs: 1, files_config: 0, files_code: 2,
      tests_added: 1, tests_changed: 2,
    });
  });
});

describe('escalationFlags', () => {
  const f = (path: string, previous_path?: string) => ({ path, status: 'modified' as const, additions: 1, deletions: 0, ...(previous_path ? { previous_path } : {}) });

  it('sets one boolean per category of Kanon\'s list, which is the schema\'s', () => {
    expect([...SCHEMA_CATEGORIES]).toEqual([...ESCALATION_CATEGORIES]);
    const flags = escalationFlags(escalations, [f('app/x.ts')]);
    expect(Object.keys(flags)).toEqual(ESCALATION_CATEGORIES.map((c) => `esc_${c}`));
    expect(Object.values(flags).every((v) => v === false)).toBe(true);
  });

  it("reads the pipeline's own paths, the project's pipeline code and its declared categories", () => {
    const flags = escalationFlags(escalations, [f('.github/workflows/ci.yml'), f('AGENTS.md'), f('app/billing/charge.ts'), f('ops/deploy.sh'), f('db/changes/1.sql')]);
    expect(flags).toMatchObject({ esc_pipeline: true, esc_playbooks: true, esc_payments: true, esc_other: true, esc_migrations: true, esc_auth: false, esc_infra: false, esc_schema: false });
    expect(escalationFlags(escalations, [f('tools/pipeline/run.mjs')]).esc_pipeline).toBe(true);
  });

  it('counts a file renamed out of an escalation path', () => {
    expect(escalationFlags(escalations, [f('app/charge.ts', 'app/billing/charge.ts')]).esc_payments).toBe(true);
  });

  it("takes Kanon's default for a repository with no escalation file: only the pipeline's own paths", () => {
    expect(escalationFlags(defaultEscalationFile(), [f('.claude/settings.json'), f('ops/x.sh')])).toMatchObject({ esc_pipeline: true, esc_other: false });
  });
});
