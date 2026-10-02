#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// RA-1089 — every label this pipeline APPLIES must exist in the repo.
//
// `qa:verify` did not. It was load-bearing in phase 5 — it is what excludes the
// verification issue from the work view — and `gh issue create --label qa:verify`
// fails outright, so the phase would have died at the moment of filing. Nothing
// could have caught it: a label is a LIVE REPO FACT, and an offline test can only
// assert the constant exists, which was true the whole time it did not.
//
// RA-1004 is the same fault line from the other side: a real repo label containing a
// space was REFUSED by the reconciler's shape regex. The code's idea of a label and
// the repo's have now disagreed in both directions.
//
// WHY THIS SCANS RATHER THAN READS A LIST. A declared list (`.github/labels.yml`)
// is checkable offline and drifts silently — it becomes a third opinion about what
// a label is. The repo is the only authority, so this asks it.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { isRoadmapMilestone } from './lib/milestones.mjs';

const REPO = process.env.REPO ?? process.env.GITHUB_REPOSITORY;

/** Where a label can be applied from. Prompts count: an agent told to apply a
 *  label it cannot apply fails mid-run, having already done the work. */
// `.github/ISSUE_TEMPLATE` and `.github/scripts` were both outside this and both
// attach labels (RA-1101): the issue forms declaratively via a `labels:` key, and the
// scripts through `gh issue edit --add-label`. A label writer the guard cannot see is
// exactly the RA-1089 defect it exists to catch, one directory over.
export const SCAN = ['.github/workflows', '.github/ISSUE_TEMPLATE', '.github/scripts', 'scripts/qa', 'docs/qa'];

/** This file's own examples are not applications. The first run flagged `foo`,
 *  `x` and `later` from its own docstrings — a tool reporting its documentation as
 *  a defect, the same shape as `verify-acs.test.ts` counting as its own coverage
 *  (RA-1068). Excluded by NAME, so a rename cannot silently re-poison it. */
const NOT_A_WRITER = ['scripts/qa/label-guard.mjs', 'tests/unit/label-guard.test.ts'];

/**
 * Comments removed. `# … the flag label and the comment` is PROSE ABOUT labels,
 * and reading it as `--label and` is the same mistake as every other one this
 * pipeline has made this week: a document containing a token treated as using it.
 *
 * Deliberately crude — `#` and `//` to end of line, and `/* … *\/` blocks. A
 * `--label` inside a string that merely looks like a comment is not a case that
 * arises here, and a real parser would be a second thing to get wrong.
 *
 * A block comment is BLANKED, not removed: its newlines stay, so every line after a
 * multi-line one keeps its number, and a finding reported as `file:line` points at
 * the line it is about (RA-2386 review).
 */
export const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|\s)(#|\/\/)\s.*$/, ''))
    .join('\n');

/**
 * Every label this repo's automation applies, with where it came from.
 *
 * Three shapes, because the pipeline writes labels three ways:
 *   `--label x` / `--add-label x`     a gh invocation, in YAML or a script
 *   const NAME = 'agent:implement'    a script constant, used with --label later
 *   Labels: `bug`, `agent:explorer`   a PROMPT telling an agent what to apply
 *
 * @param {string[]} dirs
 */
export function appliedLabels(dirs = SCAN, root = process.cwd()) {
  const out = new Map();
  const add = (label, file) => {
    if (!out.has(label)) out.set(label, new Set());
    out.get(label).add(file);
  };

  for (const dir of dirs) {
    for (const file of walk(join(root, dir))) {
      const rel = file.slice(root.length + 1);
      if (NOT_A_WRITER.includes(rel)) continue;
      const text = stripComments(readFileSync(file, 'utf8'));

      // `--label foo` / `--add-label foo`, quoted or bare, in YAML or JS.
      //
      // THE INTERPOLATION GUARD IS LIVE NOW (RA-1107). It read `if
      // (!m[1].startsWith('$'))` against a capture of `([a-z][a-z0-9:_-]*)`, which
      // cannot begin with `$` — dead code, and only half the intent served. The
      // Actions form `${{ … }}` matched nothing and was fine; the SHELL form
      // `--label sev:${SEV}` captured the literal prefix `sev:`, which is not a label,
      // does not exist in the repo, and failed the build naming a file that is
      // correct. "A red run for the wrong reason is worse than none" is this file's
      // own argument at `:103-105`; this was a way to violate it.
      //
      // The class is widened to SEE the interpolation, then the match is rejected —
      // which is what makes the guard do something.
      for (const m of text.matchAll(/--(?:add-)?label[=\s]+['"]?([a-z][a-z0-9:_${}-]*)['"]?/g)) {
        if (/[${}]/.test(m[1])) continue;
        add(m[1], rel);
      }
      // Issue forms attach labels declaratively — a `labels:` list under a form's
      // front matter, with no `gh` call for the patterns above to find (RA-1101).
      //
      // THREE SHAPES, because GitHub accepts three (RA-1299): a block list, a flow
      // sequence, and — the one its own docs use for MARKDOWN templates — a bare
      // comma-separated scalar, `labels: bug, needs:human`. The scalar reader is last
      // in the chain and cannot shadow the other two: its first character may not be
      // whitespace (so `labels:` + newline, the block header, is out), `[` (the flow
      // form), `-`, or a YAML block-scalar indicator. A reader that shadowed a working
      // one would be a red build naming a correct file, which is worse than no check.
      // Nor may it start a YAML null, alias, anchor or tag (`~`, `*`, `&`, `!`), and a
      // bare `null` is no labels — each would otherwise be reported as a missing label.
      //
      // A MARKDOWN template is read from its FRONT MATTER only: its body is prose, and
      // a body line reading `labels: see triage below` is not a declaration.
      if (rel.startsWith('.github/ISSUE_TEMPLATE/')) {
        const form = rel.endsWith('.md') ? `${text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''}\n` : text;
        const block = form.match(/^labels:\s*\n((?:\s*-\s*.+\n)+)/m)
          ?? form.match(/^labels:\s*\[([^\]]*)\]/m)
          ?? form.match(/^labels:[ \t]*(?!null[ \t]*$)([^\s[\-|>~*&!][^\n]*)$/m);
        for (const raw of (block?.[1] ?? '').split(/\n|,/)) {
          const name = raw.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, '');
          if (name && !/[${}]/.test(name)) add(name, rel);
        }
      }
      // A PROMPT's bare label list — `Labels: bug, agent:explorer, qa:needs-triage` —
      // with no backticks for the literal reader below to anchor on. The
      // targeted-invariant prompt in agent-verify-acs.yml files Explorer bugs in exactly
      // this shape and was invisible here, so the one file that applies `agent:explorer`
      // without quoting it could not be checked by anything keyed on who applies it
      // (RA-1633). Only NAMESPACED tokens after `Labels:` on the same line are read —
      // including `signal:`, which these lists apply and nothing else checked: `bug` and
      // `and a` are words, and `sev:*` is a placeholder, not a label. A list wrapped onto
      // the next line is not followed; its backticked entries are the literal reader's.
      for (const line of text.match(/\bLabels:[^\n]*/g) ?? []) {
        for (const m of line.matchAll(/(?<![\w:`'"-])(agent|qa|sev|signal):([a-z][a-z0-9-]*)(?![\w:*-])/g)) {
          add(`${m[1]}:${m[2]}`, rel);
        }
      }
      // A namespaced literal anywhere: constants, prompt text, jq filters. The
      // namespace is what makes this precise — `agent:`, `qa:` and `sev:` are this
      // pipeline's, and an ordinary word is not a label.
      for (const m of text.matchAll(/['"`](agent|qa|sev):([a-z][a-z0-9-]*)['"`]/g)) {
        add(`${m[1]}:${m[2]}`, rel);
      }
    }
  }
  return out;
}

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ya?ml|mjs|js|md)$/.test(e)) out.push(p);
  }
  return out;
}

/** What the repo actually has. NOT swallowed: an unreadable label list is a
 *  permissions problem, and reporting "no labels" would fail every label in the
 *  repo — a red run for the wrong reason is worse than none.
 *
 *  A FULL READ OR A LOUD FAILURE (RA-1107). `gh label list --limit N` returns a PREFIX
 *  when the cap is hit — no error, no warning — so every label past it would be
 *  reported missing, naming files that are correct. Raising the number only moves
 *  that cliff; a read that comes back AT the cap is treated as truncated and throws,
 *  which `main()` turns into exit 2 exactly like any other unreadable list. */
export const LABEL_READ_CAP = 1000;

export function liveLabels(repo = REPO, run = ghJson) {
  const names = run(['label', 'list', '--repo', repo, '--limit', String(LABEL_READ_CAP), '--json', 'name']).map((l) => l.name);
  assertUntruncated(names.length, LABEL_READ_CAP, 'label list');
  return new Set(names);
}

export const missing = (applied, live) =>
  [...applied.entries()].filter(([label]) => !live.has(label));

/** Shared by every capped read here: at the cap is indistinguishable from past it. */
export function assertUntruncated(count, cap, what) {
  if (count >= cap) {
    throw new Error(`the ${what} came back with ${count} entries, which is the read cap — it may be truncated, and a partial read would report real entries as absent`);
  }
}

const ghJson = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) || 'null');

// ── Explorer bugs never sit on a roadmap milestone (RA-1633) ──────────────────
//
// AGENTS.md: Explorer bugs (`agent:explorer`) "never enter the gate at any severity" —
// an incoming bug stream in a finite, completable milestone destroys the denominator
// that makes "27 of 38 done" mean anything. Until this, the rule was PROMPT PROSE in
// the workflows that file those bugs, and the backstop could not reach it: `decide()`
// in issue-triage-defaults.mjs acts only on a BARE issue, and the Explorer files with
// `--milestone`, so its `agent:explorer` exclusion never runs on the path that files.
//
// A ROADMAP MILESTONE IS RECOGNISED BY ITS DUE DATE, NEVER BY NAME. Naming the gate
// here would be one more copy of a string this repo is de-duplicating (RA-691, RA-1616),
// and it goes stale the day the gate moves. `isRoadmapMilestone` is the one definition
// (weekly-digest.mjs, RA-1638): open and dated. ⚠️ The due-date convention is a WRITTEN
// rule in AGENTS.md since 2026-09-24 ("Each carries a due date"), but still no check
// enforces it — a roadmap milestone created WITHOUT a due date reads as a bucket here
// and in the digest alike, because no mechanical test can tell an undated roadmap
// milestone from a bucket without naming one.
//
// TWO LAYERS, because the two failures arrive by different routes:
//   · STATIC — a file that applies `agent:explorer` must not also APPLY a roadmap
//     milestone. Catches prompt drift, which is the cause.
//   · LIVE — no open `agent:explorer` issue sits on a roadmap milestone where an AGENT
//     put it. Catches bad state that arrived some other way.

/** The open milestones, as the REST API reports them. */
export function liveMilestones(repo = REPO, run = ghJson) {
  const pages = run(['api', '--paginate', '--slurp', `repos/${repo}/milestones?state=open&per_page=100`]);
  return pages.flat().map((m) => ({ title: m.title, due_on: m.due_on ?? null, state: m.state }));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Which of `titles` each scanned file APPLIES, as `file -> Set<title>`.
 *
 * ONLY THE APPLYING SHAPES, so the rule being STATED does not read as the rule being
 * broken. agent-explore.yml says `milestone "Product Backlog" (a product bug; never the
 * "Production Ready" gate)` — a naive substring check reddens on the very sentence that
 * documents the invariant, which is the guard-that-cries-wolf RA-691 warned about. The
 * shapes are the ones that assign:
 *   `--milestone X` / `--milestone "X"` / `--milestone=X`   a gh invocation
 *   `Milestone: X` / `**Milestone:** X` / `milestone "X"`   a prompt or brief
 * i.e. the milestone keyword IMMEDIATELY followed by the title. A title that follows
 * other words ("never the X gate") is prose about it.
 *
 * The titles come from the LIVE milestone list, so nothing here names one.
 */
export function appliedMilestones(titles, dirs = SCAN, root = process.cwd()) {
  const out = new Map();
  for (const [rel, hits] of milestoneApplications(titles, dirs, root)) out.set(rel, new Set(hits.map((h) => h.title)));
  return out;
}

/**
 * The same, with the LINE of each application: `file -> [{title, line}]`.
 *
 * The keyword must carry a colon or be followed by a quote or bold — `Milestone: X`,
 * `**Milestone:** X`, `milestone "X"`, `milestone **X**` — and may not reach across a
 * line. So
 * "never put one on the milestone Production Ready" is prose and does not match, and
 * neither does a `### Milestone` heading with a title on the line below it.
 */
export function milestoneApplications(titles, dirs = SCAN, root = process.cwd()) {
  const out = new Map();
  if (!titles.length) return out;
  const alt = titles.map(escapeRe).sort((a, b) => b.length - a.length).join('|');
  const re = new RegExp(`(?:--milestone(?:=|[ \\t]+)|\\bmilestone(?::[* \\t]*|[ \\t]+(?=["'\`*])\\**))["'\`]?(${alt})(?![\\w-])`, 'gi');
  for (const dir of dirs) {
    for (const file of walk(join(root, dir))) {
      const rel = file.slice(root.length + 1);
      if (NOT_A_WRITER.includes(rel)) continue;
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const m of text.matchAll(re)) {
        const title = titles.find((t) => t.toLowerCase() === m[1].toLowerCase());
        if (!out.has(rel)) out.set(rel, []);
        out.get(rel).push({ title, line: lineOf(text, m.index) });
      }
    }
  }
  return out;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

export const EXPLORER_LABEL = 'agent:explorer';

/**
 * How far apart, in lines, a label list and a milestone can be and still describe ONE
 * filing. Every Explorer filing instruction in the repo today puts them within 3 lines
 * of each other (agent-explore.yml, agent-verify-acs.yml, agent-code-audit.yml,
 * explorer-playbook.md). Pairing per FILE instead would redden a correct document
 * that files Explorer bugs in one section and gate-bound reviewer follow-ups in
 * another — reviewer-playbook.md already names `agent:explorer`.
 */
export const PAIRING_WINDOW = 6;

/**
 * Static layer: `[file, roadmapTitle, line]` for every roadmap-milestone application
 * that sits within PAIRING_WINDOW lines of an `agent:explorer` in a file that applies it.
 *
 * @param {Map<string, Set<string>>} applied            appliedLabels()
 * @param {Map<string, {title: string, line: number}[]>} applications  milestoneApplications()
 * @param {{title: string, due_on: string|null, state?: string}[]} milestones
 */
export function explorerRoadmapWriters(applied, applications, milestones, root = process.cwd()) {
  const roadmap = new Set(milestones.filter(isRoadmapMilestone).map((m) => m.title));
  const out = [];
  for (const file of applied.get(EXPLORER_LABEL) ?? []) {
    const hits = (applications.get(file) ?? []).filter((h) => roadmap.has(h.title));
    if (!hits.length) continue;
    const lines = stripComments(readFileSync(join(root, file), 'utf8')).split('\n');
    const explorerLines = lines.flatMap((l, i) => (l.includes(EXPLORER_LABEL) ? [i + 1] : []));
    for (const h of hits) {
      if (explorerLines.some((n) => Math.abs(n - h.line) <= PAIRING_WINDOW)) out.push([file, h.title, h.line]);
    }
  }
  return out;
}

/** A GitHub actor that is an automation rather than a person. */
export const isAgentActor = (actor) =>
  actor?.type === 'Bot' || /\[bot\]$/.test(actor?.login ?? '');

/**
 * Live layer: open `agent:explorer` issues on a roadmap milestone that an AGENT put
 * there. `issues` carry `placedBy`, the actor of their LAST `milestoned` event.
 *
 * A PERSON'S PLACEMENT IS NOT A VIOLATION. Assigning work to a roadmap milestone is
 * the stakeholder's call (AGENTS.md), and the rule is about the incoming stream an
 * agent files — not about what the stakeholder later decides to gate on. Measured
 * 2026-09-24: RA-998 and RA-1576, both `agent:explorer` + `sev:medium`, were moved from
 * Product Backlog to Production Ready BY HAND on 2026-09-12. A check that reddened
 * every pipeline PR over a deliberate human decision would be red for the wrong
 * reason, and would teach people to ignore it.
 */
//
// NO RECORDED PLACEMENT IS NOT A PERSON'S. An issue on a roadmap milestone with no
// readable `milestoned` event cannot be attributed, and excusing it would be treating
// a failed read as a clean one — so it is flagged with the agents'.
//
// ⚠️ The actor is the TOKEN, not the intent. A local agent session using the
// developer's own `gh` login is recorded as that person and is excused here. No
// timeline field distinguishes the two; the static layer is what covers prompts.
export const agentPlacedOnRoadmap = (issues) => issues.filter((i) => !i.placedBy || isAgentActor(i.placedBy));

export const ISSUE_READ_CAP = 1000;

// ── …nor carry `gate-candidate` (RA-2398) ─────────────────────────────────────
//
// `gate-candidate` is how a gate placement is PROPOSED to the stakeholder (RA-1616): a
// human reads it and decides. Explorer bugs never enter the gate at any severity (the
// 2026-09-05 decision on RA-1616), so proposing one is the same violation one step
// earlier. FLAT, unlike the milestone check: there is no human-placement excuse,
// because the label is the proposal, not the decision. Keyed on the literal label
// name — before the label is ever applied the read is simply empty.
export const GATE_CANDIDATE_LABEL = 'gate-candidate';

/** Open `agent:explorer` issues that also carry `gate-candidate`, as issue numbers. */
export function liveExplorerGateCandidates(repo = REPO, run = ghJson) {
  const list = run(['issue', 'list', '--repo', repo, '--label', EXPLORER_LABEL, '--label', GATE_CANDIDATE_LABEL,
    '--state', 'open', '--limit', String(ISSUE_READ_CAP), '--json', 'number']);
  assertUntruncated(list.length, ISSUE_READ_CAP, `open ${EXPLORER_LABEL} + ${GATE_CANDIDATE_LABEL} issue list`);
  return list.map((i) => i.number).sort((a, b) => a - b);
}



export function liveExplorerOnRoadmap(milestones, repo = REPO, run = ghJson) {
  const roadmap = new Set(milestones.filter(isRoadmapMilestone).map((m) => m.title));
  if (!roadmap.size) return [];
  const open = run(['issue', 'list', '--repo', repo, '--label', EXPLORER_LABEL, '--state', 'open',
    '--limit', String(ISSUE_READ_CAP), '--json', 'number,milestone']);
  assertUntruncated(open.length, ISSUE_READ_CAP, `open ${EXPLORER_LABEL} issue list`);
  const onRoadmap = open.filter((i) => roadmap.has(i.milestone?.title));
  return onRoadmap.map((i) => {
    const events = run(['api', '--paginate', '--slurp', `repos/${repo}/issues/${i.number}/timeline?per_page=100`]).flat();
    const last = events.filter((e) => e.event === 'milestoned').at(-1);
    return { number: i.number, milestone: i.milestone.title, placedBy: last?.actor ?? null };
  });
}

// ── The capability label is the ledger's countable projection (RA-1917) ────────
//
// docs/qa/capability-ledger.md: "`open #N` and the `capability` label are two views of
// one cohort, and this column is the source of truth." The Overseer's backlog interlock
// counts the LABEL, so a ledger row reading `open #N` whose issue lacks the label is an
// investigation the interlock cannot see — an under-count, in the UNLOCK direction.
// That is what RA-1909 left behind (RA-1510 named by the row, unlabelled), and nothing
// mechanical compared the two.
//
// ONE DIRECTION ONLY, AND DELIBERATELY. The reverse — a labelled issue whose row is not
// `open #N` — is legitimate: RA-775 and RA-776 read `deferred` and stay open and labelled,
// and the developer closed RA-1423 on 2026-09-24 keeping the cohort exactly as labelled
// ("the threshold and the cohort stay unchanged"). Failing on it would overrule that
// decision, and would push the count DOWN, toward unlocking. It is reported, never
// failed on.
//
// READ-ONLY. Nothing here writes a label, and the interlock's query, threshold and
// cohort (scripts/qa/capability-interlock.mjs) are untouched — this only reports when
// the projection it counts has drifted from the rows it projects.

export const LEDGER = 'docs/qa/capability-ledger.md';
/** What `gh issue view` says for a number that does not resolve (verified live:
 *  "GraphQL: Could not resolve to an issue or pull request with the number of N").
 *  That string ONLY: a bare 404 / "Not Found" is also how GitHub answers a caller
 *  without access, which is an unreadable fact (exit 2), not a bad row. */
export const NOT_FOUND = /Could not resolve to an issue/;
export const CAPABILITY_LABEL = 'capability';

/** Issue numbers the ledger's table rows mark `open #N`, read from the LAST cell
 *  (the Disposition column), so prose elsewhere in a row cannot enrol an issue. */
export function ledgerOpenRows(text) {
  const out = new Set();
  for (const line of text.split('\n')) {
    if (!/^\s*\|/.test(line)) continue;
    // Code spans and escaped pipes are not cell boundaries; splitting on them would
    // make the "last cell" a fragment and drop the row's real disposition.
    const cells = line.trim().replace(/`[^`]*`/g, '').replace(/^\||(?<!\\)\|$/g, '').split(/(?<!\\)\|/);
    const disposition = cells.at(-1) ?? '';
    // `(?<![\w-])`, not `\b`: a hyphen is a word boundary, so `\bopen` read
    // `re-open #N` — a row saying the issue is closed and might come back — as open.
    for (const m of disposition.matchAll(/(?<![\w-])open\s+\[?#(\d+)\b/gi)) out.add(Number(m[1]));
  }
  return out;
}

/**
 * @param {Set<number>} rows      ledger rows reading `open #N`
 * @param {Set<number>} labelled  OPEN issues carrying `capability`
 * @param {(n: number) => 'OPEN'|'CLOSED'|null} stateOf  null = the issue could not be read
 * @returns {{undercount: number[], closed: number[], unrowed: number[], unresolved: number[]}}
 *   `unresolved` — a row naming an issue that cannot be read (mistyped, deleted,
 *   transferred) — fails the run with its OWN message, not a permissions one.
 *   `undercount` fails the run; `closed` (a row still reading open for a closed issue —
 *   stale ledger prose, invisible to the count either way) and `unrowed` (labelled
 *   with no `open #N` row, e.g. a deferred investigation kept open — in the cohort by
 *   the RA-1423 decision) are reported only.
 */
export function cohortDrift(rows, labelled, stateOf) {
  const undercount = [];
  const closed = [];
  const unresolved = [];
  for (const n of [...rows].sort((a, b) => a - b)) {
    if (labelled.has(n)) continue;
    const state = stateOf(n);
    (state === 'OPEN' ? undercount : state === 'CLOSED' ? closed : unresolved).push(n);
  }
  const unrowed = [...labelled].filter((n) => !rows.has(n)).sort((a, b) => a - b);
  return { undercount, closed, unrowed, unresolved };
}

export function liveCohortDrift(repo = REPO, root = process.cwd(), run = ghJson) {
  const rows = ledgerOpenRows(readFileSync(join(root, LEDGER), 'utf8'));
  const list = run(['issue', 'list', '--repo', repo, '--label', CAPABILITY_LABEL, '--state', 'open',
    '--limit', String(ISSUE_READ_CAP), '--json', 'number']);
  assertUntruncated(list.length, ISSUE_READ_CAP, `open ${CAPABILITY_LABEL} issue list`);
  const labelled = new Set(list.map((i) => i.number));
  // Only a NOT-FOUND is the row's defect (null → `unresolved`, exit 1). Any other
  // failure — a 5xx, a rate limit, a dropped connection — says nothing about the row,
  // so it is rethrown and `main()` reports the cohort as unreadable: exit 2, like every
  // other failed read here, rather than "mistyped/deleted?" for a row that is fine.
  const stateOf = (n) => {
    try {
      return run(['issue', 'view', String(n), '--repo', repo, '--json', 'state']).state;
    } catch (err) {
      if (NOT_FOUND.test(`${err?.stderr ?? ''}\n${err?.message ?? ''}`)) return null;
      throw err;
    }
  };
  return cohortDrift(rows, labelled, stateOf);
}

/**
 * Run every check, and let none hide another: each reports on its own, and the exit
 * code is the worst of them. An UNREADABLE fact is exit 2 — never "nothing found",
 * for the reason at the top of `liveLabels`.
 */
const main = () => {
  if (!REPO) {
    console.error('label-guard: REPO or GITHUB_REPOSITORY must be set');
    process.exit(2);
  }
  let status = 0;
  const unreadable = (what, err) => {
    console.error(`label-guard: could not read ${what} — ${String(err.message).split('\n')[0]}
    This needs a token with \`issues: read\`. Refusing to report a failed read as a clean one.`);
    status = Math.max(status, 2);
  };
  const fail = () => { status = Math.max(status, 1); };

  // 1. Every label the automation applies exists (RA-1089).
  const applied = appliedLabels();
  let live = null;
  try { live = liveLabels(); } catch (err) { unreadable("the repo's labels", err); }
  if (live) {
    console.log(`Checked ${applied.size} label(s) applied by this pipeline against ${live.size} in the repo.`);
    const gaps = missing(applied, live);
    if (!gaps.length) {
      console.log('Every label the automation applies exists.');
    } else {
      console.error(`\n${gaps.length} label(s) applied but NOT defined in the repo:\n`);
      for (const [label, files] of gaps) {
        console.error(`  - \`${label}\` — applied by ${[...files].join(', ')}`);
      }
      console.error(`\nA gh call applying one of these fails outright. Create it, or stop applying it.`);
      fail();
    }
  }

  // 2. Explorer bugs never sit on a roadmap milestone (RA-1633).
  let milestones = null;
  try { milestones = liveMilestones(); } catch (err) { unreadable("the repo's milestones", err); }
  if (milestones) {
    const roadmap = milestones.filter(isRoadmapMilestone).map((m) => m.title);
    const writers = explorerRoadmapWriters(applied, milestoneApplications(milestones.map((m) => m.title)), milestones);
    console.log(`\nRoadmap milestones (open, with a due date): ${roadmap.join(', ') || 'none'}.`);
    if (!writers.length) {
      console.log(`No filing instruction pairs \`${EXPLORER_LABEL}\` with one of them.`);
    } else {
      console.error(`\n${writers.length} filing instruction(s) pair \`${EXPLORER_LABEL}\` with a roadmap milestone:\n`);
      for (const [file, title, line] of writers) console.error(`  - ${file}:${line} applies "${title}" beside \`${EXPLORER_LABEL}\``);
      console.error(`\nExplorer bugs never enter a roadmap milestone at any severity (AGENTS.md) — route them to a bucket.`);
      fail();
    }
    try {
      const placed = liveExplorerOnRoadmap(milestones);
      const byAgent = agentPlacedOnRoadmap(placed);
      for (const i of placed.filter((p) => !byAgent.includes(p))) {
        console.log(`  (#${i.number} is on "${i.milestone}", placed by ${i.placedBy?.login ?? 'unknown'} — a person's decision, not a violation.)`);
      }
      if (!byAgent.length) {
        console.log(`No open \`${EXPLORER_LABEL}\` issue sits on a roadmap milestone an agent put it on.`);
      } else {
        console.error(`\n${byAgent.length} open \`${EXPLORER_LABEL}\` issue(s) on a roadmap milestone, placed by an agent:\n`);
        for (const i of byAgent) console.error(`  - #${i.number} on "${i.milestone}", placed by ${i.placedBy?.login ?? 'no recorded milestoned event'}`);
        console.error(`\nMove each to a bucket, and find the prompt or script that put it there.`);
        fail();
      }
    } catch (err) { unreadable(`the open ${EXPLORER_LABEL} issues`, err); }
  }

  // 2b. …and none is proposed for the gate either (RA-2398).
  try {
    const proposed = liveExplorerGateCandidates();
    if (!proposed.length) {
      console.log(`No open \`${EXPLORER_LABEL}\` issue carries \`${GATE_CANDIDATE_LABEL}\`.`);
    } else {
      console.error(`\n${proposed.length} open \`${EXPLORER_LABEL}\` issue(s) carry \`${GATE_CANDIDATE_LABEL}\`: ${proposed.map((n) => `#${n}`).join(', ')}`);
      console.error(`Explorer bugs never enter the gate at any severity (AGENTS.md), so they are never proposed for it. Remove the label.`);
      fail();
    }
  } catch (err) { unreadable(`the open ${EXPLORER_LABEL} + ${GATE_CANDIDATE_LABEL} issues`, err); }

  // 3. The capability label still projects the ledger's `open #N` rows (RA-1917).
  try {
    const { undercount, closed, unrowed, unresolved } = liveCohortDrift();
    if (unresolved.length) {
      console.error(`\n${LEDGER} marks \`open #N\` for issue(s) that could not be read: ${unresolved.map((n) => `#${n}`).join(', ')} — mistyped, deleted or transferred? The interlock cannot count what does not resolve.`);
      fail();
    }
    for (const n of closed) console.log(`  (${LEDGER} still reads \`open #${n}\`, but #${n} is closed — stale prose; the interlock does not count closed issues either way.)`);
    if (unrowed.length) console.log(`  (Labelled \`${CAPABILITY_LABEL}\` with no \`open #N\` row: ${unrowed.map((n) => `#${n}`).join(', ')} — in the cohort as labelled (the RA-1423 decision), so reported, not failed.)`);
    if (!undercount.length) {
      console.log(`\nEvery open issue the capability ledger marks \`open #N\` carries \`${CAPABILITY_LABEL}\`.`);
    } else {
      console.error(`\n${undercount.length} open issue(s) the ledger marks \`open #N\` WITHOUT \`${CAPABILITY_LABEL}\`: ${undercount.map((n) => `#${n}`).join(', ')}`);
      console.error(`The backlog interlock counts the label, so it cannot see these — it under-counts toward unlocking. Label them, or move their rows off \`open #N\`.`);
      fail();
    }
  } catch (err) { unreadable('the capability cohort', err); }

  if (status) process.exit(status);
};

// try/catch, because `pathToFileURL(undefined)` THROWS where the old `file://`
// template merely failed to match — importing this module with no argv[1] crashes.
// The Reviewer caught exactly this on RA-1071 and I wrote the unguarded form again here.
const IS_CLI = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();
if (IS_CLI) main();
