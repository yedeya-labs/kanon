// `scripts/doc-pins.mjs`: the docs name the latest stable release, which exists. `move` is what
// the promotion runs once it tags one; `check`, in CI, fails a reference a reader can't install,
// as the README's `#v0.42.0` was for a week while 0.42.0 was only a candidate.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { docPinsCli, docProblems, moveDocText, readDocs, scanDoc } from '../../scripts/doc-pins.mjs';

const START = '<!-- x-release-please-start-version -->';
const END = '<!-- x-release-please-end -->';

const README = [
  '# A project',
  'Kanon 0.39.0 introduced this; the prose keeps its version.',
  START,
  '```sh',
  'claude plugin marketplace add yedeya-labs/kanon#v0.40.2',
  '```',
  END,
  '',
].join('\n');

const INSTALL = [
  START,
  '| Check | `uses: yedeya-labs/kanon/actions/dco@v0.40.2` |',
  '| Lane | `uses: yedeya-labs/kanon/.github/workflows/agent-review.yml@v0.40.2` |',
  END,
  '',
].join('\n');

const TAGS = new Set(['v0.40.1', 'v0.40.2']);

describe('scanDoc reads only the marked lines as pins', () => {
  it('finds the reference inside the markers, and nothing outside them', () => {
    const lines = scanDoc(README);
    expect(lines.filter((l) => l.covered && l.refs.length > 0).map((l) => l.refs)).toEqual([['v0.40.2']]);
    expect(lines.find((l) => l.text.includes('0.39.0'))?.covered).toBe(false);
  });
});

describe('moveDocText', () => {
  it('rewrites each marked reference to the release, and nothing else', () => {
    const moved = moveDocText(README, 'v0.42.0');
    expect(moved).toBe(README.replace('#v0.40.2', '#v0.42.0'));
    expect(moved).toContain('Kanon 0.39.0 introduced this');
  });

  it('moves every reference on a table of `uses:` lines', () => {
    expect(moveDocText(INSTALL, 'v0.42.0')).toBe(INSTALL.replaceAll('@v0.40.2', '@v0.42.0'));
  });
});

describe('docProblems', () => {
  const docs = [
    { path: 'README.md', text: README },
    { path: 'docs/install.md', text: INSTALL },
  ];

  it('passes docs that name one published stable release', () => {
    expect(docProblems(docs, TAGS)).toEqual([]);
  });

  it('fails a release that is not tagged yet, naming the file and line', () => {
    const problems = docProblems([{ path: 'README.md', text: moveDocText(README, 'v0.42.0') }], TAGS);
    expect(problems).toEqual(['README.md:5: v0.42.0 is not a published release of yedeya-labs/kanon; a reader who copies it gets an error']);
  });

  it('fails a candidate, even a published one', () => {
    const text = README.replace('#v0.40.2', '#candidate-v0.42.0');
    expect(docProblems([{ path: 'README.md', text }], new Set([...TAGS, 'candidate-v0.42.0']))).toEqual([
      'README.md:5: candidate-v0.42.0 is not a stable release; the docs name the latest stable release, vX.Y.Z',
    ]);
  });

  it('fails a reference outside the markers, which the promotion would leave behind', () => {
    const text = `${README}Or: \`uses: yedeya-labs/kanon/actions/dco@v0.40.2\`\n`;
    expect(docProblems([{ path: 'README.md', text }], TAGS)).toEqual([
      "README.md:8: v0.40.2 is outside the version markers, so the promotion can't move it",
    ]);
  });

  it('fails docs that name two releases, both published', () => {
    const problems = docProblems([docs[0] ?? { path: '', text: '' }, { path: 'docs/install.md', text: INSTALL.replaceAll('v0.40.2', 'v0.40.1') }], TAGS);
    expect(problems).toEqual(['the docs name 2 releases, v0.40.1, v0.40.2: they name one, the latest stable']);
  });
});

describe('the command, on a repository', () => {
  let root = '';
  const files: Record<string, string> = {
    'README.md': README,
    'docs/install.md': INSTALL,
    // Left out: the skills ship in the plugin and name their own release; the history keeps its.
    'skills/adopt/SKILL.md': `${START}\nclaude plugin marketplace add yedeya-labs/kanon#v0.43.0\n${END}\n`,
    'CHANGELOG.md': `${START}\nyedeya-labs/kanon#v0.1.0\n${END}\n`,
    'docs/notes.md': 'No reference here.\n',
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'doc-pins-'));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads the tracked documents with a reference, leaving out the skills and the history', () => {
    expect(readDocs(root).map((d) => d.path).sort()).toEqual(['README.md', 'docs/install.md']);
  });

  it('`move` rewrites the documents, prints each one it changed, and leaves the rest', () => {
    const { code, out } = docPinsCli(['move', 'v0.42.0', '--root', root]);
    expect(code).toBe(0);
    expect(out.split('\n').sort()).toEqual(['README.md', 'docs/install.md']);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('#v0.42.0');
    expect(readFileSync(join(root, 'skills/adopt/SKILL.md'), 'utf8')).toBe(files['skills/adopt/SKILL.md']);
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe(files['CHANGELOG.md']);
  });

  it('`move` refuses a candidate', () => {
    expect(docPinsCli(['move', 'candidate-v0.42.0', '--root', root]).code).toBe(2);
  });

  it('`check` passes on published pins and exits 1 once they name an unpublished one', () => {
    const tags = () => TAGS;
    expect(docPinsCli(['check', '--root', root], { tags }).code).toBe(0);
    docPinsCli(['move', 'v0.42.0', '--root', root]);
    const red = docPinsCli(['check', '--root', root], { tags });
    expect(red.code).toBe(1);
    expect(red.out).toContain('README.md:5: v0.42.0 is not a published release');
    expect(red.out).toContain('Fix: node scripts/doc-pins.mjs move');
  });

  it('exits 2 on a usage error', () => {
    expect(docPinsCli(['check', 'extra', '--root', root]).code).toBe(2);
    expect(docPinsCli([], { cwd: root }).code).toBe(2);
  });
});
