// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §6; ADR 0009)
/**
 * KANON'S COPY (plan 0001, step 2). The reference adopter's lane resolver, held here as a
 * test helper: Kanon's tests use it to expand its own lanes through the blocks (plan §6).
 * The substitutions, and nothing else: Kanon's actions are read from this tree (`KANON_DIR`
 * is the repository root), the project-setup hook from the fixture adopter, and a lane's
 * call to the spine is the self-reference `$/.github/workflows/…`. The adopter keeps its
 * own copy for its not-yet-moved lanes until the last one leaves (plan §6).
 */
/**
 * Which jobs in a workflow run an agent, and with what — resolved for BOTH shapes a lane
 * can take (RA-2168).
 *
 * A lane either runs `claude-code-action` in its own steps, or calls a shared spine
 * workflow and passes the same values as inputs. Every scanner in this repo reads the
 * first shape only, because until now it was the only one: `cli-flag-guard.mjs`, the
 * `AGENT_WORKFLOWS` expectation in `collect-agent-telemetry.mjs`, and a hand-rolled copy
 * in each of five test files. RA-2092 introduces the second shape, so this exists FIRST —
 * taught while everything is still direct, and proved by producing byte-identical answers
 * on the unconverted tree. A resolver landed after the conversion would have no oracle.
 *
 * WHY THAT MATTERS MORE THAN IT SOUNDS. What these scanners produce on a miss is a
 * SHORTER list: fewer arms probed, fewer partitions queried, fewer flag sets checked
 * against the real CLI. None of that is an error — it reads as a clean run with less to
 * say. `qa-store.mjs`'s header already records this failure for its own copy of the scan;
 * this is the same hazard one layer up, and the reason the fix is a shared function
 * rather than six edits.
 *
 * THIS DOES NOT FINISH THE JOB, and saying so is the point. `cache-ttl-check.mjs`'s
 * `pinnedAgents` is a FOURTH resolution point and it is not conversion-safe: it joins the
 * `CLAUDE_CODE_PROMPT_CACHE_TTL` pin and the arm name by requiring both in ONE file, and
 * after conversion they cannot be — a `uses:` job takes only `with:` and `secrets:`, no
 * `env:`, so the caller names the arm and cannot carry the pin while the spine carries
 * the pin and names no arm. Teaching `agentsIn` taught the scan, not that join. Tracked
 * as RA-2188, because the fix needs RA-2092's placement decision. Recorded here rather than
 * left implicit: a module header claiming the resolution layer is done, while a fourth
 * point silently drops four pinned arms, is the same false-completeness this file exists
 * to prevent (RA-2186 review).
 *
 * AND A THIRD AND FOURTH SHAPE SINCE RA-2666 / RA-2669. The spine is built from composite-action
 * blocks (`LANE_BLOCKS` below), and a lane may call those blocks from its own job instead of
 * calling the spine. Both are resolved here — the spine's job by expanding the blocks when
 * a reader is given, a direct lane by reading its block calls whether or not one is — and
 * every scanner that shares this file sees them for free. The scanners that cannot share it
 * (`qa-store.mjs`'s regex, `cache-ttl-check.mjs`'s pin join, `permissions-guard.mjs`'s step
 * walk, `cli-flag-guard.mjs`'s TTL list) were taught the same shape in the same change,
 * and `tests/unit/direct-block-lane-2669.test.ts` holds all of them to one fixture lane.
 *
 * NO IMPORTS, DELIBERATELY. It takes an already-parsed document, so the caller chooses
 * the parser. `cli-flag-guard.mjs` and the tests have the `yaml` package; the Overseer
 * job runs with no `node_modules` at all, which is why `qa-store.mjs` keeps a regex
 * implementation of the same rule rather than importing this. Two implementations, both
 * covered — `agent-lanes.test.ts` asserts they agree on the real corpus, which is the
 * guard the previous duplication never had.
 */

/** A `${{ … }}` value is the SHAPE of every lane's config and the config of none. */
export const isTemplate = (v) => typeof v === 'string' && v.includes('${{');

/** A job that delegates its whole body to a local reusable workflow. */
export const callsLocalWorkflow = (def) =>
  typeof def?.uses === 'string' && /^(\.|\$)\/\.github\/workflows\//.test(def.uses);


/**
 * THE LANE'S BUILDING BLOCKS (RA-2666) — the composite actions the spine is built from.
 *
 * A THIRD SHAPE, one level down from the second. Since RA-2666 `agent-lane.yml`'s job holds
 * no `claude-code-action` step of its own: the step lives in `agent-run`, the telemetry
 * step in `agent-finish`, and the job holds `uses: yedeya-labs/kanon/actions/agent-run@<tag>`
 * (RA-2704; `$/.github/actions/agent-run` from RA-2697, `./` before it — `localActionRef` reads
 * all three). A scan of
 * the job's `steps` therefore finds no agent in the spine at all — which is not an error
 * anywhere, just a shorter list, the failure this module exists to refuse.
 *
 * NAMED, NOT "EVERY LOCAL COMPOSITE ACTION". `agent-telemetry` is a local composite action
 * too, and it is the very step the assertions look FOR: expanding it would dissolve it into
 * its own internals and every "is this job measured" check would lose its subject. A block
 * is a stage of a lane's job; the telemetry action is a thing a stage uses.
 *
 * `agent-classify` (RA-2691) IS A BLOCK, though no lane needs it as a stage of its own: the
 * classifier, called by `agent-finish` and by the six steps that classify a run outside it.
 * It is expanded like the others, so the step that RUNS the classifier is found in every
 * lane, whichever of the two calls it — including the call nested inside `agent-finish`
 * (see `expandLaneBlocks`). Like every block it is called as a `$/` reference (RA-2697).
 */
export const LANE_BLOCKS = Object.freeze(['agent-setup', 'agent-run', 'agent-finish', 'agent-classify']);

/**
 * The three STAGES of a lane's job, in the order a lane calls them — `LANE_BLOCKS` less the
 * classifier, which `agent-finish` calls itself (RA-2691). A lane on the blocks calls exactly
 * these; a lane that only classifies calls `agent-classify` alone.
 */
export const STAGE_BLOCKS = Object.freeze(['agent-setup', 'agent-run', 'agent-finish']);

/**
 * THE TWO SPELLINGS OF "AN ACTION IN THIS REPOSITORY" (RA-2697). `./.github/actions/<name>` is
 * read from the workspace; `$/.github/actions/<name>` is GitHub's self-reference, read from
 * the runner's action cache at the commit that defined the workflow. Since P3 of Kanon's
 * plan every block call is the second and the project-setup hook is still the first.
 *
 * BOTH ARE RECOGNISED, AND THE FORM IS A SEPARATE QUESTION. A resolver that knew only one
 * spelling would drop every call in the other from every scan — a shorter list, the
 * failure this module exists to refuse — and a lane switched back to `./` would vanish
 * from the scans instead of being reported. So every reader here accepts both, and the
 * rule about WHICH form a call must use is asserted once, by `agent-lane-blocks.test.ts`,
 * through `localActionRef`.
 */
export const SELF_REF = '$/';
export const WORKSPACE_REF = './';

/**
 * KANON'S BLOCKS (RA-2704; Kanon plan 0001, step 1). The blocks moved to Kanon, and a lane now
 * calls `yedeya-labs/kanon/actions/<name>@vX.Y.Z`. Inside Kanon a block reaches another as
 * `$/actions/<name>` (`agent-finish` → `agent-classify`, `agent-telemetry`), which resolves
 * to Kanon at the same tag. Both spellings name a Kanon action, read here from the checkout
 * of the pinned tag at `KANON_DIR` (decision 15; `scripts/qa/kanon-checkout.mjs` makes it).
 *
 * A remote reference matched none of the patterns below before this, so a lane moved to
 * Kanon would have dropped out of every scan: the shorter list this module refuses.
 */
export const KANON = 'yedeya-labs/kanon';
export const KANON_DIR = '.';

/**
 * A `uses:` value naming an action under this repository's `.github/actions/`, split into
 * its form and its directory name — or undefined for anything else (a remote action, a
 * docker image, a reusable workflow).
 *
 * @param {unknown} uses
 * @returns {{form: '$/'|'./', name: string}|undefined}
 */
export const localActionRef = (uses) => {
  if (typeof uses !== 'string') return undefined;
  const m = /^(\$\/|\.\/)\.github\/actions\/([\w.-]+)\/?$/.exec(uses);
  if (m) return { form: /** @type {'$/'|'./'} */ (m[1]), name: m[2] };
  return kanonActionRef(uses);
};

/**
 * A `uses:` value naming one of Kanon's actions: `yedeya-labs/kanon/actions/<name>@<ref>` from
 * a lane, or `$/actions/<name>` from inside a Kanon block (RA-2704). Undefined otherwise.
 *
 * @param {unknown} uses
 * @returns {{form: 'kanon', name: string, ref: string|undefined}|undefined}
 */
export const kanonActionRef = (uses) => {
  if (typeof uses !== 'string') return undefined;
  const remote = /^yedeya-labs\/kanon\/actions\/([\w.-]+)@([\w.-]+)$/.exec(uses);
  if (remote) return { form: 'kanon', name: remote[1], ref: remote[2] };
  const inner = /^\$\/actions\/([\w.-]+)$/.exec(uses);
  return inner ? { form: 'kanon', name: inner[1], ref: undefined } : undefined;
};

/** The block a step calls, or undefined. Either repo-local form (see `localActionRef`). */
export const laneBlockOf = (step) => {
  const ref = localActionRef(step?.uses);
  return ref && LANE_BLOCKS.includes(ref.name) ? ref.name : undefined;
};

/**
 * A LANE THAT CALLS THE BLOCKS ITSELF (RA-2669) — the fourth shape, and the one the five lanes
 * after RA-2666 take (RA-2658, RA-2659, RA-2660, RA-2661, RA-2608). Its job keeps its own steps and puts
 * calls to `agent-run` and `agent-finish` among them — Kanon's since RA-2704, `$/` from RA-2697,
 * `./` before it, all still read.
 *
 * READ AS THE CALLS, WITHOUT A READER. The CI scanners pass no `readAction` — the spine is
 * a template to them either way — so an expansion-only answer would drop every such lane:
 * no arm, no flags, no pin, reading as a clean run with less to say, which is RA-2168's
 * failure one level down. The calls carry the same values the expansion would substitute
 * in: `claude_args` and `prompt` on the run call, `agent` on the finish call. So an
 * `agent-run` call IS the agent step and an `agent-finish` call IS the telemetry step,
 * and the answer is the same with a reader or without one (`direct-block-lane-2669.test.ts`
 * holds the two to each other on the real corpus and on the fixture lane).
 */
const isAgentStep = (s) =>
  (typeof s?.uses === 'string' && s.uses.includes('claude-code-action')) || laneBlockOf(s) === 'agent-run';
const isTelemetryStep = (s) =>
  localActionRef(s?.uses)?.name === 'agent-telemetry' || laneBlockOf(s) === 'agent-finish';

/**
 * Where an action's metadata lives, relative to the repo root: the project-setup hook in this
 * tree, everything else in the Kanon checkout (RA-2704).
 */
export const laneBlockPath = (name) =>
  name === PROJECT_HOOK ? `${FIXTURE_HOOK_DIR}/${name}/action.yml` : `${KANON_DIR}/actions/${name}/action.yml`;

/** Kanon has no hook of its own: the fixture adopter's stands in for one. */
export const FIXTURE_HOOK_DIR = 'tests/fixtures/lane-check/adopter/.github/actions';

/**
 * THE PROJECT-SETUP HOOK (RA-2694; Kanon plan 0001 §5) — the one local composite action a
 * lane calls that is NOT a block. The blocks hold no project literal; the hook holds all
 * of them (Node and the install, the app role's database URL and `db:init`, the browser,
 * the failures-only switch, the slug assertion and the starting map), and a lane calls it
 * after its checkout and before `agent-setup`.
 *
 * NOT IN `LANE_BLOCKS`, because nothing that list drives applies to it: it is the
 * project's code, so it stays a `./` reference read from the checkout (PR branches
 * included) where every block is a `$/` one (RA-2697), and it is never a stage the
 * direct-lane checklist requires. But its steps ARE steps of the
 * lane's job — the starting map, the slug assertion and `npm ci` used to be block steps —
 * so the expansion below follows it as it follows a block, and `blockCallOf` names it.
 */
export const PROJECT_HOOK = 'project-setup';

/** The hook a step calls, or undefined. Either repo-local form, like `laneBlockOf`. */
export const projectHookOf = (step) => (localActionRef(step?.uses)?.name === PROJECT_HOOK ? PROJECT_HOOK : undefined);

/** A block or the hook: every local composite action a lane's job is expanded through. */
export const expandableOf = (step) => laneBlockOf(step) ?? projectHookOf(step);

/** Which block call produced an expanded step — for a caller that needs the scope back. */
const provenance = new WeakMap();
/** @returns {{block: string, call: any}|undefined} */
export const blockCallOf = (step) => provenance.get(step);

/**
 * A job's steps with every block call replaced by the block's own steps — what the job
 * RUNS, as opposed to what its file says.
 *
 * INPUTS ARE SUBSTITUTED WHERE THEY ARE A WHOLE VALUE. An inner `with:`/`env:` value that is
 * exactly `${{ inputs.x }}` becomes the value the CALL passes for `x` (or the block's
 * default), so `claude_args` inside `agent-run` reads as the spine's own
 * `${{ inputs.claude_args }}` again — the template `resolvedAgentJobs` already filters, and
 * the same string the telemetry step inside `agent-finish` resolves to, which is what makes
 * the two comparable. Anything else — a `run:` body, an `if:`, an expression with more in
 * it — is left as written: resolving it is a caller's job (`tests/unit/helpers/spine.ts`
 * does it for one lane's inputs), and a guess here would be read as a fact everywhere.
 *
 * A CALL PASSING AN INPUT THE BLOCK DOES NOT DECLARE THROWS. The runner only warns, and the
 * value is dropped — so a typo would be a switch that silently does nothing.
 *
 * THE PROJECT-SETUP HOOK IS EXPANDED THE SAME WAY (RA-2694), though it is not a block: see
 * `PROJECT_HOOK`.
 *
 * A BLOCK THAT CALLS A BLOCK IS EXPANDED TOO (RA-2691): `agent-finish` calls `agent-classify`.
 * The nested call is substituted first, as any inner step is, so its `with:` reads in the
 * OUTER caller's terms; then it is replaced by the inner block's steps. `blockCallOf` on
 * one of those names the nested call, and `blockCallOf` on the nested call names the outer
 * one, so a reader that evaluates `if:`s walks the chain (the nested call's own `if:` reads
 * the outer block's inputs, and is left as written). A block that reaches itself throws.
 *
 * NO IMPORTS, like the rest of this file: the caller supplies `readAction(path)`, which
 * returns the parsed `action.yml`.
 *
 * @param {any[]} steps
 * @param {(path: string) => any} readAction
 * @param {string[]} [within] the blocks already being expanded, outermost first
 * @returns {any[]}
 */
/**
 * A block's step output that IS one of its inputs, with an addition no scanner reads. One
 * today: `agent-run`'s prompt step appends the persona instruction to the lane's prompt and
 * changes nothing else (plan 0005 §3.3; `withPersona`, held by `tests/unit/role-marker.test.ts`),
 * so what a lane tells its agent is still read as the lane's own prompt.
 * @type {Record<string, string>}
 */
const PASSED_THROUGH = { 'agent-run:${{ steps.prompt.outputs.text || inputs.prompt }}': 'prompt' };

export function expandLaneBlocks(steps, readAction, within = []) {
  const out = [];
  for (const step of steps ?? []) {
    const name = expandableOf(step);
    if (!name) {
      out.push(step);
      continue;
    }
    if (within.includes(name)) {
      throw new Error(`${laneBlockPath(name)} calls itself through ${[...within, name].join(' → ')}`);
    }
    const action = readAction(laneBlockPath(name));
    if (action?.runs?.using !== 'composite' || !Array.isArray(action?.runs?.steps)) {
      throw new Error(`${laneBlockPath(name)} is not a composite action with steps`);
    }
    const declared = action.inputs ?? {};
    for (const k of Object.keys(step.with ?? {})) {
      if (!(k in declared)) throw new Error(`a call to ${name} passes \`${k}\`, which the block does not declare`);
    }
    const valueOf = (k) => (step.with && k in step.with ? step.with[k] : declared[k]?.default ?? '');
    const substitute = (v) => {
      if (typeof v !== 'string') return v;
      const m = /^\$\{\{\s*inputs\.([\w-]+)\s*\}\}$/.exec(v.trim());
      if (m) return valueOf(m[1]);
      const through = PASSED_THROUGH[`${name}:${v.trim()}`];
      return through ? valueOf(through) : v;
    };
    const mapValues = (o) => (o === undefined ? undefined : Object.fromEntries(Object.entries(o).map(([k, v]) => [k, substitute(v)])));
    for (const inner of action.runs.steps) {
      const copy = { ...inner };
      if (inner.with !== undefined) copy.with = mapValues(inner.with);
      if (inner.env !== undefined) copy.env = mapValues(inner.env);
      provenance.set(copy, { block: name, call: step });
      if (expandableOf(copy)) out.push(...expandLaneBlocks([copy], readAction, [...within, name]));
      else out.push(copy);
    }
  }
  return out;
}

/**
 * Every agent-running job of one parsed workflow document.
 *
 * A job is EITHER a list of steps or a call to a reusable workflow, never both — the
 * Actions schema forbids it — so the two shapes cannot double-count one job.
 *
 * `readAction`, when given, expands the lane's building blocks first (RA-2666), so the spine
 * — whose agent step now lives in `agent-run` — is found exactly as it was before the
 * split. Without it a job is read as its file says, which is what the CI scanners that only
 * want RESOLVED arms need: the spine is a template to them either way. A job that calls
 * `agent-run` / `agent-finish` directly (RA-2669) resolves to the same entry either way: its
 * calls are read as the agent and telemetry steps, and their `with:` is what the expansion
 * would have substituted in.
 *
 * @param {any} doc a parsed workflow document
 * @param {{readAction?: (path: string) => any}} [opts]
 * @returns {{job: string, via: 'step'|'caller', agent: string|undefined,
 *            claudeArgs: string|undefined, prompt: string|undefined, id: string|undefined,
 *            spine: string|undefined}[]}
 */
export function agentJobsIn(doc, { readAction } = {}) {
  const out = [];
  for (const [job, def] of Object.entries(doc?.jobs ?? {})) {
    const steps = readAction ? expandLaneBlocks(def?.steps ?? [], readAction) : def?.steps ?? [];
    const agentSteps = steps.filter(isAgentStep);
    if (agentSteps.length) {
      // ONE ENTRY PER AGENT STEP, not per job. Every job in the corpus has exactly one
      // today — `grep -c 'uses: anthropics/claude-code-action'` returns 1 for all
      // thirteen files — so this is 1:1 and the oracle is unaffected either way. It
      // iterates anyway because the alternative silently drops the SECOND step's
      // `claude_args` the day a job grows one: a shorter list of flag sets, reading as a
      // clean run with less to say, which is the precise failure this module exists to
      // remove. Cheaper to iterate now than to re-derive the hazard later (RA-2186 review).
      //
      // The telemetry step is a SIBLING of the action, not the same step: the arm's name
      // lives there and its flags live on the action. It is read once per job, so two
      // agent steps in one job would report the same arm — correct while a job runs one
      // arm, and the thing to revisit if that ever stops being true.
      const tele = steps.find(isTelemetryStep);
      for (const step of agentSteps) {
        out.push({
          job,
          via: 'step',
          agent: tele?.with?.agent,
          claudeArgs: step.with?.claude_args,
          prompt: step.with?.prompt,
          // The STEP id, which `steps.<id>.outputs.execution_file` needs. A caller has
          // none of its own — the id lives on the spine's step, and the spine is scanned
          // as its own file, so the requirement is asserted there rather than lost.
          // For a step expanded out of a block, the id the JOB can read is the CALL's: the
          // block's own ids are invisible outside it (RA-2669), and reporting the inner one
          // would make the answer depend on whether a reader was passed. A call with NO id
          // reports none, as it does unexpanded: the job cannot read its execution file.
          id: blockCallOf(step) ? blockCallOf(step).call.id : step.id,
          spine: undefined,
        });
      }
      continue;
    }
    // AGENT-NESS, NOT DELEGATION (RA-2226). `callsLocalWorkflow` alone admits ANY job that
    // delegates to a local reusable workflow, agent or not — and for a non-agent caller
    // both `agent` and `claudeArgs` are `undefined`, which `isTemplate` reports as false,
    // so `resolvedAgentJobs` admitted it too. Harmless while nothing consumed this, and
    // load-bearing since RA-2216: four test files now derive the expected fleet from it, so
    // the first non-agent caller in this repo would red all four with messages pointing
    // away from the cause ("has it been renamed?", "add it to AGENT_WORKFLOWS").
    //
    // NAMING AN ARM IS THE TEST. Presence, not resolvability — `agent: ${{ inputs.agent }}`
    // must still be SEEN here and dropped later by `resolvedAgentJobs`, because
    // `agent-telemetry.test.ts`'s step-id assertion depends on the unfiltered view keeping
    // the spine. `qa-store.mjs`'s regex copy already requires an `agent:` key, so this
    // brings the two implementations back into agreement rather than moving one of them.
    if (callsLocalWorkflow(def) && def.with?.agent !== undefined) {
      out.push({
        job,
        via: 'caller',
        agent: def.with?.agent,
        claudeArgs: def.with?.claude_args,
        prompt: def.with?.prompt,
        id: undefined,
        spine: def.uses,
      });
    }
  }
  return out;
}

/**
 * The resolved, non-template values only — what a scanner actually wants.
 *
 * The spine's own job is filtered out here rather than at each call site: it declares
 * `agent: ${{ inputs.agent }}`, which is not an arm, and admitting it would keep a list's
 * LENGTH plausible while the real entries went missing. That is the hardest kind of wrong
 * to notice, so it is refused once, centrally.
 */
export function resolvedAgentJobs(doc, opts = {}) {
  return agentJobsIn(doc, opts).filter((e) => !isTemplate(e.agent) && !isTemplate(e.claudeArgs));
}
