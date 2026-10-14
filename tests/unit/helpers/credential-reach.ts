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
 * step that uses a Kanon reusable workflow or action at a release tag runs that release; at any
 * other ref, through `$/` or through `./`, it runs this tree and is followed. A reusable workflow
 * called at a release tag is still walked, through this tree's copy of it, for what in it runs the
 * caller's checkout, this tree, on `main` (kanon#814): its steps' `uses: ./…` (the project-setup
 * hook among them), and any call it makes at a ref that is not a release; its `run:` steps and its
 * `$/` and `./` calls are the release's. For each job it computes what the job holds:
 *
 * - its effective `permissions:`: its own, else its workflow's, capped by the caller's grant when
 *   the workflow is called; a root job with neither holds the repository default, read here as
 *   `write-all`;
 * - the secrets it can read: a root workflow's secrets are all real, but those the caller names as
 *   never set; a called workflow's are the ones its caller maps from a real one (`secrets:
 *   inherit` maps them all), a hyphen in the name (`claude-token`) included. A secret the
 *   workflow's top-level `env:` reads is in every job's environment, so every job holds it;
 * - the credentials it is handed in a value (kanon#831): an output of a job it needs that holds
 *   one (a lane spine's mint job seals the App token it mints from the App's key into an output,
 *   and maps it to the agent's job as `app-token`), read in its `env:`, a step's or a call's
 *   `with:` or a call's `secrets:`; and, in a called workflow, an input its caller passed one in.
 *   A called workflow's outputs carry one when it was handed one, a real secret or such a value.
 *   An `if:` reads a value without handing it to the job, so it never counts.
 *
 * A job holds a credential when it is granted any `write` scope (`id-token: write` among them) or
 * reads a real secret (an App's key, which mints its token, among them), or such a value. A called
 * workflow is followed with its caller's grant, secrets and credential-carrying inputs.
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
 *
 * A package-manager command in such a job's `run:`, or in a shell script it reaches, reads
 * `package.json`, so that file is reached. `npm ci` and `npm install` run the root package's
 * install hooks; while `package.json` declares none, that is all they run from this tree. Any
 * other (`npm run`, `npm test`, `npm exec`, `npx`, `pnpm`, `yarn`), or an install with a hook,
 * runs files this guard can't name: it is reported as an unmodelled entry point, a problem whether
 * or not `package.json` escalates.
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
type Workflow = { on?: unknown; permissions?: Perms | string; env?: Record<string, unknown>; jobs: Record<string, Job> };

/** Every secret readable (`all`), or the names that hold a real one. */
type Secrets = 'all' | ReadonlySet<string>;

/**
 * One file reached, and the chain from the job that runs it. `unmodelled` names an entry point the
 * job uses that this guard does not follow (an `npm` command that runs `package.json`'s scripts):
 * such a reach is a problem whether or not its file escalates.
 */
export type Reach = { file: string; workflow: string; job: string; via: string[]; unmodelled?: string };

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

// A called workflow's secret may be named with a hyphen (`claude-token`), which a repository's can't.
const secretRefs = (text: string) => [...text.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map((m) => m[1]!);
// A called workflow's input, never a dispatch's `github.event.inputs`, and a needed job's output.
const inputRefs = (text: string) => [...text.matchAll(/(?<![\w.])inputs\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map((m) => m[1]!);
const outputRefs = (text: string) => [...text.matchAll(/\bneeds\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\b/g)].map((m) => m[1]!);

/** A job's text, its own and its steps' `if:` aside: a condition reads a value but never holds it. */
function heldText(job: Job): string {
  return JSON.stringify(job, (key, value: unknown) => (key === 'if' ? undefined : value));
}

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

/** A shell text's lines, its comment lines aside. */
const shellCode = (text: string) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

/** The npm lifecycle scripts `npm ci` and `npm install` run from the root `package.json`. */
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'];

/**
 * What a `run:` text's package-manager commands run from this tree: `package.json`, which every
 * one of them reads, and, for each command whose scripts this guard does not follow, why. `npm ci`
 * and `npm install` run only the root package's lifecycle hooks, so they are modelled while
 * `package.json` declares none; `npm run`, `npm test`, `npm exec`, `npx` and the other package
 * managers run a script or a binary this guard can't trace to files, so they never are.
 */
export function packageEntries(text: string, tree: Tree = treeOf()): { file: string; unmodelled?: string }[] {
  const out: { file: string; unmodelled?: string }[] = [];
  const pkgAbs = join(ROOT, 'package.json');
  for (const m of shellCode(text).matchAll(/(?:^|[\s;&|(`])(npm|npx|pnpm|yarn)(?![\w.-])(?:\s+(?:-[\w-]+(?:=\S+)?\s+)*([\w:-]+))?/gm)) {
    const [, tool, sub] = m;
    const command = sub ? `${tool} ${sub}` : tool!;
    if (tool === 'npm' && sub && ['ci', 'install', 'i', 'clean-install'].includes(sub)) {
      const scripts = tree.isFile(pkgAbs) ? ((JSON.parse(tree.text(pkgAbs)) as { scripts?: Record<string, string> }).scripts ?? {}) : {};
      const hooks = INSTALL_HOOKS.filter((h) => h in scripts);
      out.push(hooks.length ? { file: 'package.json', unmodelled: `\`${command}\` runs package.json's ${hooks.join(', ')} script` } : { file: 'package.json' });
    } else {
      out.push({ file: 'package.json', unmodelled: `\`${command}\` runs a package.json script or a binary` });
    }
  }
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
    const code = shellCode(text);
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
/** A Kanon reusable workflow called at a release tag, and its file name. */
const RELEASED = /^yedeya-labs\/kanon\/\.github\/workflows\/([^/]+\.ya?ml)@v\d+\.\d+\.\d+$/;
/** A reusable workflow named from its own repository, and its file name. */
const LOCAL_WORKFLOW = /^(?:\$\/|\.\/)\.github\/workflows\/([^/]+\.ya?ml)$/;

/** The files a job's steps execute, and its package-manager commands. */
type Entries = { files: string[]; packages: { file: string; unmodelled?: string }[] };

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
 * and see what it reaches. `options.unset` names the secrets the repository never sets (a smoke
 * run maps a lane's secrets to one), which a root workflow reads as empty.
 */
export function credentialReach(overrides: Readonly<Record<string, string>> = {}, options: { unset?: readonly string[] } = {}): Reach[] {
  const tree = treeOf(overrides);
  // A root workflow's secret is real unless the caller names it as one the repository never sets.
  const unset = new Set(options.unset ?? []);
  const readsSecret = (text: string, secrets: Secrets) =>
    secretRefs(text).some((s) => s !== 'GITHUB_TOKEN' && (secrets === 'all' ? !unset.has(s) : secrets.has(s)));
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
  // Each file is read once per call: many jobs reach the same files.
  const entryCache = new Map<string, string[]>();
  const entriesOf = (abs: string) => {
    let hit = entryCache.get(abs);
    if (!hit) entryCache.set(abs, (hit = fileEntries(abs, tree)));
    return hit;
  };
  const record = (file: string, w: Walk, via: string[], unmodelled?: string) => {
    const key = `${file}\0${w.workflow}\0${w.job}${unmodelled ? `\0${unmodelled}` : ''}`;
    if (!reaches.has(key)) reaches.set(key, { file, workflow: w.workflow, job: w.job, via, ...(unmodelled ? { unmodelled } : {}) });
  };
  const follow = (entries: Entries, w: Walk) => {
    for (const p of entries.packages) record(p.file, w, w.via, p.unmodelled);
    const seen = new Set<string>();
    const queue = entries.files.map((abs) => ({ abs, via: w.via }));
    while (queue.length) {
      const { abs, via } = queue.shift()!;
      if (seen.has(abs)) continue;
      seen.add(abs);
      record(rel(abs), w, via);
      // A shell script's package-manager commands, like a step's.
      if (/\.sh$/.test(abs)) for (const p of packageEntries(tree.text(abs), tree)) record(p.file, w, [...via, rel(abs)], p.unmodelled);
      for (const next of entriesOf(abs)) queue.push({ abs: next, via: [...via, rel(abs)] });
    }
  };
  const actionDir = (uses: string): string | null => {
    const p = treePath(uses);
    if (p === null || p.startsWith(`${WORKFLOWS}/`)) return null;
    const dir = join(ROOT, p);
    return tree.isFile(join(dir, 'action.yml')) ? dir : null;
  };
  /**
   * A step's entries: what its `run:` executes and the package-manager commands it runs, what a
   * script in its `with:` imports, and its composite action's. `pinned`, for a step of a
   * release's workflow: only a `uses: ./…` runs this tree (the caller's checkout), so only that
   * step is followed, and then its composite action in full.
   */
  const stepEntries = (s: Step, dir: string | null, depth: number, pinned = false): Entries => {
    const out: Entries = { files: [], packages: [] };
    const local = typeof s.uses === 'string' && /^\.\//.test(s.uses);
    if (pinned && !local) return out;
    if (typeof s.run === 'string') {
      out.files.push(...runEntries(s.run, dir, tree));
      out.packages.push(...packageEntries(s.run, tree));
    }
    if (s.with) out.files.push(...runEntries(JSON.stringify(s.with), null, tree));
    const inner = typeof s.uses === 'string' ? actionDir(s.uses) : null;
    if (inner && depth < 8) {
      const action = parse(tree.text(join(inner, 'action.yml'))) as { runs?: { steps?: Step[] } };
      for (const t of action.runs?.steps ?? []) {
        const e = stepEntries(t, inner, depth + 1);
        out.files.push(...e.files);
        out.packages.push(...e.packages);
      }
    }
    return out;
  };

  type Root = { workflow: string; job: string } | null;
  /**
   * `pinned`: `file` is the workflow a caller runs at a release tag. This tree's copy stands in for
   * the release, and only what in it runs the caller's checkout, this tree, is followed: a step's
   * `uses: ./…`, and a call that leaves the release for a non-release ref. A `./` or `$/` call
   * inside it stays in the release.
   */
  const walkWorkflow = (file: string, events: readonly string[], caller: Perms | null, secrets: Secrets, inputs: ReadonlySet<string>, root: Root, chain: string[], pinned = false) => {
    const wf = parsed[file];
    if (!wf || chain.length > 6) return;
    const wfPerms = normPerms(wf.permissions);
    // A workflow's top-level `env:` is every job's environment, so a secret it reads, each job holds.
    const wfEnv = JSON.stringify(wf.env ?? {});
    const jobs = wf.jobs ?? {};
    const needsOf = (j: Job) => (j.needs === undefined ? [] : Array.isArray(j.needs) ? j.needs : [j.needs]);
    // Whether a value hands a job a credential: a real secret, an input passed one, or an output of
    // a job it needs that holds one (kanon#831: the token a mint job seals into an output).
    const carrying = new Map<string, boolean>();
    const carries = (text: string, needs: readonly string[], depth = 0): boolean =>
      readsSecret(text, secrets)
      || inputRefs(text).some((i) => inputs.has(i))
      || outputRefs(text).some((n) => needs.includes(n) && outputsCarry(n, depth + 1));
    const outputsCarry = (name: string, depth: number): boolean => {
      const hit = carrying.get(name);
      if (hit !== undefined) return hit;
      const job = jobs[name];
      if (!job || depth > 50) return false;
      carrying.set(name, false);
      const needs = needsOf(job);
      // A called workflow's outputs may carry whatever it was handed; a job's, whatever it holds.
      const out = typeof job.uses === 'string'
        ? job.secrets === 'inherit'
          ? secrets === 'all' || secrets.size > 0 || Object.values(job.with ?? {}).some((v) => carries(String(v), needs, depth))
          : [...Object.values(job.secrets ?? {}), ...Object.values(job.with ?? {})].some((v) => carries(String(v), needs, depth))
        : carries(heldText(job) + wfEnv, needs, depth);
      carrying.set(name, out);
      return out;
    };
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
        const inRelease = pinned && /^(?:\$\/|\.\/)/.test(job.uses);
        const p = inRelease ? null : treePath(job.uses);
        const release = p === null ? RELEASED.exec(job.uses) : null;
        const called = p === null ? (release ? [release[0], release[1]] : inRelease ? LOCAL_WORKFLOW.exec(job.uses) : null)
          : new RegExp(`^${WORKFLOWS.replace(/\./g, '\\.')}/([^/]+\\.ya?ml)$`).exec(p);
        if (!called) continue; // another repository's
        const needs = needsOf(job);
        const passed: Secrets = job.secrets === 'inherit' ? secrets
          : new Set(Object.entries(job.secrets ?? {}).filter(([, v]) => carries(String(v), needs)).map(([k]) => k));
        const carried = new Set(Object.entries(job.with ?? {}).filter(([, v]) => carries(String(v), needs)).map(([k]) => k));
        walkWorkflow(called[1]!, under, perms, passed, carried, { workflow: at.workflow, job: at.job }, root === null ? [] : at.via, p === null);
        continue;
      }
      if (!writes(perms) && !carries(heldText(job) + wfEnv, needsOf(job))) continue;
      const entries: Entries = { files: [], packages: [] };
      for (const s of job.steps ?? []) {
        const e = stepEntries(s, null, 0, pinned);
        entries.files.push(...e.files);
        entries.packages.push(...e.packages);
      }
      follow(entries, at);
    }
  };

  for (const [file, wf] of Object.entries(parsed)) {
    const events = ownBranchEvents(wf.on);
    if (events.length > 0) walkWorkflow(file, events, null, 'all', new Set(), null, []);
  }
  return [...reaches.values()].sort((a, b) => a.file.localeCompare(b.file) || a.workflow.localeCompare(b.workflow) || a.job.localeCompare(b.job));
}

/**
 * Each reached file no escalating path matches, by name, with the workflow and job that run it
 * and the chain that reaches it. `escalations` is what the Merger holds a pull request to.
 */
export function credentialProblems(reaches: readonly Reach[], escalations: ReadonlyArray<readonly [RegExp, string]>): string[] {
  const through = (r: Reach) => (r.via.length ? ` (through ${r.via.join(' > ')})` : '');
  return reaches
    .filter((r) => r.unmodelled !== undefined || !escalations.some(([re]) => re.test(r.file)))
    .map((r) => (r.unmodelled !== undefined
      ? `${r.file}: ${r.workflow}, job ${r.job}, holds a credential and ${r.unmodelled}${through(r)}, an entry point this guard does not follow to the files it runs, so a green-zone file could run there unseen: model it in tests/unit/helpers/credential-reach.ts or drop the command`
      : `${r.file}: ${r.workflow}, job ${r.job}, runs it with a credential${through(r)}, from this tree, but no escalation path in docs/qa/escalation-paths.md matches it, so the Merger could merge a change to it`));
}
