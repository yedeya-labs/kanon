import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { skillTokenNeeds, tokenNeeds } from '../../cli/gh-token.mjs';

// kanon#1607 point 17: the adopt skill relays the permissions its token needs as `kanon init`
// gives them (`.token.needs`), read from docs/doctor.md's table, the one list of them, rather
// than a list the agent infers, which left out Actions: read.
const ROOT = join(import.meta.dirname, '..', '..');
const DOCTOR = readFileSync(join(ROOT, 'docs/doctor.md'), 'utf8');

describe("what a person's token needs, from docs/doctor.md (#1607)", () => {
  it("reads the adopt row's repository permissions, Actions: read included", () => {
    expect(skillTokenNeeds('adopt')).toEqual(tokenNeeds(DOCTOR, 'adopt'));
    expect(tokenNeeds(DOCTOR, 'adopt')).toEqual([
      { permission: 'Metadata', access: 'read' },
      { permission: 'Contents', access: 'read and write' },
      { permission: 'Issues', access: 'read and write' },
      { permission: 'Pull requests', access: 'read and write' },
      { permission: 'Actions', access: 'read' },
      { permission: 'Secrets', access: 'read and write' },
      { permission: 'Variables', access: 'read' },
      { permission: 'Administration', access: 'read and write' },
      { permission: 'Workflows', access: 'read and write' },
    ]);
  });

  it('takes each clause of the shape, names both of `A and B`, keeps the most it asks, and skips the reasons and any other clause', () => {
    const doc = [
      "### A person's fine-grained token",
      '',
      '| Skill | What the token needs |',
      '|---|---|',
      '| `x`: one | Metadata: read; Contents and Workflows: read and write (a branch; Issues: read, inside a reason); Contents: read. In an organisation, Actions: read on those. Variables: read |',
      '',
      '### Next',
      '| `y`: elsewhere | Issues: read |',
    ].join('\n');
    expect(tokenNeeds(doc, 'x')).toEqual([
      { permission: 'Metadata', access: 'read' },
      { permission: 'Contents', access: 'read and write' },
      { permission: 'Workflows', access: 'read and write' },
      { permission: 'Variables', access: 'read' },
    ]);
    // A row outside the section, a missing row or a missing section is no list.
    expect(tokenNeeds(doc, 'y')).toBeNull();
    expect(tokenNeeds(doc, 'z')).toBeNull();
    expect(tokenNeeds('# nothing', 'adopt')).toBeNull();
  });
});
