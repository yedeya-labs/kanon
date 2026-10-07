import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { LANES } from '../../infra/telemetry/function/schema.mjs';
import { FILES, REGION, STATUSES, TABLE, WINDOW_DAYS, masksOf, merge, read, readerOf, reasonOf } from '../../scripts/overseer-telemetry.mjs';

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

  it('reads the hosted store, where it lives', () => {
    expect(TABLE).toBe('kanon-telemetry');
    expect(REGION).toBe('eu-central-1');
    expect(WINDOW_DAYS).toBe(14);
  });
});

describe('the read', () => {
  const queried: Array<{ pk: string, from: string, attributes: readonly string[] }> = [];
  const query = (items: (lane: string) => unknown[]) => (q: { pk: string, from: string, attributes: readonly string[] }) => {
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
    expect(STATUSES).toEqual(['ran', 'not configured', 'failed']);
  });

  it('writes a manifest even when the export\'s is unreadable, saying so', () => {
    const dir = exportDir(null);
    merge({ TELEMETRY_STATUS: 'not configured', EXPORT_DIR: dir });
    expect(manifestOf(dir)).toEqual({ store: 'unreadable', telemetry: 'not configured', files: [] });
  });
});

describe('the script, as the lane runs it', () => {
  /** A stand-in `aws` on the PATH that records its arguments and answers rows. */
  const fakeAws = (answer: string) => {
    const bin = temp();
    const log = join(bin, 'calls');
    writeFileSync(join(bin, 'aws'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nprintf '%s' '${answer}'\n`);
    chmodSync(join(bin, 'aws'), 0o755);
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

  it('mask: registers the three masks first', () => {
    expect(run('mask', { ROLE }).stdout.split('\n').slice(0, 3)).toEqual([`::add-mask::${ROLE}`, `::add-mask::${ACCOUNT}`, `::add-mask::${KEY}`]);
  });

  it('refuses an unknown mode', () => {
    expect(run('dump', {}).status).toBe(2);
  });
});
