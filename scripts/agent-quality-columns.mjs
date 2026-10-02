#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
//
// Derive an agent run's QUALITY columns — what it decided, what it filed, at what
// severity — for the telemetry row (RA-1504).
//
// WHY THIS EXISTS. RA-1485 records what a run COST. A cost alone cannot judge any of the
// changes it is being collected for: dropping `--effort`, moving an arm to a cheaper
// model or trimming a playbook all reduce spend, and whether any of them SHOULD ship
// depends on whether high-severity recall held. A saving with a recall regression looks
// like a win in every cost column, and there is no column in which it currently looks
// like anything else.
//
// DERIVED FROM GITHUB, NEVER FROM THE AGENT. Two reasons, and the second is the one
// that decided the design:
//
//   · Trust. The repo's convention is that the workflow derives the metric and the
//     agent does not (`agent-code-audit.yml` says exactly that about `duration_ms`).
//     A self-reported tally is a claim; a review event and an issue label are facts.
//   · The BASELINE. Asking an arm to report its own tally means editing its prompt,
//     which changes `claude_args`, which changes the `config_fingerprint` every cost
//     comparison keys on — and the whole point of these columns is to make the RA-1508
//     effort comparison falsifiable. Instrumenting the experiment must not perturb it.
//
// So this reads reviews and issues with the default token and writes step outputs.
// Nothing here touches a prompt, a model, a turn cap or an effort level.
//
// Usage:
//   agent-quality-columns.mjs --pr <n> --head <sha> [--reviewer <slug>]   (default: the App register's Reviewer row, RA-2701)
//   agent-quality-columns.mjs --filed-since <iso> --label agent:explorer
//
// A lane whose artifact is a PR rather than an issue (triage, RA-1627) is counted by
// `agent-quality-prs.mjs` instead — a separate file ON PURPOSE, see its header.
//
// ABSENT MEANS UNKNOWN, NEVER ZERO — the same three-state discipline RA-1485 applies to
// cost. A read that fails emits NOTHING for that column rather than a 0, because "no
// issues were filed" and "we could not tell" are different facts and a row that
// conflates them cannot be used to judge recall.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { appLogin } from "./app-register.mjs";

const args = (() => {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 1) {
    if (!a[i].startsWith("--")) continue;
    const k = a[i].slice(2).replace(/-/g, "_");
    out[k] = a[i + 1] && !a[i + 1].startsWith("--") ? a[(i += 1)] : "true";
  }
  return out;
})();

const REPO = process.env.REPO || process.env.GITHUB_REPOSITORY;
const gh = (argv) => execFileSync("gh", argv, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

/** The severity tally, in ONE place — the issue's fourth acceptance criterion. */
export function tallySeverities(labelSets) {
  const order = ["critical", "high", "medium", "low"];
  const counts = new Map(order.map((k) => [k, 0]));
  for (const labels of labelSets) {
    for (const name of labels) {
      const m = /^sev:(critical|high|medium|low)$/.exec(String(name));
      if (m) counts.set(m[1], counts.get(m[1]) + 1);
    }
  }
  // Only non-zero bands, so an empty tally is an empty STRING rather than a row of
  // zeros that reads as a measured absence.
  return order.filter((k) => counts.get(k) > 0).map((k) => `${k}:${counts.get(k)}`).join(",");
}

/**
 * The verdict this run posted on this exact commit.
 *
 * @param {{ pr: string | number, head: string, reviewer?: string }} opts
 * @param {(argv: string[]) => string} [run]
 * @returns {string | null} null when the read FAILED — distinct from "no verdict".
 */
export function readVerdict({ pr, head, reviewer }, run = gh) {
  try {
    // Resolved inside the try (RA-2701): an unreadable register is a failed read — null —
    // exactly like an API error, never a crash of the step.
    reviewer ??= appLogin("Reviewer");
    const out = run(["api", `repos/${REPO}/pulls/${pr}/reviews?per_page=100`,
      "--jq", `[.[] | select(.commit_id == "${head}")`
        + ` | select(.user.login | startswith("${reviewer}"))`
        + ` | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED")]`
        + ` | last | .state // empty`]);
    const state = out.trim().split("\n").pop() ?? "";
    return state || null;
  } catch {
    return null;
  }
}

/**
 * Issues this run filed, by the marker the prompts already require them to write.
 *
 * @param {{ marker?: string | null, since?: string | null, label?: string | null }} opts
 *   `marker` for a PR-scoped arm ("Surfaced by PR #N"); `since` + `label` for the arms
 *   that file without a PR. Typed here rather than inferred from defaults, so a partial
 *   call site type-checks — `tsc` reads this file.
 * @param {(argv: string[]) => string} [run]
 * @returns {{ count: number, severities: string } | null} null when the read FAILED,
 *   which is not the same fact as `{count: 0}` and must not be stored as one.
 */
export function readFiled({ marker = null, since = null, label = null }, run = gh) {
  // BOTH, WHEN BOTH ARE KNOWN. The marker alone matches every issue ANY review of
  // that PR ever filed, and the reviewer is the arm that re-runs most — once per push.
  // On PR RA-1596 the 19:02 run filed one issue (RA-1604) and the unbounded marker matches
  // two, because the 13:35 run had filed RA-1597; a PR reviewed five times would report
  // growing counts for runs that filed nothing.
  //
  // That is the same over-count this file already refuses on the other arms, arriving
  // through a re-review rather than a per-issue trigger. The marker keeps its
  // precision; `since` adds the per-run scope.
  const clauses = [`repo:${REPO}`, "is:issue"];
  if (marker) clauses.push(`"${marker}" in:body`);
  if (label) clauses.push(`label:${label}`);
  if (since) clauses.push(`created:>=${since}`);
  const q = clauses.join(" ");
  try {
    // `--state all` IS LOAD-BEARING, not tidiness. `gh issue list --search` folds
    // `state:open` into the query unless told otherwise, so every artifact a human has
    // since CLOSED disappears from the count. Measured on this repo 2026-09-05:
    // `label:agent:explorer` returns 5 open and 61 across all states, and PR RA-1596's
    // marker returned [1597] where the truth is [1597, 1604] — RA-1604 had been closed.
    //
    // A row that is re-derivable only until someone closes an issue is not a durable
    // measurement, and RA-1504 deferred this half of the row precisely BECAUSE quality
    // signals were supposed to stay queryable indefinitely.
    const out = run(["issue", "list", "--repo", REPO, "--state", "all", "--search", q,
                     "--limit", "100", "--json", "number,labels"]);
    const issues = JSON.parse(out);
    return { count: issues.length, severities: tallySeverities(issues.map((i) => i.labels.map((l) => l.name))) };
  } catch {
    return null;
  }
}

function emit(name, value) {
  // Absent stays absent: an unset output is how "unknown" reaches the telemetry row,
  // and `agent-telemetry.mjs` already omits an absent column from the store.
  if (value === null || value === undefined || value === "") return;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(`${name}=${value}`);
}

const isMain = process.argv[1] && process.argv[1].endsWith("agent-quality-columns.mjs");
if (isMain) {
  if (!REPO) throw new Error("REPO / GITHUB_REPOSITORY is unset");

  if (args.pr && args.head) {
    emit("outcome_label", readVerdict({ pr: args.pr, head: args.head, reviewer: args.reviewer || undefined }));
  }
  // `--no-filed`: record the verdict but emit NO filed columns. Used when a caller
  // cannot establish this run's window — an unset column is the honest outcome, and a
  // count scoped to the wrong window is exactly the over-count this file refuses.
  const filed = args.no_filed ? null : readFiled({
    marker: args.marker || (args.pr ? `Surfaced by PR #${args.pr}` : null),
    since: args.filed_since,
    label: args.label,
  });
  if (filed) {
    emit("artifacts_filed", String(filed.count));
    emit("severities", filed.severities);
  }
  // NEVER FAILS THE CALLER. These columns are an observer of the run, like the
  // telemetry they feed; a quality read that reds a good agent run would invert the
  // rule docs/observability.md §8 records.
  process.exit(0);
}
