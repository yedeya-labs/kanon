import { describe, expect, it } from 'vitest';
import { sha256 } from '../../actions/agent-telemetry/public-words.mjs';
import { redact } from '../../actions/agent-telemetry/scrub.mjs';
import { KANON_WORDS, appNameWords, upstreamNames, upstreamNamesCli } from '../../scripts/upstream-names.mjs';

/**
 * Plan 0006 §4.2 (F3): the App register's names, which the scrub's `name` rule removes from an
 * upstream finding's evidence, read in the lane's gate job from the default branch and handed
 * on as hashes. The `name` rule removes every word of every name it is given, wherever it
 * appears, so an App slug's Kanon words (a role's, a lane's, Kanon's own) are left out: the
 * evidence keeps "the reviewer" while the App's own slug is still removed (kanon#588, from F1).
 */

const REGISTER = [
  '# App register', '',
  '| Role | App slug | Persona |', '|---|---|---|',
  '| Implementer | `acme-kanon-author` | |',
  '| Reviewer | `acme-reviewer` | |',
  '| Merger | `acme-reviewer` | |',
  '| Overseer | `acme-kanon-author` | |', '',
].join('\n');

/** A `gh` that answers the default branch and the register, or fails each as told. */
const fakeRun = (register: string | null | 'throws' = REGISTER) => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[1] === 'repos/acme/widget-shop') return 'main\n';
    if (String(args[1]).startsWith('repos/acme/widget-shop/contents/docs/qa/agent-identities.md')) {
      if (register === 'throws') throw Object.assign(new Error('boom'), { stderr: 'HTTP 500' });
      if (register === null) throw Object.assign(new Error('nope'), { stderr: 'HTTP 404: Not Found' });
      return register;
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { run, calls };
};

describe('appNameWords: an App slug\'s words, without Kanon\'s own', () => {
  it('keeps the adopter\'s words and leaves out every role, App, lane and Kanon word', () => {
    expect(appNameWords(['acme-kanon-author', 'acme-reviewer', 'widgets-explore-telemetry-bot'])).toEqual(['acme', 'widgets', 'bot']);
  });

  it('Kanon\'s words are its roles, its Apps, its lanes\' words and its own name', () => {
    for (const w of ['kanon', 'reviewer', 'implementer', 'overseer', 'explorer', 'merger', 'lead', 'releaser', 'intake', 'author', 'judge', 'review', 'implement', 'explore', 'telemetry', 'triage', 'digest']) {
      expect(KANON_WORDS.has(w), w).toBe(true);
    }
    expect(KANON_WORDS.has('acme')).toBe(false);
  });
});

describe('upstreamNames: the register, read from the default branch, as hashes', () => {
  it('hashes each adopter word of each App slug, and nothing of Kanon\'s', () => {
    const { hashes, notes } = upstreamNames({ repo: 'acme/widget-shop', run: fakeRun().run });
    expect(hashes).toEqual([sha256('acme')]);
    expect(notes).toEqual([]);
  });

  // kanon#588, from F1: the `name` rule removes every word of every name in its context.
  it('THE F1 NOTE: evidence keeps "the reviewer" while the App\'s own slug is still removed', () => {
    const { hashes } = upstreamNames({ repo: 'acme/widget-shop', run: fakeRun().run });
    const out = redact('The reviewer approved; acme-reviewer posted it, and the review lane ran.', { nameHashes: hashes! });
    expect(out.text).toBe('The reviewer approved; [name] posted it, and the review lane ran.');
  });

  it('MUTATION: hashing the slugs whole, Kanon\'s words included, removes "the reviewer" too', () => {
    // What the name rule would do with the register's words unfiltered: every one is removed.
    const unfiltered = new Set(['acme', 'kanon', 'author', 'reviewer'].map(sha256));
    expect(redact('The reviewer approved.', { nameHashes: unfiltered }).text).toBe('The [name] approved.');
  });

  it('reads nothing as names when the register is missing, malformed or unreadable, and says so: the lane then withholds text', () => {
    for (const reg of [null, 'throws', '# no table here\n'] as const) {
      const { hashes, notes } = upstreamNames({ repo: 'acme/widget-shop', run: fakeRun(reg).run });
      expect(hashes, String(reg)).toBeNull();
      expect(notes.join(' ')).toMatch(/App register/);
    }
  });
});

describe('upstreamNamesCli: what the gate job writes to its output', () => {
  it('prints the hashes, comma-separated', () => {
    expect(upstreamNamesCli({ repo: 'acme/widget-shop', run: fakeRun().run })).toEqual({ code: 0, out: sha256('acme'), notes: [] });
  });

  it('prints `none` for a register whose slugs hold only Kanon\'s words', () => {
    const reg = REGISTER.replaceAll('acme-', '');
    expect(upstreamNamesCli({ repo: 'acme/widget-shop', run: fakeRun(reg).run }).out).toBe('none');
  });

  it('prints nothing, and stays green, when the register can\'t be read: the audit still runs', () => {
    const r = upstreamNamesCli({ repo: 'acme/widget-shop', run: fakeRun('throws').run });
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(r.notes.join(' ')).toMatch(/::warning/);
  });

  it('exits 2 without the repository', () => {
    expect(upstreamNamesCli({ repo: '' }).code).toBe(2);
  });
});
