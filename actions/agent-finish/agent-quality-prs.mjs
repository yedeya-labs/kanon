#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter, which does not type-check its scripts.
// Typing it is separate work; a move changes no line it doesn't have to (ADR 0009).
//
// The `artifacts_filed` column for an arm whose artifact is a PR, not an issue (RA-1627).
//
// A SEPARATE FILE FROM `agent-quality-columns.mjs` ON PURPOSE. `permissions-guard.mjs`
// follows the script a `run:` step invokes and reads EVERY `gh` call in it, not just the
// branch that step reaches. Kept in that file, this pulls-API read made the explorer and
// auditor quality steps — which never take this branch — look like they need
// `pull-requests: read`, and granting a scope nothing uses reads as a capability that is
// not in fact there. One file per read shape keeps the guard's attribution exact.
//
// Same contract as its sibling: derived from GitHub, never from the agent; ABSENT MEANS
// UNKNOWN, NEVER ZERO; and it never fails the caller.
//
// Usage:
//   agent-quality-prs.mjs --label agent:triage --opened-since <iso> --issue <n>

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { isCliEntry } from "../../scripts/lib/cli-entry.mjs";

const REPO = process.env.REPO || process.env.GITHUB_REPOSITORY;
const gh = (argv) => execFileSync("gh", argv, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

/**
 * PRs this run opened — for an arm whose artifact is a PR, not an issue (RA-1627).
 *
 * The triage/fix arm files no issue: its output is a PR labelled `agent:triage`. The
 * issue query above reads 0 for it forever (43 PRs carry the label; 1 issue does), which
 * is the not-observable case wearing a measured value. So this counts the PRs instead.
 *
 * THE PULLS LIST, NEVER THE SEARCH API (RA-1628). This runs seconds after the agent opened
 * its PR, inside the search index's lag, so a search would miss the one PR it is here to
 * count. The REST list is not indexed: newest first, filtered on the client.
 *
 * SCOPED TO THE RUN'S OWN ISSUE, not only to its start time. Triage fires once per issue
 * and runs concurrently: RA-1389/RA-1390 were opened 80s apart, and so were RA-1340/RA-1343,
 * RA-1159/RA-1164 and RA-888/RA-891. With a time window alone each of two overlapping runs would
 * count both PRs, which is the over-count this file refuses everywhere else. Every triage
 * PR on record names its issue in the body, so the PR must also reference `#<issue>`.
 * The body, not `closingIssuesReferences`: a follow-up STACKS on its parent's branch, and
 * GitHub only resolves closing keywords on a PR into the default branch.
 *
 * @param {{ label: string, since: string, issue: string | number }} opts
 * @param {(argv: string[]) => string} [run]
 * @returns {{ count: number } | null} null when the read FAILED. A run that opened no PR
 *   (a scope-first bail, `qa:cannot-reproduce`, `qa:false-positive`) is `{count: 0}`: a
 *   measured outcome, and exactly what this column exists to make visible.
 */
export function readOpenedPrs({ label, since, issue }, run = gh) {
  const sinceMs = Date.parse(since);
  if (!label || !issue || Number.isNaN(sinceMs)) return null;
  const ref = new RegExp(`(?<![\\w/&])#${Number(issue)}(?!\\d)`);
  try {
    const out = run(["api", `repos/${REPO}/pulls?state=all&sort=created&direction=desc&per_page=100`]);
    // An error body that parses (`{"message": …}`) has no `.filter`, so it throws into
    // the catch below and stays absent rather than counting as 0.
    const prs = JSON.parse(out);
    const mine = prs.filter((p) => Date.parse(p.created_at) >= sinceMs
      && (p.labels ?? []).some((l) => l.name === label)
      && ref.test(String(p.body ?? "")));
    return { count: mine.length };
  } catch {
    return null;
  }
}

const isMain = isCliEntry(import.meta.url);
if (isMain) {
  try {
    const a = process.argv.slice(2);
    const arg = (name) => { const i = a.indexOf(`--${name}`); return i >= 0 ? a[i + 1] ?? "" : ""; };
    // `severities` is NOT emitted: a fix PR carries no `sev:*`, and borrowing the parent
    // issue's would put the severity of the INPUT in a column that means the severity of
    // the OUTPUT on every other arm.
    const opened = REPO ? readOpenedPrs({ label: arg("label"), since: arg("opened-since"), issue: arg("issue") }) : null;
    if (opened) {
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `artifacts_filed=${opened.count}\n`);
      console.log(`artifacts_filed=${opened.count}`);
    }
    process.exit(0);
  } catch (err) {
    // AN EXCEPTION IN KANON'S OWN CODE (plan 0002 §2.6). The step still fails, as it did before
    // this catch existed, and the telemetry row records Kanon's code for it. The message stays
    // in this log; only the code reaches the row.
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "kanon-error=unhandled\n");
    console.error(err);
    process.exit(1);
  }
}
