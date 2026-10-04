import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KANON_LANES, fleetConfig, matchIssues, sliceChangelog, statusLine } from '../../scripts/cc-sweep.mjs';
import { ROOT } from './helpers/adopter.js';

/**
 * RA-2276 — the changelog slice shared by the Overseer's capability review and a by-hand sweep.
 * Moved from the reference adopter with the Overseer's lane (plan 0004 step 13).
 * Each fixture is one of the silent failures the playbook measured: a 404 body read as a
 * bad watermark, an unmatched watermark slicing the whole file, and a bound applied from
 * the wrong end.
 */
const changelog = (versions: string[], linesPer = 3) =>
  ['# Changelog', '', ...versions.flatMap((v) => [`## ${v}`, '', ...Array.from({ length: linesPer }, (_, i) => `- ${v} item ${i}`), ''])].join('\n');

/** Every field any outcome carries, so a test can read the one its outcome has. */
type AnySlice = { status: string; headers: number; head?: string; lines?: number; versions?: number; truncated?: number; slice?: string; matches?: number };
const slice = (...a: Parameters<typeof sliceChangelog>) => sliceChangelog(...a) as AnySlice;

const CL = changelog(['2.1.280', '2.1.279', '2.1.278', '2.1.277']);

describe('sliceChangelog', () => {
  it('slices HEAD down to, and not including, the watermark header', () => {
    const r = slice(CL, '2.1.278');
    expect(r.status).toBe('ok');
    expect(r.head).toBe('2.1.280');
    expect(r.versions).toBe(2);
    expect(r.truncated).toBe(0);
    expect(r.slice).toContain('## 2.1.279');
    expect(r.slice).not.toContain('## 2.1.278');
  });

  it('reports a 404 body as fetch-failed, not as a bad watermark', () => {
    // curl without -f exits 0 and writes this; the header count is the only discriminator.
    expect(slice('404: Not Found', '2.1.278')).toEqual({ status: 'fetch-failed', headers: 0 });
    expect(slice('', '2.1.278').status).toBe('fetch-failed');
  });

  it('refuses to slice on a watermark matching no header, and still names HEAD for the ladder', () => {
    // An unmatched watermark would otherwise print the WHOLE file.
    // '2.1.28' is a PREFIX of exactly one header (2.1.280): a startsWith match would accept it.
    for (const bad of ['2.1.99', '`2.1.278`', 'v2.1.278', '2.1.278 (2026-09-01)', '2.1.28']) {
      const r = slice(CL, bad);
      expect(r.status, bad).toBe('bad-watermark');
      expect(r).not.toHaveProperty('slice');
      expect(r.head).toBe('2.1.280');
    }
  });

  it('refuses a watermark matching more than one header', () => {
    const dup = `${CL}\n## 2.1.278\n`;
    expect(slice(dup, '2.1.278')).toMatchObject({ status: 'bad-watermark', matches: 2 });
  });

  it('yields no versions, not an error, when the watermark is HEAD', () => {
    const r = slice(CL, '2.1.280');
    expect(r).toMatchObject({ status: 'ok', versions: 0, truncated: 0 });
  });

  it('bounds an over-large slice from the NEWEST end and counts what it skipped', () => {
    const big = changelog(Array.from({ length: 40 }, (_, i) => `2.1.${300 - i}`), 10);
    const r = slice(big, '2.1.261', 100);
    expect(r.status).toBe('ok');
    expect(r.lines).toBe(100);
    expect(r.slice).toContain('## 2.1.300');           // newest kept
    expect(r.slice).not.toContain('## 2.1.262');       // oldest dropped
    expect(r.versions! + r.truncated!).toBe(39);
    expect(r.truncated).toBeGreaterThan(0);
  });
});

describe('statusLine', () => {
  it('prints the fields the playbook reads, for each outcome', () => {
    expect(statusLine(sliceChangelog(CL, '2.1.278'), '2.1.278'))
      .toBe('cc-sweep: ok headers=4 watermark=2.1.278 head=2.1.280 lines=14 versions=2 truncated=0');
    expect(statusLine(sliceChangelog('', 'x'), 'x')).toBe('cc-sweep: fetch-failed headers=0');
    expect(statusLine(sliceChangelog(CL, '9.9.9'), '9.9.9'))
      .toBe('cc-sweep: bad-watermark headers=4 watermark=9.9.9 matches=0 head=2.1.280');
  });
});

describe('matchIssues', () => {
  const issues = [
    { number: 2, state: 'OPEN', title: 'Move the reviewer to Opus 5.5', body: 'uses claude-opus-5-5' },
    { number: 1, state: 'CLOSED', title: 'Other', body: null },
  ];
  it('matches identifiers case-insensitively over title and body, and says when nothing does', () => {
    expect(matchIssues(issues, ['CLAUDE-OPUS-5-5', 'omitClaudeMd'])).toEqual([
      'CLAUDE-OPUS-5-5: #2 OPEN Move the reviewer to Opus 5.5',
      'omitClaudeMd: no issue mentions it',
    ]);
  });
});

describe('fleetConfig', () => {
  it('finds every agent workflow that passes claude_args, with its model, in Kanon\'s own tree', () => {
    const lines = fleetConfig(join(ROOT, '.github/workflows'));
    // A regex that silently matched nothing would make the snapshot look like an empty fleet.
    expect(lines.length).toBeGreaterThanOrEqual(12);
    expect(lines.some((l) => l.startsWith('agent-review.yml') && /model=claude-opus-5/.test(l))).toBe(true);
    expect(lines.some((l) => l.startsWith('agent-overseer.yml') && /model=claude-fable-5-1/.test(l))).toBe(true);
  });

  it('reads an adopter\'s trigger-only caller through the lane it calls, from this Kanon tree', () => {
    expect(KANON_LANES).toBe(join(ROOT, '.github/workflows/'));
    const dir = mkdtempSync(join(tmpdir(), 'cc-sweep-'));
    try {
      mkdirSync(join(dir, 'wf'));
      writeFileSync(join(dir, 'wf', 'agent-overseer.yml'), 'jobs:\n  overseer:\n    uses: yedeya-labs/kanon/.github/workflows/agent-overseer.yml@v1.2.3\n');
      writeFileSync(join(dir, 'wf', 'ci.yml'), 'jobs: {}\n');
      const lines = fleetConfig(join(dir, 'wf'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^agent-overseer\.yml\s+model=claude-fable-5-1 effort=high max-turns=80 autocompact=- \(x2\)$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
