import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DeclarationError,
  ESCALATION_CATEGORIES,
  ESCALATION_FILE,
  PIPELINE_ESCALATIONS,
  defaultEscalationFile,
  escalatingPaths,
  escalationCategories,
  parseEscalationFile,
  readEscalationFile,
  readEscalationFileAt,
} from '../../scripts/lib/escalation-paths.mjs';
import { IMPLEMENTER_LOGIN, mergeVerdict, readEscalations } from '../../scripts/merge-gate.mjs';
import { IMPLEMENTER_STATUS, headerLine } from '../../scripts/lib/role-marker.mjs';
import { reviewScope, sensitiveHits } from '../../scripts/ship-review-scope.mjs';
import { KANON_SCAN, appliedLabels, scanDirs } from '../../scripts/label-guard.mjs';
import { JUDGING_INPUTS } from '../../scripts/judging-inputs.mjs';

/**
 * kanon#54: the adopter's high-risk paths and its own pipeline code are declared in
 * `docs/qa/escalation-paths.md` (`K-LAYOUT-8`), not written in the library. These tests run in
 * the fixture adopter (`tests/fixtures/adopter`), whose escalation file declares `^migrations/`,
 * an auth pattern and `scripts/pipeline/`.
 */

const FILE = (paths: string, pipeline: string) => `# Escalation paths\n\n## Escalation paths\n\n${paths}\n## Pipeline code\n\n${pipeline}\n## Bail list\n\n- anything\n`;

const fails = (text: string, message: RegExp) => {
  expect(() => parseEscalationFile(text)).toThrow(DeclarationError);
  expect(() => parseEscalationFile(text)).toThrow(message);
};

describe('the escalation file parser', () => {
  it('reads both sections, with the reason for each entry, and leaves prose alone', () => {
    const file = parseEscalationFile(
      FILE('- `^migrations/` — database migrations\n\nSome prose about them.\n* `/^src/.*payments?/i` — payments\n', '- `scripts/pipeline/` — our pipeline\n'),
    );
    expect(file.paths.map((p) => [p.pattern.source, p.pattern.flags, p.reason])).toEqual([
      ['^migrations\\/', '', 'database migrations'],
      ['^src\\/.*payments?', 'i', 'payments'],
    ]);
    expect(file.pipeline).toEqual([{ dir: 'scripts/pipeline/', reason: 'our pipeline' }]);
  });

  it("reads an entry's category from Kanon's closed list, and an entry with none as `other` (plan 0003 §3.7)", () => {
    const file = parseEscalationFile(FILE('- `^migrations/` `migrations` — database migrations\n- `/^src/.*payments?/i` `payments` — payments\n- `^infra/` — no category\n', ''));
    expect(file.paths.map((p) => [p.pattern.source, p.category, p.reason])).toEqual([
      ['^migrations\\/', 'migrations', 'database migrations'],
      ['^src\\/.*payments?', 'payments', 'payments'],
      ['^infra\\/', 'other', 'no category'],
    ]);
    for (const c of ESCALATION_CATEGORIES) expect(parseEscalationFile(FILE(`- \`^a/\` \`${c}\` — a\n`, '')).paths[0]?.category).toBe(c);
  });

  it("fails by name on a category outside Kanon's list, which would carry the project's words into the telemetry", () => {
    for (const c of ['billing', 'Payments', 'esc_auth', 'other area']) {
      fails(FILE(`- \`^a/\` \`${c}\` — a\n`, ''), new RegExp(`escalation-paths\\.md:5: \`${c}\` isn't an escalation category: write one of \`pipeline\`, .*\`other\`, or none for \`other\``));
    }
  });

  it('fails by name on a category on pipeline code, which is always `pipeline`', () => {
    fails(FILE('', '- `scripts/pipeline/` `pipeline` — ours\n'), /escalation-paths\.md:8, under `## Pipeline code`, names a category: pipeline code is always `pipeline`/);
  });

  it('reads the `always` marker after the category, or alone, and an entry without it as not marked (K-MERGE-4, kanon#344)', () => {
    const file = parseEscalationFile(FILE('- `^infra/env/` `infra` `always` — the environment\'s reviewers\n- `^deploy/` `always` — the deploy role\n- `^infra/` `infra` — the rest\n', ''));
    expect(file.paths.map((p) => [p.pattern.source, p.category, p.always, p.reason])).toEqual([
      ['^infra\\/env\\/', 'infra', true, "the environment's reviewers"],
      ['^deploy\\/', 'other', true, 'the deploy role'],
      ['^infra\\/', 'infra', false, 'the rest'],
    ]);
  });

  it('fails by name on two spans that are not a category then `always`, rather than guessing which is which', () => {
    for (const spans of ['`always` `infra`', '`infra` `auth`']) {
      fails(FILE(`- \`^a/\` ${spans} — a\n`, ''), /escalation-paths\.md:5, under `## Escalation paths`, has `.+` and `.+` after its pattern: write at most one category, then `always`/);
    }
    fails(FILE('- `^a/` `infra` `always` `x` — a\n', ''), /escalation-paths\.md:5, under `## Escalation paths`, isn't an entry: .*optionally `always` in backticks/);
  });

  it('fails by name on `always` on pipeline code, which always escalates', () => {
    fails(FILE('', '- `scripts/pipeline/` `always` — ours\n'), /escalation-paths\.md:8, under `## Pipeline code`, names `always`: pipeline code is always `pipeline` and always escalates/);
  });

  it('reads `/…/i` as a pattern that ignores case, and anything else as case-sensitive', () => {
    const file = parseEscalationFile(FILE('- `/^src/.*Payments/i` — payments\n- `^Docs/` — docs\n', ''));
    expect(file.paths[0]?.pattern.test('src/lib/payments.ts')).toBe(true);
    expect(file.paths[1]?.pattern.test('docs/a.md')).toBe(false);
  });

  it('takes a section with no entries as a declaration that there are none', () => {
    expect(parseEscalationFile(FILE('None.\n', ''))).toEqual({ paths: [], pipeline: [], defaults: [] });
  });

  it("reads an omitted section as Kanon's default, none, and names the default (plan 0005 §5.2)", () => {
    const noPipeline = parseEscalationFile('## Escalation paths\n\n- `^a/` — a\n');
    expect(noPipeline.paths).toHaveLength(1);
    expect(noPipeline.pipeline).toEqual([]);
    expect(noPipeline.defaults).toEqual([
      "docs/qa/escalation-paths.md has no `## Pipeline code` heading, so Kanon's default applies: the project declares no pipeline code of its own (K-LAYOUT-8)",
    ]);
    const noPaths = parseEscalationFile('## Pipeline code\n\n- `p/` — p\n');
    expect(noPaths.paths).toEqual([]);
    expect(noPaths.pipeline).toEqual([{ dir: 'p/', reason: 'p' }]);
    expect(noPaths.defaults).toEqual([
      "docs/qa/escalation-paths.md has no `## Escalation paths` heading, so Kanon's default applies: the project declares no high-risk paths (K-LAYOUT-8)",
    ]);
    expect(parseEscalationFile('# Nothing declared\n').defaults).toHaveLength(2);
  });

  it('ignores a heading or a bullet inside a fenced block', () => {
    const text = FILE('```\n- not an entry\n## Pipeline code\n```\n- `^a/` — a\n', '');
    expect(parseEscalationFile(text).paths).toHaveLength(1);
  });

  it('fails by name when a heading is doubled: malformed, not omitted', () => {
    fails(`${FILE('', '')}\n## Pipeline code\n`, /has the `## Pipeline code` heading 2 times, on lines 6, 13/);
  });

  it('fails by name, with the line, on an entry it cannot read', () => {
    fails(FILE('- `^a/` - a hyphen, not an em dash\n', ''), /escalation-paths\.md:5, under `## Escalation paths`, isn't an entry/);
    fails(FILE('- ^a/ — no backticks\n', ''), /:5, under `## Escalation paths`/);
    fails(FILE('- `^a/` —\n', ''), /:5, under `## Escalation paths`/);
    fails(FILE('- `^(a/` — unbalanced\n', ''), /:5: `\^\(a\/` isn't a regular expression/);
    fails(FILE('', '- `scripts/pipeline` — no slash\n'), /`scripts\/pipeline` isn't a pipeline-code directory/);
    for (const dir of ['/scripts/', './scripts/', 'scripts/*/', '../x/', 'a/../b/', 'a b/']) {
      fails(FILE('', `- \`${dir}\` — x\n`), /isn't a pipeline-code directory/);
    }
    fails(`${FILE('', '')}\`\`\`\n`, /opens a code fence that never closes/);
  });

  it('reads a CRLF file as it reads an LF one, rather than as no entries', () => {
    const lf = FILE('- `^migrations/` — database migrations\n', '- `scripts/pipeline/` — ours\n');
    const crlf = parseEscalationFile(lf.replace(/\n/g, '\r\n'));
    expect(crlf.paths.map((p) => [p.pattern.source, p.reason])).toEqual([['^migrations\\/', 'database migrations']]);
    expect(crlf.pipeline).toEqual([{ dir: 'scripts/pipeline/', reason: 'ours' }]);
  });

  it('fails by name on a list item in any other form, rather than dropping its path as prose', () => {
    for (const item of ['  - `^infra/` — infra', '+ `^infra/` — infra', '1. `^infra/` — infra', '2) `^infra/` — infra', '\t* `^infra/` — infra', '> - `^infra/` — infra', '>> 1. `^infra/` — infra']) {
      fails(FILE(`${item}\n`, ''), /escalation-paths\.md:5, under `## Escalation paths`, is a list item the file doesn't use/);
      fails(FILE('', `${item.replace('^infra/', 'infra/')}\n`), /:8, under `## Pipeline code`, is a list item the file doesn't use/);
    }
  });

  it('fails by name on any flag but `i`, rather than reading the slashes as part of a pattern that never matches', () => {
    for (const value of ['/^infra\\//g', '/^infra//u', '/^infra//gi', '/^src/.*payments?/I']) {
      fails(FILE(`- \`${value}\` — x\n`, ''), /:5: `.*` begins with `\/` but isn't `\/…\/` or `\/…\/i`/);
    }
  });

  it('fails by name on a root-anchored path, which no repository-relative path matches (#141)', () => {
    for (const value of ['/terraform/main.tf', '/infra/Makefile', '/^infra\\//1']) {
      fails(FILE(`- \`${value}\` — x\n`, ''), /begins with `\/` but isn't `\/…\/` or `\/…\/i`: patterns are over repository-relative paths/);
    }
    // The `/…/` and `/…/i` forms are still patterns.
    expect(parseEscalationFile(FILE('- `/^infra//` — x\n', '')).paths[0]?.pattern.test('infra/a')).toBe(true);
  });
});

describe('reading the escalation file', () => {
  it("reads the fixture adopter's file from the working tree", () => {
    const file = readEscalationFile();
    expect(file.pipeline.map((p) => p.dir)).toEqual(['scripts/pipeline/']);
    expect(file.paths.map((p) => p.reason)).toEqual(['database migrations', 'auth']);
    expect(file.paths.map((p) => p.category)).toEqual(['migrations', 'auth']);
  });

  it("reads a tree with no escalation file as Kanon's default, the pipeline's own paths only, and names it (plan 0005 §5.2)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'escalation-'));
    try {
      const file = readEscalationFile(dir);
      expect(file).toEqual({ paths: [], pipeline: [], defaults: [expect.stringMatching(/^docs\/qa\/escalation-paths\.md doesn't exist, so Kanon's default applies: only the pipeline's own paths escalate/)] });
      expect(escalatingPaths(file)).toEqual([...PIPELINE_ESCALATIONS]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads it from the default branch it is given, never another ref (K-MERGE-17)', () => {
    const asked: string[] = [];
    const file = readEscalationFileAt('trunk', (path, ref) => {
      asked.push(`${path}@${ref}`);
      return ref === 'trunk' ? FILE('- `^a/` — a\n', '') : FILE('', '');
    });
    expect(asked).toEqual([`${ESCALATION_FILE}@trunk`]);
    expect(file.paths).toHaveLength(1);
  });

  it("the Merger's reader asks `gh` for the default branch's copy, and reads a 404 as a missing file", () => {
    const calls: string[][] = [];
    const run = (contents: () => string) => (args: string[]) => {
      calls.push(args);
      if (args[1] === 'repos/o/r') return 'trunk\n';
      return contents();
    };
    expect(readEscalations('o/r', run(() => FILE('- `^a/` — a\n', '')))[PIPELINE_ESCALATIONS.length]?.[1]).toBe('a');
    expect(calls[1]?.[1]).toBe(`repos/o/r/contents/${ESCALATION_FILE}?ref=trunk`);
    const fail = (stderr: string) => () => {
      throw Object.assign(new Error('gh failed'), { stderr });
    };
    const printed: string[] = [];
    expect(readEscalations('o/r', run(fail('gh: Not Found (HTTP 404)')), (line) => printed.push(line))).toEqual([...PIPELINE_ESCALATIONS]);
    expect(printed).toEqual([
      "merge-gate: docs/qa/escalation-paths.md on `trunk` doesn't exist, so Kanon's default applies: only the pipeline's own paths escalate (`.github/`, `docs/qa/`, the agent instruction files) (K-LAYOUT-8)",
      // The adoption record 404s too, so the production promotion takes its default (kanon#158).
      "merge-gate: docs/qa/adoption.md on `trunk` doesn't exist, so Kanon's default applies: the production promotion isn't declared human-gated, and every escalation path escalates (K-MERGE-4)",
    ]);
    printed.length = 0;
    readEscalations('o/r', run(() => FILE('- `^a/` — a\n', '')), (line) => printed.push(line));
    expect(printed.filter((l) => l.includes(ESCALATION_FILE)), 'a declared file takes no default, and says nothing').toEqual([]);
    expect(() => readEscalations('o/r', run(fail('gh: Server Error (HTTP 502)')))).toThrow(/couldn't be read from `trunk`: gh: Server Error \(HTTP 502\)/);
  });

  it("reads no file on the default branch as Kanon's default, and fails by name on a failed read or no branch", () => {
    expect(readEscalationFileAt('main', () => null)).toEqual({ paths: [], pipeline: [], defaults: [expect.stringMatching(/escalation-paths\.md on `main` doesn't exist, so Kanon's default applies/)] });
    expect(() =>
      readEscalationFileAt('main', () => {
        throw new Error('HTTP 502');
      }),
    ).toThrow(/couldn't be read from `main`: HTTP 502/);
    expect(() => readEscalationFileAt('', () => '')).toThrow(/no default branch to read docs\/qa\/escalation-paths\.md from/);
  });
});

describe("the pipeline's own escalations cover every judging input (kanon#138)", () => {
  // `K-MERGE-4` escalates the pipeline itself, and `K-MERGE-17`'s judging inputs are what every
  // later lane reads from the default branch. A row added there that nothing here escalates would
  // let the Merger merge, with no human, a change to what judges the next PR.
  it.each(JUDGING_INPUTS.flatMap((row) => row.patterns.map((p) => [row.input, p] as const)))('%s: %s', (_input, pattern) => {
    const sample = pattern.endsWith('/') ? `${pattern}x.md` : pattern.replace('*', 'x');
    expect(PIPELINE_ESCALATIONS.some(([re]) => re.test(sample)), sample).toBe(true);
  });

  it('names the one row it does not cover, the delegation closure, as K-MERGE-4’s exception (kanon#150)', () => {
    // A row with no patterns is skipped by the cases above, so a new one would pass silently.
    // The delegation row is the one `K-MERGE-4` records as deliberately not escalated: the
    // documents the inputs link to are the project's documentation.
    expect(JUDGING_INPUTS.filter((row) => row.patterns.length === 0).map((row) => row.input)).toEqual(['Anything the inputs above delegate to']);
  });
});

describe('the escalating paths', () => {
  const paths = escalatingPaths(readEscalationFile());
  const reasonFor = (f: string) => paths.find(([re]) => re.test(f))?.[1] ?? null;

  it("are the pipeline's own paths, the declared pipeline code and the declared high-risk paths", () => {
    expect(paths.slice(0, PIPELINE_ESCALATIONS.length)).toEqual([...PIPELINE_ESCALATIONS]);
    expect(reasonFor('.github/workflows/ci.yml')).toBe('the CI and agent pipeline');
    expect(reasonFor('docs/qa/reviewer-playbook.md')).toBe('the pipeline documents, which are agent instructions');
    expect(reasonFor('AGENTS.md')).toBe('the agent instructions');
    expect(reasonFor('CLAUDE.md')).toBe('the agent instructions');
    expect(reasonFor('.claude/settings.json')).toBe('the agent configuration');
    expect(reasonFor('.claude/agents/reviewer.md')).toBe('the agent configuration');
    expect(reasonFor('scripts/pipeline/file-follow-up.mjs')).toBe("the project's own pipeline scripts");
    expect(reasonFor('migrations/0001.sql')).toBe('database migrations');
    expect(reasonFor('src/server/session.ts')).toBe('auth');
  });

  it("escalate nothing the adopter didn't declare, and never a spec", () => {
    for (const f of ['docs/qa/specs/kiosk.md', 'docs/AGENTS.md', 'AGENTS.md.bak', 'MY-CLAUDE.md', 'src/.claude/x', '.claudeignore', 'scripts/qa/x.mjs', 'drizzle/0001.sql', 'sst.config.ts', 'scripts/pipelines/x.mjs', 'src/lib/authors.ts']) {
      expect(reasonFor(f), f).toBeNull();
    }
  });
});

describe("the escalation categories come from the file's entries (plan 0003 §3.7, kanon#54)", () => {
  const file = readEscalationFile();
  const of = (...paths: string[]) => escalationCategories(file, paths);

  it("are Kanon's closed list of eight, in order", () => {
    expect([...ESCALATION_CATEGORIES]).toEqual(['pipeline', 'playbooks', 'infra', 'migrations', 'schema', 'payments', 'auth', 'other']);
  });

  it("put each of the pipeline's own paths in pipeline or playbooks", () => {
    expect(of('.github/workflows/ci.yml')).toEqual(['pipeline']);
    expect(of('.claude/settings.json')).toEqual(['pipeline']);
    expect(of('docs/qa/reviewer-playbook.md')).toEqual(['playbooks']);
    expect(of('AGENTS.md')).toEqual(['playbooks']);
    expect(of('CLAUDE.md')).toEqual(['playbooks']);
  });

  it('report the declared pipeline code as pipeline, and each declared path as the category its entry names', () => {
    expect(of('scripts/pipeline/file-follow-up.mjs')).toEqual(['pipeline']);
    expect(of('migrations/0001.sql')).toEqual(['migrations']);
    expect(of('src/server/session.ts')).toEqual(['auth']);
  });

  it('report a declared path whose entry names no category as other', () => {
    const plain = parseEscalationFile(FILE('- `^infra/` — infrastructure\n- `^db/` `schema` — the schema\n', ''));
    expect(escalationCategories(plain, ['infra/main.tf'])).toEqual(['other']);
    expect(escalationCategories(plain, ['infra/main.tf', 'db/schema.sql'])).toEqual(['schema', 'other']);
    // An entry built without a category, by a caller that doesn't parse, counts as other too.
    expect(escalationCategories({ paths: [{ pattern: /^x\//, reason: 'x' }], pipeline: [], defaults: [] }, ['x/a'])).toEqual(['other']);
  });

  it('report every category a change touches once, in their order, and none for a path nothing declares', () => {
    expect(of('migrations/0001.sql', 'AGENTS.md', '.github/x.yml', 'src/auth.ts')).toEqual(['pipeline', 'playbooks', 'migrations', 'auth']);
    expect(of('AGENTS.md', '.claude/settings.json')).toEqual(['pipeline', 'playbooks']);
    expect(of('src/app.ts', 'docs/qa/specs/kiosk.md', 'README.md')).toEqual([]);
    expect(of()).toEqual([]);
  });

  it('put every escalating path in exactly one category, so no escalation goes unreported', () => {
    for (const f of ['.github/x', 'docs/qa/x.md', 'AGENTS.md', 'CLAUDE.md', '.claude/x', 'scripts/pipeline/x.mjs', 'migrations/x.sql', 'src/auth.ts']) {
      expect(escalatingPaths(file).some(([re]) => re.test(f)), f).toBe(true);
      expect(of(f), f).toHaveLength(1);
    }
  });

  it('still report a declared path under a human-gated promotion, which only changes who approves it (K-MERGE-4)', () => {
    expect(escalatingPaths(file, { judgingInputs: [] }).some(([re]) => re.test('migrations/x.sql'))).toBe(false);
    expect(of('migrations/x.sql')).toEqual(['migrations']);
  });

  it("report no project category without the file: Kanon's default declares none", () => {
    expect(escalationCategories(defaultEscalationFile(), ['src/auth.ts', 'migrations/x.sql', '.github/x'])).toEqual(['pipeline']);
  });
});

describe("the Merger's verdict takes the escalating paths as an argument (kanon#54)", () => {
  const pr = (files: string[]) => ({
    number: 1,
    reviews: [],
    rebaseAttempted: true,
    closing: { mergeClosesUndeclared: [], unverifiable: false },
    state: 'OPEN',
    isDraft: false,
    author: IMPLEMENTER_LOGIN,
    // The Implementer's marker and status (plan 0005 §3.3, L4), so the path rule is reached.
    body: headerLine('Implementer'),
    headStatuses: [{ context: IMPLEMENTER_STATUS, state: 'success', creator: `${IMPLEMENTER_LOGIN}[bot]` }],
    labels: ['agent:implement'],
    headSha: 'abc',
    workflowRuns: [],
    files,
    checks: [],
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
  });
  const escalations = escalatingPaths(readEscalationFile());

  it('escalates a declared path, and not one the adopter never declared', () => {
    expect(mergeVerdict(pr(['migrations/0001.sql']), { escalations })).toMatchObject({ action: 'escalate', rule: 'escalating-path' });
    expect(mergeVerdict(pr(['scripts/pipeline/x.mjs']), { escalations })).toMatchObject({ rule: 'escalating-path' });
    expect(mergeVerdict(pr(['sst.config.ts']), { escalations }).rule).not.toBe('escalating-path');
  });

  it('escalates a pull request that changes only the agent instructions or configuration (kanon#138)', () => {
    for (const f of ['AGENTS.md', 'CLAUDE.md', '.claude/settings.json']) {
      expect(mergeVerdict(pr([f]), { escalations }), f).toMatchObject({ action: 'escalate', rule: 'escalating-path' });
    }
  });

  it('refuses to decide with no escalating paths, rather than merge with none applied', () => {
    expect(() => mergeVerdict(pr(['src/a.ts']))).toThrow(/needs the escalating paths/);
    expect(() => mergeVerdict(pr(['src/a.ts']), { escalations: [] })).toThrow(/needs the escalating paths/);
  });
});

describe("/ship's local review reviews what the project declares (kanon#54)", () => {
  const escalation = readEscalationFile();

  it('names the reason the project gives for each hit, plus the agent workflows', () => {
    expect(sensitiveHits(['migrations/1.sql', 'scripts/pipeline/a.mjs', '.github/workflows/agent-lead.yml', '.github/workflows/ci.yml', 'README.md'], escalation)).toEqual([
      { file: 'migrations/1.sql', area: 'database migrations' },
      { file: 'scripts/pipeline/a.mjs', area: "the project's own pipeline scripts" },
      { file: '.github/workflows/agent-lead.yml', area: 'the agent pipeline' },
    ]);
  });

  it('skips a branch that touches none of them', () => {
    expect(reviewScope(['README.md'], { env: {}, escalation })).toMatchObject({ action: 'skip', rule: 'no-sensitive-path' });
    expect(reviewScope(['migrations/1.sql'], { env: {}, escalation })).toMatchObject({ action: 'run' });
  });
});

describe("the label guard scans Kanon's directories and the declared pipeline code (kanon#54)", () => {
  it("adds the fixture adopter's `scripts/pipeline` to Kanon's three", () => {
    expect(scanDirs()).toEqual([...KANON_SCAN, 'scripts/pipeline']);
    expect(appliedLabels().get('qa:needs-severity')).toEqual(new Set(['scripts/pipeline/file-follow-up.mjs']));
  });

  it("doesn't scan an undeclared directory, and reads no file as Kanon's default, saying so", () => {
    const dir = mkdtempSync(join(tmpdir(), 'label-guard-'));
    try {
      mkdirSync(join(dir, 'scripts/pipeline'), { recursive: true });
      writeFileSync(join(dir, 'scripts/pipeline/a.mjs'), "export const L = 'qa:needs-severity';\n");
      const printed: string[] = [];
      expect(scanDirs(dir, (line) => printed.push(line))).toEqual(KANON_SCAN);
      expect(printed).toEqual([expect.stringMatching(/^label-guard: docs\/qa\/escalation-paths\.md doesn't exist, so Kanon's default applies/)]);
      expect(appliedLabels(undefined, dir).has('qa:needs-severity')).toBe(false);
      mkdirSync(join(dir, 'docs/qa'), { recursive: true });
      writeFileSync(join(dir, ESCALATION_FILE), FILE('', ''));
      expect(appliedLabels(undefined, dir).has('qa:needs-severity')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
