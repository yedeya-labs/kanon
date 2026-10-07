import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { KANON_PATH, RULE_NAMES, SCRUB_VERSION, nameContext, redact, verify } from '../../actions/agent-telemetry/scrub.mjs';
import { sha256 } from '../../actions/agent-telemetry/public-words.mjs';

/**
 * Plan 0006 step F1: the scrub (§4.2), its two halves and its eight rules. Every name below is
 * invented; the reference adopter's are only ever hashes (`public-words.mjs`).
 */

const SOURCE = readFileSync('actions/agent-telemetry/scrub.mjs', 'utf8');

/** A lane's context: the names it can see, hashed, and the Kanon tree it runs from. */
const KANON_FILES = ['scripts/overseer-file.mjs', 'scripts/merge-gate.mjs', 'rulebook/08-observability-and-cost.md'];
const SOURCES = {
  repository: 'acme-corp/widget-shop',
  apps: ['widgetbot-checkwright[bot]'],
  actor: 'harbor-captain',
  collaborators: ['quietcollab'],
  participants: ['prreviewer42', 'issueopener9', 'assigneeone', 'drivebycommenter'],
  commitAuthors: ['commitwright', 'Ottilie Brennholz'],
};
const CTX = { nameHashes: nameContext(SOURCES), kanonFiles: KANON_FILES };

/**
 * One fixture per rule, each holding what that rule alone must find. Dropping a rule from the
 * scrub lets its fixture through `verify` without that rule's name, and its case fails.
 */
const FIXTURES: Record<string, string[]> = {
  marker: ['Observed: <!-- kanon:bug-signature=abc --> was in the body.', 'nested <!<!---->-- marker'],
  url: ['See https://example.com/acme/pull/3 for it.', 'cloned from git@example.com:o/r.git', 'it was on www.example.org today', 'ssh://host:22/repo'],
  email: ['Mailed to someone@example.org yesterday.'],
  mention: ['Asked @octocat about it.', 'the bot @some-app[bot] replied'],
  key: ['The key deadbeef was in a log.', 'partition 0a1b2c3d#review was read'],
  token: [
    'commit 0123456789abcdef0123456789abcdef01234567 broke it',
    'a ghp_abcdefghijklmnopqrstuvwxyz0123456789 token',
    'AKIAABCDEFGHIJKLMNOP was set',
    'blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIz in it',
  ],
  path: ['It broke src/payments/charge.ts again.', 'the adopter repository acme/widgets', 'from ~/notes and C:\\Users\\x', 'its secrets.env file', 'the adopter\'s own scripts/build-site.mjs'],
  name: ['the reviewer prreviewer42 asked for it', 'quietcollab merged it', 'Ottilie wrote the hook'],
};

describe('the rules (§4.2)', () => {
  it('are the plan\'s eight, in its order, at scrub_version 1', () => {
    expect(RULE_NAMES).toEqual(['marker', 'url', 'email', 'mention', 'key', 'token', 'path', 'name']);
    expect(SCRUB_VERSION).toBe(1);
    expect(Object.keys(FIXTURES)).toEqual([...RULE_NAMES]);
  });

  for (const [rule, texts] of Object.entries(FIXTURES)) {
    it.each(texts)(`${rule}: verify names the rule, redact removes it, and verify then passes: %s`, (text) => {
      expect(verify(text, CTX)).toContain(rule);
      const r = redact(text, CTX);
      expect(r.fired).toContain(rule);
      expect(verify(r.text, CTX)).toEqual([]);
    });
  }

  it('replaces each with its placeholder', () => {
    expect(redact('a <!-- b', CTX).text).toBe('a  b');
    expect(redact('see https://example.com/x now', CTX).text).toBe('see [url] now');
    expect(redact('mail someone@example.org now', CTX).text).toBe('mail [email] now');
    expect(redact('ask @octocat now', CTX).text).toBe('ask [login] now');
    expect(redact('key deadbeef now', CTX).text).toBe('key [key] now');
    expect(redact(`sha ${'ab12'.repeat(10)} now`, CTX).text).toBe('sha [token] now');
    expect(redact('file src/x.ts now', CTX).text).toBe('file [path] now');
    expect(redact('by prreviewer42 now', CTX).text).toBe('by [name] now');
  });

  it('the F1 list: a URL, an email, an @login, a key\'s shape, a 40-character hex run, an adopter path and a hashed word each fail verify and are replaced', () => {
    const cases: [string, string, string][] = [
      ['url', 'https://example.com/acme', '[url]'],
      ['email', 'someone@example.org', '[email]'],
      ['mention', '@octocat', '[login]'],
      ['key', 'c0ffee42', '[key]'],
      ['token', 'f'.repeat(20) + '0'.repeat(20), '[token]'],
      ['path', 'app/models/user.rb', '[path]'],
      ['name', 'widget-shop', '[name]'],
    ];
    for (const [rule, secret, placeholder] of cases) {
      const text = `Observed: ${secret} in the run.`;
      expect(verify(text, CTX), rule).toContain(rule);
      const r = redact(text, CTX);
      expect(r.text, rule).toBe(`Observed: ${placeholder} in the run.`);
      expect(verify(r.text, CTX), rule).toEqual([]);
    }
  });

  it('all at once: every rule fires, and what is left passes', () => {
    const all = Object.values(FIXTURES).flat().join('\n');
    expect(verify(all, CTX)).toEqual([...RULE_NAMES]);
    const r = redact(all, CTX);
    expect(r.fired).toEqual([...RULE_NAMES]);
    expect(verify(r.text, CTX)).toEqual([]);
    for (const secret of ['example', 'octocat', 'deadbeef', 'ghp_', 'charge.ts', 'acme', 'prreviewer42', 'Ottilie', '<!--']) {
      expect(r.text).not.toContain(secret);
    }
  });
});

describe('what the scrub keeps', () => {
  it('Kanon\'s own files, by their tree path, with a line, an anchor or $KANON before them', () => {
    const text = 'Where: scripts/overseer-file.mjs:120, $KANON/scripts/merge-gate.mjs#L40-L42 and ./rulebook/08-observability-and-cost.md.';
    expect(verify(text, CTX)).toEqual([]);
    expect(redact(text, CTX)).toEqual({ text, fired: [] });
  });

  it('a path shaped like Kanon\'s but not in the tree the lane runs from', () => {
    expect(redact('Where: scripts/not-in-kanon.mjs', CTX).text).toBe('Where: [path]');
    // Without a tree, as at intake, a path is Kanon's when it has the finding row's pattern.
    expect(verify('Where: scripts/not-in-kanon.mjs')).toEqual([]);
    expect(verify('Where: src/not-in-kanon.mjs')).toEqual(['path']);
    expect(KANON_PATH.test('scripts/not-in-kanon.mjs')).toBe(true);
  });

  it('Kanon\'s vocabulary: rule ids, versions, codes and prose abbreviations', () => {
    const text = 'Expected: K-OBS-16 on v0.37.0, e.g. the reason `did_not_finish` at stage `agent`, i.e. issue #41.';
    expect(verify(text, CTX)).toEqual([]);
    expect(redact(text, CTX).text).toBe(text);
  });
});

describe('the name context (§4.2)', () => {
  it('holds hashes only, of every word of every name the lane can see', () => {
    const hashes = nameContext(SOURCES);
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
    for (const w of ['acme', 'corp', 'widget', 'shop', 'widgetbot', 'checkwright', 'harbor', 'captain', 'quietcollab', 'prreviewer42',
      'issueopener9', 'assigneeone', 'drivebycommenter', 'commitwright', 'ottilie', 'brennholz']) {
      expect(hashes.has(sha256(w)), w).toBe(true);
    }
    expect(hashes.has(sha256('bot')), 'an App\'s [bot] suffix is not a name').toBe(false);
  });

  it('removes a login or name from each source, bare, with no @', () => {
    const each: [keyof typeof SOURCES, string][] = [
      ['repository', 'widget-shop'], ['apps', 'widgetbot-checkwright'], ['actor', 'harbor-captain'], ['collaborators', 'quietcollab'],
      ['participants', 'prreviewer42'], ['commitAuthors', 'Brennholz'],
    ];
    for (const [source, word] of each) {
      const ctx = { nameHashes: nameContext({ [source]: SOURCES[source] }), kanonFiles: KANON_FILES };
      const text = `Observed: ${word} changed the setting.`;
      expect(verify(text, ctx), source).toEqual(['name']);
      expect(redact(text, ctx).text, source).toBe('Observed: [name] changed the setting.');
    }
  });

  it('a bare third-party login, a collaborator\'s or a PR reviewer\'s, is removed; without the participants it gets through', () => {
    const text = 'The reviewer prreviewer42 and quietcollab both approved.';
    expect(redact(text, CTX).text).toBe('The reviewer [name] and [name] both approved.');
    const withoutParticipants: Partial<typeof SOURCES> = { ...SOURCES };
    delete withoutParticipants.participants;
    const narrow = { nameHashes: nameContext(withoutParticipants), kanonFiles: KANON_FILES };
    expect(redact(text, narrow).text).toBe('The reviewer prreviewer42 and [name] both approved.');
    expect(verify('The reviewer prreviewer42 approved.', narrow)).toEqual([]);
  });

  it('removes each word of a name wherever it stands, common or not: too much rather than too little', () => {
    const ctx = { nameHashes: nameContext({ participants: ['the-builder'] }), kanonFiles: KANON_FILES };
    expect(redact('Observed: the lane stopped.', ctx).text).toBe('Observed: [name] lane stopped.');
  });

  it('a word only partly a name is still removed whole, and so is a name inside punctuation', () => {
    expect(redact('Observed: (widget-shop).', CTX).text).toBe('Observed: ([name]).');
    expect(redact('Observed: x_quietcollab_y', CTX).text).toBe('Observed: [name]');
  });
});

describe('the two halves agree, and never echo', () => {
  it('a placeholder never fires, even when a placeholder\'s word is a name the lane can see', () => {
    const ctx = { nameHashes: nameContext({ collaborators: ['path', 'name', 'url', 'cut'] }), kanonFiles: KANON_FILES };
    expect(verify('[url] [email] [login] [key] [token] [path] [name] [cut]', ctx)).toEqual([]);
    const r = redact('see https://example.com and src/x.ts, cut short [cut]', ctx);
    expect(r.text).toBe('see [url] and [path], [name] short [cut]');
    expect(verify(r.text, ctx)).toEqual([]);
  });

  it('verify returns rule names, and nothing of the text', () => {
    const v = verify(Object.values(FIXTURES).flat().join(' '), CTX);
    for (const n of v) expect(RULE_NAMES).toContain(n);
  });

  it('is deterministic: no clock, no network, no randomness; the same answer twice', () => {
    expect(SOURCE).not.toMatch(/\bDate\b|\bfetch\b|Math\.random|process\.env/);
    const text = Object.values(FIXTURES).flat().join('\n');
    expect(redact(text, CTX)).toEqual(redact(text, CTX));
    expect(redact(redact(text, CTX).text, CTX).text).toBe(redact(text, CTX).text);
  });

  it('reads a string only', () => {
    expect(() => verify(42 as unknown as string)).toThrow(TypeError);
    expect(() => redact(null as unknown as string)).toThrow(TypeError);
  });

  it('writes no name in clear: the module holds none of the context\'s words', () => {
    for (const w of ['acme', 'prreviewer42', 'quietcollab', 'ottilie']) expect(SOURCE.toLowerCase()).not.toContain(w);
  });
});
