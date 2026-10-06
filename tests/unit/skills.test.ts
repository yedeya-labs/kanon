import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { SCHEMA as DOCTOR_SCHEMA } from '../../cli/doctor.mjs';
import { SCHEMA as INIT_SCHEMA } from '../../cli/init.mjs';

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

const SKILLS: Skill[] = readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    const text = read(`skills/${d.name}/SKILL.md`);
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    if (!m) throw new Error(`skills/${d.name}/SKILL.md has no frontmatter`);
    return { dir: d.name, front: parse(m[1]!) as Record<string, unknown>, body: m[2]! };
  });
const skill = (dir: string): Skill => {
  const s = SKILLS.find((x) => x.dir === dir);
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
  const first = body.split(/\n\n(?=[^|])/).find((p) => p.trimStart().startsWith('|')) ?? '';
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
    },
  },
  init: {
    top: withError(fieldTable('docs/init.md', 'The document')),
    nested: {
      inspection: fieldTable('docs/init.md', 'The inspection'),
      answers: fieldTable('docs/init.md', 'The answers'),
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

  it('has the skills docs/skills.md lists, and only those', () => {
    const listed = [...read('docs/skills.md').matchAll(/^\| \[([a-z-]+)\]\(\.\.\/skills\/([a-z-]+)\/SKILL\.md\) \| `\/kanon:([a-z-]+)`/gm)];
    for (const m of listed) expect(new Set([m[1], m[2], m[3]]).size, m[0]).toBe(1);
    expect(listed.map((m) => m[1]).sort()).toEqual(SKILLS.map((s) => s.dir).sort());
    expect(SKILLS.map((s) => s.dir).sort()).toEqual(['adopt', 'doctor', 'upgrade']);
  });

  it("names each skill by its directory, describes it, and lets only doctor start without being asked", () => {
    for (const s of SKILLS) {
      expect(s.front.name, s.dir).toBe(s.dir);
      expect(String(s.front.name)).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
      expect(typeof s.front.description, s.dir).toBe('string');
      expect(String(s.front.description).length, s.dir).toBeGreaterThan(80);
      // Claude Code truncates a skill's description at 1,536 characters in its listing.
      expect(String(s.front.description).length, s.dir).toBeLessThanOrEqual(1536);
      // adopt and upgrade change the repository, so a person starts them (docs/skills.md).
      expect(s.front['disable-model-invocation'] === true, s.dir).toBe(s.dir !== 'doctor');
    }
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

  it("asks every question kanon init has an answer for, with its flags", () => {
    const table = rows(section(skill('adopt').body, /^## Steps$/)!).filter((c) => /^`\.answers\.[a-zA-Z]+`$/.test(c[0]!));
    const asked = table.map((c) => c[0]!.slice('`.answers.'.length, -1)).sort();
    expect(asked).toEqual([...SHAPES.init.nested.answers!.keys()].sort());
    // Every flag that answers a question (docs/init.md) is offered, except --create-apps:
    // adopt passes --no-apps, and runs the Apps' step itself.
    const offered = new Set(table.flatMap((c) => [...c[1]!.matchAll(/`(--[a-z-]+)/g)].map((m) => m[1]!)));
    const answering = rows(section(read('docs/init.md'), /^## Answering without a terminal$/)!)
      .flatMap((c) => [...(c[1] ?? '').matchAll(/`(--[a-z-]+)/g)].map((m) => m[1]!));
    expect(answering.length).toBeGreaterThan(10);
    expect(answering.filter((f) => !offered.has(f))).toEqual(['--create-apps', '--no-apps']);
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
