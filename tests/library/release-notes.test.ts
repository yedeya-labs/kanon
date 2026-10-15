/**
 * Locks the pure release-note helpers shared by announce-deploy.mjs (Kanon text,
 * plan 0011 N9) and weekly-digest.mjs (Slack mrkdwn until N8 moves it) (RA-502).
 *
 * Both callers parse and classify with the same functions (`parseSections`,
 * `scopeOf`, `classify`): the deploy announcement and the weekly digest must
 * categorise the same commit identically, and a silent drift between them is
 * invisible until a stakeholder reads two posts that disagree. The Kanon-text
 * renderers are tested here too; announce-deploy.test.ts tests the message.
 */
import { describe, expect, it } from 'vitest';
import {
  classify,
  cleanBullet,
  dropScopePrefix,
  INTERNAL_SCOPES,
  kanonList,
  kanonMaint,
  parseSections,
  scopeOf,
  slackInline,
} from '../../scripts/lib/release-notes.mjs';

describe('parseSections', () => {
  it('buckets bullets under their heading, accepting * and - at any indent', () => {
    const md = ['### Features', '* **payments:** tax line', '  - **checkout:** add-ons', '', '### Bug Fixes', '* **ui:** nit'].join('\n');
    expect(parseSections(md)).toEqual({
      Features: ['**payments:** tax line', '**checkout:** add-ons'],
      'Bug Fixes': ['**ui:** nit'],
    });
  });

  it('drops bullets that precede any heading rather than inventing a section', () => {
    expect(parseSections('* orphan\n### Features\n* **a:** b')).toEqual({ Features: ['**a:** b'] });
  });

  it('normalises CRLF, so a Windows-authored release body parses the same', () => {
    expect(parseSections('### Features\r\n* **a:** b\r\n')).toEqual({ Features: ['**a:** b'] });
  });

  it('returns {} for an empty body', () => {
    expect(parseSections('')).toEqual({});
  });
});

describe('classify', () => {
  it('reads the heading when the scope is not internal', () => {
    expect(classify('Features', 'payments')).toBe('feature');
    expect(classify('Bug Fixes', 'payments')).toBe('fix');
    expect(classify('Performance Improvements', 'storefront')).toBe('fix');
    expect(classify('Reverts', 'storefront')).toBe('fix');
    expect(classify('Miscellaneous', 'storefront')).toBe('maint');
  });

  it('forces maint for an internal scope even under a Features heading', () => {
    // The load-bearing case: a `feat(ci)` must never reach a stakeholder as a Feature.
    for (const scope of ['ci', 'deps', 'docs', 'test', 'chore', 'refactor']) {
      expect(classify('Features', scope), scope).toBe('maint');
    }
  });

  it('treats a missing scope as heading-only', () => {
    expect(classify('Features', null)).toBe('feature');
  });

  it('keeps the internal scope list stable', () => {
    // A scope silently leaving this set turns internal churn into a headline.
    expect(INTERNAL_SCOPES.has('ci')).toBe(true);
    expect(INTERNAL_SCOPES.has('payments')).toBe(false);
  });
});

describe('scopeOf', () => {
  it('extracts and lowercases the scope', () => {
    expect(scopeOf('**Payments:** thing')).toBe('payments');
  });
  it('is null when the bullet has no scope', () => {
    expect(scopeOf('just prose')).toBeNull();
  });
});

describe('cleanBullet', () => {
  it('renders `scope: prose (<url|#pr>)` and drops non-PR refs', () => {
    const raw = '**payments:** add tax ([abc1234](https://x/commit/abc)) ([#123](https://x/pull/123))';
    expect(cleanBullet(raw)).toBe('payments: add tax (<https://x/pull/123|#123>)');
  });

  it('keeps the LAST PR ref when several are present', () => {
    const raw = '**a:** b ([#1](https://x/1)) ([#2](https://x/2))';
    expect(cleanBullet(raw)).toBe('a: b (<https://x/2|#2>)');
  });

  it('survives a bullet with no scope and no refs', () => {
    expect(cleanBullet('plain prose')).toBe('plain prose');
  });

  it('converts inline markdown to Slack mrkdwn', () => {
    expect(cleanBullet('**a:** see **this** and [docs](https://d)')).toBe('a: see *this* and <https://d|docs>');
  });
});

describe('slackInline', () => {
  it('converts bold and links, leaving other text alone', () => {
    expect(slackInline('**b** [t](https://u) plain')).toBe('*b* <https://u|t> plain');
  });
});

describe('dropScopePrefix', () => {
  it('removes a leading `scope: ` so a grouped list does not repeat it', () => {
    expect(dropScopePrefix('payments: add tax')).toBe('add tax');
  });
  it('leaves prose containing a colon mid-sentence intact', () => {
    expect(dropScopePrefix('note: this has: two')).toBe('this has: two');
  });
});

describe('kanonList', () => {
  it('is empty for no bullets, so the section disappears rather than showing a header', () => {
    expect(kanonList([])).toBe('');
  });

  it('dedupes identical bullets', () => {
    expect(kanonList(['**a:** x', '**a:** x'])).toBe('- a: x');
  });

  it('caps and reports the remainder', () => {
    const bullets = Array.from({ length: 10 }, (_, i) => `**a:** item ${i}`);
    const out = kanonList(bullets, 3);
    expect(out.match(/^- /gm)).toHaveLength(3);
    expect(out).toContain('…and 7 more');
  });
});

describe('kanonMaint', () => {
  it('rolls single dependency bumps into a count', () => {
    expect(kanonMaint(['**deps:** bump a', '**deps:** bump b'])).toContain('2 dependency updates');
  });

  it('reads a batched "with N updates" bump and marks the total approximate', () => {
    expect(kanonMaint(['**deps:** bump the group with 5 updates'])).toContain('~5 dependency updates');
  });

  it('singularises one update', () => {
    expect(kanonMaint(['**deps:** bump a'])).toBe('1 dependency update');
  });

  it('lists non-dependency scopes separately and sorts them', () => {
    expect(kanonMaint(['**test:** x', '**ci:** y'])).toBe('ci, test updates');
  });

  it('is empty when nothing qualifies', () => {
    expect(kanonMaint([])).toBe('');
  });
});
