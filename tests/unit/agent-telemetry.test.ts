import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runWorkflowStep } from './helpers/workflow-step.js';

import {
  buildRow,
  configFingerprint,
  issueSize,
  normalizeUsage,
  parseAutocompact,
  parseEffort,
  parseMaxTurns,
  primaryModel,
  producedLines,
  producedRange,
  renderSummary,
  sumNumstat,
  run as runTelemetry,
} from '../../actions/agent-telemetry/agent-telemetry.mjs';
import { classifyResult, parseObjects } from '../../actions/agent-classify/classify-agent-result.mjs';
import { writeStub } from './helpers/stub-bin.js';

/**
 * RA-1485 — fourteen agent steps, and until this script not one recorded a token count.
 *
 * The fixture below is not invented: it is the shape of a REAL execution file,
 * captured from a live `claude -p --output-format json` run on 2026-09-03. Every
 * field name asserted here was read off that output rather than recalled, because
 * the issue's own "possible approach" section guessed at the field names and said so.
 */
const REAL_RESULT = {
  type: 'result',
  num_turns: 41,
  duration_ms: 338_000,
  duration_api_ms: 3805,
  total_cost_usd: 0.0322419,
  terminal_reason: 'completed',
  is_error: false,
  api_error_status: null,
  permission_denials: [],
  usage: {
    input_tokens: 10,
    output_tokens: 102,
    cache_read_input_tokens: 13_629,
    cache_creation_input_tokens: 14_706,
    output_tokens_details: { thinking_tokens: 95 },
    cache_creation: { ephemeral_1h_input_tokens: 14_706, ephemeral_5m_input_tokens: 0 },
  },
  modelUsage: {
    'claude-opus-5': { canonicalModel: 'claude-opus-5', costUSD: 0.0312949, inputTokens: 10, outputTokens: 102, cacheReadInputTokens: 13_629, cacheCreationInputTokens: 14_706 },
    'claude-haiku-4-5': { canonicalModel: 'claude-haiku-4-5', costUSD: 0.000947, inputTokens: 897, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  },
  subagent_stats: { spawned: 0, completed: 0, failed: 0, max_depth: 0 },
};

const CTX = {
  now: '2026-09-03T00:00:00.000Z',
  agent: 'reviewer',
  workflow: 'Review (Reviewer)',
  job: 'review',
  run_id: '123',
  run_attempt: '1',
  trigger: 'workflow_run',
  commit: 'deadbeef',
  pr_number: 1441,
  additions: 300,
  deletions: 120,
  changed_files: 7,
  claude_args: '--model claude-opus-5\n--max-turns 70\n--allowedTools Read,Bash,Grep,Glob',
  outcome_label: 'APPROVE',
  artifacts_filed: 2,
  severities: 'high:1,medium:1',
};

describe('reading the file the action actually writes', () => {
  // THE SHAPE THAT SHIPS. The action emits PRETTY-PRINTED objects concatenated with no
  // separator — neither a JSON document nor JSON-lines. This file's first reader
  // handled only those two, so in CI it would have found nothing and recorded
  // `not-reached` for every run, while the suite passed on a compact single-object
  // fixture generated locally. Parsing now goes through `classify-agent-result.mjs`,
  // which scans brace depth; this fixture is that shape.
  const REAL_FILE = `${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5' }, null, 2)}\n${JSON.stringify(REAL_RESULT, null, 2)}\n`;

  it('finds the result in concatenated pretty-printed objects', () => {
    const objects = parseObjects(REAL_FILE);
    expect(objects).toHaveLength(2);
    expect(objects.at(-1)?.num_turns).toBe(41);
  });

  it('reads a real file end to end, not just a hand-made object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'telemetry-file-'));
    const f = join(dir, 'execution.json');
    writeFileSync(f, REAL_FILE);
    const row = runTelemetry(
      { agent: 'reviewer', execution_file: f },
      { GITHUB_WORKFLOW: 'Review (Reviewer)', GITHUB_JOB: 'review', TELEMETRY_CLAUDE_ARGS: CTX.claude_args },
    );
    expect(row.outcome).toBe('ok');
    expect(row.num_turns).toBe(41);
    expect(row.configured_model).toBe('claude-opus-5');
  });
});

describe('the four states never collapse into a zero', () => {
  // The vocabulary and the logic are `classify-agent-result.mjs`'s; these assert that
  // this file's rows carry them faithfully, not that the classifier is correct — that
  // is `classify-agent-result.test.ts`'s job.
  it('classifies a real run as ok', () => {
    expect(classifyResult(REAL_RESULT, 'claude-opus-5').kind).toBe('ok');
  });

  it('calls the outage signature unavailable, and NOT on cost', () => {
    // PR RA-1507's own review during the 2026-09-03 outage: one turn, $0.002961, and
    // `subtype: "success"`. Cost and turns are both non-zero, so any predicate keyed
    // on `cost === 0` misses it — the Opus cap still bills a Haiku pre-flight.
    const outage = {
      ...REAL_RESULT,
      subtype: 'success',
      is_error: true,
      num_turns: 1,
      total_cost_usd: 0.002961,
      modelUsage: { 'claude-haiku-4-5': { canonicalModel: 'claude-haiku-4-5', costUSD: 0.002961 } },
    };
    expect(classifyResult(outage, 'claude-opus-5').kind).toBe('unavailable');
  });

  it('separates a genuine mid-run death from an unreachable model', () => {
    const died = { ...REAL_RESULT, is_error: true, num_turns: 30 };
    expect(classifyResult(died, 'claude-opus-5').kind).toBe('failed');
  });

  it('records a missing result as not-reached with null costs, never zero', () => {
    const row = buildRow(null, CTX, classifyResult(null, ''));
    expect(row.outcome).toBe('not-reached');
    // THE WHOLE POINT. A zero here would say "this run cost nothing", which is a
    // claim the absent file cannot support.
    expect(row.total_cost_usd).toBeNull();
    expect(row.num_turns).toBeNull();
    expect(row.usage).toBeNull();
  });

  it('keeps the denominators even when the measurement is lost', () => {
    const row = buildRow(null, CTX, classifyResult(null, ''));
    expect(row.pr_number).toBe(1441);
    expect(row.changed_lines).toBe(420);
    expect(row.config_fingerprint).toBeTruthy();
  });
});

describe('the denominators a diff needs', () => {
  const row = buildRow(REAL_RESULT, CTX, classifyResult(REAL_RESULT, 'claude-opus-5'));

  it('carries diff size alongside cost, not in a separate item', () => {
    // A cost without a diff size is uncomparable: reviewing 1,000 lines bills more
    // than 20, so a fall in daily spend measures the week's PR mix instead.
    expect(row.total_cost_usd).toBeCloseTo(0.0322419);
    expect(row.changed_lines).toBe(420);
    expect(row.changed_files).toBe(7);
  });

  it('reports total prompt size, not the uncached remainder', () => {
    // `input_tokens` is 10 on this run while the prompt was ~28k. Anyone comparing
    // prompt sizes across a caching change and reaching for `input_tokens` measures
    // it backwards.
    const u = normalizeUsage(REAL_RESULT);
    expect(u.input_tokens).toBe(10);
    expect(u.total_input_tokens).toBe(28_345);
  });

  it('splits cache writes by TTL, which is what proves cross-run reuse', () => {
    const u = normalizeUsage(REAL_RESULT);
    expect(u.cache_creation_1h_tokens).toBe(14_706);
    expect(u.cache_creation_5m_tokens).toBe(0);
  });

  it('keeps thinking tokens, the mechanism an effort change moves first', () => {
    expect(normalizeUsage(REAL_RESULT).thinking_tokens).toBe(95);
  });

  it('records the turn budget so a truncated run is not read as a cheap one', () => {
    expect(row.max_turns).toBe(70);
    expect(row.num_turns).toBe(41);
  });

  it('names the model that did the work, not the first key in modelUsage', () => {
    // modelUsage routinely carries a second near-free entry for an internal call.
    expect(primaryModel(row.models)).toBe('claude-opus-5');
  });

  it('carries the quality half, so a saving is falsifiable', () => {
    // Spend down with high-severity recall down is a regression that looks like a
    // win in every cost column.
    expect(row.outcome_label).toBe('APPROVE');
    expect(row.artifacts_filed).toBe(2);
    expect(row.severities).toBe('high:1,medium:1');
  });
});

describe('effort and the config fingerprint', () => {
  it('reads an explicit effort', () => {
    expect(parseEffort('--model claude-opus-5\n--effort high')).toBe('high');
  });

  it('reads an explicit autocompact window, and reports an unset one as null (RA-1949)', () => {
    // `--autocompact` takes `auto` or 100k-1M tokens, and `auto` IS the default — so an
    // unset step is not "compaction off", it is "window inherited". Null records exactly
    // that distinction, the same measurement argument RA-1508 makes for `--effort`.
    expect(parseAutocompact('--model claude-opus-5\n--autocompact 300000')).toBe('300000');
    expect(parseAutocompact('--model claude-opus-5')).toBeNull();
    expect(parseAutocompact('')).toBeNull();
    expect(parseAutocompact(undefined as unknown as string)).toBeNull();
  });

  it('records the CLI\'s whole value domain, and never truncates a k/m suffix', () => {
    // `(auto|\d+)` — the first attempt at failing closed — was NARROWER than the CLI
    // accepts and silently truncated: `300k` became `"300"`, a 1000x error that is
    // entirely plausible to whoever later queries the store, in an append-only row.
    //
    // Probed against the CLI the action installs (2.1.278, API at a closed port):
    //   accepted: auto, 300000, 300k, 500k, 200, 1M, 1m
    //   rejected: 99k, 2M, noop, -5, 0
    expect(parseAutocompact('--autocompact 300k')).toBe('300k');
    expect(parseAutocompact('--autocompact=500k')).toBe('500k');
    expect(parseAutocompact('--autocompact 1M')).toBe('1m'); // lowercased, not truncated
    expect(parseAutocompact('--autocompact 200')).toBe('200'); // shorthand the CLI allows
    // The bound is the CLI's to enforce; this parser records faithfully rather than
    // silently dropping an out-of-range value, which would re-create the truncation.
    expect(parseAutocompact('--autocompact 99k')).toBe('99k');
  });

  it('fails closed when the value is missing, instead of swallowing the next flag', () => {
    // `\S+` recorded the STRING "--max-turns" into a permanent row on this shape. The
    // other two parsers fail to null here; this one now does too.
    expect(parseAutocompact('--autocompact\n--max-turns 150')).toBeNull();
    expect(parseAutocompact('--autocompact --max-turns 150')).toBeNull();
    expect(parseAutocompact('--autocompact notanumber')).toBeNull();
  });

  it('keeps `auto` as a string rather than coercing it to a number', () => {
    // Coercing would collapse `auto` and an unset step back into one state, which is the
    // single thing this field exists to tell apart.
    expect(parseAutocompact('--autocompact auto')).toBe('auto');
    expect(parseAutocompact('--autocompact=250000')).toBe('250000');
  });

  it('reports an UNSET effort as null, not as the default it inherits', () => {
    // RA-780 turns on exactly this distinction: a step that chose xhigh and a step
    // that never chose both run at xhigh, and only one of them is a decision.
    expect(parseEffort('--model claude-opus-5\n--max-turns 70')).toBeNull();
  });

  it('reads the turn cap', () => {
    expect(parseMaxTurns('--max-turns 150')).toBe(150);
    expect(parseMaxTurns('--model claude-opus-5')).toBeNull();
  });

  it('is stable under reflowing the YAML block', () => {
    // Otherwise re-indenting claude_args reads as a configuration change and
    // splits a before/after comparison down the middle.
    const a = configFingerprint('--model claude-opus-5\n--max-turns 70');
    const b = configFingerprint('--max-turns 70   --model claude-opus-5');
    expect(a).toBe(b);
  });

  it('changes when the configuration changes', () => {
    expect(configFingerprint('--effort high --max-turns 70')).not.toBe(
      configFingerprint('--effort xhigh --max-turns 70'),
    );
  });
});

describe('no composite action references a context it cannot read (RA-1540)', () => {
  // A LIVE INCIDENT, NOT A HYPOTHETICAL. RA-1507 documented the qa_* inputs by writing
  // an expression around `vars.QA_DYNAMO_TABLE` inside three `description:` fields and
  // one `::error::` message. `vars` and `secrets` do not exist inside a composite
  // action — only the calling workflow reads them, which is why those values arrive as
  // inputs in the first place — and GitHub validates `${{ }}` inside descriptions and
  // message strings too. One bad expression failed template validation for the whole
  // file, and because the telemetry step is `if: always()` by design, EVERY agent job
  // in the repo went red for ~30 minutes, including runs whose agent finished cleanly
  // and then posted no verdict.
  //
  // The YAML parser is happy with all of it — the file is valid YAML — so the suite
  // saw nothing. Only a job loading the action fails.
  //
  // WALKS PARSED STRING VALUES, NOT THE FILE'S TEXT. A raw grep would flag the `#`
  // comment above that explains this, which Actions never sees — the same false
  // positive that pulled a non-agent workflow into RA-1503's parity guard.
  const strings = (node: unknown, out: string[] = []): string[] => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach((n) => strings(n, out));
    else if (node && typeof node === 'object') Object.values(node).forEach((n) => strings(n, out));
    return out;
  };

  // WHICH CONTEXTS, AND WHERE THAT COMES FROM. GitHub's context-availability table
  // ("Contexts reference", docs.github.com/en/actions/reference/workflows-and-actions/contexts
  // #context-availability) is keyed by WORKFLOW keys and has no composite-action rows. The
  // table that does exist for composite actions is the runner's own schema for
  // `action.yml`, which is what template validation checks:
  // github.com/actions/runner/blob/main/src/Runner.Worker/action_yaml.json — its
  // `context` lists for `step-if`, `step-env`, `step-with`, `string-steps-context`,
  // `boolean-steps-context`, `output-value` and `input-default-context`. Their union is
  // READABLE below. Every workflow context outside it is banned. `matrix`, `strategy`
  // and `job` ARE readable (the caller's job's values), so they are deliberately not
  // banned — a ban on them would be a false positive, not extra safety.
  const WORKFLOW_CONTEXTS = [
    'github', 'env', 'vars', 'job', 'jobs', 'steps', 'runner',
    'secrets', 'strategy', 'matrix', 'needs', 'inputs',
  ];
  const READABLE_IN_COMPOSITE = ['github', 'inputs', 'strategy', 'matrix', 'steps', 'job', 'runner', 'env'];
  const BANNED = WORKFLOW_CONTEXTS.filter((c) => !READABLE_IN_COMPOSITE.includes(c));

  // A context name only counts at the START of a property path: `inputs.needs.x` names
  // the `inputs` context, not `needs`. Both access spellings — `secrets.X` and
  // `secrets['X']` — are caught.
  // String literals are blanked first, so `'needs.x'` as text is not read as the context.
  const namedIn = (expr: string): string[] =>
    [...expr.replace(/'(?:[^']|'')*'/g, "''").matchAll(new RegExp(`(?<![\\w.-])(${BANNED.join('|')})\\s*[.[]`, 'g'))]
      .map((n) => n[1]!);
  const bannedIn = (value: string): string[] =>
    [...value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].flatMap((m) => namedIn(m[1] ?? ''));

  // A step's `if:` IS an expression with or without `${{ }}`, and the bare form is how
  // these actions most often read a context. So it is read by its KEY, not by spotting a
  // wrapper — `strings()` drops keys and would let `if: needs.x.result == 'success'` by.
  type Composite = { runs?: { steps?: { if?: unknown }[] } };
  const bannedInStepIfs = (doc: Composite): string[] =>
    (doc?.runs?.steps ?? []).flatMap((st) => {
      const c = st?.if;
      if (typeof c !== 'string' || c.includes('${{')) return [];
      return namedIn(c).length > 0 ? [`if: ${c}`] : [];
    });

  // Every composite action this repository ships or loads, at any depth and under
  // either file name GitHub accepts — not just `actions/<name>/action.yml`. Fixtures
  // under tests/ are adopter-shaped templates no job here loads, so they are skipped.
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = join(dir, d.name);
      if (d.isDirectory()) return d.name === 'node_modules' ? [] : walk(p);
      return d.name === 'action.yml' || d.name === 'action.yaml' ? [p] : [];
    });
  const actions = ['actions', '.github/actions', 'infra']
    .filter((d) => existsSync(d))
    .flatMap(walk)
    .filter((f) => (parse(readFileSync(f, 'utf8')) as { runs?: { using?: string } })?.runs?.using === 'composite')
    .sort();

  it('derives a ban list that is neither empty nor over-broad', () => {
    expect(BANNED).toEqual(['vars', 'jobs', 'secrets', 'needs']);
  });

  it('finds the composite actions, so the assertion is not vacuous', () => {
    expect(actions.length).toBeGreaterThan(0);
    // The nested and non-`actions/` homes are where a narrower walk went blind.
    expect(actions).toContain(join('infra', 'qa-store', 'aws', 'maintenance', 'action.yml'));
    expect(actions).toContain(join('.github', 'actions', 'project-setup', 'action.yml'));
  });

  it('walks nested directories and accepts both action file names', () => {
    const root = mkdtempSync(join(tmpdir(), 'composite-walk-'));
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'action.yml'), '');
    writeFileSync(join(root, 'a', 'b', 'action.yaml'), '');
    writeFileSync(join(root, 'a', 'b', 'other.yml'), '');
    expect(walk(root).sort()).toEqual([join(root, 'a', 'action.yml'), join(root, 'a', 'b', 'action.yaml')]);
  });

  it('flags every banned context on injection, and nothing readable', () => {
    expect(bannedIn('${{ needs.build.outputs.x }}')).toEqual(['needs']);
    expect(bannedIn('${{ jobs.a.result }}')).toEqual(['jobs']);
    expect(bannedIn("${{ secrets['TOKEN'] }}")).toEqual(['secrets']);
    expect(bannedIn('${{ vars.QA_DYNAMO_TABLE }}')).toEqual(['vars']);
    expect(bannedIn('${{ inputs.needs.x || matrix.os || strategy.job-index || job.status }}')).toEqual([]);
    expect(bannedIn('needs.build outside an expression')).toEqual([]);
    // A `}` inside a string literal does not end the expression early.
    expect(bannedIn("${{ format('{0}', needs.a.result) }}")).toEqual(['needs']);
    // A context's name inside a string literal is text, not a read.
    expect(bannedIn("${{ inputs.mode == 'needs.x' }}")).toEqual([]);
  });

  it('reads a bare step `if:` as an expression, and only a step `if:`', () => {
    const doc = (cond: string) => parse(
      `runs:\n  using: composite\n  steps:\n    - if: ${cond}\n      run: echo\n      shell: bash\n`) as Composite;
    expect(bannedInStepIfs(doc("inputs.app-slug != '' && needs.x.result == 'success'"))).toHaveLength(1);
    expect(bannedInStepIfs(doc('secrets.TOKEN != \'\''))).toHaveLength(1);
    expect(bannedInStepIfs(doc("inputs.app-slug != '' && job.status == 'success'"))).toEqual([]);
    // Bare text anywhere else is not an expression, so it is not read as one.
    expect(bannedInStepIfs(parse('description: needs.x is documented here\nruns:\n  using: composite\n  steps: []\n') as Composite)).toEqual([]);
  });

  it.each(actions)('%s names no context a composite action cannot read', (file) => {
    const doc = parse(readFileSync(file, 'utf8')) as Composite;
    const bad = [...strings(doc).filter((v) => bannedIn(v).length > 0), ...bannedInStepIfs(doc)];
    expect(bad, `${file} uses a context a composite action cannot read: ${bad.join(' | ')}`).toEqual([]);
  });
});


describe('every renderer names every outcome the classifier can emit (RA-1808)', () => {
  // The values `classifyResult` can actually return, read from its source rather than
  // restated — a restatement is the thing that drifted.
  const emitted = [...readFileSync('actions/agent-classify/classify-agent-result.mjs', 'utf8')
    .matchAll(/kind:\s*'([a-z-]+)'/g)].map((m) => m[1]);

  // THE OTHER THREE RENDERERS (RA-1808). `exhausted` landed (RA-1781) with the step-summary
  // icon falling through to `❔` ("not classified", beside a title that classifies it),
  // no `renderSummary` banner, and a stale header vocabulary — none of them guarded.
  // Each is read as source text and located by a structural anchor that THROWS when it
  // moves, so a renamed variable reds here instead of making the check vacuous.
  const CLASSIFIER = readFileSync('actions/agent-classify/classify-agent-result.mjs', 'utf8');
  const TELEMETRY = readFileSync('actions/agent-telemetry/agent-telemetry.mjs', 'utf8');
  const slice = (src: string, start: RegExp, end: RegExp, what: string) => {
    const a = src.search(start);
    if (a === -1) throw new Error(`${what}: start anchor ${start} not found — re-anchor this guard`);
    const b = src.slice(a).search(end);
    if (b === -1) throw new Error(`${what}: end anchor ${end} not found — re-anchor this guard`);
    return src.slice(a, a + b);
  };
  const kinds = [...new Set(emitted)];

  it("the step-summary icon map has an icon for every outcome (RA-1808)", () => {
    const map = slice(CLASSIFIER, /const icon = \{/, /\}\[kind\] \?\? /, 'icon map');
    const keys = [...map.matchAll(/(?:'([a-z-]+)'|\b([a-z]+)):\s*'/g)].map((m) => m[1] ?? m[2]);
    expect(keys.length).toBeGreaterThanOrEqual(4);
    expect(kinds.filter((k) => !keys.includes(k)), 'falls through to ❔').toEqual([]);
  });

  it('renderSummary has a banner branch for every non-ok outcome (RA-1808)', () => {
    const body = slice(TELEMETRY, /export function renderSummary\(row\)/, /\n\}\n/, 'renderSummary');
    const branches = [...body.matchAll(/row\.outcome === "([a-z-]+)"/g)].map((m) => m[1]);
    expect(branches.length).toBeGreaterThanOrEqual(3);
    expect(kinds.filter((k) => k !== 'ok' && !branches.includes(k)), 'no banner').toEqual([]);
  });

  it("agent-telemetry.mjs's header vocabulary is exactly the emitted set (RA-1808)", () => {
    const block = slice(TELEMETRY, /always one of:\n/, /\n\/\/\n\/\/ Those /, 'header vocabulary');
    const named = [...block.matchAll(/^\/\/ {3}([a-z-]+)\s+—/gm)].map((m) => m[1]);
    expect(named.sort()).toEqual([...kinds].sort());
  });
});


describe('renderSummary — the exclusion banner for a truncated run (RA-1781)', () => {
  /**
   * The other branches are covered by the RA-1529 block below; these two cases cover
   * the branch RA-1781 added, and they exist because omitting it was a REGRESSION
   * rather than a missing nicety. Before the `exhausted` kind split off, these runs
   * (`is_error: true` + `terminal_reason: 'max_turns'`) classified as `failed` and
   * carried that branch's "excluded from cost comparisons" banner. Splitting the kind
   * without a branch here left the truncated runs with no banner at all — and this is
   * the guidance `parseMaxTurns`'s own comment says most needs saying, because a run cut
   * off at its cap reads as a cheap one and drags every median it lands in.
   */
  // Every optional field is an explicit `null`, not absent: `renderSummary` guards them
  // with `!== null`, so an undefined slips past the guard and throws inside the
  // formatter. The row the real caller passes comes from `buildRow`, which always sets
  // them.
  const row = (outcome: string) => ({
    agent: 'implementer agent', outcome, reason: 'it stopped at its turn cap (num_turns 151)',
    total_cost_usd: 23.08, num_turns: 151, max_turns: 150, model: 'claude-opus-5',
    model_arg: null, effort: null, usage: null, outcome_label: null,
    artifacts_filed: null, severities: null, permission_denials: null, subagents: null,
  });

  it('says a truncated run is excluded from cost comparisons', () => {
    const out = renderSummary(row('exhausted'));
    expect(out).toMatch(/\*\*EXHAUSTED\*\*/);
    expect(out).toMatch(/Excluded from cost comparisons/);
    // The specific trap: its cost is a floor, not a total.
    expect(out).toMatch(/floor, not a total/);
  });

  it('does not leave the banner to the generic table, which states no exclusion', () => {
    // Non-vacuity: an `ok` row gets the table and NO banner, so the assertion above is
    // about the branch rather than about text the function always prints.
    const out = renderSummary(row('ok'));
    expect(out).not.toMatch(/Excluded from cost comparisons/);
    expect(out).toMatch(/\| outcome \| `ok` \|/);
  });
});

/**
 * RA-1529 — `renderSummary` is the ONLY telemetry record a human reads on the run itself, and
 * it fails silently: `main` appends it after the JSON is written and the action swallows a
 * non-zero exit, so a throw here leaves the run unmeasured with nothing red.
 *
 * Every row below is built by the REAL `buildRow` from the real `classifyResult` shapes,
 * never hand-assembled — a hand-built row is how an `undefined` the producer never emits
 * gets tested while the `null` it does emit does not. Assertions are on TOKENS (the
 * banner keyword, a table row's value), never on the sentences around them, matching the
 * rest of this file's "assert the emitted key, not the prose" style.
 */
describe('renderSummary — every outcome branch and the null-cost row (RA-1529)', () => {
  const OUTAGE = {
    ...REAL_RESULT, subtype: 'success', is_error: true, num_turns: 1, total_cost_usd: 0.002961,
    modelUsage: { 'claude-haiku-4-5': { canonicalModel: 'claude-haiku-4-5', costUSD: 0.002961 } },
  };
  const DIED = { ...REAL_RESULT, is_error: true, num_turns: 30 };
  const CAPPED = { ...REAL_RESULT, is_error: true, terminal_reason: 'max_turns', num_turns: 71 };

  const rows = {
    ok: buildRow(REAL_RESULT, CTX, classifyResult(REAL_RESULT, 'claude-opus-5')),
    unavailable: buildRow(OUTAGE, CTX, classifyResult(OUTAGE, 'claude-opus-5')),
    failed: buildRow(DIED, CTX, classifyResult(DIED, 'claude-opus-5')),
    exhausted: buildRow(CAPPED, CTX, classifyResult(CAPPED, 'claude-opus-5')),
    'not-reached': buildRow(null, { ...CTX, execution_file_form: 'no-result-event' }, classifyResult(null, '')),
  } as const;

  it('the fixtures really do land in the five outcomes, so each case binds its branch', () => {
    for (const [outcome, row] of Object.entries(rows)) expect(row.outcome).toBe(outcome);
  });

  it.each([
    ['unavailable', '**UNAVAILABLE**'],
    ['failed', '**FAILED**'],
    ['exhausted', '**EXHAUSTED**'],
    ['not-reached', '**NOT REACHED**'],
  ] as const)('%s carries its own banner, with the classifier\'s reason, and no other', (outcome, banner) => {
    const out = renderSummary(rows[outcome]);
    expect(out).toContain(`> ${banner} — ${rows[outcome].reason}.`);
    const others = ['**UNAVAILABLE**', '**FAILED**', '**EXHAUSTED**', '**NOT REACHED**'].filter((b) => b !== banner);
    for (const b of others) expect(out).not.toContain(b);
    expect(out).toContain(`| outcome | \`${outcome}\` |`);
  });

  it('an ok row carries no banner at all', () => {
    const out = renderSummary(rows.ok);
    expect(out).not.toMatch(/^> \*\*/m);
  });

  it('the not-reached banner names WHICH absence it was (execution_file_form)', () => {
    // Added in RA-1507 round 4 to close a review finding, and until now nothing asserted it.
    expect(renderSummary(rows['not-reached'])).toContain('> Execution file: `no-result-event`.');
    // …and says "unknown" rather than printing `null` when the form was never recorded.
    const unrecorded = buildRow(null, { ...CTX, execution_file_form: null }, classifyResult(null, ''));
    expect(renderSummary(unrecorded)).toContain('> Execution file: `unknown`.');
  });

  it('renders a null-cost row with dashes, not $0 and not a throw', () => {
    // The not-reached row carries `total_cost_usd: null` / `num_turns: null` / `usage: null`
    // — the case `money` and `int` null-guard. A zero here would be the exact lie the
    // row exists to avoid: a run of unknown cost reading as one that cost nothing.
    const out = renderSummary(rows['not-reached']);
    expect(out).toContain('| cost | — |');
    expect(out).toContain('| turns | — |');
    expect(out).not.toContain('$0.0000');
    // No usage -> no token rows, rather than rows of zeros.
    expect(out).not.toMatch(/\| input \/ output \|/);
    expect(out).not.toMatch(/\| turn budget \|/);
  });

  it('a result-bearing row carries its measured values in the table', () => {
    const out = renderSummary(rows.ok);
    expect(out).toContain('| cost | $0.0322 |');
    expect(out).toContain('| turns | 41 |');
    expect(out).toContain('| model | claude-opus-5 |');
    expect(out).toContain('| input / output | 10 / 102 |');
    expect(out).toContain('| cache read / written | 13,629 / 14,706 |');
    expect(out).toContain('| PR | #1441 (420 lines, 7 files) |');
    expect(out).toContain('| total prompt | 28,345 tokens |');
    expect(out).toContain('| turn budget | 41 of 70 |');
    expect(out).toContain('| verdict | APPROVE |');
    expect(out).toContain('| filed | 2 (high:1,medium:1) |');
    // An unset --effort is itself the finding (RA-780), and says so rather than printing null.
    expect(out).toContain('| effort | *unset — inherits xhigh* |');
  });

  it('names the DOLLAR cap, not the turn cap, when that is what stopped it (RA-1879)', () => {
    // `--max-budget-usd` classifies `exhausted` too, and only the classifier's `why` —
    // the row's `reason` — says which cap. The shape is `classifyResult`'s own wording for
    // a budget stop; built through `buildRow` with that classification, so the test does
    // not depend on which version of the classifier is on this branch.
    const budget = buildRow(CAPPED, CTX, { kind: 'exhausted', why: 'it stopped at its dollar cap, --max-budget-usd (total_cost_usd 40.12, num_turns 33)' });
    const out = renderSummary(budget);
    expect(out).toContain('**EXHAUSTED** — it stopped at its dollar cap, --max-budget-usd');
    expect(out).toMatch(/Stopped at its dollar cap/);
    expect(out).not.toMatch(/turn cap/);
    // …and the turn-cap row keeps its own wording, so the assertion above is about the branch.
    expect(renderSummary(rows.exhausted)).toMatch(/Stopped at its turn cap/);
    expect(renderSummary(rows.exhausted)).not.toMatch(/dollar cap/);
  });

  it('flags a run that reached its turn cap', () => {
    expect(renderSummary(rows.exhausted)).toContain('| turn budget | 71 of 70 **— cap reached** |');
  });

  it('shows subagents only when some were spawned', () => {
    expect(renderSummary(rows.ok)).not.toMatch(/\| subagents \|/);
    const spawned = buildRow(
      { ...REAL_RESULT, subagent_stats: { spawned: 3, completed: 2, failed: 1, max_depth: 1 } },
      CTX,
      classifyResult(REAL_RESULT, 'claude-opus-5'),
    );
    expect(renderSummary(spawned)).toContain('| subagents | 3 spawned, 1 failed, depth 1 |');
  });

  it('does not throw on the bare row every lane without a PR or quality columns produces', () => {
    // The issue-triggered and scheduled arms carry no PR, no verdict, no filed count and
    // no --max-turns. Every one of those is a guarded access; a throw here is silent (RA-1529).
    const bare = buildRow(null, {
      ...CTX, pr_number: null, additions: null, deletions: null, changed_files: null,
      claude_args: null, outcome_label: null, artifacts_filed: null, severities: null,
      execution_file_form: 'no-path',
    }, classifyResult(null, ''));
    const out = renderSummary(bare);
    expect(out).toContain('| outcome | `not-reached` |');
    expect(out).not.toMatch(/\| PR \||\| verdict \||\| filed \|/);
  });
});

describe('RA-1938 review — both buildRow branches produce the SAME shape', () => {
  it('a not-reached row has every key a result-bearing row has', () => {
    // THE RULE THIS PINS IS ALREADY WRITTEN DOWN, twenty-five lines above the branch
    // that broke it: "a field present on some rows and absent on others is the thing
    // that makes a store unqueryable." It was enforced only by `tsc` noticing a split
    // return union — which `vitest` does not run, so adding `api_error_status` to one
    // branch passed the unit tier locally and red four required checks in CI.
    //
    // Asserting the key SETS rather than a list means the next field added to one
    // branch fails here, without anyone remembering to extend an enumeration.
    const withResult = buildRow(REAL_RESULT, CTX, classifyResult(REAL_RESULT, 'claude-opus-5'));
    const notReached = buildRow(null, CTX, { kind: 'not-reached', why: 'no result file' });

    // BOTH DIRECTIONS (RA-1967 review). The first cut asserted only
    // `keys(withResult) ⊆ keys(notReached)` while its comment promised symmetry, so a
    // field added to the `not-reached` branch ALONE passed — present on not-reached rows
    // and absent from every other row, which is the same unqueryability, mirrored.
    // Verified: adding `only_on_not_reached` to that branch left the old assertion green.
    expect(
      Object.keys(notReached).sort(),
      'the two buildRow branches must produce identical key sets',
    ).toEqual(Object.keys(withResult).sort());
  });
});

/**
 * RA-2137 — the issue-side size, and the run's own diff.
 *
 * The issue-triggered arms have no PR at telemetry time, so no `changed_lines`, so no cost
 * comparison on ~40% of fleet spend could be size-controlled. Two things are recorded for
 * them: what was ASKED (`issue_body_chars`, `issue_paths_named` — a candidate control) and
 * what the run WROTE (`produced_lines` — an outcome, and never under `changed_lines`).
 */
describe('RA-2137 — the issue-side size', () => {
  it('counts code points after CRLF→LF, and distinct backticked repo paths', () => {
    const body = [
      'Fix `src/lib/a.ts:12-40` and `./src/lib/a.ts` (same file twice).',
      'Also `docs/qa/x.md`, `app/[id]/page.tsx`, and `tests/unit/y.test.ts`.',
      'Not paths: `docs/qa/` (no ext), `a.ts` (no slash), `https://x.io/a/b.html`, and src/c.ts unquoted.',
      '🎉',
    ].join('\r\n');
    const got = issueSize(body);
    expect(got.issue_paths_named).toBe(4);
    // CRLF counted as one character, the emoji as one.
    expect(got.issue_body_chars).toBe([...body.replace(/\r\n/g, '\n')].length);
    expect(got.issue_body_chars).toBe(body.length - 3 /* three \r */ - 1 /* surrogate pair */);
  });

  it('an unreadable body is ABSENT, never zero; an empty one is a measured 0', () => {
    expect(issueSize(null)).toEqual({ issue_body_chars: null, issue_paths_named: null });
    expect(issueSize('')).toEqual({ issue_body_chars: 0, issue_paths_named: 0 });
  });

  it('run() reads the body file only on a row that names an issue', () => {
    const dir = mkdtempSync(join(tmpdir(), 'telemetry-issue-'));
    const f = join(dir, 'body.txt');
    writeFileSync(f, 'Touch `src/a/b.ts` and `src/c/d.ts`.');
    const withIssue = runTelemetry({ agent: 'implementer' }, { TELEMETRY_ISSUE_NUMBER: '7', TELEMETRY_ISSUE_BODY_FILE: f });
    expect(withIssue.issue_body_chars).toBe(36);
    expect(withIssue.issue_paths_named).toBe(2);
    // A PR arm with a stray body file must not be labelled with an issue's size.
    const noIssue = runTelemetry({ agent: 'reviewer' }, { TELEMETRY_ISSUE_BODY_FILE: f });
    expect(noIssue.issue_body_chars).toBeNull();
    // A missing file (the fetch failed) is unknown, not an empty request.
    const missing = runTelemetry({ agent: 'implementer' }, { TELEMETRY_ISSUE_NUMBER: '7', TELEMETRY_ISSUE_BODY_FILE: join(dir, 'nope') });
    expect(missing.issue_body_chars).toBeNull();
    expect(missing.issue_paths_named).toBeNull();
  });

  it('the summary shows the issue size, and says so when it could not be read', () => {
    const row = buildRow(REAL_RESULT, { ...CTX, pr_number: null, issue_number: 9, issue_body_chars: 1200, issue_paths_named: 3, produced_lines: 40 }, classifyResult(REAL_RESULT, 'claude-opus-5'));
    const md = renderSummary(row);
    expect(md).toContain('| issue | #9 (1,200 chars, 3 paths named) |');
    expect(md).toContain('| produced | 40 lines committed |');
    const unread = renderSummary({ ...row, issue_body_chars: null, issue_paths_named: null });
    expect(unread).toContain('| issue | #9 (size unread) |');
  });
});

describe('RA-2137 — the action fetches the body from the event first', () => {
  const action = parse(readFileSync('actions/agent-telemetry/action.yml', 'utf8')) as {
    runs: { steps: { id?: string; name?: string; if?: string; run?: string; env?: Record<string, string> }[] };
  };
  const step = action.runs.steps.find((s) => s.id === 'issue')!;
  const normalize = action.runs.steps.find((s) => s.id === 'row')!;

  /** Execute the step's own `run:` with a fake `gh` and event payload. */
  const execStep = (event: unknown, ghBody: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), 'telemetry-step-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const gh = join(bin, 'gh');
    writeStub(gh, ghBody === null
      ? '#!/usr/bin/env bash\necho \'{"message":"Resource not accessible by integration"}\'\nexit 1\n'
      : `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify({ body: ghBody })}\nJSON\n`);
    const eventPath = join(dir, 'event.json');
    writeFileSync(eventPath, JSON.stringify(event));
    // Under the step's own shell mode via the shared helper (RA-1171), not `bash -e -c`.
    const r = runWorkflowStep(step, {
      dir,
      env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_EVENT_PATH: eventPath, RUNNER_TEMP: dir, ISSUE: '12', REPO: 'o/r', GH_TOKEN: 'x' },
    });
    if (r.status !== 0) throw new Error(`step failed: ${r.output}`);
    const outputs = r.outputs;
    const body = outputs.body_file && existsSync(outputs.body_file) ? readFileSync(outputs.body_file, 'utf8') : null;
    return { outputs, body };
  };

  it('is gated on issue_number and feeds the normalizer', () => {
    expect(step.if).toBe("inputs.issue_number != ''");
    expect(normalize.env?.TELEMETRY_ISSUE_BODY_FILE).toBe('${{ steps.issue.outputs.body_file }}');
    expect(normalize.env?.TELEMETRY_MEASURE_PRODUCED).toContain("inputs.issue_number != ''");
  });

  it('takes the body AT DISPATCH from the event payload, not the API', () => {
    const r = execStep({ issue: { number: 12, body: 'asked for `src/a/b.ts`' } }, 'EDITED LATER');
    expect(r.outputs.source).toBe('event');
    expect(r.body).toBe('asked for `src/a/b.ts`');
  });

  it('falls back to the API when the payload is a different issue or a dispatch', () => {
    const r = execStep({ inputs: { issue_number: '12' } }, 'from the api');
    expect(r.outputs.source).toBe('api');
    expect(r.body).toBe('from the api');
  });

  it('writes NO body file when both reads fail, so the size is absent rather than 0', () => {
    // `gh` prints its error body to stdout — a 403 is a non-empty string that would
    // otherwise be measured as the issue.
    const r = execStep({ issue: { number: 99, body: 'another issue' } }, null);
    expect(r.outputs.body_file).toBeUndefined();
    expect(r.body).toBeNull();
  });

  it('a null body in the payload is a measured empty request', () => {
    const r = execStep({ issue: { number: 12, body: null } }, 'x');
    expect(r.outputs.source).toBe('event');
    expect(r.body).toBe('');
  });
});

describe('RA-2137 — produced_lines, the run\'s own diff', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n') + '\n';
  /** A checkout: `main` with one commit, and a parent PR branch with 50 lines on it. */
  const repo = () => {
    const d = mkdtempSync(join(tmpdir(), 'produced-'));
    git(d, 'init', '-q', '-b', 'main');
    writeFileSync(join(d, 'base.txt'), lines(5, 'b'));
    git(d, 'add', '.');
    git(d, 'commit', '-q', '-m', 'base');
    git(d, 'checkout', '-q', '-b', 'parent');
    writeFileSync(join(d, 'parent.txt'), lines(50, 'p'));
    git(d, 'add', '.');
    git(d, 'commit', '-q', '-m', 'parent pr');
    git(d, 'checkout', '-q', 'main');
    // Everything above predates the "run"; start the reflog here, as a fresh checkout does.
    git(d, 'reflog', 'expire', '--expire=now', '--all');
    git(d, 'checkout', '-q', '-B', 'main');
    return d;
  };

  it('counts only what this run committed, on a stacked branch, net of an amend', () => {
    const d = repo();
    git(d, 'checkout', '-q', '-b', 'mine', 'parent'); // stack on the open parent PR
    writeFileSync(join(d, 'mine.txt'), lines(10, 'm'));
    git(d, 'add', '.');
    git(d, 'commit', '-q', '-m', 'work');
    writeFileSync(join(d, 'mine.txt'), lines(12, 'm')); // +2 more
    git(d, 'add', '.');
    git(d, 'commit', '-q', '--amend', '-m', 'work v2');
    writeFileSync(join(d, 'base.txt'), lines(4, 'b')); // -1 on a second commit
    git(d, 'commit', '-q', '-am', 'trim');
    git(d, 'checkout', '-q', 'main'); // back to main after pushing: must change nothing
    // 12 added in mine.txt, 1 deleted in base.txt; the parent's 50 are not this run's.
    expect(producedLines(d)).toBe(13);
  });

  it('is 0 for a run that committed nothing, and null where it cannot be measured', () => {
    expect(producedLines(repo())).toBe(0);
    expect(producedLines(mkdtempSync(join(tmpdir(), 'no-git-')))).toBeNull();
  });

  it('parses the reflog and numstat shapes directly', () => {
    const reflog = [
      'c3\tcheckout: moving from mine to main',
      'c2\tcommit: trim',
      'c1b\tcommit (amend): work v2',
      'c1\tcommit: work',
      'p1\tcheckout: moving from main to mine',
      'm0\tcheckout: moving from main to main',
    ].join('\n');
    expect(producedRange(reflog)).toEqual({ base: 'p1', tip: 'c2' });
    expect(producedRange('m0\tcheckout: x')).toEqual({ base: null, tip: null });
    expect(producedRange('')).toBeNull();
    expect(producedRange('c1\tcommit (initial): first')).toEqual({ base: 'c1^', tip: 'c1' });
    expect(sumNumstat('3\t1\ta.ts\n-\t-\timg.png\n10\t0\tb.ts\n')).toBe(14);
    // A run that ENDS on a revert, or on a conflicted rebase resolved with --continue, has
    // that commit as its tip (RA-2311 review).
    expect(producedRange('r1\trevert: Revert "extra"\nc1\tcommit: extra\nm0\tcheckout: x')).toEqual({ base: 'm0', tip: 'r1' });
    expect(producedRange('k1\trebase (continue): mine\nc1\tcommit: mine\nm0\tcheckout: x')).toEqual({ base: 'm0', tip: 'k1' });
  });

  it('run() measures it only on an issue row that produced a result', () => {
    const d = repo();
    writeFileSync(join(d, 'x.txt'), lines(7, 'x'));
    git(d, 'add', '.');
    git(d, 'commit', '-q', '-m', 'x');
    const exec = join(d, 'execution.json');
    writeFileSync(exec, `${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5' })}\n${JSON.stringify(REAL_RESULT)}\n`);
    const env = { TELEMETRY_ISSUE_NUMBER: '5', TELEMETRY_MEASURE_PRODUCED: '1', TELEMETRY_WORKDIR: d };
    expect(runTelemetry({ agent: 'implementer', execution_file: exec }, env).produced_lines).toBe(7);
    // not-reached: the run never ran, so "committed nothing" would be a lie.
    expect(runTelemetry({ agent: 'implementer', execution_file: join(d, 'nope') }, env).produced_lines).toBeNull();
    // Not opted in (a PR arm): absent.
    expect(runTelemetry({ agent: 'reviewer', execution_file: exec }, { ...env, TELEMETRY_MEASURE_PRODUCED: '' }).produced_lines).toBeNull();
  });
});

describe('plan 0002 S1a — the version-2 artifact is kept 90 days, whatever the caller passes (#123)', () => {
  type Step = { name?: string; uses?: string; with?: Record<string, unknown> };
  const action = parse(readFileSync('actions/agent-telemetry/action.yml', 'utf8')) as {
    inputs: Record<string, { default?: string }>;
    runs: { steps: Step[] };
  };
  const upload = (prefix: string) => {
    const found = action.runs.steps.filter(
      (s) => s.uses?.startsWith('actions/upload-artifact@') && String(s.with?.name ?? '').startsWith(prefix),
    );
    // Exactly one, so a second upload of the same prefix can't escape the check.
    expect(found).toHaveLength(1);
    return found[0]!;
  };

  /**
   * What `retention-days` evaluates to for a caller's inputs. Only `${{ inputs.<name> }}` is
   * resolved (falling back to the input's default, as Actions does); any other expression
   * throws, so a retention read from somewhere this test can't see fails rather than passes.
   */
  const retention = (step: Step, inputs: Record<string, string>) =>
    String(step.with?.['retention-days']).replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, expr: string) => {
      const name = /^inputs\.(\w+)$/.exec(expr)?.[1];
      if (name === undefined) throw new Error(`unresolvable expression in retention-days: ${expr}`);
      return inputs[name] ?? action.inputs[name]?.default ?? '';
    });

  it('keeps the version-2 artifact 90 days when the caller passes nothing', () => {
    expect(retention(upload('kanon-telemetry-'), {})).toBe('90');
  });

  it('keeps it 90 days when a lane passes `retention_days: 3`, and the version-1 artifact 3', () => {
    expect(retention(upload('kanon-telemetry-'), { retention_days: '3' })).toBe('90');
    expect(retention(upload('agent-telemetry-'), { retention_days: '3' })).toBe('3');
  });

  it('leaves the version-1 artifact on the input, which still defaults to 7', () => {
    expect(action.inputs.retention_days?.default).toBe('7');
    expect(retention(upload('agent-telemetry-'), {})).toBe('7');
  });
});
