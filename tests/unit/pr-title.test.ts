import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkBranch, checkTitle, main, TOOL_BRANCHES, TYPES } from '../../actions/pr-title/pr-title.mjs';
import { splitBranch } from '../../scripts/lib/protocol-spellings.mjs';

describe('K-SHIP-4 the PR-title check', () => {
  it.each([
    'feat: publish a draft on a schedule',
    'fix(cms): keep the editor session across a resume',
    'ci(deps): bump the setup action',
    'build(deps): update the CMS',
    'feat!: drop the legacy preview route',
    'feat(api)!: drop the v1 routes',
    'docs(projects): propose the brief for the first managed, editable site',
    'refactor(a.b/c_d-e): scope with every allowed character class',
    'chore: mention (#12) in the middle',
    '  fix: surrounding whitespace is trimmed  ',
  ])('accepts %s', (title) => {
    expect(checkTitle(title)).toEqual({ ok: true });
  });

  it.each([
    ['feature: add a thing', 'type'],
    ['Feat: add a thing', 'conventional'],
    ['add a thing', 'conventional'],
    ['feat:add a thing', 'conventional'],
    ['feat:  add a thing', 'conventional'],
    ['feat(Scope): add a thing', 'conventional'],
    ['feat(): add a thing', 'conventional'],
    ['feat: add a thing (#12)', 'issue reference'],
    ['fix(cms): keep the session (#3) ', 'issue reference'],
    ['', 'conventional'],
    ['xfeat: add a thing', 'type'],
    ['feat: add a thing\nfeat: add a second line', 'conventional'],
  ])('rejects %j', (title, reason) => {
    const result = checkTitle(title);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(reason);
  });

  it('names the offending type when the type is unrecognised', () => {
    const result = checkTitle('feature: add a thing');
    expect(result.ok === false && result.reason).toContain('"feature"');
  });

  it("recognises exactly the types in Kanon's fixed table, and marks exactly the deploying ones", () => {
    expect(Object.keys(TYPES).sort()).toEqual(
      ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'],
    );
    const deploying = Object.entries(TYPES).filter(([, t]) => t.deploys).map(([name]) => name).sort();
    expect(deploying).toEqual(['build', 'feat', 'fix', 'perf', 'refactor', 'revert']);
    const minor = Object.entries(TYPES).filter(([, t]) => t.bump === 'minor').map(([name]) => name);
    expect(minor).toEqual(['feat']);
  });

  it('does not treat inherited object properties as types', () => {
    expect(checkTitle('constructor: add a thing').ok).toBe(false);
    expect(checkTitle('tostring: add a thing').ok).toBe(false);
  });
});

describe('K-WS-8 the branch-name check', () => {
  it.each([
    'fix/42-empty-cart-total',
    'feat/1243-branch-name-guard',
    'docs/7-a',
    'ci/1065-issue-backstop-caller',
    'test/3-x2-y',
  ])('accepts %s', (branch) => {
    expect(checkBranch(branch)).toEqual({ ok: true });
  });

  it('accepts every PR-title type as the branch type, and no other', () => {
    for (const type of Object.keys(TYPES)) expect(checkBranch(`${type}/1-a`), type).toEqual({ ok: true });
    expect(checkBranch('tests/1-a').ok).toBe(false);
  });

  it.each([
    ['fix/doc-path-guard-code-spans', 'is not named'],
    ['fix/code-audit-complete-on-own-end-1144', 'is not named'],
    ['fix/42', 'is not named'],
    ['fix/42-', 'is not named'],
    ['fix/42-Empty-cart', 'is not named'],
    ['fix/42-empty_cart', 'is not named'],
    ['fix/42-empty--cart', 'is not named'],
    ['fix/42-empty-cart-', 'is not named'],
    ['fix/042-empty-cart', 'is not named'],
    ['fix/x42-empty-cart', 'is not named'],
    ['Fix/42-empty-cart', 'is not named'],
    ['fix/42-empty-cart/more', 'is not named'],
    ['42-empty-cart', 'is not named'],
    ['claude/issue-42-20261022', 'is not named'],
    ['agent/833-own-callers-reask', '"agent"'],
    ['implement/12-own-adoption-doctor', '"implement"'],
    ['tests/1204-split-slow-files', '"tests"'],
    ['constructor/1-a', '"constructor"'],
  ])('rejects %j', (branch, reason) => {
    const result = checkBranch(branch);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(reason);
  });

  it.each([
    ['dependabot/github_actions/kanon-ff1c2abc', 'Dependabot'],
    ['dependabot/npm_and_yarn/vitest-4.1.0', 'Dependabot'],
    ['release-please--branches--main--components--kanon', 'release-please'],
    ['release-please--branches--main', 'release-please'],
    ['lead/split-42', "the Lead's split lane"],
    ['kanon/upgrade-v0.42.0', "Kanon's upgrade skill"],
    ['kanon/pins-candidate-v0.42.0', "Kanon's candidate pin pull request"],
    ['kanon/metrics-page', "Kanon's metrics page"],
  ])('exempts the tool branch %s, naming its tool', (branch, tool) => {
    expect(checkBranch(branch)).toEqual({ ok: true, tool });
  });

  it.each([
    'dependabot',
    'xdependabot/npm/a',
    'release-please-branches--main',
    'lead/split-x',
    'lead/split-42-more',
    'kanon/upgrade',
    'kanon/pins',
    'kanon/metrics-page-2',
    'kanon/my-feature',
  ])('exempts nothing near a tool branch: %s', (branch) => {
    expect(checkBranch(branch).ok).toBe(false);
  });

  it('exempts only the tool branches it lists', () => {
    expect(TOOL_BRANCHES.map((t) => t.tool)).toEqual([
      'Dependabot',
      'release-please',
      "the Lead's split lane",
      "Kanon's upgrade skill",
      "Kanon's candidate pin pull request",
      "Kanon's metrics page",
    ]);
  });
});

describe('K-WS-8 the exempt tool branches are the ones the tools make', () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

  it("exempts the branch the Lead's split lane pushes to", () => {
    expect(checkBranch(splitBranch(42))).toEqual({ ok: true, tool: "the Lead's split lane" });
  });

  it("exempts the branch the upgrade skill tells the person to create", () => {
    expect(read('skills/upgrade/SKILL.md')).toContain('create the branch `kanon/upgrade-<the target>`');
    expect(checkBranch('kanon/upgrade-v1.2.3').ok).toBe(true);
  });

  it("exempts the branch the release workflow opens a candidate's pin pull request from", () => {
    expect(read('.github/workflows/release-please.yml')).toContain('branch="kanon/pins-$TAG"');
    expect(checkBranch('kanon/pins-candidate-v1.2.3').ok).toBe(true);
  });

  it('exempts the branch the metrics page is proposed from', () => {
    expect(read('.github/workflows/metrics-page.yml')).toContain('branch=kanon/metrics-page\n');
    expect(checkBranch('kanon/metrics-page').ok).toBe(true);
  });
});

const capture = () => {
  const out = { logs: [] as string[], errors: [] as string[] };
  return { out, sink: { log: (s: string) => out.logs.push(s), error: (s: string) => out.errors.push(s) } };
};

describe('K-SHIP-4 the check reports its result', () => {

  it('exits 0 and prints nothing to stderr on a valid title', () => {
    const { out, sink } = capture();
    expect(main('fix: a thing', sink)).toBe(0);
    expect(out.errors).toEqual([]);
  });

  it('exits 1 on an invalid title and prints every recognised type', () => {
    const { out, sink } = capture();
    expect(main('feature: a thing', sink)).toBe(1);
    const printed = out.errors.join('\n');
    expect(printed).toContain('feature: a thing');
    for (const type of Object.keys(TYPES)) expect(printed).toMatch(new RegExp(`\\b${type}\\b`));
  });
});

describe('K-WS-8 the check reports the branch name', () => {
  it('exits 0 on a valid title from a valid branch, and says it checked both', () => {
    const { out, sink } = capture();
    expect(main('fix: a thing', sink, 'fix/42-a-thing')).toBe(0);
    expect(out.errors).toEqual([]);
    expect(out.logs.join('\n')).toContain('Branch name OK: fix/42-a-thing');
  });

  it('exits 1 on a valid title from a misnamed branch, naming the branch and the rule', () => {
    const { out, sink } = capture();
    expect(main('fix: a thing', sink, 'fix/a-thing')).toBe(1);
    const printed = out.errors.join('\n');
    expect(printed).toContain('Branch "fix/a-thing" is not named');
    expect(printed).toContain('K-WS-8');
    expect(printed).toContain('Recognised types:');
  });

  it('reports both failures when the title and the branch are both wrong', () => {
    const { out, sink } = capture();
    expect(main('a thing', sink, 'a-thing')).toBe(1);
    const printed = out.errors.join('\n');
    expect(printed).toContain('PR title "a thing"');
    expect(printed).toContain('Branch "a-thing"');
  });

  it("passes a tool's branch, naming the tool", () => {
    const { out, sink } = capture();
    expect(main('ci(deps): bump kanon', sink, 'dependabot/github_actions/kanon-1')).toBe(0);
    expect(out.logs.join('\n')).toContain('Dependabot');
  });

  it('says so, and checks the title alone, when there is no branch to check', () => {
    const { out, sink } = capture();
    expect(main('fix: a thing', sink, '')).toBe(0);
    expect(out.logs.join('\n')).toContain('No branch to check');
    expect(main('fix: a thing', sink)).toBe(0);
  });
});
