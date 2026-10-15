// Plan 0009 S4: `scripts/move-pins.mjs`, the edit Kanon's pin job and the upgrade skill share.
// On a fixture tree, every `yedeya-labs/kanon` pin under `.github/`, every `npx … kanon#` line
// and the plugin's `ref` move, and nothing else changes.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codeEnd, movePins, movePinsCli, moveSettings, moveText, RELEASE } from '../../scripts/move-pins.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/move-pins.mjs', import.meta.url));

// Every file of the fixture repository, before the move. `@v0.39.0` is the pin; everything
// that must stay put is spread among the lines that move.
const BEFORE: Record<string, string> = {
  '.github/workflows/review.yml': [
    'name: Review',
    'jobs:',
    '  review:',
    '    uses: yedeya-labs/kanon/.github/workflows/agent-review.yml@v0.39.0 # the lane at its release',
    '    secrets:',
    '      TOKEN: ${{ secrets.TOKEN }}',
    '',
  ].join('\n'),
  '.github/workflows/ci.yml': [
    'jobs:',
    '  check:',
    '    steps:',
    '      - uses: actions/checkout@v7',
    '      - uses: yedeya-labs/kanon/actions/lane-check@v0.39.0',
    "      - uses: 'yedeya-labs/kanon/actions/dco@v0.39.0'",
    '      - uses: $/actions/kanon-path',
    '      - uses: yedeya-labs/kanon/actions/pr-title@main',
    '      - uses: yedeya-labs/kanon-other/actions/x@v0.39.0',
    '      - uses: yedeya-labs/kanon/actions/pr-title@v0.39.0-rc.1',
    '      # - uses: yedeya-labs/kanon/actions/old@v0.38.0',
    '      - run: npx --yes --package github:yedeya-labs/kanon#v0.39.0 kanon doctor --json',
    '      - run: npx --yes --package github:yedeya-labs/kanon#candidate-v0.38.1 kanon doctor',
    '      - run: echo done # was npx --yes --package github:yedeya-labs/kanon#v0.38.0 kanon',
    '',
  ].join('\n'),
  '.github/actions/qa-store/action.yml': ['runs:', '  steps:', '    - uses: yedeya-labs/kanon/infra/qa-store/aws@v0.39.0', ''].join('\n'),
  '.github/scripts/check.sh': ['#!/usr/bin/env bash', '# yedeya-labs/kanon/actions/lane-check@v0.38.0 is the old one', 'echo yedeya-labs/kanon/actions/lane-check@v0.39.0', ''].join('\n'),
  '.github/dependabot.yml': ['# run Kanon\'s last release, `yedeya-labs/kanon/actions/…@vX.Y.Z`', 'updates: []', ''].join('\n'),
  '.claude/settings.json': `${JSON.stringify(
    {
      extraKnownMarketplaces: {
        kanon: { source: { source: 'github', repo: 'yedeya-labs/kanon', ref: 'v0.39.0' } },
        other: { source: { source: 'github', repo: 'acme/plugins', ref: 'v0.39.0' } },
      },
      enabledPlugins: { 'kanon@kanon': true },
    },
    null,
    2,
  )}\n`,
  // Outside `.github/` and the settings: never touched.
  'README.md': 'Pin `yedeya-labs/kanon/actions/dco@v0.39.0`.\n',
  'docs/install.md': 'npx --yes --package github:yedeya-labs/kanon#v0.39.0 kanon init\n',
  'workflows/elsewhere.yml': 'uses: yedeya-labs/kanon/actions/dco@v0.39.0\n',
};

// The same tree after a move to `candidate-v0.40.0`: only these lines differ.
const AFTER: Record<string, string> = {
  ...BEFORE,
  '.github/workflows/review.yml': (BEFORE['.github/workflows/review.yml'] ?? '').replace(
    'agent-review.yml@v0.39.0',
    'agent-review.yml@candidate-v0.40.0',
  ),
  '.github/workflows/ci.yml': [
    'jobs:',
    '  check:',
    '    steps:',
    '      - uses: actions/checkout@v7',
    '      - uses: yedeya-labs/kanon/actions/lane-check@candidate-v0.40.0',
    "      - uses: 'yedeya-labs/kanon/actions/dco@candidate-v0.40.0'",
    '      - uses: $/actions/kanon-path',
    '      - uses: yedeya-labs/kanon/actions/pr-title@main',
    '      - uses: yedeya-labs/kanon-other/actions/x@v0.39.0',
    '      - uses: yedeya-labs/kanon/actions/pr-title@v0.39.0-rc.1',
    '      # - uses: yedeya-labs/kanon/actions/old@v0.38.0',
    '      - run: npx --yes --package github:yedeya-labs/kanon#candidate-v0.40.0 kanon doctor --json',
    '      - run: npx --yes --package github:yedeya-labs/kanon#candidate-v0.40.0 kanon doctor',
    '      - run: echo done # was npx --yes --package github:yedeya-labs/kanon#v0.38.0 kanon',
    '',
  ].join('\n'),
  '.github/actions/qa-store/action.yml': (BEFORE['.github/actions/qa-store/action.yml'] ?? '').replace('@v0.39.0', '@candidate-v0.40.0'),
  '.github/scripts/check.sh': (BEFORE['.github/scripts/check.sh'] ?? '').replace('lane-check@v0.39.0', 'lane-check@candidate-v0.40.0'),
  '.claude/settings.json': (BEFORE['.claude/settings.json'] ?? '').replace(
    '"repo": "yedeya-labs/kanon",\n        "ref": "v0.39.0"',
    '"repo": "yedeya-labs/kanon",\n        "ref": "candidate-v0.40.0"',
  ),
};

const MOVED = ['.claude/settings.json', '.github/actions/qa-store/action.yml', '.github/scripts/check.sh', '.github/workflows/ci.yml', '.github/workflows/review.yml'];

let root = '';
const writeTree = (files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};
const readTree = (dir = root): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) Object.assign(out, readTree(path));
    else out[relative(root, path)] = readFileSync(path, 'utf8');
  }
  return out;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'move-pins-'));
  writeTree(BEFORE);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('move-pins on a fixture tree (plan 0009 S4)', () => {
  it('moves every Kanon pin under .github/, every npx kanon# line and the plugin ref, and nothing else', () => {
    const changed = movePins({ root, release: 'candidate-v0.40.0' });
    expect(changed.map((c) => c.path).sort()).toEqual(MOVED);
    expect(readTree()).toEqual(AFTER);
  });

  it("moves the plugin's ref in .claude/settings.json", () => {
    movePins({ root, release: 'candidate-v0.40.0' });
    const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
    expect(settings.extraKnownMarketplaces.kanon.source.ref).toBe('candidate-v0.40.0');
    expect(settings.extraKnownMarketplaces.other.source.ref).toBe('v0.39.0');
  });

  it('never moves a commented-out ref', () => {
    movePins({ root, release: 'candidate-v0.40.0' });
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('# - uses: yedeya-labs/kanon/actions/old@v0.38.0');
    expect(ci).toContain('# was npx --yes --package github:yedeya-labs/kanon#v0.38.0 kanon');
    expect(readFileSync(join(root, '.github/scripts/check.sh'), 'utf8')).toContain('# yedeya-labs/kanon/actions/lane-check@v0.38.0 is the old one');
  });

  it('is idempotent, and moves a candidate pin on to the stable tag', () => {
    movePins({ root, release: 'candidate-v0.40.0' });
    expect(movePins({ root, release: 'candidate-v0.40.0' })).toEqual([]);
    expect(readTree()).toEqual(AFTER);
    const back = movePins({ root, release: 'v0.40.0' });
    expect(back.map((c) => c.path).sort()).toEqual(MOVED);
    expect(readFileSync(join(root, '.github/workflows/review.yml'), 'utf8')).toContain('agent-review.yml@v0.40.0 #');
  });

  it('works without .claude/settings.json or .github/', () => {
    rmSync(join(root, '.claude'), { recursive: true });
    expect(movePins({ root, release: 'v0.40.0' }).map((c) => c.path)).not.toContain('.claude/settings.json');
    rmSync(join(root, '.github'), { recursive: true });
    expect(movePins({ root, release: 'v0.40.0' })).toEqual([]);
  });

  it('refuses a release that is not exact', () => {
    for (const bad of ['v0.40', 'v0', 'stable', 'candidate-v0.40.0x', 'v0.40.0-rc.1', 'main']) {
      expect(RELEASE.test(bad), bad).toBe(false);
      expect(() => movePins({ root, release: bad }), bad).toThrow(/not an exact release/);
    }
    expect(readTree()).toEqual(BEFORE);
  });
});

describe('the pieces', () => {
  it('a comment starts at a # at the line start or after whitespace, never inside kanon#', () => {
    expect(codeEnd('# all comment')).toBe(0);
    expect(codeEnd('  uses: x@v1 # note')).toBe(13);
    expect(codeEnd('npx github:yedeya-labs/kanon#v1.2.3 kanon')).toBe('npx github:yedeya-labs/kanon#v1.2.3 kanon'.length);
  });

  it('moveText counts what it moved', () => {
    expect(moveText('uses: yedeya-labs/kanon/actions/dco@v1.2.3\n', 'v1.3.0')).toEqual({ text: 'uses: yedeya-labs/kanon/actions/dco@v1.3.0\n', moved: 1 });
    expect(moveText('uses: yedeya-labs/kanon/actions/dco@v1.3.0\n', 'v1.3.0').moved).toBe(0);
  });

  it("moveSettings keeps the file's layout", () => {
    const text = '{"extraKnownMarketplaces":{"kanon":{"source":{"source":"github","repo":"yedeya-labs/kanon","ref":"v1.2.3"}}}}';
    expect(moveSettings(text, 'v1.3.0')).toEqual({ text: text.replace('v1.2.3', 'v1.3.0'), moved: 1 });
  });
});

describe('the CLI', () => {
  it('prints each file it changed, relative to --root', () => {
    const r = movePinsCli(['candidate-v0.40.0', '--root', root]);
    expect(r.code).toBe(0);
    expect(r.out.split('\n').sort()).toEqual(MOVED);
    expect(readTree()).toEqual(AFTER);
  });

  it('runs from the current directory, as the pin job runs it', () => {
    const r = spawnSync(process.execPath, [SCRIPT, 'candidate-v0.40.0'], { cwd: root, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n').sort()).toEqual(MOVED);
    expect(readTree()).toEqual(AFTER);
  });

  it('exits 2 on a release that is not exact, or none', () => {
    expect(movePinsCli(['v0.40', '--root', root]).code).toBe(2);
    expect(movePinsCli([], root).code).toBe(2);
    expect(readTree()).toEqual(BEFORE);
  });
});
