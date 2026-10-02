import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Plan 0001 §4 (decision 3): every reference from one Kanon file to another is `$/`, GitHub's
// self-reference, which resolves to Kanon at the commit the caller pinned. A `./` reference
// resolves against the CALLER's workspace, so inside an adopter's run it would read the
// adopter's tree. A `yedeya-labs/kanon/…@ref` reference pins a second version beside the
// one the adopter chose. Either would let two versions of Kanon run in one job.

const files = [
  ...readdirSync('actions', { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join('actions', d.name, 'action.yml')),
  ...readdirSync('.github/workflows').filter((f) => f.endsWith('.yml')).map((f) => join('.github/workflows', f)),
];

// The one exception, with its reason in the file: the release caller calls the reusable
// release workflow at job level, which runs only on main, so a `$/` that failed there would
// first fail a release. It moves to `$/` once a job-level `$/` call is proven on a PR.
const EXEMPT = new Set(['.github/workflows/release-please.yml: ./.github/workflows/release.yml']);

type Node = { uses?: unknown; steps?: Node[]; jobs?: Record<string, Node>; runs?: { steps?: Node[] } };
const usesOf = (file: string): string[] => {
  const doc = parse(readFileSync(file, 'utf8')) as Node;
  const steps = [...(doc.runs?.steps ?? []), ...Object.values(doc.jobs ?? {}).flatMap((j) => j.steps ?? [])];
  const jobs = Object.values(doc.jobs ?? {});
  return [...steps, ...jobs].map((n) => n.uses).filter((u): u is string => typeof u === 'string');
};

describe('plan 0001 §4: Kanon references itself only through `$/`', () => {
  const all = files.flatMap((file) => usesOf(file).map((uses) => ({ file, uses })));

  it('finds the actions and workflows, and the blocks calling each other, so the rule is not vacuous', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(all.filter((x) => x.uses.startsWith('$/actions/agent-')).length).toBeGreaterThanOrEqual(2);
  });

  it('has no `uses:` naming `./` or `yedeya-labs/kanon/`, apart from the one exemption', () => {
    const bad = all
      .filter((x) => x.uses.startsWith('./') || x.uses.startsWith('yedeya-labs/kanon/'))
      .map((x) => `${x.file}: ${x.uses}`);
    expect(bad).toEqual([...EXEMPT]);
  });

  it('has no such line in comments or examples either, which get copied', () => {
    // The parse above sees only real `uses:` keys. An example in a header comment is
    // copied into a lane sooner or later, so the text is held to the same rule.
    const hits = files.flatMap((file) => readFileSync(file, 'utf8').split('\n')
      .map((line, i) => ({ line, at: `${file}:${i + 1}` }))
      // A `uses:` key, live or commented out (`#   - uses: …`), not prose quoting one.
      .filter(({ line }) => /^\s*(#\s*)?(-\s*)?uses:\s*["']?(\.\/|yedeya-labs\/kanon\/)/.test(line))
      .map(({ at, line }) => `${at}: ${line.trim()}`));
    expect(hits.map((h) => h.replace(/:\d+: (- )?uses: /, ': '))).toEqual([...EXEMPT]);
  });

  it('names every `$/` target that exists in this tree', () => {
    for (const { file, uses } of all.filter((x) => x.uses.startsWith('$/'))) {
      const path = uses.slice(2);
      const target = path.endsWith('.yml') ? path : join(path, 'action.yml');
      expect(() => readFileSync(target), `${file}: ${uses}`).not.toThrow();
    }
  });
});
