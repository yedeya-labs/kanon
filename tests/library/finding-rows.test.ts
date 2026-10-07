import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers/adopter.js';
import { RULE_IDS, validate } from '../../actions/agent-telemetry/schema.mjs';
import { nameContext, verify } from '../../actions/agent-telemetry/scrub.mjs';
import {
  FINDING_FILE,
  artifactName,
  buildRows,
  cutText,
  kanonFileIn,
  levelOf,
  readUpstream,
  sendFromEnv,
  sentSentence,
} from '../../scripts/lib/finding-rows.mjs';

/**
 * Plan 0006 §5, steps 1 and 2 (F3): what a lane's filing step writes for Kanon's telemetry store.
 * The agent chooses which codes to send, never a value outside Kanon's vocabulary; its text goes
 * only into `evidence` and `suggested_fix`, and only through the scrub; and a row that would carry
 * text the scrub can't vouch for is sent as codes, never on a guess.
 */

const isKanonFile = kanonFileIn(ROOT);
const send = (extra: Record<string, unknown> = {}) => ({
  run: { id: 4242, attempt: 2 }, tag: 'test', recordedAt: '2026-10-07T12:00:00.000Z', kanonVersion: '0.38.0', actor: 'someone',
  nameHashes: [], isKanonFile, write: () => {}, ...extra,
});
const item = (raw: unknown, subject = 'guard') => ({ subject, ...readUpstream(raw, isKanonFile) });

describe('levelOf: the declared value, as the row\'s level', () => {
  it('sends codes for `sent`, evidence for `sent with evidence`, and nothing otherwise', () => {
    expect(levelOf('sent')).toBe('codes');
    expect(levelOf(' sent with evidence ')).toBe('evidence');
    for (const v of ['drafted', 'filed here', '', undefined, 'sent  with evidence', 'Sent']) expect(levelOf(v)).toBeNull();
  });
});

describe('sentSentence: says what the draft\'s rows are, true for the release it ships in', () => {
  // Until F4's collector lists `kanon-finding-*`, a row is written and uploaded, and nothing
  // leaves the repository; the sentence must not say a row was sent (PR #605's review).
  it('says the collector sends the rows only from F4, and that until then nothing leaves', () => {
    for (const level of ['codes', 'evidence'] as const) {
      const s = sentSentence(level);
      expect(s).toMatch(/once the collector sends finding rows \(plan 0006 F4\)/);
      expect(s).toContain('nothing leaves the repository');
      expect(s).not.toMatch(/telemetry collector sends it, and/);
    }
  });
});

describe('readUpstream: a code is kept only when it is in the schema\'s list', () => {
  it('keeps every code in Kanon\'s vocabulary', () => {
    const r = readUpstream({ lane: 'review', failed_stage: 'agent', kanon_error: 'unhandled', reason: 'did_not_finish', rules: ['K-SELF-11', 'K-OBS-16'], kanon_paths: ['scripts/overseer-file.mjs'], fix_category: 'guard' }, isKanonFile);
    expect(r.codes).toEqual({ lane: 'review', failed_stage: 'agent', kanon_error: 'unhandled', reason: 'did_not_finish', rules: ['K-SELF-11', 'K-OBS-16'], kanon_paths: ['scripts/overseer-file.mjs'], fix_category: 'guard' });
    expect(r.dropped).toEqual([]);
  });

  // F3's mutation: an agent `upstream.lane` outside the lane list is dropped, not sent.
  it('drops a lane outside the lane list, and names the field, never the value', () => {
    const r = readUpstream({ lane: 'acme-deploy', fix_category: 'guard' }, isKanonFile);
    expect(r.codes).not.toHaveProperty('lane');
    expect(r.dropped).toEqual(['lane']);
  });

  it('drops a stage, an error, a reason, a rule id, a fix category or a path outside Kanon\'s', () => {
    const r = readUpstream({
      failed_stage: 'deploy', kanon_error: 'oops', reason: 'Because it broke',
      rules: ['K-SELF-11', 'K-NOPE-1', 'RA-12'],
      kanon_paths: ['scripts/overseer-file.mjs', 'scripts/not-in-kanon.mjs', 'src/app.ts', 'scripts/../etc/passwd'],
      fix_category: 'rewrite everything',
    }, isKanonFile);
    expect(r.codes).toEqual({ rules: ['K-SELF-11'], kanon_paths: ['scripts/overseer-file.mjs'], fix_category: 'other' });
    expect(r.dropped).toEqual(['failed_stage', 'kanon_error', 'reason', 'rules', 'kanon_paths', 'fix_category']);
  });

  it('keeps at most ten rule ids and ten paths, each once', () => {
    const rules = RULE_IDS.slice(0, 12);
    const r = readUpstream({ rules: [rules[0], ...rules], fix_category: 'rule-text' }, isKanonFile);
    expect(r.codes.rules).toEqual(rules.slice(0, 10));
    expect(r.dropped).toEqual(['rules']);
  });

  it('reads no upstream at all as codes only, `other`, with nothing dropped', () => {
    for (const raw of [undefined, null, 'text', ['a']]) {
      expect(readUpstream(raw, isKanonFile)).toEqual({ codes: { fix_category: 'other' }, dropped: [], evidence: '', suggested_fix: '' });
    }
  });

  it('reads the two texts, and nothing else, as text', () => {
    const r = readUpstream({ evidence: '  **Expected:** K-SELF-11\r\n\tholds.  ', suggested_fix: 42 }, isKanonFile);
    expect(r.evidence).toBe('**Expected:** K-SELF-11\n  holds.');
    expect(r.suggested_fix).toBe('');
  });
});

describe('kanonFileIn: a path is Kanon\'s when it is a file in the tree the lane runs from', () => {
  it('keeps a file of the tree, and refuses a directory, a missing file and a path that climbs out', () => {
    expect(isKanonFile('scripts/overseer-file.mjs')).toBe(true);
    expect(isKanonFile('.github/workflows/agent-overseer.yml')).toBe(true);
    expect(isKanonFile('scripts')).toBe(false);
    expect(isKanonFile('scripts/lib')).toBe(false);
    expect(isKanonFile('scripts/not-in-kanon.mjs')).toBe(false);
    expect(isKanonFile('scripts/../package.json')).toBe(false);
    expect(isKanonFile('package.json')).toBe(false);
  });
});

describe('cutText: longer text is cut at the last whole line before the limit, and ends `[cut]` (§2.2)', () => {
  it('leaves text within the limit alone', () => {
    expect(cutText('a\nb', 3)).toBe('a\nb');
  });

  it('cuts at a whole line, so the result fits, marked', () => {
    const text = ['one line', 'two line', 'three line'].join('\n');
    const out = cutText(text, 24);
    expect(out).toBe('one line\ntwo line\n[cut]');
    expect([...out].length).toBeLessThanOrEqual(24);
  });

  it('cuts inside a first line that alone is too long, and still fits', () => {
    const out = cutText('x'.repeat(50), 20);
    expect(out.endsWith('\n[cut]')).toBe(true);
    expect([...out].length).toBe(20);
  });

  it('counts code points, as the schema does', () => {
    const out = cutText(`${'é'.repeat(15)}\n${'é'.repeat(15)}`, 25);
    expect(out).toBe(`${'é'.repeat(15)}\n[cut]`);
  });
});

describe('buildRows', () => {
  it('builds one valid row per item at `codes`, with no text, whatever the agent wrote', () => {
    const { rows, outcomes } = buildRows({
      reporter: 'overseer', level: 'codes', send: send(),
      items: [item({ lane: 'review', fix_category: 'guard', evidence: 'secret prose', suggested_fix: 'more prose' }), item({}, 'rule')],
    });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(validate(r)).toEqual({ ok: true });
      expect(r).not.toHaveProperty('evidence');
      expect(r).not.toHaveProperty('suggested_fix');
      expect(r).not.toHaveProperty('scrub_version');
    }
    expect(rows.map((r) => [r.finding_index, r.subject, r.evidence_level, r.run_id, r.run_attempt, r.kanon_version])).toEqual([
      [0, 'guard', 'codes', 4242, 2, '0.38.0'], [1, 'rule', 'codes', 4242, 2, '0.38.0'],
    ]);
    expect(outcomes.map((o) => o.level)).toEqual(['codes', 'codes']);
  });

  it('at `evidence`, sends the text after the scrub, and validates it', () => {
    const context = { nameHashes: nameContext({ repository: 'acme-corp/widget-shop' }), kanonFiles: isKanonFile };
    const { rows, outcomes } = buildRows({
      reporter: 'overseer', level: 'evidence', send: send(), context,
      items: [item({ fix_category: 'guard', evidence: '**Observed:** the widget-shop review, see https://example.test/x and scripts/overseer-file.mjs', suggested_fix: 'Ask @someone.' })],
    });
    expect(rows[0]!.evidence).toBe('**Observed:** the [name] review, see [url] and scripts/overseer-file.mjs');
    expect(rows[0]!.suggested_fix).toBe('Ask [login].');
    expect(rows[0]!.scrub_version).toBe(1);
    expect(rows[0]!.evidence_level).toBe('evidence');
    expect(validate(rows[0])).toEqual({ ok: true });
    expect(outcomes[0]!.fired).toEqual(['url', 'mention', 'name']);
    expect(verify(rows[0]!.evidence as string, context)).toEqual([]);
  });

  it('at `evidence`, an item with no text is sent as codes, and says nothing was withheld', () => {
    const { rows, outcomes } = buildRows({ reporter: 'overseer', level: 'evidence', send: send(), context: {}, items: [item({ fix_category: 'guard' })] });
    expect(rows[0]!.evidence_level).toBe('codes');
    expect(outcomes[0]!.withheld).toBeUndefined();
  });

  it('FAILS CLOSED: without the scrub\'s context, the text is withheld and the row is sent as codes, saying why', () => {
    const { rows, outcomes } = buildRows({
      reporter: 'overseer', level: 'evidence', send: send(), contextProblem: 'the App register\'s names were not read',
      items: [item({ fix_category: 'guard', evidence: 'plain text' })],
    });
    expect(rows[0]!.evidence_level).toBe('codes');
    expect(rows[0]).not.toHaveProperty('evidence');
    expect(outcomes[0]!.withheld).toBe('the App register\'s names were not read');
  });

  it('FAILS CLOSED: a lane\'s own check refusing the scrubbed text withholds it, by the check\'s reason', () => {
    const { rows, outcomes } = buildRows({
      reporter: 'overseer', level: 'evidence', send: send(), context: {}, check: (t: string) => (/\d/.test(t) ? 'it quotes a figure' : null),
      items: [item({ fix_category: 'guard', evidence: 'it failed 12 times' })],
    });
    expect(rows[0]!.evidence_level).toBe('codes');
    expect(outcomes[0]!.withheld).toBe('it quotes a figure');
  });

  it('FAILS CLOSED: a text the schema refuses after the scrub is withheld, and the row is still sent at codes', () => {
    // `readUpstream` removes control characters; an item built elsewhere may not, and the scrub
    // passes one. Without the check of the row with its text, the whole row would fail and none
    // would be sent.
    const { rows, outcomes } = buildRows({ reporter: 'overseer', level: 'evidence', send: send(), context: {}, items: [{ ...item({ fix_category: 'guard' }), evidence: 'a\u0007b' }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.evidence_level).toBe('codes');
    expect(outcomes[0]!.withheld).toBe('the row with its text failed the schema: evidence (control)');
  });

  it('FAILS CLOSED: text the scrub still fires on after the cut is withheld, naming the rule', () => {
    // A Kanon path cut in half is no longer a Kanon file, so the `path` rule fires on what is left.
    const long = `${'word '.repeat(397)}scripts/overseer-file.mjs`;
    const { rows, outcomes } = buildRows({ reporter: 'overseer', level: 'evidence', send: send(), context: { kanonFiles: isKanonFile }, items: [item({ fix_category: 'guard', evidence: long })] });
    expect(rows[0]!.evidence_level).toBe('codes');
    expect(outcomes[0]!.withheld).toMatch(/`path`/);
  });

  it(`sends at most ${20} a run and holds back the rest`, () => {
    const items = Array.from({ length: 23 }, () => item({ fix_category: 'guard' }));
    const { rows, outcomes } = buildRows({ reporter: 'overseer', level: 'codes', send: send(), items });
    expect(rows).toHaveLength(20);
    expect(rows.at(-1)!.finding_index).toBe(19);
    expect(outcomes.filter((o) => o.held)).toHaveLength(3);
  });

  it('a row the schema refuses is not sent, and its outcome names the fields', () => {
    const { rows, outcomes } = buildRows({ reporter: 'explore-telemetry', level: 'codes', send: send(), items: [item({ fix_category: 'guard' }, 'lane')] });
    expect(rows).toEqual([]);
    expect(outcomes[0]!.error).toBe('lane (required)');
  });
});

describe('sendFromEnv: the lane\'s run, from the filing job\'s environment', () => {
  it('reads the run, the tag, the release and the App register\'s names, and writes the rows where the upload looks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'finding-rows-'));
    const out = join(dir, 'out');
    const s = sendFromEnv({
      GITHUB_RUN_ID: '777', GITHUB_RUN_ATTEMPT: '3', GITHUB_ACTOR: 'someone', TAG: 'smoke', KANON: ROOT,
      KANON_WORKFLOW_REF: 'yedeya-labs/kanon/.github/workflows/agent-overseer.yml@refs/tags/v0.38.0', KANON_WORKFLOW_SHA: 'a'.repeat(40),
      APP_NAME_HASHES: `${'b'.repeat(64)},${'c'.repeat(64)}`, FINDINGS_PATH: join(dir, 'finding', FINDING_FILE), GITHUB_OUTPUT: out,
    }, () => '2026-10-07T12:00:00.000Z');
    expect(s.run).toEqual({ id: 777, attempt: 3 });
    expect(s.tag).toBe('smoke');
    expect(s.kanonVersion).toBe('0.38.0');
    expect(s.nameHashes).toEqual(['b'.repeat(64), 'c'.repeat(64)]);
    expect(s.isKanonFile('scripts/overseer-file.mjs')).toBe(true);
    s.write([{ a: 1 }]);
    expect(JSON.parse(readFileSync(join(dir, 'finding', FINDING_FILE), 'utf8'))).toEqual([{ a: 1 }]);
    expect(readFileSync(out, 'utf8')).toBe('finding-rows=1\n');
  });

  it('reads `none` as a register with no names to remove, and nothing as names not read', () => {
    expect(sendFromEnv({ APP_NAME_HASHES: 'none' }).nameHashes).toEqual([]);
    expect(sendFromEnv({}).nameHashes).toBeNull();
    expect(sendFromEnv({ APP_NAME_HASHES: 'not-a-hash' }).nameHashes).toBeNull();
    expect(sendFromEnv({ TAG: 'nonsense' }).tag).toBe('run');
    expect(sendFromEnv({ KANON_WORKFLOW_REF: 'x/y/.github/workflows/a.yml@refs/heads/main', KANON_WORKFLOW_SHA: 'a'.repeat(40) }).kanonVersion).toBe('dev');
  });

  it('names the artifact by reporter, run and attempt', () => {
    expect(artifactName('overseer', 1, 2)).toBe('kanon-finding-overseer-1-2');
  });
});
