import { describe, expect, it } from 'vitest';
import { checkTitle, main, TYPES } from '../../actions/pr-title/pr-title.mjs';

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

describe('K-SHIP-4 the check reports its result', () => {
  const capture = () => {
    const out = { logs: [] as string[], errors: [] as string[] };
    return { out, sink: { log: (s: string) => out.logs.push(s), error: (s: string) => out.errors.push(s) } };
  };

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
