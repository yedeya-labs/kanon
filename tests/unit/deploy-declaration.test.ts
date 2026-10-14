import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADOPTION_RECORD,
  DeclarationError,
  DEFAULT_CI_WAIT,
  movedReferenceBullets,
  parseDeployDeclaration,
  readDeployDeclaration,
  readReferenceDeployFrom,
} from '../../scripts/lib/deploy-declaration.mjs';
import { readDeploy } from '../../scripts/lead-reconcile.mjs';
import { EXIT, FINDINGS, UNWAIVABLE } from '../../cli/doctor.mjs';
import { checkout, fakeGitHub, healthyFiles, ids, run } from './helpers/doctor.js';
import { SPAWNS } from './helpers/spawns.js';

/**
 * Plan 0010 step D2: the adoption record's `## Deploy` section, read by one parser,
 * `scripts/lib/deploy-declaration.mjs`: the environment chain, the CI wait, the reference deploy's
 * three bullets (moved there from `## Choices` at once, follow-up decision 1) and the fallback's
 * marker. The reconciler and lane-check read the reference deploy through it; doctor reports
 * bullets left under `## Choices` as `deploy.declaration-moved`; the upgrade skill moves them.
 */

const ROOT = process.cwd();
const FIXTURE = join(ROOT, 'tests/fixtures/adopter');
const RECORD = (deploy: string[], before = '') =>
  `# Adoption record\n\n## Plan\n\n- **Environments:** no Kanon lane needs one.\n\n## Choices\n\n- **Overseer:** \`not installed\`\n${before}\n## Deploy\n\n${deploy.join('\n')}\n`;
// The line of `RECORD`'s first `## Deploy` bullet, for the messages.
const FIRST = 13;
const REFERENCE = (environment: string) => [
  `- **Reference environment:** \`${environment}\``,
  '- **Reference deploy workflow:** `deploy.yml`',
  `- **Reference deploy job:** \`${environment} / deploy\``,
];

const fails = (text: string, message: RegExp) => {
  expect(() => parseDeployDeclaration(text)).toThrow(DeclarationError);
  expect(() => parseDeployDeclaration(text)).toThrow(message);
};

describe('the chain: an ordered list, whose last is production (plan 0010 §4, decision 2)', () => {
  it.each([
    [['production']],
    [['staging', 'production']],
    [['dev', 'staging', 'live']],
    [['qa', 'canary', 'beta']],
  ])('reads %j in the order written, the last as production', (names) => {
    const d = parseDeployDeclaration(RECORD([`- **Environments:** ${names.map((n) => `\`${n}\``).join(', ')}`]));
    expect(d.environments).toEqual(names);
    expect(d.chain).toEqual(names.map((environment, i) => ({
      environment,
      position: i + 1,
      role: i === names.length - 1 ? 'production' : 'pre-production',
    })));
  });

  it('declares no environment with no section, no list, or an empty list', () => {
    const none = { environments: [], chain: [], ciWait: DEFAULT_CI_WAIT, reference: null, fallback: null };
    expect(parseDeployDeclaration('# Adoption record\n\n## Choices\n\n- **Overseer:** `installed`\n')).toEqual(none);
    expect(parseDeployDeclaration(RECORD(['Nothing deploys yet.']))).toEqual(none);
    expect(parseDeployDeclaration(RECORD(['- **Environments:**']))).toEqual(none);
  });

  it("reads Kanon's own record as declaring nothing: no environment and no reference deploy", () => {
    expect(readDeployDeclaration(ROOT)).toEqual({ environments: [], chain: [], ciWait: DEFAULT_CI_WAIT, reference: null, fallback: null });
  });

  it("leaves `## Plan`'s prose `Environments` bullet, which `kanon init` writes, as prose", () => {
    expect(parseDeployDeclaration(RECORD([])).environments).toEqual([]);
  });
});

describe('the CI wait (decision 9)', () => {
  it('reads an absent wait as 90 minutes', () => {
    expect(DEFAULT_CI_WAIT).toBe(90);
    expect(parseDeployDeclaration(RECORD(['- **Environments:** `production`'])).ciWait).toBe(90);
  });

  it.each([1, 45, 360])('reads a wait of %i', (n) => {
    expect(parseDeployDeclaration(RECORD([`- **CI wait:** \`${n}\``])).ciWait).toBe(n);
  });

  it.each(['0', '361', '-5', '1.5', 'ninety'])('refuses a wait of %s, by its line', (n) => {
    fails(RECORD([`- **CI wait:** \`${n}\``]), new RegExp(`docs/qa/adoption\\.md:${FIRST}: \`CI wait\` is \`${n.replace('.', '\\.')}\`; write a whole number of minutes from 1 to 360`));
  });
});

describe('the reference deploy (K-PROJ-11), in `## Deploy`', () => {
  it("reads a section holding only the three bullets as a reference deploy with no chain: the adopter fixture's", () => {
    const d = readDeployDeclaration(FIXTURE);
    expect(d).toEqual({
      environments: [],
      chain: [],
      ciWait: DEFAULT_CI_WAIT,
      reference: { environment: 'preview', workflow: 'deploy-preview.yml', job: 'ship' },
      fallback: null,
    });
  });

  it('reads a reference that names one of the declared environments, and the whole section', () => {
    const d = parseDeployDeclaration(RECORD([
      '- **Environments:** `staging`, `production`',
      '- **CI wait:** `120`',
      ...REFERENCE('staging'),
      '- **Fallback:** `no-reviewers`',
    ]));
    expect(d).toEqual({
      environments: ['staging', 'production'],
      chain: [
        { environment: 'staging', position: 1, role: 'pre-production' },
        { environment: 'production', position: 2, role: 'production' },
      ],
      ciWait: 120,
      reference: { environment: 'staging', workflow: 'deploy.yml', job: 'staging / deploy' },
      fallback: 'no-reviewers',
    });
  });

  it('reads both markers', () => {
    for (const marker of ['no-environments', 'no-reviewers']) {
      expect(parseDeployDeclaration(RECORD(['- **Environments:** `production`', `- **Fallback:** \`${marker}\``])).fallback).toBe(marker);
    }
  });

  it("the reconciler finds the fixture's reference deploy in `## Deploy`, and takes its job as the deploy", () => {
    const text = readFileSync(join(FIXTURE, ADOPTION_RECORD), 'utf8');
    const gh = (args: string[]) => (args[1] === 'repos/o/r' ? 'main\n' : text);
    const declared = readReferenceDeployFrom('o/r', gh);
    expect(declared).toEqual({ environment: 'preview', workflow: 'deploy-preview.yml', job: 'ship' });
    const json = (args: string[]) => {
      if (args[0] === 'issue') return { closedByPullRequestsReferences: [{ number: 9 }] };
      if (args[0] === 'pr') return { state: 'MERGED', mergeCommit: { oid: 'a'.repeat(40) } };
      if (args[0] === 'api') return [{ tag: 'v1.0.0' }];
      if (args[1] === 'list') return [{ displayTitle: 'v1.0.0', status: 'completed', conclusion: 'success', databaseId: 1, url: 'u' }];
      return { jobs: [{ name: 'ship', conclusion: 'success' }] };
    };
    const d = readDeploy([{ number: 1, state: 'CLOSED' }], { json, text: (a: string[]) => (a.includes('--paginate') ? '' : 'behind'), declared: () => declared });
    expect(d).toMatchObject({ state: 'deployed', environment: 'preview', workflow: 'deploy-preview.yml', job: 'ship' });
  });
});

describe('what the parser refuses, each a DeclarationError naming the file and the line', () => {
  it.each([
    ['an environment named twice', ['- **Environments:** `staging`, `production`, `staging`'], /adoption\.md:13: `Environments` names `staging` twice/],
    ['an empty code span in the list', ['- **Environments:** `staging`, ``'], /adoption\.md:13: `Environments` has an empty code span/],
    ['an empty code span for a value', ['- **Fallback:** ``'], /adoption\.md:13: `Fallback` has an empty code span/],
    ['a list not written as code spans', ['- **Environments:** staging, production'], /adoption\.md:13: `Environments` isn't a list of code spans/],
    ['a reference environment not in a present list', ['- **Environments:** `production`', ...REFERENCE('staging')], /adoption\.md:14: the reference environment `staging` isn't one of the `Environments` declared on line 13/],
    ['two of the three reference bullets', REFERENCE('staging').slice(0, 2), /adoption\.md declares the reference environment's deploy without `Reference deploy job`: declare all three, or none/],
    ['an unknown marker', ['- **Fallback:** `no-protection`'], /adoption\.md:13: `Fallback` is `no-protection`; write `no-environments` or `no-reviewers`/],
    ['a bullet written twice', ['- **CI wait:** `30`', '- **CI wait:** `40`'], /adoption\.md:14 repeats `CI wait`, already declared on line 13/],
    ['a list item that declares nothing', ['- **Environment:** `production`'], /adoption\.md:13, under `## Deploy`, is a list item that declares nothing/],
  ])('%s', (_what, lines, message) => {
    fails(RECORD(lines), message);
    expect(() => parseDeployDeclaration(RECORD(lines))).toThrow(/\(K-LAYOUT-10\)$/);
  });

  it('a deploy bullet outside `## Deploy`', () => {
    fails(RECORD([], '- **CI wait:** `30`\n'), /adoption\.md:10 declares `CI wait` outside `## Deploy`: write it under that heading/);
    fails(RECORD([], '- **Environments:** `production`\n'), /adoption\.md:10 declares `Environments` outside `## Deploy`/);
    fails(RECORD([], '- **Fallback:** `no-reviewers`\n'), /adoption\.md:10 declares `Fallback` outside `## Deploy`/);
    fails(`# Adoption record\n\n## Notes\n\n${REFERENCE('preview')[0]}\n`, /adoption\.md:5 declares the reference environment's deploy outside `## Deploy`/);
  });

  it('`## Deploy` written twice', () => {
    fails(`${RECORD([])}\n## Deploy\n`, /has the `## Deploy` heading 2 times/);
  });

  it('ignores a declaration inside a fenced block, as an example', () => {
    expect(parseDeployDeclaration(RECORD(['```markdown', '- **Environments:** `a`, `a`', '- **CI wait:** `0`', '```'])).environments).toEqual([]);
  });
});

describe('the bullets moved at once (plan 0010, follow-up decision 1)', () => {
  const LEFT = (bullets: string[]) => RECORD([], `${bullets.join('\n')}\n`);

  it('throws on reference bullets left under `## Choices`, naming the line and the move, never reading them as a declaration', () => {
    fails(LEFT(REFERENCE('preview')), /adoption\.md:10 declares `Reference environment` under `## Choices`, but the reference deploy is read from `## Deploy` only \(plan 0010\): move its three bullets into a `## Deploy` section, as the upgrade skill does; `kanon doctor` reports them as `deploy\.declaration-moved`/);
    // Even beside a whole declaration in `## Deploy`: there is no reading both places.
    fails(RECORD(REFERENCE('preview'), `${REFERENCE('preview')[1]}\n`), /adoption\.md:10 declares `Reference deploy workflow` under `## Choices`/);
  });

  it('the reconciler refuses them on the default branch, by the same message', () => {
    const gh = (args: string[]) => (args[1] === 'repos/o/r' ? 'main\n' : LEFT(REFERENCE('preview')));
    expect(() => readReferenceDeployFrom('o/r', gh)).toThrow(DeclarationError);
    expect(() => readReferenceDeployFrom('o/r', gh)).toThrow(/adoption\.md:10 declares `Reference environment` under `## Choices`.*move its three bullets into a `## Deploy` section/);
  });

  it('movedReferenceBullets lists them with their lines and text, outside fences only, and never throws', () => {
    expect(movedReferenceBullets(LEFT(REFERENCE('preview')))).toEqual(REFERENCE('preview').map((text, i) => ({ line: 10 + i, label: /\*\*(.+):\*\*/.exec(text)![1], text })));
    expect(movedReferenceBullets(RECORD(REFERENCE('preview')))).toEqual([]);
    expect(movedReferenceBullets(LEFT(['```', ...REFERENCE('preview'), '```']))).toEqual([]);
    expect(movedReferenceBullets(LEFT([...REFERENCE('preview'), '```']))).toHaveLength(3);
  });
});

describe('doctor reports bullets left under `## Choices` as deploy.declaration-moved', SPAWNS, () => {
  const LEFT = '- **Reference environment:** `preview`\n- **Reference deploy workflow:** `deploy-preview.yml`\n- **Reference deploy job:** `ship`\n';

  it('is a blocking declaration finding no waiver waives', () => {
    expect(FINDINGS['deploy.declaration-moved']).toEqual({ category: 'declaration', blocking: true });
    expect(UNWAIVABLE['deploy.declaration-moved']).toBeDefined();
  });

  it('for an adopter with no chain, naming the lines, with the move as its fix', async () => {
    const files = healthyFiles();
    files['docs/qa/adoption.md'] += LEFT;
    const r = await run(checkout(files), fakeGitHub(), ['--json']);
    expect(r.status, r.out).toBe(EXIT.findings);
    expect(ids(r)).toEqual(['deploy.declaration-moved docs/qa/adoption.md']);
    const f = r.json.findings[0];
    expect(f).toMatchObject({ category: 'declaration', blocking: true });
    expect(f.message).toContain('docs/qa/adoption.md declares the reference deploy under ## Choices, on lines 12, 13, 14, but Kanon reads it from ## Deploy alone');
    expect(f.fix.text).toMatch(/^Move these bullets out of ## Choices into a ## Deploy section of docs\/qa\/adoption\.md/);
    expect(f.fix.text).toContain('as the upgrade skill does');
    expect(f.fix.commands).toEqual(['## Deploy', '', ...LEFT.trim().split('\n')]);
  });

  it('is quiet once they are in `## Deploy`', async () => {
    const files = healthyFiles();
    files['docs/qa/adoption.md'] += `\n## Deploy\n\n${LEFT}`;
    const r = await run(checkout(files), fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual([]);
  });
});

describe('the upgrade skill moves them', () => {
  const skill = readFileSync(join(ROOT, 'skills/upgrade/SKILL.md'), 'utf8');
  const steps = skill.split('## Steps')[1]!.split('\n## ')[0]!;
  it('says, in its steps, to move each of the three bullets from `## Choices` into `## Deploy`, unchanged, and names the finding', () => {
    const para = steps.split('\n\n').find((p) => p.includes('deploy.declaration-moved')) ?? '';
    for (const label of ['Reference environment', 'Reference deploy workflow', 'Reference deploy job']) expect(para).toContain(`- **${label}:**`);
    expect(para).toMatch(/move each one, unchanged, out of `## Choices` into a `## Deploy` section/);
    expect(para).toMatch(/no period of reading both places/);
  });
});
