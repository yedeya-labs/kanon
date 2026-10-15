import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { TYPES } from '../../actions/pr-title/pr-title.mjs';
import { RELEASE_TITLE } from '../../scripts/metrics/release.mjs';
import { RELEASE as MOVE_PINS_RELEASE } from '../../scripts/move-pins.mjs';
import { check, Refusal } from '../../scripts/promote.mjs';

type Section = { type: string; section: string; hidden?: boolean };
type Package = {
  'changelog-sections': Section[];
  'initial-version'?: string;
  component?: string;
  'include-component-in-tag'?: boolean;
  'tag-separator'?: string;
  'include-v-in-tag'?: boolean;
  prerelease?: boolean;
};
type Config = { 'last-release-sha'?: string; packages: Record<string, Package> };

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
const config = read('release-please-config.json') as Config;
const root = config.packages['.'];

describe("K-SHIP-4 the check's types agree with the release tool's", () => {
  it('release-please has exactly one package, at the root', () => {
    expect(Object.keys(config.packages)).toEqual(['.']);
  });

  it("the changelog sections name exactly the action's types, once each", () => {
    const types = root?.['changelog-sections'].map((s) => s.type) ?? [];
    expect(new Set(types).size).toBe(types.length);
    expect([...types].sort()).toEqual(Object.keys(TYPES).sort());
  });

  it('no section is hidden, so every type produces a release (K-SHIP-7)', () => {
    expect(root?.['changelog-sections'].filter((s) => s.hidden)).toEqual([]);
  });
});

describe('K-SHIP-7 the first release is 0.1.0', () => {
  // The manifest holds the last released version, so it changes with every release: pin
  // the invariants that hold across releases, not a value that the first release changes.
  it('the first release is 0.1.0, and the manifest agrees with package.json', () => {
    expect(root?.['initial-version']).toBe('0.1.0');
    const manifest = read('.release-please-manifest.json') as Record<string, string>;
    expect(Object.keys(manifest)).toEqual(['.']);
    expect(manifest['.']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest['.']).toBe((read('package.json') as { version: string }).version);
  });
});

/**
 * Plan 0009 §3, step S3: Kanon's release PR cuts a candidate, `candidate-vX.Y.Z`, published as a
 * GitHub pre-release, and its first candidate's changelog starts after the last plain release.
 * The pin job (`release-please.yml`'s `candidate` job, S4) and the promotion (`promote.mjs`, S5)
 * were built first and look for exactly that tag and that flag, so the three are held together here.
 */
describe('plan 0009 S3 Kanon cuts candidates', () => {
  const manifest = read('.release-please-manifest.json') as Record<string, string>;
  const version = manifest['.'] as string;
  /** The tag release-please writes for `v`, as its `TagName` builds it: component, separator, `v`, version. */
  const tagOf = (v: string, p: Package = root as Package) =>
    `${p['include-component-in-tag'] && p.component ? `${p.component}${p['tag-separator'] ?? '-'}` : ''}${p['include-v-in-tag'] ? 'v' : ''}${v}`;
  const tag = tagOf(version);

  it('tags the candidate form, candidate-vX.Y.Z', () => {
    expect(root?.component).toBe('candidate');
    expect(root?.['include-component-in-tag']).toBe(true);
    expect(root?.['tag-separator']).toBe('-');
    expect(root?.['include-v-in-tag']).toBe(true);
    expect(tag).toBe(`candidate-v${version}`);
  });

  it("marks each candidate's Release a pre-release, which GitHub's latest release never names", () => {
    expect(root?.prerelease).toBe(true);
    // release-please (17.x, in the action's v5) marks a Release a pre-release only when
    // `prerelease` is set AND the version has a pre-release suffix or a major of 0:
    // `config.prerelease && (!!version.preRelease || version.major === 0)`. Kanon's versions carry
    // no suffix, so at 1.0.0 its candidates would stop being pre-releases, the pin job would find
    // none, and GitHub's latest release would name a candidate. Before Kanon's first major, the
    // configuration needs another way to mark them; this turns red to say so.
    expect(Number(version.split('.')[0]), 'release-please marks a suffix-free version a pre-release only below 1.0.0').toBe(0);
  });

  it("bounds the first candidate's changelog at the last plain release's commit", () => {
    // Without it release-please looks for `candidate-v<previous>`, finds none, and the changelog
    // runs from the first commit (plan 0009 S0). S3's second change removes it once the first
    // candidate is tagged.
    const sha = config['last-release-sha'];
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    let plain = '';
    try {
      plain = execFileSync('git', ['rev-list', '-n1', 'v0.40.0'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      // A checkout without tags can't resolve it; the form above still holds.
    }
    if (plain) expect(sha).toBe(plain);
  });

  it('titles the release PR in a form the metrics recognise as a release PR', () => {
    // release-please's default title, `chore${scope}: release${component} ${version}`.
    expect(RELEASE_TITLE.test(`chore(main): release ${root?.component} ${version}`)).toBe(true);
  });

  it("the pin job's `candidate` job looks for exactly this tag, as a pre-release", () => {
    const workflow = parse(readFileSync(new URL('../../.github/workflows/release-please.yml', import.meta.url), 'utf8')) as {
      jobs: Record<string, { steps?: Array<{ id?: string; run?: string }> }>;
    };
    const script = workflow.jobs.candidate?.steps?.find((s) => s.id === 'find')?.run ?? '';
    // The version it reads is the manifest's, as release-please's is.
    expect(script).toContain('.release-please-manifest.json');
    const built = /^\s*tag="([^"]*)"$/m.exec(script)?.[1];
    expect(built, "the job's tag line").toBeDefined();
    expect(String(built).replace('$version', version)).toBe(tag);
    expect(script).toContain('.prerelease');
    expect(script).toContain('[[ "$pre" == "true" ]]');
  });

  it('the promotion finds this tag as its candidate, and the pin script takes it as a release', () => {
    expect(MOVE_PINS_RELEASE.test(tag)).toBe(true);
    const sha = 'c'.repeat(40);
    const found = (name: string) => {
      const api = (path: string) => (path === 'repos/o/r/git/matching-refs/tags/candidate-v' && name.startsWith('candidate-v')
        ? [{ ref: `refs/tags/${name}`, object: { sha, type: 'commit' } }]
        : undefined);
      try {
        return check({ GITHUB_REPOSITORY: 'o/r' }, { api: api as never, workflows: [] }).candidate === name;
      } catch (e) {
        // Past finding it, the stub answers nothing more, so it refuses on the candidate's commit.
        return e instanceof Refusal && e.message.includes(name);
      }
    };
    expect(found(tag)).toBe(true);
    // A plain tag, the configuration before S3, is never a candidate.
    expect(found(tagOf(version, { ...(root as Package), 'include-component-in-tag': false }))).toBe(false);
  });
});
