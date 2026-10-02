import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { writeStub } from './helpers/stub-bin.js';

/**
 * #77 — `.github/scripts/actionlint.sh` runs a pinned actionlint over a COPY of `.github/`
 * (and `actions/`) in which `uses: $/` is rewritten to `uses: ./`, because actionlint 1.7.12
 * cannot parse `$/` (rhysd/actionlint#711, #732), and so checks no input of a `$/` call.
 * Kanon's CI didn't run actionlint at all, so the review lane's reads of hook outputs the
 * hook contract doesn't define (#77) stayed green.
 *
 * These cases SPAWN the real wrapper, so they run the real pinned binary: it is downloaded
 * once (checksum-verified) into ACTIONLINT_CACHE_DIR, which in CI the actionlint step of the
 * checks job has already filled before the unit tests run.
 */
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const WRAPPER = join(REPO, '.github/scripts/actionlint.sh');
const TIMEOUT = 120_000;
const version = /^ACTIONLINT_VERSION=(\S+)$/m.exec(readFileSync(WRAPPER, 'utf8'))?.[1];

function run(root: string, args: string[] = []) {
  const r = spawnSync('bash', [WRAPPER, ...args], {
    cwd: REPO, encoding: 'utf8', timeout: TIMEOUT,
    env: { ...process.env, ACTIONLINT_ROOT: root },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** One digest over every path and byte under `<root>/.github`. */
function hashGithub(root: string): string {
  const h = createHash('sha256');
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  for (const f of walk(join(root, '.github')).sort()) {
    h.update(relative(root, f)).update('\0').update(readFileSync(f)).update('\0');
  }
  return h.digest('hex');
}

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const BLOCK = `name: blk
description: fixture block
inputs:
  arm:
    description: the arm
    required: true
runs:
  using: composite
  steps:
    - run: echo hi
      shell: bash
`;

/** A repository whose one workflow calls a local block through `$/`, with `with:` as given. */
function fixture(withLines: string[], dir = '.github/actions/blk'): string {
  const root = mkdtempSync(join(tmpdir(), 'actionlint-77-'));
  dirs.push(root);
  mkdirSync(join(root, dir), { recursive: true });
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(join(root, dir, 'action.yml'), BLOCK);
  const call = [`      - uses: $/${dir}`, ...(withLines.length ? ['        with:', ...withLines.map((l) => `          ${l}`)] : [])];
  writeFileSync(join(root, '.github/workflows/w.yml'), [
    'name: w', 'on: workflow_dispatch', 'jobs:', '  j:', '    runs-on: ubuntu-latest', '    steps:', ...call, '',
  ].join('\n'));
  return root;
}

describe('the actionlint wrapper checks `$/` block calls (#77)', () => {
  it('passes on the current tree, and leaves the real .github/ byte for byte as it was', () => {
    const before = hashGithub(REPO);
    const r = run(REPO);
    expect(r.out).toBe('');
    expect(r.code, r.out).toBe(0);
    expect(hashGithub(REPO)).toBe(before);
  }, TIMEOUT);

  it('goes red on an undeclared input to a `$/` call, at the real file and line', () => {
    const root = fixture(['arm: x', 'bogus: y']);
    const before = hashGithub(root);
    const r = run(root, ['-oneline']);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/input "bogus" is not defined in action "blk"/);
    // The red is the input check, not the `$/` parse error the shim exists to avoid.
    expect(r.out).not.toContain('ref is missing');
    // Mapped back: the reported path and line name the real file's `bogus:` line.
    const m = /^(\S+):(\d+):(\d+): input "bogus"/m.exec(r.out);
    expect(m, r.out).not.toBeNull();
    const [, file, line] = m!;
    expect(readFileSync(join(root, file!), 'utf8').split('\n')[Number(line) - 1]).toMatch(/^\s+bogus: y$/);
    expect(r.out).not.toMatch(/actionlint-dollar\./);
    expect(hashGithub(root), 'the wrapper wrote to the .github/ it was pointed at').toBe(before);
  }, TIMEOUT);

  it("checks a `$/` call to an action under actions/, where Kanon's own actions live", () => {
    const r = run(fixture(['arm: x', 'bogus: y'], 'actions/blk'), ['-oneline']);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/^\.github\/workflows\/w\.yml:10:\d+: input "bogus" is not defined in action "blk"/m);
  }, TIMEOUT);

  it('passes the same call when every input is declared (the control)', () => {
    const r = run(fixture(['arm: x']));
    expect(r.out).toBe('');
    expect(r.code, r.out).toBe(0);
  }, TIMEOUT);

  it('quotes the real `$/` line, not the rewritten copy, in a snippet', () => {
    // A missing required input is reported on the `uses:` line itself.
    const r = run(fixture([]));
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/missing input "arm"/);
    expect(r.out).toMatch(/^\s*7 \|\s+- uses: \$\/\.github\/actions\/blk$/m);
    expect(r.out).not.toMatch(/\| .*uses: \.\/\.github\/actions\/blk/);
  }, TIMEOUT);

  it('names the real block path, never the temp copy, when a block does not parse', () => {
    // actionlint prints this one ABSOLUTE, so it is the case the root mapping exists for.
    const root = fixture(['arm: x']);
    writeFileSync(join(root, '.github/actions/blk/action.yml'), 'name: [\n');
    const r = run(root, ['-oneline']);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(`could not parse action metadata in "${realpathSync(root)}/.github/actions/blk"`);
    expect(r.out).not.toMatch(/actionlint-dollar\./);
  }, TIMEOUT);
});

describe('the actionlint wrapper keeps its own failures apart from findings (#77)', () => {
  it('exits 3, not 1, when the wrapper itself cannot run', () => {
    const root = mkdtempSync(join(tmpdir(), 'actionlint-77-'));
    dirs.push(root);
    const r = run(root);
    expect(r.code, r.out).toBe(3);
    expect(r.out).toContain('no .github/ under');
  }, TIMEOUT);

  it('never runs a cached binary whose sha256 is not the pinned one', () => {
    // A stand-in that claims the pinned version and leaves a mark if it is ever executed.
    const cache = mkdtempSync(join(tmpdir(), 'actionlint-77-cache-'));
    dirs.push(cache);
    const mark = join(cache, 'ran');
    mkdirSync(join(cache, version!), { recursive: true });
    writeStub(join(cache, version!, 'actionlint'), `#!/usr/bin/env bash\ntouch '${mark}'\necho ${version}\nexit 0\n`);
    const r = spawnSync('bash', [WRAPPER], {
      cwd: REPO, encoding: 'utf8', timeout: TIMEOUT,
      env: { ...process.env, ACTIONLINT_ROOT: fixture(['arm: x', 'bogus: y']), ACTIONLINT_CACHE_DIR: cache },
    });
    expect(existsSync(mark), 'the tampered binary was executed').toBe(false);
    // It was replaced by the verified one, which finds the bad input.
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
    expect(r.stdout).toMatch(/input "bogus" is not defined/);
  }, TIMEOUT);
});

describe('CI runs the wrapper with a pinned, cached binary and no credentials (#77)', () => {
  type Step = { id?: string; name?: string; run?: string; uses?: string; if?: string; with?: Record<string, string>; env?: Record<string, string> };
  const ci = parse(readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8'));
  const steps = ci.jobs.checks.steps as Step[];
  const at = steps.findIndex((s) => s.run === 'bash .github/scripts/actionlint.sh');

  it('runs the wrapper in the checks job, before the unit tests', () => {
    expect(at, 'no step runs the wrapper').toBeGreaterThan(-1);
    expect(at).toBeLessThan(steps.findIndex((s) => s.run === 'npm test'));
    expect(steps[at]?.env ?? {}, 'the step needs no token or secret').toEqual({});
  });

  it('restores the binary under a key that names the pinned version, and saves it even on a red', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const restore = steps.slice(0, at).find((s) => s.uses?.startsWith('actions/cache/restore@'));
    expect(restore, 'no actions/cache/restore step before the wrapper').toBeTruthy();
    expect(restore!.with?.key).toContain(`actionlint-${version}-`);
    expect(restore!.with?.path).toBe('~/.cache/kanon-actionlint');
    const save = steps.slice(at + 1).find((s) => s.uses?.startsWith('actions/cache/save@'));
    expect(save, 'no actions/cache/save step after the wrapper').toBeTruthy();
    expect(save!.with?.path).toBe(restore!.with?.path);
    expect(save!.with?.key).toContain(`steps.${restore!.id}.outputs.cache-primary-key`);
    // Saving only on success would re-download on every push of a red PR.
    expect(save!.if ?? '').not.toMatch(/success\(\)/);
    expect(save!.if ?? '').toContain("steps.actionlint.outcome != 'skipped'");
  });
});
