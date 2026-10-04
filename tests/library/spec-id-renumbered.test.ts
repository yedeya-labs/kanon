import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRegistry } from '../../scripts/spec-lib.mjs';
import { renumberFindings, trailProblems } from '../../scripts/spec-id-renumbered.mjs';
import { check } from '../../scripts/spec-guard.mjs';
import { ROOT } from './helpers/adopter.js';

/**
 * RA-2004 — a reference to a RENUMBERED spec id must be looked at once.
 *
 * `[STORE-102]` still resolves after RA-2003 moved RA-1891's clause to `[STORE-103]` — it
 * names RA-1854's clause now — so existence cannot see a stale reference to it. The
 * renumber leaves a trail (`_id-registry.json`'s `renumbered` map) and
 * `spec-id-renumbered.mjs` lists every reference to a moved-off id until it is rewritten
 * or acknowledged with a per-file `renumber-checked: <OLD-ID>` marker.
 *
 * This file imports `scripts/qa/`, so it is outside the reference corpus it tests: the
 * ids and markers below are fixtures, not references.
 *
 * KANON'S HALF (plan 0001, step 3). The reference adopter keeps the checks of its own tree: its trail, its corpus and its lint wiring.
 */

const REPO = ROOT;
const TRAIL = { 'STORE-102': { to: 'STORE-103', by: 2003 } };
const file = (path: string, ...lines: string[]) => ({ path, text: lines.join('\n') });

describe('renumberFindings', () => {
  it('lists a reference to a renumbered id that nothing acknowledges, with where it went', () => {
    const r = renumberFindings(TRAIL, [file('docs/a.md', 'intro', 'refused (#1891, [STORE-102])')]);
    expect(r.unacknowledged).toEqual([{ path: 'docs/a.md', line: 2, id: 'STORE-102', to: 'STORE-103', by: 2003 }]);
    expect(r.references).toBe(1);
  });

  it('drops a reference once it is rewritten to the new id', () => {
    const r = renumberFindings(TRAIL, [file('docs/a.md', 'refused (#1891, [STORE-103])')]);
    expect(r.unacknowledged).toEqual([]);
    expect(r.references).toBe(0);
  });

  it('a marker acknowledges EVERY reference to that id in its own file, and no other file', () => {
    const r = renumberFindings(TRAIL, [
      file('tests/a.test.ts', "it('[STORE-102] one', () => {});", "it('[STORE-102] two', () => {});", '// renumber-checked: STORE-102'),
      file('tests/b.test.ts', "it('[STORE-102] three', () => {});"),
    ]);
    expect(r.unacknowledged.map((u) => `${u.path}:${u.line}`)).toEqual(['tests/b.test.ts:1']);
    expect(r.markers).toEqual([]);
    expect(r.citing).toBe(2);
  });

  it('a marker for a DIFFERENT id acknowledges nothing', () => {
    const r = renumberFindings({ ...TRAIL, 'KIOSK-5': { to: 'KIOSK-6', by: 1 } }, [
      file('docs/a.md', '[STORE-102] and [KIOSK-5]', '<!-- renumber-checked: KIOSK-5 -->'),
    ]);
    expect(r.unacknowledged.map((u) => u.id)).toEqual(['STORE-102']);
  });

  it('refuses a marker that acknowledges nothing — a pre-signed pass for the next reference', () => {
    const r = renumberFindings(TRAIL, [
      file('docs/a.md', 'no reference here', '<!-- renumber-checked: STORE-102 -->'),
      file('docs/b.md', '[STORE-102]', '<!-- renumber-checked: STORE-102 -->', '<!-- renumber-checked: STORE-7 -->'),
    ]);
    expect(r.markers.map((m) => `${m.path}:${m.line} ${m.id}`)).toEqual(['docs/a.md:2 STORE-102', 'docs/b.md:3 STORE-7']);
    // Each says WHY, and the two reasons differ: a typo'd id is not a leftover.
    expect(r.markers[0].why).toMatch(/no longer cites/);
    expect(r.markers[1].why).toMatch(/not in the `renumbered` trail/);
    expect(r.unacknowledged).toEqual([]);
  });

  it('catches both instances that motivated it, replayed verbatim', () => {
    // RA-2003's straggler (`docs/fe-gap-analysis.md:214` at 745bbcd6^) and the reference
    // RA-2013 wrote against the mid-flight numbering (`e2e/data-deletion.spec.ts:8` at
    // 52c5e5a4). Both resolved; both named the wrong clause.
    const r = renumberFindings(TRAIL, [
      file('docs/fe-gap-analysis.md', '| Data deletion request form | … refused … when the provider refuses the message (#1891, `[STORE-102]`) | done |'),
      file('e2e/data-deletion.spec.ts', '/**', " * carries the routes, which is what makes `[STORE-102]`'s send-failure copy", ' */'),
    ]);
    expect(r.unacknowledged.map((u) => `${u.path}:${u.line}`)).toEqual(['docs/fe-gap-analysis.md:1', 'e2e/data-deletion.spec.ts:2']);
  });
});

describe('trailProblems', () => {
  const known = new Set(['STORE-102', 'STORE-103']);
  it('accepts a well-formed entry', () => {
    expect(trailProblems(TRAIL, known)).toEqual([]);
  });
  it('rejects an entry pointing at a clause that does not exist', () => {
    expect(trailProblems({ 'STORE-102': { to: 'STORE-999', by: 2003 } }, known).join()).toMatch(/no spec clause declares `STORE-999`/);
  });
  it('rejects a key no reference could ever match, a self-move and a missing PR', () => {
    expect(trailProblems({ 'NOPE-1': { to: 'STORE-103', by: 1 } }, known).join()).toMatch(/registered area prefix/);
    expect(trailProblems({ 'STORE-103': { to: 'STORE-103', by: 1 } }, known).join()).toMatch(/to itself/);
    expect(trailProblems({ 'STORE-102': { to: 'STORE-103' } } as never, known).join()).toMatch(/`by` must be/);
    expect(trailProblems({ 'STORE-102': 'STORE-103' } as never, known).join()).toMatch(/needs/);
  });
});

describe('the real tree', () => {

  it('keeps the trail out of the high-water marks every other caller reads', () => {
    const marks = loadRegistry();
    expect(marks).not.toHaveProperty('renumbered');
    for (const v of Object.values(marks)) expect(typeof v).toBe('number');
  });



  it('the CLI exits NON-ZERO and names the file on an unacknowledged reference', () => {
    const dir = mkdtempSync(join(tmpdir(), 'renum-'));
    mkdirSync(join(dir, 'docs/qa/specs'), { recursive: true });
    writeFileSync(join(dir, 'docs/qa/specs/storefront.md'), '# S\n\n**Id prefix:** `STORE`\n\n## A\n\n- `[STORE-102]` `[seed]` one\n- `[STORE-103]` `[seed]` two\n');
    writeFileSync(join(dir, 'docs/qa/specs/_id-registry.json'), JSON.stringify({ STORE: 103, renumbered: TRAIL }));
    writeFileSync(join(dir, 'docs/notes.md'), 'see [STORE-102]\n');
    const r = spawnSync(process.execPath, [join(REPO, 'scripts/spec-id-renumbered.mjs')], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('docs/notes.md:1  [STORE-102]');
  });
});

describe('the allocator writes the trail back untouched (RA-2004)', () => {
  it('`spec-ids.mjs --apply` advances the mark and keeps `renumbered`', () => {
    const dir = mkdtempSync(join(tmpdir(), 'renum-alloc-'));
    mkdirSync(join(dir, 'docs/qa/specs'), { recursive: true });
    writeFileSync(join(dir, 'docs/qa/specs/storefront.md'), '# S\n\n**Id prefix:** `STORE`\n\n## A\n\n- `[STORE-102]` `[seed]` one\n- `[STORE-103]` `[seed]` two\n- `[seed]` new\n');
    writeFileSync(join(dir, 'docs/qa/specs/_id-registry.json'), JSON.stringify({ STORE: 103, renumbered: TRAIL }));
    execFileSync(process.execPath, [join(REPO, 'scripts/spec-ids.mjs'), '--apply', '--offline'], { cwd: dir, encoding: 'utf8' });
    const written = JSON.parse(readFileSync(join(dir, 'docs/qa/specs/_id-registry.json'), 'utf8'));
    expect(written).toEqual({ STORE: 104, renumbered: TRAIL });
  });
});

describe('whoever resolves a collision is told to write the trail', () => {
  it("spec-guard's duplicate-id problem names the `renumbered` map and the id to key it by", () => {
    const dir = mkdtempSync(join(tmpdir(), 'renum-dup-'));
    writeFileSync(join(dir, 'storefront.md'), '# S\n\n**Id prefix:** `STORE`\n\n## A\n\n- `[STORE-7]` `[seed]` one\n- `[STORE-7]` `[seed]` two\n');
    writeFileSync(join(dir, '_id-registry.json'), JSON.stringify({ STORE: 7 }));
    const { problems } = check({ dir, registryPath: join(dir, '_id-registry.json') });
    const dup = problems.find((p: string) => p.startsWith('duplicate ID `STORE-7`'));
    expect(dup).toMatch(/`renumbered` map/);
    expect(dup).toContain('{"STORE-7": {"to": "<NEW-ID>"');
  });

  // kanon#168 — the entry is owed only for an id that reached `main`. A duplicate is
  // often minted inside one PR, and an unearned entry is permanent: every later
  // citation of the clause that kept the number has to carry a `renumber-checked`
  // marker. The three messages that tell a resolver what to do must agree on that.
  it("spec-guard asks for the entry only for an id that has been on `main`, as spec-ids and spec-id-claims do", () => {
    const dir = mkdtempSync(join(tmpdir(), 'renum-dup-'));
    writeFileSync(join(dir, 'storefront.md'), '# S\n\n**Id prefix:** `STORE`\n\n## A\n\n- `[STORE-7]` `[seed]` one\n- `[STORE-7]` `[seed]` two\n');
    writeFileSync(join(dir, '_id-registry.json'), JSON.stringify({ STORE: 7 }));
    const { problems } = check({ dir, registryPath: join(dir, '_id-registry.json') });
    const dup = problems.find((p: string) => p.startsWith('duplicate ID `STORE-7`')) ?? '';
    const qualifier = 'If the id you move off has already been on `main`, record the move';
    expect(dup).toContain(qualifier);
    // The qualifier precedes the instruction: no unconditional "and record the move".
    expect(dup).not.toMatch(/\)\s*and record the move/);
    expect(dup).toMatch(/never reached `main`[^.]*write no entry/);
    // The siblings say the same thing, so a reword of one is a red test here.
    const ids = readFileSync(join(REPO, 'scripts/spec-ids.mjs'), 'utf8');
    expect(ids).toContain('If an id you move off has already been on \\`main\\`, record the move');
    const claims = readFileSync(join(REPO, 'scripts/spec-id-claims.mjs'), 'utf8');
    expect(claims).toMatch(/No `renumbered`\\n' \+\s*'entry in `_id-registry.json` is needed: the number never reached `main`/);
  });
});
