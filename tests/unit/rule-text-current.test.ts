import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMAS, STORE_FIELDS } from '../../actions/agent-telemetry/schema.mjs';

/**
 * Text that described a plan after the plan shipped, found while writing the v1 docs (kanon#707).
 * Each passage here is held to what the code does now: the consent question `kanon init` asks
 * (`CONSENT_QUESTION` in `cli/init.mjs`, and `docs/sharing.md`'s three answers), the fields a
 * telemetry row carries (`actions/agent-telemetry/schema.mjs`), and the installer that runs
 * `K-ADOPT-1`'s steps (`kanon init`, `kanon doctor` and the adopt skill).
 */
const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** A rule's section, from its heading to the next rule's. */
const ruleOf = (chapter: string, id: string): string => {
  const text = read(chapter);
  const start = text.indexOf(`### \`${id}\``);
  const end = text.indexOf('\n### ', start + 1);
  return text.slice(start, end === -1 ? undefined : end);
};
const paragraph = (rule: string, name: string): string =>
  new RegExp(`^\\*\\*${name}\\.\\*\\*([\\s\\S]*?)(?=^\\*\\*[A-Z][a-z ]+\\.\\*\\*)`, 'm').exec(rule)?.[1] ?? '';

describe('K-OBS-18 describes the consent question as it ships (kanon#707)', () => {
  const rule = ruleOf('rulebook/08-observability-and-cost.md', 'K-OBS-18');

  it('names what asks it now, and the test that holds "nothing sent without an explicit answer"', () => {
    const enforced = paragraph(rule, 'Enforced by');
    expect(enforced).not.toMatch(/until then|G5 and G6/);
    expect(enforced).not.toMatch(/^\s*Prose only/);
    expect(enforced).toContain('`CONSENT_QUESTION`');
    expect(enforced).toContain('`/kanon:adopt`');
    expect(enforced).toContain('tests/unit/kanon-init.test.ts');
    // The test it names exists under the title it cites.
    expect(read('tests/unit/kanon-init.test.ts')).toContain("it('installs nothing without an explicit yes");
  });

  it('says that by default nothing is sent, without an adopter-owned store the install never makes', () => {
    const optIn = /^- \*\*Opt-in\.\*\*(.*)$/m.exec(paragraph(rule, 'Rule'))?.[1] ?? '';
    expect(optIn).not.toMatch(/own store by default|same collector/);
    expect(optIn).toContain('**No**');
    expect(optIn).toContain('explicit opt-in');
  });
});

describe('ADR 0007 records that rules 1 and 3 now say what K-OBS-16 and K-OBS-18 say (kanon#708)', () => {
  const adr = read('docs/decisions/0007-data-boundary.md');
  const amendment = /^\*\*Amended 2026-10-12[^\n]*\n((?:- [^\n]*\n)+)/m.exec(adr)?.[1] ?? '';

  it("amends rule 1's repository to the opaque key, and rule 3's default to no collector", () => {
    expect(amendment).toMatch(/^- \*\*Rule 1's "the repository" is the opaque key/m);
    expect(amendment).toMatch(/^- \*\*Rule 3's default is not an adopter-owned store[^\n]*\*\*No\*\*/m);
  });

  it('points rules 1 and 3 at the amendment, beside the text it changes', () => {
    expect(/^1\. [\s\S]*?^2\. /m.exec(adr)?.[0]).toContain('amendment of 2026-10-12, below');
    expect(/^3\. .*$/m.exec(adr)?.[0]).toContain('amended 2026-10-12, below');
  });
});

describe("K-OBS-16 lists what a row carries, and a row names no repository (kanon#707)", () => {
  it('no row kind has a field naming the repository or its owner, and the store sets the key', () => {
    for (const [kind, versions] of Object.entries(SCHEMAS)) {
      for (const fields of Object.values(versions)) {
        expect(Object.keys(fields).filter((f) => /(^|_)(repo|repository|owner)(_|$)/.test(f)), kind).toEqual([]);
      }
    }
    expect(STORE_FIELDS).toContain('pk');
  });

  it('its first bullet is the opaque key and the issue or PR number, not the repository', () => {
    const first = /^\*\*Rule\.\*\* A telemetry row may contain only:\n- (.*)$/m.exec(ruleOf('rulebook/08-observability-and-cost.md', 'K-OBS-16'))?.[1] ?? '';
    expect(first).not.toMatch(/repository/);
    expect(first).toMatch(/opaque key/);
    expect(first).toMatch(/issue or PR number/);
  });
});

describe("K-OBS-16's Enforced by describes the deploy row's guard as the schema holds it (kanon#896)", () => {
  const enforced = paragraph(ruleOf('rulebook/08-observability-and-cost.md', 'K-OBS-16'), 'Enforced by');
  const deploy = /The deploy row is held the same way[^.]*\./.exec(enforced)?.[0] ?? '';
  const { role, position } = (SCHEMAS.deploy?.[1] ?? {}) as Record<string, { type: string; min?: number } | undefined>;

  it('says its role is from a closed list and its position an integer from 1, not an enum', () => {
    expect(role?.type).toBe('enum');
    expect(position).toMatchObject({ type: 'int', min: 1 });
    expect(deploy).not.toMatch(/position from closed lists/);
    expect(deploy).toMatch(/its role from a closed list/);
    expect(deploy).toMatch(/its position an integer from 1/);
  });
});

describe('K-ADOPT-1 names the installer that runs its steps today (kanon#707)', () => {
  const enforced = paragraph(ruleOf('rulebook/10-adoption.md', 'K-ADOPT-1'), 'Enforced by');

  it('says what runs and checks which steps, and leaves prose only to the rest', () => {
    expect(enforced).not.toMatch(/is planned|first pieces/);
    for (const s of ['`kanon init`', '`kanon doctor`', '`/kanon:adopt`', '`kanon milestones`', '`kanon apps`']) expect(enforced).toContain(s);
    expect(enforced).toMatch(/[Tt]he rest of step 4 \([^)]*\) and of step 13 \(the mechanism list and the reference environment's deploy\), steps 3, 9, 10, 11 and 14[^.]*prose only/);
    // Neither tool lays down these parts of step 4, so the rule must leave them to prose (kanon#708).
    const rest = /rest of step 4 \(([^)]*)\)/.exec(enforced)?.[1] ?? '';
    for (const s of ['agent instruction files', 'brief template', 'spec directory', 'observability document', '`.gitignore`']) expect(rest).toContain(s);
  });
});

describe("the architecture page's consent wording matches docs/sharing.md's three answers (kanon#707)", () => {
  const where = /^## Where data goes\n([\s\S]*?)(?=^## )/m.exec(read('docs/architecture.md'))?.[1] ?? '';
  const bullet = (name: string): string => new RegExp(`^- \\*\\*${name}\\*\\*.*$`, 'm').exec(where)?.[0] ?? '';

  it('turns telemetry on for Yes and Codes only', () => {
    const telemetry = bullet('The telemetry store');
    expect(telemetry).not.toContain('used only if you say yes at install');
    expect(telemetry).toContain('only if you answer **Yes** or **Codes only** at install');
  });

  it('sends a bug as codes only on Yes or Codes only, and its text only on Yes', () => {
    const bugs = bullet("Kanon's own bugs");
    expect(bugs).toContain('as codes if you answered **Yes** or **Codes only**, and with **Yes** also its evidence and suggested fix as scrubbed text');
    const sharing = read('docs/sharing.md');
    expect(sharing).toMatch(/^\| \*\*Codes only\*\* \| telemetry on/m);
    expect(sharing).toMatch(/^\| \*\*No\*\* \| no telemetry[^\n]*\| nothing/m);
  });
});
