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
    for (const p of ['.catalogue', '.catalogue[].lanes[].does', '.catalogue[].lanes[].cost', '.catalogue[].lanes[].when', '.catalogue[].lanes[].recommended', '.catalogue[].lanes[].recommendedWith']) {
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

  // The upgrade skill asks, rather than defaults, any answer a newer release adds.
  it('has the upgrade skill ask any answer the target release adds, as the adopt skill asks it', () => {
    const steps = section(skill('upgrade').body, /^## Steps$/)!;
    expect(steps).toMatch(/\*\*New questions\.\*\*/);
    expect(steps).toMatch(/"The answers"/);
    expect(steps).toMatch(/"The questions"/);
    expect(steps).toMatch(/never tak(e|ing) its default/);
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
