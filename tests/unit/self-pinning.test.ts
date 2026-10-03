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

// The first exception is the hook (plan 0001 §5). The spine calls the ADOPTER's project-setup
// hook, which is the adopter's code in the adopter's checkout. `./` is exactly right for it,
// and the only form that reaches it.
//
// The other two are the checks that judge a Kanon PR (#47). They run Kanon's LAST release, so a
// PR can't weaken the check that passes it: ADR 0011's bootstrap, applied to a check's code.
// Their version is whatever Dependabot last proposed, so it is compared as `vX.Y.Z`, and only
// an exact version matches. The PR's own copies run as a test, in judging-actions-smoke.yml.
//
// The last two are Kanon running its own lanes (ADR 0011, plan 0001 step 4b), for the same
// reason. review.yml is the caller of the review lane: through `$/`, a PR's own lane code
// would review that same PR. CI's lane-check judges that caller, and is a required check, so
// it runs the release too; it then reads the lanes at the version the caller pins.
//
// The smoke run's python fixture hook is the first exception again, on a fixture (kanon#110):
// the project-setup hook of the fixture adopter in Kanon's own checkout, run to show that a
// hook with no `KANON` and no Node leaves a guard running on Kanon's Node.
//
// The test-database smoke runs the worked example's hook the same way (kanon#18): copied over
// the workspace, then called as a lane calls a hook, to show the `hook` contract on a runner.
const EXEMPT = new Set([
  '.github/workflows/agent-blocks-smoke.yml: ./tests/fixtures/python-adopter/.github/actions/project-setup',
  '.github/workflows/agent-lane.yml: ./.github/actions/project-setup',
  '.github/workflows/agent-lead-split.yml: ./.github/actions/project-setup',
  '.github/workflows/agent-rebase.yml: ./.github/actions/project-setup',
  '.github/workflows/agent-review.yml: ./.github/actions/project-setup',
  '.github/workflows/agent-verify-acs.yml: ./.github/actions/project-setup',
  '.github/workflows/dco.yml: yedeya-labs/kanon/actions/dco@vX.Y.Z',
  '.github/workflows/pr-title.yml: yedeya-labs/kanon/actions/pr-title@vX.Y.Z',
  '.github/workflows/review.yml: yedeya-labs/kanon/.github/workflows/agent-review.yml@vX.Y.Z',
  '.github/workflows/ci.yml: yedeya-labs/kanon/actions/lane-check@vX.Y.Z',
  '.github/workflows/test-database-smoke.yml: ./.github/actions/project-setup',
]);
/** An exact release, written as the form, so the exemption survives each Dependabot bump. */
const form = (entry: string): string => entry.replace(/^(.*: yedeya-labs\/kanon\/[^@]+)@v\d+\.\d+\.\d+$/, '$1@vX.Y.Z');

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

  it('has no `uses:` naming `./` or `yedeya-labs/kanon/`, apart from the exemptions', () => {
    const bad = all
      .filter((x) => x.uses.startsWith('./') || x.uses.startsWith('yedeya-labs/kanon/'))
      .map((x) => form(`${x.file}: ${x.uses}`));
    expect(bad.sort()).toEqual([...EXEMPT].sort());
  });

  it('has no such line in comments or examples either, which get copied', () => {
    // The parse above sees only real `uses:` keys. An example in a header comment is
    // copied into a lane sooner or later, so the text is held to the same rule.
    const hits = files.flatMap((file) => readFileSync(file, 'utf8').split('\n')
      .map((line, i) => ({ line, at: `${file}:${i + 1}` }))
      // A `uses:` key, live or commented out (`#   - uses: …`), not prose quoting one.
      .filter(({ line }) => /^\s*(#\s*)?(-\s*)?uses:\s*["']?(\.\/|yedeya-labs\/kanon\/)/.test(line))
      .map(({ at, line }) => `${at}: ${line.trim()}`));
    expect(hits.map((h) => form(h.replace(/:\d+: (- )?uses: /, ': '))).sort()).toEqual([...EXEMPT].sort());
  });

  it('names every `$/` target that exists in this tree', () => {
    for (const { file, uses } of all.filter((x) => x.uses.startsWith('$/'))) {
      const path = uses.slice(2);
      const target = path.endsWith('.yml') ? path : join(path, 'action.yml');
      expect(() => readFileSync(target), `${file}: ${uses}`).not.toThrow();
    }
  });
});
