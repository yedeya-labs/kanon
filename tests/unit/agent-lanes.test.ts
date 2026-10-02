import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { agentJobsIn, callsLocalWorkflow, isTemplate, resolvedAgentJobs } from './helpers/agent-lanes.mjs';

/**
 * RA-2168 — every scanner in this repo reads ONE shape of agent lane: a job with its own
 * `claude-code-action` step. RA-2092 introduces a second: a job that calls a shared spine
 * workflow and passes the same values as inputs.
 *
 * WHAT A MISS LOOKS LIKE, and why it is worth a file of its own. A scanner that cannot
 * see the second shape does not error — it returns a SHORTER list. Fewer arms probed,
 * fewer partitions queried, fewer flag sets checked against the real CLI, and every one
 * of those reads as a clean run with less to say. That is the silent-absence class, and
 * it is exactly what `qa-store.mjs`'s header already records happening to its own copy of
 * this scan.
 *
 * KANON'S HALF (plan 0001, step 2): the resolver's own cases, and the caller-context rule
 * over Kanon's lanes. The agreement with the store's regex copy stays in the reference
 * adopter, with the store.
 */
const CALLER = `
jobs:
  implement:
    if: github.event.label.name == 'agent:implement'
    uses: ./.github/workflows/agent-lane.yml
    with:
      agent: implementer
      claude_args: |
        --model claude-opus-5
        --effort high
`;

const SPINE = `
jobs:
  run:
    steps:
      - uses: anthropics/claude-code-action@v1
        with:
          claude_args: \${{ inputs.claude_args }}
      - uses: ./.github/actions/agent-telemetry
        with:
          agent: \${{ inputs.agent }}
`;

const DIRECT = `
jobs:
  triage-fix:
    steps:
      - uses: anthropics/claude-code-action@v1
        with:
          claude_args: |
            --model claude-opus-5
      - uses: ./.github/actions/agent-telemetry
        with:
          agent: triage-fix
`;

describe('both shapes of an agent lane resolve to the same answer', () => {
  it('reads an arm that runs the action in its own steps', () => {
    const e = resolvedAgentJobs(parse(DIRECT))[0]!;
    expect(e.via).toBe('step');
    expect(e.agent).toBe('triage-fix');
    expect(e.claudeArgs).toContain('--model claude-opus-5');
  });

  it('reads an arm that delegates to a spine workflow', () => {
    const e = resolvedAgentJobs(parse(CALLER))[0]!;
    expect(e.via).toBe('caller');
    expect(e.agent).toBe('implementer');
    expect(e.claudeArgs).toContain('--effort high');
    expect(e.spine).toBe('./.github/workflows/agent-lane.yml');
  });

  it('refuses the spine itself — a template is the shape of every arm and the name of none', () => {
    // THE DANGEROUS SHAPE. Admitting `${{ inputs.agent }}` would add a bogus partition
    // AND keep the list's LENGTH plausible while the real arms went missing, which is the
    // hardest kind of wrong to notice. `agentJobsIn` still SEES the job — the filtering is
    // a deliberate decision at one place, not an accident of the regex.
    expect(agentJobsIn(parse(SPINE))).toHaveLength(1);
    expect(resolvedAgentJobs(parse(SPINE))).toEqual([]);
  });

  it('returns one entry per agent-lane branch when a file mixes both shapes', () => {
    // A job is steps OR a call, never both — the Actions schema forbids it — so the two
    // branches cannot double-count. Pinned here because the resolver iterates both and
    // "continue" is the only thing keeping them exclusive.
    const mixed = parse(`
jobs:
  implement:
    uses: ./.github/workflows/agent-lane.yml
    with:
      agent: implementer
      claude_args: --model claude-opus-5
  triage-fix:
    steps:
      - uses: anthropics/claude-code-action@v1
        with:
          claude_args: --model claude-opus-5
      - uses: ./.github/actions/agent-telemetry
        with:
          agent: triage-fix
`);
    const jobs = resolvedAgentJobs(mixed);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.agent).sort()).toEqual(['implementer', 'triage-fix']);
    expect(jobs.map((j) => j.via).sort()).toEqual(['caller', 'step']);
  });

  it('returns one entry per AGENT STEP, so a second step in one job keeps its own flags (RA-2193)', () => {
    // `steps.find(isAgentStep)` silently dropped the second step's `claude_args` — a
    // shorter list of flag sets, reading as a clean run with less to say. Every job in the
    // corpus has one agent step today, so only this fixture can see the difference.
    const two = parse(`
jobs:
  audit:
    steps:
      - id: first
        uses: anthropics/claude-code-action@v1
        with:
          claude_args: --model claude-opus-5
      - id: second
        uses: anthropics/claude-code-action@v1
        with:
          claude_args: --model claude-haiku-4-5
      - uses: ./.github/actions/agent-telemetry
        with:
          agent: code-audit
`);
    const jobs = resolvedAgentJobs(two);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.claudeArgs)).toEqual(['--model claude-opus-5', '--model claude-haiku-4-5']);
    expect(jobs.map((j) => j.id)).toEqual(['first', 'second']);
    expect(jobs.map((j) => j.agent)).toEqual(['code-audit', 'code-audit']);
    expect(jobs.every((j) => j.job === 'audit')).toBe(true);
  });

  it('ignores a local reusable-workflow caller that names no arm (RA-2226)', () => {
    // DELEGATION IS NOT AGENT-NESS. Four test files derive the expected fleet from this
    // since RA-2216, so the first job in this repo that calls a local reusable workflow for
    // a non-agent purpose would red all four — with messages pointing away from the cause
    // ("has it been renamed?", "add it to AGENT_WORKFLOWS"). RA-2094 and RA-1597 both point at
    // more `workflow_call` extraction, so this is a matter of when rather than whether.
    const nonAgent = parse(`
jobs:
  build:
    uses: ./.github/workflows/some-shared-thing.yml
    with:
      target: production
`);
    expect(agentJobsIn(nonAgent), 'a caller naming no arm is not an agent job').toEqual([]);
    expect(resolvedAgentJobs(nonAgent)).toEqual([]);
  });

  it('still SEES a caller that forwards a templated arm, and still resolves none', () => {
    // PRESENCE, NOT RESOLVABILITY. The unfiltered view must keep anything that names an
    // `agent` input at all — `agent-telemetry.test.ts`'s step-id assertion depends on that
    // view keeping the spine — while the resolved view drops what names no real arm.
    const forwarder = parse(`
jobs:
  x:
    uses: ./.github/workflows/agent-lane.yml
    with:
      agent: \${{ inputs.agent }}
`);
    expect(agentJobsIn(forwarder)).toHaveLength(1);
    expect(resolvedAgentJobs(forwarder)).toEqual([]);
  });

  it('identifies a local spine call, and not a marketplace action', () => {
    expect(callsLocalWorkflow({ uses: './.github/workflows/agent-lane.yml' })).toBe(true);
    // Kanon's lanes call the spine through the self-reference (plan 0001 §4).
    expect(callsLocalWorkflow({ uses: '$/.github/workflows/agent-lane.yml' })).toBe(true);
    expect(callsLocalWorkflow({ uses: 'actions/checkout@v7' })).toBe(false);
    expect(isTemplate('${{ inputs.agent }}')).toBe(true);
    expect(isTemplate('implementer')).toBe(false);
  });
});

describe('a caller job may only use contexts that exist at that level (RA-2092)', () => {
  /**
   * CAUGHT BY A REAL RUN, NOT BY THIS TIER — which is why it is now a test.
   *
   * The converted `agent-triage.yml` kept `${{ env.ISSUE_NUMBER }}` in its prompt. That
   * resolved while the prompt lived in a STEP under a job-level `env:` block. A `uses:`
   * job cannot have `env:` at all, and the `env` context is not available when a caller's
   * inputs are evaluated — so GitHub refused to load the file and reported a startup
   * failure whose run `name` was the file PATH rather than the workflow's name.
   *
   * Everything local was green: `yaml` parsed it, the resolver read it, and every
   * assertion about arms and flags passed. The only signal was the run itself. That is
   * exactly the shape this repo treats as worst — so the check moves into the tier that
   * runs before a push rather than staying a lesson someone has to remember.
   */
  const WORKFLOWS = '.github/workflows';
  const callerJobs = () => {
    const out: { file: string; job: string; key: string; value: string }[] = [];
    for (const file of readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml'))) {
      const doc = parse(readFileSync(join(WORKFLOWS, file), 'utf8')) as {
        jobs?: Record<string, { uses?: string; with?: Record<string, unknown> }>;
      };
      for (const [job, def] of Object.entries(doc?.jobs ?? {})) {
        if (!callsLocalWorkflow(def)) continue;
        for (const [key, value] of Object.entries(def.with ?? {})) {
          out.push({ file, job, key, value: String(value) });
        }
      }
    }
    return out;
  };

  it('finds the caller jobs at all, so the assertion below is not vacuous', () => {
    // The day no lane is a caller this suite would pass by describing nothing. It would
    // also mean the conversion had been reverted, which is worth a red test either way.
    const inputs = callerJobs();
    expect(inputs.length, 'no reusable-workflow callers found — the scan is broken, or the spine is gone')
      .toBeGreaterThan(0);
    expect([...new Set(inputs.map((i) => i.file))].length).toBeGreaterThanOrEqual(2);
  });

  /**
   * ALL FIVE, NOT JUST THE ONE THAT BIT (RA-2221). A caller job's inputs are evaluated in a
   * context set that excludes `env`, `secrets`, `steps`, `job` and `runner`. RA-2216 guarded
   * `env` alone because `env` is what actually broke — and a guard shaped by the single
   * instance that caused it is a guard that lets the next four through. Nine lanes are
   * still to convert, and `steps.` in particular is a live hazard: the prompts these lanes
   * carry were written beside steps.
   *
   * `secrets` is in the list deliberately even though a caller MAY pass secrets — it does
   * so through the `secrets:` block, never through `with:`, so a `${{ secrets.X }}` inside
   * an input is the same startup failure as the rest.
   */
  const FORBIDDEN_CONTEXTS = ['env', 'secrets', 'steps', 'job', 'runner'] as const;

  it.each(FORBIDDEN_CONTEXTS)('uses no `%s` context in any input it passes', (ctx) => {
    const offenders = callerJobs()
      .filter((i) => new RegExp(`\\$\\{\\{\\s*${ctx}\\.`).test(i.value))
      .map((i) => `${i.file}:${i.job} with.${i.key}`);
    expect(
      offenders,
      `the \`${ctx}\` context does not exist where a caller's inputs are evaluated, and GitHub `
        + `refuses to load the workflow — a startup failure, not a step failure: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('the forbidden list is the documented one, so it cannot quietly shrink', () => {
    // NON-VACUITY FOR THE SET ITSELF. Every assertion above passes trivially if the list
    // is emptied, and an `it.each` over nothing reports as green with no cases run.
    expect(FORBIDDEN_CONTEXTS).toHaveLength(5);
    expect([...FORBIDDEN_CONTEXTS].sort()).toEqual(['env', 'job', 'runner', 'secrets', 'steps']);
  });
});
