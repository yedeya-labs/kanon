import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADOPTER, ROOT } from './helpers/adopter.js';

import { readVerdict } from '../../scripts/agent-quality-columns.mjs';
import { APP_OF, OTHER_APP, ROLES, appLogin, appLoginAtLoad, appShape, loadAppRegister, parseAppRegister, parseOtherApps, parsePersonas } from '../../scripts/app-register.mjs';

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
    expect(m.agentLogin()).toBe('example-implementer');
    expect(m.sweepLogin()).toBe('example-lead');
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
    expect((await import('../../scripts/review-run-evidence.mjs')).recoveryLogin()).toBe('example-lead');
    expect((await import('../../scripts/brief-revise-recovery.mjs')).LEAD_LOGIN).toBe('example-lead');
    expect((await import('../../scripts/lead-reconcile.mjs')).explorerLogin()).toBe('example-explorer');
  });

  // The fixture adopter's register cut to some of its rows: the Judge's (Reviewer, Merger), as a
  // review-only install has, or the Author's, as `kanon apps` leaves it after the Author App alone.
  const FIXTURE_REGISTER = readFileSync(join(ADOPTER, 'docs/qa/agent-identities.md'), 'utf8');
  const JUDGE_ONLY = ['Reviewer', 'Merger'];
  const AUTHOR_ONLY = ['Implementer', 'Lead', 'Explorer', 'Overseer'];
  /** A Merger row whose slug isn't one, which the register's parse refuses. */
  const MALFORMED = 'malformed';
  /** A temp directory whose register holds only `roles`' rows, a malformed register, or none at all. */
  const checkout = (roles: string[] | typeof MALFORMED | null) => {
    const dir = mkdtempSync(join(tmpdir(), 'partial-register-'));
    if (roles === null) return dir;
    if (roles === MALFORMED) {
      mkdirSync(join(dir, 'docs/qa'), { recursive: true });
      writeFileSync(join(dir, 'docs/qa/agent-identities.md'), FIXTURE_REGISTER.replace('| Merger | **`example-merger`**', '| Merger | `Example Merger!`'));
      expect(() => loadAppRegister(join(dir, 'docs/qa/agent-identities.md'))).toThrow(/App slug .* is malformed/);
      return dir;
    }
    const kept = FIXTURE_REGISTER.split('\n').filter((l) => !/^\| [A-Z][a-z]+ \| /.test(l) || l.startsWith('| Role |') || roles.some((r) => l.startsWith(`| ${r} |`)));
    mkdirSync(join(dir, 'docs/qa'), { recursive: true });
    writeFileSync(join(dir, 'docs/qa/agent-identities.md'), kept.join('\n'));
    expect(parseAppRegister(kept.join('\n')).size).toBe(roles.length);
    return dir;
  };

  // Loading is soft so the status core can run where there is no checkout, and `kanon` where the
  // register lists only some roles; running the lane asserts its logins first, so it fails as it
  // did when they were read at load.
  it.each([
    ['merge-gate', null, /App register docs\/qa\/agent-identities\.md is unreadable/],
    ['review-recovery', null, /App register docs\/qa\/agent-identities\.md is unreadable/],
    ['rebase-lane', null, /App register docs\/qa\/agent-identities\.md is unreadable/],
    ['merge-gate', JUDGE_ONLY, /lists no Implementer App/],
    ['review-recovery', AUTHOR_ONLY, /lists no Reviewer App/],
    ['rebase-lane', JUDGE_ONLY, /lists no Implementer App/],
    ['merge-gate', MALFORMED, /App slug .* is malformed/],
    ['review-recovery', MALFORMED, /App slug .* is malformed/],
    ['rebase-lane', MALFORMED, /App slug .* is malformed/],
  ] as const)('%s loads with the register %j, and its lane still stops before it reads anything (kanon#1396)', (lane, roles, error) => {
    const dir = checkout(roles === null || roles === MALFORMED ? roles : [...roles]);
    const before = readdirSync(dir);
    const file = join(ROOT, `scripts/${lane}.mjs`);
    const loaded = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(file)}); console.log('loaded');`], { cwd: dir, encoding: 'utf8' });
    expect(loaded.stderr).toBe('');
    expect(loaded.stdout.trim()).toBe('loaded');
    const ran = spawnSync(process.execPath, [file], { cwd: dir, encoding: 'utf8', env: { PATH: '', HOME: dir } });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toMatch(error);
    expect(ran.stdout).toBe('');
    expect(readdirSync(dir)).toEqual(before);
  });

  it.each([['holds only the Judge\'s rows', JUDGE_ONLY], ['is malformed', MALFORMED]] as const)('`kanon` runs a command, and `kanon status --project`, in a checkout whose register %s (kanon#1396)', (_, roles) => {
    // `kanon` loads the status core, and with it the merge gate, whatever the command. A
    // review-only install's register has no Implementer row, and a malformed one is what
    // `kanon doctor` reports: neither may stop the command at import.
    const dir = checkout(roles === MALFORMED ? roles : [...roles]);
    const kanon = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'cli/kanon.mjs'), ...args], { cwd: dir, encoding: 'utf8', env: { PATH: '', HOME: dir } });
    const doctor = kanon('doctor', '--help');
    expect(doctor.stderr).toBe('');
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toMatch(/^Usage: kanon doctor/);
    // No `gh` on PATH, so the project view's first read fails: the command loaded, ran and
    // answered with that view's error, rather than stopping at import on the register.
    const project = kanon('status', '--project', '7', '--repo', 'acme/shop', '--json');
    expect(project.stderr).not.toMatch(/App register/);
    expect(project.status).toBe(4);
    const doc = JSON.parse(project.stdout);
    expect(doc).toMatchObject({ schema: 'kanon-status/v1', status: 'incomplete', repo: 'acme/shop' });
    expect(doc.project.error).toMatch(/project #7 couldn't be read whole.*gh ENOENT/);
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

// Issue #990 (decision 22 of docs/projects/902.md): `K-AGENT-3` asks for every App installed on the
// repository, agent or not, so an App with no role of Kanon's has a row under the `Other App` role.
describe('parseAppRegister — Apps that are not agents (docs/qa/specs/app-register.md)', () => {
  const AGENTS = ['| Implementer | `o-author` | x |', '| Lead | `o-author` | x |', '| Reviewer | `o-judge` | x |', '| Releaser | `o-releaser` | x |', '| Intake | `o-intake` | x |'];
  const OTHERS = ['| Other App | `o-reporter` | x |', '| **Other App** | **`o-scanner`** | y |'];

  it('[REG-1] accepts several Other App rows, each its own slug, and reads every agent role\'s row as before', () => {
    const plain = parseAppRegister(table(...AGENTS));
    // Interleaved, so a row is read by its role, never by where it sits.
    const text = table(AGENTS[0]!, OTHERS[0]!, ...AGENTS.slice(1), OTHERS[1]!);
    const withOthers = parseAppRegister(text);
    expect(Object.fromEntries(withOthers)).toEqual(Object.fromEntries(plain));
    expect(appShape(withOthers)).toEqual([]);
    expect(parseOtherApps(text)).toEqual(['o-reporter', 'o-scanner']);
    expect(parseOtherApps(table(...AGENTS))).toEqual([]);
    expect(parsePersonas(text).size).toBe(0);
  });

  it('[REG-1] reads a register whose only rows are Other App rows', () => {
    const text = table(...OTHERS);
    expect(parseAppRegister(text).size).toBe(0);
    expect(parseOtherApps(text)).toEqual(['o-reporter', 'o-scanner']);
  });

  it('names the role in the list a wrong role\'s message gives, and gives an Other App row no persona', () => {
    expect(OTHER_APP).toBe('Other App');
    expect(() => parseAppRegister(table('| Others | `a` | x |'), 'reg.md')).toThrow(/is not a role\. The first column is one of: .*Intake, Other App\./);
    expect(() => parsePersonas('| Role | App slug | Persona |\n|---|---|---|\n| Other App | `a` | Bob |\n')).toThrow(/only an agent role has one/);
  });

  const refuses = (text: string, why: RegExp) => {
    expect(() => parseAppRegister(text, 'reg.md')).toThrow(why);
    expect(() => parseOtherApps(text, 'reg.md')).toThrow(why);
  };

  it('[REG-2] refuses an Other App row naming an agent App\'s slug, in either order, naming both rows', () => {
    refuses(table('| Lead | `o-author` | x |', '| Other App | `o-author` | y |'), /reg\.md:4: the Other App row names `o-author`, the App the Lead row names \(reg\.md:3\)/);
    refuses(table('| Other App | `o-judge` | x |', '| Reviewer | `o-judge` | y |'), /reg\.md:4: the Reviewer row names `o-judge`, the App the Other App row names \(reg\.md:3\)/);
  });

  it('refuses an Other App row naming the Releaser\'s or the Intake App\'s slug, or another Other App row\'s', () => {
    refuses(table('| Releaser | `r` | x |', '| Other App | `r` | y |'), /reg\.md:4: the Other App row names `r`, the App the Releaser row names \(reg\.md:3\)/);
    refuses(table('| Other App | `i` | x |', '| Intake | `i` | y |'), /reg\.md:4: the Intake row names `i`, the App the Other App row names \(reg\.md:3\)/);
    refuses(table('| Other App | `a` | x |', '| Lead | `l` | x |', '| Other App | `a` | y |'), /reg\.md:5: the Other App row names `a`, the App the Other App row names \(reg\.md:3\)/);
  });

  it('refuses a malformed Other App slug, like any row\'s', () => refuses(table('| Other App | `Bad_Slug` | x |'), /reg\.md:3: the Other App row's App slug .* is malformed/));
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

  it('appLoginAtLoad gives `undefined` for an absent register or role and for a malformed register, where appLogin throws (kanon#1396)', () => {
    expect(appLoginAtLoad('Lead', join(dir, 'absent.md'))).toBeUndefined();
    const ok = join(dir, 'at-load.md');
    writeFileSync(ok, table('| Lead | `example-lead` | x |'));
    expect(appLoginAtLoad('Lead', ok)).toBe('example-lead');
    expect(appLoginAtLoad('Reviewer', ok), 'a register that lists no such role').toBeUndefined();
    const bad = join(dir, 'at-load-bad.md');
    writeFileSync(bad, '# no table\n');
    expect(appLoginAtLoad('Lead', bad), 'a malformed register').toBeUndefined();
    expect(() => appLogin('Lead', bad), 'which appLogin, behind every read, still refuses').toThrow(/no App register table/);
  });
});

describe('agent-quality-columns reads the reviewer from the register', () => {
  it('filters on the Reviewer row by default', () => {
    let argv: string[] = [];
    readVerdict({ pr: '1', head: 'abc' }, (a: string[]) => { argv = a; return ''; });
    expect(argv.join(' ')).toContain('startswith("example-reviewer")');
  });
});
