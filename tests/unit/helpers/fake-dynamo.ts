import { AwsError, itemOf, plain, plainItem } from '../../../infra/telemetry/function/aws.mjs';
import { FUNCTION_FIELDS, INGEST_SCAN } from '../../../infra/telemetry/function/register-fields.mjs';

/**
 * An in-memory DynamoDB for the ingest function's tests (plan 0008 J3), with the two tables and
 * the parts of the API the function calls, evaluated as DynamoDB evaluates them: condition,
 * update, key-condition, filter and projection expressions (the subset the function writes),
 * whole-transaction cancellation with per-item reasons, `Limit` before the filter, and pages.
 *
 * IAM IS MODELLED TOO, from `template.yaml`'s grants as `register-fields.mjs` lists them, so a
 * test that passes here is one AWS would let through:
 *   - the function's own credentials (none passed) may `PutItem` the rows table and nothing else
 *     on it; on the register it may `GetItem`, `Query`, `Scan` `pk` alone, `PutItem` and
 *     `UpdateItem` naming only `FUNCTION_FIELDS` (in the item, the update and the condition), and
 *     `DeleteItem` key items (`key#…`) alone; a `TransactWriteItems` is checked item by item;
 *   - a session from `sts` (the self-read role) may do on the rows table only what its session
 *     policy lists, and only on partitions its `dynamodb:LeadingKeys` pattern matches.
 * A refusal is `AccessDeniedException`, as AWS answers.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Attr = Record<string, any>;
type Item = Record<string, Attr>;
type Creds = { accessKeyId: string, secretAccessKey: string, sessionToken?: string };

export const ROWS = 'kanon-telemetry';
export const REGISTER = 'kanon-telemetry-register';
const RANGE: Record<string, boolean> = { [ROWS]: true, [REGISTER]: false };

// ------------------------------------------------------------------------- expressions

type Tok = string;
const TOKEN = /\s*(attribute_not_exists|attribute_exists|begins_with|BETWEEN|AND|OR|NOT|SET|ADD|REMOVE|<>|<=|>=|=|<|>|\(|\)|,|\+|#[A-Za-z0-9_]+|:[A-Za-z0-9_]+|[A-Za-z_][A-Za-z0-9_]*)/y;
function tokens(expr: string): Tok[] {
  const out: Tok[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < expr.length) {
    if (/^\s*$/.test(expr.slice(TOKEN.lastIndex))) break;
    const m = TOKEN.exec(expr);
    if (!m) throw new Error(`fake-dynamo: can't read ${expr}`);
    out.push(m[1]!);
  }
  return out;
}

type Ctx = { names: Record<string, string>, values: Record<string, Attr> };
const nameOf = (t: Tok, ctx: Ctx) => {
  if (t.startsWith('#')) {
    const n = ctx.names[t];
    if (n === undefined) throw new AwsError('expression', 'ValidationException');
    return n;
  }
  return t;
};

/** A condition's evaluator, and the attribute names it reads. */
function condition(expr: string, ctx: Ctx): { test: (item: Item) => boolean, names: string[] } {
  const ts = tokens(expr);
  const names: string[] = [];
  let i = 0;
  const peek = () => ts[i];
  const take = (want?: string) => {
    const t = ts[i++];
    if (want !== undefined && t !== want) throw new Error(`fake-dynamo: expected ${want} in ${expr}`);
    return t!;
  };
  const operand = (): ((item: Item) => unknown) => {
    const t = take();
    if (t.startsWith(':')) {
      const v = ctx.values[t];
      if (v === undefined) throw new AwsError('expression', 'ValidationException');
      return () => plain(v);
    }
    const n = nameOf(t, ctx);
    names.push(n);
    return (item) => plain(item[n]);
  };
  const cmp = (a: unknown, b: unknown, op: string) => {
    if (a === undefined || b === undefined) return op === '<>' && !(a === undefined && b === undefined);
    if (typeof a !== typeof b) return op === '<>';
    const x = a as any;
    const y = b as any;
    switch (op) {
      case '=': return x === y;
      case '<>': return x !== y;
      case '<': return x < y;
      case '<=': return x <= y;
      case '>': return x > y;
      default: return x >= y;
    }
  };
  const primary = (): ((item: Item) => boolean) => {
    const t = peek();
    if (t === '(') {
      take('(');
      const e = or();
      take(')');
      return e;
    }
    if (t === 'NOT') {
      take();
      const e = primary();
      return (item) => !e(item);
    }
    if (t === 'attribute_exists' || t === 'attribute_not_exists') {
      take();
      take('(');
      const n = nameOf(take(), ctx);
      names.push(n);
      take(')');
      return t === 'attribute_exists' ? (item) => item[n] !== undefined : (item) => item[n] === undefined;
    }
    if (t === 'begins_with') {
      take();
      take('(');
      const a = operand();
      take(',');
      const b = operand();
      take(')');
      return (item) => typeof a(item) === 'string' && String(a(item)).startsWith(String(b(item)));
    }
    const a = operand();
    const op = take();
    if (op === 'BETWEEN') {
      const lo = operand();
      take('AND');
      const hi = operand();
      return (item) => cmp(a(item), lo(item), '>=') && cmp(a(item), hi(item), '<=');
    }
    const b = operand();
    return (item) => cmp(a(item), b(item), op);
  };
  const and = (): ((item: Item) => boolean) => {
    let e = primary();
    while (peek() === 'AND') {
      take();
      const l = e;
      const r = primary();
      e = (item) => l(item) && r(item);
    }
    return e;
  };
  function or(): (item: Item) => boolean {
    let e = and();
    while (peek() === 'OR') {
      take();
      const l = e;
      const r = and();
      e = (item) => l(item) || r(item);
    }
    return e;
  }
  const test = or();
  if (i !== ts.length) throw new Error(`fake-dynamo: trailing tokens in ${expr}`);
  return { test, names };
}

/** An update expression's effect, and the attribute names it writes. */
function update(expr: string, ctx: Ctx): { apply: (item: Item) => void, names: string[] } {
  const ts = tokens(expr);
  const names: string[] = [];
  const steps: Array<(item: Item) => void> = [];
  let i = 0;
  let clause = '';
  while (i < ts.length) {
    const t = ts[i]!;
    if (t === 'SET' || t === 'ADD' || t === 'REMOVE') {
      clause = t;
      i += 1;
      continue;
    }
    if (t === ',') {
      i += 1;
      continue;
    }
    const n = nameOf(t, ctx);
    names.push(n);
    i += 1;
    if (clause === 'SET') {
      if (ts[i++] !== '=') throw new Error('fake-dynamo: SET without =');
      const v = ctx.values[ts[i++]!];
      if (!v) throw new AwsError('UpdateItem', 'ValidationException');
      steps.push((item) => { item[n] = v; });
    } else if (clause === 'ADD') {
      const v = ctx.values[ts[i++]!];
      if (!v || !('N' in v)) throw new AwsError('UpdateItem', 'ValidationException');
      steps.push((item) => { item[n] = { N: String(Number(item[n]?.N ?? 0) + Number(v.N)) }; });
    } else if (clause === 'REMOVE') {
      steps.push((item) => { delete item[n]; });
    } else throw new Error(`fake-dynamo: can't read ${expr}`);
  }
  return { apply: (item) => steps.forEach((s) => s(item)), names };
}

const projectionNames = (expr: string | undefined, ctx: Ctx) =>
  expr === undefined ? undefined : expr.split(',').map((p) => nameOf(p.trim(), ctx));
const project = (item: Item, names: string[] | undefined): Item =>
  names === undefined ? structuredClone(item) : Object.fromEntries(names.filter((n) => item[n] !== undefined).map((n) => [n, structuredClone(item[n]!)]));

// ------------------------------------------------------------------------- the fake

export type Fake = ReturnType<typeof fakeDynamo>;

export function fakeDynamo() {
  const tables = new Map<string, Map<string, Item>>([[ROWS, new Map()], [REGISTER, new Map()]]);
  const sessions = new Map<string, any>();
  const calls: Array<{ op: string, body: any, session: boolean }> = [];
  let before: ((op: string, body: any) => void | Promise<void>) | undefined;
  let sessionCount = 0;

  const tableOf = (name: string) => {
    const t = tables.get(name);
    if (!t) throw new AwsError('any', 'ResourceNotFoundException');
    return t;
  };
  const keyString = (table: string, key: Item) => (RANGE[table] ? `${key.pk?.S}|${key.sk?.S}` : String(key.pk?.S));
  const keyOf = (table: string, item: Item): Item => (RANGE[table] ? { pk: item.pk!, sk: item.sk! } : { pk: item.pk! });
  const ctxOf = (body: any): Ctx => ({ names: body.ExpressionAttributeNames ?? {}, values: body.ExpressionAttributeValues ?? {} });
  const denied = (op: string) => new AwsError(op, 'AccessDeniedException');

  /** IAM, for one action on one item or request. */
  function authorize(op: string, table: string, body: any, creds: Creds | undefined, pks: string[]) {
    const token = creds?.sessionToken;
    if (token !== undefined && sessions.has(token)) {
      const policy = sessions.get(token);
      const s = policy.Statement[0];
      const actions: string[] = [s.Action].flat();
      const patterns: string[] = s.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'];
      if (table !== ROWS || !String(s.Resource).endsWith(`table/${ROWS}`) || !actions.includes(`dynamodb:${op}`)) throw denied(op);
      const matches = (pk: string) => patterns.some((p) => (p.endsWith('*') ? pk.startsWith(p.slice(0, -1)) : pk === p));
      if (!pks.length || !pks.every(matches)) throw denied(op);
      return;
    }
    if (token !== undefined) throw denied(op);
    // The function's own role.
    if (table === ROWS) {
      if (op !== 'PutItem') throw denied(op);
      return;
    }
    const ctx = ctxOf(body);
    if (op === 'GetItem' || op === 'Query') return;
    if (op === 'Scan') {
      const names = projectionNames(body.ProjectionExpression, ctx);
      if (!names || body.Select !== 'SPECIFIC_ATTRIBUTES' || !names.every((n) => INGEST_SCAN.includes(n))) throw denied(op);
      return;
    }
    if (op === 'PutItem' || op === 'UpdateItem') {
      const named = [
        ...Object.keys(body.Item ?? {}), ...Object.keys(body.Key ?? {}),
        ...(body.UpdateExpression ? update(body.UpdateExpression, ctx).names : []),
        ...(body.ConditionExpression ? condition(body.ConditionExpression, ctx).names : []),
      ];
      if (!named.every((n) => FUNCTION_FIELDS.includes(n))) throw denied(op);
      return;
    }
    if (op === 'DeleteItem') {
      if (!pks.every((pk) => pk.startsWith('key#'))) throw denied(op);
      return;
    }
    throw denied(op);
  }

  function conditionHolds(body: any, existing: Item | undefined) {
    if (!body.ConditionExpression) return true;
    return condition(body.ConditionExpression, ctxOf(body)).test(existing ?? {});
  }

  const writes: Record<string, (body: any, dryRun: boolean) => boolean> = {
    PutItem(body, dryRun) {
      const t = tableOf(body.TableName);
      const k = keyString(body.TableName, body.Item);
      if (!conditionHolds(body, t.get(k))) return false;
      if (!dryRun) t.set(k, structuredClone(body.Item));
      return true;
    },
    UpdateItem(body, dryRun) {
      const t = tableOf(body.TableName);
      const k = keyString(body.TableName, body.Key);
      const existing = t.get(k);
      if (!conditionHolds(body, existing)) return false;
      if (!dryRun) {
        const item = structuredClone(existing ?? body.Key);
        update(body.UpdateExpression, ctxOf(body)).apply(item);
        t.set(k, item);
      }
      return true;
    },
    DeleteItem(body, dryRun) {
      const t = tableOf(body.TableName);
      const k = keyString(body.TableName, body.Key);
      if (!conditionHolds(body, t.get(k))) return false;
      if (!dryRun) t.delete(k);
      return true;
    },
  };

  async function db(op: string, body: any, creds?: Creds): Promise<any> {
    calls.push({ op, body: structuredClone(body), session: creds?.sessionToken !== undefined });
    if (before) await before(op, body);
    switch (op) {
      case 'GetItem': {
        authorize(op, body.TableName, body, creds, [body.Key.pk.S]);
        const item = tableOf(body.TableName).get(keyString(body.TableName, body.Key));
        return item ? { Item: project(item, projectionNames(body.ProjectionExpression, ctxOf(body))) } : {};
      }
      case 'PutItem':
      case 'UpdateItem':
      case 'DeleteItem': {
        authorize(op, body.TableName, body, creds, [(body.Item ?? body.Key).pk.S]);
        if (!writes[op]!(body, false)) throw new AwsError(op, 'ConditionalCheckFailedException');
        return {};
      }
      case 'TransactWriteItems': {
        const items: Array<[string, any]> = body.TransactItems.map((t: any) => {
          const [kind, b] = Object.entries(t)[0] as [string, any];
          return [kind === 'Put' ? 'PutItem' : kind === 'Update' ? 'UpdateItem' : kind === 'Delete' ? 'DeleteItem' : 'ConditionCheckItem', b];
        });
        for (const [o, b] of items) authorize(o, b.TableName, b, creds, [(b.Item ?? b.Key).pk.S]);
        const reasons = items.map(([o, b]) => (writes[o]!(b, true) ? 'None' : 'ConditionalCheckFailed'));
        if (reasons.some((r) => r !== 'None')) throw new AwsError(op, 'TransactionCanceledException', reasons);
        for (const [o, b] of items) writes[o]!(b, false);
        return {};
      }
      case 'BatchWriteItem': {
        for (const [table, requests] of Object.entries(body.RequestItems as Record<string, any[]>)) {
          const pks = requests.map((r) => String((r.DeleteRequest ? r.DeleteRequest.Key : r.PutRequest.Item).pk.S));
          authorize(op, table, body, creds, pks);
          for (const r of requests) {
            if (r.DeleteRequest) tableOf(table).delete(keyString(table, r.DeleteRequest.Key));
            else tableOf(table).set(keyString(table, r.PutRequest.Item), structuredClone(r.PutRequest.Item));
          }
        }
        return { UnprocessedItems: {} };
      }
      case 'Query':
      case 'Scan': {
        const ctx = ctxOf(body);
        const t = tableOf(body.TableName);
        let pks: string[] = [];
        let keyTest: (item: Item) => boolean = () => true;
        if (op === 'Query') {
          const kc = condition(body.KeyConditionExpression, ctx);
          keyTest = kc.test;
          const p = /(?:^|\s)(#?[A-Za-z0-9_]+)\s*=\s*(:[A-Za-z0-9_]+)/.exec(body.KeyConditionExpression);
          pks = p ? [String(plain(ctx.values[p[2]!]))] : [];
        }
        authorize(op, body.TableName, body, creds, pks);
        const sorted = [...t.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, v] as const).filter(([, v]) => keyTest(v));
        let from = 0;
        if (body.ExclusiveStartKey) {
          const k = keyString(body.TableName, body.ExclusiveStartKey);
          from = sorted.findIndex(([kk]) => kk > k);
          if (from < 0) from = sorted.length;
        }
        const limit = body.Limit ?? Infinity;
        const page = sorted.slice(from, from + limit);
        const more = from + page.length < sorted.length;
        const filter = body.FilterExpression ? condition(body.FilterExpression, ctx).test : () => true;
        const kept = page.map(([, v]) => v).filter(filter);
        const last = page[page.length - 1]?.[1];
        const lek = more && last ? keyOf(body.TableName, last) : undefined;
        if (body.Select === 'COUNT') return { Count: kept.length, ...(lek ? { LastEvaluatedKey: lek } : {}) };
        const names = projectionNames(body.ProjectionExpression, ctx);
        return { Items: kept.map((v) => project(v, names)), Count: kept.length, ...(lek ? { LastEvaluatedKey: structuredClone(lek) } : {}) };
      }
      default:
        throw denied(op);
    }
  }

  /** STS for the self-read role: a session whose policy the fake holds, by its token. */
  async function sts(req: { roleArn: string, sessionName: string, policy: object }) {
    sessionCount += 1;
    const sessionToken = `session-${sessionCount}`;
    sessions.set(sessionToken, structuredClone(req.policy));
    return { accessKeyId: 'ASIA0000000000000000', secretAccessKey: 'secret', sessionToken };
  }

  return {
    db,
    sts,
    tables,
    calls,
    sessions,
    /** Run `fn` before each call, as a concurrent writer would. */
    before(fn: typeof before) { before = fn; },
    seed(table: string, item: Record<string, unknown>) { tableOf(table).set(keyString(table, itemOf(item)), itemOf(item)); },
    get(table: string, pk: string, sk?: string) {
      return plainItem(tableOf(table).get(RANGE[table] ? `${pk}|${sk}` : pk)) as Record<string, any> | undefined;
    },
    all(table: string) { return [...tableOf(table).values()].map((i) => plainItem(i) as Record<string, any>); },
    partition(pk: string) { return [...tableOf(ROWS).values()].filter((i) => i.pk?.S === pk).map((i) => plainItem(i) as Record<string, any>); },
  };
}
