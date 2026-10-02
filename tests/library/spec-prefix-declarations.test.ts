import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { check } from '../../scripts/spec-guard.mjs';
import { allocate } from '../../scripts/spec-ids.mjs';
import {
  SPEC_DIR, declaredPrefix, idPattern, loadPrefixes, parseAll, parseSpec, prefixProblems,
} from '../../scripts/spec-lib.mjs';

/**
 * RA-2701 (Kanon move plan P4, `K-LAYOUT-2`) — each spec file declares its own area prefix,
 * `**Id prefix:** \`AREA\`` in its preamble, instead of a map in `spec-lib.mjs`.
 *
 * The declaration is now the only thing that makes a file's invariants exist to the
 * allocator, the guard and the coverage report, so every way of getting it wrong must be
 * a finding: a missing, repeated, misplaced or malformed declaration, and one prefix
 * declared by two files.
 */

const spec = (preamble: string, body = '- `[KIOSK-1]` `[seed]` One.') =>
  `# L2 Spec — Fixture\n\n${preamble}\n\n**Area:** a fixture.\n\n## Invariants\n\n${body}\n`;

function corpus(files: Record<string, string>, registry: Record<string, number> = { KIOSK: 9, STORE: 9 }) {
  const dir = mkdtempSync(join(tmpdir(), 'spec-prefix-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const registryPath = join(dir, '_id-registry.json');
  writeFileSync(registryPath, JSON.stringify(registry));
  return { dir, registryPath };
}

const lines = (text: string) => text.split('\n');

describe('declaredPrefix — the accepted shape', () => {
  it('reads the prefix from the preamble line', () => {
    expect(declaredPrefix(lines(spec('**Id prefix:** `KIOSK`')), 'k.md')).toEqual({ prefix: 'KIOSK', problems: [] });
  });

  it('ignores a declaration-shaped line inside a code fence — a documented example is not a declaration', () => {
    const text = spec('**Id prefix:** `KIOSK`\n\n```text\n**Id prefix:** `EXAMPLE`\n```');
    expect(declaredPrefix(lines(text), 'k.md')).toEqual({ prefix: 'KIOSK', problems: [] });
  });

  it('reads a file with no `##` heading as all preamble', () => {
    expect(declaredPrefix(['# T', '', '**Id prefix:** `KIOSK`'], 'k.md').prefix).toBe('KIOSK');
  });
});

describe('declaredPrefix — fails loudly', () => {
  const problem = (text: string) => {
    const d = declaredPrefix(lines(text), 'k.md');
    expect(d.prefix).toBeNull();
    return d.problems.join('\n');
  };

  it('on no declaration', () => expect(problem(spec('Nothing here.'))).toMatch(/k\.md — declares no area prefix/));
  it('on two declarations', () => expect(problem(spec('**Id prefix:** `KIOSK`\n\n**Id prefix:** `KIOSK`'))).toMatch(/declares its area prefix 2 times \(lines 3, 5\)/));
  it('on a declaration below the first `##` heading', () => {
    expect(problem(spec('Nothing here.', '**Id prefix:** `KIOSK`'))).toMatch(/k\.md:9 — the area-prefix declaration sits below the first `##` heading/);
  });
  it.each([
    ['a lowercase prefix', '**Id prefix:** `kiosk`'],
    ['a prefix with a digit', '**Id prefix:** `KIOSK2`'],
    ['no backticks', '**Id prefix:** KIOSK'],
    ['a trailing word', '**Id prefix:** `KIOSK` (the kiosk)'],
    ['a list marker', '- **Id prefix:** `KIOSK`'],
    ['different capitalisation', '**ID prefix:** `KIOSK`'],
    ['no bold', 'Id prefix: `KIOSK`'],
    ['a hyphenated label', '**Id-prefix:** `KIOSK`'],
  ])('on a malformed declaration — %s', (_, line) => {
    expect(problem(spec(line))).toMatch(/k\.md:3 — malformed area-prefix declaration/);
  });
});

describe('an unclosed fence that hides the declaration', () => {
  it('is named as the cause, not reported as a missing declaration', () => {
    const d = declaredPrefix(lines(spec('```text\nan example that never closes\n\n**Id prefix:** `KIOSK`')), 'k.md');
    expect(d.prefix).toBeNull();
    expect(d.problems).toEqual(['k.md:3 — declares no area prefix that can be read: a code fence opens here and never closes, so every line below it is an example. Close the fence.']);
  });
});

describe('the corpus', () => {
  it('refuses one prefix declared by two files, naming both', () => {
    const { dir } = corpus({ 'a.md': spec('**Id prefix:** `KIOSK`'), 'b.md': spec('**Id prefix:** `KIOSK`') });
    expect(prefixProblems(dir).problems).toEqual([
      'b.md — declares area prefix `KIOSK`, which a.md already declares. A prefix names one area; pick another for one of them.',
    ]);
    expect(() => loadPrefixes(dir)).toThrow(/which a\.md already declares/);
    // `parseAll` validates the corpus first: no single `parseSpec` can see a duplicate.
    expect(() => parseAll(dir)).toThrow(/which a\.md already declares/);
  });

  it('parseSpec throws on a file whose declaration is missing — the file must not silently vanish', () => {
    const { dir } = corpus({ 'a.md': spec('Nothing here.') });
    expect(() => parseSpec('a.md', dir)).toThrow(/a\.md — declares no area prefix/);
  });

  it('the declaration, not the filename, decides the prefix', () => {
    const { dir } = corpus({ 'renamed.md': spec('**Id prefix:** `KIOSK`') });
    expect(parseSpec('renamed.md', dir).map((i: { prefix: string }) => i.prefix)).toEqual(['KIOSK']);
    expect(loadPrefixes(dir)).toEqual({ 'renamed.md': 'KIOSK' });
  });

  it('idPattern is derived from the declarations of the directory it is given', () => {
    const { dir } = corpus({ 'a.md': spec('**Id prefix:** `KIOSK`'), 'b.md': spec('**Id prefix:** `STORE`', '- `[STORE-1]` `[seed]` One.') });
    expect('[KIOSK-1] [STORE-2] [PAY-3]'.match(idPattern('g', dir))).toEqual(['[KIOSK-1]', '[STORE-2]']);
  });

  it('idPattern sees a declaration edited mid-process, as loadPrefixes does', () => {
    const { dir } = corpus({ 'a.md': spec('**Id prefix:** `KIOSK`') });
    expect('[KIOSK-1]'.match(idPattern('g', dir))).toEqual(['[KIOSK-1]']);
    writeFileSync(join(dir, 'a.md'), spec('**Id prefix:** `STORES`'));
    expect('[KIOSK-1] [STORES-2]'.match(idPattern('g', dir))).toEqual(['[STORES-2]']);
  });

  it('the allocator mints under the declared prefix', () => {
    const { dir } = corpus({ 'renamed.md': spec('**Id prefix:** `KIOSK`', '- `[seed]` New.') });
    expect(allocate({ dir, registry: { KIOSK: 9 } }).assigned.map((a: { id: string }) => a.id)).toEqual(['KIOSK-10']);
  });

  it('the real corpus: every spec file declares a prefix, and no two share one', () => {
    const onDisk = readdirSync(SPEC_DIR).filter((f) => f.endsWith('.md')).sort();
    const prefixes = loadPrefixes();
    expect(Object.keys(prefixes).sort()).toEqual(onDisk);
    expect(new Set(Object.values(prefixes)).size).toBe(onDisk.length);
  });
});

describe('spec-guard reports declaration problems as findings, never as a crash', () => {
  it('on a missing declaration', () => {
    const { dir, registryPath } = corpus({ 'a.md': spec('Nothing here.') });
    expect(check({ dir, registryPath }).problems).toEqual([
      'a.md — declares no area prefix. Add the line **Id prefix:** `AREA` (the prefix in backticks) above the first `##` heading.',
    ]);
  });

  it('on a duplicate across files', () => {
    const { dir, registryPath } = corpus({ 'a.md': spec('**Id prefix:** `KIOSK`'), 'b.md': spec('**Id prefix:** `KIOSK`') });
    expect(check({ dir, registryPath }).problems.join('\n')).toMatch(/b\.md — declares area prefix `KIOSK`, which a\.md already declares/);
  });

  it('an id whose prefix no file declares is unknown — and the message says where to declare one', () => {
    const { dir, registryPath } = corpus({ 'a.md': spec('**Id prefix:** `KIOSK`', '- `[PAY-1]` `[seed]` One.') }, { KIOSK: 9, PAY: 9 });
    expect(check({ dir, registryPath }).problems).toEqual([
      'a.md:9 — `PAY-1` uses an unknown area prefix. Declare it with `**Id prefix:**` in its area\'s spec file.',
    ]);
  });

  it('a well-formed corpus passes', () => {
    const { dir, registryPath } = corpus({ 'a.md': spec('**Id prefix:** `KIOSK`') });
    expect(check({ dir, registryPath }).problems).toEqual([]);
  });
});
