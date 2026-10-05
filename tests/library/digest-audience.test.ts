import { describe, expect, it } from 'vitest';
import { digestAudienceCli } from '../../scripts/digest-audience.mjs';
import {
  DEFAULT_AUDIENCE,
  LABEL,
  MAX_LENGTH,
  parseDigestAudience,
  readDigestAudience,
  readDigestAudienceFrom,
} from '../../scripts/lib/digest-audience.mjs';
import { parseReferenceDeploy } from '../../scripts/lib/reference-deploy.mjs';

/**
 * kanon#218, `K-LAYOUT-10`: the weekly digest's audience, declared by the adopter under
 * `## Choices` in the adoption record, with Kanon's neutral wording as the default.
 */
const RECORD = (choices: string[], tail = '') =>
  ['# Adoption', '', '## People', '', '- Owner: someone', '', '## Choices', '', ...choices, '', tail].join('\n');
const BULLET = `- **${LABEL}:** a co-founder tracking runway`;

describe('the declaration', () => {
  it('reads the audience under `## Choices`, beside the other choices', () => {
    expect(parseDigestAudience(RECORD(['- **Chat channel:** #team', BULLET, '- **Reference environment:** `staging`', '- **Reference deploy workflow:** `deploy.yml`', '- **Reference deploy job:** `deploy`'])))
      .toBe('a co-founder tracking runway');
  });

  it('drops a trailing full stop, so it completes "The reader is …"', () => {
    expect(parseDigestAudience(RECORD([`${BULLET}.`]))).toBe('a co-founder tracking runway');
    expect(parseDigestAudience(RECORD([`* **${LABEL}:** the board  `]))).toBe('the board');
  });

  it('reads a CRLF record as it reads an LF one', () => {
    expect(parseDigestAudience(RECORD([BULLET]).replace(/\n/g, '\r\n'))).toBe('a co-founder tracking runway');
  });

  it('declares nothing without the bullet, or with it only inside a code fence', () => {
    expect(parseDigestAudience(RECORD(['- **Chat channel:** none']))).toBeNull();
    expect(parseDigestAudience(RECORD(['```markdown', BULLET, '```']))).toBeNull();
  });

  it('does not disturb the reference-deploy declaration beside it', () => {
    expect(parseReferenceDeploy(RECORD([BULLET]))).toBeNull();
  });

  it.each([
    ['outside `## Choices`', `# Adoption\n\n${BULLET}\n\n## Choices\n\n- **Chat channel:** none\n`, /adoption\.md:3 declares the weekly digest's audience outside `## Choices`/],
    ['after `## Choices` ends', RECORD([], `## Later\n\n${BULLET}`), /outside `## Choices`/],
    ['with no `## Choices` at all', `# Adoption\n\n${BULLET}\n`, /outside `## Choices`/],
    ['twice', RECORD([BULLET, `- **${LABEL}:** the board`]), /adoption\.md:10 repeats `Weekly digest audience`, already declared on line 9/],
    ['indented', RECORD([`  ${BULLET}`]), /isn't a declaration: write a `- ` bullet at the start of the line/],
    ['numbered', RECORD([`1. **${LABEL}:** the board`]), /isn't a declaration/],
    ['without a space after the label', RECORD([`- **${LABEL}:**the board`]), /isn't a declaration/],
    ['empty', RECORD([`- **${LABEL}:** .`]), /names no audience/],
    ['with a backtick', RECORD([`- **${LABEL}:** \`the board\``]), /is plain text, without a backtick/],
    ['too long', RECORD([`- **${LABEL}:** ${'x'.repeat(MAX_LENGTH + 1)}`]), new RegExp(`is ${MAX_LENGTH + 1} characters; name the reader in at most ${MAX_LENGTH}`)],
    ['with a fence that never closes', RECORD(['```', BULLET]), /opens a code fence that never closes/],
  ])('throws by name when written %s', (_why, text, message) => {
    expect(() => parseDigestAudience(text)).toThrow(message);
    expect(() => parseDigestAudience(text)).toThrow(/\(K-LAYOUT-10\)$/);
  });

  it('allows exactly the longest audience', () => {
    expect(parseDigestAudience(RECORD([`- **${LABEL}:** ${'x'.repeat(MAX_LENGTH)}`]))).toHaveLength(MAX_LENGTH);
  });

  it('reads the fixture adopter, which declares none', () => {
    expect(readDigestAudience()).toBeNull();
  });
});

describe('the lane reads it from the default branch (K-MERGE-17)', () => {
  const run = (contents: () => string) => (args: string[]) => (args[1] === 'repos/o/r' ? 'trunk\n' : contents());
  const fail = (stderr: string) => () => {
    throw Object.assign(new Error('gh failed'), { stderr });
  };

  it('uses the declared audience, and Kanon\'s default when there is none or no record', () => {
    expect(readDigestAudienceFrom('o/r', run(() => RECORD([BULLET])))).toBe('a co-founder tracking runway');
    expect(readDigestAudienceFrom('o/r', run(() => RECORD([])))).toBe(DEFAULT_AUDIENCE);
    expect(readDigestAudienceFrom('o/r', run(fail('gh: Not Found (HTTP 404)')))).toBe(DEFAULT_AUDIENCE);
  });

  it("names Kanon's default when it takes it, and says nothing when the record declares one (plan 0005 §5.2)", () => {
    const notes: string[] = [];
    readDigestAudienceFrom('o/r', run(() => RECORD([])), (l) => notes.push(l));
    readDigestAudienceFrom('o/r', run(fail('gh: Not Found (HTTP 404)')), (l) => notes.push(l));
    readDigestAudienceFrom('o/r', run(() => RECORD([BULLET])), (l) => notes.push(l));
    expect(notes).toEqual([
      `docs/qa/adoption.md on \`trunk\` declares no audience, so Kanon's default applies: the digest is written for ${DEFAULT_AUDIENCE} (K-LAYOUT-10)`,
      `docs/qa/adoption.md on \`trunk\` doesn't exist, so Kanon's default applies: the digest is written for ${DEFAULT_AUDIENCE} (K-LAYOUT-10)`,
    ]);
    expect(digestAudienceCli({ repo: 'o/r', run: run(() => RECORD([])) })).toEqual({ code: 0, out: DEFAULT_AUDIENCE, notes: [`digest-audience: ${notes[0]}`] });
  });

  it('fails by name on a malformed record, an unreadable one, and no default branch', () => {
    expect(() => readDigestAudienceFrom('o/r', run(() => RECORD([BULLET, BULLET])))).toThrow(/repeats `Weekly digest audience`/);
    expect(() => readDigestAudienceFrom('o/r', run(fail('gh: Server Error (HTTP 502)')))).toThrow(/couldn't be read from `trunk`: gh: Server Error \(HTTP 502\)/);
    expect(() => readDigestAudienceFrom('o/r', () => '\n')).toThrow(/no default branch to read docs\/qa\/adoption\.md from/);
  });

  it('the CLI prints the audience, and exits 1 or 2 by name', () => {
    expect(digestAudienceCli({ repo: 'o/r', run: run(() => RECORD([BULLET])) })).toEqual({ code: 0, out: 'a co-founder tracking runway' });
    expect(digestAudienceCli({ repo: 'o/r', run: run(() => RECORD([`- **${LABEL}:**`])) }).code).toBe(1);
    expect(digestAudienceCli({ repo: '' })).toEqual({ code: 2, out: 'digest-audience: GITHUB_REPOSITORY must be set' });
  });

  it('the default is the neutral audience kanon#216 shipped', () => {
    expect(DEFAULT_AUDIENCE).toBe('a stakeholder who follows the project from outside the day-to-day work');
  });
});
