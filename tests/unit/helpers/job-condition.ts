/**
 * Can a job's `if:` hold when the jobs it reads have NOT admitted the event? (kanon#209)
 *
 * The membership-gate check (`tests/unit/lane-gate.test.ts`, `K-AGENT-45`) used to read a job's
 * `if:` as text and ask whether a verdict clause occurred in it. That passes
 * `needs.logins.outputs.member == 'true' || github.event_name == 'schedule'`, which runs on
 * every schedule with no gate behind it. So the condition is parsed and EVALUATED instead,
 * over every world in which no gate admitted:
 *
 *   - every clause that reads the event (`github.*`, `inputs.*`, `vars.*`, `cancelled()`) is a
 *     free boolean, tried both ways. Each is free on its own, so two clauses about the same
 *     field are never assumed to agree: that over-approximates, and errs towards a failure;
 *   - every job the caller says the gate never admitted (`refused`) concluded `success`,
 *     `skipped` or `failure`, with every output empty except `member`, which a refusing gate
 *     sets to `'false'`, and which is empty when the job did not run;
 *   - every job the caller says is held behind a refused gate (`held`) concluded `skipped`, with
 *     every output empty;
 *   - any other job a condition reads is free: its result is tried every way and its outputs
 *     are free clauses.
 *
 * With no status function in the `if:`, GitHub's implicit `success()` applies: the job starts
 * only when every job it needs succeeded.
 *
 * It THROWS on syntax or a function it does not model, so a new construct in a lane fails
 * here by name rather than being misread.
 */

type Node =
  | { kind: 'lit'; value: string | number | boolean | null; src: string }
  | { kind: 'ref'; path: string; src: string }
  | { kind: 'call'; name: string; args: Node[]; src: string }
  | { kind: 'not'; arg: Node; src: string }
  | { kind: 'and' | 'or'; left: Node; right: Node; src: string }
  | { kind: 'cmp'; op: string; left: Node; right: Node; src: string };

const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|('(?:[^']|'')*')|(==|!=|<=|>=|&&|\|\||[!<>(),])|([A-Za-z_][\w-]*(?:\.(?:[A-Za-z_][\w-]*|\*))*))/y;

const tokenize = (expr: string): { text: string; at: number }[] => {
  const out: { text: string; at: number }[] = [];
  TOKEN.lastIndex = 0;
  let at = 0;
  while (at < expr.length) {
    if (/^\s*$/.test(expr.slice(at))) break;
    TOKEN.lastIndex = at;
    const m = TOKEN.exec(expr);
    if (!m) throw new Error(`job condition: cannot read ${JSON.stringify(expr.slice(at))} in ${JSON.stringify(expr)}`);
    const text = m[1] ?? m[2] ?? m[3] ?? m[4]!;
    out.push({ text, at: m.index + m[0].length - text.length });
    at = TOKEN.lastIndex;
  }
  return out;
};

/** Parse a GitHub expression (the `${{ }}` already stripped, or never written). */
export const parseCondition = (expr: string): Node => {
  const toks = tokenize(expr);
  let i = 0;
  const peek = () => toks[i]?.text;
  const take = (want?: string) => {
    const t = toks[i];
    if (!t || (want !== undefined && t.text !== want)) throw new Error(`job condition: expected ${want ?? 'more'} at ${t ? t.at : 'end'} in ${JSON.stringify(expr)}`);
    i += 1;
    return t;
  };
  const srcOf = (from: number) => {
    const start = toks[from]!.at;
    const last = toks[i - 1]!;
    return expr.slice(start, last.at + last.text.length);
  };
  const binary = (kind: 'and' | 'or', op: string, next: () => Node) => (): Node => {
    const from = i;
    let left = next();
    while (peek() === op) {
      take();
      const right = next();
      left = { kind, left, right, src: srcOf(from) };
    }
    return left;
  };
  const primary = (): Node => {
    const from = i;
    const t = take();
    if (t.text === '(') {
      const inner = or();
      take(')');
      return inner;
    }
    if (t.text === '!') {
      const arg = primary();
      return { kind: 'not', arg, src: srcOf(from) };
    }
    if (t.text.startsWith("'")) return { kind: 'lit', value: t.text.slice(1, -1).replace(/''/g, "'"), src: t.text };
    if (/^\d/.test(t.text)) return { kind: 'lit', value: Number(t.text), src: t.text };
    if (t.text === 'true' || t.text === 'false') return { kind: 'lit', value: t.text === 'true', src: t.text };
    if (t.text === 'null') return { kind: 'lit', value: null, src: t.text };
    if (/^[A-Za-z_]/.test(t.text)) {
      if (peek() !== '(') return { kind: 'ref', path: t.text, src: t.text };
      take('(');
      const args: Node[] = [];
      while (peek() !== ')') {
        args.push(or());
        if (peek() === ',') take(',');
        else break;
      }
      take(')');
      return { kind: 'call', name: t.text, args, src: srcOf(from) };
    }
    throw new Error(`job condition: unexpected ${JSON.stringify(t.text)} at ${t.at} in ${JSON.stringify(expr)}`);
  };
  const cmp = (): Node => {
    const from = i;
    let left = primary();
    while (['==', '!=', '<', '<=', '>', '>='].includes(peek() ?? '')) {
      const op = take().text;
      const right = primary();
      left = { kind: 'cmp', op, left, right, src: srcOf(from) };
    }
    return left;
  };
  const and = binary('and', '&&', cmp);
  const or = binary('or', '||', and);
  const node = or();
  if (i !== toks.length) throw new Error(`job condition: trailing ${JSON.stringify(toks[i]!.text)} in ${JSON.stringify(expr)}`);
  return node;
};

const STATUS = new Set(['always', 'success', 'failure', 'cancelled']);
const PURE = new Set(['contains', 'startsWith', 'endsWith', 'format', 'fromJSON', 'toJSON', 'join']);

type Value = string | number | boolean | null | unknown[] | Record<string, unknown>;
const truthy = (v: unknown) => !(v === '' || v === 0 || v === false || v === null || v === undefined);
const loose = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v);

/**
 * A value as GitHub's expression comparison coerces it to a number when the two sides' types
 * differ (kanon#238): `null` is 0, a boolean 0 or 1, a string its JSON number or NaN, the empty
 * string 0, and an array or object NaN.
 */
const asNumber = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return 0;
    return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(t) ? Number(t) : NaN;
  }
  return NaN;
};

/**
 * GitHub's `==`, which is LOOSE (kanon#238): operands of one type compare as themselves
 * (strings case-insensitively, arrays and objects only as the same instance); operands of
 * different types are each coerced to a number first, so a refused gate's empty output equals
 * `0`, `null` and `false`. NaN equals nothing.
 */
const equalsLoosely = (l: unknown, r: unknown): boolean => {
  const kind = (v: unknown) => (v === null || v === undefined ? 'null' : typeof v);
  if (kind(l) === kind(r)) return kind(l) === 'null' || l === r;
  return asNumber(l) === asNumber(r);
};

/** A job the condition reads, in one world. */
export type NeedWorld = { result: string; outputs: Record<string, string> };

/** The jobs `job` waits for, by GitHub's `needs`. */
const needsOf = (needs: string | string[] | undefined): string[] => [needs ?? []].flat();

/** Read a condition, its `${{ }}` stripped; `null` when there is none. */
const treeOf = (cond: string | undefined): Node | null =>
  cond === undefined || String(cond).trim() === '' ? null : parseCondition(String(cond).replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, '$1'));

const usesStatus = (n: Node): boolean =>
  n.kind === 'call' ? STATUS.has(n.name) || n.args.some(usesStatus)
    : n.kind === 'not' ? usesStatus(n.arg)
      : n.kind === 'and' || n.kind === 'or' || n.kind === 'cmp' ? usesStatus(n.left) || usesStatus(n.right)
        : false;

/** Does `cond` call a status function (`always()`, `success()`, `failure()`, `cancelled()`)? */
export const hasStatusFunction = (cond: string | undefined): boolean => {
  const tree = treeOf(cond);
  return tree !== null && usesStatus(tree);
};

/**
 * The clauses of `tree` the logical operators see as one free boolean each: those that read
 * the event, or an output of a job that is neither `refused` nor `held`.
 */
const freeAtoms = (tree: Node | null, refused: Set<string>, held: Set<string>): Node[] => {
  const free = (n: Node): boolean => {
    switch (n.kind) {
      case 'lit': return false;
      case 'ref': {
        if (/^(github|inputs|vars|env)\./.test(n.path)) return true;
        const m = /^needs\.([\w-]+)\.outputs\./.exec(n.path);
        return Boolean(m && !refused.has(m[1]!) && !held.has(m[1]!));
      }
      case 'call':
        if (n.name === 'cancelled') return true;
        if (!STATUS.has(n.name) && !PURE.has(n.name)) throw new Error(`job condition: unmodelled function ${n.name}() in ${n.src}`);
        return n.args.some(free);
      case 'not': return false;
      case 'and': case 'or': return false;
      case 'cmp': return free(n.left) || free(n.right);
    }
  };
  const atoms: Node[] = [];
  const collect = (n: Node) => {
    if (n.kind === 'not') return collect(n.arg);
    if (n.kind === 'and' || n.kind === 'or') { collect(n.left); collect(n.right); return; }
    if (free(n)) atoms.push(n);
    else if (n.kind === 'call') n.args.forEach(collect);
  };
  if (tree) collect(tree);
  if (atoms.length > 16) throw new Error(`job condition: ${atoms.length} free clauses is more than this check enumerates`);
  return atoms;
};

/** Every combination of results (and, from `worldsOf`, outputs) for `jobs`. */
const worldsFor = (jobs: string[], worldsOf: (job: string) => NeedWorld[]): Record<string, NeedWorld>[] => {
  let worlds: Record<string, NeedWorld>[] = [{}];
  for (const job of jobs) worlds = worlds.flatMap((w) => worldsOf(job).map((o) => ({ ...w, [job]: o })));
  return worlds;
};

/** The jobs whose results `success()` and `failure()` read, in one world. */
type Status = { success: boolean; failure: boolean };

/**
 * The value of `n` in `world`, with each free clause as `assigned`. A free clause that reads an
 * output of a job in `emptied` is read with that output empty instead, as GitHub gives a
 * skipped job's outputs.
 */
const evaluate = (n: Node, world: Record<string, NeedWorld>, assigned: Map<Node, boolean>, status: Status, emptied: Set<string> = new Set()): Value => {
  const reads = (m: Node): boolean => {
    switch (m.kind) {
      case 'ref': { const r = /^needs\.([\w-]+)\.outputs\./.exec(m.path); return Boolean(r && emptied.has(r[1]!)); }
      case 'call': return m.args.some(reads);
      case 'not': return reads(m.arg);
      case 'and': case 'or': case 'cmp': return reads(m.left) || reads(m.right);
      case 'lit': return false;
    }
  };
  const value = (m: Node): Value => {
    if (assigned.has(m) && !reads(m)) return assigned.get(m)!;
    switch (m.kind) {
      case 'lit': return m.value;
      case 'ref': {
        const r = /^needs\.([\w-]+)\.(result|outputs\.([\w-]+))$/.exec(m.path);
        if (!r) throw new Error(`job condition: unmodelled context ${m.path}`);
        const w = world[r[1]!];
        if (!w) return '';
        return r[2] === 'result' ? w.result : (w.outputs[r[3]!] ?? '');
      }
      case 'call': {
        const args = m.args.map(value);
        switch (m.name) {
          case 'always': return true;
          case 'success': return status.success;
          case 'failure': return status.failure;
          case 'contains': return Array.isArray(args[0])
            ? args[0].some((x) => loose(x) === loose(args[1]))
            : String(args[0] ?? '').toLowerCase().includes(String(args[1] ?? '').toLowerCase());
          case 'startsWith': return String(args[0] ?? '').toLowerCase().startsWith(String(args[1] ?? '').toLowerCase());
          case 'endsWith': return String(args[0] ?? '').toLowerCase().endsWith(String(args[1] ?? '').toLowerCase());
          case 'format': return String(args[0]).replace(/\{(\d+)\}/g, (_m, k: string) => String(args[Number(k) + 1] ?? ''));
          case 'fromJSON': return JSON.parse(String(args[0])) as Value;
          case 'toJSON': return JSON.stringify(args[0]);
          case 'join': return Array.isArray(args[0]) ? args[0].join(String(args[1] ?? ',')) : String(args[0] ?? '');
        }
        throw new Error(`job condition: unmodelled function ${m.name}()`);
      }
      case 'not': return !truthy(value(m.arg));
      case 'and': { const l = value(m.left); return truthy(l) ? value(m.right) : l; }
      case 'or': { const l = value(m.left); return truthy(l) ? l : value(m.right); }
      case 'cmp': {
        const l = loose(value(m.left));
        const r = loose(value(m.right));
        switch (m.op) {
          case '==': return equalsLoosely(l, r);
          case '!=': return !equalsLoosely(l, r);
          case '<': return Number(l) < Number(r);
          case '<=': return Number(l) <= Number(r);
          case '>': return Number(l) > Number(r);
          case '>=': return Number(l) >= Number(r);
        }
        throw new Error(`job condition: unmodelled operator ${m.op}`);
      }
    }
  };
  return value(n);
};

/** Every assignment of the free clauses `atoms`, as the map `evaluate` reads. */
const assignments = function* (atoms: Node[]): Generator<Map<Node, boolean>> {
  for (let bits = 0; bits < 2 ** atoms.length; bits += 1) yield new Map(atoms.map((a, k) => [a, Boolean(bits & (1 << k))]));
};

/**
 * The first world, if any, in which `cond` starts its job although no gate admitted.
 *
 * @param cond the job's `if:` (absent = none)
 * @param needs the job's direct `needs`
 * @param ancestors every job it transitively needs, for `failure()`
 * @param refused jobs whose gate did not admit
 * @param held jobs that cannot run when no gate admitted
 * @returns a description of the world, or `null` when there is none
 */
export const runsUnadmitted = (
  cond: string | undefined,
  needs: string | string[] | undefined,
  ancestors: string[],
  refused: Set<string>,
  held: Set<string>,
): string | null => {
  const direct = needsOf(needs);
  const tree = treeOf(cond);
  const atoms = freeAtoms(tree, refused, held);
  const explicitStatus = tree ? usesStatus(tree) : false;

  // Every job whose result matters: the direct needs, and every ancestor `failure()` can see.
  const jobs = [...new Set([...direct, ...ancestors])];
  const worldsOf = (job: string): NeedWorld[] => {
    if (held.has(job)) return [{ result: 'skipped', outputs: {} }];
    if (refused.has(job)) {
      return [
        { result: 'success', outputs: { member: 'false' } },
        { result: 'success', outputs: {} },
        { result: 'skipped', outputs: {} },
        { result: 'failure', outputs: {} },
      ];
    }
    return ['success', 'skipped', 'failure'].map((result) => ({ result, outputs: {} }));
  };

  for (const world of worldsFor(jobs, worldsOf)) {
    // Direct needs only: an over-approximation towards "runs", which is the error this check
    // wants to see (`startsDespite` below models GitHub's transitive rule).
    const allSucceeded = direct.every((j) => world[j]!.result === 'success');
    if (!explicitStatus && !allSucceeded) continue;
    const status = { success: allSucceeded, failure: jobs.some((j) => world[j]!.result === 'failure') };
    for (const assigned of assignments(atoms)) {
      if (tree === null || truthy(evaluate(tree, world, assigned, status))) {
        const jobsDesc = jobs.map((j) => {
          const w = world[j]!;
          const outs = Object.entries(w.outputs).map(([k, v]) => `${k}=${v}`).join(', ');
          return `${j} ${w.result}${outs ? ` (${outs})` : ''}`;
        });
        const clauses = atoms.flatMap((a) => (assigned.get(a) ? [`\`${a.src}\``] : []));
        return [...jobsDesc, ...(clauses.length ? [`true: ${clauses.join(', ')}`] : [])].join('; ') || 'always';
      }
    }
  }
  return null;
};

/**
 * The ancestors whose skip or failure `cond` starts its job DESPITE (kanon#261), under GitHub's
 * real rule: a job whose `if:` has no status function starts only when EVERY job in its `needs`
 * chain succeeded, grandparents included (actions/runner#491), and so does `success()`.
 *
 * A job with no status function tolerates none: it is skipped whenever any ancestor did not
 * succeed. A job with one (`!cancelled()`, `always()`, `failure()`) tolerates each ancestor for
 * which some world exists where that ancestor was skipped or failed and `cond` still holds.
 * Each ancestor's result is free, except where GitHub's own rule forbids it (kanon#268): an
 * ancestor whose `if:` has no status function cannot have run, so cannot have succeeded or
 * failed, unless every job in ITS `needs` chain succeeded. Worlds that break that are never
 * produced, so they are not counted. A skipped job's outputs are empty and any other job's are
 * free.
 *
 * @param cond the job's `if:` (absent = none)
 * @param ancestors every job it transitively needs
 * @param graph the workflow's jobs, for each ancestor's own `if:` and `needs`
 * @returns each tolerated ancestor, in `ancestors` order, with the results (`skipped`,
 *   `failure`) it is tolerated in
 */
export const startsDespite = (
  cond: string | undefined,
  ancestors: string[],
  graph: Record<string, { needs?: string | string[]; if?: string } | undefined>,
): { job: string; results: string[] }[] => {
  const tree = treeOf(cond);
  if (tree === null || !usesStatus(tree)) return [];
  const atoms = freeAtoms(tree, new Set(), new Set());
  const upstreamOf = (id: string, seen = new Set<string>()): string[] => {
    for (const n of needsOf(graph[id]?.needs)) if (!seen.has(n)) { seen.add(n); upstreamOf(n, seen); }
    return [...seen];
  };
  // The ancestors GitHub's implicit success() holds to their own chain, with that chain.
  const implicit = ancestors.flatMap((j) => (hasStatusFunction(graph[j]?.if) ? [] : [{ job: j, chain: upstreamOf(j) }]));
  const possible = (world: Record<string, NeedWorld>) => implicit.every(({ job, chain }) =>
    world[job]!.result === 'skipped' || chain.every((a) => (world[a]?.result ?? 'success') === 'success'));
  const worlds = worldsFor(ancestors, () => ['success', 'skipped', 'failure'].map((result) => ({ result, outputs: {} }))).filter(possible);
  const tolerated = new Set<string>();
  const key = (j: string, world: Record<string, NeedWorld>) => `${j}\0${world[j]!.result}`;
  for (const world of worlds) {
    const unseen = ancestors.filter((j) => world[j]!.result !== 'success' && !tolerated.has(key(j, world)));
    if (unseen.length === 0) continue;
    const status = { success: false, failure: ancestors.some((j) => world[j]!.result === 'failure') };
    const emptied = new Set(ancestors.filter((j) => world[j]!.result === 'skipped'));
    for (const assigned of assignments(atoms)) {
      if (truthy(evaluate(tree, world, assigned, status, emptied))) { unseen.forEach((j) => tolerated.add(key(j, world))); break; }
    }
  }
  return ancestors.flatMap((job) => {
    const results = ['skipped', 'failure'].filter((r) => tolerated.has(`${job}\0${r}`));
    return results.length ? [{ job, results }] : [];
  });
};
