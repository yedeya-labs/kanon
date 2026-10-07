import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

/**
 * Plan 0006 §4.2: the scrub's `name` rule also checks `public-words.mjs`'s own list, the reference
 * adopter's words, whatever the context holds. Those words are never written down, only hashed, so
 * this file stands an invented word in for them: it replaces the list `namesForbiddenWord` falls
 * back to, and nothing else. Its own file, because the stand-in holds for every case in it.
 */

const STAND_IN = 'zorblaxquint';
const hashOf = (w: string) => createHash('sha256').update(w).digest('hex');

vi.mock('../../actions/agent-telemetry/public-words.mjs', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../actions/agent-telemetry/public-words.mjs')>();
  const stand = new Set([hashOf(STAND_IN)]);
  return { ...original, FORBIDDEN_WORD_HASHES: stand, namesForbiddenWord: (text: string, hashes: Set<string> = stand) => original.namesForbiddenWord(text, hashes) };
});

const { redact, verify } = await import('../../actions/agent-telemetry/scrub.mjs');
const { validate } = await import('../../actions/agent-telemetry/schema.mjs');

describe("the name rule checks public-words.mjs's own list, with no context at all", () => {
  it('verify names it, redact removes it, and validate refuses a text holding it', () => {
    const text = `Observed: the ${STAND_IN} hook failed.`;
    expect(verify(text)).toEqual(['name']);
    expect(redact(text)).toEqual({ text: 'Observed: the [name] hook failed.', fired: ['name'] });
    const row = {
      schema_version: 1, row_kind: 'finding', tag: 'test', recorded_at: '2026-10-07T09:00:00Z', run_id: 1, run_attempt: 1,
      finding_index: 0, reporter: 'overseer', subject: 'lane', lane: 'review', kanon_version: '0.37.0', fix_category: 'other',
      evidence_level: 'evidence', evidence: text, scrub_version: 1,
    };
    expect(validate(row)).toEqual({ ok: false, errors: [{ field: 'evidence', problem: 'name' }] });
  });
});
