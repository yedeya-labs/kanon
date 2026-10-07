import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeclarationError } from '../../scripts/lib/declarations.mjs';
import { ESCALATION_FILE, PIPELINE_ESCALATIONS, escalatingPaths, escalationCategories, parseEscalationFile, readEscalationFile } from '../../scripts/lib/escalation-paths.mjs';
import { parseProductionPromotion, readProductionPromotion, readProductionPromotionAt } from '../../scripts/lib/production-promotion.mjs';
import { ADOPTION_RECORD } from '../../scripts/lib/reference-deploy.mjs';
import { IMPLEMENTER_LOGIN, REVIEWER_LOGIN, mergeVerdict, readEscalations } from '../../scripts/merge-gate.mjs';
import { IMPLEMENTER_STATUS, headerLine } from '../../scripts/lib/role-marker.mjs';

/**
 * kanon#158, the Owner's decision of 2026-10-06: an adopter whose production promotion is
 * human-gated may say so in its adoption record, and the Merger then merges a PR on one of its
 * high-risk paths in the green zone (`K-MERGE-4`). Nothing that decides how a PR is judged ever
 * stops escalating, and the declaration counts only from the default branch (`K-MERGE-17`).
 */

const BULLET = "- **Production promotion:** human-gated (the `production` environment's required reviewer)";
const RECORD = (choices: string) => `# Adoption record\n\n## People\n\nA.\n\n## Choices\n\n- **Chat channel:** none yet.\n${choices}\n## Notes\n\nProse.\n`;

const fails = (text: string, message: RegExp) => {
  expect(() => parseProductionPromotion(text)).toThrow(DeclarationError);
  expect(() => parseProductionPromotion(text)).toThrow(message);
};

describe('the production-promotion declaration (K-LAYOUT-10)', () => {
  it('reads what gates the promotion, from inside the parentheses', () => {
    expect(parseProductionPromotion(RECORD(`${BULLET}\n`))).toBe("the `production` environment's required reviewer");
    expect(parseProductionPromotion(RECORD('* **Production promotion:** human-gated (a release manager approves each deploy)  \n'))).toBe('a release manager approves each deploy');
    expect(parseProductionPromotion(RECORD(`${BULLET}\n`).replace(/\n/g, '\r\n'))).toBe("the `production` environment's required reviewer");
  });

  it("reads no bullet, or one only inside a fenced example, as not declared: Kanon's default", () => {
    expect(parseProductionPromotion(RECORD(''))).toBeNull();
    expect(parseProductionPromotion(RECORD(`\`\`\`markdown\n${BULLET}\n\`\`\`\n`))).toBeNull();
  });

  it('refuses one declared twice, by line', () =>
    fails(RECORD(`${BULLET}\n${BULLET}\n`), /adoption\.md:11 repeats `Production promotion`, already declared on line 10 \(K-LAYOUT-10\)/));

  it('refuses one outside `## Choices`, by line, including under a later heading', () => {
    fails(`# Adoption record\n\n${BULLET}\n\n## Choices\n`, /adoption\.md:3 declares the production promotion outside `## Choices`/);
    fails(`${RECORD('')}${BULLET}\n`, /adoption\.md:14 declares the production promotion outside `## Choices`/);
    fails(`# Adoption record\n\n${BULLET}\n`, /outside `## Choices`/);
  });

  it('refuses another shape or another value, and says how to keep the default', () => {
    for (const line of [
      '- **Production promotion:** `human-gated`',
      '- **Production promotion:** human-gated',
      '- **Production promotion:** human gated (a reviewer)',
      '- **Production promotion:** not gated (nothing)',
      '- **Production promotion:** Human-gated (a reviewer)',
      '+ **Production promotion:** human-gated (a reviewer)',
      '  - **Production promotion:** human-gated (a reviewer)',
      '- **Production promotion:** human-gated (a reviewer) and more',
    ]) {
      fails(RECORD(`${line}\n`), /adoption\.md:10, under `## Choices`, isn't a declaration: .*Remove the bullet for Kanon's default/);
    }
  });

  it('refuses empty parentheses, and a description longer than 200 characters', () => {
    fails(RECORD('- **Production promotion:** human-gated ( )\n'), /adoption\.md:10: `Production promotion` names nothing in its parentheses/);
    expect(parseProductionPromotion(RECORD(`- **Production promotion:** human-gated (${'x'.repeat(200)})\n`))).toHaveLength(200);
    fails(RECORD(`- **Production promotion:** human-gated (${'x'.repeat(201)})\n`), /is 201 characters; name it in at most 200/);
  });

  it('reads a checked-out tree for lane-check: no record declares nothing, a malformed one throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'promotion-'));
    try {
      expect(readProductionPromotion(dir)).toBeNull();
      mkdirSync(join(dir, 'docs/qa'), { recursive: true });
      writeFileSync(join(dir, ADOPTION_RECORD), RECORD(`${BULLET}\n`));
      expect(readProductionPromotion(dir)).toMatch(/required reviewer/);
      writeFileSync(join(dir, ADOPTION_RECORD), RECORD('- **Production promotion:** yes\n'));
      expect(() => readProductionPromotion(dir)).toThrow(/isn't a declaration/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the default branch it is given, names the default, and fails by name on a failed read', () => {
    const asked: string[] = [];
    expect(readProductionPromotionAt('trunk', (path, ref) => { asked.push(`${path}@${ref}`); return RECORD(`${BULLET}\n`); }))
      .toEqual({ gate: "the `production` environment's required reviewer", defaults: [] });
    expect(asked).toEqual([`${ADOPTION_RECORD}@trunk`]);
    expect(readProductionPromotionAt('trunk', () => null)).toEqual({
      gate: null,
      defaults: ["docs/qa/adoption.md on `trunk` doesn't exist, so Kanon's default applies: the production promotion isn't declared human-gated, and every escalation path escalates (K-MERGE-4)"],
    });
    expect(readProductionPromotionAt('trunk', () => RECORD('')).defaults).toEqual([
      "docs/qa/adoption.md on `trunk` declares no `Production promotion`, so Kanon's default applies: the production promotion isn't declared human-gated, and every escalation path escalates (K-MERGE-4)",
    ]);
    expect(() => readProductionPromotionAt('trunk', () => { throw new Error('HTTP 502'); })).toThrow(/couldn't be read from `trunk`: HTTP 502/);
    expect(() => readProductionPromotionAt('', () => RECORD(`${BULLET}\n`))).toThrow(/no default branch to read docs\/qa\/adoption\.md from/);
  });
});

/** A green-zone PR in every respect but its files. */
const pr = (files: string[]) => ({
  number: 1,
  author: IMPLEMENTER_LOGIN,
  // The Implementer's role marker and head status, which the green zone requires (#333).
  body: headerLine('Implementer'),
  headStatuses: [{ context: IMPLEMENTER_STATUS, state: 'success', creator: `${IMPLEMENTER_LOGIN}[bot]` }],
  state: 'OPEN',
  isDraft: false,
  labels: ['agent:implement'],
  files,
  headSha: 'abc1234',
  reviews: [{ state: 'APPROVED', sha: 'abc1234', author: REVIEWER_LOGIN, body: headerLine('Reviewer') }],
  checks: [{ name: 'Test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  mergeStateStatus: 'CLEAN',
  mergeable: 'MERGEABLE',
  rebaseAttempted: false,
  closing: { mergeClosesUndeclared: [], unverifiable: false },
  workflowRuns: [],
});

describe('the escalating paths under a human-gated promotion (K-MERGE-4)', () => {
  // The fixture adopter declares `^migrations/` and an auth pattern as high-risk paths, and
  // `scripts/pipeline/` as its pipeline code.
  const file = readEscalationFile();
  const undeclared = escalatingPaths(file);
  const declared = escalatingPaths(file, { judgingInputs: ['AGENTS.md', 'docs/qa/stack.md', 'docs/guides/observability.md', 'src/auth/README.md'] });
  const verdict = (escalations: Array<readonly [RegExp, string]>, files: string[]) => mergeVerdict(pr(files), { escalations });

  it('undeclared, is unchanged: an ordinary high-risk path escalates', () => {
    expect(undeclared).toEqual(escalatingPaths(file, null));
    for (const f of ['migrations/0001.sql', 'src/server/session.ts']) {
      expect(verdict(undeclared, [f]), f).toMatchObject({ action: 'escalate', rule: 'escalating-path' });
    }
  });

  it('declared, merges a PR that touches only ordinary high-risk paths', () => {
    expect(verdict(declared, ['migrations/0001.sql', 'src/server/session.ts', 'src/app/page.tsx'])).toMatchObject({ action: 'merge', rule: 'green-zone' });
  });

  it('declared, still escalates every rule file: the record that declares it, the rest of `docs/qa/`, the agent instructions, `.claude/`, every workflow and the pipeline code', () => {
    for (const f of [
      ADOPTION_RECORD,
      ESCALATION_FILE,
      'docs/qa/agent-identities.md',
      'docs/qa/sign-off-delegation.md',
      'docs/qa/reviewer-playbook.md',
      'AGENTS.md',
      'CLAUDE.md',
      '.claude/settings.json',
      '.github/workflows/agent-merge.yml',
      '.github/workflows/deploy-production.yml',
      '.github/actions/project-setup/action.yml',
      '.github/dependabot.yml',
      'scripts/pipeline/file-follow-up.mjs',
    ]) {
      expect(verdict(declared, ['migrations/0001.sql', f]), f).toMatchObject({ action: 'escalate', rule: 'escalating-path' });
      expect(verdict(declared, [f]), f).toMatchObject({ action: 'escalate', rule: 'escalating-path' });
    }
  });

  it('declared, still escalates a high-risk path that is a judging input on the default branch, and only that file', () => {
    expect(verdict(declared, ['src/auth/README.md'])).toMatchObject({ action: 'escalate', rule: 'escalating-path', why: expect.stringMatching(/`src\/auth\/README\.md` \(auth, and a judging input \(K-MERGE-17\)/) });
    expect(verdict(declared, ['src/auth/README.md.bak', 'src/auth/session.ts'])).toMatchObject({ action: 'merge' });
    // A judging input that no declared path covers is K-MERGE-4's deliberate exception, before
    // and after: the opt-in never adds an escalation the default doesn't have.
    expect(verdict(declared, ['docs/guides/observability.md'])).toMatchObject({ action: 'merge' });
    expect(verdict(undeclared, ['docs/guides/observability.md'])).toMatchObject({ action: 'merge' });
  });

  it('declared, keeps the verdict\'s own rules: a project brief and a spec promotion still escalate', () => {
    expect(verdict(declared, ['docs/projects/12-kiosk.md'])).toMatchObject({ action: 'escalate', rule: 'escalating-path' });
    const spec = { ...pr(['docs/qa/specs/kiosk.md']), specDiff: { promotions: [{ id: 'KIO-1', file: 'docs/qa/specs/kiosk.md', from: 'proposed' }], unreadable: [] } };
    expect(mergeVerdict(spec, { escalations: declared })).toMatchObject({ action: 'escalate', rule: 'spec-promotion' });
  });

  it('declared, still escalates a high-risk path marked `always`, such as the code that keeps the promotion gated (kanon#344)', () => {
    const marked = parseEscalationFile(
      '## Escalation paths\n\n- `^infra/environments/` `infra` `always` — the production environment\'s required reviewers\n- `^infra/` `infra` — the rest of the infrastructure\n',
    );
    const gated = escalatingPaths(marked, { judgingInputs: [] });
    expect(verdict(gated, ['infra/environments/production.tf'])).toMatchObject({
      action: 'escalate',
      rule: 'escalating-path',
      why: expect.stringMatching(/the production environment's required reviewers, marked `always`, which a human-gated promotion never relaxes \(K-MERGE-4\)/),
    });
    expect(verdict(gated, ['infra/network.tf'])).toMatchObject({ action: 'merge', rule: 'green-zone' });
    // Undeclared, the marker changes nothing: both escalate, each with its own reason.
    for (const f of ['infra/environments/production.tf', 'infra/network.tf']) {
      expect(verdict(escalatingPaths(marked), [f]), f).toMatchObject({ action: 'escalate', rule: 'escalating-path', why: expect.not.stringMatching(/marked `always`/) });
    }
    // The category still says what the change touched, marked or not.
    expect(escalationCategories(marked, ['infra/environments/production.tf'])).toEqual(['infra']);
  });

  it('keeps every pipeline escalation first, whatever is declared', () => {
    expect(declared.slice(0, PIPELINE_ESCALATIONS.length)).toEqual([...PIPELINE_ESCALATIONS]);
  });
});

describe("the Merger's reader (K-MERGE-17)", () => {
  const ESCALATION = '# Escalation paths\n\n## Escalation paths\n\n- `^migrations/` — database migrations\n\n## Pipeline code\n\n- `scripts/pipeline/` — ours\n';
  /** `gh`, serving each file per ref; the repository's default branch is `trunk`. */
  const gh = (files: Record<string, string>, asked: string[] = []) => (args: string[]) => {
    if (args[1] === 'repos/o/r') return 'trunk\n';
    const m = /^repos\/o\/r\/contents\/(.+)\?ref=(.+)$/.exec(args[1] ?? '');
    asked.push(args[1] ?? '');
    const text = m ? files[`${m[1]}@${decodeURIComponent(m[2] ?? '')}`] : undefined;
    if (text === undefined) throw Object.assign(new Error('gh failed'), { stderr: 'gh: Not Found (HTTP 404)' });
    return text;
  };
  const reasons = (paths: Array<readonly [RegExp, string]>) => paths.map(([, r]) => r);

  it('undeclared: reads no judging inputs, escalates every path, and names the default', () => {
    const printed: string[] = [];
    const inputs: string[] = [];
    const paths = readEscalations('o/r', gh({ [`${ESCALATION_FILE}@trunk`]: ESCALATION, [`${ADOPTION_RECORD}@trunk`]: RECORD('') }), (l) => printed.push(l), (b) => { inputs.push(b); return []; });
    expect(reasons(paths)).toContain('database migrations');
    expect(inputs, 'the default costs no judging-input read').toEqual([]);
    expect(printed).toEqual([
      "merge-gate: docs/qa/adoption.md on `trunk` declares no `Production promotion`, so Kanon's default applies: the production promotion isn't declared human-gated, and every escalation path escalates (K-MERGE-4)",
    ]);
  });

  it('declared on the default branch: drops the high-risk paths, keeps the rest, reads the judging inputs there, and says so', () => {
    const printed: string[] = [];
    const inputs: string[] = [];
    const asked: string[] = [];
    const paths = readEscalations('o/r', gh({ [`${ESCALATION_FILE}@trunk`]: ESCALATION, [`${ADOPTION_RECORD}@trunk`]: RECORD(`${BULLET}\n`) }, asked), (l) => printed.push(l), (b) => { inputs.push(b); return ['migrations/README.md', 'AGENTS.md']; });
    expect(reasons(paths)).not.toContain('database migrations');
    expect(reasons(paths)).toContain('ours');
    expect(paths.find(([re]) => re.test('migrations/README.md'))?.[1]).toMatch(/^database migrations, and a judging input/);
    expect(paths.find(([re]) => re.test('migrations/0001.sql'))).toBeUndefined();
    expect(inputs).toEqual(['trunk']);
    expect(asked.every((a) => a.endsWith('?ref=trunk')), asked.join(', ')).toBe(true);
    expect(printed).toEqual([
      "merge-gate: the production promotion is human-gated (the `production` environment's required reviewer), as docs/qa/adoption.md on `trunk` declares, so the project's 1 high-risk path under `## Escalation paths` not marked `always` merges in the green zone. The pipeline's own paths, the project's pipeline code, every high-risk path marked `always` and every judging input still escalate (K-MERGE-4)",
    ]);
  });

  it('declared, counts only the unmarked high-risk paths as relaxed, and names the marked ones as still escalating (kanon#344)', () => {
    const marked = '# Escalation paths\n\n## Escalation paths\n\n- `^infra/environments/` `infra` `always` — the required reviewers\n- `^infra/` `infra` — the rest\n- `^migrations/` — database migrations\n\n## Pipeline code\n';
    const printed: string[] = [];
    const paths = readEscalations('o/r', gh({ [`${ESCALATION_FILE}@trunk`]: marked, [`${ADOPTION_RECORD}@trunk`]: RECORD(`${BULLET}\n`) }), (l) => printed.push(l), () => []);
    expect(printed).toEqual([
      "merge-gate: the production promotion is human-gated (the `production` environment's required reviewer), as docs/qa/adoption.md on `trunk` declares, so the project's 2 high-risk paths under `## Escalation paths` not marked `always` merge in the green zone. The pipeline's own paths, the project's pipeline code, every high-risk path marked `always` and every judging input still escalate (K-MERGE-4)",
    ]);
    expect(paths.find(([re]) => re.test('infra/environments/prod.tf'))?.[1]).toMatch(/^the required reviewers, marked `always`/);
    expect(paths.find(([re]) => re.test('infra/network.tf'))).toBeUndefined();
  });

  it("ignores a declaration on a PR's branch: only the default branch's record counts", () => {
    const paths = readEscalations('o/r', gh({
      [`${ESCALATION_FILE}@trunk`]: ESCALATION,
      [`${ADOPTION_RECORD}@trunk`]: RECORD(''),
      [`${ADOPTION_RECORD}@feat/gate`]: RECORD(`${BULLET}\n`),
    }), () => {}, () => []);
    expect(mergeVerdict(pr([ADOPTION_RECORD, 'migrations/0002.sql']), { escalations: paths })).toMatchObject({ action: 'escalate', rule: 'escalating-path' });
    expect(mergeVerdict(pr(['migrations/0002.sql']), { escalations: paths })).toMatchObject({ action: 'escalate', rule: 'escalating-path' });
  });

  it('stops by name on a malformed bullet, an unreadable record, or unreadable judging inputs: never a sweep with the wrong rules', () => {
    expect(() => readEscalations('o/r', gh({ [`${ESCALATION_FILE}@trunk`]: ESCALATION, [`${ADOPTION_RECORD}@trunk`]: RECORD('- **Production promotion:** sure\n') }), () => {}, () => []))
      .toThrow(/adoption\.md:10, under `## Choices`, isn't a declaration/);
    const broken = (args: string[]) => {
      if (args[1] === 'repos/o/r') return 'trunk\n';
      if ((args[1] ?? '').includes(ADOPTION_RECORD)) throw Object.assign(new Error('gh failed'), { stderr: 'gh: Server Error (HTTP 502)' });
      return ESCALATION;
    };
    expect(() => readEscalations('o/r', broken, () => {}, () => [])).toThrow(/adoption\.md couldn't be read from `trunk`: gh: Server Error \(HTTP 502\)/);
    expect(() => readEscalations('o/r', gh({ [`${ESCALATION_FILE}@trunk`]: ESCALATION, [`${ADOPTION_RECORD}@trunk`]: RECORD(`${BULLET}\n`) }), () => {}, () => { throw new Error('the tree of o/r@trunk is too large to read in one request'); }))
      .toThrow(/too large/);
  });
});
