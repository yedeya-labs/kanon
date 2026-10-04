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

/** A job the condition reads, in one world. */
export type NeedWorld = { result: string; outputs: Record<string, string> };

/** The jobs `job` waits for, by GitHub's `needs`. */
const needsOf = (needs: string | string[] | undefined): string[] => [needs ?? []].flat();

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
  const tree = cond === undefined || String(cond).trim() === '' ? null : parseCondition(String(cond).replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, '$1'));

  // Free: reads the event, or a job the caller vouches for neither way.
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
  // The free clauses, as the logical operators see them; each is one boolean.
  const atoms: Node[] = [];
  const collect = (n: Node) => {
    if (n.kind === 'not') return collect(n.arg);
    if (n.kind === 'and' || n.kind === 'or') { collect(n.left); collect(n.right); return; }
    if (free(n)) atoms.push(n);
    else if (n.kind === 'call') n.args.forEach(collect);
  };
  if (tree) collect(tree);
  if (atoms.length > 16) throw new Error(`job condition: ${atoms.length} free clauses is more than this check enumerates`);
  const usesStatus = (n: Node): boolean =>
    n.kind === 'call' ? STATUS.has(n.name) || n.args.some(usesStatus)
      : n.kind === 'not' ? usesStatus(n.arg)
        : n.kind === 'and' || n.kind === 'or' || n.kind === 'cmp' ? usesStatus(n.left) || usesStatus(n.right)
          : false;
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
  let worlds: Record<string, NeedWorld>[] = [{}];
  for (const job of jobs) worlds = worlds.flatMap((w) => worldsOf(job).map((o) => ({ ...w, [job]: o })));

  for (const world of worlds) {
    const allSucceeded = direct.every((j) => world[j]!.result === 'success');
    if (!explicitStatus && !allSucceeded) continue;
    for (let bits = 0; bits < 2 ** atoms.length; bits += 1) {
      const assigned = new Map(atoms.map((a, k) => [a, Boolean(bits & (1 << k))]));
      const value = (n: Node): Value => {
        if (assigned.has(n)) return assigned.get(n)!;
        switch (n.kind) {
          case 'lit': return n.value;
          case 'ref': {
            const m = /^needs\.([\w-]+)\.(result|outputs\.([\w-]+))$/.exec(n.path);
            if (!m) throw new Error(`job condition: unmodelled context ${n.path}`);
            const w = world[m[1]!];
            if (!w) return '';
            return m[2] === 'result' ? w.result : (w.outputs[m[3]!] ?? '');
          }
          case 'call': {
            const args = n.args.map(value);
            switch (n.name) {
              case 'always': return true;
              case 'success': return allSucceeded;
              case 'failure': return jobs.some((j) => world[j]!.result === 'failure');
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
            throw new Error(`job condition: unmodelled function ${n.name}()`);
          }
          case 'not': return !truthy(value(n.arg));
          case 'and': { const l = value(n.left); return truthy(l) ? value(n.right) : l; }
          case 'or': { const l = value(n.left); return truthy(l) ? l : value(n.right); }
          case 'cmp': {
            const l = loose(value(n.left));
            const r = loose(value(n.right));
            switch (n.op) {
              case '==': return l === r;
              case '!=': return l !== r;
              case '<': return Number(l) < Number(r);
              case '<=': return Number(l) <= Number(r);
              case '>': return Number(l) > Number(r);
              case '>=': return Number(l) >= Number(r);
            }
            throw new Error(`job condition: unmodelled operator ${n.op}`);
          }
        }
      };
      if (tree === null || truthy(value(tree))) {
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
