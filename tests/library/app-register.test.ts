import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readVerdict } from '../../scripts/agent-quality-columns.mjs';
import { APP_OF, ROLES, appLogin, appShape, loadAppRegister, parseAppRegister } from '../../scripts/app-register.mjs';

/**
 * RA-2701 (Kanon move plan P4) — the bot logins every pipeline script compares against are
 * read from the App register, `docs/qa/agent-identities.md`, not restated as constants.
 *
 * Two halves. The REGISTER's own parse, against every malformation the parser promises to
 * refuse — a register that degrades to "no login matches" is the silent, act-toward-human
 * failure `isBot()` already has, so each one must throw. And the CONSUMERS: every exported
 * login is the one the register lists, read here from the fixture adopter's register.
 *
 * KANON'S HALF (plan 0001, step 3). The reference adopter keeps the half that pins its own register's slugs, and its review lane's base-extracted import list.
 */

const table = (...rows: string[]) =>
  ['| Role | App slug | What it does |', '|---|---|---|', ...rows].join('\n') + '\n';

describe('every consumer reads the login it compared before the move', () => {
  // The fixture adopter's register (tests/fixtures/adopter), which every library test runs in.
  it('dispatch-sweep', async () => {
    const m = await import('../../scripts/dispatch-sweep.mjs');
    expect(m.AGENT_LOGIN).toBe('example-implementer');
    expect(m.SWEEP_LOGIN).toBe('example-lead');
    // `BOT_LOGINS` is the six project Apps it always named plus GitHub's two — and NOT
    // the Merger or the Intake App, which the move deliberately did not add.
    const bots = ['example-implementer', 'example-lead', 'example-reviewer', 'example-explorer',
      'example-overseer', 'example-releaser', 'github-actions', 'dependabot'];
    for (const b of bots) expect(m.isBot(b), b).toBe(true);
    for (const h of ['example-merger', 'example-intake', 'a-human']) expect(m.isBot(h), h).toBe(false);
  });

  it('rebase-lane, merge-gate, review-recovery, review-run-evidence, brief-revise-recovery, lead-reconcile', async () => {
    expect((await import('../../scripts/rebase-lane.mjs')).IMPLEMENTER_LOGIN).toBe('example-implementer');
    const gate = await import('../../scripts/merge-gate.mjs');
    expect(gate.IMPLEMENTER_LOGIN).toBe('example-implementer');
    expect(gate.MERGER_LOGIN).toBe('example-merger');
    expect(gate.REVIEWER_LOGIN).toBe('example-reviewer');
    expect((await import('../../scripts/review-recovery.mjs')).REVIEWER_LOGIN).toBe('example-reviewer');
    expect((await import('../../scripts/review-run-evidence.mjs')).RECOVERY_LOGIN).toBe('example-lead');
    expect((await import('../../scripts/brief-revise-recovery.mjs')).LEAD_LOGIN).toBe('example-lead');
    expect((await import('../../scripts/lead-reconcile.mjs')).EXPLORER_LOGIN).toBe('example-explorer');
  });

  it('incremental-review matches the reviewer by exact login, decorated or not, and nothing else', async () => {
    const { reviewerVerdicts } = await import('../../scripts/incremental-review.mjs');
    const { headerLine } = await import('../../scripts/lib/role-marker.mjs');
    // Each carries the Reviewer's marker, so only the login decides here (plan 0005 §3.3).
    const review = (login: string) => ({ id: 1, user: { login }, state: 'APPROVED', submitted_at: '2026-01-01T00:00:00Z', body: headerLine('Reviewer') });
    for (const login of ['example-reviewer', 'example-reviewer[bot]']) expect(reviewerVerdicts([review(login)]), login).toHaveLength(1);
    for (const login of ['example-reviewer-x', 'app/example-reviewer', 'example-lead']) expect(reviewerVerdicts([review(login)]), login).toHaveLength(0);
  });
});

describe('parseAppRegister — the accepted shape', () => {
  it('reads role → slug, ignoring bold and any further columns', () => {
    const r = parseAppRegister(table('| Lead | **`example-lead`** | x |', '| **Reviewer** | `example-reviewer` | y |'));
    expect(Object.fromEntries(r)).toEqual({ Lead: 'example-lead', Reviewer: 'example-reviewer' });
  });

  it('ignores a register-shaped table inside a code fence — an example is not the register', () => {
    const text = ['```text', table('| Lead | `example-app` | x |').trimEnd(), '```', '', table('| Lead | `example-lead` | x |')].join('\n');
    expect(parseAppRegister(text).get('Lead')).toBe('example-lead');
  });

  it('ends the table at the first line that is not a row', () => {
    const text = table('| Lead | `example-lead` | x |') + '\nprose\n| Nonsense | not a row of the register |\n';
    expect(parseAppRegister(text).size).toBe(1);
  });

  it('covers every role Kanon names that runs under, or is, an App', () => {
    expect([...ROLES]).toEqual(['Explorer', 'Implementer', 'Reviewer', 'Merger', 'Lead', 'Overseer', 'Releaser', 'Intake']);
  });
});

describe('parseAppRegister — the two Apps and the Releaser (plan 0005 §3.4)', () => {
  it('reads one row per role, the Author\'s four sharing a slug, the Judge\'s two another, the Releaser\'s a third', () => {
    const r = parseAppRegister(table(
      '| Implementer | `o-author` | x |', '| Lead | `o-author` | x |', '| Explorer | `o-author` | x |', '| Overseer | `o-author` | x |',
      '| Reviewer | `o-judge` | x |', '| Merger | `o-judge` | x |', '| Releaser | `o-releaser` | x |',
    ));
    expect(Object.fromEntries(r)).toEqual({
      Implementer: 'o-author', Lead: 'o-author', Explorer: 'o-author', Overseer: 'o-author',
      Reviewer: 'o-judge', Merger: 'o-judge', Releaser: 'o-releaser',
    });
  });

  it('reads, and appShape reports, an App whose roles name two slugs: lane-check fails it, a lane does not crash on it', () => {
    const per = parseAppRegister(table('| Implementer | `a` | x |', '| Lead | `b` | y |', '| Reviewer | `j` | x |', '| Merger | `k` | y |', '| Releaser | `r` | y |'));
    expect(per.get('Lead')).toBe('b');
    expect(appShape(per)).toEqual([
      expect.stringMatching(/^the Author's roles name 2 App slugs \(Implementer `a`, Lead `b`\): one App, one slug/),
      expect.stringMatching(/^the Judge's roles name 2 App slugs \(Reviewer `j`, Merger `k`\)/),
    ]);
    expect(appShape(parseAppRegister(table('| Implementer | `a` | x |', '| Lead | `a` | y |', '| Intake | `i` | y |')))).toEqual([]);
  });

  it('reads the Apps each role belongs to from agent-permissions.json\'s apps block', () => {
    expect(APP_OF).toEqual({
      Implementer: 'Author', Lead: 'Author', Explorer: 'Author', Overseer: 'Author',
      Reviewer: 'Judge', Merger: 'Judge', Releaser: 'Releaser',
    });
  });
});

describe('parseAppRegister — fails loudly', () => {
  const refuses = (text: string, why: RegExp) => expect(() => parseAppRegister(text, 'reg.md')).toThrow(why);

  it('on no register table at all', () => refuses('# nothing\n\n| App | What |\n|---|---|\n| `x` | y |\n', /no App register table/));
  it('on a register table only inside a fence', () => refuses(['```', table('| Lead | `a` | x |').trimEnd(), '```'].join('\n'), /no App register table/));
  it('on two register tables', () => refuses(table('| Lead | `a` | x |') + '\n' + table('| Reviewer | `b` | y |'), /2 App register tables .*reg\.md:1, reg\.md:5/));
  it('on a header with no delimiter row', () => refuses('| Role | App slug |\n| Lead | `a` |\n', /reg\.md:2: .*delimiter/));
  it('on an empty table', () => refuses(table(), /has no rows/));
  it('on a role that is not one of Kanon’s', () => refuses(table('| Triage | `a` | x |'), /reg\.md:3: `Triage` is not a role/));
  it('on a slug without backticks', () => refuses(table('| Lead | example-lead | x |'), /reg\.md:3: the Lead row's App slug .* is malformed/));
  it('on a slug GitHub would not derive (uppercase, spaces, underscores, edge hyphens)', () => {
    for (const bad of ['`Example-lead`', '`example lead`', '`example_lead`', '`-example`', '`example--lead`', '``']) {
      refuses(table(`| Lead | ${bad} | x |`), /malformed/);
    }
  });
  it('on a role listed twice', () => refuses(table('| Lead | `a` | x |', '| Lead | `b` | y |'), /reg\.md:4: role Lead is listed twice \(also reg\.md:3\)/));
  // Plan 0005 §3.4 (L4): roles share a slug only within one of the Author, the Judge and the Releaser.
  it('on the Author and the Judge sharing a slug, which would let an App approve what it authored', () =>
    refuses(table('| Lead | `a` | x |', '| Reviewer | `a` | y |'), /reg\.md:4: the Reviewer row names `a`, the App the Lead row names \(reg\.md:3\), but the Reviewer belongs to the Judge and the Lead to the Author/));
  it('on the Releaser sharing a slug with the Author or the Judge', () => {
    refuses(table('| Implementer | `a` | x |', '| Releaser | `a` | y |'), /but the Releaser belongs to the Releaser and the Implementer to the Author/);
    refuses(table('| Releaser | `r` | x |', '| Merger | `r` | y |'), /the Merger belongs to the Judge and the Releaser to the Releaser/);
  });
  it('on a role outside the three Apps sharing a slug', () =>
    refuses(table('| Intake | `i` | x |', '| Lead | `i` | y |'), /the Lead belongs to the Author and the Intake to no App of Kanon's three/));
});

describe('appLogin / loadAppRegister', () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-register-'));

  it('returns the role’s slug from the register at the given path', () => {
    const path = join(dir, 'ok.md');
    writeFileSync(path, table('| Lead | `example-lead` | x |'));
    expect(appLogin('Lead', path)).toBe('example-lead');
  });

  it('throws — never returns a non-matching value — for a role the register does not list', () => {
    const path = join(dir, 'partial.md');
    writeFileSync(path, table('| Lead | `example-lead` | x |'));
    expect(() => appLogin('Reviewer', path)).toThrow(/lists no Reviewer App/);
  });

  it('throws, naming the path, when the register is missing', () => {
    expect(() => loadAppRegister(join(dir, 'absent.md'))).toThrow(/App register .*absent\.md is unreadable/);
  });

  it('throws when the register is malformed, before any lookup', () => {
    const path = join(dir, 'bad.md');
    writeFileSync(path, '# no table\n');
    expect(() => appLogin('Lead', path)).toThrow(/no App register table/);
  });
});

describe('agent-quality-columns reads the reviewer from the register', () => {
  it('filters on the Reviewer row by default', () => {
    let argv: string[] = [];
    readVerdict({ pr: '1', head: 'abc' }, (a: string[]) => { argv = a; return ''; });
    expect(argv.join(' ')).toContain('startswith("example-reviewer")');
  });
});
