import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Plan 0007 step G1: one consent question replaces the telemetry, upstream-findings and evidence
 * questions (Owner decision 2), and the caveats those questions carry beyond the consent
 * question's own disclosure move to `docs/sharing.md`, the page it links (Owner decision 14).
 * The disclosure itself stays in the question (Owner decision 15), so ADR 0007's "says plainly"
 * sentence is kept, and only its "as their own questions" is amended.
 */
const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

describe('docs/sharing.md, the consent question\'s page (plan 0007 G1)', () => {
  const page = read('docs/sharing.md');

  // Each caveat the evidence question (`UPSTREAM_EVIDENCE_QUESTION`) states today, and where the page must say it.
  it.each([
    ['the scrub', /automatic scrub removes URLs, this repository's name, the logins and names the lane can see, and every path outside Kanon's own files/],
    ['that it may rarely still hold personal data', /may rarely still (?:contain|hold) personal data/],
    ['the third-party decision provider', /third-party decision provider, TypeSafe, whose model, Jev, decides whether a finding becomes a public Kanon issue/],
    ['that the text is never published', /text itself is never published/],
    ['Frankfurt', /Frankfurt \(eu-central-1\)/],
    ['13 months', /kept 13 months/],
    ['erasure', /erase[sd]? .*on request/],
    ['how to stop', /delet(?:e|ing) `\.github\/workflows\/telemetry\.yml`/],
  ])('states %s', (_what, phrase) => {
    expect(page).toMatch(phrase);
  });

  it('names the three answers and what each sets', () => {
    expect(page).toMatch(/\*\*Yes\*\*[^\n]*telemetry on[^\n]*`sent with evidence`/);
    expect(page).toMatch(/\*\*Codes only\*\*[^\n]*telemetry on[^\n]*`sent`/);
    expect(page).toMatch(/\*\*No\*\*[^\n]*no telemetry[^\n]*`drafted`/);
  });
});

describe('the rules name one consent question (plan 0007 G1)', () => {
  const adr = read('docs/decisions/0007-data-boundary.md');
  const obs = read('rulebook/08-observability-and-cost.md');
  const obs18 = obs.slice(obs.indexOf('### `K-OBS-18`'));

  it('ADR 0007 asks both levels in one consent question, and still says plainly who reads the text', () => {
    expect(adr).toContain('asked during install, in one consent question that sets both levels');
    expect(adr).not.toContain('asked during install as their own questions');
    expect(adr).toContain('The question for the second level says plainly that the text is read by Kanon\'s maintainer and by a third-party decision provider.');
  });

  it("K-OBS-18's Enforced by names the consent question", () => {
    const enforced = /^\*\*Enforced by\.\*\* (.*)$/m.exec(obs18)?.[1] ?? '';
    expect(enforced).toContain('consent question');
    expect(enforced).toContain('docs/sharing.md');
    expect(enforced).not.toContain('will be a step in the installer');
  });
});
