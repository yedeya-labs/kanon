import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { keysOf, toAttributes } from '../../infra/telemetry/function/index.mjs';
import { LANES } from '../../infra/telemetry/function/schema.mjs';
import { report as cliReport } from '../../cli/metrics-report.mjs';
import { parse } from 'yaml';
import { FILES, JOB_TIMEOUT_MINUTES, QUERY_TIMEOUT_MS, REGION, REPORT_BY_MS, REPORT_FALLBACK_MS, REPORT_MONTHS, STARTED_FILE, STATUSES, TABLE, WINDOW_DAYS, checkStore, deadlineOf, headline, masksOf, merge, read, readerOf, reasonOf, reportStep, rowOf } from '../../scripts/overseer-telemetry.mjs';
import { UNTIL, ago, itemRow, risingRows, runRow } from '../unit/helpers/metrics-rows.js';
import { SPAWNS } from '../unit/helpers/spawns.js';
import { writeStub } from '../unit/helpers/stub-bin.js';

/**
 * kanon#470 (the Owner's decision, option A): the Overseer's own cost view. The lane's
 * `telemetry` job reads this repository's own rows with its telemetry reader role and hands the
 * agent `token-trend.md` and `cache-ttl.md`, never rows; the agent's job adds them to the export
 * and writes the read's status into the manifest, which the prompt reports and never reads as an
 * absent store.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/overseer-telemetry.mjs', import.meta.url));
const WORKFLOWS = fileURLToPath(new URL('../../.github/workflows', import.meta.url));
// Built, so the tree holds no twelve-digit literal (public-tree.test.ts).
const ACCOUNT = `${'1234567890'}12`;
const KEY = 'a1b2c3d4';
const ROLE = `arn:aws:iam::${ACCOUNT}:role/kanon-telemetry-${KEY}-reader`;
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

const item = (daysAgo: number, cost: number, extra: Record<string, unknown> = {}) => {
  const sk = `${new Date(NOW - daysAgo * 86_400_000).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z#1-1-0`;
  return { sk: { S: sk }, tag: { S: 'run' }, outcome: { S: 'ok' }, total_cost_usd: { N: String(cost) }, changed_lines: { N: '300' }, cache_write_tokens: { N: '100' }, cache_write_1h_tokens: { N: '100' }, ...extra };
};

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'overseer-telemetry-')); dirs.push(d); return d; };

describe('the reader role', () => {
  it('reads the account id and the key from a reader role\'s ARN, and nothing else', () => {
    expect(readerOf(ROLE)).toEqual({ account: ACCOUNT, key: KEY });
    expect(readerOf(` ${ROLE}\n`)).toEqual({ account: ACCOUNT, key: KEY });
    expect(readerOf(`arn:aws:iam::${ACCOUNT}:role/kanon-telemetry-${KEY}-writer`)).toBeNull();
    expect(readerOf(`arn:aws:iam::${ACCOUNT}:role/kanon-telemetry-${KEY}-aggregates`)).toBeNull();
    expect(readerOf('')).toBeNull();
    expect(readerOf(undefined)).toBeNull();
  });

  it('masks the ARN, the account id and the key, and nothing when no role is set', () => {
    expect(masksOf({ ROLE })).toEqual([ROLE, ACCOUNT, KEY]);
    expect(masksOf({ ROLE: '' })).toEqual([]);
    expect(masksOf({})).toEqual([]);
  });

  it('reads the hosted store by default, where it lives', () => {
    expect(TABLE).toBe('kanon-telemetry');
    expect(REGION).toBe('eu-central-1');
    expect(WINDOW_DAYS).toBe(14);
    expect(checkStore({})).toEqual({ table: TABLE, region: REGION, problems: [] });
    expect(checkStore({ TABLE: '', REGION: ' ' })).toEqual({ table: TABLE, region: REGION, problems: [] });
  });

  // kanon#499: a self-hosted store's table and region, as the caller sets them, held to their shapes.
  it('takes a self-hosted table and region, and refuses one of the wrong shape by name', () => {
    expect(checkStore({ TABLE: 'acme_telemetry.v2', REGION: 'us-gov-west-1' })).toEqual({ table: 'acme_telemetry.v2', region: 'us-gov-west-1', problems: [] });
    expect(checkStore({ REGION: 'ap-southeast-2' }).problems).toEqual([]);
    for (const table of ['ab', 'a b', 'kanon/telemetry', '${{ x }}', 't'.repeat(256)]) expect(checkStore({ TABLE: table }).problems, table).toEqual([expect.stringMatching(/the KANON_TELEMETRY_TABLE variable .* is not a DynamoDB table name/)]);
    for (const region of ['eu-central', 'EU-CENTRAL-1', 'eu-central-1; rm', 'europe', '1-a-1']) expect(checkStore({ REGION: region }).problems, region).toEqual([expect.stringMatching(/the KANON_TELEMETRY_REGION variable .* is not an AWS region code/)]);
  });
});

describe('the read', () => {
  type Q = { pk: string, from?: string, attributes?: readonly string[], table?: string, region?: string };
  const queried: Q[] = [];
  const query = (items: (lane: string) => unknown[]) => (q: Q) => {
    queried.push(q);
    return items(q.pk.slice(q.pk.indexOf('#') + 1)) as never;
  };

  it('reads its own key\'s partition for each of Kanon\'s lanes, over the window, projected', () => {
    queried.length = 0;
    const r = read({ ROLE, CREDENTIALS: 'success' }, { query: query(() => []), now: NOW, workflows: WORKFLOWS });
    expect(r.status).toBe('ran');
    expect(queried.map((q) => q.pk)).toEqual(LANES.map((l) => `${KEY}#${l}`));
    expect(new Set(queried.map((q) => q.from))).toEqual(new Set(['20260923T120000Z']));
    expect(queried[0]!.attributes).toEqual(expect.arrayContaining(['sk', 'tag', 'total_cost_usd', 'cache_write_1h_tokens']));
  });

  it('writes the two reports from the rows, and says only counts', () => {
    const r = read({ ROLE, CREDENTIALS: 'success' }, {
      query: query((lane) => (lane === 'review' ? [item(1, 2), item(2, 3), item(9, 2), item(10, 2)] : [])), now: NOW, workflows: WORKFLOWS,
    });
    expect(r.status).toBe('ran');
    expect(Object.keys(r.files).sort()).toEqual([...FILES].sort());
    expect(r.files['token-trend.md']).toMatch(/^## Token efficiency — 7 days to 2026-10-07/);
    expect(r.files['token-trend.md']).toMatch(/\*\*\$5\.00 across 2 run\(s\)\*\*/);
    expect(r.files['cache-ttl.md']).toMatch(/^cache-ttl: 0 of 4 row\(s\) across \d+ lane partition\(s\) over the last 14 days/);
    expect(r.lines).toEqual([`The telemetry read ran: ${LANES.length} of ${LANES.length} lane partitions read, 4 row(s) over the last 14 days, summarised into token-trend.md and cache-ttl.md.`]);
    // Neither the key nor the account reaches anything the agent or the log reads.
    for (const text of [...Object.values(r.files), ...r.lines]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(ACCOUNT);
    }
  });

  it('names an unreadable partition in both reports, without its key, and still ran', () => {
    const r = read({ ROLE, CREDENTIALS: 'success' }, {
      query: (q) => { if (q.pk.endsWith('#implement')) throw Object.assign(new Error('x'), { stderr: `An error occurred (AccessDeniedException) on ${KEY}#implement for ${ROLE}\nmore` }); return []; },
      now: NOW, workflows: WORKFLOWS,
    });
    expect(r.status).toBe('ran');
    expect(r.files['token-trend.md']).toMatch(/UNAVAILABLE:\*\* could not read `implement` \(An error occurred \(AccessDeniedException\) on <key>#implement for <arn>\)/);
    expect(r.files['cache-ttl.md']).toMatch(/UNREADABLE \(implement\)/);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('fails, writing nothing, when no partition can be read', () => {
    const r = read({ ROLE, CREDENTIALS: 'success' }, { query: () => { throw new Error('ExpiredToken'); }, now: NOW, workflows: WORKFLOWS });
    expect(r).toMatchObject({ status: 'failed', files: {} });
    expect(r.lines[0]).toMatch(/none of the \d+ lane partitions could be read \(ExpiredToken\)/);
  });

  it('reads the table and region it is given, and refuses a malformed one before any query', () => {
    queried.length = 0;
    read({ ROLE, CREDENTIALS: 'success', TABLE: 'acme-telemetry', REGION: 'us-east-2' }, { query: query(() => []), now: NOW, workflows: WORKFLOWS });
    expect(new Set(queried.map((q) => `${q.table}@${q.region}`))).toEqual(new Set(['acme-telemetry@us-east-2']));
    const never = () => { throw new Error('must not query'); };
    const bad = read({ ROLE, CREDENTIALS: 'success', REGION: 'nowhere' }, { query: never, now: NOW, workflows: WORKFLOWS });
    expect(bad).toMatchObject({ status: 'failed', files: {} });
    expect(bad.lines[0]).toMatch(/^The telemetry read failed: the KANON_TELEMETRY_REGION variable `nowhere` is not an AWS region code/);
  });

  it('fails, reading nothing, when the role could not be assumed or isn\'t a reader role', () => {
    const never = () => { throw new Error('must not query'); };
    const refused = read({ ROLE, CREDENTIALS: 'failure' }, { query: never, now: NOW, workflows: WORKFLOWS });
    expect(refused).toMatchObject({ status: 'failed', files: {} });
    expect(refused.lines[0]).toMatch(/the reader role could not be assumed/);
    const wrong = read({ ROLE: `arn:aws:iam::${ACCOUNT}:role/kanon-telemetry-${KEY}-writer`, CREDENTIALS: 'success' }, { query: never, now: NOW, workflows: WORKFLOWS });
    expect(wrong).toMatchObject({ status: 'failed', files: {} });
    expect(wrong.lines[0]).toMatch(/is not a telemetry reader role's ARN/);
  });

  it('takes the key, account ids and ARNs out of a failure\'s reason', () => {
    expect(reasonOf({ stderr: `denied for ${ROLE} on ${KEY}#review (account ${ACCOUNT})\nsecond line` }, KEY)).toBe('denied for <arn> on <key>#review (account <account>)');
    expect(reasonOf(new Error(''), KEY)).toBe('the query failed');
  });
});

/**
 * kanon#668 (plan 0003 §6.4, option A): the Overseer's weekly job runs `kanon metrics report` over
 * this repository's own work-item and run partitions, the store's whole thirteen months, and writes
 * the Markdown to the job summary. The rows never leave the job: only the report's figures do.
 */
describe('the headline report (kanon#668)', () => {
  type Q = { pk: string, from?: string, attributes?: readonly string[], table?: string, region?: string, timeout?: number };
  /** Rows as the store holds them: each attribute typed, under its partition and sort key. */
  const store = (rows: Record<string, unknown>[]) => rows.map((r) => {
    const { pk, sk } = keysOf(KEY, r);
    return { pk: { S: pk }, sk: { S: sk }, ...toAttributes({ ...r, received_at: r.recorded_at, expires_at: 1_900_000_000, source: 'writer' }) };
  });
  const rows = [
    ...risingRows({ S: 12, M: 12, L: 12, XL: 12 }),
    itemRow(900, { closed: ago(3), fate: 'closed_unmerged', band: 'M' }),
    runRow('implement', { pr: 900, at: ago(4), cost: 2 }),
    runRow('explore', { at: ago(2), cost: 1.5 }),
    runRow('implement', { pr: 1, at: ago(2), cost: 99, tag: 'smoke' }),
  ];
  const NOW_MS = UNTIL.getTime();
  const fake = (items: ReturnType<typeof store>, fail: (pk: string) => unknown = () => null) => {
    const queried: Q[] = [];
    const query = (q: Q) => {
      queried.push(q);
      const e = fail(q.pk);
      if (e) throw e;
      return items.filter((i) => i.pk.S === q.pk && (q.from === undefined || i.sk.S > q.from)) as never;
    };
    return { queried, query };
  };
  /** What `kanon metrics report` prints for the same rows, the same day. */
  const cli = (input: unknown[]) => {
    const out: string[] = [];
    const code = cliReport(['--rows', 'rows.json'], { out: (l) => out.push(l), err: (l) => out.push(l), readFile: () => JSON.stringify(input), release: () => 'test', now: () => UNTIL });
    expect(code).toBe(0);
    return out.join('\n');
  };

  it('reads the store as rows: each attribute\'s value, without the store\'s key', () => {
    expect(rowOf({ pk: { S: `${KEY}#review` }, sk: { S: '20261001T000000Z#1-1-2' }, lane: { S: 'review' }, total_cost_usd: { N: '1.25' }, pr_number: { N: '2' }, cache_1h: { BOOL: true } }))
      .toEqual({ lane: 'review', total_cost_usd: 1.25, pr_number: 2, cache_1h: true });
  });

  it('reads the work-item partition whole and every lane\'s partition over thirteen months, unprojected', () => {
    const { queried, query } = fake(store(rows));
    const r = headline({ ROLE, CREDENTIALS: 'success', TABLE: 'acme-telemetry', REGION: 'us-east-2' }, { query, now: NOW_MS });
    expect(r.status).toBe('ran');
    expect(REPORT_MONTHS).toBe(13);
    expect(queried.map((q) => q.pk)).toEqual([`${KEY}#work`, ...LANES.map((l) => `${KEY}#${l}`)]);
    // A work item's sort key is its PR number, not a time: the partition is read whole.
    expect(queried[0]!.from).toBeUndefined();
    expect(new Set(queried.slice(1).map((q) => q.from))).toEqual(new Set(['20250910T000000Z']));
    expect(queried.every((q) => q.attributes === undefined)).toBe(true);
    expect(new Set(queried.map((q) => `${q.table}@${q.region}`))).toEqual(new Set(['acme-telemetry@us-east-2']));
  });

  it('is `kanon metrics report`\'s Markdown for the same rows, and says only counts', () => {
    const { query } = fake(store(rows));
    const r = headline({ ROLE, CREDENTIALS: 'success' }, { query, now: NOW_MS });
    expect(r.status).toBe('ran');
    expect(r.markdown).toBe(`${cli(rows)}\n`);
    expect(r.markdown).toMatch(/^## Kanon metrics, /);
    // The fixture is big enough for numbers, so the comparison isn't of two empty reports.
    expect(r.markdown).toMatch(/\| Cost per merged item, median \| \$\d/);
    expect(r.markdown).toMatch(/Rows read: 98 runs .* and 49 work items; left out: 1 not `tag: run`/);
    const runs = rows.filter((x) => x.row_kind === 'run').length;
    expect(r.lines).toEqual([`The headline report ran: ${LANES.length + 1} partitions read, 49 work item(s) and ${runs} run row(s) over the last 13 months, written to the job summary.`]);
    for (const text of [r.markdown, ...r.lines]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(ACCOUNT);
    }
  });

  it('withholds the report when any partition can\'t be read, naming it without its key', () => {
    for (const lane of ['work', 'implement']) {
      const denied = Object.assign(new Error('x'), { stderr: `An error occurred (AccessDeniedException) on ${KEY}#${lane} for ${ROLE}` });
      const { query } = fake(store(rows), (pk) => (pk === `${KEY}#${lane}` ? denied : null));
      const r = headline({ ROLE, CREDENTIALS: 'success' }, { query, now: NOW_MS });
      expect(r, lane).toMatchObject({ status: 'failed', markdown: '' });
      expect(r.lines, lane).toEqual([`The headline report was not made: the \`${lane}\` partition could not be read (An error occurred (AccessDeniedException) on <key>#${lane} for <arn>), and a report without it would be wrong.`]);
    }
  });

  it('reads nothing when the store, the role or the credentials are not right', () => {
    const never = () => { throw new Error('must not query'); };
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ ROLE, CREDENTIALS: 'success', REGION: 'nowhere' }, /^The headline report was not made: the KANON_TELEMETRY_REGION variable `nowhere` is not an AWS region code/],
      [{ ROLE: `arn:aws:iam::${ACCOUNT}:role/kanon-telemetry-${KEY}-writer`, CREDENTIALS: 'success' }, /^The headline report was not made: the KANON_TELEMETRY_READER_ROLE secret is not a telemetry reader role's ARN/],
      [{ ROLE, CREDENTIALS: 'failure' }, /^The headline report was not made: the reader role could not be assumed/],
    ];
    for (const [env, says] of cases) {
      const r = headline(env, { query: never, now: NOW_MS });
      expect(r, JSON.stringify(env)).toMatchObject({ status: 'failed', markdown: '' });
      expect(r.lines[0]).toMatch(says);
    }
  });
});

/**
 * kanon#682: the report step never fails the job. It holds a deadline of its own inside the job's
 * timeout, so no slow store holds the job past it, and a throw anywhere in it is a warning.
 */
describe('the report step never fails the job (kanon#682)', () => {
  const NOW_MS = UNTIL.getTime();
  const ok = (items: unknown[] = []) => () => items as never;
  /** A store that takes `ms` of the fake clock per query, and records each query's limit. */
  const slow = (ms: number) => {
    let t = NOW_MS;
    const timeouts: number[] = [];
    const clock = () => t;
    const query = (q: { timeout?: number }) => {
      timeouts.push(q.timeout!);
      t += ms;
      return [] as never;
    };
    return { clock, query, timeouts };
  };

  it('keeps its deadline inside the job\'s timeout, the workflow\'s own', () => {
    const wf = parse(readFileSync(join(WORKFLOWS, 'agent-overseer.yml'), 'utf8')) as { jobs: { telemetry: { 'timeout-minutes': number } } };
    expect(wf.jobs.telemetry['timeout-minutes']).toBe(JOB_TIMEOUT_MINUTES);
    expect(REPORT_BY_MS).toBeLessThan(JOB_TIMEOUT_MINUTES * 60_000);
    expect(REPORT_FALLBACK_MS).toBeLessThan(REPORT_BY_MS);
  });

  it('counts its deadline from the job\'s stamped start, or from its own start when the stamp is missing or stale', () => {
    const at = NOW_MS;
    expect(deadlineOf(`${at - 60_000}\n`, at)).toBe(at - 60_000 + REPORT_BY_MS);
    expect(deadlineOf(String(at), at)).toBe(at + REPORT_BY_MS);
    for (const stamp of [undefined, '', 'soon', String(at + 1), String(at - JOB_TIMEOUT_MINUTES * 60_000), String(at - 86_400_000)]) {
      expect(deadlineOf(stamp, at), String(stamp)).toBe(at + REPORT_FALLBACK_MS);
    }
  });

  it('starts no partition after its deadline, and withholds the report, naming the partition', () => {
    const { clock, query, timeouts } = slow(60_000);
    const r = headline({ ROLE, CREDENTIALS: 'success' }, { query, now: NOW_MS, clock, deadline: NOW_MS + 5 * 60_000 });
    expect(r).toMatchObject({ status: 'failed', markdown: '' });
    // Five queries of a minute each use the five minutes; the sixth partition is never started.
    expect(timeouts).toHaveLength(5);
    expect(r.lines).toEqual([`The headline report was not made: its time ran out before the \`${LANES[4]}\` partition was read (the step keeps inside the job's ${JOB_TIMEOUT_MINUTES}-minute timeout), and a report without it would be wrong.`]);
  });

  it('gives no query longer than what is left of its deadline', () => {
    const { clock, query, timeouts } = slow(1_000);
    const r = headline({ ROLE, CREDENTIALS: 'success' }, { query, now: NOW_MS, clock, deadline: NOW_MS + QUERY_TIMEOUT_MS + 2_500 });
    expect(r.status).toBe('ran');
    expect(timeouts.slice(0, 5)).toEqual([QUERY_TIMEOUT_MS, QUERY_TIMEOUT_MS, QUERY_TIMEOUT_MS, QUERY_TIMEOUT_MS - 500, QUERY_TIMEOUT_MS - 1_500]);
    // Without a deadline, a query keeps its own limit.
    const plain = slow(1_000);
    headline({ ROLE, CREDENTIALS: 'success' }, { query: plain.query, now: NOW_MS, clock: plain.clock });
    expect(new Set(plain.timeouts)).toEqual(new Set([QUERY_TIMEOUT_MS]));
  });

  it('says a query cut off by the deadline ran out of time, not that the store refused it', () => {
    let t = NOW_MS;
    const query = (q: { timeout?: number }) => { t += q.timeout!; throw Object.assign(new Error('spawnSync aws ETIMEDOUT'), { code: 'ETIMEDOUT' }); };
    const r = headline({ ROLE, CREDENTIALS: 'success' }, { query, now: NOW_MS, clock: () => t, deadline: NOW_MS + 30_000 });
    expect(r.lines).toEqual([expect.stringMatching(/^The headline report was not made: its time ran out while the `work` partition was read/)]);
  });

  it('a step out of time warns, writes no report, and returns', () => {
    const { clock, query } = slow(60_000);
    const log: string[] = [];
    const summary: string[] = [];
    reportStep({ ROLE, CREDENTIALS: 'success', GITHUB_STEP_SUMMARY: 'summary' }, { query, now: NOW_MS, clock, stamp: () => String(NOW_MS - REPORT_BY_MS + 90_000), append: (_p, t) => { summary.push(t); }, log: (l) => { log.push(l); } });
    expect(log).toEqual([expect.stringMatching(/^::warning title=overseer metrics::The headline report was not made: its time ran out before the `\S+` partition was read/)]);
    expect(summary.join('')).not.toContain('## Kanon metrics');
    expect(summary.join('')).toMatch(/^The headline report was not made: its time ran out/);
  });

  it('a throw from the report warns, without the key, and returns', () => {
    const log: string[] = [];
    const summary: string[] = [];
    // A row the store couldn't hold: making the report throws.
    reportStep({ ROLE, CREDENTIALS: 'success', GITHUB_STEP_SUMMARY: 'summary' }, { query: ok([null]), now: NOW_MS, append: (_p, t) => { summary.push(t); }, log: (l) => { log.push(l); } });
    expect(log).toEqual([expect.stringMatching(/^::warning title=overseer metrics::The headline report stopped on an error \(.+\); the job is not failed for it\.$/)]);
    expect(summary).toEqual([expect.stringMatching(/^The headline report stopped on an error/)]);
  });

  it('a throw from the summary\'s write warns, and returns', () => {
    const log: string[] = [];
    const append = () => { throw Object.assign(new Error(`EISDIR: illegal operation on a directory, open '/tmp/${KEY}'`), { code: 'EISDIR' }); };
    expect(() => reportStep({ ROLE, CREDENTIALS: 'success', GITHUB_STEP_SUMMARY: 'summary' }, { query: ok(), now: NOW_MS, append, log: (l) => { log.push(l); } })).not.toThrow();
    expect(log).toEqual([`::warning title=overseer metrics::The headline report stopped on an error (EISDIR: illegal operation on a directory, open '/tmp/<key>'); the job is not failed for it.`]);
    // Even a log that throws doesn't throw out of the step.
    expect(() => reportStep({ ROLE, CREDENTIALS: 'success', GITHUB_STEP_SUMMARY: 'summary' }, { query: ok(), now: NOW_MS, append, log: () => { throw new Error('EPIPE'); } })).not.toThrow();
  });
});

describe('the merge into the export', () => {
  const exportDir = (manifest: Record<string, unknown> | null, files: Record<string, string> = {}) => {
    const root = temp();
    const dir = join(root, 'qa-store-export');
    mkdirSync(dir);
    if (manifest) writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t);
    return dir;
  };
  const telemetry = (files: string[] = [...FILES]) => {
    const dir = temp();
    for (const f of files) writeFileSync(join(dir, f), `kanon ${f}\n`);
    return dir;
  };
  const manifestOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const PRESENT = { store: 'present', kind: 'overseer', files: ['areas.json'], reports: 0 };

  it('adds the read\'s files and says it ran, replacing a hook\'s own', () => {
    const dir = exportDir(PRESENT, { 'areas.json': '[]', 'token-trend.md': 'hook\n' });
    expect(merge({ TELEMETRY_STATUS: 'ran', TELEMETRY_DIR: telemetry(), EXPORT_DIR: dir })).toEqual({ status: 'ran', line: "Telemetry read: ran; token-trend.md and cache-ttl.md are from this repository's own rows." });
    expect(readFileSync(join(dir, 'token-trend.md'), 'utf8')).toBe('kanon token-trend.md\n');
    expect(manifestOf(dir)).toEqual({ ...PRESENT, telemetry: 'ran', files: ['areas.json', 'cache-ttl.md', 'token-trend.md'] });
  });

  it('passes a hook\'s own files on when the read didn\'t run, and says so', () => {
    const dir = exportDir(PRESENT, { 'areas.json': '[]', 'token-trend.md': 'hook\n', 'cache-ttl.md': 'hook\n' });
    const r = merge({ TELEMETRY_STATUS: 'not configured', TELEMETRY_DIR: telemetry(), EXPORT_DIR: dir });
    expect(r).toEqual({ status: 'not configured', line: "Telemetry read: not configured. The store hook's own files are passed on." });
    expect(readFileSync(join(dir, 'token-trend.md'), 'utf8')).toBe('hook\n');
    expect(manifestOf(dir)).toMatchObject({ store: 'present', telemetry: 'not configured', files: ['areas.json', 'cache-ttl.md', 'token-trend.md'] });
  });

  it('keeps the store\'s own state: an absent store with a read that ran is still an absent store', () => {
    const dir = exportDir({ store: 'absent', kind: 'overseer', files: [], reports: 0 });
    merge({ TELEMETRY_STATUS: 'ran', TELEMETRY_DIR: telemetry(), EXPORT_DIR: dir });
    expect(manifestOf(dir)).toEqual({ store: 'absent', kind: 'overseer', files: ['cache-ttl.md', 'token-trend.md'], reports: 0, telemetry: 'ran' });
  });

  it('calls a read that ran but left no files `failed`, and any other status too', () => {
    const missing = exportDir(PRESENT);
    expect(merge({ TELEMETRY_STATUS: 'ran', TELEMETRY_DIR: telemetry(['token-trend.md']), EXPORT_DIR: missing }).status).toBe('failed');
    expect(readdirSync(missing)).toEqual(['manifest.json']);
    expect(manifestOf(missing).telemetry).toBe('failed');
    for (const odd of ['', 'yes', undefined]) expect(merge({ TELEMETRY_STATUS: odd, EXPORT_DIR: exportDir(PRESENT) }).status).toBe('failed');
    expect(STATUSES).toEqual(['ran', 'not configured', 'not run on this trigger', 'failed']);
  });

  // kanon#499: on the runtime-version trigger the read isn't tried, and the manifest says so.
  it('records `not run on this trigger` as it is, passing a hook\'s own files on', () => {
    const dir = exportDir(PRESENT, { 'areas.json': '[]', 'cache-ttl.md': 'hook\n' });
    expect(merge({ TELEMETRY_STATUS: 'not run on this trigger', TELEMETRY_DIR: telemetry(), EXPORT_DIR: dir })).toEqual({ status: 'not run on this trigger', line: "Telemetry read: not run on this trigger. The store hook's own files are passed on." });
    expect(readFileSync(join(dir, 'cache-ttl.md'), 'utf8')).toBe('hook\n');
    expect(manifestOf(dir)).toMatchObject({ telemetry: 'not run on this trigger', files: ['areas.json', 'cache-ttl.md'] });
  });

  it('writes a manifest even when the export\'s is unreadable, saying so', () => {
    const dir = exportDir(null);
    merge({ TELEMETRY_STATUS: 'not configured', EXPORT_DIR: dir });
    expect(manifestOf(dir)).toEqual({ store: 'unreadable', telemetry: 'not configured', files: [] });
  });
});

// Its cases run the script in `node` against a stub `aws`, so the block takes the spawn budget (#436).
describe('the script, as the lane runs it', SPAWNS, () => {
  /** A stand-in `aws` on the PATH that records its arguments and answers rows. */
  const fakeAws = (answer: string) => {
    const bin = temp();
    const log = join(bin, 'calls');
    // A link to the shared shim, never a new executable that macOS scans on its first run (#436).
    writeStub(join(bin, 'aws'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nprintf '%s' '${answer}'\n`);
    return { bin, log };
  };
  const run = (mode: string, env: Record<string, string>) => spawnSync(process.execPath, [SCRIPT, mode], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });

  it('read: queries the hosted table, writes the two files, outputs `ran`, and prints no row', () => {
    const rowCost = '7.25';
    const { bin, log } = fakeAws(JSON.stringify({ Items: [item(1, Number(rowCost))] }));
    const out = join(temp(), 'out');
    const outputs = join(temp(), 'outputs');
    const r = run('read', { PATH: `${bin}:${process.env.PATH}`, ROLE, CREDENTIALS: 'success', OUT: out, GITHUB_OUTPUT: outputs });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(outputs, 'utf8')).toBe('status=ran\n');
    expect(readdirSync(out).sort()).toEqual(['cache-ttl.md', 'token-trend.md']);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(LANES.length);
    expect(calls[0]).toContain('dynamodb query --table-name kanon-telemetry --region eu-central-1');
    expect(calls[0]).toContain(`"S":"${KEY}#${LANES[0]}"`);
    expect(calls[0]).toContain('--projection-expression');
    // The rows reach the files as figures, never the log.
    expect(r.stdout).not.toContain(rowCost);
    expect(r.stdout).not.toContain('Items');
  });

  it('read: a refused role outputs `failed`, writes nothing, warns, and exits 0', () => {
    const out = join(temp(), 'out');
    const outputs = join(temp(), 'outputs');
    const r = run('read', { ROLE, CREDENTIALS: 'failure', OUT: out, GITHUB_OUTPUT: outputs });
    expect(r.status).toBe(0);
    expect(readFileSync(outputs, 'utf8')).toBe('status=failed\n');
    expect(existsSync(out)).toBe(false);
    expect(r.stdout).toMatch(/::warning title=overseer telemetry::The telemetry read failed/);
  });

  // kanon#499: the variables are resolved once, here; an unset or an empty one is the hosted store's.
  it('mask: resolves an unset or empty variable to the hosted store\'s table and region, as its outputs', () => {
    for (const env of [{}, { TABLE: '', REGION: '' }, { TABLE: '  ', REGION: '\n' }] as Array<Record<string, string>>) {
      const outputs = join(temp(), 'outputs');
      const r = run('mask', { ROLE, GITHUB_OUTPUT: outputs, ...env });
      expect(r.status, JSON.stringify(env)).toBe(0);
      expect(readFileSync(outputs, 'utf8'), JSON.stringify(env)).toBe('table=kanon-telemetry\nregion=eu-central-1\n');
    }
    const outputs = join(temp(), 'outputs');
    expect(run('mask', { ROLE, GITHUB_OUTPUT: outputs, TABLE: 'acme-telemetry', REGION: 'us-east-2' }).status).toBe(0);
    expect(readFileSync(outputs, 'utf8')).toBe('table=acme-telemetry\nregion=us-east-2\n');
  });

  it('mask: registers the three masks first, then checks the table and region', () => {
    const ok = run('mask', { ROLE, GITHUB_OUTPUT: join(temp(), 'o') });
    expect(ok.status).toBe(0);
    expect(ok.stdout.split('\n').slice(0, 3)).toEqual([`::add-mask::${ROLE}`, `::add-mask::${ACCOUNT}`, `::add-mask::${KEY}`]);
    expect(ok.stdout).toContain('Reading the telemetry table kanon-telemetry in eu-central-1.');
    const badOut = join(temp(), 'o');
    const bad = run('mask', { ROLE, TABLE: 'a b', REGION: 'eu-central-1', GITHUB_OUTPUT: badOut });
    expect(bad.status).toBe(1);
    // A refused value hands nothing on: the credentials step gets no region at all.
    expect(existsSync(badOut)).toBe(false);
    expect(bad.stdout.split('\n').slice(0, 3)).toEqual([`::add-mask::${ROLE}`, `::add-mask::${ACCOUNT}`, `::add-mask::${KEY}`]);
    expect(bad.stdout).toMatch(/::error title=overseer telemetry::the KANON_TELEMETRY_TABLE variable `a b` is not a DynamoDB table name/);
  });

  it('read: queries the table and region it is handed', () => {
    const { bin, log } = fakeAws(JSON.stringify({ Items: [] }));
    const r = run('read', { PATH: `${bin}:${process.env.PATH}`, ROLE, CREDENTIALS: 'success', OUT: join(temp(), 'out'), GITHUB_OUTPUT: join(temp(), 'o'), TABLE: 'acme-telemetry', REGION: 'us-east-2' });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(log, 'utf8').split('\n')[0]).toContain('dynamodb query --table-name acme-telemetry --region us-east-2');
  });

  // kanon#668: the report step, the job's last.
  it('report: writes the Markdown to the job summary, queries every partition, prints no row, and exits 0', () => {
    const rowCost = '7.25';
    const items = [
      { pk: { S: `${KEY}#work` }, sk: { S: 'pr-0000000007' }, row_kind: { S: 'work_item' }, tag: { S: 'run' }, pr_number: { N: '7' }, closed_at: { S: '2026-10-01T00:00:00Z' }, recorded_at: { S: '2026-10-01T00:00:00Z' }, fate: { S: 'merged' } },
      { pk: { S: `${KEY}#implement` }, sk: { S: '20260930T000000Z#1-1-7' }, row_kind: { S: 'run' }, tag: { S: 'run' }, lane: { S: 'implement' }, pr_number: { N: '7' }, recorded_at: { S: '2026-09-30T00:00:00Z' }, total_cost_usd: { N: rowCost } },
    ];
    const { bin, log } = fakeAws(JSON.stringify({ Items: items }));
    const summary = join(temp(), 'summary');
    const r = run('report', { PATH: `${bin}:${process.env.PATH}`, ROLE, CREDENTIALS: 'success', GITHUB_STEP_SUMMARY: summary });
    expect(r.status, r.stderr).toBe(0);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(LANES.length + 1);
    expect(calls[0]).toContain('dynamodb query --table-name kanon-telemetry --region eu-central-1');
    expect(calls[0]).toContain(`"S":"${KEY}#work"`);
    expect(calls[0]).not.toContain(':from');
    expect(calls.every((c) => !c.includes('--projection-expression'))).toBe(true);
    const text = readFileSync(summary, 'utf8');
    expect(text).toMatch(/^## Kanon metrics, /);
    expect(text).toMatch(/The headline report ran: \d+ partitions read/);
    // The rows reach the summary as figures, never the log.
    expect(r.stdout).not.toContain(rowCost);
    expect(r.stdout).not.toContain('Items');
    expect(r.stdout).not.toContain('Kanon metrics');
  });

  it('report: a refused role warns, says so in the summary, writes no report, and exits 0', () => {
    const summary = join(temp(), 'summary');
    const r = run('report', { ROLE, CREDENTIALS: 'failure', GITHUB_STEP_SUMMARY: summary });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/::warning title=overseer metrics::The headline report was not made: the reader role could not be assumed/);
    expect(readFileSync(summary, 'utf8')).toMatch(/^The headline report was not made: the reader role could not be assumed/);
    expect(readFileSync(summary, 'utf8')).not.toContain('## Kanon metrics');
  });

  // kanon#682: the job's start, for the report's deadline; the step's outputs are unchanged.
  it('mask: stamps the job\'s start under the runner\'s temp directory, outside the uploaded one', () => {
    const runnerTemp = temp();
    const outputs = join(temp(), 'outputs');
    const before = Date.now();
    expect(run('mask', { ROLE, GITHUB_OUTPUT: outputs, RUNNER_TEMP: runnerTemp }).status).toBe(0);
    expect(readdirSync(runnerTemp)).toEqual([STARTED_FILE]);
    const started = Number(readFileSync(join(runnerTemp, STARTED_FILE), 'utf8'));
    expect(started).toBeGreaterThanOrEqual(before);
    expect(started).toBeLessThanOrEqual(Date.now());
    expect(readFileSync(outputs, 'utf8')).toBe('table=kanon-telemetry\nregion=eu-central-1\n');
  });

  it('report: a query past the deadline is killed, the report withheld, the outputs untouched, and it exits 0', () => {
    const bin = temp();
    // A store that never answers in time: the CLI must be killed, not waited for.
    writeStub(join(bin, 'aws'), '#!/usr/bin/env bash\nexec sleep 30\n');
    const runnerTemp = temp();
    // The job started so long ago that half a second of the report's time is left.
    writeFileSync(join(runnerTemp, STARTED_FILE), `${Date.now() - REPORT_BY_MS + 500}\n`);
    const summary = join(temp(), 'summary');
    const outputs = join(temp(), 'outputs');
    writeFileSync(outputs, 'status=ran\n');
    const began = Date.now();
    const r = run('report', { PATH: `${bin}:${process.env.PATH}`, ROLE, CREDENTIALS: 'success', GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: outputs, RUNNER_TEMP: runnerTemp });
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/::warning title=overseer metrics::The headline report was not made: its time ran out (while|before) the `work` partition was read/);
    expect(readFileSync(summary, 'utf8')).not.toContain('## Kanon metrics');
    expect(readFileSync(outputs, 'utf8')).toBe('status=ran\n');
  });

  it('report: a summary it can\'t write warns, and exits 0', () => {
    const { bin } = fakeAws(JSON.stringify({ Items: [] }));
    const r = run('report', { PATH: `${bin}:${process.env.PATH}`, ROLE, CREDENTIALS: 'success', GITHUB_STEP_SUMMARY: temp() });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/::warning title=overseer metrics::The headline report stopped on an error \(.+\); the job is not failed for it\./);
    expect(r.stdout).not.toContain(KEY);
  });

  it('refuses an unknown mode', () => {
    expect(run('dump', {}).status).toBe(2);
  });
});
