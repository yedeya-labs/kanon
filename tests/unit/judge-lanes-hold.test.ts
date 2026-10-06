import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Plan 0005 §3.3, the `holdOn` row (step L4). Since L4 the Merger shares the Judge App with
 * the Reviewer, and a label event has no body, so the Merger can't tell its own `needs:human`
 * from one another Judge lane applied. It lifts a hold only when the label's last actor is the
 * Judge AND every Merger escalation on the PR is about another head
 * (`tests/library/two-apps.test.ts`). That stays safe only while no FIXED step of another
 * Judge lane (the review lane and the merge-reconcile lane) applies the label: this fails
 * when one does.
 *
 * It reads the fixed steps, not the agent. The Reviewer's agent holds Pull requests write and
 * could apply the label; such a label has no lapsed Merger escalation behind it, so it is
 * never lifted. It holds a PR for a person and can't release one.
 */

const ROOT = process.cwd();

/** Every file a Judge lane's fixed steps run, other than the Merger's own lane. */
const JUDGE_LANES = [
  '.github/workflows/agent-review.yml',
  '.github/workflows/review-agent-job.yml',
  '.github/workflows/review-run.yml',
  '.github/workflows/agent-merge-reconcile.yml',
  '.github/workflows/merge-reconcile-agent-job.yml',
  '.github/workflows/merge-reconcile-run.yml',
  // The spine and the blocks both lanes' agent jobs run through.
  '.github/workflows/lane-agent-job.yml',
];

/** Drop comment lines (`#`, `//`, a JSDoc `*`), so prose about the label is not a step that applies it. */
const code = (text: string) => text.split('\n').filter((l) => !/^\s*(#|\/\/|\*|\/\*)/.test(l)).join('\n');

/** A script a step runs: JavaScript, shell or awk. */
const SCRIPT = String.raw`[\w./-]+\.(?:mjs|sh|awk)`;

/**
 * The files a workflow or script runs, by path, in every spelling the lanes use (kanon#338):
 * Kanon's checkout as `$KANON/…` or `$KANON_PATH/…` (braced or not); `uses: $/actions/…` and
 * `uses: $/.github/workflows/…`; an action's own directory as `$GITHUB_ACTION_PATH/…` or
 * `${{ github.action_path }}/…`; a shell script's own directory as `$HERE/…`; and an `.mjs`
 * file's relative imports. A form missing here is a file the guard never reads.
 */
function reaches(file: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(String.raw`\$\{?KANON(?:_PATH)?\}?\/((?:scripts|actions|cli)\/${SCRIPT})`, 'g'))) out.push(m[1]!);
  for (const m of text.matchAll(/uses:\s*\$\/(actions\/[\w-]+)/g)) out.push(`${m[1]}/action.yml`);
  for (const m of text.matchAll(/uses:\s*\$\/(\.github\/workflows\/[\w-]+\.yml)/g)) out.push(m[1]!);
  for (const m of text.matchAll(new RegExp(String.raw`(?:(?:\$\{?)?GITHUB_ACTION_PATH\}?|\$\{\{\s*github\.action_path\s*\}\})\/(${SCRIPT})`, 'g'))) {
    out.push(join(dirname(file), m[1]!));
  }
  if (file.endsWith('.sh')) {
    for (const m of text.matchAll(new RegExp(String.raw`\$\{?HERE\}?\/(${SCRIPT})`, 'gi'))) out.push(join(dirname(file), m[1]!));
  }
  if (file.endsWith('.mjs')) {
    for (const m of text.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+'(\.[^']+)'/g)) out.push(join(dirname(file), m[1]!));
    for (const m of text.matchAll(/import\('(\.[^']+)'\)/g)) out.push(join(dirname(file), m[1]!));
  }
  return out.map((p) => resolve(ROOT, p).slice(ROOT.length + 1));
}

function closure(): Map<string, string> {
  const seen = new Map<string, string>();
  const todo = [...JUDGE_LANES];
  while (todo.length) {
    const file = todo.pop()!;
    if (seen.has(file) || !existsSync(join(ROOT, file))) continue;
    const text = readFileSync(join(ROOT, file), 'utf8');
    seen.set(file, text);
    todo.push(...reaches(file, text));
  }
  return seen;
}

describe('plan 0005 L4: no fixed step of another Judge lane applies `needs:human`', () => {
  const files = closure();

  it('reads the lanes, the spine, the blocks and the scripts they run', () => {
    for (const lane of JUDGE_LANES) expect(files.has(lane), lane).toBe(true);
    expect([...files.keys()].some((f) => f.startsWith('scripts/'))).toBe(true);
    expect([...files.keys()].some((f) => f.startsWith('actions/'))).toBe(true);
  });

  it("follows `$KANON_PATH` and a shell script's own directory into the scripts they run (kanon#338)", () => {
    // `review-agent-job.yml` runs this as `bash "$KANON_PATH/scripts/restore-judging-inputs.sh"`,
    // and it runs `node "$HERE/judging-inputs.mjs"` and `bash "$HERE/../actions/agent-setup/declaration-defaults.sh"`.
    expect(files.has('scripts/restore-judging-inputs.sh')).toBe(true);
    expect(files.has('actions/agent-setup/declaration-defaults.sh')).toBe(true);
  });

  it('reads every spelling of an entry point (kanon#338)', () => {
    const step = [
      'node "$KANON/scripts/a.mjs"',
      'bash "${KANON_PATH}/scripts/b.sh"',
      'awk -f "$KANON/actions/c/c.awk"',
      'node "$KANON/cli/d.mjs"',
      'node "${{ github.action_path }}/e.mjs"',
      'bash "$GITHUB_ACTION_PATH/f.sh"',
    ].join('\n');
    expect(reaches('actions/x/action.yml', step).sort()).toEqual(
      ['actions/c/c.awk', 'actions/x/e.mjs', 'actions/x/f.sh', 'cli/d.mjs', 'scripts/a.mjs', 'scripts/b.sh'],
    );
    expect(reaches('scripts/x.sh', 'node "$HERE/g.mjs"\nbash "$HERE/../actions/y/h.sh"')).toEqual(['scripts/g.mjs', 'actions/y/h.sh']);
  });

  it('never names the label outside a comment, in any of them', () => {
    const named = [...files].filter(([, text]) => code(text).includes('needs:human')).map(([f]) => f);
    expect(named).toEqual([]);
  });
});
