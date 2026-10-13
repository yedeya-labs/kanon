import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REGISTER, ROOT, TRIAGE, adopter, check, red, job, type Tree, laneCheck } from './helpers/lane-check.js';

/**
 * `actions/lane-check` (plan 0001 §6): the secrets a calling job maps, and plan 0005's two Apps by
 * their secrets and the register.
 *
 * One of the lane-check files split by area (kanon#381); `tests/unit/helpers/lane-check.ts`
 * says how every case runs and holds the helpers they share.
 */
laneCheck(() => {
  describe('the calling job maps exactly the lane\'s secrets, explicitly', () => {
    it('refuses `secrets: inherit` (decision 7)', () =>
      red((t) => t.edit(TRIAGE, (d) => { job(d).secrets = 'inherit'; }), 'maps no secrets explicitly'));
    it('refuses a missing secret', () =>
      red((t) => t.edit(TRIAGE, (d) => { delete (job(d).secrets as Record<string, string>).AUTHOR_APP_ID; }), 'takes exactly [ANTHROPIC_API_KEY,AUTHOR_APP_ID,AUTHOR_APP_PRIVATE_KEY,CLAUDE_CODE_OAUTH_TOKEN], and may leave out [ANTHROPIC_API_KEY,CLAUDE_CODE_OAUTH_TOKEN]'));
    it('refuses a secret under a name the lane does not take', () =>
      red((t) => t.edit(TRIAGE, (d) => { (job(d).secrets as Record<string, string>).QA_TRIAGE_APP_ID = '${{ secrets.QA_TRIAGE_APP_ID }}'; }), 'the Kanon lane agent-triage takes exactly'));
    it('refuses a secret mapped to anything but one repository secret', () =>
      red((t) => t.edit(TRIAGE, (d) => { (job(d).secrets as Record<string, string>).AUTHOR_APP_ID = '${{ github.token }}'; }), 'map each one to a single repository secret'));
    it('accepts a secret mapped from another repository secret, as during the renaming (§8)', () => {
      const t = adopter();
      t.edit(TRIAGE, (d) => { (job(d).secrets as Record<string, string>).AUTHOR_APP_ID = '${{ secrets.QA_TRIAGE_APP_ID }}'; });
      expect(check(t).status).toBe(0);
    });
  });

  // Plan 0009 §10, steps A2 and A3: a lane's `# ONE OF SECRETS:` line names the Claude credential
  // pair, which the lane declares optional. A caller maps exactly one of the two: the token, as
  // every caller did, or an API key in its place; both or neither is a red that names the lane,
  // the caller and the two secrets, and never a value.
  describe('the calling job maps exactly one of a `# ONE OF SECRETS:` pair (plan 0009 A3)', () => {
    const secretsOf = (d: Record<string, unknown>) => job(d).secrets as Record<string, string>;
    const KEY = '${{ secrets.ANTHROPIC_API_KEY }}';
    it('accepts a caller that maps the Claude token alone', () => {
      const r = check(adopter());
      expect(r.status, r.out).toBe(0);
    });
    it('accepts a caller that maps an API key alone, in the token\'s place', () => {
      const t = adopter();
      t.edit(TRIAGE, (d) => { delete secretsOf(d).CLAUDE_CODE_OAUTH_TOKEN; secretsOf(d).ANTHROPIC_API_KEY = KEY; });
      const r = check(t);
      expect(r.status, r.out).toBe(0);
    });
    it('refuses a caller that maps both, naming the lane, the caller and the two secrets', () => {
      const r = red((t) => t.edit(TRIAGE, (d) => { secretsOf(d).ANTHROPIC_API_KEY = KEY; }),
        '::error file=.github/workflows/agent-triage.yml,title=lane-check::maps both `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`; the Kanon lane agent-triage takes exactly one of `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`');
      expect(r.out.match(/::error/g)).toHaveLength(1);
      expect(r.out).not.toContain('secrets.ANTHROPIC_API_KEY');
    });
    it('refuses a caller that maps neither, naming the lane, the caller and the two secrets', () => {
      const r = red((t) => t.edit(TRIAGE, (d) => { delete secretsOf(d).CLAUDE_CODE_OAUTH_TOKEN; }),
        '::error file=.github/workflows/agent-triage.yml,title=lane-check::maps neither of the pair; the Kanon lane agent-triage takes exactly one of `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`');
      expect(r.out.match(/::error/g)).toHaveLength(1);
    });

    // An old lane, one from before step A2: no marker, the token required and no key declared.
    // It keeps today's rule, exactly the declared secrets, so the pair rule asks nothing of it.
    const roots: string[] = [];
    afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });
    const oldKanon = () => {
      const dir = mkdtempSync(join(tmpdir(), 'kanon-old-lane-'));
      roots.push(dir);
      for (const e of readdirSync(ROOT)) if (e !== '.github') symlinkSync(join(ROOT, e), join(dir, e));
      mkdirSync(join(dir, '.github/workflows'), { recursive: true });
      for (const e of readdirSync(join(ROOT, '.github'))) if (e !== 'workflows') symlinkSync(join(ROOT, '.github', e), join(dir, '.github', e));
      for (const e of readdirSync(join(ROOT, '.github/workflows'))) if (e !== 'agent-triage.yml') symlinkSync(join(ROOT, '.github/workflows', e), join(dir, '.github/workflows', e));
      const lane = readFileSync(join(ROOT, '.github/workflows/agent-triage.yml'), 'utf8');
      const old = lane
        .replace(/^# ONE OF SECRETS: .*\n/m, '')
        .replace(/( {6}CLAUDE_CODE_OAUTH_TOKEN:\n {8}required: )false\n {6}ANTHROPIC_API_KEY:\n {8}required: false\n/, '$1true\n');
      expect(old).not.toContain('ONE OF SECRETS');
      expect(old).not.toMatch(/^ {6}ANTHROPIC_API_KEY:/m);
      writeFileSync(join(dir, '.github/workflows/agent-triage.yml'), old);
      return dir;
    };
    it('holds a caller of an old lane, with no marker, to today\'s rule: the token it declares', () => {
      const kanon = oldKanon();
      const r = check(adopter(), { KANON_ROOT: kanon });
      expect(r.status, r.out).toBe(0);
      const t = adopter();
      t.edit(TRIAGE, (d) => { delete secretsOf(d).CLAUDE_CODE_OAUTH_TOKEN; secretsOf(d).ANTHROPIC_API_KEY = KEY; });
      const k = check(t, { KANON_ROOT: kanon });
      expect(k.status, k.out).toBe(1);
      expect(k.out).toContain('the Kanon lane agent-triage takes exactly [AUTHOR_APP_ID,AUTHOR_APP_PRIVATE_KEY,CLAUDE_CODE_OAUTH_TOKEN]');
      expect(k.out).not.toContain('ONE OF SECRETS');
    });
  });

  describe('plan 0005 L4: the two Apps, by their secrets and the register (§3.4, §3.5)', () => {
    const rename = (t: Tree) => t.edit(TRIAGE, (d) => {
      const sec = job(d).secrets as Record<string, string>;
      delete sec.AUTHOR_APP_ID; delete sec.AUTHOR_APP_PRIVATE_KEY;
      sec.IMPLEMENTER_APP_ID = '${{ secrets.IMPLEMENTER_APP_ID }}';
      sec.IMPLEMENTER_APP_PRIVATE_KEY = '${{ secrets.IMPLEMENTER_APP_PRIVATE_KEY }}';
    });
    it('fails a caller mapping a role-named secret, naming the Author\'s it takes instead', () =>
      red(rename, 'maps the role-named secret `IMPLEMENTER_APP_ID`; since plan 0005\'s two Apps the lane takes `AUTHOR_APP_ID` (the Author App\'s)'));
    it('names the Judge\'s for a Reviewer or Merger secret', () =>
      red((t) => t.edit(TRIAGE, (d) => { (job(d).secrets as Record<string, string>).MERGER_APP_ID = '${{ secrets.MERGER_APP_ID }}'; }), 'takes `JUDGE_APP_ID` (the Judge App\'s)'));
    const rows = (t: Tree, extra: string) => t.write(REGISTER, `${t.read(REGISTER)}${extra}`);
    it('fails a register whose Author roles name two slugs', () =>
      red((t) => rows(t, '| Explorer | `example-explorer` | Read | Read & write | Read | No access |\n'),
        /the Author's roles name 2 App slugs \(Implementer `example-author`, Lead `example-author`, Explorer `example-explorer`\)/));
    it('fails a register whose Judge roles name two slugs', () =>
      red((t) => rows(t, '| Reviewer | `example-judge` | x | x | x | x |\n| Merger | `example-merger` | x | x | x | x |\n'), /the Judge's roles name 2 App slugs/));
    it('fails a register in which the Author and the Judge share a slug: the self-approval case', () =>
      red((t) => rows(t, '| Reviewer | `example-author` | x | x | x | x |\n'), /the Reviewer row names `example-author`, the App the Implementer row names .*, but the Reviewer belongs to the Judge and the Implementer to the Author/));
    it('fails a register in which the Releaser shares a slug with another App', () =>
      red((t) => rows(t, '| Releaser | `example-author` | x | x | x | x |\n'), /the Releaser belongs to the Releaser and the Implementer to the Author/));
    it('passes the Author\'s four rows on one slug, the Judge\'s two on another and the Releaser on a third', () => {
      const t = adopter();
      rows(t, '| Explorer | `example-author` | x | x | x | x |\n| Overseer | `example-author` | x | x | x | x |\n| Reviewer | `example-judge` | x | x | x | x |\n| Merger | `example-judge` | x | x | x | x |\n| Releaser | `example-releaser` | x | x | x | x |\n');
      const r = check(t);
      expect(r.status, r.out).toBe(0);
    });
  });
});
