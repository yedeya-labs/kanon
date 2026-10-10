import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { workflowText } from './helpers/called-workflow.js';
import { loadRequirements } from '../../cli/callers.mjs';
import { laneCatalogue } from '../../cli/init.mjs';
import { SECTIONS as EXCERPTED } from '../../scripts/playbook-excerpt.mjs';
import { REVIEW_LABELS } from '../../scripts/lane-gate.mjs';

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
 *      `K-LAYOUT-17` tells the adopter to write;
 *   4. docs/lanes.md's catalogue table is the lane catalogue (docs/lanes.json, kanon#428), as
 *      `kanon init` reads it with the requirements beside it. Rebuild it with
 *      `KANON_WRITE_LANES_DOC=1 npx vitest run tests/unit/lanes-doc.test.ts`.
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
  [...new Set(workflowText(join(WORKFLOWS, file)).match(/docs\/qa\/(stack|capability-ledger|[a-z]+(-[a-z]+)*-playbook)\.md/g) ?? [])].sort();

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

  it.each(LANES)('%s: the row maps exactly the App secrets the lane declares, and the lane takes the Claude token only if it runs a model', (file) => {
    const declared = Object.keys(lane(file).on.workflow_call?.secrets ?? {}).sort();
    const row = rows.find((r) => r.lane === file);
    expect(row?.secrets).toEqual(declared.filter((s) => s !== 'CLAUDE_CODE_OAUTH_TOKEN'));
    // A lane runs a model through the spine or the run block; one that runs none (the
    // Merger, plan 0004 step 7) must not ask its caller for the subscription's token.
    const text = workflowText(join(WORKFLOWS, file));
    const runsModel = /uses: \$\/(\.github\/workflows\/agent-lane\.yml|actions\/agent-run)\b/.test(text);
    expect(declared.includes('CLAUDE_CODE_OAUTH_TOKEN'), file).toBe(runsModel);
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

  /** `the playbook's "<name>"`, `the "<name>" section` (or `"<a>" and "<b>" sections`),
   *  `Use the rubric in docs/qa/explorer-playbook.md`, and the sections the excerpting step
   *  cuts out, in every lane. Prompts break lines anywhere, so whitespace is folded first. */
  const named = [...EXCERPTED, ...LANES.flatMap((file) => {
    const text = workflowText(join(WORKFLOWS, file)).replace(/\s+/g, ' ');
    return [
      ...[...text.matchAll(/playbook's "([^"]+)"/g)].map((m) => m[1]!),
      ...[...text.matchAll(/"([^"]+)"(?= (?:and "[^"]+" )?sections?\b)/g)].map((m) => m[1]!),
      ...(/rubric in docs\/qa\/explorer-playbook\.md/.test(text) ? ['Severity rubric'] : []),
    ];
  })];

  it('finds the sections, so the check below is not vacuous', () => {
    expect(named).toContain('Capturing follow-ups');
    expect(named).toContain('Severity rubric');
    expect(named).toContain('Follow-ups: branch off the open parent');
    expect(named).toContain('Implementer mode');
  });

  it.each([...new Set(named)])('names "%s"', (section) => {
    expect(body).toContain(`\`## ${section}\``);
  });
});

describe("docs/lanes.md's example callers are ones lane-check passes", () => {
  // tests/unit/lane-check*.test.ts run lane-check over the fixture callers, so a docs caller
  // equal to its fixture (bar the version) is one an adopter can copy and see go green.
  const unpin = (text: string): unknown => parse(text.replace(/(yedeya-labs\/kanon\/[^@\s]+)@v\d+\.\d+\.\d+/g, '$1@vX'));
  const FIXTURES = ['tests/fixtures/lane-check/adopter/.github/workflows', 'tests/fixtures/lane-check/extra'];
  const callers = [...read('docs/lanes.md').matchAll(/```yaml\n([\s\S]*?)```/g)]
    .map((m) => m[1]!)
    .map((text) => ({ text, lane: /yedeya-labs\/kanon\/\.github\/workflows\/(agent-[a-z-]+\.yml)@/.exec(text)?.[1] }))
    .filter((c): c is { text: string; lane: string } => c.lane !== undefined);

  it('finds the review and implement-revise callers, so the check below is not vacuous', () => {
    expect(callers.map((c) => c.lane).sort()).toEqual(['agent-implement-revise.yml', 'agent-review.yml']);
  });

  it.each(callers.map((c) => [c.lane, c.text] as const))('%s matches its lane-check fixture', (file, text) => {
    const fixture = FIXTURES.map((d) => join(d, file)).filter((p) => {
      try {
        read(p);
        return true;
      } catch {
        return false;
      }
    });
    expect(fixture).toHaveLength(1);
    expect(unpin(text)).toEqual(unpin(read(fixture[0]!)));
  });
});

/**
 * The catalogue table, built from what `kanon init --json` prints as `catalogue`: the catalogue's
 * own words, and what the requirements derive from each lane (its App, its secrets beside the
 * App's, the QA store, its hooks, its schedule).
 */
const catalogueTable = (): string => {
  const req = loadRequirements();
  const out = ['| Group | Lane | What it does | Needs | Cost | Recommended |', '|---|---|---|---|---|---|'];
  for (const g of laneCatalogue(req, [])) {
    for (const l of g.lanes) {
      const needs = [
        l.app ? `the ${req.identities.apps[l.app]!.name} App` : 'no App',
        ...l.secrets.filter((x) => !/_APP_(ID|PRIVATE_KEY)$/.test(x)).map((x) => `\`${x}\``),
        ...(l.qaStore ? ['the QA store, if you have one'] : []),
        ...l.hooks.map((h) => `\`${h}\``),
        ...(l.schedule ? [`a schedule (\`${l.schedule}\`)`] : []),
        ...l.needs,
      ];
      out.push(`| ${g.title} | \`${l.lane}.yml\` | ${l.does} | ${needs.join('; ')} | ${l.cost} | ${l.when} |`);
    }
  }
  return `\n\n${out.join('\n')}\n\n`;
};

describe("docs/lanes.md's catalogue table is the lane catalogue (kanon#428)", () => {
  const OPEN = '<!-- lane-catalogue:table -->';
  const CLOSE = '<!-- /lane-catalogue:table -->';
  const doc = read('docs/lanes.md');
  const rebuilt = `${doc.slice(0, doc.indexOf(OPEN) + OPEN.length)}${catalogueTable()}${doc.slice(doc.indexOf(CLOSE))}`;
  if (process.env.KANON_WRITE_LANES_DOC) writeFileSync(join(ROOT, 'docs/lanes.md'), rebuilt);

  it('is built from docs/lanes.json and the requirements, row for row', () => {
    expect(between(read('docs/lanes.md'), OPEN, CLOSE), 'docs/lanes.md\'s catalogue table is stale: rebuild it with KANON_WRITE_LANES_DOC=1 npx vitest run tests/unit/lanes-doc.test.ts').toBe(catalogueTable());
  });

  it('has a row for every lane', () => {
    const rows = between(read('docs/lanes.md'), OPEN, CLOSE).split('\n').filter((l) => /^\| [^-|][^|]* \| `agent-/.test(l));
    expect(rows.map((r) => /`(agent-[a-z-]+)\.yml`/.exec(r)![1]).sort()).toEqual(LANES.map((f) => f.replace(/\.yml$/, '')).sort());
  });
});

/**
 * The features table (plan 0007 §2, step G2), built from `requirements.json`'s `features`, which
 * is docs/lanes.json's: a row per feature, its lanes and person steps as what it adds to the one
 * before it, its Apps by name, and its secrets from its lanes, the ones a caller may leave out
 * aside (the QA store's, and the Overseer's telemetry reader role), and then those its
 * conditional lanes add.
 */
const featuresTable = (): string => {
  const req = loadRequirements();
  const features = req.features ?? [];
  const tick = (xs: string[]) => xs.map((x) => `\`${x}\``).join(', ');
  const secretsOf = (lanes: string[]) => [...new Set(lanes.flatMap((l) => req.lanes[l]!.secrets.filter((s) => !(req.lanes[l]!.optionalSecrets ?? []).includes(s))))].sort();
  /** What a feature adds to the one before it, said as such: "Review's, plus …", or "Review's" alone. */
  const added = (prev: { title: string } | undefined, now: string): string => (!prev ? now : now ? `${prev.title}'s, plus ${now}` : `${prev.title}'s`);
  const out = ['| Feature | What it does | Lanes | Apps | Secrets | Your steps |', '|---|---|---|---|---|---|'];
  features.forEach((f, i) => {
    const prev = features[i - 1];
    const lanes = [
      added(prev, tick(f.lanes.filter((l) => !prev?.lanes.includes(l)))),
      ...Object.entries(f.conditional).map(([l, c]) => `\`${l}\`, only ${c.condition}`),
      ...Object.entries(f.leftOut ?? {}).map(([l, why]) => `Left out: \`${l}\`. ${why}`),
    ];
    const secrets = secretsOf(f.lanes);
    const before = prev ? secretsOf(prev.lanes) : [];
    const ifIn = secretsOf(Object.keys(f.conditional)).filter((s) => !secrets.includes(s));
    out.push(
      `| ${f.title} | ${f.does} | ${lanes.join('<br>')} | ${f.apps.map((a) => `the ${req.identities.apps[a]!.name}`).join(' and ')} | ${added(prev, tick(secrets.filter((s) => !before.includes(s))))}${ifIn.length ? `; with a conditional lane, ${tick(ifIn)}` : ''} | ${added(prev, f.steps.filter((s) => !prev?.steps.includes(s)).join('; '))} |`,
    );
  });
  return `\n\n${out.join('\n')}\n\n`;
};

describe("docs/lanes.md's features table is the features of docs/lanes.json (plan 0007 §2)", () => {
  const OPEN = '<!-- lane-features:table -->';
  const CLOSE = '<!-- /lane-features:table -->';
  const doc = read('docs/lanes.md');
  if (process.env.KANON_WRITE_LANES_DOC && doc.includes(OPEN)) writeFileSync(join(ROOT, 'docs/lanes.md'), `${doc.slice(0, doc.indexOf(OPEN) + OPEN.length)}${featuresTable()}${doc.slice(doc.indexOf(CLOSE))}`);

  it('is built from the features, row for row', () => {
    expect(between(read('docs/lanes.md'), OPEN, CLOSE), "docs/lanes.md's features table is stale: rebuild it with KANON_WRITE_LANES_DOC=1 npx vitest run tests/unit/lanes-doc.test.ts").toBe(featuresTable());
  });

  it('has a row for each feature, so the check above is not vacuous', () => {
    const rows = between(read('docs/lanes.md'), OPEN, CLOSE).split('\n').filter((l) => /^\| [^-|]/.test(l) && !l.startsWith('| Feature |'));
    expect(rows.map((r) => r.split(' | ')[0]!.slice(2))).toEqual(['Review', 'Review + build', 'Full pipeline']);
    expect(rows[0]).toContain('`agent-review`');
  });
});

// #626: the review lane reviews a pull request only once it carries one of its labels, or when
// dispatched, and a person installing it read that nowhere they looked. Both of docs/lanes.md's
// tables state it in the review lane's row, with the labels the lane gates on.
describe("docs/lanes.md's tables say the review lane is opt-in (kanon#626)", () => {
  const doc = read('docs/lanes.md');
  const row = (part: string): string => doc.split('\n').find((l) => l.startsWith('| Review |') && l.includes(part)) ?? '';

  it.each([
    ['the lanes table', '| `agent-review.yml` | Reviewer |'],
    ['the catalogue table', '| `agent-review.yml` | Reviews '],
  ])("names every review label, and the dispatch, in %s's review row", (_, part) => {
    const r = row(part);
    expect(r, part).not.toBe('');
    for (const label of REVIEW_LABELS) expect(r, label).toContain(`\`${label}\``);
    expect(r).toMatch(/dispatch/);
  });
});
