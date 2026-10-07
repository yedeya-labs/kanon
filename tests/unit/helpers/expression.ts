/**
 * A small GitHub Actions expression evaluator, and a fake of what the runner prints at the head of
 * a step's log (kanon#433).
 *
 * The runner prints a `uses:` step's evaluated `with:` and every step's evaluated `env:` before
 * the step runs, and masks only secrets (and values registered with `::add-mask::`), wherever
 * they appear. So whether the QA store's coordinates reach a public log is a question of what
 * those values evaluate to, and which of them are secrets. `stepHeader` answers it the way the
 * runner does: it evaluates each value, then replaces every occurrence of every secret's value
 * with `***`.
 *
 * It models the subset the store steps use: literals, context paths, `format`, `toJSON`,
 * `fromJSON` with a property read after it, `||`, `&&`, `==`, `!=` and `!`. Anything else THROWS,
 * so a new construct fails here by name rather than being misread.
 */

type Value = unknown;
export type Contexts = Record<string, Value>;

const TOKEN = /\s*(?:('(?:[^']|'')*')|(\d+(?:\.\d+)?)|(==|!=|&&|\|\||[!(),.])|([A-Za-z_][\w-]*))/y;

const tokenize = (src: string): string[] => {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(TOKEN.lastIndex))) break;
    const m = TOKEN.exec(src);
    if (!m) throw new Error(`cannot read the expression at ${TOKEN.lastIndex}: ${src}`);
    out.push(m[0].trim());
  }
  return out;
};

/** GitHub's `toJSON`: two-space indented, as the runner prints it. */
const toJSON = (v: Value) => JSON.stringify(v ?? null, null, 2);

/** GitHub's string coercion, for `format` and the printed value. */
export const asString = (v: Value): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'object' ? toJSON(v) : String(v));

const truthy = (v: Value) => !(v === null || v === undefined || v === false || v === '' || v === 0);

/** GitHub's loose equality: strings compare case-insensitively, null and '' are equal. */
const equal = (a: Value, b: Value) => {
  const norm = (v: Value) => (v === null || v === undefined ? '' : typeof v === 'string' ? v.toLowerCase() : v);
  return norm(a) === norm(b);
};

/** Evaluates one expression, the text inside `${{ }}`, over `ctx`. */
export const evaluate = (src: string, ctx: Contexts): Value => {
  const t = tokenize(src);
  let i = 0;
  const peek = () => t[i];
  const take = (want?: string) => {
    const x = t[i++];
    if (want !== undefined && x !== want) throw new Error(`expected ${want}, got ${String(x)} in ${src}`);
    return x!;
  };
  const postfix = (v: Value): Value => {
    while (peek() === '.') {
      take('.');
      const k = take();
      v = v !== null && typeof v === 'object' ? (v as Record<string, Value>)[k] : null;
    }
    return v;
  };
  const primary = (): Value => {
    const x = take();
    if (x === '!') return !truthy(primary());
    if (x === '(') { const v = or(); take(')'); return postfix(v); }
    if (x.startsWith("'")) return x.slice(1, -1).replace(/''/g, "'");
    if (/^\d/.test(x)) return Number(x);
    if (x === 'true' || x === 'false') return x === 'true';
    if (x === 'null') return null;
    if (peek() === '(') {
      take('(');
      const args: Value[] = [];
      while (peek() !== ')') { args.push(or()); if (peek() === ',') take(','); }
      take(')');
      let v: Value;
      if (x === 'toJSON') v = toJSON(args[0]);
      else if (x === 'fromJSON') v = JSON.parse(asString(args[0]));
      else if (x === 'format') v = asString(args[0]).replace(/\{\{|\}\}|\{(\d+)\}/g, (m, n) => (m === '{{' ? '{' : m === '}}' ? '}' : asString(args[Number(n) + 1])));
      else throw new Error(`the function ${x} is not modelled`);
      return postfix(v);
    }
    if (!(x in ctx)) throw new Error(`the context ${x} is not given`);
    return postfix(ctx[x]);
  };
  const cmp = (): Value => {
    let v = primary();
    while (peek() === '==' || peek() === '!=') {
      const op = take();
      const r = primary();
      v = op === '==' ? equal(v, r) : !equal(v, r);
    }
    return v;
  };
  const and = (): Value => {
    let v = cmp();
    while (peek() === '&&') { take(); const r = cmp(); v = truthy(v) ? r : v; }
    return v;
  };
  const or = (): Value => {
    let v = and();
    while (peek() === '||') { take(); const r = and(); v = truthy(v) ? v : r; }
    return v;
  };
  const v = or();
  if (i !== t.length) throw new Error(`unread tokens in ${src}: ${t.slice(i).join(' ')}`);
  return v;
};

/** A YAML value with its `${{ }}` expressions evaluated, as a string, as the runner holds it. */
export const interpolate = (value: unknown, ctx: Contexts): string => {
  // A `}}` inside a quoted string (format's escaped brace) does not close the expression.
  const text = String(value ?? '');
  let out = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('${{', i);
    if (open < 0) { out += text.slice(i); break; }
    out += text.slice(i, open);
    let j = open + 3;
    let quoted = false;
    while (j < text.length && (quoted || text.slice(j, j + 2) !== '}}')) {
      if (text[j] === "'") quoted = !quoted;
      j++;
    }
    if (j >= text.length) throw new Error(`an unclosed expression in ${text}`);
    out += asString(evaluate(text.slice(open + 3, j), ctx));
    i = j + 2;
  }
  return out;
};

/** Every occurrence of every non-empty secret value replaced with `***`, as the runner masks a log. */
export const mask = (text: string, secrets: Record<string, string>): string =>
  Object.values(secrets).filter((s) => s !== '').sort((a, b) => b.length - a.length).reduce((t, s) => t.split(s).join('***'), text);

/**
 * What the runner prints at the head of a step's log: its `with:` and its `env:`, evaluated, then
 * masked. Also returns the evaluated, unmasked `with:`, which is what the called action receives
 * as its `inputs`.
 */
export const stepHeader = (step: { with?: Record<string, unknown>; env?: Record<string, unknown> }, ctx: Contexts, secrets: Record<string, string>) => {
  const withValues = Object.fromEntries(Object.entries(step.with ?? {}).map(([k, v]) => [k, interpolate(v, ctx)]));
  const envValues = Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, interpolate(v, ctx)]));
  const lines = [
    ...(Object.keys(withValues).length ? ['with:', ...Object.entries(withValues).map(([k, v]) => `  ${k}: ${v}`)] : []),
    ...(Object.keys(envValues).length ? ['env:', ...Object.entries(envValues).map(([k, v]) => `  ${k}: ${v}`)] : []),
  ];
  return { printed: mask(lines.join('\n'), secrets), unmasked: lines.join('\n'), inputs: withValues, env: envValues };
};
