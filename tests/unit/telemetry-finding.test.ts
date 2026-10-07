import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  EVIDENCE_LEVELS,
  FINDING_SUBJECTS,
  FIX_CATEGORIES,
  LANES,
  REPORTERS,
  RULE_IDS,
  SCHEMAS,
  STORE_FIELDS,
  describeErrors,
  validate,
} from '../../actions/agent-telemetry/schema.mjs';
import { SUBJECTS } from '../../scripts/overseer-file.mjs';

/**
 * Plan 0006 step F1: the finding row, version 1 (§2.1), its text fields (§2.2), and each mutation
 * F1's row of the order of moves lists for `validate`. The scrub's own cases are in
 * telemetry-scrub.test.ts; the reserved partition is in telemetry-schema.test.ts.
 */

type Row = Record<string, unknown>;
const FINDING = SCHEMAS.finding![1]!;
const RUN = SCHEMAS.run![2]!;
const FIXTURES = JSON.parse(readFileSync('tests/fixtures/telemetry/findings.json', 'utf8')) as Row[];
/** A valid level-1 finding to mutate: the fixture guard finding. */
const codes = (): Row => ({ ...FIXTURES[0]! });
/** A valid level-2 finding to mutate: the fixture lane finding with evidence. */
const withEvidence = (): Row => ({ ...FIXTURES[1]! });

const fails = (row: Row, field: string, problem?: string) => {
  const v = validate(row);
  expect(v.ok, field).toBe(false);
  if (!v.ok) {
    expect(v.errors.map((e) => e.field)).toContain(field);
    if (problem) expect(v.errors).toContainEqual({ field, problem });
  }
};

describe('every fixture finding validates (F1)', () => {
  it('holds a finding of each reporter, subject, tag and level', () => {
    expect(new Set(FIXTURES.map((f) => f.reporter))).toEqual(new Set(REPORTERS));
    expect(new Set(FIXTURES.map((f) => f.subject))).toEqual(new Set(FINDING_SUBJECTS));
    expect(new Set(FIXTURES.map((f) => f.evidence_level))).toEqual(new Set(EVIDENCE_LEVELS));
    expect(new Set(FIXTURES.map((f) => f.tag))).toEqual(new Set(['run', 'test', 'smoke']));
  });

  it.each(FIXTURES.map((f, i) => [i, f] as const))('fixture %i validates', (_, f) => {
    expect(validate(f)).toEqual({ ok: true });
  });

  it('names only Kanon files that exist in its kanon_paths', () => {
    for (const f of FIXTURES) {
      for (const p of String(f.kanon_paths ?? '').split(',').filter(Boolean)) expect(() => readFileSync(p), p).not.toThrow();
    }
  });
});

describe('the field list (§2.1)', () => {
  it('has twenty-one fields, and exactly the plan\'s required ones', () => {
    expect(Object.keys(FINDING)).toHaveLength(21);
    const required = Object.entries(FINDING).filter(([, f]) => f.required).map(([k]) => k).sort();
    expect(required).toEqual([
      'evidence_level', 'finding_index', 'fix_category', 'kanon_version', 'recorded_at', 'reporter', 'row_kind',
      'run_attempt', 'run_id', 'schema_version', 'subject', 'tag',
    ]);
  });

  it('has no title, no body and none of the fields the store sets', () => {
    for (const f of ['title', 'body', ...STORE_FIELDS]) expect(Object.keys(FINDING)).not.toContain(f);
  });

  it('takes the signature\'s lists and pattern from the run row, imported, not copied', () => {
    for (const k of ['lane', 'failed_stage', 'kanon_error', 'reason'] as const) {
      expect((FINDING[k] as { values: unknown }).values, k).toBe((RUN[k] as { values: unknown }).values);
    }
    expect((FINDING.kanon_version as { re: unknown }).re).toBe((RUN.kanon_version as { re: unknown }).re);
  });

  it('reporters are lanes, and the subjects are exactly the Overseer\'s Kanon subjects', () => {
    for (const r of REPORTERS) expect(LANES).toContain(r);
    const kanon = Object.entries(SUBJECTS).filter(([, who]) => who === 'kanon').map(([s]) => s).sort();
    expect([...FINDING_SUBJECTS].sort()).toEqual(kanon);
  });

  it('holds the plan\'s fix categories (decision 9)', () => {
    expect(FIX_CATEGORIES).toEqual(['lane-behaviour', 'guard', 'rule-text', 'documentation', 'codes-or-schema', 'default-value', 'permissions', 'other']);
  });

  it('holds RULE_IDS to the rulebook\'s headings, both ways', () => {
    const headings = readdirSync('rulebook').filter((f) => f.endsWith('.md')).flatMap((f) =>
      [...readFileSync(join('rulebook', f), 'utf8').matchAll(/^#+ `(K-[A-Z]+-\d+)`/gm)].map((m) => m[1]!));
    expect(headings.length).toBeGreaterThan(200);
    expect([...RULE_IDS].sort()).toEqual([...new Set(headings)].sort());
    expect(new Set(RULE_IDS).size).toBe(RULE_IDS.length);
  });
});

describe('the mutations F1 lists each fail validate', () => {
  it('a finding with a title field, or a body', () => {
    fails({ ...codes(), title: 'The merge gate escalates twice' }, 'title', 'unknown');
    fails({ ...codes(), body: 'It escalated twice.' }, 'body', 'unknown');
  });
  it('a free-text fix_category', () => fails({ ...codes(), fix_category: 'make the gate escalate once' }, 'fix_category', 'enum'));
  it('evidence at evidence_level: codes', () => {
    fails({ ...withEvidence(), evidence_level: 'codes' }, 'evidence', 'level-mismatch');
    fails({ ...withEvidence(), evidence_level: 'codes' }, 'suggested_fix', 'level-mismatch');
  });
  it('evidence of 2,001 characters, and a suggested fix of 1,001; the limits themselves pass', () => {
    const line = 'Observed: the lane stopped at stage agent.\n';
    const of = (n: number) => line.repeat(Math.ceil(n / line.length)).slice(0, n);
    expect(validate({ ...withEvidence(), evidence: of(2000), suggested_fix: of(1000) })).toEqual({ ok: true });
    fails({ ...withEvidence(), evidence: of(2001) }, 'evidence', 'range');
    fails({ ...withEvidence(), suggested_fix: of(1001) }, 'suggested_fix', 'range');
    // Characters, not UTF-16 units: 2,000 of a character outside the basic plane still fit.
    expect(validate({ ...withEvidence(), evidence: '\u{1F600}'.repeat(2000) })).toEqual({ ok: true });
  });
  it('a rules id the rulebook doesn\'t have, one not shaped like an id, and eleven', () => {
    fails({ ...codes(), rules: 'K-MERGE-10,K-OBS-99' }, 'rules', 'enum');
    fails({ ...codes(), rules: 'K-merge-10' }, 'rules', 'pattern');
    fails({ ...codes(), rules: RULE_IDS.slice(0, 11).join(',') }, 'rules', 'range');
    expect(validate({ ...codes(), rules: RULE_IDS.slice(0, 10).join(',') })).toEqual({ ok: true });
  });
  it('a kanon_paths entry outside Kanon\'s top-level directories, or climbing out of one', () => {
    for (const p of ['src/payments/charge.ts', 'acme/widgets', '/etc/passwd', '.github/actions/project-setup/action.yml',
      'scripts/../src/charge.ts', 'docs/./x.md', 'scripts/x y.mjs']) {
      fails({ ...codes(), kanon_paths: p }, 'kanon_paths', 'pattern');
    }
    fails({ ...codes(), kanon_paths: Array.from({ length: 11 }, (_, i) => `scripts/f${i}.mjs`).join(',') }, 'kanon_paths', 'range');
  });
});

describe('the other checks of a finding row (§2.1, §2.2)', () => {
  it('scrub_version is required with either text, and only its known versions', () => {
    const row = withEvidence();
    delete row.scrub_version;
    fails(row, 'scrub_version', 'required');
    fails({ ...withEvidence(), scrub_version: 2 }, 'scrub_version', 'range');
    fails({ ...withEvidence(), scrub_version: 0 }, 'scrub_version', 'range');
  });
  it('a telemetry-Explorer finding is about a lane, which it names', () => {
    const row = { ...FIXTURES[2]! };
    fails({ ...row, subject: 'guard' }, 'subject', 'reporter-mismatch');
    const noLane = { ...row };
    delete noLane.lane;
    fails(noLane, 'lane', 'required');
  });
  it('checks its reason against the list alone, with no outcome to pair it with', () => {
    expect(validate({ ...codes(), reason: 'turn_cap' })).toEqual({ ok: true });
    fails({ ...codes(), reason: 'the agent ran out of turns' }, 'reason', 'enum');
    fails({ ...codes(), outcome: 'failed' }, 'outcome', 'unknown');
  });
  it('a finding_index past 19, a reporter outside the two, a lane outside the list', () => {
    fails({ ...codes(), finding_index: 20 }, 'finding_index', 'range');
    fails({ ...codes(), reporter: 'review' }, 'reporter', 'enum');
    fails({ ...codes(), lane: 'work' }, 'lane', 'enum');
    fails({ ...codes(), lane: 'finding' }, 'lane', 'enum');
  });
  it('a text with a control character other than the newline, an HTML comment, or nothing in it', () => {
    fails({ ...withEvidence(), evidence: 'Observed:\tthe lane stopped.' }, 'evidence', 'control');
    fails({ ...withEvidence(), evidence: 'Observed: the lane stopped.\r\n' }, 'evidence', 'control');
    fails({ ...withEvidence(), evidence: 'Observed: <!-- kanon:bug-signature=abc -->' }, 'evidence', 'marker');
    fails({ ...withEvidence(), evidence: '' }, 'evidence', 'range');
    fails({ ...withEvidence(), evidence: 42 }, 'evidence', 'type');
  });
  it('runs the scrub\'s verifier on each text, naming the rules that fire, never the text (§2.2)', () => {
    const secret = 'see https://example.com/acme/widgets/pull/3 from someone@example.org';
    const v = validate({ ...withEvidence(), evidence: secret, suggested_fix: 'ping @octocat' });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.errors).toEqual(expect.arrayContaining([
        { field: 'evidence', problem: 'url' }, { field: 'evidence', problem: 'email' }, { field: 'suggested_fix', problem: 'mention' },
      ]));
      expect(describeErrors(v.errors)).toContain('evidence (url)');
      expect(JSON.stringify(v.errors)).not.toContain('example');
      expect(JSON.stringify(v.errors)).not.toContain('octocat');
    }
  });
  it('a text field on a run row is still an unknown field', () => {
    const run = { schema_version: 2, row_kind: 'run', tag: 'run', recorded_at: '2026-10-07T09:00:00Z', run_id: 1, run_attempt: 1,
      role: 'reviewer', lane: 'review', outcome: 'ok', reason: 'none', kanon_version: '0.37.0' };
    expect(validate(run)).toEqual({ ok: true });
    fails({ ...run, evidence: 'Observed: fine.' }, 'evidence', 'unknown');
  });
});
