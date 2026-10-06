import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
 * NO CASE HERE REACHES THE NETWORK (#85). Every spawn puts a `curl` stub first on PATH, so
 * the wrapper's one download goes to the stub, never to github.com:
 *
 * - The wrapper's own behaviour (the pinned URL, both sha256 checks, the cache, the `$/`
 *   rewrite and the mapping back) is proven against a COPY of the wrapper whose pins for
 *   this platform are swapped for those of a locally built archive holding a stub binary.
 *   The swap lives only in that copy, so the real wrapper has no override CI could reach.
 * - The cases that need the REAL actionlint (does it check a rewritten call's inputs?) use
 *   the verified binary already in the default cache, and never download it: CI's actionlint
 *   step, which runs before `npm test`, is the one place that downloads. With no verified
 *   binary cached they are SKIPPED, by name, outside CI; in CI that is a failure, because the
 *   step before should have left one there.
 */
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const WRAPPER = join(REPO, '.github/scripts/actionlint.sh');
const TIMEOUT = 120_000;
const SOURCE = readFileSync(WRAPPER, 'utf8');
const version = /^ACTIONLINT_VERSION=(\S+)$/m.exec(SOURCE)?.[1];

const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8' }).stdout.trim();
// The same mapping as the wrapper's, from the same `uname`.
const OS = ({ Linux: 'linux', Darwin: 'darwin' } as Record<string, string>)[sh('uname', ['-s'])];
const ARCH = ({ x86_64: 'amd64', amd64: 'amd64', aarch64: 'arm64', arm64: 'arm64' } as Record<string, string>)[sh('uname', ['-m'])];
const PLATFORM = `${OS}_${ARCH}`;
/** The wrapper's pins for this platform: the first table is the archive's, the second the binary's. */
const PINS = [...SOURCE.matchAll(new RegExp(`^\\s*${PLATFORM}\\)\\s+echo ([0-9a-f]{64}) ;;$`, 'gm'))].map((m) => m[1]!);
const [ARCHIVE_PIN, BINARY_PIN] = PINS;

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** The verified binary the real-binary cases use, if CI's actionlint step (or a local run) left one. */
const CACHED = join(process.env.ACTIONLINT_CACHE_DIR ?? join(homedir(), '.cache/kanon-actionlint'), version ?? '', 'actionlint');
const REAL_BINARY = existsSync(CACHED) && sha256(CACHED) === BINARY_PIN;

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };

/**
 * A `curl` that never leaves the machine. It logs its arguments to `$CURL_LOG` and copies
 * `$CURL_SERVES` to the `-o` path; with nothing to serve it fails as an offline curl would.
 */
const NET = tmp('actionlint-85-net-');
writeStub(join(NET, 'curl'), `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "$CURL_LOG"
out=; while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
[ -n "\${CURL_SERVES:-}" ] && [ -n "$out" ] || { echo "curl stub: no network in unit tests" >&2; exit 7; }
cp "$CURL_SERVES" "$out"
`);

/** Spawn `wrapper` with the curl stub first on PATH. `curl` is what that stub was asked for, if anything. */
function spawn(wrapper: string, args: string[], env: Record<string, string>) {
  const curlLog = join(tmp('actionlint-85-log-'), 'curl');
  const r = spawnSync('bash', [wrapper, ...args], {
    cwd: REPO, encoding: 'utf8', timeout: TIMEOUT,
    env: { ...process.env, PATH: `${NET}:${process.env.PATH}`, CURL_LOG: curlLog, ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, curl: existsSync(curlLog) ? readFileSync(curlLog, 'utf8') : null };
}

/** The real wrapper with the real cached binary. It must never have to download. */
function run(root: string, args: string[] = []) {
  const r = spawn(WRAPPER, args, { ACTIONLINT_ROOT: root });
  expect(r.curl, 'a unit test reached for the network').toBeNull();
  return r;
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

const SKIP_REASON = `SKIPPED: no verified actionlint ${version} cached at ${CACHED}; \`bash .github/scripts/actionlint.sh\` fetches it`;
// In CI the actionlint step has just run, so a missing binary is a red, not a skip. Outside
// it the skip is said out loud, since a summary's "skipped" count alone names no reason.
it.runIf(!REAL_BINARY || !!process.env.CI)('has the verified binary to run the real-actionlint cases with', (ctx) => {
  if (!process.env.CI) ctx.skip(`the real-actionlint cases are ${SKIP_REASON}`);
  expect(REAL_BINARY, `${CACHED} is missing or not the pinned binary`).toBe(true);
});

describe.skipIf(!REAL_BINARY)('the actionlint wrapper checks `$/` block calls (#77)', () => {
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

/**
 * A copy of the wrapper that pins `archive` and `binary` for this platform in place of the
 * release's, and differs from the real one in nothing else.
 */
function forge(archive: string, binary: string): string {
  expect(PINS, `the wrapper pins ${PLATFORM} exactly once per table`).toHaveLength(2);
  expect(SOURCE.split(ARCHIVE_PIN!)).toHaveLength(2);
  expect(SOURCE.split(BINARY_PIN!)).toHaveLength(2);
  const path = join(tmp('actionlint-85-wrapper-'), 'actionlint.sh');
  writeFileSync(path, SOURCE.replace(ARCHIVE_PIN!, archive).replace(BINARY_PIN!, binary));
  return path;
}

/**
 * A release archive holding a stand-in `actionlint` that records where it ran, with what
 * arguments, and the workflow it was shown, then prints a finding as actionlint would: its
 * path absolute in the copy, its snippet the copy's (rewritten) line.
 */
function archive(tag: string): { tarball: string; binary: string } {
  const dir = tmp('actionlint-85-release-');
  const bin = join(dir, 'actionlint');
  writeFileSync(bin, `#!/usr/bin/env bash
# ${tag}
{ printf '%s\\n' "$PWD" "$@"; } > "$STUB_LOG"
cp .github/workflows/w.yml "$STUB_LOG.w.yml"
echo "$PWD/.github/workflows/w.yml:7:9: stand-in finding [stub]"
echo "   7 |       - uses: ./.github/actions/blk"
exit "\${STUB_RC:-0}"
`);
  chmodSync(bin, 0o755);
  const tarball = join(dir, 'release.tar.gz');
  const t = spawnSync('tar', ['-czf', tarball, '-C', dir, 'actionlint'], { encoding: 'utf8' });
  expect(t.status, t.stderr).toBe(0);
  return { tarball, binary: bin };
}

const GOOD = archive('good');
const OTHER = archive('other');

/** The forged wrapper over a `$/` fixture, with a fresh cache unless one is given. */
function fetchRun(o: { wrapper?: string; serves?: string; cache?: string; rc?: number; args?: string[]; root?: string } = {}) {
  const cache = o.cache ?? tmp('actionlint-85-cache-');
  const stubLog = join(tmp('actionlint-85-stub-'), 'ran');
  const root = o.root ?? fixture(['arm: x']);
  const r = spawn(o.wrapper ?? forge(sha256(GOOD.tarball), sha256(GOOD.binary)), o.args ?? [], {
    ACTIONLINT_ROOT: root, ACTIONLINT_CACHE_DIR: cache, STUB_LOG: stubLog, STUB_RC: String(o.rc ?? 0),
    ...(o.serves ? { CURL_SERVES: o.serves } : {}),
  });
  const cached = join(cache, version!, 'actionlint');
  return {
    ...r, root, cache, cached, stubLog,
    ran: existsSync(stubLog) ? readFileSync(stubLog, 'utf8').split('\n') : null,
    copy: existsSync(`${stubLog}.w.yml`) ? readFileSync(`${stubLog}.w.yml`, 'utf8') : null,
  };
}

describe('the actionlint wrapper gets, checks and caches its binary, with no network (#85)', () => {
  it('downloads the pinned version for this platform on a miss, verifies and caches it, then runs it', () => {
    const r = fetchRun({ serves: GOOD.tarball });
    expect(r.code, r.out).toBe(0);
    expect(r.curl?.split('\n')).toContain(
      `https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_${PLATFORM}.tar.gz`);
    expect(r.ran, 'the verified binary did not run').not.toBeNull();
    expect(sha256(r.cached)).toBe(sha256(GOOD.binary));
  }, TIMEOUT);

  it('runs a cached binary whose sha256 is the pinned one without downloading again', () => {
    const first = fetchRun({ serves: GOOD.tarball });
    const again = fetchRun({ cache: first.cache });
    expect(again.code, again.out).toBe(0);
    expect(again.curl, 'it downloaded although the cache held the pinned binary').toBeNull();
    expect(again.ran).not.toBeNull();
  }, TIMEOUT);

  it('never runs a cached binary whose sha256 is not the pinned one, and replaces it', () => {
    // A stand-in that claims the pinned version and leaves a mark if it is ever executed.
    const cache = tmp('actionlint-85-cache-');
    const mark = join(cache, 'ran');
    mkdirSync(join(cache, version!), { recursive: true });
    writeStub(join(cache, version!, 'actionlint'), `#!/usr/bin/env bash\ntouch '${mark}'\necho ${version}\nexit 0\n`);
    const r = fetchRun({ cache, serves: GOOD.tarball, rc: 1 });
    expect(existsSync(mark), 'the tampered binary was executed').toBe(false);
    expect(r.curl, 'the tampered binary was not replaced').not.toBeNull();
    expect(r.code, r.out).toBe(1);
    expect(r.ran).not.toBeNull();
    expect(sha256(r.cached)).toBe(sha256(GOOD.binary));
  }, TIMEOUT);

  it('refuses an archive whose sha256 is not the pinned one: exit 3, nothing cached, nothing run', () => {
    const r = fetchRun({ serves: OTHER.tarball });
    expect(r.code, r.out).toBe(3);
    expect(r.out).toContain(`archive checksum mismatch for actionlint ${version} ${PLATFORM}: got ${sha256(OTHER.tarball)}`);
    expect(existsSync(r.cached)).toBe(false);
    expect(r.ran).toBeNull();
  }, TIMEOUT);

  it('refuses a binary whose sha256 is not the pinned one, even from a verified archive', () => {
    const r = fetchRun({ serves: GOOD.tarball, wrapper: forge(sha256(GOOD.tarball), sha256(OTHER.binary)) });
    expect(r.code, r.out).toBe(3);
    expect(r.out).toContain(`binary checksum mismatch for actionlint ${version} ${PLATFORM}: got ${sha256(GOOD.binary)}`);
    expect(existsSync(r.cached)).toBe(false);
    expect(r.ran).toBeNull();
  }, TIMEOUT);

  it('exits 3, not 1, when the download fails', () => {
    const r = fetchRun();
    expect(r.code, r.out).toBe(3);
    expect(r.out).toContain(`download of actionlint ${version} failed`);
    expect(r.ran).toBeNull();
  }, TIMEOUT);

  it('exits 3, not 1, when the wrapper itself cannot run', () => {
    const r = fetchRun({ root: tmp('actionlint-77-') });
    expect(r.code, r.out).toBe(3);
    expect(r.out).toContain('no .github/ under');
    expect(r.curl).toBeNull();
  }, TIMEOUT);
});

describe('the actionlint wrapper rewrites `$/` in a copy only, and maps the output back (#85)', () => {
  it('shows the binary `./` on every `uses:` key, never in a comment, and leaves the real tree alone', () => {
    const root = fixture(['arm: x']);
    const w = join(root, '.github/workflows/w.yml');
    writeFileSync(w, `${readFileSync(w, 'utf8')}      - uses: '$/.github/actions/blk'\n        with:\n          arm: x\n# uses: $/kept\n`);
    const before = hashGithub(root);
    const r = fetchRun({ root, serves: GOOD.tarball, args: ['-oneline'] });
    expect(r.code, r.out).toBe(0);
    expect(r.copy).toContain('      - uses: ./.github/actions/blk\n');
    expect(r.copy).toContain("      - uses: './.github/actions/blk'\n");
    expect(r.copy).toContain('# uses: $/kept\n');
    expect(r.copy?.match(/\$\//g)).toHaveLength(1);
    expect(hashGithub(root), 'the wrapper wrote to the .github/ it was pointed at').toBe(before);
    // In the copy, with its flags first and the caller's after them.
    expect(r.ran![0]).toMatch(/\/actionlint-dollar\.[^/]+\/repo$/);
    expect(r.ran!.slice(1, 5)).toEqual(['-no-color', '-shellcheck=', '-pyflakes=', '-oneline']);
  }, TIMEOUT);

  it("maps the copy's path to the real one, quotes the real `$/` line, and passes the exit code through", () => {
    const root = fixture(['arm: x']);
    const r = fetchRun({ root, serves: GOOD.tarball, rc: 1 });
    expect(r.code, r.out).toBe(1);
    expect(r.stdout).toContain(`${realpathSync(root)}/.github/workflows/w.yml:7:9: stand-in finding [stub]\n`);
    expect(r.stdout).toMatch(/^ {3}7 \| {7}- uses: \$\/\.github\/actions\/blk$/m);
    expect(r.out).not.toMatch(/actionlint-dollar\./);
  }, TIMEOUT);
});

describe('CI runs the wrapper with a pinned, cached binary and no credentials (#77)', () => {
  type Step = { id?: string; name?: string; run?: string; uses?: string; if?: string; with?: Record<string, string>; env?: Record<string, string> };
  const ci = parse(readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8'));
  // The lint job (#407), whose result the required `Lint, type-check and unit tests` check reads.
  const steps = ci.jobs.lint.steps as Step[];
  const at = steps.findIndex((s) => s.run === 'bash .github/scripts/actionlint.sh');

  it('runs the wrapper in the lint job, which the required check needs', () => {
    expect(at, 'no step runs the wrapper').toBeGreaterThan(-1);
    expect([ci.jobs.checks.needs].flat()).toContain('lint');
    expect(steps[at]?.env ?? {}, 'the step needs no token or secret').toEqual({});
  });

  it('provisions the binary in every test shard, before the tests, since a missing one is a red in CI', () => {
    const unit = ci.jobs.unit.steps as Step[];
    const wrapper = unit.findIndex((s) => s.run === 'bash .github/scripts/actionlint.sh');
    expect(wrapper, 'the shard job never provisions the binary').toBeGreaterThan(-1);
    expect(wrapper).toBeLessThan(unit.findIndex((s) => /^npm test\b/m.test(s.run ?? '')));
    const restore = unit.slice(0, wrapper).find((s) => s.uses?.startsWith('actions/cache/restore@'));
    expect(restore?.with?.key).toBe(steps.find((s) => s.id === 'actionlint-cache')?.with?.key);
    expect(restore?.with?.path).toBe('~/.cache/kanon-actionlint');
    expect(unit[wrapper]?.env ?? {}, 'the step needs no token or secret').toEqual({});
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
