import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { SCHEMA as DOCTOR_SCHEMA } from '../../cli/doctor.mjs';
import { SCHEMA as INIT_SCHEMA, UPSTREAM_EVIDENCE_QUESTION } from '../../cli/init.mjs';
import { REVIEW_LABELS } from '../../scripts/lane-gate.mjs';
import { DEFAULT_VALUE as UPSTREAM_DEFAULT, LABEL as UPSTREAM_LABEL } from '../../scripts/lib/upstream-findings.mjs';

/**
 * The agent skills (plan 0005 step L11, ADR 0014 audience 1; docs/skills.md) are held to the
 * command they drive.
 *
 * WHY. A skill is instructions an agent follows, written against `kanon init --json` and
 * `kanon doctor --json` (ADR 0014's guardrail: the public surfaces only). Nothing runs those
 * instructions in CI, so a flag renamed in the parser, a finding id added to doctor or a field
 * moved in a JSON document would leave a skill that reads well and fails on the person's
 * machine, the one place nobody is looking. So every name a skill uses that the CLI defines is
 * checked against the CLI's own source or its documented contract:
 *
 *   - each `kanon <command>` a skill names is a command `cli/kanon.mjs` dispatches, and every
 *     `--flag` after it is one that command's parser compares against;
 *   - each skill's table of findings lists exactly the ids its command's page documents (whose
 *     own test holds them to the code), so a new id can't go unhandled and a removed one can't
 *     linger;
 *   - each JSON path a skill reads (`.findings[].fix.commands`) is a field the page documents;
 *   - each skill's status table is its command's, code for code;
 *   - each skill names the contract (`kanon-<command>/v1`) its command's `SCHEMA` prints, and runs
 *     `kanon` through `npx` at a release (whose number `version-references.test.ts` holds).
 *
 * It reads the skills as text; it can't tell whether an instruction is wise, only whether every
 * name in it exists.
 */

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** The body of a Markdown section: from its heading line to the next heading of its level or above. */
const section = (text: string, heading: RegExp): string | null => {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => heading.test(l));
  if (at < 0) return null;
  const level = /^(#+) /.exec(lines[at]!)?.[1]!.length ?? 0;
  const end = lines.findIndex((l, i) => i > at && /^(#+) /.test(l) && /^(#+) /.exec(l)![1]!.length <= level);
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n');
};

/** The cells of each table row in a piece of Markdown, header and rule rows included. */
const rows = (text: string): string[][] =>
  [...text.matchAll(/^\s*\|(.+)\|$/gm)].map((m) => m[1]!.split(/(?<!\\)\|/).map((c) => c.trim()));

type Skill = { dir: string; front: Record<string, unknown>; body: string };

/** A skill's frontmatter and body, from its text. */
const parseSkill = (dir: string, text: string): Skill => {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`skills/${dir}/SKILL.md has no frontmatter`);
  return { dir, front: parse(m[1]!) as Record<string, unknown>, body: m[2]! };
};

/**
 * The skills a lane's agent reads from `$KANON` (plan 0006 §4.1), not a person's skills: they
 * drive no `kanon` command, so the person's skills' checks below don't apply to them.
 */
const LANE_SKILLS = ['upstream-finding'];

const ALL_SKILLS: Skill[] = readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => parseSkill(d.name, read(`skills/${d.name}/SKILL.md`)));
const SKILLS: Skill[] = ALL_SKILLS.filter((s) => !LANE_SKILLS.includes(s.dir));
const skill = (dir: string): Skill => {
  const s = ALL_SKILLS.find((x) => x.dir === dir);
  if (!s) throw new Error(`no skill ${dir}`);
  return s;
};

/** Every piece of code a skill shows: its inline code spans and the lines of its fenced blocks. */
const code = (body: string): string[] => {
  const fenced = [...body.matchAll(/^```[a-z]*\n([\s\S]*?)^```$/gm)].flatMap((m) => m[1]!.split('\n'));
  const prose = body.replace(/^```[a-z]*\n[\s\S]*?^```$/gm, '');
  return [...fenced, ...[...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!)];
};

/** Each `kanon <command> [flags]` a skill names: the command, and the flags after it. */
const invocations = (body: string): Array<{ command: string; flags: string[]; text: string }> =>
  code(body).flatMap((c) =>
    [...c.matchAll(/(?:^|\s)kanon ([a-z][a-z-]*)((?:\s+[^\s]+)*)/g)].map((m) => ({
      command: m[1]!,
      flags: [...(m[2] ?? '').matchAll(/(?:^|\s)(--[a-z][a-z-]*)/g)].map((f) => f[1]!),
      text: c,
    })),
  );

/** The commands `cli/kanon.mjs` dispatches. */
const COMMANDS = new Set([...read('cli/kanon.mjs').matchAll(/command === '([a-z]+)'/g)].map((m) => m[1]!));

/**
 * The flags a command's parser takes: each it compares an argument against, less one whose
 * branch only throws, such as `init`'s `--owner`, refused with a hint at `--project-owner`.
 */
const flagsOf = (command: string): Set<string> => {
  const source = read(`cli/${command}.mjs`);
  const refused = new Set([...source.matchAll(/flag === '(--[a-z-]+)'\)\s*throw\b/g)].map((m) => m[1]!));
  return new Set([...source.matchAll(/flag === '(--[a-z-]+)'/g)].map((m) => m[1]!).filter((f) => !refused.has(f)));
};

/** The JSON contract each command's page documents. */
const CONTRACT = {
  init: { page: 'docs/init.md', schema: INIT_SCHEMA },
  doctor: { page: 'docs/doctor.md', schema: DOCTOR_SCHEMA },
} as const;
type Command = keyof typeof CONTRACT;

/** The command whose JSON a skill reads: the one contract it names. */
const contractOf = (s: Skill): Command => {
  const named = (Object.keys(CONTRACT) as Command[]).filter((c) => s.body.includes(`\`${CONTRACT[c].schema}\``));
  if (named.length !== 1) throw new Error(`skills/${s.dir} names ${named.length} JSON contracts, not one`);
  return named[0]!;
};

/** The finding ids a command's page documents, from its finding table. */
const documentedIds = (command: Command): string[] => {
  const page = read(CONTRACT[command].page);
  const table = command === 'init' ? section(page, /^### The findings$/) : section(page, /^### The finding ids$/);
  if (!table) throw new Error(`${CONTRACT[command].page} has no finding table`);
  return rows(table).map((c) => /^`([a-z-]+\.[a-z-]+)`$/.exec(c[0]!)?.[1]).filter((x): x is string => !!x).sort();
};

/** A documented table of fields: each field's name and its Meaning cell. */
const fieldTable = (page: string, heading: string): Map<string, string> => {
  const body = section(read(page), new RegExp(`^### ${heading}$`));
  if (!body) throw new Error(`${page} has no "### ${heading}"`);
  // The first table only: a section may follow its fields with a status table.
  const first = body.split(/\n\s*\n/).find((p) => p.trimStart().startsWith('|')) ?? '';
  return new Map(rows(first).flatMap((c) => {
    const name = /^`([a-zA-Z]+)`$/.exec(c[0]!)?.[1];
    return name ? [[name, c.at(-1)!] as [string, string]] : [];
  }));
};

/**
 * The error document every command prints when it can't run (docs/cli-json.md): its one field
 * that no command's own table lists, `error`, is read by every skill.
 */
const ERROR_FIELDS = (() => {
  const doc = /the document is `\{ ([^`]+) \}`/.exec(read('docs/cli-json.md'))?.[1];
  if (!doc) throw new Error('docs/cli-json.md no longer spells the error document');
  return [...doc.matchAll(/(?<!: )"([a-zA-Z]+)"/g)].map((m) => m[1]!);
})();
const withError = (top: Map<string, string>): Map<string, string> =>
  new Map([...top, ...ERROR_FIELDS.filter((f) => !top.has(f)).map((f) => [f, 'the error document (docs/cli-json.md)'] as [string, string])]);

/**
 * The fields of each command's document, and the tables of its nested objects. A finding has
 * one shape in every command (docs/cli-json.md), documented as a table in docs/doctor.md.
 */
const SHAPES: Record<Command, { top: Map<string, string>; nested: Record<string, Map<string, string>> }> = {
  doctor: {
    top: withError(fieldTable('docs/doctor.md', 'The document')),
    nested: {
      findings: fieldTable('docs/doctor.md', 'A finding'),
      fix: fieldTable('docs/doctor.md', 'A fix'),
      idTokenHolders: fieldTable('docs/doctor.md', 'An id-token holder'),
      waived: fieldTable('docs/doctor.md', 'A waived finding'),
    },
  },
  init: {
    top: withError(fieldTable('docs/init.md', 'The document')),
    nested: {
      inspection: fieldTable('docs/init.md', 'The inspection'),
      answers: fieldTable('docs/init.md', 'The answers'),
      catalogue: fieldTable('docs/init.md', 'The lane catalogue'),
      lanes: fieldTable('docs/init.md', 'A catalogue lane'),
      files: fieldTable('docs/init.md', 'A file'),
      changes: fieldTable('docs/init.md', 'A change'),
      apps: fieldTable('docs/init.md', 'The Apps'),
      findings: fieldTable('docs/doctor.md', 'A finding'),
      fix: fieldTable('docs/doctor.md', 'A fix'),
    },
  },
};

/**
 * Whether a path such as `.findings[].fix.commands` names a documented field. Each segment is a
 * field of its parent's table, or, for an object documented in one row (`.token.login`), a name
 * that row's Meaning cell spells in backticks.
 */
const resolves = (command: Command, path: string): boolean => {
  const { top, nested } = SHAPES[command];
  let table: Map<string, string> | null = top;
  let meaning = '';
  for (const seg of path.slice(1).split('.').map((s) => s.replace(/\[\]$/, ''))) {
    if (table) {
      if (!table.has(seg)) return false;
      meaning = table.get(seg)!;
    } else if (!meaning.includes(`\`${seg}\``)) return false;
    table = nested[seg] ?? null;
  }
  return true;
};

/** The JSON paths a skill reads: code spans that are only a path, such as `.answers.lanes`. */
const PATH = /^\.[a-zA-Z]+(?:\[\])?(?:\.[a-zA-Z]+(?:\[\])?)*$/;
const paths = (body: string): string[] => [...new Set(code(body).filter((c) => PATH.test(c)))];

/** A status table's (status, exit code) pairs, in either column order. */
const statusPairs = (text: string): string[] =>
  rows(text).flatMap((c) => {
    const s = c.findIndex((x) => /^`[a-z-]+`$/.test(x));
    const k = c.findIndex((x) => /^\d( or \d)?$/.test(x));
    return s >= 0 && k >= 0 && Math.abs(s - k) === 1 ? [`${c[s]!.slice(1, -1)}=${c[k]}`] : [];
  }).sort();

describe('the plugin that ships the skills (docs/skills.md)', () => {
  it('is the kanon plugin, from the marketplace at the repository root', () => {
    expect((JSON.parse(read('.claude-plugin/plugin.json')) as { name: string }).name).toBe('kanon');
    const market = JSON.parse(read('.claude-plugin/marketplace.json')) as { name: string; plugins: Array<{ name: string; source: string }> };
    expect(market.name).toBe('kanon');
    expect(market.plugins.map((p) => [p.name, p.source])).toEqual([['kanon', './']]);
  });

  // The marketplace's source is `./`, so the repository's root is the plugin's root, and Claude
  // Code loads every component it finds there into each adopter's session. Only `skills/` may
  // be one: a top-level `hooks/` or `.mcp.json` added later for Kanon's own use would otherwise
  // ship to every adopter's agent unannounced (kanon#374 review). The manifest may not point
  // at components elsewhere either.
  it('ships only skills/: no other plugin component exists at the root, and the manifest adds none', () => {
    const COMPONENTS = ['commands', 'agents', 'hooks', 'output-styles', 'monitors', 'bin', '.mcp.json', '.lsp.json', 'settings.json'];
    const root = new Set(readdirSync(ROOT));
    expect(COMPONENTS.filter((c) => root.has(c))).toEqual([]);
    const manifest = JSON.parse(read('.claude-plugin/plugin.json')) as Record<string, unknown>;
    expect(Object.keys(manifest).sort()).toEqual(['author', 'description', 'homepage', 'license', 'name', 'repository', 'version']);
    expect(readdirSync(join(ROOT, '.claude-plugin')).sort()).toEqual(['marketplace.json', 'plugin.json']);
  });

  it('has the skills docs/skills.md lists, and only those', () => {
    const listed = [...read('docs/skills.md').matchAll(/^\| \[([a-z-]+)\]\(\.\.\/skills\/([a-z-]+)\/SKILL\.md\) \| `\/kanon:([a-z-]+)`/gm)];
    for (const m of listed) expect(new Set([m[1], m[2], m[3]]).size, m[0]).toBe(1);
    expect(listed.map((m) => m[1]).sort()).toEqual(SKILLS.map((s) => s.dir).sort());
    expect(SKILLS.map((s) => s.dir).sort()).toEqual(['adopt', 'doctor', 'upgrade']);
    // The lanes' skills are listed apart, as files a lane reads, never as a `/kanon:` command.
    const lanes = section(read('docs/skills.md'), /^## The lanes' skill$/);
    expect(lanes).not.toBeNull();
    const named = [...lanes!.matchAll(/\[([a-z-]+)\]\(\.\.\/skills\/([a-z-]+)\/SKILL\.md\)/g)];
    for (const m of named) expect(m[1], m[0]).toBe(m[2]);
    expect(named.map((m) => m[1]).sort()).toEqual([...LANE_SKILLS].sort());
    expect(lanes).not.toMatch(/\/kanon:/);
  });

  it("names each skill by its directory, describes it, and lets only doctor start without being asked", () => {
    for (const s of ALL_SKILLS) {
      expect(s.front.name, s.dir).toBe(s.dir);
      expect(String(s.front.name)).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
      expect(typeof s.front.description, s.dir).toBe('string');
      expect(String(s.front.description).length, s.dir).toBeGreaterThan(80);
      // Claude Code truncates a skill's description at 1,536 characters in its listing.
      expect(String(s.front.description).length, s.dir).toBeLessThanOrEqual(1536);
      // adopt and upgrade change the repository, so a person starts them (docs/skills.md).
      expect(s.front['disable-model-invocation'] === true, s.dir).toBe(s.dir !== 'doctor');
      // A lane's skill is read by its path, so it is no command in the person's menu either.
      expect(s.front['user-invocable'] === false, s.dir).toBe(LANE_SKILLS.includes(s.dir));
    }
  });

  // #626: a person who asked their agent to "install Kanon" got an agent that couldn't, and
  // nothing they read said why. Each skill the agent can't start, but the person can, is named
  // in docs/skills.md as one only the person starts, with why, and the README says to type it.
  it('says which skills only the person can start, why, and that asking the agent will not', () => {
    const typed = ALL_SKILLS.filter((s) => s.front['disable-model-invocation'] === true && s.front['user-invocable'] !== false).map((s) => s.dir);
    expect(typed.sort()).toEqual(['adopt', 'upgrade']);
    const doc = read('docs/skills.md');
    const para = doc.split('\n\n').find((p) => /\*\*Only you can start\*\*/.test(p));
    expect(para, 'docs/skills.md has no "**Only you can start**" paragraph').toBeDefined();
    const named = [...para!.matchAll(/`\/kanon:([a-z-]+)`/g)].map((m) => m[1]!);
    expect([...new Set(named)].sort()).toEqual(typed.sort());
    expect(para).toMatch(/writes? your repository/);
    expect(para).toMatch(/steps only you can take/);
    expect(para).toMatch(/asking the agent .*won't start/);
    expect(read('README.md')).toMatch(/Type `\/kanon:adopt`/);
  });
});

/**
 * Plan 0006 step F2a (§4.1): the one file both lanes that write to Kanon, the Overseer and the
 * telemetry Explorer, read before they write an upstream finding's `evidence` or
 * `suggested_fix`. Its prompt line is held by each lane's own test; here, that the file has what
 * the plan says it has: the template's five parts, the hard rules, and the self-check.
 */
describe('the upstream-finding skill (plan 0006 §4.1)', () => {
  const s = skill('upstream-finding');

  it('is the one lane skill', () => {
    expect(LANE_SKILLS).toEqual(['upstream-finding']);
    expect(ALL_SKILLS.map((x) => x.dir)).toContain('upstream-finding');
  });

  it('has the template\'s five parts, in order, the fifth written into `suggested_fix`', () => {
    const template = section(s.body, /^## The template$/);
    expect(template).not.toBeNull();
    expect([...template!.matchAll(/^### (.+)$/gm)].map((m) => m[1])).toEqual(['Expected', 'Observed', 'Where', 'Reproduce', 'Suggested fix']);
    const part = (name: string): string => section(template!, new RegExp(`^### ${name}$`))!.trim();
    expect(part('Expected')).toMatch(/`K-…`/);
    expect(part('Observed')).toMatch(/stage/);
    expect(part('Where')).toMatch(/`kanon_version`/);
    expect(part('Reproduce')).toMatch(/trigger/);
    expect(part('Suggested fix')).toMatch(/into `suggested_fix`, never `evidence`/);
    expect(part('Suggested fix')).toMatch(/`K-SELF-10`/);
  });

  it('states the hard rules, with roles instead of names', () => {
    const rules = section(s.body, /^## The hard rules$/);
    expect(rules).not.toBeNull();
    const leads = rules!.split('\n').filter((l) => l.startsWith('- **')).map((l) => /^- (\*\*[^*]+\*\*)/.exec(l)![1]);
    expect(leads).toEqual([
      '**No people, logins or personal names.**',
      '**No repository names.**',
      '**No URLs.**',
      "**No paths outside Kanon's tree.**",
      "**No quotes of the adopter's text,**",
      '**Roles instead.**',
    ]);
    for (const role of ['"the PR"', '"the reviewer"', '"an adopter workflow"', '"the adopter\'s hook"']) expect(rules, role).toContain(role);
  });

  it('ends with the self-check: codes only when it can\'t comply, and the draft says why', () => {
    const check = section(s.body, /^## The self-check$/);
    expect(check).not.toBeNull();
    expect(check).toMatch(/re-read each extract against the hard rules/);
    expect(check).toMatch(/leave `evidence` and `suggested_fix` empty/);
    expect(check).toMatch(/sent as codes only/);
    expect(check).toMatch(/say why/);
  });
});

describe('each skill is held to the kanon command it drives', () => {
  it('names only commands the CLI has, with only flags their parsers take', () => {
    const problems: string[] = [];
    let flags = 0;
    for (const s of SKILLS) {
      const calls = invocations(s.body);
      expect(calls.length, s.dir).toBeGreaterThan(0);
      for (const c of calls) {
        if (!COMMANDS.has(c.command)) {
          problems.push(`skills/${s.dir}: "kanon ${c.command}" is not a command (${c.text})`);
          continue;
        }
        const known = flagsOf(c.command);
        for (const f of c.flags) {
          flags++;
          if (!known.has(f)) problems.push(`skills/${s.dir}: kanon ${c.command} takes no ${f} (${c.text})`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(flags).toBeGreaterThan(15);
  });

  it("passes, as a flag on its own, only flags its command's parser takes", () => {
    // adopt's table of answers names each `init` flag on its own, outside a `kanon init` line.
    const problems: string[] = [];
    let seen = 0;
    for (const s of SKILLS) {
      const known = flagsOf(contractOf(s));
      for (const c of code(s.body).filter((x) => x.startsWith('--'))) {
        const f = /^--[a-z][a-z-]*/.exec(c)![0];
        seen++;
        if (!known.has(f)) problems.push(`skills/${s.dir}: kanon ${contractOf(s)} takes no ${f} (${c})`);
      }
    }
    expect(problems).toEqual([]);
    expect(seen).toBeGreaterThan(10);
  });

  // kanon#428, the Owner's rule: anything that needs the person's input is asked during the
  // installation, as a question with its recommended option and what each option does, never
  // filled in with a default the person didn't see. So every answer in init's contract has a
  // question of its own in the adopt skill, and a new answer without one fails the build here.
  it('asks a question for every answer in kanon init\'s contract, with its recommended option, its options and their flags', () => {
    const questions = section(skill('adopt').body, /^## The questions$/);
    expect(questions).not.toBeNull();
    const blocks = questions!.split(/^(?=### )/m).filter((b) => b.startsWith('### '));
    const asked = new Map(blocks.map((b) => [/^### `\.answers\.([a-zA-Z]+)`: /.exec(b)?.[1] ?? b.split('\n')[0]!, b]));
    expect([...asked.keys()].sort()).toEqual([...SHAPES.init.nested.answers!.keys()].sort());
    for (const [answer, b] of asked) {
      expect(b, answer).toMatch(/^- \*\*Recommended:\*\* \S/m);
      // Each option says what it does: at least two, each with the flag it becomes.
      expect(b, answer).toMatch(/^- \*\*Options:\*\* .*`--[a-z-]+[^`]*`.*\S/m);
    }
    // Every flag that answers a question (docs/init.md) is offered, except --create-apps and
    // --no-apps: adopt passes --no-apps, and walks the person through the Apps itself.
    // Only from the options themselves: a flag named elsewhere in a question is not an option.
    const offered = new Set(blocks.flatMap((b) => [...b.matchAll(/^- \*\*Options\b.*$/gm)].flatMap((l) => [...l[0].matchAll(/`(--[a-z-]+)/g)].map((m) => m[1]!))));
    const answering = rows(section(read('docs/init.md'), /^## Answering without a terminal$/)!)
      .flatMap((c) => [...(c[1] ?? '').matchAll(/`(--[a-z-]+)/g)].map((m) => m[1]!));
    expect(answering.length).toBeGreaterThan(10);
    expect(answering.filter((f) => !offered.has(f))).toEqual(['--create-apps', '--no-apps']);
    // No answer is taken unasked: the steps say so, and the lanes are asked a group at a time,
    // from the catalogue init prints, recommended option first.
    const steps = section(skill('adopt').body, /^## Steps$/)!;
    expect(steps).toMatch(/none is taken from its default unasked/);
    const lanes = asked.get('lanes')!;
    for (const p of ['.catalogue', '.catalogue[].lanes[].does', '.catalogue[].lanes[].cost', '.catalogue[].lanes[].minutes', '.catalogue[].lanes[].when', '.catalogue[].lanes[].recommended', '.catalogue[].lanes[].recommendedWith']) {
      expect(lanes, p).toContain(`\`${p}\``);
    }
    expect(lanes).toMatch(/multi-select/);
  });

  it('asks in Claude Code with its question tool, recommended option first and marked, and never for a list', () => {
    const how = section(skill('adopt').body, /^## How to ask$/)!;
    expect(how).toMatch(/In Claude Code, ask with its question tool\*\* \(`AskUserQuestion`\)/);
    expect(how).toMatch(/recommended option comes first/);
    expect(how).toContain('`(Recommended)`');
    expect(how).toMatch(/In another agent client/);
    expect(how).toMatch(/Never ask for a comma-separated list/);
  });

  it("walks the person through a step only they can do when it comes up, as do it now or skip, and records a skip", () => {
    const person = section(skill('adopt').body, /^## Steps only a person can do$/)!;
    // Both options in the one question the person is asked.
    expect(person).toMatch(/^2\. Ask, as a question: \*\*Do it now\*\* \(Recommended\).*; or \*\*Skip it for now\*\*/m);
    expect(person).toMatch(/skipped list/);
    // The pull request carries what was skipped.
    expect(section(skill('adopt').body, /^## Steps$/)).toMatch(/`## Left to do`/);
  });

  // Plan 0006 §3.2 (kanon#585): where upstream findings go is asked after telemetry, Drafted
  // recommended, Sent to Kanon offered only on a telemetry yes; the evidence question is asked only
  // after Sent to Kanon, says in its own words that the text reaches a third-party decision
  // provider (Owner decision 7), and is init's own question, word for word.
  it('asks where upstream findings go after telemetry, and the evidence question in init\'s words, naming the third-party decision provider', () => {
    const questions = section(skill('adopt').body, /^## The questions$/)!;
    const blocks = questions.split(/^(?=### )/m);
    const at = (answer: string) => blocks.findIndex((b) => b.startsWith(`### \`.answers.${answer}\`: `));
    expect(at('upstreamFindings')).toBe(at('telemetry') + 1);
    expect(at('upstreamEvidence')).toBe(at('upstreamFindings') + 1);
    const where = blocks[at('upstreamFindings')]!;
    expect(where).toMatch(/^- \*\*Recommended:\*\* \*\*Drafted\*\*/m);
    expect(where).toMatch(/\*\*Sent to Kanon\*\* \(`--upstream-findings sent`\).*Offered only when the telemetry answer is yes/);
    expect(where).toMatch(/nothing is ever filed in another repository/);
    const evidence = blocks[at('upstreamEvidence')]!;
    expect(evidence).toMatch(/Asked only after \*\*Sent to Kanon\*\*/);
    expect(evidence).toMatch(/^- \*\*Recommended:\*\* \*\*Codes only\*\*/m);
    expect(evidence).toContain('`--upstream-findings sent-with-evidence`');
    expect(evidence).toContain(`"${UPSTREAM_EVIDENCE_QUESTION}"`);
    expect(evidence).toContain('third-party decision provider');
  });

  // The upgrade skill asks, rather than defaults, any answer a newer release adds.
  it('has the upgrade skill ask any answer the target release adds, as the adopt skill asks it', () => {
    const steps = section(skill('upgrade').body, /^## Steps$/)!;
    expect(steps).toMatch(/\*\*New questions\.\*\*/);
    expect(steps).toMatch(/"The answers"/);
    expect(steps).toMatch(/"The questions"/);
    expect(steps).toMatch(/never tak(e|ing) its default/);
  });

  // kanon#601: `init` never rewrites an adoption record that exists (`kept`, no content), so an
  // answer whose only effect is a bullet there brings no `new` file. The upgrade skill writes the
  // bullet itself, after a yes, or tells the person plainly that it didn't: never drops it.
  it('has the upgrade skill carry a new answer whose only effect is an adoption-record bullet (#601)', () => {
    const steps = section(skill('upgrade').body, /^## Steps$/)!;
    expect(steps).toMatch(/\*\*An answer that lands in a file the repository already has is yours to carry, or to say you didn't\*\*.*`kept`.*`docs\/qa\/adoption\.md`/);
    expect(steps).toMatch(/show the person the bullet as `init` writes it, and write it into the existing record on this branch after a yes/);
    expect(steps).toMatch(/add `## Choices` before `## Data`/);
  });

  it('has the upgrade skill say plainly when it did not carry an answer, in the pull request too (#601)', () => {
    const steps = section(skill('upgrade').body, /^## Steps$/)!;
    expect(steps).toMatch(/\*\*Never drop an answer silently\.\*\*.*tell the person plainly that their answer is not in the repository.*`## Left to do`/);
    expect(steps).toMatch(/\*\*Open the pull request\.\*\*.*under `## Left to do`.*each answer step 5 didn't carry, with the bullet that would carry it/);
    expect(read('docs/skills.md')).toMatch(/the upgrade skill carries each answer a newer release added .*or tells you plainly, and in the pull request's `## Left to do`, that your answer isn't in the repository/);
  });

  // The skill's table of record-only answers names every bold bullet `adoptionFile` can write, read
  // from its source, so a bullet a release adds for a new answer fails here until the skill carries
  // it. The ones left out are not answers: the plan's bullets come from the inspection, and the
  // Overseer's follows the lanes the callers run, which lane-check holds the record to.
  it('lists, in the upgrade skill, every adoption-record bullet init writes from an answer (#601)', () => {
    const steps = section(skill('upgrade').body, /^## Steps$/)!;
    const table = rows(steps).filter((r) => r[0] !== 'Answer' && !/^-+$/.test(r[0]!));
    const init = read('cli/init.mjs');
    const start = init.indexOf('export const adoptionFile = ');
    expect(start).toBeGreaterThan(-1);
    const source = init.slice(start, init.indexOf('\n};\n', start));
    const written = [...source.matchAll(/- \*\*([^*]+):\*\* /g)].map((m) => m[1]!.replace('${UPSTREAM_LABEL}', UPSTREAM_LABEL));
    const notAnswers = ['Rulesets', 'Merge queue', 'Environments', 'Overseer'];
    for (const l of notAnswers) expect(written, l).toContain(l);
    const labels = [...new Set(written)].filter((l) => !notAnswers.includes(l));
    expect(labels).toContain(UPSTREAM_LABEL);
    expect(labels.length).toBeGreaterThanOrEqual(4);
    const documented = new Set([...section(read('docs/init.md'), /^### The answers$/)!.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]!));
    for (const label of labels) {
      const row = table.find((r) => r[2]!.includes(`**${label}:**`));
      expect(row, label).toBeDefined();
      const fields = [...row![1]!.matchAll(/`(\w+)`/g)].map((m) => m[1]!).filter((f) => !/^(true|false|null)$/.test(f));
      expect(fields.length, label).toBeGreaterThan(0);
      for (const f of fields) expect(documented, `${label}: .answers.${f}`).toContain(f);
    }
    expect(table.find((r) => r[2]!.includes(`**${UPSTREAM_LABEL}:**`))![3]).toBe(`\`${UPSTREAM_DEFAULT}\``);
  });

  // K-LAYOUT-10: a record without the bullet means `labelled`, so `labelled` needs no bullet until
  // `every pull request` exists.
  it('has the upgrade skill write no review-trigger bullet for the value a record without it means (#601)', () => {
    const table = rows(section(skill('upgrade').body, /^## Steps$/)!);
    expect(table.find((r) => r[2]!.includes('**Review trigger:**'))![3]).toBe('`labelled`, null');
    expect(read('rulebook/11-repository-layout.md')).toMatch(/\*\*A record without the bullets, or no record, means `custom` and `labelled`\*\*/);
  });

  // An agent's shell has no terminal on standard input, where `kanon init` refuses to start
  // without `--yes` or `--json` (docs/init.md), and without `--no-apps` a write runs `kanon apps`,
  // which opens the person's browser unannounced. So each `kanon init` a skill runs, one with
  // flags, carries `--json`, and each that writes carries `--no-apps` too (kanon#374 review).
  // A bare `kanon init` is the command's name in prose, or a step the person runs themselves.
  it("runs kanon init only as an agent's shell can: with --json, and --no-apps when it writes", () => {
    const problems: string[] = [];
    let seen = 0;
    for (const s of SKILLS) {
      for (const c of invocations(s.body).filter((x) => x.command === 'init' && x.flags.length > 0)) {
        seen++;
        if (!c.flags.includes('--json')) problems.push(`skills/${s.dir}: ${c.text} lacks --json`);
        if (!c.flags.includes('--dry-run') && !c.flags.includes('--no-apps')) problems.push(`skills/${s.dir}: ${c.text} writes without --no-apps`);
      }
    }
    expect(problems).toEqual([]);
    expect(seen).toBeGreaterThanOrEqual(6);
  });

  it('runs kanon through npx from one release, as the command its contract is', () => {
    for (const s of SKILLS) {
      const lines = code(s.body).filter((c) => c.startsWith('npx '));
      expect(lines, s.dir).toHaveLength(1);
      expect(lines[0], s.dir).toMatch(new RegExp(`^npx --yes --package github:yedeya-labs/kanon#v\\d+\\.\\d+\\.\\d+ kanon ${contractOf(s)} `));
    }
  });

  it('names the contract its command prints', () => {
    expect(SKILLS.map((s) => [s.dir, contractOf(s)])).toEqual([['adopt', 'init'], ['doctor', 'doctor'], ['upgrade', 'doctor']]);
    for (const s of SKILLS) expect(s.body).toContain(`**The contract is \`${CONTRACT[contractOf(s)].schema}\`.**`);
  });

  it('lists exactly the finding ids its command documents, each with who fixes it', () => {
    const tables = SKILLS.flatMap((s) => {
      const m = /^## Who fixes each finding of `kanon ([a-z]+)`$/m.exec(s.body);
      return m ? [{ s, command: m[1] as Command, body: section(s.body, new RegExp(`^${m[0].replace(/[`]/g, '.')}$`))! }] : [];
    });
    expect(tables.map((t) => [t.s.dir, t.command])).toEqual([['adopt', 'init'], ['doctor', 'doctor']]);
    for (const t of tables) {
      const listed = rows(t.body).filter((c) => /^`[^`]+`$/.test(c[0]!));
      expect(listed.map((c) => c[0]!.slice(1, -1)).sort(), t.s.dir).toEqual(documentedIds(t.command));
      for (const c of listed) expect(c[1], `${t.s.dir} ${c[0]}`).toMatch(/^(agent|person|decision)(, (agent|person|decision))*$/);
    }
    // upgrade fixes through doctor's table, and says so.
    expect(skill('upgrade').body).toContain("the doctor skill's table");
  });

  // #418, L5's G14: a status check required before a job on the default branch reports it
  // blocks every other open pull request. Doctor asks for the job first; the skills ask for the
  // rule only once the pull request adding the job has merged.
  it('asks the person to require a status check only after the job that reports it has merged', () => {
    const table = rows(section(skill('doctor').body, /^## Who fixes each finding of `kanon doctor`$/)!);
    const row = (id: string) => table.find((c) => c[0] === `\`${id}\``)!;
    expect(row('ruleset.rule-missing')[2]).toMatch(/never ask for a check it didn't name, or before the pull request that adds the check's job has merged/);
    expect(row('ruleset.check-unreported')[1]).toBe('agent, person');
    expect(row('ruleset.check-unreported')[2]).toMatch(/its step comes after that pull request merges/);
    expect(section(skill('upgrade').body, /^## Steps$/)).toMatch(/\*\*Never ask the person to require a status check before this pull request merges\*\*.*`ruleset\.check-unreported`/);
  });

  // #444: init no longer requires the check before a job on the default branch reports it, and
  // the adopt skill hands the rule over as a step for after the adopt pull request merges.
  it('has the adopt skill leave the required check for after its pull request merges', () => {
    const table = rows(section(skill('adopt').body, /^## Who fixes each finding of `kanon init`$/)!);
    const row = table.find((c) => c[0] === '`ruleset.require-check`')!;
    expect(row[1]).toBe('person');
    expect(row[2]).toMatch(/never before/);
    expect(row[2]).toMatch(/`## After merging`/);
    const steps = section(skill('adopt').body, /^## Steps$/)!;
    expect(steps).toMatch(/under `## After merging`, each step that waits for the merge \(`ruleset\.require-check`\)/);
    expect(steps).toMatch(/\*\*Never ask the person to require the `Lane check` status check before this pull request merges\*\*/);
    expect(steps).toMatch(/\*\*Do it now\*\* \(Recommended\) or \*\*Skip it for now\*\*: for `ruleset\.require-check`/);
  });

  // #626: the review lane reviews a pull request only once it carries one of its labels, and
  // the agent told a person installing it that no label was needed. The adopt skill's pull
  // request body and its hand-over say how review starts, with the labels the lane gates on.
  it('has the adopt skill say how review starts: a review label or a dispatch, and never the install pull request', () => {
    const steps = section(skill('adopt').body, /^## Steps$/)!;
    const step = (n: number): string => steps.split('\n').find((l) => l.startsWith(`${n}. `)) ?? '';
    for (const n of [9, 11]) {
      for (const label of REVIEW_LABELS) expect(step(n), `step ${n}: ${label}`).toContain(`\`${label}\``);
      // The Owner, 2026-10-12: the review lane waits for CI itself (its workflow_run on CI's
      // completion reviews a labelled pull request), so the label goes on when the pull request opens.
      expect(step(n), `step ${n}`).toMatch(/`review:please`[^.]*to a pull request when it opens, without waiting for its CI \(the review lane waits for CI itself/);
      expect(step(n), `step ${n}`).not.toMatch(/once its CI has finished/);
      expect(step(n), `step ${n}`).toMatch(/-f pr_number=/);
    }
    expect(step(9)).toMatch(/under `## After merging`[^.]*how review starts/);
    expect(step(9)).toMatch(/this pull request itself is never reviewed/);
    expect(step(11)).toMatch(/never that no label is needed/);
  });

  // #652: with the installations unlisted, a sibling register naming some Apps says nothing of the
  // rest, so the adopt skill asks about each App init couldn't look for, not only when ownerApps is null.
  it('has the adopt skill ask about each App init could not look for, whatever ownerApps holds', () => {
    const body = skill('adopt').body;
    const reuse = section(body, /^### `\.answers\.reuseApps`: reuse an App the owner already has$/)!;
    const steps = section(body, /^## Steps$/)!;
    const step7 = steps.split('\n').find((l) => l.startsWith('7. ')) ?? '';
    for (const [where, text] of [['reuseApps', reuse], ['step 7', step7]] as const) {
      expect(text, where).toContain('`.inspection.appsNotLookedFor`');
      expect(text, where).not.toMatch(/When `\.inspection\.ownerApps` is null/);
    }
    expect(reuse).toMatch(/For each of them that a chosen lane runs as/);
    expect(step7).toMatch(/for each such App by name, \*\*Does the owner already have the <App> App for another repository\?\*\*/);
  });

  // #419, L5's G4, G11, G12 and G14: the steps that can only happen once the upgrade has merged
  // are kept in a list the person is handed, each with who does it, when, and what to run.
  it('keeps a post-merge checklist in the upgrade skill, built from doctor findings that exist', () => {
    const after = section(skill('upgrade').body, /^## After the merge$/);
    expect(after).not.toBeNull();
    const table = rows(after!).filter((c) => c.length === 4 && !/^-+$/.test(c[0]!) && c[0] !== 'Step');
    const ids = table.map((c) => /^`([a-z-]+\.[a-z-]+)`$/.exec(c[0]!)?.[1]).filter((x): x is string => !!x);
    // Every finding id it names is one doctor documents: a renamed id fails here.
    const documented = documentedIds('doctor');
    expect(ids.filter((id) => !documented.includes(id))).toEqual([]);
    for (const id of ['ruleset.check-unreported', 'ruleset.bypass-extra', 'app.unused', 'secret.stale']) expect(ids, id).toContain(id);
    for (const c of table) {
      expect(c[1], c[0]).toMatch(/^(agent|person|decision)(, (agent|person|decision))*$/);
      expect(c[2], c[0]).toMatch(/merge|week|chooses/);
      expect(c[3]!.length, c[0]).toBeGreaterThan(40);
    }
    // apps-check is plan 0005 L5's acceptance, and the live checks follow it.
    expect(after).toContain('`gh workflow run apps-check.yml -R <owner>/<repo>`');
    expect(after).toMatch(/Judge's App/);
    // Requiring a check waits for the merge, and app.unused for a week of green runs.
    expect(table.find((c) => c[0] === '`ruleset.check-unreported`')![2]).toMatch(/^On merge/);
    expect(table.find((c) => c[0] === '`app.unused`')![2]).toMatch(/week/);
    // Handed over in the pull request's body, walked through as the person's steps, and found again.
    const steps = section(skill('upgrade').body, /^## Steps$/)!;
    expect(steps).toMatch(/under `## After merging`/);
    expect(steps).toMatch(/\*\*Hand over what waits for the merge\.\*\*/);
    expect(after).toMatch(/\*\*Do it now\*\* \(Recommended\) or \*\*Skip it for now\*\*/);
    expect(after).toMatch(/To get the list again/);
    expect(section(skill('doctor').body, /^## Steps$/)).toMatch(/under `## After merging`/);
  });

  // #420, L5's G8 and G10: an agent client refused to run kanon apps (it creates Apps and writes
  // secrets), and the person's first run stopped at the token's pre-check. So the skills say up
  // front that it is the person's step, check the token first, and give the exact `!` line.
  it("hands kanon apps to the person: the token checked first, then the exact ! line", () => {
    for (const dir of ['adopt', 'doctor']) {
      const s = skill(dir);
      const run = section(s.body, /^## Running `kanon apps`$/);
      expect(run, dir).not.toBeNull();
      expect(run, dir).toMatch(/\*\*it is the person's step,\*\*/);
      expect(invocations(run!).some((c) => c.command === 'apps' && c.flags.includes('--preflight')), dir).toBe(true);
      expect(run, dir).toContain('**Secrets: read and write**');
      const line = code(run!).find((c) => c.startsWith('! cd '));
      expect(line, dir).toMatch(/^! cd <the checkout's root> && npx --yes --package github:yedeya-labs\/kanon#v\d+\.\d+\.\d+ kanon apps --owner <owner> --repo <repo> --apps <apps>$/);
      expect(run, dir).toMatch(/\*\*Do it now\*\* \(Recommended\).*\*\*Skip it for now\*\*/);
      // #382: for the Releaser, kanon apps also edits the default branch's rulesets (setReleaserBypass),
      // so the person is told before they run it, not only by docs/apps.md.
      expect(run, dir).toMatch(/\*\*Say what else it changes, before they run it\.\*\*[^\n]*Releaser[^\n]*bypass list[^\n]*for pull requests only[^\n]*`K-MERGE-8`/);
      // Every finding whose fix is a kanon apps command sends the agent to that section, and none
      // tells the agent to run it itself.
      const table = rows(section(s.body, /^## Who fixes each finding of `kanon [a-z]+`$/)!);
      for (const c of table.filter((x) => /`kanon apps(?: --[a-z-]+)?` command|`kanon apps --/.test(x[2] ?? ''))) expect(c[2], `${dir} ${c[0]}`).toContain('"Running `kanon apps`"');
      expect(s.body, dir).not.toMatch(/(?:you )?run (?:the fix's|the finding's) `kanon apps`/i);
      // Where it says how to read a fix's commands, a `kanon apps` one is the person's, and only
      // other `kanon` commands are the agent's to run (#445 review).
      expect(s.body, dir).toMatch(/that starts `kanon apps` is the person's \("Running `kanon apps`"/);
      expect(s.body, dir).not.toMatch(/(?:a command|one) that starts `kanon ` you run/);
    }
    expect(section(skill('upgrade').body, /^## Steps$/)).toMatch(/\*\*Say up front that each `kanon apps` command a fix names is the person's step\*\*.*"Running `kanon apps`"/);
  });

  // #625: the skills show `!` for the person's own commands, and with `!` at the Claude Code
  // prompt standard input isn't a terminal, so a `gh secret set` that reads the value there stores
  // an empty secret without a word. A value that isn't secret goes with `--body`; a real secret,
  // to the person's own terminal or a file, and never with `!`.
  it('hands gh secret set over without `!` for a real secret, and with `--body` for a value that isn\'t one (#625)', () => {
    for (const dir of ['adopt', 'doctor']) {
      const s = skill(dir).body;
      const run = section(s, /^## Running `gh secret set`$/);
      expect(run, dir).not.toBeNull();
      expect(run, dir).toMatch(/\*\*Never with `!` at the Claude Code prompt\*\*[^\n]*standard input isn't a terminal[^\n]*stores an \*\*empty\*\* secret/);
      expect(run, dir).toMatch(/\*\*A value that isn't secret,\*\* such as an App's id[^\n]*`… --body <value>`[^\n]*works with `!`/);
      expect(run, dir).toMatch(/\*\*A real secret,\*\* such as a private key, `CLAUDE_CODE_OAUTH_TOKEN` or a webhook's URL[^\n]*in their own terminal, without the `!`/);
      expect(code(run!), dir).toContain('gh secret set <NAME> -R <owner>/<repo> < <file>');
      expect(run, dir).toContain('`kanon apps --reuse`');
      // Where the skill says how to read a fix's commands, a `gh secret set` one goes through it,
      // and nothing still sends the value to standard input unqualified.
      expect(s, dir).toMatch(/one that starts `gh secret set` is the person's \("Running `gh secret set`"/);
      expect(s, dir).not.toMatch(/pasting the value on standard input|paste the value on standard input/);
    }
  });

  // #406, the Owner's 2026-10-07 decision: a waiver of a finding that lists items names them, or
  // is malformed. The skills show which bullet waives which items, write waivers that name them,
  // and the upgrade rewrites an old item-less one before or with the move.
  it('names the items of a waiver, and has the upgrade rewrite one that names none', () => {
    const doctor = skill('doctor').body;
    expect(section(doctor, /^## Steps$/)).toMatch(/`\.waived\[\]\.items`.*`\.waived\[\]\.line`/);
    const waiving = section(doctor, /^## Waiving a finding$/)!;
    expect(waiving).toMatch(/after `for`/);
    expect(waiving).toMatch(/names no items is malformed and waives nothing/);
    expect(waiving).toMatch(/bullets of their own, each with its reason; no item in two/);
    expect(code(waiving).some((c) => / for `[^`]+` \(/.test(c)) || /\*\*Waived doctor finding:\*\* `[^`]+` on `[^`]+` for `/.test(waiving)).toBe(true);
    const malformed = rows(section(doctor, /^## Who fixes each finding of `kanon doctor`$/)!).find((r) => r[0] === '`declaration.malformed`')!;
    expect(malformed[2]).toMatch(/names no items, the fix's bullet names every item doctor reports there today/);
    expect(section(skill('upgrade').body, /^## Steps$/)).toMatch(/\*\*Rewrite a waiver that names no items, before or with this upgrade:\*\*.*`declaration\.malformed`/);
  });

  it('offers the Releaser to a repository that calls the release workflow without it, as the person\'s choice', () => {
    const offer = section(skill('doctor').body, /^## Offering the Releaser$/);
    expect(offer).not.toBeNull();
    expect(offer).toContain('`.apps[].identity` lists no `releaser`');
    expect(offer).toMatch(/It is the person's choice/);
    expect(invocations(offer!).some((c) => c.command === 'apps' && c.text.includes('--apps releaser'))).toBe(true);
    for (const n of ['RELEASER_APP_ID', 'RELEASER_APP_PRIVATE_KEY']) expect(offer).toContain(`\`${n}\``);
    expect(section(skill('upgrade').body, /^## Steps$/)).toContain('"Offering the Releaser"');
  });

  it('reads only fields its command documents', () => {
    const problems: string[] = [];
    let seen = 0;
    for (const s of SKILLS) {
      for (const p of paths(s.body)) {
        seen++;
        if (!resolves(contractOf(s), p)) problems.push(`skills/${s.dir}: ${p} is not a field of ${CONTRACT[contractOf(s)].page}`);
      }
    }
    expect(problems).toEqual([]);
    expect(seen).toBeGreaterThan(40);
  });

  it('handles exactly the statuses and exit codes its command documents', () => {
    for (const s of SKILLS.filter((x) => x.dir !== 'upgrade')) {
      const page = read(CONTRACT[contractOf(s)].page);
      const documented = contractOf(s) === 'doctor' ? section(page, /^## Exit codes$/)! : section(page, /^### The document$/)!;
      const handled = statusPairs(s.body);
      expect(handled.length, s.dir).toBeGreaterThanOrEqual(4);
      expect(handled, s.dir).toEqual(statusPairs(documented));
    }
  });

  it('states what it never does, and what only a person can do', () => {
    for (const s of SKILLS) {
      const rules = section(s.body, /^## Ground rules$/);
      expect(rules, s.dir).not.toBeNull();
      for (const lead of ['**Never merge.**', '**Never print a secret.**', '**Only a person can**', '**The person signs off.**']) {
        expect(rules!.split('\n').some((l) => l.startsWith(`- ${lead}`)), `${s.dir}: ${lead}`).toBe(true);
      }
    }
  });
});

/**
 * #630, the first timed install: the session's `GH_TOKEN` was another organisation's, and `gh`
 * prefers it to its stored login, so every call ran as the wrong token until the person noticed;
 * and `gh pr checks` failed on the person's fine-grained token, which can't read check runs. So
 * the skills name the token and ask before anything is written, the person's steps read runs
 * through Actions, and one place lists what a person's fine-grained token needs and can't do.
 */
describe("the person's token (#630)", () => {
  const PERSONS_TOKEN = /^### A person's fine-grained token$/;

  it('has the adopt and doctor skills name the token gh uses, and ask, before their first question', () => {
    for (const dir of ['adopt', 'doctor']) {
      const body = skill(dir).body;
      const confirm = section(body, /^## Confirming the token$/);
      expect(confirm, dir).not.toBeNull();
      // Which token, and whose, from the document: never the token itself.
      expect(confirm, dir).toContain('`.token.source`');
      expect(confirm, dir).toContain('`.token.login`');
      expect(confirm, dir).toMatch(/`GH_TOKEN`, then `GITHUB_TOKEN`, then its stored login/);
      // Asked before the first question and before anything is written, as a question.
      expect(confirm, dir).toMatch(/\*\*before your first question, and before anything is written,\*\*/);
      expect(confirm, dir).toMatch(/\*\*Use it\*\* \(Recommended\)[^\n]*\*\*Not this one\*\*/);
      // A wrong token is the person's to change, in their own terminal, then start again.
      expect(confirm, dir).toMatch(/a step only a person can do/);
      expect(confirm, dir).toMatch(/set `GH_TOKEN`[^\n]*in their own terminal[^\n]*`unset GH_TOKEN`[^\n]*start this session again/);
      expect(confirm, dir).toMatch(/Never set `GH_TOKEN` yourself/);
      // And what the token needs, in the one place that lists it.
      expect(confirm, dir).toContain('"A person\'s fine-grained token"');
      // The first run's steps send the agent there before going on.
      const steps = section(body, /^## Steps$/)!;
      expect(steps, dir).toContain('"Confirming the token"');
    }
    // Adopt asks it in step 2, after the read-only dry run and before the questions of step 3,
    // and before the admin question in the same step.
    const steps = section(skill('adopt').body, /^## Steps$/)!;
    const at = steps.indexOf('"Confirming the token"');
    expect(at).toBeGreaterThan(steps.indexOf('2. **Inspect, changing nothing.**'));
    expect(at).toBeLessThan(steps.indexOf('If `.inspection.admin` is false'));
    expect(at).toBeLessThan(steps.indexOf('3. **Ask the questions**'));
    // Doctor asks it on its first run, before it explains or changes anything.
    const doctor = section(skill('doctor').body, /^## Steps$/)!;
    expect(doctor.indexOf('"Confirming the token"')).toBeLessThan(doctor.indexOf('2. **Say what it checked.**'));
    // The upgrade, which runs doctor first, confirms it before it writes the branch.
    const upgrade = section(skill('upgrade').body, /^## Steps$/)!;
    expect(upgrade.indexOf('"Confirming the token"')).toBeGreaterThan(-1);
    expect(upgrade.indexOf('"Confirming the token"')).toBeLessThan(upgrade.indexOf('4. **Bump every pin.**'));
  });

  it("keeps the person's steps off gh pr checks and statusCheckRollup, which a fine-grained token can't read", () => {
    const docs = readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`);
    const files = [...SKILLS.map((s) => `skills/${s.dir}/SKILL.md`), ...docs];
    const problems: string[] = [];
    for (const f of files) {
      for (const para of read(f).split(/\n\s*\n/)) {
        if (!/gh pr checks|statusCheckRollup/.test(para)) continue;
        // Named only where it says plainly that it needs a classic token, or a fine-grained one can't.
        if (/classic token|fine-grained (?:personal access )?token can't/.test(para)) continue;
        problems.push(`${f}: ${para.slice(0, 80)}`);
      }
    }
    expect(problems).toEqual([]);
    // The upgrade's live checks read the runs through Actions, and the verdict through the reviews.
    const live = rows(section(skill('upgrade').body, /^## After the merge$/)!).find((r) => r[0] === 'The live checks')!;
    expect(live[3]).toContain('`gh run list --commit <sha> -R <owner>/<repo>`');
    expect(live[3]).toContain('`gh run view <id> -R <owner>/<repo>`');
    expect(live[3]).not.toMatch(/with `gh pr checks/);
    expect(live[3]).toMatch(/Not `gh pr checks`/);
  });

  it("lists in one place what a person's fine-grained token needs for adopt, doctor and upgrade, and what it can't read", () => {
    const doctor = read('docs/doctor.md');
    const token = section(doctor, /^## The token it needs$/)!;
    const one = section(doctor, PERSONS_TOKEN);
    expect(one).not.toBeNull();
    expect(token, 'under "The token it needs"').toContain(one!);
    // One row per skill, each naming repository permissions by GitHub's names.
    const table = rows(one!).filter((r) => r.length >= 2 && !/^-+$/.test(r[0]!) && r[0] !== 'Skill');
    for (const s of ['adopt', 'doctor', 'upgrade']) {
      const row = table.find((r) => r[0]!.includes(`\`${s}\``));
      expect(row, s).toBeDefined();
      expect(row![1], s).toMatch(/Metadata: read/);
    }
    expect(table.find((r) => r[0]!.includes('`adopt`'))![1]).toMatch(/Secrets: read and write[\s\S]*Administration: read and write[\s\S]*Workflows: read and write/);
    expect(table.find((r) => r[0]!.includes('`upgrade`'))![1]).toMatch(/Actions: read and write/);
    // Doctor lists the variables (`gh variable list`), and the upgrade deletes them after the merge.
    expect(table.find((r) => r[0]!.includes('`doctor`'))![1]).toMatch(/Variables: read/);
    expect(table.find((r) => r[0]!.includes('`upgrade`'))![1]).toMatch(/Variables: read and write[^;|]*`qa-store\.variables`/);
    // The reads it can't do: check runs, so `gh pr checks` and doctor's two annotation checks.
    const cant = section(doctor, /^#### What it can't read$/);
    expect(cant).not.toBeNull();
    expect(one).toContain(cant!);
    for (const t of ['`gh pr checks`', '`gh pr view --json statusCheckRollup`', '`unreachable-runs`', '`telemetry-runs`', '`gh run list --commit <sha>`']) expect(cant, t).toContain(t);
    // The permissions table no longer asks a fine-grained token for a permission it can't hold.
    for (const check of ['unreachable-runs', 'telemetry-runs']) {
      const row = rows(token).find((r) => r[0] === `\`${check}\``)!;
      expect(row[2], check).toMatch(/classic token/);
      expect(row[2], check).toMatch(/on a private repository/);
    }
    // telemetry-runs reads every job's annotations of the last finished run, not a failed one's.
    expect(rows(token).find((r) => r[0] === '`telemetry-runs`')![2]).toMatch(/every job's annotations, whatever the run's conclusion/);
    // A public repository's check runs answer any token, which is how Kanon's own reaches 0.
    expect(cant).toMatch(/On a public repository[^\n]*any token[^\n]*on a private one such a token can't read them/);
    expect(cant).not.toMatch(/when a run failed/);
    const healthy = token.split(/\n\s*\n/).find((p) => p.startsWith('**A healthy Kanon reaches 0**'))!;
    expect(healthy).toMatch(/Kanon's repository is public/);
    expect(healthy).toMatch(/On a private repository with a telemetry caller[^\n]*`telemetry-runs` stays `unchecked`/);
    // docs/init.md lists init's own needs and points to the one place, rather than a second list.
    const init = section(read('docs/init.md'), /^## The token it needs$/);
    expect(init).not.toBeNull();
    expect(init).toContain('(doctor.md#a-persons-fine-grained-token)');
    expect(init).toMatch(/`GH_TOKEN`, `GITHUB_TOKEN` or `gh`'s own login/);
    for (const p of ['Issues: write', 'Administration: write', 'Secrets: read']) expect(init, p).toContain(p);
  });

  it("names the classic token in doctor's reason for a run's annotations it couldn't read", () => {
    const src = read('cli/doctor.mjs');
    const reasons = [...src.matchAll(/reason: `the token can't read the jobs or annotations of its run \$\{id\}; ([^`]+)`/g)].map((m) => m[1]!);
    expect(reasons).toHaveLength(2);
    for (const r of reasons) expect(r).toMatch(/fine-grained personal access token has no Checks permission, so on a private repository/);
  });
});
