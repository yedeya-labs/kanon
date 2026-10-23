import { describe, expect, it } from 'vitest';
import { coveringRulesets, readCovering } from '../../cli/ruleset-bypass.mjs';

/**
 * Which branch rulesets cover the default branch (#1262). GitHub answers that itself:
 * `GET repos/<repo>/rules/branches/<branch>` returns every active rule that applies to the branch,
 * from rulesets at every level, each with its `ruleset_id`. Kanon matches no ref pattern, so a
 * ruleset GitHub applies through a glob counts, one whose `exclude` leaves the branch out
 * doesn't, and one it names but that can't be read is reported, never dropped.
 *
 * The four fixtures are the issue's. Each stub answers as GitHub does for its ruleset: the rules
 * endpoint lists the rules of the rulesets that apply, and nothing else.
 */
const REPO = 'acme/widgets';
const RULES = `repos/${REPO}/rules/branches/main?per_page=100`;
type Res = { status: number | null; stdout: string; stderr: string };
const ok = (json: unknown): Res => ({ status: 0, stdout: JSON.stringify(json), stderr: '' });
const no = (stderr: string): Res => ({ status: 1, stdout: '', stderr });

const ruleset = (id: number, name: string, include: string[], exclude: string[] = []) => ({
  id, name, target: 'branch', enforcement: 'active', source_type: 'Repository', source: REPO,
  conditions: { ref_name: { include, exclude } }, rules: [{ type: 'deletion' }],
});
const GLOB = ruleset(1, 'glob', ['refs/heads/**/*']);
const STAR = ruleset(2, 'star', ['refs/heads/*']);
const ALL_MINUS_MAIN = ruleset(3, 'all-minus-main', ['~ALL'], ['refs/heads/main']);
const UNREADABLE = ruleset(4, 'org-main', ['~DEFAULT_BRANCH']);
const FIXTURES = [GLOB, STAR, ALL_MINUS_MAIN, UNREADABLE];
const listOf = (rs: typeof FIXTURES) => rs.map((r) => ({ id: r.id, name: r.name, target: r.target }));

/** GitHub as it answers for these four: it applies glob, star and the unreadable one to main, and not all-minus-main; the unreadable one's GET fails. */
const gh = () => async (args: string[]): Promise<Res> => {
  if (args.join(' ') === `api --paginate --slurp ${RULES}`) {
    return ok([[GLOB, STAR, UNREADABLE].map((r) => ({ type: 'deletion', ruleset_source_type: 'Repository', ruleset_source: REPO, ruleset_id: r.id }))]);
  }
  const one = /^repos\/acme\/widgets\/rulesets\/(\d+)$/.exec(args[1] ?? '');
  if (args[0] === 'api' && one) return Number(one[1]) === UNREADABLE.id ? no('gh: Server Error (HTTP 502)') : ok(FIXTURES.find((r) => r.id === Number(one[1])));
  return no(`unexpected gh ${args.join(' ')}`);
};

describe('coveringRulesets asks GitHub which rulesets apply to the default branch (#1262)', () => {
  it('counts a ruleset that covers it through refs/heads/**/*', async () => {
    expect((await coveringRulesets(gh(), REPO, listOf(FIXTURES), 'main')).covering.map((r) => r.name)).toContain('glob');
  });

  it('counts a ruleset that covers it through refs/heads/*', async () => {
    expect((await coveringRulesets(gh(), REPO, listOf(FIXTURES), 'main')).covering.map((r) => r.name)).toContain('star');
  });

  it('does not count ~ALL with refs/heads/main excluded', async () => {
    expect((await coveringRulesets(gh(), REPO, listOf(FIXTURES), 'main')).covering.map((r) => r.name)).not.toContain('all-minus-main');
  });

  it('reports a ruleset that applies but could not be read, with its id, name and why', async () => {
    expect((await coveringRulesets(gh(), REPO, listOf(FIXTURES), 'main')).unreadable).toEqual([
      { id: 4, name: 'org-main', why: 'gh: Server Error (HTTP 502)', source_type: 'Repository', source: REPO },
    ]);
  });

  it('reports every branch ruleset as unreadable when the rules for the branch could not be read, and counts none', async () => {
    const r = await coveringRulesets(async () => no('gh: Server Error (HTTP 503)'), REPO, listOf([GLOB, STAR]), 'main');
    expect(r).toEqual({
      covering: [],
      inactive: [],
      unreadable: [GLOB, STAR].map((x) => ({ id: x.id, name: x.name, why: 'could not read the rules that apply to main (gh: Server Error (HTTP 503))' })),
    });
  });

  it('readCovering returns the unreadable ones beside the covering ones', async () => {
    const base = gh();
    const r = await readCovering(async (args) => (args[1] === `repos/${REPO}` ? ok({ default_branch: 'main' }) : args[1]?.startsWith(`repos/${REPO}/rulesets?`) ? ok(listOf(FIXTURES)) : base(args)), REPO);
    expect(r).toMatchObject({ defaultBranch: 'main', covering: [{ name: 'glob' }, { name: 'star' }], unreadable: [{ id: 4, name: 'org-main' }] });
  });
});
