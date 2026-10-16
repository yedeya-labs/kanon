import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TELEMETRY_CALLER_PATH, telemetryCallerFile } from '../../cli/callers.mjs';
import { ROOT, SCRIPT, adopter, check, red, laneCheck, type Tree } from './helpers/lane-check.js';

/**
 * `actions/lane-check`: a caller of Kanon's telemetry collector that still passes the SigV4 path's
 * `url:` or `writer-role:` without `audience:` (kanon#845). The collector refuses those inputs
 * before it mints a token (Owner decision of 2026-10-14, kanon#842), but only on the default
 * branch, after the pin bump's pull request merged. This turns that pull request red instead, as
 * doctor's `telemetry.legacy-inputs` does when someone runs it.
 *
 * A caller is judged against the release it pins, which is the release lane-check reads only when
 * it runs at that pin (`ACTION_REF`, which the pin rule already holds every reference to), so
 * every case here runs at the fixture's `v1.2.3`.
 *
 * One of the lane-check files split by area (kanon#381); `tests/unit/helpers/lane-check.ts`
 * says how every case runs and holds the helpers they share.
 */
laneCheck(() => {
  describe("a telemetry collector caller still passing the SigV4 path's inputs (telemetry.legacy-inputs, kanon#845)", () => {
    /** The collector's caller as `kanon init --telemetry` writes it, with `lines` added under its `with:`. */
    const caller = (lines: string) => (t: Tree) =>
      t.write(TELEMETRY_CALLER_PATH, telemetryCallerFile('v1.2.3').replace('    with:\n', `    with:\n${lines}`));
    /** lane-check at the fixture's pin, as the action runs at the version a caller pins. */
    const AT = { ACTION_REF: 'v1.2.3' };
    const URL = '      url: ${{ vars.KANON_TELEMETRY_URL }}\n';
    const ROLE = '      writer-role: ${{ vars.KANON_TELEMETRY_WRITER_ROLE }}\n';

    // Plan 0008 J9: this release's collector declares no `writer-role`, so that line is
    // `caller.input-stale`, as doctor splits them, and `telemetry.legacy-inputs` names `url:` alone.
    it('refuses `url:` without `audience:` as legacy-inputs, and `writer-role:` as an input the collector no longer declares, each naming the job and the fix', () => {
      const r = red(caller(`${URL}${ROLE}`),
        /::error file=\.github\/workflows\/telemetry\.yml,title=lane-check::the job `collect` passes `url:` to Kanon's telemetry collector without `audience:`.*refuses it before it mints a token.*nothing is sent or registered.*kanon init --telemetry.*add `audience:` beside `url:` \(.*telemetry\.legacy-inputs/, AT);
      expect(r.out).toMatch(/::error file=\.github\/workflows\/telemetry\.yml,title=lane-check::the job `collect` passes `writer-role:` to Kanon's telemetry collector, which does not declare it at this release, so GitHub refuses the call before the run starts\. Remove it from the job's `with:`, with the repository variable it read .*\(caller\.input-stale\)/);
      expect(r.out.match(/::error/g)).toHaveLength(2);
      // Only the inputs' names reach the message, never a value.
      expect(r.out).not.toContain('vars.KANON_TELEMETRY');
    });
    it('refuses `writer-role:` alone as caller.input-stale, not as legacy-inputs', () => {
      const r = red(caller(ROLE), /the job `collect` passes `writer-role:` to Kanon's telemetry collector, which does not declare it.*\(caller\.input-stale\)/, AT);
      expect(r.out).not.toContain('telemetry.legacy-inputs');
      expect(r.out.match(/::error/g)).toHaveLength(1);
    });
    it('refuses `writer-role:` without `audience:` as legacy-inputs against a release whose requirements list no collector inputs (before J9)', () => {
      const t = adopter();
      caller(ROLE)(t);
      const r = check(t, { ...AT, KANON_ROOT: kanonWithout((req) => { delete req.telemetry.inputs; }) });
      expect(r.status, r.out).not.toBe(0);
      expect(r.out).toMatch(/the job `collect` passes `writer-role:` to Kanon's telemetry collector without `audience:`.*remove `writer-role:`.*telemetry\.legacy-inputs/);
      expect(r.out).not.toContain('caller.input-stale');
    });
    it('refuses `url:` alone without `audience:`', () =>
      red(caller(URL), /the job `collect` passes `url:` to Kanon's telemetry collector without `audience:`/, AT));
    it('passes a self-hosted store named by `url:` and `audience:` together, and init\'s caller, which passes neither', () => {
      const t = adopter();
      caller(`${URL}      audience: acme-telemetry\n`)(t);
      const r = check(t, AT);
      expect(r.status, r.out).toBe(0);
      const plain = adopter();
      plain.write(TELEMETRY_CALLER_PATH, telemetryCallerFile('v1.2.3'));
      const p = check(plain, AT);
      expect(p.status, p.out).toBe(0);
    });

    // A release before the token path: its requirements don't say `telemetry.token`, and its
    // collector still takes `url:` and `writer-role:`, so the rule asks nothing of the caller.
    const roots: string[] = [];
    afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });
    /** Kanon's tree, with its requirements changed by `change`, as an earlier release's would read. */
    function kanonWithout(change: (req: { telemetry: Record<string, unknown> }) => void) {
      const dir = mkdtempSync(join(tmpdir(), 'kanon-pre-token-'));
      roots.push(dir);
      for (const e of readdirSync(ROOT)) if (e !== 'requirements.json') symlinkSync(join(ROOT, e), join(dir, e));
      const req = JSON.parse(readFileSync(join(ROOT, 'requirements.json'), 'utf8'));
      expect(req.telemetry.token).toBe(true);
      change(req);
      writeFileSync(join(dir, 'requirements.json'), JSON.stringify(req));
      return dir;
    }
    it('asks nothing of the caller against a release whose requirements don\'t say `telemetry.token` or list its inputs', () => {
      const t = adopter();
      caller(`${URL}${ROLE}`)(t);
      const r = check(t, { ...AT, KANON_ROOT: kanonWithout((req) => { delete req.telemetry.token; delete req.telemetry.inputs; }) });
      expect(r.status, r.out).toBe(0);
    });

    // A caller pinned to another release than the one lane-check runs at. Run without an
    // `ACTION_REF`, as tests/unit/lane-check.test.ts runs it, lane-check doesn't read the release
    // the caller pins, so it judges nothing; CI's released lane-check runs at that pin, and judges
    // the pull request that moves it. Kanon's own collector caller moved to the token path with
    // its pin at v0.40.2 (plan 0008 §9 step 4), so it passes neither input any more.
    it("asks nothing of a caller whose pin isn't the release lane-check runs at, as in Kanon's own tree", () => {
      const t = adopter();
      caller(`${URL}${ROLE}`)(t);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      const kanon = spawnSync('bash', [SCRIPT], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, KANON_ROOT: ROOT, ACTION_REF: '' } });
      expect(readFileSync(join(ROOT, '.github/workflows/telemetry.yml'), 'utf8')).not.toMatch(/^ {6}(url|writer-role): /m);
      expect(kanon.stdout).not.toContain('telemetry.legacy-inputs');
    }, 30_000);
  });
});
