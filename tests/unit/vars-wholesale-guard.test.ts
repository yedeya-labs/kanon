import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * kanon#479: no Kanon workflow or action hands a step the whole `vars` context.
 *
 * The runner prints a step's evaluated `with:` and `env:` at the head of its log, and masks only
 * secrets, never a variable. So a step given `toJSON(vars)` prints every repository and
 * organisation variable into the log, the ARNs and account ids among them: through v0.34.1 every
 * QA store step did (kanon#433). A step may name a variable it needs, `vars.NAME`, and nothing
 * wider: not `vars` itself, `toJSON(vars)`, `vars.*`, or `vars[<expression>]`, which can reach
 * any of them.
 *
 * It reads every workflow under .github/workflows, every action.yml outside tests/ and
 * node_modules/, and the YAML blocks of docs/, which hold the callers and hooks adopters copy.
 * In a parsed file it checks every string value, comments aside, and every `if:` as the bare
 * expression it may be.
 */

const ROOT = process.cwd();

/** The places an expression reads the `vars` context as a whole, or by a computed name. */
export const wholeVars = (expression: string): string[] => {
  // String literals can't read a context; emptied, so `vars['X']` stays a read by name.
  const code = expression.replace(/'(?:[^']|'')*'/g, "''");
  const found: string[] = [];
  for (const m of code.matchAll(/(?<![\w.-])vars(?![\w-])/g)) {
    const rest = code.slice(m.index + 4);
    if (/^\s*\.\s*[A-Za-z_][\w-]*/.test(rest) || /^\s*\[\s*''\s*\]/.test(rest)) continue;
    found.push(code.slice(m.index, m.index + 4 + Math.min(rest.length, 12)).trim());
  }
  return found;
};

/** The expressions in one string value: each `${{ … }}`, or the whole of a bare `if:`. */
const expressionsIn = (value: string, key: string): string[] => {
  const spans = [...value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]!);
  return spans.length ? spans : key === 'if' ? [value] : [];
};

type Hit = { at: string; expression: string };

/** Every expression in a parsed YAML document, with where it is, and each that reads `vars` whole. */
export const scan = (doc: unknown, file: string): { expressions: number; hits: Hit[] } => {
  let expressions = 0;
  const hits: Hit[] = [];
  const walk = (v: unknown, path: string, key: string) => {
    if (typeof v === 'string') {
      for (const e of expressionsIn(v, key)) {
        expressions += 1;
        if (wholeVars(e).length) hits.push({ at: `${file}: ${path}`, expression: e.trim() });
      }
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, k);
  };
  walk(doc, '', '');
  return { expressions, hits };
};

const walkFiles = (dir: string, keep: (f: string) => boolean): string[] =>
  readdirSync(join(ROOT, dir)).flatMap((n) => {
    const rel = join(dir, n);
    if (['node_modules', '.git', 'tests'].includes(n)) return [];
    return statSync(join(ROOT, rel)).isDirectory() ? walkFiles(rel, keep) : keep(rel) ? [rel] : [];
  });

const WORKFLOWS = readdirSync(join(ROOT, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`);
const ACTIONS = walkFiles('.', (f) => /(^|\/)action\.ya?ml$/.test(f));
/** Each ```yaml block of docs/, by the file and its block's number. */
const DOC_BLOCKS = walkFiles('docs', (f) => f.endsWith('.md')).flatMap((f) =>
  [...readFileSync(join(ROOT, f), 'utf8').matchAll(/^```ya?ml\n([\s\S]*?)^```/gm)].map((m, i) => ({ at: `${f} (YAML block ${i + 1})`, text: m[1]! })));

const parsed = (f: string) => parse(readFileSync(join(ROOT, f), 'utf8')) as unknown;

describe('no Kanon workflow or action hands a step the whole `vars` context (#479)', () => {
  it('reads the lanes, the blocks and the hooks it must, and the expressions in them', () => {
    for (const f of ['.github/workflows/agent-explore.yml', '.github/workflows/agent-code-audit.yml', '.github/workflows/agent-dispatch-sweep.yml', '.github/workflows/agent-overseer.yml', '.github/workflows/qa-store-aws-maintenance.yml']) expect(WORKFLOWS).toContain(f);
    for (const f of ['actions/qa-store/action.yml', '.github/actions/qa-store/action.yml', 'infra/qa-store/aws/action.yml']) expect(ACTIONS).toContain(f);
    expect(ACTIONS.some((f) => f.startsWith('tests/'))).toBe(false);
    expect(DOC_BLOCKS.some((b) => b.at.startsWith('docs/qa-store.md'))).toBe(true);
    const total = [...WORKFLOWS, ...ACTIONS].reduce((n, f) => n + scan(parsed(f), f).expressions, 0);
    expect(total).toBeGreaterThan(500);
  });

  it('finds none in any workflow or action', () => {
    expect([...WORKFLOWS, ...ACTIONS].flatMap((f) => scan(parsed(f), f).hits)).toEqual([]);
  });

  it('finds none in the YAML adopters copy from docs/', () => {
    const hits = DOC_BLOCKS.flatMap((b) => [...b.text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').matchAll(/\$\{\{([\s\S]*?)\}\}/g)]
      .filter((m) => wholeVars(m[1]!).length).map((m) => `${b.at}: ${m[0]}`));
    expect(hits).toEqual([]);
  });

  it('tells a read of the whole context from a read by name', () => {
    for (const red of ['toJSON(vars)', ' vars ', "fromJSON(toJSON(vars)).X", 'toJSON(vars.*)', 'vars[inputs.name]', "format('{0}', vars)", 'vars == null', "vars['A'] || vars"]) expect(wholeVars(red), red).not.toEqual([]);
    for (const green of ['vars.KANON_AGGREGATE_URL', "vars['KANON_X']", " vars . X ", "'toJSON(vars)'", 'steps.vars.outputs.x', 'inputs.variables', 'github.vars-x', "toJSON(secrets.QA_STORE_ROLE_ARN)"]) expect(wholeVars(green), green).toEqual([]);
  });

  // Each mutation puts back a path #479 removed, or a new one, and the guard must name it.
  describe('fails when a step is handed the whole context', () => {
    const lane = '.github/workflows/agent-explore.yml';
    type Doc = { jobs: Record<string, { if?: string; steps?: Array<Record<string, unknown> & { with?: Record<string, unknown>; env?: Record<string, unknown> }> }> };
    const mutate = (f: string, change: (d: Doc) => void) => {
      const d = parsed(f) as Doc;
      change(d);
      return scan(d, f).hits.map((h) => h.at);
    };
    const storeStep = (d: Doc) => Object.values(d.jobs).flatMap((j) => j.steps ?? []).find((s) => s.uses === '$/actions/qa-store')!;

    it("a lane's store step given `variables: ${{ toJSON(vars) }}` again", () => {
      expect(mutate(lane, (d) => { storeStep(d).with!.variables = '${{ toJSON(vars) }}'; })).toEqual([expect.stringMatching(/^\.github\/workflows\/agent-explore\.yml: jobs\.[\w-]+\.steps\[\d+\]\.with\.variables$/)]);
    });
    it('a step env given `${{ vars }}`', () => {
      expect(mutate(lane, (d) => { storeStep(d).env = { ALL: '${{ vars }}' }; })).toHaveLength(1);
    });
    it('a bare `if:` reading the whole context', () => {
      expect(mutate(lane, (d) => { Object.values(d.jobs)[0]!.if = "toJSON(vars) != '{}'"; })).toHaveLength(1);
    });
    it("the block's hook step handing `vars` on inside a composite action", () => {
      const block = 'actions/qa-store/action.yml';
      const d = parsed(block) as { runs: { steps: Array<{ uses?: string; with?: Record<string, unknown> }> } };
      d.runs.steps.find((s) => s.uses === './.github/actions/qa-store')!.with!.variables = '${{ toJSON(vars) }}';
      expect(scan(d, block).hits).toHaveLength(1);
    });
  });
});
