import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * kanon#1566 (the Owner's decision of 2026-11-06): a brief's bail list binds whoever implements its
 * items, a local Claude session included, and an item reserved with `qa:human-action` states its
 * plan as its pull request's first section, which the Reviewer checks before the code.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const section = (text: string, heading: string) => {
  const at = text.indexOf(`\n${heading}\n`);
  if (at < 0) return null;
  const rest = text.slice(at + heading.length + 2);
  const end = rest.search(/\n#{2,3} /);
  return end < 0 ? rest : rest.slice(0, end);
};

describe('the bail list binds whoever implements (kanon#1566)', () => {
  it('says so in K-AGENT-13, with the plan as the pull request\'s first section where no lane runs', () => {
    const rule = section(read('rulebook/03-agents.md'), '### `K-AGENT-13` Assess scope first, and bail with a plan on the bail list')!;
    expect(rule).toContain('The bail list binds whoever implements the change, a lane, a person or a local Claude session alike.');
    expect(rule).toContain("the plan is the pull request's first section, `## Plan`, and the Reviewer checks it before reviewing the code");
    expect(read('rulebook/CHANGES.md')).toMatch(/## `K-AGENT-13`\n\n- \*\*2026-11-06\.\*\* The Owner decided that the bail list binds whoever implements a change/);
  });

  it('says so in the brief template, which the Lead copies, and in its copy here', () => {
    const t = read('rulebook/templates/brief.md');
    expect(t).toContain('The bail list binds whoever implements an item, the Implementer lane, a person or a local Claude session alike (`K-AGENT-13`).');
    expect(t).toContain("when it opens a pull request, that pull request's first section is `## Plan`");
    expect(read('docs/projects/_template.md')).toBe(t);
  });

  it('has the Reviewer read the plan before the code, in Kanon\'s playbook and the baseline', () => {
    for (const p of ['docs/qa/reviewer-playbook.md', 'rulebook/templates/playbooks/reviewer-playbook.md']) {
      const s = section(read(p), '## A pull request no lane opened, on a brief item');
      expect(s, p).not.toBeNull();
      expect(s, p).toContain('Read the plan before the code.');
      expect(s, p).toContain('With no `## Plan` section, request changes asking for it and review nothing else yet.');
    }
  });
});
