import { describe, expect, it } from 'vitest';
import { REGISTER, TRIAGE, adopter, check, red, job, type Tree, laneCheck } from './helpers/lane-check.js';

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
      red((t) => t.edit(TRIAGE, (d) => { delete (job(d).secrets as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN; }), 'takes exactly [AUTHOR_APP_ID,AUTHOR_APP_PRIVATE_KEY,CLAUDE_CODE_OAUTH_TOKEN]'));
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
