// The telemetry schema: every field a stored row may carry, and `validate(row)` (plan 0002 §2,
// plan 0003 §3.3, ADR 0007, `K-OBS-16`).
//
// ONE FILE, USED THREE TIMES (plan 0002 §2.5): by the normaliser's tests, so every fixture's
// row must validate; by the collector, before it sends a row; and by the store's ingest
// function, which is the enforcement. So it imports nothing but `node:` built-ins (it imports
// none today), and it lives beside the normaliser so the lane, the collector and the function
// read it at the same Kanon tag.
//
// A ROW IS VALID OR IT IS NOT STORED. `validate` never strips or repairs. A row with a field
// outside its kind's list, a value of the wrong type, a string outside its enum or pattern,
// or a reason that doesn't match its outcome is rejected whole, and the answer names the
// offending FIELDS only. It never echoes a value: a rejected row may hold the content this
// schema exists to keep out, and the rejection is what reaches a log.
//
// TWO ROW KINDS, each with its own version (plan 0002 §2.2). A `run` row (version 2) describes
// one agent run. A `work_item` row (version 1, plan 0003 §3.3) describes one pull request; S1
// ships its field list only, and nothing writes one until plan 0003's M4.

/** Integers are non-negative and below 2³¹ (plan 0002 §2.1)... */
const INT_MAX = 2 ** 31 - 1;
/** ...except a workflow run id, which GitHub already issues above 2³¹ (run 33679229731). */
const RUN_ID_MAX = Number.MAX_SAFE_INTEGER;

/**
 * Kanon's lanes, and the role each runs as (plan 0002 §7's table). The lane is the run row's
 * partition (`<key>#<lane>`), so `work`, the work-item partition, is reserved: no lane may be
 * named `work`, and the schema test fails if this list ever holds it.
 * @type {Readonly<Record<string, string>>}
 */
export const LANE_ROLES = Object.freeze({
  review: 'reviewer',
  'merge-reconcile': 'reviewer',
  implement: 'implementer',
  'implement-revise': 'implementer',
  triage: 'implementer',
  rebase: 'implementer',
  lead: 'lead',
  'lead-revise': 'lead',
  'lead-split': 'lead',
  explore: 'explorer',
  'code-audit': 'explorer',
  'verify-acs': 'explorer',
  overseer: 'overseer',
  'weekly-digest': 'overseer',
  'project-digest': 'overseer',
});
export const LANES = Object.freeze(Object.keys(LANE_ROLES));
/** The work-item partition's name, which no lane may take (plan 0002 §4). */
export const RESERVED_PARTITION = 'work';

export const ROLES = Object.freeze(['explorer', 'implementer', 'reviewer', 'merger', 'lead', 'overseer']);
/** An actor's class on a work-item row (plan 0003 §3.2): a role, or `human`, or `other_bot`. */
export const ACTOR_CLASSES = Object.freeze([...ROLES, 'human', 'other_bot']);

export const TAGS = Object.freeze(['run', 'smoke', 'test']);
export const OUTCOMES = Object.freeze(['ok', 'unavailable', 'exhausted', 'failed', 'not-reached']);

/**
 * The reason codes (plan 0002 §2.3), each valid only with its outcome. `agent-classify`
 * returns one beside its sentence; the sentence never leaves the step summary.
 * @type {Readonly<Record<string, string>>}
 */
export const REASON_OUTCOME = Object.freeze({
  none: 'ok',
  model_never_ran: 'unavailable',
  no_model_ran: 'unavailable',
  turn_cap: 'exhausted',
  budget_cap: 'exhausted',
  did_not_finish: 'failed',
  no_result_file: 'not-reached',
});
export const REASONS = Object.freeze(Object.keys(REASON_OUTCOME));

export const EXECUTION_FILE_FORMS = Object.freeze(['ok', 'no-path', 'absent', 'unparseable', 'no-result-event']);

/**
 * The CLI's terminal reasons this schema knows, plus `other`. The normaliser maps any value
 * not listed to `other`, so a CLI release can't make rows fail. Plan 0002 §7's dry run over
 * the reference adopter's history adds the ones found there, in a new Kanon release.
 */
export const TERMINAL_REASONS = Object.freeze(['completed', 'max_turns', 'budget_exhausted', 'api_error', 'other']);

export const VERDICTS = Object.freeze(['approved', 'changes_requested']);
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const JOB_STATUSES = Object.freeze(['success', 'failure', 'cancelled']);

/**
 * The lane stages' names (plan 0002 §2.6). `failed_stage` is the first stage that ended the
 * run, in the order THAT LANE runs them, which differs between lanes (the review lane mints its
 * token last), so the lane passes its own order and this list is only the names. A hook failure
 * is recorded as `hook` and nothing else: the adopter's own step names are its content.
 */
export const STAGES = Object.freeze(['token', 'checkout', 'hook', 'setup', 'agent', 'finish']);

/**
 * KANON'S OWN ERROR CODES (plan 0002 §2.6): written by Kanon's scripts when they fail, as a
 * `kanon-error=<code>` step output. Closed: `tests/unit/telemetry-schema.test.ts` fails when a
 * script emits a code that isn't here, or when a code here has no emitter. The codes are
 * Kanon's, so they say nothing about the adopter.
 */
export const KANON_ERRORS = Object.freeze([
  // A lane found no hook it runs in the checked-out tree: `.github/actions/project-setup`, or
  // the Explorer's sweep hook, `.github/actions/explore-sweep` (plan 0004 step 12).
  'hook_missing',
  // `agent-setup`'s push probe: the minted App can't push.
  'push_probe_denied',
  // An exception in Kanon's own code, caught at a script's top level.
  'unhandled',
]);

/**
 * GitHub's documented workflow trigger events (`trigger` is `github.event_name`).
 */
export const TRIGGERS = Object.freeze([
  'branch_protection_rule', 'check_run', 'check_suite', 'create', 'delete', 'deployment',
  'deployment_status', 'discussion', 'discussion_comment', 'fork', 'gollum', 'image_version',
  'issue_comment', 'issues', 'label', 'merge_group', 'milestone', 'page_build', 'public',
  'pull_request', 'pull_request_review', 'pull_request_review_comment', 'pull_request_target',
  'push', 'registry_package', 'release', 'repository_dispatch', 'schedule', 'status', 'watch',
  'workflow_call', 'workflow_dispatch', 'workflow_run',
]);

/**
 * The Merger's escalation rules (`K-MERGE-10`): the `stop('<rule>', …)` ids in
 * `scripts/merge-gate.mjs`, which mark its escalation comments. The schema test holds this
 * list to that file. A work item's `escalation_reasons` is built from these only.
 */
export const ESCALATION_REASONS = Object.freeze([
  'checks-cancelled', 'checks-failed', 'closes-unverifiable', 'contradictory-verdicts',
  'escalating-label', 'escalating-path', 'files-unreadable', 'merge-state', 'never-started',
  'spec-diff-unreadable', 'spec-promotion', 'undeclared-closes',
]);

/**
 * The escalation categories (plan 0003 §3.7, decision 14): Kanon's closed list, which each
 * entry of the escalation file (`K-LAYOUT-8`) carries, `other` when it names none. It is
 * `ESCALATION_CATEGORIES` in `scripts/lib/escalation-paths.mjs`; this module imports nothing,
 * so the schema test holds this copy to that one (kanon#54). A work item's `esc_<category>`
 * booleans are built from it.
 */
export const ESCALATION_CATEGORIES = Object.freeze(['pipeline', 'playbooks', 'infra', 'migrations', 'schema', 'payments', 'auth', 'other']);

/**
 * Kanon's guards, as `guard_failures` names them (plan 0003 §3.3, group 9; decision 16). Each
 * is a guard Kanon ships, and the schema test fails when one names no file. The list grows
 * with Kanon's releases; a new guard is a new entry, never a new field.
 */
export const GUARDS = Object.freeze([
  'brief-guard', 'citation-guard', 'doc-path-guard', 'label-guard', 'spec-guard',
  'dco', 'pr-title', 'lane-check',
]);

// ------------------------------------------------------------------ field types

/** @typedef {{ type: 'int', max?: number, min?: number }
 *   | { type: 'number', min: number, max: number }
 *   | { type: 'bool' }
 *   | { type: 'enum', values: readonly (string | number)[] }
 *   | { type: 'pattern', re: RegExp }
 *   | { type: 'time' }
 *   | { type: 'list', re: RegExp, values?: readonly string[], max: number, pair?: boolean }
 * } FieldType */
/** @typedef {FieldType & { required?: boolean }} Field */

const int = (/** @type {number} */ max = INT_MAX) => /** @type {Field} */ ({ type: 'int', max });
const count = int();
const bool = /** @type {Field} */ ({ type: 'bool' });
const time = /** @type {Field} */ ({ type: 'time' });
const oneOf = (/** @type {readonly (string|number)[]} */ values) => /** @type {Field} */ ({ type: 'enum', values });
const pattern = (/** @type {RegExp} */ re) => /** @type {Field} */ ({ type: 'pattern', re });
const req = (/** @type {Field} */ f) => /** @type {Field} */ ({ ...f, required: true });

const KANON_VERSION = pattern(/^(\d+\.\d+\.\d+|dev)$/);
/** A comma-separated list of up to 20 PR or issue numbers (plan 0003 §3.3). */
const NUMBERS = /** @type {Field} */ ({ type: 'list', re: /^\d{1,9}$/, max: 20 });

/** The run row, version 2: fifty-nine fields (plan 0002 §2.1, amended by plan 0003 §5.1). */
const RUN_V2 = Object.freeze({
  // Row
  schema_version: req(oneOf([2])),
  row_kind: req(oneOf(['run'])),
  tag: req(oneOf(TAGS)),
  recorded_at: req(time),
  // Run
  run_id: req(int(RUN_ID_MAX)),
  run_attempt: req(count),
  trigger: oneOf(TRIGGERS),
  pr_number: count,
  issue_number: count,
  // Who
  role: req(oneOf(ROLES)),
  lane: req(oneOf(LANES)),
  // Outcome
  outcome: req(oneOf(OUTCOMES)),
  reason: req(oneOf(REASONS)),
  execution_file_form: oneOf(EXECUTION_FILE_FORMS),
  terminal_reason: oneOf(TERMINAL_REASONS),
  is_error: bool,
  api_error_status: /** @type {Field} */ ({ type: 'int', min: 100, max: 599 }),
  verdict: oneOf(VERDICTS),
  // Attribution (§2.6)
  kanon_version: req(KANON_VERSION),
  failed_stage: oneOf(STAGES),
  kanon_error: oneOf(KANON_ERRORS),
  // Configuration
  model: pattern(/^[a-z0-9][a-z0-9.-]{0,63}(\[1m\])?$/),
  configured_model: pattern(/^[a-z0-9][a-z0-9.-]{0,63}(\[1m\])?$/),
  effort: oneOf(EFFORTS),
  max_turns: count,
  autocompact: pattern(/^(auto|\d+[km]?)$/),
  config_fingerprint: pattern(/^[0-9a-f]{12}$/),
  // Cost
  total_cost_usd: /** @type {Field} */ ({ type: 'number', min: 0, max: 1000 }),
  num_turns: count,
  duration_ms: count,
  duration_api_ms: count,
  // Tokens
  input_tokens: count,
  output_tokens: count,
  total_input_tokens: count,
  thinking_tokens: count,
  cache_read_tokens: count,
  cache_write_tokens: count,
  cache_write_1h_tokens: count,
  cache_write_5m_tokens: count,
  // Behaviour
  permission_denials: count,
  subagents_spawned: count,
  subagents_completed: count,
  subagents_failed: count,
  subagents_max_depth: count,
  tool_calls: count,
  tool_errors: count,
  compactions: count,
  // Job (plan 0003)
  job_status: oneOf(JOB_STATUSES),
  timed_out: bool,
  // Work size
  changed_lines: count,
  changed_files: count,
  issue_body_chars: count,
  issue_paths_named: count,
  produced_lines: count,
  artifacts_filed: count,
  severities_critical: count,
  severities_high: count,
  severities_medium: count,
  severities_low: count,
});

const ACTOR = oneOf(ACTOR_CLASSES);
const CHECK = oneOf(['pass', 'fail', 'absent']);

/** The work-item row, version 1: eighty-four fields (plan 0003 §3.3). */
const WORK_ITEM_V1 = Object.freeze({
  // Row and join
  schema_version: req(oneOf([1])),
  row_kind: req(oneOf(['work_item'])),
  tag: req(oneOf(TAGS)),
  recorded_at: req(time),
  pr_number: req(count),
  closing_issues: NUMBERS,
  opened_at: time,
  closed_at: req(time),
  dispatched_at: time,
  fate: req(oneOf(['merged', 'closed_unmerged'])),
  kanon_version: KANON_VERSION,
  // Group 1. Amount and complexity of work
  changed_lines: count,
  changed_files: count,
  changed_dirs: count,
  excluded_lines: count,
  files_code: count,
  files_tests: count,
  files_workflows: count,
  files_migrations: count,
  files_docs: count,
  files_specs: count,
  files_config: count,
  files_deps: count,
  ...Object.fromEntries(ESCALATION_CATEGORIES.map((c) => [`esc_${c}`, bool])),
  tests_added: count,
  tests_changed: count,
  ac_count: count,
  spec_clauses_cited: count,
  issue_body_chars: count,
  issue_paths_named: count,
  blocked_by_count: count,
  origin: oneOf(['brief', 'explorer', 'reviewer_followup', 'overseer', 'human', 'dependency_bot', 'other_bot']),
  author_kind: ACTOR,
  commits: count,
  force_pushes: count,
  band: oneOf(['S', 'M', 'L', 'XL']),
  band_version: count,
  // Group 2. Flow and time (durations in whole seconds)
  lead_time_s: count,
  t_queue_s: count,
  t_agent_s: count,
  t_review_s: count,
  t_ci_s: count,
  t_rework_s: count,
  t_human_s: count,
  t_merge_queue_s: count,
  t_other_s: count,
  human_waits: count,
  wip_at_dispatch: count,
  // Group 3. Accuracy
  first_verdict: oneOf(['approved', 'changes_requested', 'none']),
  review_rounds: count,
  ci_failures_before_review: count,
  red_first: CHECK,
  verify_acs: CHECK,
  human_commits: count,
  human_cr_after_approval: count,
  human_reviews: count,
  revert_pr: count,
  revert_days: count,
  fix_prs: NUMBERS,
  first_fix_days: count,
  // Group 4. Reviewer quality
  review_comments: count,
  followups_filed: count,
  followups_sev_critical: count,
  followups_sev_high: count,
  followups_sev_medium: count,
  followups_sev_low: count,
  followups_completed: count,
  followups_not_planned: count,
  followups_open: count,
  cr_acted: count,
  cr_withdrawn: count,
  // Group 5. Autonomy
  escalations: count,
  escalation_reasons: /** @type {Field} */ ({ type: 'list', re: /^[a-z-]+$/, values: ESCALATION_REASONS, max: ESCALATION_REASONS.length }),
  human_interventions: count,
  merged_by: ACTOR,
  // Group 6. Reliability
  recoveries: count,
  // Group 9. Kanon's own health
  guard_failures: /** @type {Field} */ ({ type: 'list', re: /^[a-z-]+:\d{1,9}$/, values: GUARDS, max: GUARDS.length, pair: true }),
});

/**
 * Every field list, by row kind and then version (plan 0002 §2.2). A new version is a Kanon
 * release that adds a list; the old one stays until no supported release writes it.
 * @type {Readonly<Record<string, Readonly<Record<number, Readonly<Record<string, Field>>>>>>}
 */
export const SCHEMAS = Object.freeze({
  run: Object.freeze({ 2: RUN_V2 }),
  work_item: Object.freeze({ 1: WORK_ITEM_V1 }),
});

/** Set by the store, never by a row: a row that sends one is rejected (plan 0002 §2.1). */
export const STORE_FIELDS = Object.freeze(['pk', 'sk', 'source', 'received_at', 'expires_at']);

// ------------------------------------------------------------------- validation

/** What a field name looks like. Anything else is never echoed. */
const FIELD_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** The `time` type: ISO-8601 UTC, to the second or the millisecond. */
export const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * Why one value fails its field, or null. Returns a PROBLEM WORD, never the value.
 * @param {Field} f
 * @param {unknown} v
 * @returns {string | null}
 */
function problemOf(f, v) {
  switch (f.type) {
    case 'int':
      if (typeof v !== 'number' || !Number.isInteger(v)) return 'type';
      return v < (f.min ?? 0) || v > (f.max ?? INT_MAX) ? 'range' : null;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'type';
      return v < f.min || v > f.max ? 'range' : null;
    case 'bool':
      return typeof v === 'boolean' ? null : 'type';
    case 'enum':
      if (typeof v !== typeof f.values[0]) return 'type';
      return f.values.includes(/** @type {string | number} */ (v)) ? null : 'enum';
    case 'pattern':
      if (typeof v !== 'string') return 'type';
      return f.re.test(v) ? null : 'pattern';
    case 'time':
      if (typeof v !== 'string') return 'type';
      return ISO_UTC.test(v) && !Number.isNaN(Date.parse(v)) ? null : 'pattern';
    case 'list': {
      // Element by element: each against its pattern, and against Kanon's list where there is
      // one (plan 0002 §2.5). An empty list is absent, never "".
      if (typeof v !== 'string') return 'type';
      const items = v.split(',');
      if (items.length > f.max) return 'range';
      const seen = new Set();
      for (const item of items) {
        if (!f.re.test(item)) return 'pattern';
        const name = f.pair ? item.slice(0, item.indexOf(':')) : item;
        if (f.values && !f.values.includes(name)) return 'enum';
        if (seen.has(name)) return 'pattern';
        seen.add(name);
      }
      return null;
    }
    default:
      return 'type';
  }
}

/**
 * The cross-field rules of a run row: a reason is valid only with its outcome (§2.3), and
 * `failed_stage` is required when the outcome is `not-reached` or `failed` and absent
 * otherwise (§2.6).
 * @param {Record<string, unknown>} row
 * @param {boolean} importedRun the history import's run row (decision 19): a `not-reached` one
 *   may omit `failed_stage`, because the history doesn't record which stage the run stopped at
 * @returns {{ field: string, problem: string }[]}
 */
function runPairings(row, importedRun) {
  /** @type {{ field: string, problem: string }[]} */
  const out = [];
  const outcome = typeof row.outcome === 'string' ? row.outcome : null;
  const reason = typeof row.reason === 'string' ? row.reason : null;
  if (outcome && reason && Object.hasOwn(REASON_OUTCOME, reason) && REASON_OUTCOME[reason] !== outcome) {
    out.push({ field: 'reason', problem: 'outcome-mismatch' });
  }
  if (outcome && OUTCOMES.includes(outcome)) {
    const needsStage = outcome === 'not-reached' || outcome === 'failed';
    const exempt = importedRun && outcome === 'not-reached';
    if (needsStage && !exempt && !Object.hasOwn(row, 'failed_stage')) out.push({ field: 'failed_stage', problem: 'required' });
    if (!needsStage && Object.hasOwn(row, 'failed_stage')) out.push({ field: 'failed_stage', problem: 'outcome-mismatch' });
  }
  if (typeof row.lane === 'string' && typeof row.role === 'string'
    && Object.hasOwn(LANE_ROLES, row.lane) && LANE_ROLES[row.lane] !== row.role) {
    out.push({ field: 'role', problem: 'lane-mismatch' });
  }
  return out;
}

/** The run field an imported row leaves absent (decision 17): no Kanon version ran it. */
export const IMPORT_ABSENT = 'kanon_version';

/**
 * Validate one row. Reads `row_kind` first, then checks the row against that kind's list at
 * its `schema_version`. Rejects the WHOLE row on any problem, and names fields only.
 *
 * `imported` is the history import's run row (plan 0002 §7, decision 17): it ran before Kanon
 * existed, so it carries NO `kanon_version`, and one that does is refused. A `not-reached` one may
 * also omit `failed_stage` (decision 19): the history doesn't say where the run stopped. A release or `dev`
 * would claim a Kanon version the run never had. Only the ingest function sets it, and only for
 * the importer role; every other caller validates a run row with `kanon_version` required.
 *
 * @param {unknown} row
 * @param {{ imported?: boolean }} [opts]
 * @returns {{ ok: true } | { ok: false, errors: { field: string, problem: string }[] }}
 */
export function validate(row, { imported = false } = {}) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return { ok: false, errors: [{ field: '(row)', problem: 'type' }] };
  }
  const r = /** @type {Record<string, unknown>} */ (row);
  const kind = r.row_kind;
  const versions = typeof kind === 'string' && Object.hasOwn(SCHEMAS, kind) ? SCHEMAS[kind] : undefined;
  if (!versions) return { ok: false, errors: [{ field: 'row_kind', problem: Object.hasOwn(r, 'row_kind') ? 'enum' : 'required' }] };
  const version = r.schema_version;
  const fields = typeof version === 'number' && Object.hasOwn(versions, version) ? versions[version] : undefined;
  if (!fields) return { ok: false, errors: [{ field: 'schema_version', problem: Object.hasOwn(r, 'schema_version') ? 'enum' : 'required' }] };

  /** @type {{ field: string, problem: string }[]} */
  const errors = [];
  for (const name of Object.keys(r)) {
    const f = Object.hasOwn(fields, name) ? fields[name] : undefined;
    // A field name outside the list is reported by name: the names are the row's own keys,
    // and a key is the one thing about a bad row the rejection may say.
    // A key that isn't shaped like a field name could itself be content, so it is reported
    // as `(unnamed)` rather than echoed.
    if (!f) { errors.push({ field: FIELD_NAME.test(name) ? name : '(unnamed)', problem: 'unknown' }); continue; }
    const p = problemOf(f, r[name]);
    if (p) errors.push({ field: name, problem: p });
  }
  const importedRun = imported && kind === 'run';
  for (const [name, f] of Object.entries(fields)) {
    if (importedRun && name === IMPORT_ABSENT) continue;
    if (f.required && !Object.hasOwn(r, name)) errors.push({ field: name, problem: 'required' });
  }
  if (importedRun && Object.hasOwn(r, IMPORT_ABSENT)) errors.push({ field: IMPORT_ABSENT, problem: 'not-allowed' });
  if (kind === 'run') errors.push(...runPairings(r, importedRun));
  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * A rejection as one line, field names and problem words only: what a log may carry.
 * @param {{ field: string, problem: string }[]} errors
 */
export const describeErrors = (errors) => errors.map((e) => `${e.field} (${e.problem})`).join(', ');
