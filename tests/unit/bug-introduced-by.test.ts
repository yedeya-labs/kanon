import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INTRODUCED_BY, introducedBy } from '../../scripts/metrics/detectors.mjs';

/**
 * Plan 0003 §3.5 and decision 9 (M3, kanon#657): a linked fix counts only when its bug issue,
 * or the fix, cross-references the pull request that introduced the defect. GitHub records that
 * `cross-referenced` event only for a `#<n>` reference, so the bug form asks for one, optionally,
 * and the Implementer's playbook asks it to name the cause when it finds it. The detector also
 * reads the field itself, by its label, so the form and `INTRODUCED_BY` must agree.
 */
const ROOT = process.cwd();
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

type Field = { type: string; id?: string; attributes?: Record<string, string>; validations?: { required?: boolean } };
const bugForm = (): Field[] => (parse(read('.github/ISSUE_TEMPLATE/bug.yml')) as { body: Field[] }).body;

describe('the bug form', () => {
  it('has an optional "Introduced by" input that asks for the pull request as #<n>', () => {
    const field = bugForm().find((f) => f.id === 'introduced-by');
    expect(field).toBeDefined();
    expect(field?.type).toBe('input');
    expect(field?.attributes?.label).toBe(INTRODUCED_BY);
    // Optional: a reporter rarely knows the cause, and a guess would count as an escape.
    expect(field?.validations?.required ?? false).toBe(false);
    // The detector reads a bare number from the field too, but only `#<n>` also makes GitHub
    // record the cross-reference, the link that holds without the form.
    expect(field?.attributes?.placeholder).toMatch(/^#\d+$/);
    expect(field?.attributes?.description).toMatch(/`#\d+`/);
  });

  it('renders, as GitHub renders a filed form, to a body the linked-fix detector reads the PR from', () => {
    const value: Record<string, string> = { version: 'v1.0.0', what: 'It broke, see #99.', expected: 'K-SHIP-4', 'introduced-by': '#12' };
    const body = bugForm().map((f) => `### ${f.attributes?.label}\n\n${value[f.id ?? ''] ?? '_No response_'}`).join('\n\n');
    expect(introducedBy(body, 'o/r')).toEqual([12]);
    expect(introducedBy(body.replace('#12', '_No response_'), 'o/r')).toEqual([]);
  });

  it('keeps the field after the required ones, so it reads as the last, optional question', () => {
    const ids = bugForm().map((f) => f.id);
    expect(ids.indexOf('introduced-by')).toBe(ids.length - 1);
  });
});

describe.each([
  'docs/qa/triage-fix-playbook.md',
  'rulebook/templates/playbooks/triage-fix-playbook.md',
])('%s', (path) => {
  it('asks the Implementer to name the pull request that introduced a bug, as "Introduced by #<n>", in its own pull request', () => {
    const section = read(path).split(/^## /m).find((s) => s.startsWith('Implementer mode')) ?? '';
    const line = section.split('\n').find((l) => l.includes('Introduced by')) ?? '';
    expect(line).toMatch(/`Introduced by #<n>`/);
    expect(line).toMatch(/pull request's body/);
    // Only on evidence: a guessed cause is counted as an escape the item never had.
    expect(line).toMatch(/never a guess/);
  });
});
