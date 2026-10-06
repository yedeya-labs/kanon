import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * kanon#54: no reference-adopter fact in the code the library runs.
 *
 * Kanon was extracted from one adopter, and its facts (its pipeline directory, its environment
 * and deploy workflow, its database port, its migration tool, its milestones, its personas,
 * its product's areas) kept turning up as constants that made that adopter's choice every
 * adopter's. Each moved to a file the adopter declares (`K-LAYOUT-8`, `K-LAYOUT-10`,
 * `K-LAYOUT-15` to `K-LAYOUT-17`). This test keeps them from coming back: it reads every
 * script, action and workflow Kanon ships, with comments removed, and fails on any of the
 * literals below. `infra/` is read too: the QA store's AWS implementation is shipped code,
 * which adopters provision and whose maintenance action the lanes call.
 *
 * COMMENTS ARE NOT READ. They are history: the library's comments record what a guard was
 * measured on, and that was the reference adopter's tree (`RA-N` references). A comment
 * changes no behaviour. A prompt is not a comment: it is a string the agent reads, so it is
 * scanned. The reference adopter's own names are kept out of the whole tree, comments
 * included, by `public-tree.test.ts`, which compares hashes so it doesn't publish them.
 *
 * AN EXCEPTION NAMES ITS FILE, ITS LITERAL AND WHY, and an exception that matches nothing
 * fails, so the list can only shrink.
 */

const LITERALS: ReadonlyArray<readonly [string, RegExp]> = [
  // `K-LAYOUT-8`'s `## Pipeline code`.
  ["the reference adopter's pipeline directory", /scripts\\?\/qa\b/],
  // `K-LAYOUT-10`'s reference environment and its deploy.
  ['its deploy workflow', /deploy-staging/i],
  ['its environment name', /\bstaging\b/i],
  // `K-LAYOUT-16` and `K-LAYOUT-17`: the stack is the project's.
  ['its database port', /\b5433\b/],
  ['its migration tool', /drizzle/i],
  ['its infrastructure file', /sst\.config/i],
  // `K-WORK-4`: the buckets' names are Kanon's; a roadmap milestone's is the project's.
  ['its roadmap milestones', /Production Ready|AI Capabilities|Development Ready/i],
  // Kanon names agents by role.
  ['its persona names', /\b(?:thomas|joshua|bezalel|oholiab)\b/i],
  // Its product's areas.
  ["its product's areas", /\b(?:storefront|kiosk|tenant)/i],
  // Its product's routes, as a prompt's example.
  ["its product's routes", /\/admin\/courses\b/i],
  // Its framework's and its domain's audit areas: `K-LAYOUT-17`'s `audit` descriptions are the project's.
  ["its framework's and domain's audit areas", /\b(?:payment paths|server actions)\b/i],
  // Its escalation paths (`K-LAYOUT-8`): where its payments and auth code live is the project's.
  // `payments` and `auth` themselves are two of Kanon's generic escalation categories (plan 0003
  // decision 14), so the category names, and the telemetry's `esc_payments` and `esc_auth`, are
  // not adopter facts and aren't matched: only a path into such code is.
  ['its payments and auth paths', /\b(?:src|app|lib|server)\\?\/\S*?(?:payments?|auth)/i],
  // Its test trees and the runner it gave each (ADR 0012's JavaScript row).
  ['its test trees', /\btests\|e2e\b|['"`]e2e\/['"`]|startsWith\(['"`](?:tests|e2e)\/['"`]\)/],
  // Its import alias, `@/` for `src/`.
  ['its import alias', /['"`]src\/['"`]\)/],
];

const ALLOWED: ReadonlyArray<readonly [string, string, string]> = [
  ['scripts/lib/protocol-spellings.mjs', 'its persona names',
    "the legacy spellings of Kanon's protocol markers, read so a marker written before the rename still parses"],
  ['scripts/lib/reference-deploy.mjs', 'its environment name',
    "the example the declaration's error message shows (`K-LAYOUT-10`)"],
  ['scripts/weekly-digest.mjs', 'its environment name',
    'the generic environment words the digest must not use ("staging", "production"): vocabulary, not a declaration'],
  ['infra/qa-store/aws/provision.mjs', 'its environment name',
    "the generic stage words a store resource's lifecycle must not name: vocabulary, not a declaration"],
  ['scripts/lib/test-conventions.mjs', 'its test trees',
    "ADR 0012's JavaScript row: tests under `tests/` and `e2e/`, run by Vitest and Playwright. Changing it revises the ADR, an Owner decision (kanon#54)"],
];

const SCANNED = /\.(?:mjs|cjs|js|yml|yaml|sh|awk)$/;
const files = execFileSync('git', ['ls-files', 'scripts', 'cli', 'actions', '.github', 'infra'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => SCANNED.test(f));

/** JavaScript with every comment blanked, line breaks kept, read by the TypeScript parser so a
 *  `//` inside a string or a regular expression is never taken for a comment. */
function jsCode(text: string): string {
  const sf = ts.createSourceFile('x.mjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const chars = text.split('');
  const blank = (r: ts.CommentRange) => { for (let i = r.pos; i < r.end; i++) if (chars[i] !== '\n') chars[i] = ' '; };
  const visit = (n: ts.Node) => {
    for (const r of ts.getLeadingCommentRanges(text, n.getFullStart()) ?? []) blank(r);
    for (const r of ts.getTrailingCommentRanges(text, n.getEnd()) ?? []) blank(r);
    for (const c of n.getChildren(sf)) visit(c);
  };
  visit(sf);
  return chars.join('');
}

/** YAML and shell with every whole-line `#` comment blanked. A prompt is a string, not a
 *  comment, so it is kept; a line of a prompt that starts with `#` would be dropped, which
 *  only ever hides a hit, never invents one. */
function hashCode(text: string): string {
  return text.split('\n').map((l) => (/^\s*#/.test(l) ? '' : l)).join('\n');
}

const code = (f: string) => {
  const text = readFileSync(f, 'utf8');
  return /\.(?:mjs|cjs|js)$/.test(f) ? jsCode(text) : hashCode(text);
};

const hits = files.flatMap((f) =>
  code(f).split('\n').flatMap((line, i) =>
    LITERALS.filter(([, re]) => re.test(line)).map(([name]) => ({ file: f, name, at: `${f}:${i + 1}: ${line.trim()}` })),
  ),
);
const allowed = (h: { file: string; name: string }) => ALLOWED.some(([f, n]) => f === h.file && n === h.name);

describe("the library's code names no reference-adopter fact (kanon#54)", () => {
  it.each(LITERALS.map(([name]) => name))('%s', (name) => {
    expect(hits.filter((h) => h.name === name && !allowed(h)).map((h) => h.at)).toEqual([]);
  });

  it('every exception still matches something, so the list only shrinks', () => {
    const stale = ALLOWED.filter(([f, n]) => !hits.some((h) => h.file === f && h.name === n));
    expect(stale.map(([f, n]) => `${f}: ${n}`)).toEqual([]);
  });

  it('every exception names a literal this test knows', () => {
    const names = new Set(LITERALS.map(([n]) => n));
    expect(ALLOWED.filter(([, n]) => !names.has(n))).toEqual([]);
  });
});

describe('the scan reads code and skips comments', () => {
  it('reads the scripts, the actions and the workflows', () => {
    for (const dir of ['scripts/', 'cli/', 'actions/', '.github/workflows/', 'infra/']) expect(files.some((f) => f.startsWith(dir))).toBe(true);
  });

  it('reads a string, and a regular expression holding `//`, as code', () => {
    const js = "const a = 'scripts/qa/x.mjs';\nconst b = /https?:\\/\\/x/; const c = 'deploy-staging';\n";
    expect(jsCode(js)).toBe(js);
  });

  it('blanks a line comment, a trailing comment and a block comment, and keeps the line count', () => {
    const js = '// scripts/qa\nconst a = 1; // staging\n/* drizzle\n   5433 */\nconst b = 2;\n';
    const out = jsCode(js);
    expect(out.split('\n')).toHaveLength(js.split('\n').length);
    for (const [, re] of LITERALS) expect(re.test(out)).toBe(false);
    expect(out).toContain('const a = 1;');
    expect(out).toContain('const b = 2;');
  });

  it("blanks a YAML comment and keeps a prompt's text", () => {
    const yml = '# staging\n  prompt: |\n    deploy to staging\n';
    expect(hashCode(yml)).toBe('\n  prompt: |\n    deploy to staging\n');
  });

  it("allows Kanon's escalation categories as names, and still catches a path into a project's payments or auth code", () => {
    const named = (line: string) => LITERALS.filter(([, re]) => re.test(line)).map(([n]) => n);
    expect(named("export const ESCALATION_CATEGORIES = Object.freeze(['pipeline', 'playbooks', 'infra', 'migrations', 'schema', 'payments', 'auth', 'other']);")).toEqual([]);
    expect(named('  esc_payments: bool, esc_auth: bool,')).toEqual([]);
    for (const line of ["const PAY = /^src\\/.*payments?/i;", "'src/lib/payments/charge.ts'", "if (f.startsWith('app/auth/')) return true;", "'server/session/auth.ts'"]) {
      expect(named(line), line).toEqual(['its payments and auth paths']);
    }
  });

  it('sees a known code line: the scan is not empty', () => {
    // The digest's environment rule is code, and holds the generic word on purpose.
    expect(hits.some((h) => h.file === 'scripts/weekly-digest.mjs' && h.name === 'its environment name')).toBe(true);
  });
});
