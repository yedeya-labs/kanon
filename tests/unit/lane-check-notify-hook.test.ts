import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ROOT, TRIAGE, adopter, check, red, laneCheck, type Tree } from './helpers/lane-check.js';

/**
 * `actions/lane-check`: the notify hook's pin of Kanon's prebuilt hook (plan 0011 decision 18,
 * kanon#955). The hook's pin follows the callers', so one behind them, at a release that still
 * writes a contract version the hook declares, is no failure: doctor notes it as
 * `notify.hook-pin-behind`, and lane-check passes it with a notice. One ahead of the callers, or
 * behind them at a release whose contract version the callers' release no longer writes, still
 * fails, and so does a pin that isn't an exact version.
 *
 * One of the lane-check files split by area (kanon#381); `tests/unit/helpers/lane-check.ts`
 * says how every case runs and holds the helpers they share.
 */
laneCheck(() => {
  describe("the notify hook's pin of a prebuilt hook follows the callers' (plan 0011 decision 18)", () => {
    const HOOK = '.github/actions/notify/action.yml';
    /** Kanon's prebuilt hook `name` as `kanon init` writes it, pinned at `tag`. */
    const hook = (name: 'slack' | 'webhook', tag: string) => (t: Tree) => {
      const text = readFileSync(join(ROOT, `actions/notify/hooks/${name}.yml`), 'utf8');
      expect(text).toMatch(new RegExp(`yedeya-labs/kanon/actions/notify/${name}@v\\d+\\.\\d+\\.\\d+`));
      mkdirSync(join(t.dir, '.github/actions/notify'), { recursive: true });
      t.write(HOOK, text.replace(new RegExp(`(yedeya-labs/kanon/actions/notify/${name})@v\\d+\\.\\d+\\.\\d+`), `$1@${tag}`));
    };
    /** lane-check at the fixture's pin, as the action runs at the version the callers pin. */
    const AT = { ACTION_REF: 'v1.2.3' };

    for (const name of ['slack', 'webhook'] as const) {
      it(`accepts Kanon's ${name} hook pinned behind the callers, at a release that still writes the version it declares`, () => {
        const t = adopter();
        hook(name, 'v1.2.2')(t);
        const r = check(t, AT);
        expect(r.status, r.out).toBe(0);
        expect(r.out).toContain(`::notice file=${HOOK},title=lane-check::pins Kanon's ${name} hook at v1.2.2, behind the callers' v1.2.3`);
        expect(r.out).not.toContain('pin v1.2.2,v1.2.3');
      });
      it(`refuses Kanon's ${name} hook pinned ahead of the callers`, () =>
        red(hook(name, 'v1.2.4'), `${HOOK},title=lane-check::pins Kanon's ${name} hook at v1.2.4, ahead of the callers' v1.2.3`, AT));
    }

    it("accepts the hook at the callers' pin, and says nothing of it", () => {
      const t = adopter();
      hook('slack', 'v1.2.3')(t);
      const r = check(t, AT);
      expect(r.status, r.out).toBe(0);
      expect(r.out).not.toContain(HOOK);
    });
    it('compares the versions, not the strings: v1.2.10 is ahead of v1.2.3, and v1.1.9 behind it', () => {
      red(hook('slack', 'v1.2.10'), "ahead of the callers' v1.2.3", AT);
      const t = adopter();
      hook('slack', 'v1.1.9')(t);
      expect(check(t, AT).status).toBe(0);
    });
    it('refuses a candidate ahead of the callers', () =>
      red(hook('slack', 'candidate-v1.2.4'), "pins Kanon's slack hook at candidate-v1.2.4, ahead of the callers' v1.2.3", AT));
    it('still refuses a hook pin that is not an exact version (K-ADOPT-11)', () =>
      red(hook('slack', 'main'), `${HOOK},title=lane-check::a Kanon reference pins 'main', not an exact version`));
    it("still counts any other Kanon reference in the hook as the callers' pin", () =>
      red((t) => {
        hook('slack', 'v1.2.3')(t);
        t.write(HOOK, `${t.read(HOOK)}    - uses: yedeya-labs/kanon/actions/pr-title@v1.2.2\n`);
      }, 'pin v1.2.2,v1.2.3'));
    it("still refuses two versions among the callers, beside a hook behind them", () =>
      red((t) => {
        hook('slack', 'v1.2.2')(t);
        t.write(TRIAGE, t.read(TRIAGE).replace(/@v1\.2\.3/g, '@v1.2.4'));
      }, 'pin v1.2.3,v1.2.4'));

    describe('behind the callers, at a release whose contract version is retired', () => {
      const roots: string[] = [];
      afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });
      /** Kanon's tree, with a requirements.json whose notify entry writes `versions` only. */
      const writing = (versions: number[]) => {
        const dir = mkdtempSync(join(tmpdir(), 'kanon-notify-versions-'));
        roots.push(dir);
        for (const e of readdirSync(ROOT)) if (e !== 'requirements.json') symlinkSync(join(ROOT, e), join(dir, e));
        const req = JSON.parse(readFileSync(join(ROOT, 'requirements.json'), 'utf8'));
        req.notify.versions = versions;
        writeFileSync(join(dir, 'requirements.json'), `${JSON.stringify(req, null, 2)}\n`);
        return dir;
      };
      it('refuses a hook that declares only a version the callers\' release no longer writes', () => {
        const t = adopter();
        hook('slack', 'v1.2.2')(t);
        const r = check(t, { ...AT, KANON_ROOT: writing([2]) });
        expect(r.status, r.out).toBe(1);
        expect(r.out).toContain(`${HOOK},title=lane-check::pins Kanon's slack hook at v1.2.2, behind the callers' v1.2.3, and declares message-v1, which the callers' release no longer writes: it writes message-v2`);
      });
      it('accepts it while the callers\' release still writes the version it declares beside a newer one', () => {
        const t = adopter();
        hook('slack', 'v1.2.2')(t);
        const r = check(t, { ...AT, KANON_ROOT: writing([1, 2]) });
        expect(r.status, r.out).toBe(0);
      });
    });
  });
});
