import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import ts from 'typescript';
import { parse } from 'yaml';

/**
 * kanon#730: what this tree's code a Kanon workflow runs with a credential, and by which path.
 *
 * The Merger merges an Implementer pull request that touches only the green zone
 * (`docs/qa/escalation-paths.md`, ADR 0011 as amended on 2026-10-12). The lane callers run the
 * library at the release they pin (`yedeya-labs/kanon/…@vX`), so a green-zone change reaches them
 * only through the release pull request. A workflow that runs this tree instead, through `$/`,
 * `./` or a checkout of this repository, runs whatever `main` holds: every file such a job runs
 * or imports, while it holds a credential, must escalate, or the Merger could land code into it.
 *
 * `credentialReach` walks every workflow under `.github/workflows/` that a non-pull-request
 * event starts on this repository's branch (a `pull_request` or `merge_group` run executes the
 * pull request's own code before anything merges, which no escalation path can guard). A job or
 * step that uses a Kanon reusable workflow or action at a release tag runs that release and is
 * not followed; at any other ref, through `$/` or through `./`, it runs this tree and is. For
 * each job it computes what the job holds:
 *
 * - its effective `permissions:`: its own, else its workflow's, capped by the caller's grant when
 *   the workflow is called; a root job with neither holds the repository default, read here as
 *   `write-all`;
 * - the secrets it can read: a root workflow's secrets are all real; a called workflow's are the
 *   ones its caller maps from a real one (`secrets: inherit` maps them all).
 *
 * A job holds a credential when it is granted any `write` scope (`id-token: write` among them) or
 * reads a real secret (an App's key, which mints its token, among them). A called workflow is
 * followed with its caller's grant and secrets.
 *
 * A job runs unless its `if:`, read under each event that starts its root workflow, can't hold
 * (`evaluateIf`): so the lanes `agent-lanes-smoke.yml` calls on a push run only their jobs that
 * a push admits, which the workflows under `.github/` decide, themselves always the Owner's.
 *
 * In a credential-holding job, the entry files are the paths its steps execute under `$KANON`,
 * `$KANON_PATH`, `$KANON_ROOT`, `$GITHUB_WORKSPACE`, `process.env.KANON` or after
 * `node`/`bash`/`sh`/`source` relative to the checkout, and those the composite actions it uses
 * from this tree execute (under `$GITHUB_ACTION_PATH` or `github.action_path`), with their own
 * composite actions. From each entry it follows, transitively: every string in a module's code,
 * never its comments, that is a relative specifier it imports, requires or resolves, or that
 * names a code file next to it or at the root (a script it spawns); and a shell script's tokens,
 * its comment lines aside, naming a code file next to it or at the root. It over-approximates on
 * purpose: a string that names a file it never runs still counts.
 */

export const ROOT = process.cwd();
const WORKFLOWS = '.github/workflows';
const CODE = /\.(?:mjs|cjs|js|ts|sh|awk)$/;

type Perms = Record<string, string>;
type Step = { uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
type Job = {
  if?: unknown;
  needs?: string | string[];
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: 'inherit' | Record<string, string>;
  permissions?: Perms | string;
  steps?: Step[];
  env?: Record<string, unknown>;
};
type Workflow = { on?: unknown; permissions?: Perms | string; jobs: Record<string, Job> };

/** Every secret readable (`all`), or the names that hold a real one. */
type Secrets = 'all' | ReadonlySet<string>;

/** One file reached, and the chain from the job that runs it. */
export type Reach = { file: string; workflow: string; job: string; via: string[] };

const LEVEL: Record<string, number> = { none: 0, read: 1, write: 2 };

function normPerms(p: Perms | string | undefined): Perms | undefined {
  if (p === undefined) return undefined;
  if (typeof p === 'string') {
    if (p === 'write-all') return { '*': 'write' };
    if (p === 'read-all') return { '*': 'read' };
    return {};
  }
  return { ...p };
}
const level = (p: Perms, scope: string) => LEVEL[p[scope] ?? p['*'] ?? 'none'] ?? 0;
/** `own` capped by `caller`, scope by scope. */
function cap(own: Perms, caller: Perms): Perms {
  const out: Perms = {};
  for (const scope of new Set([...Object.keys(own), ...Object.keys(caller)])) {
    const l = Math.min(level(own, scope), level(caller, scope));
    out[scope] = ['none', 'read', 'write'][l]!;
  }
  return out;
}
const writes = (p: Perms) => Object.values(p).some((v) => v === 'write');

const secretRefs = (text: string) => [...text.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!);
const readsSecret = (text: string, secrets: Secrets) =>
  secretRefs(text).some((s) => s !== 'GITHUB_TOKEN' && (secrets === 'all' || secrets.has(s)));

/** The triggers that run this repository's own branch, not a pull request's code. */
export function ownBranchEvents(on: unknown): string[] {
  const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on.map(String) : Object.keys((on ?? {}) as object);
  return triggers.filter((t) => !['pull_request', 'merge_group', 'workflow_call'].includes(t));
}

const inTree = (abs: string) => {
  const rel = relative(ROOT, abs);
  return rel !== '' && !rel.startsWith('..') && !rel.split(sep).includes('node_modules');
};
const rel = (abs: string) => relative(ROOT, abs).split(sep).join('/');

/** This tree's files, with `overrides` (repository-relative path to text) laid over them. */
type Tree = { isFile: (abs: string) => boolean; text: (abs: string) => string };
function treeOf(overrides: Readonly<Record<string, string>> = {}): Tree {
  return {
    isFile: (abs) => rel(abs) in overrides || (existsSync(abs) && statSync(abs).isFile()),
    text: (abs) => overrides[rel(abs)] ?? readFileSync(abs, 'utf8'),
  };
}

/** The code files a `run:` text, or a composite action's, executes. */
export function runEntries(text: string, actionDir: string | null, tree: Tree = treeOf()): string[] {
  const out: string[] = [];
  const add = (base: string, p: string) => {
    const abs = normalize(join(base, p));
    if (CODE.test(abs) && inTree(abs) && tree.isFile(abs)) out.push(abs);
  };
  const PATH = String.raw`([\w.@/-]+)`;
  for (const m of text.matchAll(new RegExp(String.raw`(?:\$\{?(?:KANON|KANON_PATH|KANON_ROOT|GITHUB_WORKSPACE)\}?|process\.env\.(?:KANON|KANON_PATH|KANON_ROOT)\s*\+\s*['"\`])/${PATH}`, 'g'))) add(ROOT, m[1]!);
  if (actionDir) {
    for (const m of text.matchAll(new RegExp(String.raw`(?:\$\{?GITHUB_ACTION_PATH\}?|\$\{\{\s*github\.action_path\s*\}\})/${PATH}`, 'g'))) add(actionDir, m[1]!);
  }
  for (const m of text.matchAll(new RegExp(String.raw`(?:^|[\s;&|(])(?:node|bash|sh|source|\.)\s+(?:-[\w-]+\s+)*["']?((?:\./)?[\w.-]+/[\w.@/-]+)`, 'gm'))) add(ROOT, m[1]!);
  for (const m of text.matchAll(/(?:import\(|require\(|from)\s*['"`](\.{1,2}\/[^'"`]+)['"`]/g)) add(ROOT, m[1]!);
  return out;
}

/** The code files a reached file runs or imports, one step on. */
export function fileEntries(abs: string, tree: Tree = treeOf()): string[] {
  const text = tree.text(abs);
  const here = dirname(abs);
  const out = new Set<string>();
  const add = (base: string, p: string) => {
    const f = normalize(join(base, p));
    if (CODE.test(f) && inTree(f) && tree.isFile(f) && f !== abs) out.add(f);
  };
  if (/\.(?:sh|awk)$/.test(abs)) {
    // Its comment lines aside, every token naming a code file, next to it or from the root.
    const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    for (const m of code.matchAll(/((?:\.{1,2}\/)*[\w@-][\w.@/-]*\.(?:mjs|cjs|js|sh|awk))\b/g)) {
      add(here, m[1]!);
      add(ROOT, m[1]!);
    }
    for (const f of runEntries(code, here, tree)) out.add(f);
    return [...out];
  }
  // Every string in the module's code, never in its comments: a relative specifier it imports,
  // requires or resolves, and a code file it names, next to it or from the root, which it may
  // spawn. A TypeScript module is imported by its emitted extension.
  const source = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, false, /\.ts$/.test(abs) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const s = node.text;
      if (/^\.{1,2}\//.test(s)) {
        add(here, s);
        if (/\.js$/.test(s)) add(here, s.replace(/\.js$/, '.ts'));
      } else {
        const named = /([\w@-][\w.@/-]*\.(?:mjs|cjs|js|sh|awk))$/.exec(s.replace(/^\/+/, ''));
        if (named) {
          add(here, named[1]!);
          add(ROOT, named[1]!);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...out];
}

type Walk = { workflow: string; job: string; via: string[] };

/**
 * A job's `if:` under one event, in three values: `false` when it can't hold, `true` when it
 * must, `null` when this can't tell (it reads an input, a label, an output of a job that runs).
 * It reads only what a workflow decides statically: `github.event_name`, the status functions,
 * and the result and outputs of a needed job that never runs under this event (`skipped`, and
 * every output empty). Anything else is unknown, and an unknown `if:` runs. GitHub ANDs
 * `success()` into an `if:` that calls no status function, so a job whose needed job never runs
 * never runs either, unless its `if:` says `always()`, `failure()` or `!cancelled()`.
 */
type Val = { k: 'str'; v: string } | { k: 'bool'; v: boolean } | { k: 'num'; v: number } | { k: 'arr'; v: unknown[] } | { k: 'null' } | { k: 'unknown' };
const UNKNOWN: Val = { k: 'unknown' };
const truth = (v: Val): boolean | null => {
  switch (v.k) {
    case 'bool': return v.v;
    case 'str': return v.v !== '';
    case 'num': return v.v !== 0;
    case 'arr': return true;
    case 'null': return false;
    default: return null;
  }
};
const bool = (b: boolean | null): Val => (b === null ? UNKNOWN : { k: 'bool', v: b });
const NO_ITEM_EVENTS = ['push', 'schedule', 'workflow_dispatch'];
const STATUS = /\b(?:always|success|failure|cancelled)\s*\(/;

export type IfContext = { event: string; needs: readonly string[]; neverRuns: (job: string) => boolean };

export function evaluateIf(expression: unknown, ctx: IfContext): boolean | null {
  let text = expression === undefined || expression === null ? '' : String(expression).trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(text);
  if (wrapped) text = wrapped[1]!.trim();
  if (text === '') text = 'success()';
  else if (!STATUS.test(text)) text = `success() && (${text})`;
  try {
    return truth(new IfParser(text, ctx).parse());
  } catch {
    return null;
  }
}

class IfParser {
  private readonly tokens: string[];
  private i = 0;
  constructor(text: string, private readonly ctx: IfContext) {
    this.tokens = [...text.matchAll(/\s*('(?:[^']|'')*'|==|!=|<=|>=|&&|\|\||[!()<>,]|[A-Za-z_][\w.*-]*|\d+(?:\.\d+)?|\S)/g)].map((m) => m[1]!);
  }
  parse(): Val {
    const v = this.or();
    if (this.i !== this.tokens.length) throw new Error('trailing');
    return v;
  }
  private peek() { return this.tokens[this.i]; }
  private next() { return this.tokens[this.i++]; }
  private expect(t: string) { if (this.next() !== t) throw new Error(`expected ${t}`); }
  private or(): Val {
    const parts = [this.and()];
    while (this.peek() === '||') { this.next(); parts.push(this.and()); }
    if (parts.length === 1) return parts[0]!;
    const ts = parts.map(truth);
    return bool(ts.some((t) => t === true) ? true : ts.every((t) => t === false) ? false : null);
  }
  private and(): Val {
    const parts = [this.unary()];
    while (this.peek() === '&&') { this.next(); parts.push(this.unary()); }
    if (parts.length === 1) return parts[0]!;
    const ts = parts.map(truth);
    return bool(ts.some((t) => t === false) ? false : ts.every((t) => t === true) ? true : null);
  }
  private unary(): Val {
    if (this.peek() === '!') { this.next(); const t = truth(this.unary()); return bool(t === null ? null : !t); }
    return this.comparison();
  }
  private comparison(): Val {
    const left = this.primary();
    const op = this.peek();
    if (op !== '==' && op !== '!=') {
      if (op && ['<', '>', '<=', '>='].includes(op)) { this.next(); this.primary(); return UNKNOWN; }
      return left;
    }
    this.next();
    const right = this.primary();
    if (left.k === 'unknown' || right.k === 'unknown' || left.k === 'arr' || right.k === 'arr') return UNKNOWN;
    // Like types compare by value, strings ignoring case; unlike ones as numbers, as GitHub
    // coerces them (null is 0, a string that isn't a number is NaN, which equals nothing).
    const num = (v: Val) => (v.k === 'null' ? 0 : v.k === 'bool' ? Number(v.v) : v.k === 'num' ? v.v : v.k === 'str' ? (v.v.trim() === '' ? 0 : Number(v.v)) : NaN);
    const eq = left.k === right.k
      ? (left.k === 'str' ? left.v.toLowerCase() === (right as typeof left).v.toLowerCase() : left.k === 'null' || (left as { v: unknown }).v === (right as { v: unknown }).v)
      : num(left) === num(right);
    return bool(op === '==' ? eq : !eq);
  }
  private primary(): Val {
    const t = this.next();
    if (t === undefined) throw new Error('end');
    if (t === '(') { const v = this.or(); this.expect(')'); return v; }
    if (t.startsWith("'")) return { k: 'str', v: t.slice(1, -1).replace(/''/g, "'") };
    if (/^\d/.test(t)) return { k: 'num', v: Number(t) };
    if (t === 'true' || t === 'false') return { k: 'bool', v: t === 'true' };
    if (t === 'null') return { k: 'null' };
    if (!/^[A-Za-z_]/.test(t)) throw new Error(`token ${t}`);
    if (this.peek() === '(') {
      this.next();
      const args: Val[] = [];
      while (this.peek() !== ')') { args.push(this.or()); if (this.peek() === ',') this.next(); }
      this.expect(')');
      return this.call(t.toLowerCase(), args);
    }
    if (t === 'github.event_name') return { k: 'str', v: this.ctx.event };
    // A push, a schedule and a dispatch carry no label, review, pull request, issue, workflow run
    // or action in their payload.
    if (NO_ITEM_EVENTS.includes(this.ctx.event) && /^github\.event\.(?:label|review|pull_request|issue|workflow_run|action)(?:\.|$)/.test(t)) return { k: 'null' };
    const needs = /^needs\.([\w-]+)\.(result|outputs\.[\w-]+)$/.exec(t);
    if (needs && this.ctx.neverRuns(needs[1]!)) return { k: 'str', v: needs[2] === 'result' ? 'skipped' : '' };
    return UNKNOWN;
  }
  private call(fn: string, args: Val[]): Val {
    const allSkipped = this.ctx.needs.length > 0 && this.ctx.needs.every((n) => this.ctx.neverRuns(n));
    const anySkipped = this.ctx.needs.some((n) => this.ctx.neverRuns(n));
    switch (fn) {
      case 'always': return bool(true);
      case 'cancelled': return bool(false);
      case 'success': return bool(anySkipped ? false : this.ctx.needs.length === 0 ? true : null);
      case 'failure': return bool(allSkipped || this.ctx.needs.length === 0 ? false : null);
      case 'fromjson': {
        const a = args[0];
        if (a?.k !== 'str') return UNKNOWN;
        const v = JSON.parse(a.v) as unknown;
        return Array.isArray(v) ? { k: 'arr', v } : typeof v === 'string' ? { k: 'str', v } : UNKNOWN;
      }
      case 'contains': {
        const [hay, needle] = args;
        if (hay?.k === 'arr' && needle?.k === 'str') return bool(hay.v.some((x) => String(x).toLowerCase() === needle.v.toLowerCase()));
        if (hay?.k === 'str' && needle?.k === 'str') return bool(hay.v.toLowerCase().includes(needle.v.toLowerCase()));
        return UNKNOWN;
      }
      default: return UNKNOWN;
    }
  }
}

/** A Kanon release tag: what a pinned caller names. A branch or a commit of this tree isn't one. */
const RELEASE = /^v\d+\.\d+\.\d+$/;

/**
 * Where a `uses:` of Kanon's runs from: this tree's path (through `$/`, `./`, or
 * `yedeya-labs/kanon/…` at a ref that is not a release), or `null` when it runs a release or
 * another repository.
 */
function treePath(uses: string): string | null {
  const local = /^(?:\$\/|\.\/)(.+?)\/?$/.exec(uses);
  if (local) return local[1]!;
  const kanon = /^yedeya-labs\/kanon\/(.+?)\/?@(.+)$/.exec(uses);
  return kanon && !RELEASE.test(kanon[2]!) ? kanon[1]! : null;
}

/**
 * Every file this tree's credential-holding runs reach, with `overrides` (repository-relative
 * path to text, a workflow among them) laid over the tree, so a test can add an import or a step
 * and see what it reaches.
 */
export function credentialReach(overrides: Readonly<Record<string, string>> = {}): Reach[] {
  const tree = treeOf(overrides);
  const names = new Set([
    ...readdirSync(join(ROOT, WORKFLOWS)),
    ...Object.keys(overrides).filter((p) => p.startsWith(`${WORKFLOWS}/`)).map((p) => p.slice(WORKFLOWS.length + 1)),
  ]);
  const parsed: Record<string, Workflow> = {};
  for (const f of [...names].filter((f) => /^[^/]+\.ya?ml$/.test(f))) {
    const w = parse(tree.text(join(ROOT, WORKFLOWS, f))) as Workflow & { true?: unknown };
    parsed[f] = { ...w, on: w.on ?? w.true };
  }
  const reaches = new Map<string, Reach>();
  const follow = (entries: string[], w: Walk) => {
    const seen = new Set<string>();
    const queue = entries.map((abs) => ({ abs, via: w.via }));
    while (queue.length) {
      const { abs, via } = queue.shift()!;
      if (seen.has(abs)) continue;
      seen.add(abs);
      const key = `${rel(abs)}\0${w.workflow}\0${w.job}`;
      if (!reaches.has(key)) reaches.set(key, { file: rel(abs), workflow: w.workflow, job: w.job, via });
      for (const next of fileEntries(abs, tree)) queue.push({ abs: next, via: [...via, rel(abs)] });
    }
  };
  const actionDir = (uses: string): string | null => {
    const p = treePath(uses);
    if (p === null || p.startsWith(`${WORKFLOWS}/`)) return null;
    const dir = join(ROOT, p);
    return tree.isFile(join(dir, 'action.yml')) ? dir : null;
  };
  /** A step's entries: what its `run:` executes, what a script in its `with:` imports, and its composite action's. */
  const stepEntries = (s: Step, dir: string | null, depth: number): string[] => {
    const out: string[] = [];
    if (typeof s.run === 'string') out.push(...runEntries(s.run, dir, tree));
    if (s.with) out.push(...runEntries(JSON.stringify(s.with), null, tree));
    const inner = typeof s.uses === 'string' ? actionDir(s.uses) : null;
    if (inner && depth < 8) {
      const action = parse(tree.text(join(inner, 'action.yml'))) as { runs?: { steps?: Step[] } };
      for (const t of action.runs?.steps ?? []) out.push(...stepEntries(t, inner, depth + 1));
    }
    return out;
  };

  type Root = { workflow: string; job: string } | null;
  const walkWorkflow = (file: string, events: readonly string[], caller: Perms | null, secrets: Secrets, root: Root, chain: string[]) => {
    const wf = parsed[file];
    if (!wf || chain.length > 6) return;
    const wfPerms = normPerms(wf.permissions);
    const jobs = wf.jobs ?? {};
    const needsOf = (j: Job) => (j.needs === undefined ? [] : Array.isArray(j.needs) ? j.needs : [j.needs]);
    // The events under which each job may run, from its `if:` and its needed jobs'.
    const memo = new Map<string, string[]>();
    const runsUnder = (name: string, depth = 0): string[] => {
      const hit = memo.get(name);
      if (hit) return hit;
      const job = jobs[name];
      if (!job || depth > 50) return [...events];
      const needs = needsOf(job);
      const out = events.filter((event) => evaluateIf(job.if, { event, needs, neverRuns: (n) => !runsUnder(n, depth + 1).includes(event) }) !== false);
      memo.set(name, out);
      return out;
    };
    for (const [name, job] of Object.entries(jobs)) {
      const under = runsUnder(name);
      if (under.length === 0) continue;
      const own = normPerms(job.permissions) ?? wfPerms;
      const perms = caller === null ? (own ?? { '*': 'write' }) : own ? cap(own, caller) : caller;
      const at: Walk = root === null ? { workflow: file, job: name, via: [] } : { ...root, via: [...chain, `${file}:${name}`] };
      if (typeof job.uses === 'string') {
        const p = treePath(job.uses);
        const called = p === null ? null : new RegExp(`^${WORKFLOWS.replace(/\./g, '\\.')}/([^/]+\\.ya?ml)$`).exec(p);
        if (!called) continue; // a release, or another repository's
        const passed: Secrets = job.secrets === 'inherit' ? secrets
          : new Set(Object.entries(job.secrets ?? {}).filter(([, v]) => readsSecret(String(v), secrets)).map(([k]) => k));
        walkWorkflow(called[1]!, under, perms, passed, { workflow: at.workflow, job: at.job }, root === null ? [] : at.via);
        continue;
      }
      if (!writes(perms) && !readsSecret(JSON.stringify(job), secrets)) continue;
      follow((job.steps ?? []).flatMap((s) => stepEntries(s, null, 0)), at);
    }
  };

  for (const [file, wf] of Object.entries(parsed)) {
    const events = ownBranchEvents(wf.on);
    if (events.length > 0) walkWorkflow(file, events, null, 'all', null, []);
  }
  return [...reaches.values()].sort((a, b) => a.file.localeCompare(b.file) || a.workflow.localeCompare(b.workflow) || a.job.localeCompare(b.job));
}

/**
 * Each reached file no escalating path matches, by name, with the workflow and job that run it
 * and the chain that reaches it. `escalations` is what the Merger holds a pull request to.
 */
export function credentialProblems(reaches: readonly Reach[], escalations: ReadonlyArray<readonly [RegExp, string]>): string[] {
  return reaches
    .filter((r) => !escalations.some(([re]) => re.test(r.file)))
    .map((r) => `${r.file}: ${r.workflow}, job ${r.job}, runs it with a credential${r.via.length ? ` (through ${r.via.join(' > ')})` : ''}, from this tree, but no escalation path in docs/qa/escalation-paths.md matches it, so the Merger could merge a change to it`);
}
