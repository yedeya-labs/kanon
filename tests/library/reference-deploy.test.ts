import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADOPTION_RECORD,
  DeclarationError,
  parseReferenceDeploy,
  readReferenceDeploy,
  declaredEnvironmentFrom,
  readReferenceDeployFrom,
  requireReferenceDeploy,
} from '../../scripts/lib/reference-deploy.mjs';
import { readDeploy } from '../../scripts/lead-reconcile.mjs';
import { referenceDeployCli } from '../../scripts/reference-deploy.mjs';
import { ROOT } from './helpers/adopter.js';

/**
 * Plan 0004 P6 (kanon#197, kanon#54): the reference environment's deploy is the adopter's, declared
 * in its adoption record (`K-LAYOUT-10`, `K-PROJ-11`). These run in the fixture adopter, whose
 * record declares `preview`, deployed by `deploy-preview.yml`'s `ship` job, so nothing here passes
 * because a library default happens to match the reference adopter's names.
 */

const DECLARED = [
  '- **Reference environment:** `staging`',
  '- **Reference deploy workflow:** `deploy-staging.yml`',
  '- **Reference deploy job:** `deploy`',
];
const RECORD = (choices: string, rest = '') =>
  `# Adoption record\n\n## People\n\nThe Owner.\n\n## Choices\n\n${choices}\n${rest}`;
const WITH = (lines: string[]) => RECORD(`- **Chat channel:** none yet.\n${lines.join('\n')}\n`);

const fails = (text: string, message: RegExp) => {
  expect(() => parseReferenceDeploy(text)).toThrow(DeclarationError);
  expect(() => parseReferenceDeploy(text)).toThrow(message);
};

describe('the reference-deploy declaration parser (K-LAYOUT-10)', () => {
  it('reads the three bullets under `## Choices`', () => {
    expect(parseReferenceDeploy(WITH(DECLARED))).toEqual({ environment: 'staging', workflow: 'deploy-staging.yml', job: 'deploy' });
  });

  it('reads them in any order, with `*` bullets, prose between them and CRLF line endings', () => {
    const lines = [DECLARED[2], 'Prose.', DECLARED[0]?.replace(/^-/, '*'), DECLARED[1]] as string[];
    expect(parseReferenceDeploy(WITH(lines).replace(/\n/g, '\r\n'))).toEqual({ environment: 'staging', workflow: 'deploy-staging.yml', job: 'deploy' });
  });

  it('reads a job name with spaces, as a run lists a job with a `name:`', () => {
    const lines = [...DECLARED.slice(0, 2), '- **Reference deploy job:** `Deploy to staging`'];
    expect(parseReferenceDeploy(WITH(lines))?.job).toBe('Deploy to staging');
  });

  it('returns null for a record that declares none of them: no reference environment', () => {
    expect(parseReferenceDeploy(WITH([]))).toBeNull();
    expect(parseReferenceDeploy('# Adoption record\n\nNo sections at all.\n')).toBeNull();
  });

  it('ignores a declaration inside a fenced block, as an example', () => {
    expect(parseReferenceDeploy(WITH(['```markdown', ...DECLARED, '```']))).toBeNull();
  });

  it("reads Kanon's own record as declaring no reference environment", () => {
    expect(parseReferenceDeploy(readFileSync(join(ROOT, ADOPTION_RECORD), 'utf8'))).toBeNull();
  });

  it('fails by name on a declaration missing a field: all three or none', () => {
    fails(WITH(DECLARED.slice(0, 2)), /docs\/qa\/adoption\.md declares the reference environment's deploy without `Reference deploy job`: declare all three, or none \(K-LAYOUT-10\)/);
    fails(WITH(DECLARED.slice(0, 1)), /without `Reference deploy workflow` and `Reference deploy job`/);
  });

  it('fails by name on a field declared twice', () => {
    fails(WITH([...DECLARED, DECLARED[1] as string]), /docs\/qa\/adoption\.md:13 repeats `Reference deploy workflow`, already declared on line 11/);
  });

  it('fails by name on a declaration outside `## Choices`, or with no `## Choices` at all', () => {
    fails(RECORD('None.', `\n## Notes\n\n${DECLARED.join('\n')}\n`), /adoption\.md:13 declares the reference environment's deploy outside `## Choices`/);
    fails(`# Adoption record\n\n${DECLARED.join('\n')}\n`, /adoption\.md:3 declares the reference environment's deploy outside `## Choices`/);
  });

  it('fails by name on `## Choices` written twice', () => {
    fails(`${WITH(DECLARED)}\n## Choices\n\nMore.\n`, /has the `## Choices` heading 2 times, on lines 7, 15/);
  });

  it.each([
    ['indented', `  ${DECLARED[0]}`],
    ['a `+` bullet', DECLARED[0]?.replace(/^-/, '+')],
    ['numbered', DECLARED[0]?.replace(/^-/, '1.')],
    ['in a blockquote', `> ${DECLARED[0]}`],
    ['not a list item', DECLARED[0]?.replace(/^- /, '')],
    ['an unquoted value', '- **Reference environment:** staging'],
    ['text after the value', `${DECLARED[0]}, the last stage before production`],
    ['two code spans', '- **Reference environment:** `staging` `qa`'],
  ])('fails by name on a field written %s', (_shape, line) => {
    fails(WITH([line as string, ...DECLARED.slice(1)]), /docs\/qa\/adoption\.md:10, under `## Choices`, isn't a declaration: write a `- ` bullet/);
  });

  it.each([
    ['with a directory', '.github/workflows/deploy.yml'],
    ['with no extension', 'deploy-staging'],
    ['as a workflow name, not its file', 'Deploy staging'],
  ])('fails by name on a workflow written %s', (_shape, workflow) => {
    fails(WITH([DECLARED[0] as string, `- **Reference deploy workflow:** \`${workflow}\``, DECLARED[2] as string]), /adoption\.md:11: `.*` isn't a workflow file name/);
  });

  it('fails by name on a value with spaces around it', () => {
    fails(WITH(['- **Reference environment:** ` staging`', ...DECLARED.slice(1)]), /adoption\.md:10: `Reference environment` has spaces around its value/);
  });

  it('fails by name on a code fence that never closes', () => {
    fails(WITH([...DECLARED, '```']), /adoption\.md:13 opens a code fence that never closes/);
  });
});

describe('a project needs the declaration to close (K-PROJ-11)', () => {
  it('requireReferenceDeploy fails by name when the record declares none', () => {
    expect(() => requireReferenceDeploy(null, ' on `main`')).toThrow(DeclarationError);
    expect(() => requireReferenceDeploy(null, ' on `main`')).toThrow(
      /docs\/qa\/adoption\.md on `main` declares no reference environment, so no project can close \(K-PROJ-11\): add `- \*\*Reference environment:\*\*`/,
    );
  });

  it('reads the checked-out tree, where no record declares nothing and a malformed one throws', () => {
    expect(readReferenceDeploy()).toEqual({ environment: 'preview', workflow: 'deploy-preview.yml', job: 'ship' });
    const dir = mkdtempSync(join(tmpdir(), 'adoption-'));
    try {
      expect(readReferenceDeploy(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the reconciler's reader, from the default branch (K-MERGE-17)", () => {
  const calls: string[][] = [];
  const run = (contents: () => string) => (args: string[]) => {
    calls.push(args);
    if (args[1] === 'repos/o/r') return 'trunk\n';
    return contents();
  };
  const fail = (stderr: string) => () => {
    throw Object.assign(new Error('gh failed'), { stderr });
  };

  it("asks `gh` for the default branch's copy", () => {
    calls.length = 0;
    expect(readReferenceDeployFrom('o/r', run(() => WITH(DECLARED))).workflow).toBe('deploy-staging.yml');
    expect(calls[1]?.[1]).toBe(`repos/o/r/contents/${ADOPTION_RECORD}?ref=trunk`);
  });

  it('fails by name on a missing record, an unreadable one, one that declares nothing, and no default branch', () => {
    expect(() => readReferenceDeployFrom('o/r', run(fail('gh: Not Found (HTTP 404)')))).toThrow(
      /docs\/qa\/adoption\.md doesn't exist on `trunk`, so it declares no reference environment, and no project can close \(K-PROJ-11, K-LAYOUT-10\)/,
    );
    expect(() => readReferenceDeployFrom('o/r', run(fail('gh: Server Error (HTTP 502)')))).toThrow(/couldn't be read from `trunk`: gh: Server Error \(HTTP 502\)/);
    expect(() => readReferenceDeployFrom('o/r', run(() => WITH([])))).toThrow(/adoption\.md on `trunk` declares no reference environment, so no project can close/);
    expect(() => readReferenceDeployFrom('o/r', run(() => WITH(DECLARED.slice(1))))).toThrow(/without `Reference environment`/);
    expect(() => readReferenceDeployFrom('o/r', () => '\n')).toThrow(/no default branch to read docs\/qa\/adoption\.md from/);
  });

  it('names the environment for a message, and never throws (kanon#219)', () => {
    expect(declaredEnvironmentFrom('o/r', run(() => WITH(DECLARED)))).toBe('staging');
    // Each of these fails the deploy phase by name, through `readReferenceDeployFrom`; a
    // message before it falls back to "the reference environment" instead.
    expect(declaredEnvironmentFrom('o/r', run(fail('gh: Not Found (HTTP 404)')))).toBeNull();
    expect(declaredEnvironmentFrom('o/r', run(fail('gh: Server Error (HTTP 502)')))).toBeNull();
    expect(declaredEnvironmentFrom('o/r', run(() => WITH([])))).toBeNull();
    expect(declaredEnvironmentFrom('o/r', run(() => WITH(DECLARED.slice(1))))).toBeNull();
    expect(declaredEnvironmentFrom('o/r', () => '\n')).toBeNull();
  });

  it('the CLI prints one field, and exits 1 or 2 by name', () => {
    expect(referenceDeployCli(['workflow'], { repo: 'o/r', run: run(() => WITH(DECLARED)) })).toEqual({ code: 0, out: 'deploy-staging.yml' });
    expect(referenceDeployCli(['job'], { repo: 'o/r', run: run(() => WITH(DECLARED)) })).toEqual({ code: 0, out: 'deploy' });
    expect(referenceDeployCli(['workflow'], { repo: 'o/r', run: run(() => WITH([])) }).code).toBe(1);
    expect(referenceDeployCli(['toString'], { repo: 'o/r' }).code).toBe(2);
    expect(referenceDeployCli([], { repo: 'o/r' }).code).toBe(2);
    expect(referenceDeployCli(['workflow'], { repo: '' })).toEqual({ code: 2, out: 'reference-deploy: GITHUB_REPOSITORY must be set' });
  });
});

describe('readDeploy reads the declared workflow and job (plan 0004 P6)', () => {
  const CLOSED = [{ number: 1, state: 'CLOSED' }];
  const DECL = { environment: 'preview', workflow: 'deploy-preview.yml', job: 'ship' };
  const fakeGh = (jobs: Array<{ name: string; conclusion: string }>) => {
    const seen: string[][] = [];
    return {
      seen,
      json: (args: string[]) => {
        seen.push(args);
        if (args[0] === 'issue') return { closedByPullRequestsReferences: [{ number: 9 }] };
        if (args[0] === 'pr') return { state: 'MERGED', mergeCommit: { oid: 'a'.repeat(40) } };
        if (args[0] === 'api' && String(args[1]).includes('/releases')) return [{ tag: 'v1.0.0' }];
        if (args[0] === 'run' && args[1] === 'list') {
          return [{ displayTitle: 'v1.0.0', status: 'completed', conclusion: 'success', databaseId: 1, url: 'u' }];
        }
        if (args[0] === 'run' && args[1] === 'view') return { jobs };
        throw new Error(`unexpected gh ${args.join(' ')}`);
      },
      text: (a: string[]) => (a.includes('--paginate') ? '' : 'behind'),
    };
  };

  it('lists the declared workflow, and takes only the declared job as the deploy', () => {
    const io = fakeGh([{ name: 'gate', conclusion: 'success' }, { name: 'ship', conclusion: 'success' }]);
    const d = readDeploy(CLOSED, { ...io, declared: () => DECL });
    expect(d).toMatchObject({ state: 'deployed', tag: 'v1.0.0', ...DECL });
    const list = io.seen.find((a) => a[0] === 'run' && a[1] === 'list') ?? [];
    expect(list[list.indexOf('--workflow') + 1]).toBe('deploy-preview.yml');
  });

  it('a job that merely contains "deploy" is not the declared job', () => {
    const io = fakeGh([{ name: 'deploy', conclusion: 'success' }, { name: 'announce-deploy', conclusion: 'success' }]);
    expect(readDeploy(CLOSED, { ...io, declared: () => DECL }).state).toBe('deploy-job-absent');
    expect(readDeploy(CLOSED, { ...io, declared: () => ({ ...DECL, job: 'deploy' }) }).state).toBe('deployed');
  });

  it('a missing declaration fails the read by name, but only once there is a merge to look for', () => {
    const io = fakeGh([{ name: 'ship', conclusion: 'success' }]);
    const none = () => requireReferenceDeploy(null, ' on `main`');
    expect(() => readDeploy(CLOSED, { ...io, declared: none })).toThrow(/declares no reference environment, so no project can close \(K-PROJ-11\)/);
    // Nothing merged closed these issues: no run is looked for, so nothing is read.
    const noMerge = { ...io, json: (args: string[]) => (args[0] === 'issue' ? { closedByPullRequestsReferences: [] } : io.json(args)) };
    expect(readDeploy(CLOSED, { ...noMerge, declared: none }).state).toBe('nothing-to-deploy');
  });
});

describe('no script names the reference adopter\'s deploy workflow (plan 0004 P6)', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(mjs|js|sh)$/.test(f) ? [p] : [];
    });

  it('finds the scripts, so the check below is not vacuous', () => {
    expect(files(join(ROOT, 'scripts')).map((f) => f.slice(ROOT.length))).toContain('scripts/lead-reconcile.mjs');
  });

  it("holds no `'deploy-staging.yml'` literal in code", () => {
    const hits = files(join(ROOT, 'scripts')).flatMap((f) =>
      readFileSync(f, 'utf8').split('\n').flatMap((l, i) => (/['"]deploy-staging\.ya?ml['"]/.test(l) ? [`${f.slice(ROOT.length)}:${i + 1}`] : [])),
    );
    expect(hits).toEqual([]);
  });
});
