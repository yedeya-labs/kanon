import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SECURITY.md states the exposure the Owner accepted for the implementer's revise and
 * rebase lanes (kanon#580): they run the pull request's code in the job that holds the App
 * token and the Claude token. It is the first thing an adopter's security review asks about,
 * so the page says it plainly, and both lanes' documentation links to it.
 *
 *   1. SECURITY.md has an "Accepted exposures" section naming both lanes, what runs, the
 *      credentials present, why it is accepted and what bounds it;
 *   2. each rule id it cites sits in parentheses after prose that says what it means, and is
 *      a link to the rulebook chapter that declares it;
 *   3. docs/lanes.md's passages on the revise lane and the rebase lane link to that section.
 */

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** The body of the `## ` section titled `title`, up to the next `## `. Throws when absent. */
const section = (text: string, title: string): string => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `## ${title}`);
  if (start < 0) throw new Error(`no "## ${title}" section`);
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
};

/** GitHub's anchor for a heading: lowercased, punctuation dropped, spaces to hyphens. */
const slug = (heading: string): string => heading.toLowerCase().replace(/[^\w\- ]/g, '').replace(/ /g, '-');

const SECURITY = read('SECURITY.md');
const ANCHOR = `SECURITY.md#${slug('Accepted exposures')}`;

describe('SECURITY.md states the accepted exposure of implement-revise and rebase (kanon#580)', () => {
  it('has an "Accepted exposures" section', () => {
    expect(() => section(SECURITY, 'Accepted exposures')).not.toThrow();
  });

  it('names both lanes, what runs in them and the credentials beside it', () => {
    const body = section(SECURITY, 'Accepted exposures');
    for (const lane of ['agent-implement-revise.yml', 'agent-rebase.yml']) expect(body).toContain(lane);
    expect(body).toMatch(/project-setup hook/);
    expect(body).toMatch(/tests?|gates?/);
    expect(body).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(body).toMatch(/Author App's .*token/);
  });

  it('says why it is accepted and what bounds it: scopes, lifetime, the membership gate, forks', () => {
    const body = section(SECURITY, 'Accepted exposures');
    expect(body).toMatch(/### Why it is accepted/);
    expect(body).toMatch(/### What bounds it/);
    for (const scope of ['contents', 'issues', 'pull requests', 'workflows']) expect(body).toContain(scope);
    expect(body).toMatch(/expires within an hour/);
    expect(body).toMatch(/revoked/);
    expect(body).toMatch(/member/);
    expect(body).toMatch(/fork/);
  });

  it('glosses every rule id it cites and links it to the rulebook chapter that declares it', () => {
    const cited = [...SECURITY.matchAll(/K-[A-Z]+-\d+/g)];
    expect(cited.length).toBeGreaterThan(0);
    for (const m of cited) {
      const id = m[0];
      // In parentheses, so the sentence before it reads without it.
      const before = SECURITY.slice(0, m.index);
      expect(before.lastIndexOf('(')).toBeGreaterThan(before.lastIndexOf(')'));
      const link = SECURITY.slice(m.index).match(/^K-[A-Z]+-\d+`?\]\((rulebook\/[\w-]+\.md)\)/);
      expect(link, `${id} is not a link to the rulebook`).not.toBeNull();
      expect(read(link![1]!)).toContain(`### \`${id}\``);
    }
  });
});

describe('the revise and rebase lanes\' documentation links to the accepted exposure (kanon#580)', () => {
  const LANES = read('docs/lanes.md');

  it.each(['The revise lane', 'The rebase lane'])('docs/lanes.md "%s" links to SECURITY.md\'s section', (title) => {
    expect(section(LANES, title)).toContain(`](../${ANCHOR})`);
  });

  it('the project-setup hook\'s note on the two lanes links to it too', () => {
    expect(section(LANES, 'The project-setup hook')).toContain(`](../${ANCHOR})`);
  });
});
