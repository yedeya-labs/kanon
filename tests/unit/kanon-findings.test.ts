import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { nameHashesVariable } from '../../infra/telemetry/render.mjs';
import { detect, parseRows, signature } from '../../scripts/telemetry/kanon-bugs.mjs';
import {
  BODY_BUDGET, LABELS, assertNoKeyIn, holdsKey, main, plan, readFinding, registerContext,
} from '../../scripts/telemetry/kanon-findings.mjs';

/**
 * Plan 0006 step F5: the public logic of the #41 job's private filing of upstream findings (§6).
 * Pure, so every case runs on fixture rows keyed by made-up adopter keys, a fixture tree and a
 * fixture register. Nothing touches the network, git or AWS.
 */

type Row = Record<string, unknown>;
const DIR = 'tests/fixtures/telemetry/kanon-findings';
const ROWS = parseRows(readFileSync(join(DIR, 'rows.jsonl'), 'utf8')) as Row[];
const TREES = JSON.parse(readFileSync(join(DIR, 'trees.json'), 'utf8')) as Record<string, string[]>;
const REGISTER = JSON.parse(readFileSync(join(DIR, 'register.json'), 'utf8'));
const CTX = { ...registerContext(REGISTER), trees: TREES, tag: 'test' };
const KEYS = ['a1b2c3d4', 'e5f6a7b8', 'kfixture3'];

let seq = 0;
/** A valid finding row of key `k` at tag `test`, a lane finding on the fixture signal unless overridden. */
const finding = (k: string, over: Row = {}): Row => ({
  pk: `${k}#finding`, sk: `20261007T090000Z#${(seq += 1)}-1-0`,
  schema_version: 1, row_kind: 'finding', tag: 'test', recorded_at: '2026-10-07T09:00:00Z',
  run_id: 90_000_000_000 + seq, run_attempt: 1, finding_index: 0, reporter: 'overseer', subject: 'lane',
  lane: 'review', failed_stage: 'agent', reason: 'did_not_finish', kanon_version: '0.37.0',
  fix_category: 'lane-behaviour', evidence_level: 'codes', ...over,
});
/** The same finding at level 2, with the evidence given. */
const withEvidence = (k: string, evidence: string, over: Row = {}): Row =>
  finding(k, { evidence_level: 'evidence', evidence, scrub_version: 1, ...over });
const failedRun = (k: string, over: Row = {}): Row => ({
  pk: `${k}#review`, row_kind: 'run', tag: 'test', recorded_at: '2026-10-05T10:00:00Z', lane: 'review',
  outcome: 'failed', reason: 'did_not_finish', failed_stage: 'agent', kanon_version: '0.37.0', ...over,
});
const CLEAN = 'Expected: the review lane finishes within its turn cap (K-AGENT-12).\nWhere: scripts/merge-gate.mjs:120.';
const SIGNAL = signature({ lane: 'review', failed_stage: 'agent', kanon_error: null, reason: 'did_not_finish', kanon_version: '0.37.0' });

const only = (r: ReturnType<typeof plan>, sig: string) => {
  const found = r.findings.issues.filter((i) => i.signature === sig);
  expect(found).toHaveLength(1);
  return found[0]!;
};
const problemsOf = (row: Row) => {
  const r = readFinding(row as never, { tag: 'test', trees: TREES, names: CTX.names, keys: new Set(KEYS) });
  if (!('finding' in r)) throw new Error(`skipped: ${r.skip}`);
  return r.finding.problems.map((p) => `${p.field} (${p.problem})`);
};

describe("F5's check: one private issue per signature, beside the signal (plan 0006 §6, §8)", () => {
  it("a seeded test finding with a signal's signature goes on that signal's issue, and files no second", () => {
    const r = plan(ROWS as never, CTX);
    const s = r.signals.find((x) => x.signature === SIGNAL);
    expect(s).toBeDefined();
    const i = only(r, SIGNAL);
    expect(i.signal).toBe(true);
    // The same issue: the signal's title, the signal's counts, one marker, the signal's signature.
    expect(i.issue.title).toBe(s!.issue.title);
    expect(i.issue.body.startsWith(s!.issue.body.replace(/\n\n<!-- kanon:bug-signature=[0-9a-f]{24} -->$/, ''))).toBe(true);
    expect(i.issue.body.match(/<!-- kanon:bug-signature=/g)).toHaveLength(1);
    expect(i.issue.body.endsWith(`<!-- kanon:bug-signature=${SIGNAL} -->`)).toBe(true);
    expect(i.issue.body).toContain('| Runs | 2 |');
    // The two findings with the signature are two entries on it, from two adopters.
    expect(i).toMatchObject({ findings: 2, adopters: 2, gate_failed: 0 });
    expect(i.issue.body).toContain('## Upstream findings: 2, from 2 adopter(s)');
    expect(i.issue.body).toContain('### Finding 1: overseer');
    expect(i.issue.body).toContain('### Finding 2: explore-telemetry');
    expect(i.labels).toEqual([LABELS.bug, LABELS.finding]);
  });

  it('a second finding with the same signature adds to the issue, and a third adds again', () => {
    const one = only(plan([failedRun('a1b2c3d4'), failedRun('e5f6a7b8'), finding('a1b2c3d4')] as never, CTX), SIGNAL);
    const two = only(plan([failedRun('a1b2c3d4'), failedRun('e5f6a7b8'), finding('a1b2c3d4'), finding('a1b2c3d4', { recorded_at: '2026-10-08T09:00:00Z' })] as never, CTX), SIGNAL);
    expect([one.findings, two.findings]).toEqual([1, 2]);
    expect(two.adopters).toBe(1);
    expect(two.issue.body).toContain('### Finding 2: overseer, subject `lane`, 2026-10-08');
  });

  it('a finding with no signal is an issue of its own, under the same signature function, labelled kanon-bug and finding', () => {
    const r = plan([finding('a1b2c3d4', { kanon_version: '0.36.0' })] as never, CTX);
    const sig = signature({ lane: 'review', failed_stage: 'agent', reason: 'did_not_finish', kanon_version: '0.36.0' });
    const i = only(r, sig);
    expect(i.signal).toBe(false);
    expect(i.issue.title).toBe('Kanon finding: review lane, `did_not_finish` at stage `agent`, on 0.36.0');
    expect(i.labels).toEqual(['kanon-bug', 'finding']);
  });

  it("a signal's issue keeps the signal's class label beside finding", () => {
    // One adopter, no earlier release: an `adopter` signal.
    const r = plan([failedRun('a1b2c3d4'), finding('a1b2c3d4')] as never, CTX);
    expect(r.signals[0]!.classification).toBe('adopter');
    expect(only(r, SIGNAL).labels).toEqual(['kanon-bug', 'adopter', 'finding']);
  });

  it("leaves detect's signals and rises exactly as kanon-bugs.mjs returns them, so a public body never holds a finding", () => {
    const r = plan(ROWS as never, CTX);
    const bugs = detect(ROWS.filter((x) => x.row_kind !== 'finding') as never, { tag: 'test' });
    expect({ signals: r.signals, rises: r.rises, skipped: r.skipped }).toEqual(bugs);
    for (const s of r.signals) expect(s.issue.body).not.toContain('Upstream findings');
  });

  it('a code-less finding signs by its rules and paths, so two such findings on a release stay apart', () => {
    const a = finding('a1b2c3d4', { subject: 'guard', lane: undefined, failed_stage: undefined, reason: undefined, rules: 'K-MERGE-10', fix_category: 'guard' });
    const b = finding('a1b2c3d4', { subject: 'rule', lane: undefined, failed_stage: undefined, reason: undefined, rules: 'K-OBS-16', fix_category: 'rule-text' });
    for (const row of [a, b]) for (const k of ['lane', 'failed_stage', 'reason']) delete row[k];
    const r = plan([a, b] as never, CTX);
    expect(r.findings.issues).toHaveLength(2);
    expect(r.findings.issues.map((i) => i.issue.title).sort()).toEqual(['Kanon finding: guard, K-MERGE-10, on 0.37.0', 'Kanon finding: rule, K-OBS-16, on 0.37.0']);
  });

  it('reads only finding rows of the asked tag, with a version and a key, and counts the rest', () => {
    const r = plan([finding('a1b2c3d4', { tag: 'run' }), finding('a1b2c3d4', { kanon_version: 'v1' }), finding('', { pk: 'nokey' }), finding('a1b2c3d4')] as never, CTX);
    expect(r.findings.skipped).toEqual({ not_finding: 1, no_version: 1, no_adopter: 1 });
    expect(r.findings.total).toBe(1);
  });
});

describe('the gate: each finding checked again, and filed with gate: failed when a check fails (§6, item 2)', () => {
  it("a finding whose kanon_paths entry isn't in its release's tree is filed with gate: failed, the path withheld", () => {
    const r = plan(ROWS as never, CTX);
    const failed = r.findings.issues.find((i) => i.gate_failed)!;
    expect(failed.labels).toEqual(['kanon-bug', 'finding', 'gate-failed']);
    expect(failed.issue.body).toContain('**gate: failed**: `kanon_paths (not-in-tree)`');
    expect(failed.issue.body).toContain('Kanon paths: `scripts/merge-gate.mjs` (1 withheld');
    expect(failed.issue.body).not.toContain('adopter-own');
    // A failed finding's text is withheld too, whatever failed.
    expect(failed.issue.body).not.toContain('Expected: the merge gate holds');
  });

  it('every path in the tree passes; a release with no tree fails a finding with a path or a text, not one with neither', () => {
    expect(problemsOf(finding('a1b2c3d4', { kanon_paths: 'scripts/merge-gate.mjs,rulebook/08-observability-and-cost.md' }))).toEqual([]);
    expect(problemsOf(finding('a1b2c3d4', { kanon_version: '0.35.0', kanon_paths: 'scripts/merge-gate.mjs' }))).toEqual(['kanon_version (no-tree)']);
    expect(problemsOf(withEvidence('a1b2c3d4', CLEAN, { kanon_version: 'dev' }))).toEqual(['kanon_version (no-tree)']);
    expect(problemsOf(finding('a1b2c3d4', { kanon_version: '0.35.0' }))).toEqual([]);
  });

  it("runs validate at this release: a field the schema doesn't have fails, and its value never reaches the issue", () => {
    const row = finding('a1b2c3d4', { title: 'Acme widgets broke in octo-repo' });
    expect(problemsOf(row)).toEqual(['title (unknown)']);
    const body = only(plan([row] as never, CTX), SIGNAL).issue.body;
    expect(body).toContain('`title (unknown)`');
    expect(body).not.toContain('Acme');
  });

  it("runs verify on the text with the key's name hashes and the release's tree", () => {
    expect(problemsOf(withEvidence('a1b2c3d4', CLEAN))).toEqual([]);
    expect(problemsOf(withEvidence('a1b2c3d4', 'Observed: see https://ci.test'))).toContain('evidence (url)');
    // A path the scrub's pattern would keep, but the release's tree doesn't hold.
    expect(problemsOf(withEvidence('a1b2c3d4', 'Where: scripts/adopter-own.mjs'))).toEqual(['evidence (path)']);
    // A word of the sender's own repository name (example-org/widgets-alpha), which only its hashes know.
    expect(problemsOf(withEvidence('a1b2c3d4', 'Observed: the widgets job stopped.'))).toEqual(['evidence (name)']);
    expect(problemsOf(withEvidence('e5f6a7b8', 'Observed: the widgets job stopped.'))).toEqual([]);
    expect(problemsOf(finding('a1b2c3d4', { evidence_level: 'evidence', suggested_fix: 'Mail ops@example.test.', scrub_version: 1 }))).toContain('suggested_fix (email)');
  });

  it('a text of a key the register has no entry for fails closed: no name context', () => {
    expect(problemsOf(withEvidence('f0f0f0f0', CLEAN))).toEqual(['evidence (no-sender-context)']);
    expect(problemsOf(finding('f0f0f0f0'))).toEqual([]);
  });

  it("an adopter key, as a value or as a word in the text, fails the gate, and the key never reaches the issue body", () => {
    // `kfixture3` has no key's shape, so only the key check finds it.
    const row = withEvidence('a1b2c3d4', 'Observed: kfixture3 saw the lane stop.');
    expect(problemsOf(row)).toEqual(['evidence (key)']);
    const r = plan([row] as never, CTX);
    const body = only(r, SIGNAL).issue.body;
    expect(body).toContain('`evidence (key)`');
    for (const k of KEYS) expect(JSON.stringify(r)).not.toContain(k);
  });

  it('a passing finding shows its text, fenced past any backticks it holds', () => {
    const text = 'Observed: the prompt says ```` and stops.';
    const body = only(plan([withEvidence('a1b2c3d4', text)] as never, CTX), SIGNAL).issue.body;
    expect(body).toContain(`\`\`\`\`\`text\n${text}\n\`\`\`\`\``);
  });
});

describe('nothing identifying leaves into the output', () => {
  it('holds no key, repository, run id, run attempt or time finer than the day', () => {
    const r = plan(ROWS as never, CTX);
    const all = JSON.stringify(r);
    for (const k of KEYS) expect(all).not.toContain(k);
    for (const x of ['example-org', 'widgets', '33679229731', '33679229999', 'T09:00:00Z#']) expect(all).not.toContain(x);
    for (const i of r.findings.issues) expect(i.issue.body).not.toMatch(/T\d{2}:\d{2}/);
  });

  it('refuses the output whole when an adopter key is one of the words it would print', () => {
    // A key that is also one of Kanon's words (here a subject) would sit in the title.
    const row = finding('guard', { subject: 'guard', lane: undefined, failed_stage: undefined, reason: undefined, fix_category: 'guard' });
    for (const k of ['lane', 'failed_stage', 'reason']) delete row[k];
    expect(() => plan([row] as never, CTX)).toThrow(/adopter key/);
  });

  it('assertNoKeyIn finds a key as a whole value and as a word, not inside a longer run', () => {
    const keys = new Set(['kfixture3']);
    expect(() => assertNoKeyIn({ a: ['kfixture3'] }, keys)).toThrow();
    expect(() => assertNoKeyIn({ a: { b: 'saw kfixture3 stop' } }, keys)).toThrow();
    expect(() => assertNoKeyIn({ a: 'xkfixture3 kfixture3x kfixture3-a' }, keys)).not.toThrow();
    expect(holdsKey('KFIXTURE3.', 'kfixture3')).toBe(true);
  });

  it('keeps an issue body inside GitHub’s limit: past the budget, a finding is listed without its text', () => {
    const long = `${'Observed: the review lane stopped at stage agent.\n'.repeat(38)}`.trim();
    expect(long.length).toBeLessThan(2000);
    const rows = Array.from({ length: 60 }, (_, i) => withEvidence('a1b2c3d4', long, { recorded_at: `2026-10-07T09:${String(i).padStart(2, '0')}:00Z`, suggested_fix: 'Cap it.' }));
    const i = only(plan(rows as never, CTX), SIGNAL);
    expect(i.findings).toBe(60);
    expect(i.issue.body.length).toBeLessThanOrEqual(BODY_BUDGET + 2000);
    expect(i.issue.body.length).toBeLessThan(65_536);
    expect(i.issue.body).toMatch(/\n\d+ finding\(s\) shown without their text: the issue body is full\./);
    expect(i.issue.body).toMatch(/\n\d+ more finding\(s\) with this signature not listed: the issue body is full\./);
    expect(i.issue.body).toContain('### Finding 1:');
  });
});

describe('the register gives the keys and the name hashes intake has', () => {
  it('hashes each repository as render.mjs does for NAME_HASHES', () => {
    const { keys, names } = registerContext(REGISTER);
    expect(keys).toEqual(KEYS);
    expect(Object.entries(names).map(([k, h]) => `${k}=${h.join(':')}`).join(',')).toBe(nameHashesVariable(REGISTER.repositories));
    expect(JSON.stringify(names)).not.toContain('widgets');
  });

  it('refuses a register without repositories, or an entry without a key or repository', () => {
    for (const bad of [{}, null, { repositories: [{ key: 'k1' }] }, { repositories: [{ repository: 'o/r' }] }]) {
      expect(() => registerContext(bad)).toThrow();
    }
  });
});

describe('the CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-findings-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const args = ['--rows', join(DIR, 'rows.jsonl'), '--tag', 'test', '--trees', join(DIR, 'trees.json'), '--register', join(DIR, 'register.json')];

  it('prints the plan as JSON, and a summary of counts without --json', () => {
    const json = main([...args, '--json']);
    expect(json.code).toBe(0);
    const r = JSON.parse(json.out);
    expect(r.findings.issues).toHaveLength(2);
    expect(r.findings).toMatchObject({ total: 3, gate_failed: 1, skipped: { not_finding: 1, no_version: 0, no_adopter: 0 } });
    const text = main(args);
    expect(text.code).toBe(0);
    expect(text.out).toContain('3 finding(s) on 2 private issue(s), 1 of them a signal\'s; 1 failed the gate. Finding rows skipped: 1 not finding.');
    expect(text.out).not.toContain('Expected');
  });

  it('without a tree or a register, every finding with a path or a text fails the gate', () => {
    const r = JSON.parse(main(['--rows', join(DIR, 'rows.jsonl'), '--tag', 'test', '--json']).out);
    expect(r.findings.gate_failed).toBe(2);
  });

  it('refuses bad arguments and unreadable input, naming no content', () => {
    expect(main([]).code).toBe(2);
    expect(main(['--rows']).code).toBe(2);
    expect(main([...args, '--tag', 'other']).code).toBe(2);
    expect(main(['--rows', join(dir, 'missing.jsonl')]).out).toBe('could not read the input (Error)');
    const trees = join(dir, 'trees.json');
    writeFileSync(trees, '{"0.37.0": "scripts/x.mjs"}');
    expect(main([...args, '--trees', trees]).out).toBe('--trees is not a JSON object of path lists');
    const register = join(dir, 'register.json');
    writeFileSync(register, '{"repositories":[{"key":"secretkey1"}]}');
    const bad = main([...args, '--register', register]);
    expect([bad.code, bad.out.includes('secretkey1')]).toEqual([2, false]);
    const known = join(dir, 'known.json');
    writeFileSync(known, '{}');
    expect(main([...args, '--known', known]).out).toBe('--known is not a JSON array of signatures');
  });

  it('refuses to print anything when the output would hold a key', () => {
    const rows = join(dir, 'rows.jsonl');
    writeFileSync(rows, JSON.stringify({ ...finding('guard', { subject: 'guard', fix_category: 'guard' }), lane: undefined }));
    const r = main(['--rows', rows, '--tag', 'test']);
    expect(r).toEqual({ code: 2, out: 'refused: the output would hold an adopter key, so nothing is printed' });
  });
});
