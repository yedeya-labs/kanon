#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter, which does not type-check its scripts.
// Typing it is separate work; a move changes no line it doesn't have to (ADR 0009).
//
// Normalize one `claude-code-action` run's execution file into a single telemetry
// row, write it to the step summary, and emit it as JSON for the L1 store (RA-1485).
//
// WHY THIS EXISTS. Every agent step in this repo runs and, until this script,
// not one recorded a token count. Every cost statement about the pipeline was
// inferred from `gh run list` durations and job-skip rates — enough to rank the
// agents, not enough to decide anything. The action already publishes the data as
// its `execution_file` output; nothing read it.
//
// WHAT IT MUST NOT DO IS COLLAPSE THREE STATES INTO A ZERO. A run that cost money,
// a run that produced nothing because the usage cap was hit, and a run whose
// telemetry was lost are different facts, and recording any of them as
// `cost: 0` makes the other two invisible. That is the failure shape agent-review.yml
// already counts six occurrences of — a read fails, the failure is swallowed, and the
// empty value reads as data. Hence `outcome`, which is always one of:
//
//   ok          — the agent ran on the configured model and finished. The normal row.
//   unavailable — it errored AND the configured model never appears in `modelUsage`:
//                 a usage cap, an API outage, or a bad model id / expired token.
//                 Measured four times on 2026-09-03 during an Anthropic outage, each
//                 at ONE turn and ~$0.003 — non-zero on both counts, which is why an
//                 earlier version of this file testing `turns === 0 && cost === 0`
//                 would never have fired on a real cap. The Opus cap still bills a
//                 Haiku pre-flight (RA-1503).
//   exhausted   — it stopped at a cap: the turn cap (`terminal_reason: 'max_turns'`)
//                 or, since RA-1879, the dollar cap (`terminal_reason: 'budget_exhausted'`,
//                 `--max-budget-usd`). The row's `reason` names which one, and the
//                 summary banner branches on it (RA-2284). Like
//                 `failed` it is excluded from cost comparisons, and for the reason
//                 `parseMaxTurns` below states: a truncated run is not a sample of the
//                 same thing as one that finished. Split off from `failed` because the
//                 ADVICE differs — a re-run reproduces it (RA-1781). Keyed on the
//                 reported terminal reason and NEVER on `num_turns` against
//                 `max_turns`: two runs in the first week finished cleanly at 166 and
//                 157 turns against a cap of 150.
//   failed      — it errored, but on the right model: a genuine mid-run death.
//   not-reached — no result file at all. An ABSENCE of measurement, never a
//                 measurement of zero.
//
// Those five names and the logic behind them are `classify-agent-result.mjs`'s (in
// `actions/agent-classify/`), reused
// rather than re-derived — see the note above `classifyResult`'s import.
//
// Usage: agent-telemetry.mjs --execution-file <path> --agent <name> [--out <path>]
// Everything else comes from the environment (see readContext).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

// The classifier lives in the `agent-classify` block's directory (RA-2691), so the block can
// run it from its own path; this imports the same file.
import { classifyResult, parseObjects, readConfiguredModel, readResult } from "../agent-classify/classify-agent-result.mjs";

const SCHEMA = 1;

// ---------------------------------------------------------------- arg parsing
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2).replace(/-/g, "_");
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

// ------------------------------------------------------------- normalisation
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function normalizeUsage(result) {
  const u = result.usage ?? {};
  const cc = u.cache_creation ?? {};
  const input = num(u.input_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens);
  return {
    // THE TRAP THIS FIELD EXISTS TO CLOSE. `input_tokens` is the UNCACHED
    // REMAINDER, not the prompt size — on a well-cached run it reads as a few
    // thousand while the real prompt was hundreds of thousands. Anyone comparing
    // prompt sizes across a caching change and reaching for `input_tokens` will
    // measure the change backwards. Total prompt is the sum of all three.
    total_input_tokens: input + cacheRead + cacheWrite,
    input_tokens: input,
    output_tokens: num(u.output_tokens),
    cache_read_input_tokens: num(u.cache_read_input_tokens),
    cache_creation_input_tokens: num(u.cache_creation_input_tokens),
    cache_creation_1h_tokens: num(cc.ephemeral_1h_input_tokens),
    cache_creation_5m_tokens: num(cc.ephemeral_5m_input_tokens),
    thinking_tokens: num(u.output_tokens_details?.thinking_tokens),
  };
}

export function normalizeModels(result) {
  const mu = result.modelUsage ?? {};
  return Object.entries(mu).map(([id, m]) => ({
    model: m?.canonicalModel ?? id,
    model_id: id,
    cost_usd: num(m?.costUSD),
    input_tokens: num(m?.inputTokens),
    output_tokens: num(m?.outputTokens),
    cache_read_input_tokens: num(m?.cacheReadInputTokens),
    cache_creation_input_tokens: num(m?.cacheCreationInputTokens),
  }));
}

// The model that did the work — the one that billed the most, not the first key.
// `modelUsage` routinely carries a second, near-free entry for an internal call.
export function primaryModel(models) {
  if (models.length === 0) return null;
  return [...models].sort((a, b) => b.cost_usd - a.cost_usd)[0].model;
}

// EFFORT IS NOT IN THE EXECUTION FILE. Nothing the agent writes reports which
// effort level it ran at, so the only honest source is the step's own claude_args.
// `null` means "the step did not set one", which is itself the finding worth
// recording — an unset --effort inherits Claude Code's xhigh default, and that
// inheritance across every step is what RA-780 is about.
export function parseEffort(claudeArgs) {
  if (!claudeArgs) return null;
  const m = claudeArgs.match(/--effort[\s=]+([a-z]+)/i);
  return m ? m[1].toLowerCase() : null;
}

// A RUN THAT HIT ITS TURN CAP IS NOT A SAMPLE OF THE SAME THING as one that
// finished. `terminal_reason` plus `num_turns` against this tells the two apart;
// without the cap value, a truncated run silently reads as a cheap one and drags
// every median it lands in.
export function parseMaxTurns(claudeArgs) {
  if (!claudeArgs) return null;
  const m = claudeArgs.match(/--max-turns[\s=]+(\d+)/);
  return m ? Number(m[1]) : null;
}

// WHICH CONTEXT WINDOW THIS RUN ACTUALLY HAD (RA-1949), and `null` is the finding here
// exactly as it is for `--effort`. `--autocompact` takes `auto` or 100k-1M tokens, and
// `auto` IS THE DEFAULT — compaction is not off on an unset step, so this does not
// record "compaction on/off". It records whether a window was CHOSEN or inherited, which
// is the only thing that distinguishes a measured experiment from a run that happened to
// sit under whatever threshold Claude Code picked that week.
//
// Kept as a string rather than a number because `auto` is a legal value: coercing it
// would turn the two states this field exists to separate back into one.
export function parseAutocompact(claudeArgs) {
  if (!claudeArgs) return null;
  // FAIL CLOSED ON A MISSING VALUE, BUT MATCH THE WHOLE VALUE DOMAIN. `\S+` recorded the
  // STRING "--max-turns" into a permanent row on `--autocompact\n--max-turns 150`, which
  // `parseEffort` (`[a-z]+`) and `parseMaxTurns` (`\d+`) both refuse. But `(auto|\d+)` —
  // the first fix — was NARROWER than what the CLI accepts and truncated silently:
  // `300k` became `"300"`, a 1000x error that is entirely plausible to whoever later
  // queries the store, in the one column this field exists to make readable.
  //
  // MEASURED against the CLI the action installs (2.1.278, API pointed at a closed port
  // so nothing was spent), rather than taken from the help text:
  //
  //   accepted: auto, 300000, 300k, 500k, 200, 1M, 1m
  //   rejected: 99k, 2M, noop, -5, 0        (the bound is 100k-1M)
  //
  // So the domain is `auto` | digits | digits+k | digits+m, case-insensitive. The bound
  // is deliberately NOT enforced here: the CLI already rejects an out-of-range value at
  // startup, and a parser that silently dropped one would re-create the truncation this
  // comment exists to record.
  const m = claudeArgs.match(/--autocompact[\s=]+(auto|\d+[km]?)(?=\s|$)/i);
  return m ? m[1].toLowerCase() : null;
}

export function parseModelArg(claudeArgs) {
  if (!claudeArgs) return null;
  const m = claudeArgs.match(/--model[\s=]+([^\s]+)/);
  return m ? m[1] : null;
}

// A row has to be attributable to the configuration that produced it WITHOUT
// reading the workflow file at that commit — otherwise a before/after comparison
// has to reconstruct history to know which side of a change a run sits on.
// Whitespace-normalised so reflowing the YAML block is not a config change.
export function configFingerprint(claudeArgs) {
  const normalized = (claudeArgs ?? "").split(/\s+/).filter(Boolean).sort().join(" ");
  if (!normalized) return null;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

// ------------------------------------------------------ the issue-side size (RA-2137)
//
// WHAT WAS ASKED FOR, measured before a token was spent. The issue-triggered arms
// (`implementer`, `triage-fix`) have no PR at telemetry time, so they carry no
// `changed_lines` and no cost comparison on them could be size-controlled — ~40% of
// fleet spend. The two numbers below describe the REQUEST, which is what makes them a
// candidate control: `num_turns` and the agent's own diff (`produced_lines`) describe
// what the work turned out to cost, so regressing cost on them absorbs the very effect
// being measured.
//
// A CANDIDATE, NOT A CONTROL. `token-trend.mjs` adopts it for an arm only once the rows
// show `log(cost)` rising with it (`validateSizeRegressor` there). Recording it is cheap;
// trusting it is a separate, measured decision.
//
// Paths: a backticked token containing a `/` and ending in `.ext`, optionally followed by
// a `:line` or `:line-line` cite — `src/lib/x.ts`, `docs/a.md:12-40`. Distinct, with a
// leading `./` dropped so one file is not counted twice. A URL (`://`) is not a repo path.
const ISSUE_PATH_RE = /`(?:\.\/)?((?:[\w.@()+[\]-]+\/)+[\w.@()+[\]-]*\.[A-Za-z0-9]+)(?::\d+(?:[-–]\d+)?)?`/g;

export function issueSize(body) {
  if (typeof body !== "string") return { issue_body_chars: null, issue_paths_named: null };
  // CRLF → LF so the same text measures the same whichever client wrote it (the web UI
  // posts CRLF). Code points, not UTF-16 units, so an emoji is one character.
  const text = body.replace(/\r\n/g, "\n");
  const paths = new Set();
  for (const m of text.matchAll(ISSUE_PATH_RE)) {
    if (!m[0].includes("://")) paths.add(m[1]);
  }
  return { issue_body_chars: [...text].length, issue_paths_named: paths.size };
}

// ------------------------------------------------- the run's own diff (RA-2137)
//
// `produced_lines` IS AN OUTCOME, NEVER A REGRESSOR, and never named `changed_lines`.
// On the reviewer the diff is handed to the agent, so its size is exogenous. On the
// implementer THE AGENT WRITES IT: a configuration that makes it write more code raises
// cost and diff size together, so a fit on it would absorb part of the effect — the
// `num_turns` objection, only weaker. Recorded so a change that cuts spend by producing
// less can be seen doing so.
//
// MEASURED FROM THE CHECKOUT'S REFLOG, because the telemetry step's token cannot read a
// PR in this private repo (`contents: read` only) and the run's PR number is not in
// scope. The definition, precisely: the net `git diff --numstat` from the commit HEAD
// sat on before the run's FIRST commit to the commit its LAST commit produced — so a
// stacked branch (checked out from another PR's head) counts only this run's work, an
// amend chain counts once, and switching back to `main` after pushing changes nothing.
// Binary files count 0 (numstat prints `-`). A rebase onto a newer base mid-run would
// count the base's movement too; that is the known over-count.
//
// 0 means the run committed nothing. `null` means it could not be measured (no reflog,
// no git, an unresolvable base) — absent, never zero, as everywhere else on this row.
// `revert` and `rebase (continue)` both create a commit too (RA-2311 review, measured on
// git 2.55): missing either left the tip one commit short on a run that ended with one.
const COMMIT_ENTRY_RE = /^(commit(?: \((?:amend|merge|initial)\))?|cherry-pick|revert|rebase(?: -i)? \((?:pick|squash|fixup|reword|continue)\)):/;

/** @param {string} reflog  `git reflog --format=%H%x09%gs HEAD` (newest first) */
export function producedRange(reflog) {
  const entries = reflog
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const tab = l.indexOf("\t");
      return { sha: l.slice(0, tab), subject: l.slice(tab + 1) };
    });
  if (!entries.length) return null;
  const commits = entries.map((e, i) => (COMMIT_ENTRY_RE.test(e.subject) ? i : -1)).filter((i) => i >= 0);
  if (!commits.length) return { base: null, tip: null };
  const last = Math.min(...commits); // newest-first, so the smallest index is the latest
  const first = Math.max(...commits);
  // The value HEAD held BEFORE the first commit is the next-older entry. A reflog that
  // begins with a commit (no older entry) has no recorded base; use its parent.
  const base = first + 1 < entries.length ? entries[first + 1].sha : `${entries[first].sha}^`;
  return { base, tip: entries[last].sha };
}

/** @param {string} numstat  `git diff --numstat` output */
export function sumNumstat(numstat) {
  let total = 0;
  for (const line of numstat.split("\n")) {
    const [a, d] = line.split("\t");
    if (/^\d+$/.test(a ?? "")) total += Number(a);
    if (/^\d+$/.test(d ?? "")) total += Number(d);
  }
  return total;
}

export function producedLines(cwd) {
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    const range = producedRange(git(["reflog", "--format=%H%x09%gs", "HEAD"]));
    if (range === null) return null;
    if (range.tip === null) return 0;
    return sumNumstat(git(["diff", "--numstat", range.base, range.tip]));
  } catch {
    return null;
  }
}

export function buildRow(result, ctx, classification) {
  const { kind: outcome, why: reason } = classification;
  const base = {
    schema: SCHEMA,
    outcome,
    reason,
    recorded_at: ctx.now,
    agent: ctx.agent,
    workflow: ctx.workflow,
    job: ctx.job,
    run_id: ctx.run_id,
    run_attempt: ctx.run_attempt,
    trigger: ctx.trigger,
    // --- the denominators. Without these a cost is uncomparable across runs.
    commit: ctx.commit,
    pr_number: ctx.pr_number,
    // THE ISSUE THIS RUN WAS DISPATCHED FOR (RA-1517), on the issue-triggered lanes.
    // `pr_number` cannot stand in: `agent-implement` and `agent-triage` fire on
    // `issues`, so their rows have no PR at all, and without this a row cannot be tied
    // back to the work it was spent on. The dispatch sweep charges a re-dispatch
    // attempt per marker comment and has no way to ask whether the run that comment
    // triggered ever reached the model — this field is what makes that askable.
    issue_number: ctx.issue_number,
    // WHAT WAS ASKED FOR (RA-2137): the issue body's length and the repo paths it names,
    // read at telemetry time on the issue-triggered arms — a candidate size control that
    // `token-trend.mjs` adopts only once validated. Null on every arm without an issue.
    issue_body_chars: ctx.issue_body_chars ?? null,
    issue_paths_named: ctx.issue_paths_named ?? null,
    // WHAT THE RUN WROTE (RA-2137) — an OUTCOME, see `producedLines`. Deliberately not
    // `changed_lines`: that name means an exogenous denominator everywhere it is read.
    produced_lines: ctx.produced_lines ?? null,
    additions: ctx.additions,
    deletions: ctx.deletions,
    changed_lines:
      ctx.additions === null || ctx.deletions === null ? null : ctx.additions + ctx.deletions,
    changed_files: ctx.changed_files,
    effort: parseEffort(ctx.claude_args),
    model_arg: parseModelArg(ctx.claude_args),
    // The model the run was CONFIGURED for, read from the init message — distinct from
    // `model`, which is whichever model actually billed most. On an `unavailable` run
    // they differ, and that difference IS the finding.
    configured_model: ctx.configured_model,
    // WHICH ABSENCE IT WAS (RA-1518). `outcome` says `not-reached` for all three shapes;
    // only this says whether there was no file, an unparseable one, or one with no
    // result event. On the row rather than added afterwards, so every row has the same
    // shape — a field present on some rows and absent on others is the thing that makes
    // a store unqueryable.
    execution_file_form: ctx.execution_file_form,
    max_turns: parseMaxTurns(ctx.claude_args),
    autocompact: parseAutocompact(ctx.claude_args),
    // --- the quality half. A cost is not a result: a change that cuts spend and
    // drops a sev:high finding is a regression that looks like a win in every
    // cost column. These come from the CALLER, which already computes them (the
    // reviewer's verdict step, the explorer's filed count) rather than being
    // re-derived here where a failed read would look like "no findings".
    outcome_label: ctx.outcome_label,
    artifacts_filed: ctx.artifacts_filed,
    severities: ctx.severities,
    config_fingerprint: configFingerprint(ctx.claude_args),
  };

  if (!result) {
    return {
      ...base,
      model: null,
      num_turns: null,
      duration_ms: null,
      // Pre-existing violation of the same rule, surfaced by the shape test (RA-1967
      // review): the result-bearing branch has carried this since it was added and this
      // one never did. That is a SHAPE violation only — no row is queryable on this
      // field either way, because `push-run.sh` maps it into neither emitter, exactly as
      // `api_error_status` was before this change. That half is RA-1969, not this PR.
      duration_api_ms: null,
      total_cost_usd: null,
      usage: null,
      models: [],
      permission_denials: null,
      subagents: null,
      terminal_reason: null,
      // PRESENT AND NULL, NOT ABSENT (RA-1967 review). The uniform-shape rule is asserted
      // twenty-five lines above this branch — "a field present on some rows and absent
      // on others is the thing that makes a store unqueryable" — and a `not-reached`
      // row already carries `terminal_reason: null` and `is_error: null` for exactly
      // that reason. Omitting it also split `buildRow`'s return union, so `tsc` refused
      // any read of `row.api_error_status`.
      is_error: null,
      api_error_status: null,
    };
  }

  const models = normalizeModels(result);
  const s = result.subagent_stats ?? {};
  return {
    ...base,
    model: primaryModel(models),
    num_turns: num(result.num_turns),
    duration_ms: num(result.duration_ms),
    duration_api_ms: num(result.duration_api_ms),
    terminal_reason: result.terminal_reason ?? null,
    total_cost_usd: num(result.total_cost_usd),
    usage: normalizeUsage(result),
    models,
    permission_denials: Array.isArray(result.permission_denials)
      ? result.permission_denials.length
      : null,
    subagents: {
      spawned: num(s.spawned),
      completed: num(s.completed),
      failed: num(s.failed),
      max_depth: num(s.max_depth),
    },
    is_error: result.is_error === true,
    api_error_status: result.api_error_status ?? null,
  };
}

// ------------------------------------------------------------- step summary
const money = (v) => (v === null ? "—" : `$${v.toFixed(4)}`);
const int = (v) => (v === null ? "—" : v.toLocaleString("en-US"));

export function renderSummary(row) {
  const lines = [`### Agent telemetry — \`${row.agent}\``, ""];

  if (row.outcome === "not-reached") {
    lines.push(
      `> **NOT REACHED** — ${row.reason}.`,
      ">",
      // WHICH absence, in the summary too. `classifyResult` answers "the agent
      // produced no result file" for all three shapes — a sentence that is FALSE when
      // a file exists but carries no result event. Round 2's finding was that this
      // distinction reached the summary and stopped there; moving it to the store
      // without leaving it here would just invert that.
      `> Execution file: \`${row.execution_file_form ?? "unknown"}\`.`,
      ">",
      "> An absence of measurement, not a measurement of zero. The run may have cost",
      "> anything; nothing here says it cost nothing.",
      "",
    );
  } else if (row.outcome === "failed") {
    lines.push(
      `> **FAILED** — ${row.reason}.`,
      ">",
      "> Excluded from cost comparisons: a run that died partway is not a sample of",
      "> the same thing as a run that finished. Check the agent step's log for the cause",
      "> (an API outage looks exactly like this — one turn, cents, no output).",
      "",
    );
  } else if (row.outcome === "exhausted") {
    // A REGRESSION IF OMITTED, not a new nicety. These runs were `failed` before RA-1781
    // and carried that branch's exclusion banner; splitting the kind off without a
    // branch here leaves the truncated runs with no banner at all — and this is the
    // shape `parseMaxTurns` above says most needs saying, because a run cut off at its
    // cap reads as a cheap one and drags every median it lands in.
    //
    // TWO CAPS END IN THIS KIND, and the banner must name the right one. Since RA-1879 the
    // dollar cap (`--max-budget-usd`) classifies `exhausted` too — same advice, so same
    // kind — and `classifyResult`'s `why` (this row's `reason`) is the only thing that
    // says which. A budget stop reading "stopped at its turn cap" would send the reader
    // to raise `--max-turns`, which changes nothing about a run that ran out of dollars.
    const budget = /--max-budget-usd/.test(String(row.reason ?? ""));
    lines.push(
      `> **EXHAUSTED** — ${row.reason}.`,
      ">",
      budget
        ? "> Stopped at its dollar cap, so the work was truncated rather than finished."
        : "> Stopped at its turn cap, so the work was truncated rather than finished.",
      "> Excluded from cost comparisons for the same reason `failed` is — a run cut off",
      "> partway is not a sample of the same thing as one that ran to completion, and its",
      budget
        ? "> cost is a floor, not a total. A plain re-run spends the same dollars against the"
        : "> cost is a floor, not a total. A plain re-run spends the same turns against the",
      budget
        ? "> same cap: read the transcript for the runaway first, then split the work or raise the cap (RA-1879)."
        : "> same cap: either the work needs splitting or the cap needs raising (RA-1781).",
      "",
    );
  } else if (row.outcome === "unavailable") {
    lines.push(
      `> **UNAVAILABLE** — ${row.reason}.`,
      ">",
      "> The configured model never ran: a usage cap, an API outage, or a bad model id /",
      "> expired token. Excluded from cost comparisons — and re-dispatching walks into",
      "> the same wall, so this is a wait, not a retry.",
      "",
    );
  }

  lines.push("| | |", "|---|---|");
  lines.push(`| outcome | \`${row.outcome}\` |`);
  lines.push(`| cost | ${money(row.total_cost_usd)} |`);
  lines.push(`| turns | ${int(row.num_turns)} |`);
  lines.push(`| model | ${row.model ?? row.model_arg ?? "—"} |`);
  lines.push(`| effort | ${row.effort ?? "*unset — inherits xhigh*"} |`);
  if (row.usage) {
    lines.push(`| input / output | ${int(row.usage.input_tokens)} / ${int(row.usage.output_tokens)} |`);
    lines.push(
      `| cache read / written | ${int(row.usage.cache_read_input_tokens)} / ${int(row.usage.cache_creation_input_tokens)} |`,
    );
  }
  if (row.pr_number) {
    lines.push(`| PR | #${row.pr_number} (${int(row.changed_lines)} lines, ${int(row.changed_files)} files) |`);
  }
  if (row.issue_number) {
    const size = row.issue_body_chars == null
      ? "size unread"
      : `${int(row.issue_body_chars)} chars, ${int(row.issue_paths_named)} paths named`;
    lines.push(`| issue | #${row.issue_number} (${size}) |`);
  }
  if (row.produced_lines != null) lines.push(`| produced | ${int(row.produced_lines)} lines committed |`);
  if (row.usage) {
    lines.push(`| total prompt | ${int(row.usage.total_input_tokens)} tokens |`);
    lines.push(`| thinking | ${int(row.usage.thinking_tokens)} tokens |`);
  }
  if (row.max_turns !== null && row.num_turns !== null) {
    const hit = row.num_turns >= row.max_turns ? " **— cap reached**" : "";
    lines.push(`| turn budget | ${int(row.num_turns)} of ${int(row.max_turns)}${hit} |`);
  }
  if (row.outcome_label) lines.push(`| verdict | ${row.outcome_label} |`);
  if (row.artifacts_filed !== null) lines.push(`| filed | ${int(row.artifacts_filed)}${row.severities ? ` (${row.severities})` : ""} |`);
  if (row.permission_denials) {
    lines.push(`| permission denials | **${row.permission_denials}** |`);
  }
  if (row.subagents && row.subagents.spawned > 0) {
    lines.push(
      `| subagents | ${row.subagents.spawned} spawned, ${row.subagents.failed} failed, depth ${row.subagents.max_depth} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ------------------------------------------------------------------ context
function intOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function readContext(args, env) {
  return {
    now: env.TELEMETRY_NOW || new Date().toISOString(),
    agent: args.agent || env.GITHUB_JOB || "unknown",
    workflow: env.GITHUB_WORKFLOW || null,
    job: env.GITHUB_JOB || null,
    run_id: env.GITHUB_RUN_ID || null,
    trigger: env.GITHUB_EVENT_NAME || null,
    run_attempt: env.GITHUB_RUN_ATTEMPT || null,
    commit: args.commit || env.TELEMETRY_COMMIT || env.GITHUB_SHA || null,
    pr_number: intOrNull(args.pr_number ?? env.TELEMETRY_PR),
    additions: intOrNull(args.additions ?? env.TELEMETRY_ADDITIONS),
    deletions: intOrNull(args.deletions ?? env.TELEMETRY_DELETIONS),
    changed_files: intOrNull(args.changed_files ?? env.TELEMETRY_CHANGED_FILES),
    claude_args: args.claude_args ?? env.TELEMETRY_CLAUDE_ARGS ?? null,
    configured_model: null,
    execution_file_form: null,
    outcome_label: args.outcome_label || env.TELEMETRY_OUTCOME_LABEL || null,
    issue_number: intOrNull(args.issue_number ?? env.TELEMETRY_ISSUE_NUMBER),
    issue_body_chars: null,
    issue_paths_named: null,
    produced_lines: null,
    artifacts_filed: intOrNull(args.artifacts_filed ?? env.TELEMETRY_ARTIFACTS_FILED),
    severities: args.severities || env.TELEMETRY_SEVERITIES || null,
  };
}

export function run(args, env) {
  const ctx = readContext(args, env);
  const path = args.execution_file && args.execution_file !== "true" ? args.execution_file : null;

  // BOTH READS GO THROUGH THE SHARED PARSER. A missing or unreadable file yields no
  // objects, which `classifyResult` reports as `not-reached` — the same answer the
  // `if: failure()` arms give, rather than a second opinion from a second reader.
  const result = path ? readResult(path) : null;
  const configuredModel = path ? readConfiguredModel(path) : "";

  // WHICH ABSENCE IT WAS (RA-1518). `classifyResult` answers `not-reached` for all three,
  // which is the right ADVICE but not enough to diagnose weeks later — and weeks later
  // is the only time anyone reads these rows: Actions logs 410 within ~3 days, after
  // which the store row is the sole surviving record, and it is permanent. Derived from
  // the shared parser rather than a second reader of our own, so the two cannot disagree
  // about what the file contained.
  let form = "ok";
  if (!path) {
    form = "no-path";
  } else if (!result) {
    let raw;
    try { raw = readFileSync(path, "utf8"); } catch { raw = null; }
    if (raw === null) form = "absent";
    else if (parseObjects(raw).length === 0) form = "unparseable";
    else form = "no-result-event";
  }

  // THE ISSUE-SIDE SIZE (RA-2137), from the body file the action wrote — only on a row that
  // names an issue, so a body file left over from anything else cannot label a PR arm.
  const bodyFile = args.issue_body_file ?? env.TELEMETRY_ISSUE_BODY_FILE;
  if (ctx.issue_number !== null && bodyFile && bodyFile !== "true") {
    let body;
    try { body = readFileSync(bodyFile, "utf8"); } catch { body = null; }
    Object.assign(ctx, issueSize(body));
  }
  // …AND THE RUN'S OWN DIFF, on the same arms and only when the run produced a result:
  // a `not-reached` run committed nothing because it never ran, which is not a 0.
  if (ctx.issue_number !== null && result && (args.measure_produced ?? env.TELEMETRY_MEASURE_PRODUCED) === "1") {
    ctx.produced_lines = producedLines(args.workdir ?? env.TELEMETRY_WORKDIR ?? process.cwd());
  }

  ctx.configured_model = configuredModel || null;
  const model = configuredModel || parseModelArg(ctx.claude_args) || "";
  ctx.execution_file_form = form;
  return buildRow(result, ctx, classifyResult(result, model));
}

// --------------------------------------------------------------------- main
const isMain = process.argv[1] && process.argv[1].endsWith("agent-telemetry.mjs");
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const row = run(args, process.env);
  const json = JSON.stringify(row, null, 2);

  if (args.out && args.out !== "true") writeFileSync(args.out, json);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderSummary(row));
  }
  process.stdout.write(`${json}\n`);

  // NEVER FAILS THE JOB. Telemetry is an observer; a broken observer must not
  // turn a good agent run red. The `not-reached` outcome is how a failure here
  // becomes visible instead.
  process.exit(0);
}
