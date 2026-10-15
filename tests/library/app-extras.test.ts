// `K-LAYOUT-10`, `K-AGENT-3`: the extra App permissions an adoption record declares, read by one
// parser that `kanon apps`, `apps-check` and `kanon doctor` share.
import { describe, expect, it } from 'vitest';
import { ADOPTION_RECORD, CHOICES_HEADING, EXTRA_LABEL, readAppExtras, withExtras } from '../../scripts/lib/app-extras.mjs';
import { ADOPTION_RECORD as RECORD, CHOICES_HEADING as CHOICES } from '../../scripts/lib/deploy-declaration.mjs';

const APPS = ['author', 'judge', 'releaser'];
const record = (...choices: string[]) => ['# Adoption record', '', '## Choices', '', ...choices, '', '## Data', '', '- **Private or sensitive material:** `no`', ''].join('\n');
const GOOD = '- **Extra App permission:** `releaser` `workflows: write` (the pin pull request moves pins in .github/workflows)';

describe('readAppExtras', () => {
  it('names the same record and heading as the deploy declaration', () => {
    expect([ADOPTION_RECORD, CHOICES_HEADING]).toEqual([RECORD, CHOICES]);
    expect(EXTRA_LABEL).toBe('Extra App permission');
  });

  it('reads one App, one permission, one level and the reason', () => {
    expect(readAppExtras(record(GOOD), APPS)).toEqual({
      extras: { releaser: { workflows: 'write' } },
      reasons: { 'releaser.workflows': 'the pin pull request moves pins in .github/workflows' },
      errors: [],
    });
  });

  it('declares nothing extra without the bullet, or without a record', () => {
    for (const text of [record(), null, '']) expect(readAppExtras(text, APPS)).toEqual({ extras: {}, reasons: {}, errors: [] });
  });

  it('reads several permissions of one App, and of several Apps', () => {
    const r = readAppExtras(record(GOOD, '- **Extra App permission:** `releaser` `actions: read` (why)', '- **Extra App permission:** `author` `deployments: read` (why)'), APPS);
    expect(r.errors).toEqual([]);
    expect(r.extras).toEqual({ releaser: { workflows: 'write', actions: 'read' }, author: { deployments: 'read' } });
  });

  it('ignores a bullet inside a fenced block', () => {
    expect(readAppExtras(record('```markdown', GOOD, '```'), APPS).extras).toEqual({});
  });

  const malformed: [string, string, RegExp][] = [
    ['with no reason', '- **Extra App permission:** `releaser` `workflows: write`', /:5 is not/],
    ['with an empty reason', '- **Extra App permission:** `releaser` `workflows: write` ( )', /:5 is not/],
    ['with a level other than read or write', '- **Extra App permission:** `releaser` `workflows: admin` (why)', /:5 is not/],
    ['naming an App Kanon lacks', '- **Extra App permission:** `intake` `issues: write` (why)', /names the App `intake`/],
    ['in another shape', '* **Extra App permission:** releaser workflows: write (why)', /:5 is not/],
  ];
  for (const [what, bullet, error] of malformed) {
    it(`is malformed ${what}`, () => {
      const r = readAppExtras(record(bullet), APPS);
      expect(r.extras).toEqual({});
      expect(r.errors.join('\n')).toMatch(error);
    });
  }

  it('is malformed outside ## Choices, or declaring one permission twice', () => {
    const outside = `${record()}\n${GOOD}\n`;
    expect(readAppExtras(outside, APPS).errors.join('\n')).toMatch(/outside `## Choices`/);
    const twice = readAppExtras(record(GOOD, GOOD.replace('write', 'read')), APPS);
    expect(twice.errors.join('\n')).toMatch(/declares `workflows` for the releaser App a second time/);
    expect(twice.extras).toEqual({ releaser: { workflows: 'write' } });
  });
});

describe('withExtras', () => {
  it('raises a permission to the declared level, never lowers one, and leaves the grant alone', () => {
    const grant = { contents: 'write', pull_requests: 'write', metadata: 'read' };
    expect(withExtras(grant, { workflows: 'write', contents: 'read' })).toEqual({ ...grant, workflows: 'write' });
    expect(withExtras(grant, undefined)).toEqual(grant);
    expect(grant).toEqual({ contents: 'write', pull_requests: 'write', metadata: 'read' });
  });
});
