import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMAS, STORE_FIELDS } from '../../actions/agent-telemetry/schema.mjs';

/**
 * Text that described a plan after the plan shipped, found while writing the v1 docs (kanon#707).
 * Each passage here is held to what the code does now: the consent question `kanon init` asks
 * (`CONSENT_QUESTION` in `cli/init.mjs`, and `docs/sharing.md`'s three answers), the fields a
 * telemetry row carries (`actions/agent-telemetry/schema.mjs`), and the installer that runs
 * `K-ADOPT-1`'s steps (`kanon init`, `kanon doctor` and the adopt skill). And a rule the Owner
 * changed, held to the decision and to the docs that restate it: `K-MERGE-4`'s pinned library (kanon#728).
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

describe("K-MERGE-4 says a library the project's own lanes run only at a pinned release is product (kanon#728, kanon#897)", () => {
  const rule = ruleOf('rulebook/04-review-and-merge.md', 'K-MERGE-4');
  const LIBRARY = /library that the project's own lanes run only at a pinned release is product, not pipeline code/;

  it('says so in the rule, and its Why states the premise: the release and the pin bump both escalate', () => {
    expect(paragraph(rule, 'Rule')).toMatch(LIBRARY);
    const why = paragraph(rule, 'Why');
    expect(why).toMatch(/reaches the lanes only through the release[^.]*and the[^.]*pin/);
    expect(why).toMatch(/both escalate/);
    // Each half of "both": the Merger never merges a release, and the bump changes `.github/`.
    expect(why).toMatch(/never merges a release[^.]*`K-MERGE-3`/);
    expect(why).toMatch(/bump changes the pins under `\.github\/`/);
  });

  it('puts the library sentence after the one its "high-risk paths" come from, so "It also goes to a human" is still the PR (kanon#905)', () => {
    const sentences = paragraph(rule, 'Rule').trim().split(/(?<=\.)\s+(?=[A-Z])/);
    const highRisk = sentences.findIndex((s) => /^It also goes to a human if it changes one of the project's own high-risk paths/.test(s));
    expect(sentences[0]).toMatch(/^A PR always goes to a human if it changes \*\*the pipeline itself\*\*/);
    expect(highRisk).toBe(1);
    expect(sentences.findIndex((s) => /high-risk paths/.test(s))).toBe(highRisk);
    expect(sentences.findIndex((s) => LIBRARY.test(s))).toBeGreaterThan(highRisk);
  });

  it('records the change in CHANGES.md under K-MERGE-4, dated 2026-10-14, linking #728', () => {
    const section = /^## `K-MERGE-4`\n([\s\S]*?)(?=^## )/m.exec(read('rulebook/CHANGES.md'))?.[1] ?? '';
    expect(section).toMatch(/^- \*\*2026-10-14\.\*\* [^\n]*pinned release[^\n]*\[#728\]\(https:\/\/github\.com\/yedeya-labs\/kanon\/issues\/728\)/m);
  });

  it("Kanon's escalation file says why it declares no scripts/ as pipeline code, citing the sentence", () => {
    const pipelineCode = /^## Pipeline code\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(read('docs/qa/escalation-paths.md'))?.[1] ?? '';
    expect(pipelineCode).toMatch(/^None\./m);
    expect(pipelineCode).toMatch(/run only at a pinned release is product, not pipeline code \(`K-MERGE-4`\)/);
  });

  it("the lanes page's list of what still escalates says it too", () => {
    const merger = /^## The Merger\n([\s\S]*?)(?=^## )/m.exec(read('docs/lanes.md'))?.[1] ?? '';
    expect(merger).toMatch(/run only at a pinned release is product, not pipeline code \(`K-MERGE-4`\)/);
  });
});

describe("K-OBS-16 and ADR 0007 name the notify row the schema holds (kanon#943)", () => {
  const rule = ruleOf('rulebook/08-observability-and-cost.md', 'K-OBS-16');
  const notify = /^A notify row, [\s\S]*?(?=\n\nNo row contains)/m.exec(paragraph(rule, 'Rule'))?.[0] ?? '';
  const fields = Object.keys(SCHEMAS.notify?.[1] ?? {});
  /** What a notify row never carries (plan 0011 §11, decision 14), as the rule and the ADR say it. */
  const NEVER = ['URL', 'channel', 'host', 'text', 'status body', 'secret'];

  it('the rule names the fields its general list does not already cover', () => {
    for (const f of ['hook', 'kind', 'contract_version', 'producer_attempt', 'skip_reason', 'failure']) expect(fields).toContain(f);
    expect(notify).toMatch(/the hook's kind/);
    expect(notify).toMatch(/the message's kind/);
    expect(notify).toMatch(/contract version/);
    expect(notify).toMatch(/producer's attempt/);
    expect(notify).toMatch(/skip reason/);
    expect(notify).toMatch(/failure/);
  });

  it('the rule says what a notify row never holds, no field holds it, and it is stored but not published', () => {
    const never = /A notify row never holds ([^.]*)\./.exec(notify)?.[1] ?? '';
    for (const n of NEVER) expect(never).toContain(n);
    for (const n of ['url', 'channel', 'host', 'text', 'status', 'body', 'secret', 'webhook']) expect(fields).not.toContain(n);
    expect(notify).toMatch(/Notify rows are stored, and not published/);
  });

  it("its Enforced by cites the schema test N5 added, which exists under the title it cites", () => {
    const enforced = paragraph(rule, 'Enforced by');
    const held = /The notify row is held the same way[\s\S]*?\)\./.exec(enforced)?.[0] ?? '';
    expect(held).toContain('tests/unit/telemetry-schema.test.ts');
    expect(read('tests/unit/telemetry-schema.test.ts')).toContain("describe('the notify row (plan 0011 §11, step N5)'");
  });

  it('CHANGES.md records the amendment under K-OBS-16, linking #943', () => {
    const section = /^## `K-OBS-16`\n([\s\S]*?)(?=^## )/m.exec(read('rulebook/CHANGES.md'))?.[1] ?? '';
    expect(section).toMatch(/^- \*\*2026-10-14\.\*\* [^\n]*notify row[^\n]*\[#943\]\(https:\/\/github\.com\/yedeya-labs\/kanon\/issues\/943\)/m);
  });

  it("ADR 0007 records the notify row as it records the deploy row: Allowed, Never and Rule 5", () => {
    const adr = read('docs/decisions/0007-data-boundary.md');
    const amendment = /^\*\*Amended [^\n]*: the notify row\.\*\*[^\n]*\n((?:- [^\n]*\n)+)/m.exec(adr)?.[1] ?? '';
    const bullet = (name: string): string => new RegExp(`^- \\*\\*${name}[^\\n]*$`, 'm').exec(amendment)?.[0] ?? '';
    for (const f of ['hook', 'kind', 'contract version', "producer's attempt", 'skip reason']) expect(bullet('Allowed:')).toContain(f);
    for (const n of NEVER) expect(bullet('Never:')).toContain(n);
    expect(bullet('Rule 5 for notify rows:')).toMatch(/stored, and not published/);
    expect(bullet('Rule 5 for notify rows:')).toMatch(/decision 19/);
  });
});
