import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { SECTIONS as EXCERPTED } from '../../scripts/playbook-excerpt.mjs';

/**
 * What an adopter copies into a lane caller comes from docs/lanes.md, not from the lane's
 * source: its role's secrets, the permissions it grants, and the project documents it
 * needs. The first adopter set up from the docs alone had to read the lanes and a fixture
 * for all three, and found that the README listed half the shipped lanes. So the docs carry
 * them, and this file holds the docs to the lanes:
 *
 *   1. docs/lanes.md's lane-contract table has one row per lane, and each row's secrets,
 *      permissions and documents are exactly what the lane declares and reads;
 *   2. the README's lane row names every shipped lane;
 *   3. every playbook section a lane prompt sends the agent to by name is one that
 *      `K-LAYOUT-17` tells the adopter to write.
 */

const ROOT = process.cwd();
const WORKFLOWS = join(ROOT, '.github/workflows');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

type Perms = Record<string, string>;
type Lane = { on: { workflow_call?: { secrets?: Record<string, unknown> } }; permissions?: Perms; jobs: Record<string, { permissions?: Perms }> };

/** A lane is an `agent-*.yml` reusable workflow; the spine, `agent-lane.yml`, is not one. */
const LANES = readdirSync(WORKFLOWS)
  .filter((f) => /^agent-.*\.yml$/.test(f) && f !== 'agent-lane.yml')
  .filter((f) => (parse(readFileSync(join(WORKFLOWS, f), 'utf8')) as Lane).on?.workflow_call !== undefined)
  .sort();

const lane = (file: string): Lane => parse(readFileSync(join(WORKFLOWS, file), 'utf8')) as Lane;

const LEVEL: Record<string, number> = { none: 0, read: 1, write: 2 };

/** The most each scope is granted anywhere in the lane: what lane-check holds a caller to. */
const ceiling = (wf: Lane): Perms => {
  const out: Perms = {};
  for (const grant of [wf.permissions ?? {}, ...Object.values(wf.jobs).map((j) => j.permissions ?? {})]) {
    for (const [scope, level] of Object.entries(grant)) {
      if ((LEVEL[level] ?? 0) > (LEVEL[out[scope] ?? 'none'] ?? 0)) out[scope] = level;
    }
  }
  return out;
};

/** The project documents a lane's prompt reads, found exactly as lane-check finds them. */
const docsRead = (file: string): string[] =>
  [...new Set(readFileSync(join(WORKFLOWS, file), 'utf8').match(/docs\/qa\/(stack|[a-z]+(-[a-z]+)*-playbook)\.md/g) ?? [])].sort();

/** The text between an anchor pair. Throws when either anchor is missing or doubled. */
const between = (text: string, open: string, close: string): string => {
  const count = (a: string): number => text.split(a).length - 1;
  if (count(open) !== 1 || count(close) !== 1) throw new Error(`expected ${open} and ${close} exactly once each`);
  return text.slice(text.indexOf(open) + open.length, text.indexOf(close));
};

const ticked = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

type Row = { lane: string; secrets: string[]; grants: Perms; reads: string[] };

const contract = (doc: string): Row[] =>
  between(doc, '<!-- lane-contract:table -->', '<!-- /lane-contract:table -->')
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|\s*(Lane|-)/.test(l))
    .map((l) => {
      const [name, secrets, grants, reads] = l.split('|').slice(1, -1).map((c) => c.trim());
      return {
        lane: ticked(name ?? '')[0] ?? '',
        secrets: ticked(secrets ?? '').sort(),
        grants: Object.fromEntries(ticked(grants ?? '').map((g) => g.split(/:\s*/) as [string, string])),
        reads: ticked(reads ?? '').sort(),
      };
    });

describe("docs/lanes.md's lane-contract table is what each lane declares", () => {
  const rows = contract(read('docs/lanes.md'));

  it('finds the lanes and the rows, so the checks below are not vacuous', () => {
    expect(LANES.length).toBeGreaterThanOrEqual(10);
    expect(LANES).toContain('agent-review.yml');
  });

  it('has exactly one row per lane', () => {
    expect(rows.map((r) => r.lane).sort()).toEqual(LANES);
  });

  it.each(LANES)('%s: the row maps exactly the App secrets the lane declares, plus the Claude token', (file) => {
    const declared = Object.keys(lane(file).on.workflow_call?.secrets ?? {}).sort();
    const row = rows.find((r) => r.lane === file);
    expect([...(row?.secrets ?? []), 'CLAUDE_CODE_OAUTH_TOKEN'].sort()).toEqual(declared);
  });

  it.each(LANES)('%s: the row grants exactly the most any of the lane\'s jobs declares', (file) => {
    expect(rows.find((r) => r.lane === file)?.grants).toEqual(ceiling(lane(file)));
  });

  it.each(LANES)('%s: the row names exactly the project documents the lane reads', (file) => {
    expect(rows.find((r) => r.lane === file)?.reads).toEqual(docsRead(file));
  });

  it('throws, rather than passing, when an anchor is missing', () => {
    expect(() => contract('| `agent-review.yml` | | | |')).toThrow(/exactly once/);
  });
});

describe('the README lists every shipped lane', () => {
  it("names each lane in its agent-lanes row, and no lane Kanon doesn't ship", () => {
    const row = read('README.md')
      .split('\n')
      .find((l) => l.startsWith('| [Agent lanes: '));
    if (!row) throw new Error('README.md has no `| [Agent lanes: …` row');
    const names = (/\[Agent lanes: ([^\]]+)\]/.exec(row)?.[1] ?? '').split(/,\s*/).map((n) => `agent-${n.trim()}.yml`);
    expect(names.sort()).toEqual(LANES);
  });
});

describe('K-LAYOUT-17 names every playbook section a lane prompt sends the agent to', () => {
  const rule = read('rulebook/11-repository-layout.md');
  const start = rule.indexOf('### `K-LAYOUT-17`');
  if (start < 0) throw new Error('rulebook/11-repository-layout.md has no `K-LAYOUT-17` heading');
  const end = rule.indexOf('\n### ', start + 1);
  const body = rule.slice(start, end < 0 ? undefined : end);

  /** `the playbook's "<name>"`, `Use the rubric in docs/qa/explorer-playbook.md`, and the
   *  sections the excerpting step cuts out, in every lane. */
  const named = [...EXCERPTED, ...LANES.flatMap((file) => {
    const text = readFileSync(join(WORKFLOWS, file), 'utf8');
    return [
      ...[...text.matchAll(/playbook's "([^"]+)"/g)].map((m) => m[1]!),
      ...(/rubric in docs\/qa\/explorer-playbook\.md/.test(text) ? ['Severity rubric'] : []),
    ];
  })];

  it('finds the sections, so the check below is not vacuous', () => {
    expect(named).toContain('Capturing follow-ups');
    expect(named).toContain('Severity rubric');
    expect(named).toContain('Follow-ups: branch off the open parent');
  });

  it.each([...new Set(named)])('names "%s"', (section) => {
    expect(body).toContain(`\`## ${section}\``);
  });
});
