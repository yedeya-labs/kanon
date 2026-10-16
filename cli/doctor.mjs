// `kanon doctor` (plan 0005 §5.5, step L10): what an installation of Kanon lacks, read-only.
//
// It reads the repository the way `kanon init` does (cli/init.mjs's `inspect`, and the same
// register and ruleset readers) and compares it with the requirements file of a release
// (`requirements.json`, which every release ships at its tag): the release its callers pin, or,
// with `--to vX.Y.Z`, the release being moved to, so that run before Dependabot's pin bump merges
// it turns "the first red run" into a list. Each finding says what is missing or stale and the
// exact fix, and the list comes in the order to work through it: the pin (with the kanon plugin's,
// where the project declares it), then each App (its register rows and its permissions), the
// secrets, the declarations and hooks, the callers, the labels and the ruleset.
//
// It also lists every job of the repository's own workflows that holds `id-token: write`,
// counted as Kanon's id-token guard counts it (tests/unit/helpers/store-jobs.ts): its own grant,
// the workflow's when it declares none, `write-all` at either level, and a job that calls a
// reusable workflow with such a grant. The QA store's role and the telemetry writer trust the
// default branch's ref, so each of those jobs can assume them. A caller of one of Kanon's
// store-coupled lanes at the pinned release is listed as Kanon's and accepted; any other holder
// is accepted only by a bullet in the adoption record that names it and gives a reason
// (`K-LAYOUT-10`), or by narrowing its grant.
//
// ANY OTHER FINDING CAN BE WAIVED the same way, by the repository and not by doctor: a bullet
// under `## Choices` names one finding id, the one subject it applies to, and the reason
// (`WAIVER_LABEL`). A waived finding moves from `findings` to `waived`, so it no longer counts
// toward the exit code but stays in the document. Doctor knows no repository's special case:
// every finding and every repository is waived alike, except the ids `UNWAIVABLE` lists. A waiver
// that matches no finding is listed as stale, and one in another shape is malformed. A finding
// that lists items, which a later release can add to (`ITEMIZED`), is waived item by item: each
// bullet names the items it waives after `for`, with its own reason, several bullets may share
// one finding, and an item none names stays a finding. A bullet of such a finding that names no
// items is malformed, since it would hide what a later release adds (#406, the Owner, 2026-10-07).
//
// IT WRITES NOTHING: every GitHub call is a read, and no file is written. `kanon init` fixes
// what can be fixed from the checkout.
//
// TWO OUTPUTS, ONE RESULT. The default is prose for a person. `--json` prints one JSON document
// and nothing else on standard output, whose shape is a versioned contract (`SCHEMA`, and
// docs/doctor.md, following docs/cli-json.md's convention for every command): the skills that
// wrap `kanon init` and `kanon doctor` (ADR 0014, decision 1) and later integrators build on it,
// so a change to it is a breaking change. The exit code is the same in both modes:
//   0  healthy: every check ran and found nothing that blocks
//   1  findings: at least one blocking finding, an id-token holder neither accepted nor narrowed
//      included
//   2  usage error
//   3  could not run: no checkout, the repository or a requirements file could not be read, or
//      nothing pins Kanon
//   4  incomplete: nothing blocking was found, but at least one check could not run (the token
//      can't list the secrets, say), so health can't be claimed
//
// Node built-ins only: this runs from a Kanon checkout or through `npx`, with no install.

import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { URL } from 'node:url';
import { readResult, resultMasked } from './apps-check.mjs';
import { checkoutCheck, NEW_KEY, ownerInstallations as listInstallations, REGISTER_PATH, remoteRepo } from './apps.mjs';
import { appSecrets, kanonRelease, loadRequirements, TRIGGERS } from './callers.mjs';
import { whoami } from './gh-token.mjs';
import { appsArgs, BRIEF_TEMPLATE_PATH, briefTemplate, DEPLOY_CALLER_PATH, deployEnvironmentSecrets, HOLDER_LABEL, holderBullet, inspect, LANE_CHECK, LEAD_LANE, OWN_TERMINAL, registerOtherApps, registerRolesOf, registerRows, requiredCheckGap, REVIEW_LANE, rulesetBody, rulesetGaps, RULESET_NAME } from './init.mjs';
import { actorName, bypassCommand, releaserActor, releaserBypass, rulesetUrl } from './ruleset-bypass.mjs';
import { readPluginDeclaration, SETTINGS_PATH } from './plugin.mjs';
import { parseYaml } from './workflow-yaml.mjs';
import { branchWorkflows, checkJobs, checkReporters, mergeQueueOn } from './check-reporters.mjs';
import { LABEL as UPSTREAM_LABEL, parseUpstreamFindings, unsentMessage } from '../scripts/lib/upstream-findings.mjs';
import { LEDGER as CAPABILITY_LEDGER, parseCapabilityWatch } from '../scripts/lib/capability-watch.mjs';
import { DeclarationError, DEPLOY_HEADING, movedReferenceBullets, parseDeployDeclaration } from '../scripts/lib/deploy-declaration.mjs';
import { PROBE_LINE } from '../scripts/deploy-gate.mjs';
import { EXTRA_LABEL, readAppExtras, withExtras } from '../scripts/lib/app-extras.mjs';
import { REFUSED_TITLE, UNPUBLISHED_JOB } from '../scripts/lib/telemetry-token.mjs';
import { ARTIFACT_FILE, LISTING_SLACK, listTelemetryArtifacts, MAX_PAGES, readZipEntry } from '../scripts/lib/telemetry-artifacts.mjs';
import { LANES as TELEMETRY_LANES, TERMINAL_REASONS } from '../actions/agent-telemetry/schema.mjs';
import { defaultEscalationFile, ESCALATION_FILE, inPipelineCode, parseEscalationFile } from '../scripts/lib/escalation-paths.mjs';
import { callerNameFindings, FIXED_CALLERS } from '../actions/lane-check/caller-names.mjs';
import { renderNotice } from '../actions/agent-classify/classify-agent-result.mjs';

// The reporter check lives in its own module, which `kanon init` shares (#444).
export { branchPattern, branchWorkflows, checkJobs, checkReporters } from './check-reporters.mjs';

/** @typedef {import('./callers.mjs').Requirements} Requirements */
/** @typedef {import('./init.mjs').Inspection} Inspection */
/** @typedef {{ status: number | null, stdout: string, stderr: string }} GhResult */

// ── The Claude credential (plan 0009 §10, §11) ─────────────────────────────────────────────

/** The subscription's token, and the API key a caller may map in its place. */
export const CLAUDE_TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN';
export const CLAUDE_KEY = 'ANTHROPIC_API_KEY';
/**
 * `claude.token-age`: a note once the token's secret was last updated more than NOTE days ago,
 * blocking once more than YEAR days ago. A subscription token lasts a year (#579, not run against
 * a real token); the secret's `updatedAt` is when it was stored, so the token is at least that old.
 */
export const TOKEN_AGE = /** @type {const} */ ({ note: 335, year: 365 });
/** `claude.unreachable-runs`: at least `runs` runs on the subscription within `days` days. */
export const UNREACHABLE = /** @type {const} */ ({ runs: 2, days: 14, perCaller: 20 });
/**
 * `lane.turn-cap` (#1004): a lane whose runs keep ending at its turn limit. Read from the
 * repository's own `kanon-telemetry-*` artifacts of the last `days` days, the newest `perLane` of
 * each lane, through at most `maxPages` pages of the artifact listing (the dispatch sweep's cap),
 * downloading `downloads` at a time. Reported when at least `runs` of them, and at least `share`
 * of those that reached the model, ended with `terminal_reason: max_turns`.
 */
export const TURN_CAP = /** @type {const} */ ({ runs: 2, share: 0.25, days: 14, perLane: 20, maxPages: MAX_PAGES, downloads: 8 });
/**
 * The title GitHub stores for an annotation a workflow command (`::error title=<title>::…`) gives:
 * the runner splits the command's properties on every `,`, unescaped, and keeps only `key=value`
 * segments, so a title with a comma keeps its first segment's value alone.
 * @param {string} title @returns {string}
 */
export const storedTitle = (title) => {
  for (const part of `title=${title}`.split(',')) {
    const at = part.indexOf('=');
    if (at > 0) return part.slice(at + 1);
  }
  return '';
};
/**
 * The title of `agent-classify`'s notice for a model it never reached, as GitHub stores it, which
 * doctor looks for: "the model was unreachable", since the notice's own title holds a comma.
 */
export const UNREACHABLE_TITLE = storedTitle(renderNotice('unavailable', '').title);
/** Where an Anthropic API key is made. */
export const CONSOLE_KEYS = 'https://console.anthropic.com/settings/keys';
const DAY = 86_400_000;

// ── Chat notifications (plan 0011 §9) ──────────────────────────────────────────────────────

/** The notify hook's fixed path (plan 0011 §6.1, `K-LAYOUT-1`): the one thing a `notify` job calls. */
export const NOTIFY_HOOK = '.github/actions/notify/action.yml';
/** A reference to one of Kanon's prebuilt hooks' actions, whose pin follows the callers' (decision 18). */
const PREBUILT_REF = /yedeya-labs\/kanon\/actions\/notify\/[a-z-]+@/;
/** The line the `notify` block prints for doctor (plan 0011 §5.1, step 6), before its JSON. */
export const NOTIFY_LINE = 'kanon-notify/v1';
/** The `notify` job's id in each notifying lane (plan 0011 §5.1), which names it in a caller's run. */
export const NOTIFY_JOB = 'notify';
/** How many of a caller's latest completed runs (default-branch ones, but the deploy caller's) doctor looks through for a `notify` job that ran. */
export const NOTIFY_RUNS = 10;

/**
 * @typedef {{ hook: { path: string, inputs: string[] }, versions: number[],
 *   kinds: Record<string, { secret: string, lanes: string[] }>, legacySecret: string,
 *   prebuilt: Record<string, { action: string, hook: string }> }} NotifyRequirements
 */

/**
 * Whether a `uses:` of a hook's step is pinned as `K-ADOPT-12` asks (plan 0011 §6.2, item 3): an
 * action by a version tag or a full commit SHA, never a branch; a `docker://` image by a digest,
 * never a tag alone. A local action (`./…`) is the repository's own, held by
 * `notify.hook-unreviewed` instead, so it counts as pinned here. An exact Kanon release, a
 * candidate's `candidate-vX.Y.Z` included, is a tag, so the pin `notify.hook-pin-behind`'s fix
 * writes is never unpinned.
 * @param {string} uses
 */
export const pinnedUses = (uses) => {
  const u = uses.trim();
  if (u.startsWith('./')) return true;
  if (u.startsWith('docker://')) return /@sha256:[0-9a-f]{64}$/.test(u);
  const ref = /^[^@\s]+@([^@\s]+)$/.exec(u)?.[1];
  return ref !== undefined && (/^[0-9a-f]{40}$/.test(ref) || EXACT_RELEASE.test(ref) || /^v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/.test(ref));
};

/**
 * Whether a `run:` installs packages (plan 0011 §6.2, item 2): a lockfile outside `.github/` would
 * bring in code nobody reviewed. Each package manager's install, and the like.
 */
export const PACKAGE_INSTALL = /(?<![\w-])(?:(?:npm|pnpm)\s+(?:ci|install|i|add)|yarn\s+(?:install|add)|yarn(?=[ \t]*(?:$|[;&|]))|(?:pip3?|pipx|pipenv|poetry|bundle|gem|composer)\s+install|uv\s+(?:sync|pip\s+install|add)|python3?\s+-m\s+pip\s+install|go\s+(?:mod\s+download|get|install)|cargo\s+(?:install|fetch))(?![\w-])/m;

/**
 * The repository paths a `run:` names, as doctor can see them (plan 0011 §6.2, item 2): each word
 * that reads as a relative path, with a `/` or a file's extension, after `./`, the workspace's
 * variables and the hook's own directory (`$GITHUB_ACTION_PATH`, under `.github/`) are resolved,
 * that `exists` in the checkout. A path built at run time, or one the checkout lacks, is not seen.
 * @param {string} run @param {(path: string) => boolean} exists
 * @returns {string[]}
 */
export const runPaths = (run, exists) => {
  const hookDir = `${dirname(NOTIFY_HOOK)}/`;
  const text = run
    .replace(/\$\{\{\s*github\.workspace\s*\}\}\/|\$\{?GITHUB_WORKSPACE\}?\//g, '')
    .replace(/\$\{\{\s*github\.action_path\s*\}\}\/|\$\{?GITHUB_ACTION_PATH\}?\//g, hookDir);
  /** @type {string[]} */
  const out = [];
  for (const raw of text.split(/[\s"'`;|&()<>=,]+/)) {
    const dir = raw.replace(/^\.\//, '');
    const w = dir.replace(/\/+$/, '');
    if (!w || w.startsWith('-') || w.startsWith('/') || w.includes('$') || w.includes('://') || w.includes('..')) continue;
    if (!/^[\w.@+-]+(?:\/[\w.@+-]+)*$/.test(w) || !(dir.includes('/') || /\.[A-Za-z0-9]+$/.test(w))) continue;
    if (exists(w) && !out.includes(w)) out.push(w);
  }
  return out;
};

/** The JSON output's contract (docs/doctor.md). A breaking change to it changes this. */
export const SCHEMA = 'kanon-doctor/v1';

/** The exit codes, as docs/doctor.md documents them. */
export const EXIT = /** @type {const} */ ({ healthy: 0, findings: 1, usage: 2, error: 3, incomplete: 4 });

/** Where Kanon's releases are, whose tags carry each release's requirements file. */
export const KANON_REPO = 'yedeya-labs/kanon';

/**
 * An exact release (`K-ADOPT-11`): a stable one, `vX.Y.Z`, or a candidate, `candidate-vX.Y.Z`, the
 * same code before it is promoted (plan 0009). Compared as strings, so a candidate beside its own
 * stable release is two releases.
 */
export const EXACT_RELEASE = /^(?:candidate-)?v\d+\.\d+\.\d+$/;

/** A stable release only, `vX.Y.Z`: what GitHub's latest release names. */
const STABLE_RELEASE = /^v\d+\.\d+\.\d+$/;

/** The adoption record (`K-LAYOUT-10`), where an id-token holder is accepted. */
export const ADOPTION_RECORD = 'docs/qa/adoption.md';

// The bullet that accepts an id-token holder, under `## Choices`: `kanon init` writes it from the
// person's answer (#631), and doctor reads it, so its label and shape live with init's writer.
export { HOLDER_LABEL, holderBullet };

/** The bullet's bold label that waives one finding, under `## Choices`. */
export const WAIVER_LABEL = 'Waived doctor finding';

/** The dispatch sweep's backlog feeder's valve, a repository variable (#609). */
export const BACKLOG_FEED = 'QA_BACKLOG_FEED';

/**
 * The note on the backlog feeder's valve (#609): informational in every state, since unset is
 * the feeder's default, off. Reads the value as `scripts/backlog-feed.mjs` does: a whole number,
 * and anything else closed.
 * @param {string[]} files the callers of a sweep that feeds
 * @param {Map<string, string> | null} vars the repository's variables, or null when unlisted
 * @param {string} repo
 */
export function backlogFeedNote(files, vars, repo) {
  const who = `${files.join(', ')} ${files.length > 1 ? 'run' : 'runs'} the dispatch sweep, whose backlog feeder`;
  const how = '(docs/lanes.md, "The backlog feeder")';
  if (!vars) return `${who} reads ${BACKLOG_FEED}, and the token can't list ${repo}'s variables, so doctor can't tell whether it feeds ${how}.`;
  const raw = (vars.get(BACKLOG_FEED) ?? '').trim();
  const milestones = (vars.get('QA_BACKLOG_MILESTONES') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  if (raw === '' || raw === '0') return `${who} is off: ${BACKLOG_FEED} is ${raw === '' ? 'unset' : '0'}. Set it to the number of reviewer follow-ups to label agent:implement a day ${how}: \`gh variable set ${BACKLOG_FEED} -R ${repo} --body 1\`.`;
  if (!/^\d+$/.test(raw)) return `${who} is off: ${BACKLOG_FEED} is \`${raw}\`, which is not a whole number, so the feeder reads it as 0 ${how}.`;
  return `${who} labels up to ${raw} reviewer follow-up${raw === '1' ? '' : 's'} a day agent:implement, from ${milestones.length ? milestones.join(', ') : 'Product Backlog'}, into implementer slots nothing else is using ${how}.`;
}

/**
 * The finding ids no waiver waives, each with why (docs/doctor.md, "Waiving a finding"). A
 * waiver of one is malformed. The record's own findings can't be waived, or a waiver could hide
 * a broken or stale waiver; an id-token holder has its own form of waiver, the acceptance above;
 * and the rest protect a rule that keeps review independent or keeps secrets in their place.
 * @type {Record<string, string>}
 */
export const UNWAIVABLE = {
  'declaration.malformed': 'it is about the adoption record itself, so a waiver could hide a malformed waiver',
  'waiver.stale': 'it is about the adoption record itself, so a waiver could keep a stale waiver alive',
  'id-token.stale-acceptance': 'it is about the adoption record itself; remove the stale acceptance instead',
  'id-token.unaccepted': `a job is accepted as an id-token holder by its own bullet, \`- **${HOLDER_LABEL}:** \`<workflow>.yml\` job \`<job>\` (<why>)\``,
  'register.shared-slug': 'one App authoring and approving its own work defeats independent review (K-LAYOUT-6)',
  'register.other-app-slug': 'an Other App row naming an agent\'s App would re-label that App as one that isn\'t an agent (K-LAYOUT-6)',
  'caller.secrets-inherited': 'it hands the lane every secret of the repository (plan 0001 decision 7)',
  'ruleset.missing': 'without it nothing enforces review on the default branch (K-ADOPT-1 step 8)',
  'ruleset.rule-missing': 'without it nothing enforces that rule of review on the default branch (K-ADOPT-1 step 8)',
  'ruleset.bypass-extra': 'it lets an actor other than the Releaser merge around review (K-MERGE-8)',
  'ruleset.approval-off': 'the adoption record says bootstrap ended, and bootstrap never returns: a ruleset that stopped requiring approval is an incident to fix (K-ADOPT-6)',
  'upstream.unsent': 'it is about the adoption record itself, which says findings are sent when nothing sends them, and lane-check fails it whatever a waiver says',
  'deploy.declaration-moved': 'it is about the adoption record itself: the reconciler and lane-check read the reference deploy from `## Deploy` alone, and fail on bullets left under `## Choices` whatever a waiver says (plan 0010 D2)',
  'deploy.declaration': 'it protects production: the lane, `kanon init` and the gate read the chain from it, and the gate refuses a record it can\'t read (plan 0010 §12)',
  'deploy.caller-mismatch': 'it protects production: the gate refuses a caller that differs from the declaration, so no environment deploys until `kanon init` writes it again (plan 0010 §12)',
  'deploy.environment-missing': 'it protects production: a declared environment that doesn\'t exist has no protection rule and no deployment policy, and a job naming it creates it with none (plan 0010 §12)',
  'deploy.reviewers-missing': 'it protects production: with no required reviewer, nothing stands between a release and production but the lane\'s own code (plan 0010 §12)',
  'deploy.subject-custom': 'it protects production: a subject without the environment lets a job outside it assume its role (plan 0010 §5, §12)',
};

/**
 * The finding ids no waiver waives under one fallback marker of the adoption record's `## Deploy`
 * section (plan 0010 §12, §13), each with the marker and why. Under any other marker, or none,
 * they are waived like any other note. A waiver of one under its marker is malformed, and waives
 * nothing.
 * @type {Record<string, { fallback: string, why: string }>}
 */
export const UNWAIVABLE_UNDER = {
  'deploy.tag-ruleset': {
    fallback: 'no-reviewers',
    why: 'under the `no-reviewers` fallback no reviewer stands in front of production, so who may create, move or delete a release tag is what guards its secret and its role (plan 0010 §13)',
  },
};

/**
 * The finding ids whose findings list items, each with what an item is (#406). A later release
 * can add an item to such a finding, a permission an App needs or a secret a lane takes, so a
 * waiver of one names the items it waives after `for`, and doctor still reports any other. Several
 * bullets may waive items of one finding, each with its reason, but no item twice. A waiver of one
 * that names no items is malformed (the Owner, 2026-10-07), its fix the bullet built from the
 * items doctor reports today.
 * @type {Record<string, string>}
 */
export const ITEMIZED = {
  'register.missing-row': 'a role whose row is missing',
  'register.split-slug': 'an App whose roles name more than one slug',
  'app.permission-missing': 'a permission',
  'app.permission-extra': 'a permission',
  'secret.missing': 'a secret',
  'secret.stale': 'a secret',
  'declaration.section-missing': 'a heading',
  'hook.input-missing': 'an input',
  'caller.secret-missing': 'a secret',
  'caller.secret-stale': 'a secret',
  'caller.input-stale': 'an input',
  'caller.grant-missing': 'a permission',
  'apps-check.secret-missing': 'a secret',
  'apps-check.secret-stale': 'a secret',
  'label.missing': 'a label',
  'qa-store.unmapped': 'a secret',
  'qa-store.variables': 'a variable',
};

/**
 * The categories of the findings a check that could not run would have reported, by the
 * `unchecked[].check` it is listed under: a waiver of such a finding can't be called stale.
 * @type {Record<string, string>}
 */
const UNCHECKED_CATEGORY = { 'app-permissions': 'app', 'unused-apps': 'app', secrets: 'secret', 'token-age': 'secret', 'telemetry-register': 'secret', 'unreachable-runs': 'secret', 'telemetry-runs': 'caller', 'turn-cap-runs': 'caller', hook: 'declaration', ruleset: 'ruleset', 'ruleset-bypass': 'ruleset', 'required-check': 'ruleset', 'notify-secrets': 'secret', 'notify-hook': 'declaration', 'notify-runs': 'caller', 'deploy-hook': 'declaration', 'deploy-ci': 'caller', 'deploy-environments': 'deploy', 'deploy-subject': 'deploy', 'deploy-runs': 'deploy', 'deploy-retention': 'deploy', 'deploy-rulesets': 'deploy', 'deploy-secrets': 'deploy' };

/**
 * The finding categories, in the order a finding is listed and fixed: the pin decides which
 * release's requirements apply; an App's rows and permissions come before the secrets that name
 * it; the files a lane reads before the callers that call it; the platform's own state last.
 */
export const CATEGORIES = ['pin', 'app', 'secret', 'declaration', 'caller', 'label', 'ruleset', 'deploy', 'id-token'];

/**
 * Every finding `doctor` can report, by its stable id: its category, and whether it blocks (sets
 * exit code 1). docs/doctor.md lists the same ids; tests/unit/kanon-doctor.test.ts holds the two
 * to each other.
 * @type {Record<string, { category: string, blocking: boolean }>}
 */
export const FINDINGS = {
  'pin.mixed': { category: 'pin', blocking: true },
  'pin.candidate': { category: 'pin', blocking: false },
  'plugin.version-mismatch': { category: 'pin', blocking: false },
  'notify.hook-pin-behind': { category: 'pin', blocking: false },
  'notify.hook-pin-ahead': { category: 'pin', blocking: true },
  'register.missing-row': { category: 'app', blocking: true },
  'register.split-slug': { category: 'app', blocking: true },
  'register.shared-slug': { category: 'app', blocking: true },
  'register.other-app-slug': { category: 'app', blocking: true },
  'app.permission-missing': { category: 'app', blocking: true },
  'app.permission-extra': { category: 'app', blocking: false },
  'app.unused': { category: 'app', blocking: false },
  'secret.missing': { category: 'secret', blocking: true },
  'secret.stale': { category: 'secret', blocking: false },
  'claude.token-age': { category: 'secret', blocking: true },
  'claude.unreachable-runs': { category: 'secret', blocking: false },
  'telemetry.register-tracked': { category: 'secret', blocking: true },
  'declaration.missing': { category: 'declaration', blocking: true },
  'declaration.section-missing': { category: 'declaration', blocking: true },
  'declaration.malformed': { category: 'declaration', blocking: true },
  'upstream.unsent': { category: 'declaration', blocking: true },
  'deploy.declaration-moved': { category: 'declaration', blocking: true },
  'deploy.declaration': { category: 'declaration', blocking: true },
  'deploy.reference-undeclared': { category: 'declaration', blocking: false },
  'deploy.hook-missing': { category: 'declaration', blocking: true },
  'hook.missing': { category: 'declaration', blocking: true },
  'hook.input-missing': { category: 'declaration', blocking: true },
  'workflow.missing': { category: 'declaration', blocking: true },
  'lead.template-missing': { category: 'declaration', blocking: false },
  'lead.template-stale': { category: 'declaration', blocking: false },
  'waiver.stale': { category: 'declaration', blocking: false },
  'caller.lane-removed': { category: 'caller', blocking: true },
  'caller.misplaced': { category: 'caller', blocking: true },
  'caller.secrets-inherited': { category: 'caller', blocking: true },
  'caller.secret-missing': { category: 'caller', blocking: true },
  'caller.secret-stale': { category: 'caller', blocking: true },
  'caller.input-stale': { category: 'caller', blocking: true },
  'caller.grant-missing': { category: 'caller', blocking: true },
  'caller.name': { category: 'caller', blocking: true },
  'caller.run-name': { category: 'caller', blocking: true },
  'caller.job-id': { category: 'caller', blocking: true },
  'caller.claude-both': { category: 'caller', blocking: true },
  'caller.claude-none': { category: 'caller', blocking: true },
  'claude.mixed': { category: 'caller', blocking: false },
  'apps-check.secret-missing': { category: 'caller', blocking: true },
  'apps-check.secret-stale': { category: 'caller', blocking: true },
  'telemetry.refused': { category: 'caller', blocking: false },
  'telemetry.not-run': { category: 'caller', blocking: false },
  'telemetry.unpublished': { category: 'caller', blocking: false },
  'telemetry.legacy-inputs': { category: 'caller', blocking: true },
  'lane.turn-cap': { category: 'caller', blocking: false },
  'qa-store.unmapped': { category: 'caller', blocking: false },
  'qa-store.variables': { category: 'secret', blocking: false },
  'notify.kind-unset': { category: 'secret', blocking: false },
  'notify.none': { category: 'declaration', blocking: false },
  'notify.hook-malformed': { category: 'declaration', blocking: true },
  'notify.hook-version-old': { category: 'declaration', blocking: false },
  'notify.hook-unpinned': { category: 'declaration', blocking: true },
  'notify.hook-unreviewed': { category: 'declaration', blocking: true },
  'notify.legacy-secret': { category: 'caller', blocking: true },
  'notify.failing': { category: 'caller', blocking: false },
  'deploy.caller-mismatch': { category: 'caller', blocking: true },
  'deploy.releaser-missing': { category: 'caller', blocking: true },
  'deploy.ci-push-missing': { category: 'caller', blocking: true },
  'label.missing': { category: 'label', blocking: false },
  'ruleset.missing': { category: 'ruleset', blocking: true },
  'ruleset.rule-missing': { category: 'ruleset', blocking: true },
  'ruleset.check-unreported': { category: 'ruleset', blocking: true },
  'ruleset.releaser-bypass-missing': { category: 'ruleset', blocking: true },
  'ruleset.bypass-extra': { category: 'ruleset', blocking: true },
  'ruleset.bootstrap-can-end': { category: 'ruleset', blocking: true },
  'ruleset.approval-off': { category: 'ruleset', blocking: true },
  // The deploy lane's platform state (plan 0010 §12). A fallback marker turns some blocks into
  // notes and one note into a block: `find`'s `warnOnly` and `escalate`.
  'deploy.environment-missing': { category: 'deploy', blocking: true },
  'deploy.reviewers-missing': { category: 'deploy', blocking: true },
  'deploy.branch-policy': { category: 'deploy', blocking: true },
  'deploy.self-review': { category: 'deploy', blocking: false },
  'deploy.admin-bypass': { category: 'deploy', blocking: false },
  'deploy.subject-custom': { category: 'deploy', blocking: true },
  'deploy.trust-unproven': { category: 'deploy', blocking: true },
  'deploy.artifact-retention': { category: 'deploy', blocking: false },
  'deploy.secret-repository': { category: 'deploy', blocking: false },
  'deploy.secret-organization': { category: 'deploy', blocking: false },
  'deploy.tag-ruleset': { category: 'deploy', blocking: false },
  'id-token.unaccepted': { category: 'id-token', blocking: true },
  'id-token.stale-acceptance': { category: 'id-token', blocking: false },
};

export const USAGE = `Usage: kanon doctor [options]

Compares the Kanon installation in the repository whose checkout you run it from with the
requirements of a release: the one its callers pin, or, with --to, the one you are moving to.
Lists what is missing or stale, each with its exact fix, in the order to fix them, and every
job of your own workflows that holds id-token: write. Writes nothing.

Options:
  --to <vX.Y.Z>          check against this release's requirements instead of the pinned one's
                         (run it before you merge the pin bump; a candidate,
                         candidate-vX.Y.Z, is an exact release too)
  --json                 print one JSON document (docs/doctor.md) instead of prose
  --repo <owner>/<repo>  the repository (default: the checkout's origin remote)
  --dir <path>           the checkout (default: here)
  -h, --help             this text

Exit codes: 0 healthy; 1 findings; 2 usage error; 3 could not run; 4 nothing blocking found,
but some check could not run (docs/doctor.md).

Needs \`gh\` and a token that can read the repository; listing its secrets' names needs
admin access to it. gh takes its token from GH_TOKEN, then GITHUB_TOKEN, then its stored
login; the command says which one it used and whose it is.`;

/**
 * @typedef {{
 *   gh: (args: string[], input?: string) => Promise<GhResult>,
 *   download: (repo: string, id: number) => Promise<{ status: number | null, bytes: Buffer, stderr: string }>,
 *   git: (args: string[]) => GhResult,
 *   env: Record<string, string | undefined>,
 *   out: (line: string) => void,
 *   err: (line: string) => void,
 *   readFile: (path: string) => string | null,
 *   listFiles: (dir: string) => string[],
 *   requirements: () => Requirements,
 *   release: () => string,
 *   briefTemplate: () => string,
 *   labels: () => Array<{ name: string, color: string, description: string }>,
 *   now: () => number,
 * }} Deps
 */

/** Every file under `dir`, by path relative to it; none when it doesn't exist. @param {string} dir */
const listFiles = (dir) => {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk('');
  return out.sort();
};

/** @type {Deps} */
export const realDeps = {
  gh: (args, input) =>
    new Promise((done) => {
      const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (e) => done({ status: null, stdout, stderr: String(e.message) }));
      child.on('close', (status) => done({ status, stdout, stderr }));
      child.stdin.on('error', () => {});
      child.stdin.end(input ?? '');
    }),
  // An artifact's zip, as bytes: `gh`'s output read as text would mangle them.
  download: (repo, id) =>
    new Promise((done) => {
      const child = spawn('gh', ['api', `repos/${repo}/actions/artifacts/${id}/zip`], { stdio: ['ignore', 'pipe', 'pipe'] });
      /** @type {Buffer[]} */
      const chunks = [];
      let stderr = '';
      child.stdout.on('data', (d) => chunks.push(d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (e) => done({ status: null, bytes: Buffer.concat(chunks), stderr: String(e.message) }));
      child.on('close', (status) => done({ status, bytes: Buffer.concat(chunks), stderr }));
    }),
  git: (args) => {
    const r = spawnSync('git', args, { encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.error ? String(r.error.message) : (r.stderr ?? '') };
  },
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  readFile: (path) => (existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : null),
  listFiles,
  requirements: loadRequirements,
  release: kanonRelease,
  briefTemplate,
  labels: () => JSON.parse(readFileSync(new URL('../rulebook/labels.json', import.meta.url), 'utf8')).labels,
  now: () => Date.now(),
};

/**
 * Parses `kanon doctor`'s arguments. Throws with a message naming the problem.
 * @param {string[]} argv
 */
export const parseArgs = (argv) => {
  /** @type {{ repo: string, dir: string, to: string | null, json: boolean, help: boolean }} */
  const opts = { repo: '', dir: process.cwd(), to: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === '') throw new Error(`${flag} needs a value`);
      // The next argument is a flag, not this one's value: an unset, unquoted variable leaves
      // `--dir --json`, which would read "--json" as the checkout and print prose (#457). A
      // value that does begin with "-" is given inline, `--dir=-x`.
      if (inline === undefined && v.startsWith('-')) throw new Error(`${flag} needs a value, not the flag "${v}"; to give a value that begins with "-", write ${flag}=<value>`);
      return v;
    };
    if (flag === '-h' || flag === '--help') opts.help = true;
    else if (flag === '--repo') opts.repo = value();
    else if (flag === '--dir') opts.dir = value();
    else if (flag === '--to') opts.to = value();
    else if (flag === '--json') opts.json = true;
    else throw new Error(`unknown argument "${arg}"`);
  }
  // `--help` prints the usage, which is no document: with `--json` it would leave prose on
  // standard output, so the pair is refused, and the refusal is the error document (#457).
  if (opts.help && opts.json) throw new Error('--help and --json contradict each other; give one');
  if (opts.repo && !/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error(`--repo takes <owner>/<repo>, not "${opts.repo}"`);
  if (opts.to && !EXACT_RELEASE.test(opts.to)) throw new Error(`--to takes an exact release, vX.Y.Z or candidate-vX.Y.Z, not "${opts.to}"`);
  return opts;
};

// ── Small readers ─────────────────────────────────────────────────────────────────────────

/** @param {unknown} v */
const level = (v) => (v === 'write' ? 2 : v === 'read' ? 1 : 0);

/** @param {unknown} v @returns {v is Record<string, any>} */
const isMap = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The strings `git grep` looks for in the tracked files before doctor reads any as JSON, so that
 * it parses only the files that can hold a register's shape (#1071): the register's owner ARN,
 * `render.mjs`'s `parameters.json` line for it, and its `template.json`'s writer keys.
 */
export const REGISTER_MARKERS = ['owner_principal_arn', 'OwnerPrincipalArn=', 'WRITER_KEYS'];

/** An owner ARN still holding a `<…>` placeholder, which no real ARN does. @param {unknown} v */
const placeholder = (v) => typeof v === 'string' && /<[^<>]+>/.test(v);

/**
 * What a file holds of a telemetry register, by its shape and never its name (#1071): `register`,
 * a JSON object with an `owner_principal_arn` and `repositories` some entry of which pairs a `key`
 * with a `repository` (`infra/telemetry/register.example.json`'s shape); `render.mjs`'s output,
 * `parameters.json`, an array of `Name=value` strings holding `OwnerPrincipalArn=`, or
 * `template.json`, whose ingest function holds writer keys; or null. A register or parameters
 * whose owner ARN is still a `<…>` placeholder is an example, which pairs no real key, and is
 * null: so Kanon's own example is exempt by what it holds, and doctor learns no repository's case.
 * @param {string} text @returns {'register' | 'template' | 'parameters' | null}
 */
export const registerShape = (text) => {
  /** @type {any} */
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(doc)) {
    if (!doc.length || !doc.every((p) => typeof p === 'string')) return null;
    const owner = doc.find((p) => p.startsWith('OwnerPrincipalArn='));
    return owner !== undefined && !placeholder(owner) ? 'parameters' : null;
  }
  if (!isMap(doc)) return null;
  if ('owner_principal_arn' in doc && Array.isArray(doc.repositories)) {
    const pairs = doc.repositories.some((/** @type {unknown} */ r) => isMap(r) && typeof r.key === 'string' && r.key !== '' && typeof r.repository === 'string' && r.repository !== '');
    return pairs && !placeholder(doc.owner_principal_arn) ? 'register' : null;
  }
  const keys = doc.Resources?.IngestFunction?.Properties?.Environment?.Variables?.WRITER_KEYS;
  return typeof keys === 'string' && keys !== '' ? 'template' : null;
};

/** @typedef {{ runId: number, maxTurns: number | null, numTurns: number | null, reason: string | null }} TurnRow */

/**
 * The fields `lane.turn-cap` reads from one run artifact's zip: null when the zip or its row
 * can't be read, or the row isn't its artifact's (lane, run, attempt); `skip` for a smoke or test
 * row, which no read counts. Only these fields are checked, not the whole schema, so a row a newer
 * release wrote still reads.
 * @param {Buffer} bytes @param {{ runId: number, attempt: number }} a @param {string} lane
 * @returns {TurnRow | 'skip' | null}
 */
export const turnRow = (bytes, a, lane) => {
  /** @type {any} */
  let row;
  try {
    const file = readZipEntry(bytes, ARTIFACT_FILE);
    if (!file) return null;
    row = JSON.parse(file.toString('utf8'));
  } catch {
    return null;
  }
  if (!isMap(row) || row.row_kind !== 'run' || row.lane !== lane || row.run_id !== a.runId || row.run_attempt !== a.attempt) return null;
  if (row.tag !== 'run') return 'skip';
  /** @param {unknown} v */
  const count = (v) => (v === null || v === undefined ? null : Number.isInteger(v) && Number(v) >= 0 ? Number(v) : NaN);
  const maxTurns = count(row.max_turns);
  const numTurns = count(row.num_turns);
  const reason = row.terminal_reason ?? null;
  if (Number.isNaN(maxTurns) || Number.isNaN(numTurns) || (reason !== null && !TERMINAL_REASONS.includes(reason))) return null;
  return { runId: a.runId, maxTurns, numTurns, reason };
};

/** A semantic version's parts, for ordering; a candidate's are its release's. @param {string} v */
const semver = (v) => (/^(?:candidate-)?v(\d+)\.(\d+)\.(\d+)$/.exec(v) ?? []).slice(1).map(Number);

/** @param {string} a @param {string} b */
const newer = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** The line numbers (0-based) inside fenced code blocks. @param {string[]} lines */
const fenced = (lines) => {
  /** @type {Set<number>} */
  const set = new Set();
  let open = false;
  lines.forEach((l, i) => {
    if (/^[ \t]*(```|~~~)/.test(l)) {
      set.add(i);
      open = !open;
    } else if (open) set.add(i);
  });
  return set;
};

/**
 * Every Kanon release a file under `.github/` pins, outside comments, as `lane-check` reads them.
 * @param {Map<string, string>} texts by path
 * @returns {Map<string, string[]>} release → the files that pin it
 */
export const kanonPins = (texts) => {
  /** @type {Map<string, string[]>} */
  const pins = new Map();
  for (const [path, text] of texts) {
    for (const line of text.split('\n')) {
      if (/^\s*#/.test(line)) continue;
      for (const m of line.matchAll(/yedeya-labs\/kanon\/[^@\s]+@([^\s"']+)/g)) {
        const ref = /** @type {string} */ (m[1]);
        const files = pins.get(ref) ?? [];
        if (!files.includes(path)) files.push(path);
        pins.set(ref, files);
      }
    }
  }
  return pins;
};

/**
 * The date the adoption record says bootstrap ended (`K-ADOPT-6`): the first `ended YYYY-MM-DD`
 * or `in bootstrap since YYYY-MM-DD` code span under `## Bootstrap`, outside fences, when it is
 * the former (`K-LAYOUT-10`). Null for a record still in bootstrap, or one that doesn't say.
 * @param {string | null} text
 * @returns {string | null}
 */
export const bootstrapEnded = (text) => {
  if (!text) return null;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const inFence = fenced(lines);
  let section = '';
  for (const [i, line] of lines.entries()) {
    if (inFence.has(i)) continue;
    if (/^#{1,2} /.test(line)) section = line.trimEnd();
    if (section !== '## Bootstrap') continue;
    const m = /`(in bootstrap since|ended) (\d{4}-\d{2}-\d{2})`/.exec(line);
    if (m) return m[1] === 'ended' ? /** @type {string} */ (m[2]) : null;
  }
  return null;
};

/**
 * The approving reviews the rulesets covering the default branch require: the most any of their
 * pull request rules asks for, 0 when none does (`K-MERGE-6`).
 * @param {any[]} covering
 */
export const requiredApprovals = (covering) =>
  Math.max(0, ...covering.flatMap((s) => s.rules ?? []).filter((r) => r?.type === 'pull_request').map((r) => Number(r.parameters?.required_approving_review_count ?? 0) || 0));

/**
 * The accepted id-token holders the adoption record declares under `## Choices`, one bullet
 * each: `- **Accepted id-token holder:** \`deploy.yml\` job \`deploy\` (why it holds it)`. A
 * bullet in another shape, outside `## Choices`, with no reason, or naming a holder twice, is
 * returned as an error naming its line.
 * @param {string | null} text
 * @returns {{ accepted: Map<string, string>, errors: string[] }} accepted: `<file>#<job>` → reason
 */
export const readHolderAcceptances = (text) => {
  /** @type {Map<string, string>} */
  const accepted = new Map();
  /** @type {string[]} */
  const errors = [];
  if (!text) return { accepted, errors };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const inFence = fenced(lines);
  const mention = new RegExp(`^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)?\\*\\*${HOLDER_LABEL}:\\*\\*`, 'i');
  const entry = new RegExp(`^[-*] \\*\\*${HOLDER_LABEL}:\\*\\* \`([^\`\\s/]+\\.ya?ml)\` job \`([^\`\\s]+)\` \\((.*\\S.*)\\)\\s*$`);
  let section = '';
  lines.forEach((line, i) => {
    if (inFence.has(i)) return;
    if (/^#{1,6} /.test(line)) section = line.trimEnd();
    if (!mention.test(line)) return;
    const m = entry.exec(line);
    const where = `${ADOPTION_RECORD}:${i + 1}`;
    if (!m) errors.push(`${where} is not \`- **${HOLDER_LABEL}:** \`<workflow>.yml\` job \`<job>\` (<why it holds the grant>)\``);
    else if (section !== '## Choices') errors.push(`${where} accepts an id-token holder outside \`## Choices\``);
    else {
      const key = `${m[1]}#${m[2]}`;
      if (accepted.has(key)) errors.push(`${where} accepts ${m[1]}'s job ${m[2]} a second time`);
      else accepted.set(key, /** @type {string} */ (m[3]).trim());
    }
  });
  return { accepted, errors };
};

/**
 * The waivers the adoption record declares under `## Choices`, one bullet each:
 * `- **Waived doctor finding:** \`caller.misplaced\` on \`.github/workflows/review.yml\` (why)`.
 * Each names one finding id, one subject exactly as doctor reports it, and the reason; for a
 * finding that lists items (`ITEMIZED`), it may name the items it waives, each a code span after
 * `for`, separated by commas (`items`, null when it names none). A bullet in another shape,
 * outside `## Choices`, with no reason, naming an id doctor doesn't report or one it doesn't
 * waive (`UNWAIVABLE`), naming items of a finding that lists none, waiving a finding that lists
 * none twice, or naming an item another bullet of the same finding names, is returned as an error
 * naming its line. A bullet of an `ITEMIZED` finding that names no items is returned as read:
 * `diagnose` reports it malformed, with the bullet to write from the items it finds.
 * @param {string | null} text
 * @returns {{ waivers: Array<{ id: string, subject: string, items: string[] | null, reason: string, line: number }>, errors: string[] }}
 */
export const readWaivers = (text) => {
  /** @type {Array<{ id: string, subject: string, items: string[] | null, reason: string, line: number }>} */
  const waivers = [];
  /** @type {string[]} */
  const errors = [];
  if (!text) return { waivers, errors };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const inFence = fenced(lines);
  const mention = new RegExp(`^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)?\\*\\*${WAIVER_LABEL}:\\*\\*`, 'i');
  const entry = new RegExp(`^[-*] \\*\\*${WAIVER_LABEL}:\\*\\* \`([^\`\\s]+)\` on \`([^\`]*\\S[^\`]*)\`(?: for (\`[^\`]*\\S[^\`]*\`(?:, \`[^\`]*\\S[^\`]*\`)*))? \\((.*\\S.*)\\)\\s*$`);
  let section = '';
  lines.forEach((line, i) => {
    if (inFence.has(i)) return;
    if (/^#{1,6} /.test(line)) section = line.trimEnd();
    if (!mention.test(line)) return;
    const m = entry.exec(line);
    const where = `${ADOPTION_RECORD}:${i + 1}`;
    if (!m) return errors.push(`${where} is not \`- **${WAIVER_LABEL}:** \`<finding id>\` on \`<subject>\` (<why the finding stands>)\`, with \`for \`<item>\`, \`<item>\`\` before the parentheses for a finding that lists items`);
    if (section !== '## Choices') return errors.push(`${where} waives a finding outside \`## Choices\``);
    const [id, subject, reason] = [/** @type {string} */ (m[1]), /** @type {string} */ (m[2]), /** @type {string} */ (m[4]).trim()];
    const items = m[3] === undefined ? null : [...new Set([...m[3].matchAll(/`([^`]+)`/g)].map((x) => /** @type {string} */ (x[1])))];
    if (!FINDINGS[id]) return errors.push(`${where} waives \`${id}\`, which is no finding doctor reports`);
    if (UNWAIVABLE[id]) return errors.push(`${where} waives \`${id}\`, which can't be waived: ${UNWAIVABLE[id]}`);
    if (items && !ITEMIZED[id]) return errors.push(`${where} names items after \`for\`, but \`${id}\` lists none: waive it on its subject alone`);
    const same = waivers.filter((w) => w.id === id && w.subject === subject);
    if (!ITEMIZED[id] && same.length) return errors.push(`${where} waives \`${id}\` on \`${subject}\` a second time`);
    for (const w of same) {
      const twice = items && w.items ? items.filter((x) => w.items?.includes(x)) : [];
      if (twice.length) return errors.push(`${where} waives ${twice.map((x) => `\`${x}\``).join(', ')} of \`${id}\` on \`${subject}\`, which ${ADOPTION_RECORD}:${w.line} waives already`);
    }
    waivers.push({ id, subject, items, reason, line: i + 1 });
  });
  return { waivers, errors };
};

/** @param {unknown} p a `permissions:` value */
const grantsIdToken = (p) => p === 'write-all' || (isMap(p) && 'id-token' in p && p['id-token'] !== 'none');

/**
 * Whether a job holds `id-token: write`, as Kanon's id-token guard counts it: from its own
 * `permissions:`, or from the workflow's when it declares none, either one a map that grants it or
 * `write-all`. A job that calls a reusable workflow holds what it grants as any job does.
 * @param {Record<string, any>} wf @param {Record<string, any>} job
 * @returns {{ from: 'job' | 'workflow', how: 'id-token' | 'write-all' } | null}
 */
export const idTokenGrant = (wf, job) => {
  const own = job.permissions;
  if (own !== undefined) return grantsIdToken(own) ? { from: 'job', how: own === 'write-all' ? 'write-all' : 'id-token' } : null;
  return grantsIdToken(wf.permissions) ? { from: 'workflow', how: wf.permissions === 'write-all' ? 'write-all' : 'id-token' } : null;
};

/** A call of one of Kanon's reusable workflows: its file name without `.yml`, and its ref. @param {unknown} uses */
export const kanonCall = (uses) => {
  const m = typeof uses === 'string' ? /^yedeya-labs\/kanon\/\.github\/workflows\/([A-Za-z0-9_.-]+)\.ya?ml@(\S+)$/.exec(uses.trim()) : null;
  return m ? { workflow: /** @type {string} */ (m[1]), ref: /** @type {string} */ (m[2]) } : null;
};

/**
 * Every job of `workflows` that holds `id-token: write` (`idTokenGrant`), with its status: a
 * caller of a store-coupled lane, or of Kanon's telemetry collector (#428), at a ref `pinned`
 * takes is `kanon-lane`, held by Kanon's id-token guard; any other is `accepted` when `accepted`
 * names it, else `unaccepted`. Doctor and `kanon init` share it (#631), so init's dry run names
 * the holders doctor would block on, at the telemetry question rather than after the pull request.
 * @param {{ workflows: Map<string, Record<string, any>>, accepted: Map<string, string>, pinned: (ref: string) => boolean, req: Requirements }} c
 *   `accepted`: `<file>#<job>` → reason, as `readHolderAcceptances` reads them
 * @returns {Holder[]}
 */
export const idTokenHolders = ({ workflows, accepted, pinned, req }) => {
  /** @type {Holder[]} */
  const holders = [];
  for (const [file, wf] of workflows) {
    for (const [job, j] of Object.entries(isMap(wf.jobs) ? wf.jobs : {})) {
      if (!isMap(j)) continue;
      const g = idTokenGrant(wf, j);
      if (!g) continue;
      const calls = typeof j.uses === 'string' ? j.uses.trim() : null;
      const call = kanonCall(calls);
      const reason = accepted.get(`${file.slice('.github/workflows/'.length)}#${job}`) ?? null;
      /** @type {Holder['status']} */
      let status = reason !== null ? 'accepted' : 'unaccepted';
      if (call && pinned(call.ref) && req.lanes[call.workflow]?.grant['id-token'] === 'write') status = 'kanon-lane';
      // Kanon's telemetry collector (#428): its one job that holds the grant is held by Kanon's
      // id-token guard, as a store-coupled lane's store jobs are.
      if (call && pinned(call.ref) && req.telemetry && call.workflow === req.telemetry.collector) status = 'kanon-lane';
      // The deploy lane's two workflows (plan 0010 §12): `deploy-release.yml`'s probe and
      // `deploy.yml`'s deploy job hold the grant, to their exact shapes in Kanon's id-token guard.
      if (call && pinned(call.ref) && deployWorkflows(req).includes(call.workflow)) status = 'kanon-lane';
      holders.push({ workflow: file, job, grant: g.from, how: g.how, calls, status, reason: status === 'kanon-lane' ? null : reason });
    }
  }
  return holders;
};

/**
 * What `id-token.unaccepted` says of a holder, and its fix, in doctor and in `kanon init` alike
 * (#631): what the job could assume, and the acceptance bullet to write, with `reason` in it when
 * the person has given one.
 * @param {Holder} h @param {string} defaultBranch @param {string} [reason]
 */
export const unacceptedHolder = (h, defaultBranch, reason = '<why it holds the grant>') => {
  const base = h.workflow.slice('.github/workflows/'.length);
  const source = `${h.how === 'write-all' ? 'permissions: write-all' : 'id-token: write'} ${h.grant === 'job' ? 'in its own permissions' : "inherited from the workflow's permissions"}`;
  return {
    subject: `${h.workflow}#${h.job}`,
    message: `The job ${h.job} of ${h.workflow} holds ${source}${h.calls ? `, and passes it to ${h.calls}` : ''}. On ${defaultBranch} it can assume the QA store's role and the telemetry writer, which trust the default branch's ref.`,
    fix: {
      text: `Narrow its grant${h.grant === 'workflow' ? ' (give the job a permissions: of its own without id-token)' : ''}, or accept it under ## Choices in ${ADOPTION_RECORD}, with the reason it holds the grant:`,
      commands: [holderBullet(base, h.job, reason)],
    },
  };
};


/**
 * The triggers a workflow runs on, read from its `on:` as a name, a list or a map. Null when `on:`
 * is none of those, which doctor can't read.
 * @param {Record<string, any>} wf
 * @returns {string[] | null}
 */
const triggers = (wf) => typeof wf.on === 'string' ? [wf.on] : Array.isArray(wf.on) ? wf.on.map(String) : isMap(wf.on) ? Object.keys(wf.on) : null;

/**
 * Whether a caller runs on a pull request closed on `branch` (`pull_request_target`, `closed`), the
 * trigger that starts a lane after a merge through a merge queue (kanon#484). `types` must name
 * `closed`, which GitHub's default types don't; a `branches` filter must match `branch` (by name,
 * and a glob is taken to match), and a `branches-ignore` must not name it.
 * @param {Record<string, any>} wf @param {string} branch
 */
export const startsOnMerge = (wf, branch) => {
  const on = wf.on;
  if (!isMap(on)) return false;
  const t = on.pull_request_target;
  if (!isMap(t)) return false;
  /** @param {unknown} v @returns {string[]} */
  const list = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.map(String) : []);
  if (!list(t.types).includes('closed')) return false;
  if (t.branches !== undefined) return list(t.branches).some((b) => b === branch || /[*?[]/.test(b));
  return !list(t['branches-ignore']).includes(branch);
};

/**
 * Whether an expression reads the `secrets` context other than by a literal name: an index by an
 * expression (`secrets[format('{0}_APP_ID', x)]`), or the whole context (`toJSON(secrets)`,
 * `secrets.*`, `${{ secrets }}`). Such a read can reach any secret the workflow sees (#440).
 * @param {string} expr the text inside `${{ }}`, or an `if:`
 */
const computedRead = (expr) => /(?<![\w.])secrets(?![\w-])/.test(expr
  .replace(/(?<![\w.])secrets\s*(?:\.\s*[A-Za-z_][A-Za-z0-9_-]*|\[\s*'[A-Za-z_][A-Za-z0-9_-]*'\s*\])/g, '')
  .replace(/'(?:[^']|'')*'/g, "''"));

/**
 * The expressions a string holds, each `${{ }}`'s text, read past a `}}` inside a quoted literal
 * (`format('{{"A":{0}}}', x)`).
 * @param {string} v
 */
const expressions = (v) => {
  /** @type {string[]} */
  const out = [];
  for (let at = v.indexOf('${{'); at !== -1; at = v.indexOf('${{', at)) {
    let i = at + 3;
    let quoted = false;
    for (; i < v.length; i++) {
      if (v[i] === "'") quoted = !quoted;
      else if (!quoted && v.startsWith('}}', i)) break;
    }
    out.push(v.slice(at + 3, i));
    at = i + 2;
  }
  return out;
};

/**
 * The secrets a workflow maps into its jobs: each name an expression reads as `secrets.<NAME>` or
 * `secrets['<NAME>']` anywhere outside its `on:` (where a reusable workflow declares the secrets
 * it takes, which reads none), upper-cased as GitHub stores them; the jobs that pass on every
 * secret with `secrets: inherit`; and whether it reads the repository's secrets by a computed name
 * or as a whole (`secrets[expr]`, `toJSON(secrets)`), which can reach any of them (#440). Only an
 * expression counts for that, `${{ }}` or an `if:`, never a script's own text, and only in a
 * workflow that runs on a trigger of its own: one that runs only on `workflow_call` sees just what
 * its caller passes, which the caller names or inherits. Whatever a job calls, a lane, the release
 * workflow by any path, or nothing, its secrets count (#414).
 * @param {Record<string, any>} wf
 */
export const secretReads = (wf) => {
  /** @type {Set<string>} */
  const names = new Set();
  let computed = false;
  /** @param {unknown} v @param {string} [key] */
  const walk = (v, key) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/(?<![\w.])secrets\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\])/g)) names.add(/** @type {string} */ (m[1] ?? m[2]).toUpperCase());
      const exprs = expressions(v);
      if (key === 'if' && !exprs.length) exprs.push(v);
      if (exprs.some(computedRead)) computed = true;
    } else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (isMap(v)) Object.entries(v).forEach(([k, x]) => walk(x, k));
  };
  for (const [k, v] of Object.entries(wf)) if (k !== 'on') walk(v, k);
  const inherits = Object.entries(isMap(wf.jobs) ? wf.jobs : {}).filter(([, j]) => isMap(j) && j.secrets === 'inherit').map(([n]) => n);
  const on = triggers(wf);
  return { names, inherits, computed: computed && (on === null || on.some((t) => t !== 'workflow_call')) };
};

/**
 * Whether a job's `uses` calls Kanon's release workflow, recognised by what it calls: Kanon's
 * pinned path, `$/` (Kanon's self-pinning form, plan 0001 §4) or a local path, never by the
 * repository doctor runs on (#441).
 * @param {unknown} uses
 */
export const releaseCall = (uses) => kanonCall(uses)?.workflow === 'release'
  || (typeof uses === 'string' && /^(?:\$|\.)\/\.github\/workflows\/release\.ya?ml$/.test(uses.trim()));

/**
 * The secrets a reusable workflow declares it takes from its caller (`on.workflow_call.secrets`),
 * upper-cased as `secretReads` reads them.
 * @param {Record<string, any>} wf
 * @returns {Set<string>}
 */
export const callTakes = (wf) => {
  const call = isMap(wf.on) && isMap(wf.on.workflow_call) ? wf.on.workflow_call : null;
  return new Set(Object.keys(call && isMap(call.secrets) ? call.secrets : {}).map((n) => n.toUpperCase()));
};

/** The headings a document holds exactly once outside a fence, and how often each appears. @param {string} text @param {string} heading */
const headingCount = (text, heading) => {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const inFence = fenced(lines);
  return lines.filter((l, i) => !inFence.has(i) && l === heading).length;
};

// ── The deploy lane (plan 0010 §12, step D7) ──────────────────────────────────────────────

/**
 * The deploy lane's two reusable workflows at a release, by file name without `.yml`: its
 * `release` workflow and its per-environment one. None for a release without the lane.
 * @param {Requirements} req @returns {string[]}
 */
export const deployWorkflows = (req) => {
  const w = /** @type {{ deploy?: { workflows?: { release?: string, environment?: string } } }} */ (/** @type {unknown} */ (req)).deploy?.workflows;
  return w ? [w.release, w.environment].filter((x) => typeof x === 'string') : [];
};

/** How many of the deploy caller's latest completed runs doctor looks through for one that counts. */
export const DEPLOY_RUNS = 20;

/** The `build` input every `deploy-<position>` job passes (plan 0010 §4, D5). */
const BUILD_INPUT = /^\$\{\{\s*needs\.release\.outputs\.build\s*\}\}$/;

/**
 * What a deploy caller lacks against the declared chain (`deploy.caller-mismatch`, plan 0010 §4,
 * §12): a `release` job calling the lane's release workflow with the declared list; then, per
 * environment in order, a `deploy-<position>` job calling its per-environment workflow with that
 * environment and position, passing `build: ${{ needs.release.outputs.build }}`, and needing the
 * one before it and `release` (the first `release` alone); all at one release, and no other job.
 * Each `deploy-<position>` maps each of `secrets`, the deploy hook's environment secrets, as
 * `NAME: ${{ secrets.NAME }}` (kanon#1049): GitHub evaluates that expression in the called job's
 * scope, the environment's secret first, so an unmapped one, or one mapped from anything else,
 * reaches the hook empty or wrong. With no environment declared, any caller is the problem. One
 * sentence per problem; none when it matches, as `kanon init` writes it.
 * @param {Record<string, any>} wf the caller @param {string[]} environments the declared list
 * @param {{ release: string, environment: string }} workflows the lane's two, by file name without `.yml`
 * @param {string[]} [secrets] the environment secrets the release's `deploy.yml` declares (`deployEnvironmentSecrets`)
 * @returns {string[]}
 */
export const deployCallerProblems = (wf, environments, workflows, secrets = []) => {
  if (!environments.length) return [`it calls the deploy lane, but ${ADOPTION_RECORD} declares no environment under ## Deploy, so the gate refuses every run`];
  /** @type {string[]} */
  const problems = [];
  const jobs = isMap(wf.jobs) ? wf.jobs : {};
  const want = ['release', ...environments.map((_, i) => `deploy-${i + 1}`)];
  /** @param {unknown} v @returns {string[]} */
  const list = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.map(String) : []);
  /** @param {string[]} xs */
  const spans = (xs) => (xs.length ? xs.map((x) => `\`${x}\``).join(' and ') : 'nothing');
  /** @type {Set<string>} */
  const refs = new Set();
  for (const key of want) {
    if (!isMap(jobs[key])) problems.push(key === 'release' ? `it has no \`release\` job calling ${workflows.release}.yml` : `it has no \`${key}\` job, for \`${environments[Number(key.slice('deploy-'.length)) - 1]}\``);
  }
  for (const key of Object.keys(jobs)) if (!want.includes(key)) problems.push(`it has a job \`${key}\` that the declaration doesn't ask for`);
  const release = jobs.release;
  if (isMap(release)) {
    const call = kanonCall(release.uses);
    if (call?.workflow !== workflows.release) problems.push(`its \`release\` job doesn't call Kanon's ${workflows.release}.yml`);
    else refs.add(call.ref);
    const passed = String(isMap(release.with) ? release.with.environments ?? '' : '').trim().split(/\s+/).filter(Boolean);
    if (passed.join(' ') !== environments.join(' ')) problems.push(`its \`release\` job passes the environments ${passed.length ? `\`${passed.join(' ')}\`` : 'none'}, not the declared \`${environments.join(' ')}\`, in that order`);
  }
  environments.forEach((environment, i) => {
    const n = i + 1;
    const key = `deploy-${n}`;
    const job = jobs[key];
    if (!isMap(job)) return;
    const call = kanonCall(job.uses);
    if (call?.workflow !== workflows.environment) problems.push(`\`${key}\` doesn't call Kanon's ${workflows.environment}.yml`);
    else refs.add(call.ref);
    const w = isMap(job.with) ? job.with : {};
    if (String(w.environment ?? '') !== environment) problems.push(`\`${key}\` deploys ${w.environment === undefined ? 'no environment' : `\`${String(w.environment)}\``}, not \`${environment}\`, the declared environment at position ${n}`);
    if (String(w.position ?? '') !== String(n)) problems.push(`\`${key}\` passes ${w.position === undefined ? 'no position' : `position ${String(w.position)}`}, not ${n}`);
    if (!BUILD_INPUT.test(String(w.build ?? '').trim())) problems.push(`\`${key}\` doesn't pass \`build: \${{ needs.release.outputs.build }}\`, which ${workflows.environment}.yml requires, so the run fails before any job starts`);
    const needs = [...new Set(list(job.needs))].sort();
    const ought = (n === 1 ? ['release'] : ['release', `deploy-${n - 1}`]).sort();
    if (needs.join('\n') !== ought.join('\n')) problems.push(`\`${key}\` needs ${spans(needs)}, not ${spans(ought)}${n > 1 && !needs.includes('release') ? `: without \`release\` it can't read the build it deploys` : ''}`);
    const mapped = isMap(job.secrets) ? job.secrets : {};
    for (const name of secrets) {
      const want = `\${{ secrets.${name} }}`;
      const has = mapped[name];
      if (has === undefined) problems.push(`\`${key}\` doesn't map \`${name}: ${want}\`, so the deploy hook reads it empty, whatever \`${environment}\` holds (kanon#1049)`);
      else if (!new RegExp(`^\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}$`).test(String(has).trim())) problems.push(`\`${key}\` maps \`${name}\` from \`${String(has)}\`, not \`${want}\`, which resolves \`${environment}\`'s own secret in the deploy job (kanon#1049)`);
    }
  });
  if (refs.size > 1) problems.push(`its jobs call the lane at different releases, ${[...refs].sort().join(' and ')}: each calls the one pinned release`);
  return problems;
};

/**
 * The probe's answer a `probe` job's log printed (plan 0010 §5): the last `kanon-deploy-probe/v1`
 * line's JSON object, or null when there is none it can read.
 * @param {string} log @returns {Record<string, unknown> | null}
 */
export const probeAnswer = (log) => {
  /** @type {Record<string, unknown> | null} */
  let said = null;
  for (const line of log.split('\n')) {
    const at = line.indexOf(`${PROBE_LINE} {`);
    if (at === -1) continue;
    try {
      const v = JSON.parse(line.slice(at + PROBE_LINE.length + 1).trim());
      said = isMap(v) ? v : null;
    } catch {
      said = null;
    }
  }
  return said;
};

/**
 * Whether a workflow runs on `push` to `branch`: its `on:` names `push`, and a `branches` filter,
 * when it has one, matches it (a glob is taken to match), and a `branches-ignore` doesn't name it.
 * @param {Record<string, any>} wf @param {string} branch
 */
export const runsOnPush = (wf, branch) => {
  const on = triggers(wf);
  if (!on?.includes('push')) return false;
  const push = isMap(wf.on) ? wf.on.push : null;
  if (!isMap(push)) return true;
  /** @param {unknown} v @returns {string[]} */
  const list = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.map(String) : []);
  if (push.branches !== undefined) return list(push.branches).some((b) => b === branch || /[*?[]/.test(b));
  if (push.tags !== undefined && push['branches-ignore'] === undefined) return false;
  return !list(push['branches-ignore']).includes(branch);
};

/** The three rules a release-tag ruleset holds (plan 0010 §12): who may create, move or delete a tag. */
export const TAG_RULES = /** @type {const} */ (['creation', 'update', 'deletion']);

/**
 * Whether a ruleset restricts who may create, move and delete tags (`deploy.tag-ruleset`): an
 * active one, on tags, with the creation, update and deletion rules all. One that restricts
 * creation alone doesn't: moving an existing release tag onto another commit opens the same path.
 * @param {any} r a ruleset, read whole
 */
export const restrictsTags = (r) => isMap(r) && r.target === 'tag' && r.enforcement === 'active'
  && TAG_RULES.every((t) => (Array.isArray(r.rules) ? r.rules : []).some((/** @type {any} */ x) => x?.type === t));

// ── The requirements of a release ─────────────────────────────────────────────────────────

/**
 * A release's requirements file: this tree's own when it is that release, otherwise read from
 * Kanon's repository at the release's tag. Throws naming the release when there is none.
 * @param {Deps} deps @param {string} release
 * @returns {Promise<Requirements>}
 */
export const requirementsAt = async (deps, release) => {
  if (release === deps.release()) return deps.requirements();
  const r = await deps.gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${KANON_REPO}/contents/requirements.json?ref=${encodeURIComponent(release)}`]);
  if (r.status !== 0) {
    const why = r.stderr.trim() || `exit ${r.status}`;
    throw new Error(/HTTP 404|Not Found/i.test(why) ? `Kanon ${release} ships no requirements file (requirements.json); doctor can check against a release from v0.28.0 on, the first that ships one` : `could not read Kanon ${release}'s requirements file (${why})`);
  }
  try {
    const req = JSON.parse(r.stdout);
    if (!isMap(req) || !isMap(req.lanes) || !isMap(req.identities)) throw new Error('not a requirements file');
    return /** @type {Requirements} */ (req);
  } catch {
    throw new Error(`Kanon ${release}'s requirements.json is not a requirements file this doctor reads`);
  }
};

/**
 * A release's brief template (`K-LAYOUT-11`): this tree's own when it is that release, otherwise
 * read from Kanon's repository at the release's tag, as `requirementsAt` reads its requirements.
 * Throws naming the release when it can't be read.
 * @param {Deps} deps @param {string} release
 * @returns {Promise<string>}
 */
export const briefTemplateAt = async (deps, release) => {
  if (release === deps.release()) return deps.briefTemplate();
  const r = await deps.gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${KANON_REPO}/contents/rulebook/templates/brief.md?ref=${encodeURIComponent(release)}`]);
  if (r.status !== 0) throw new Error(`could not read Kanon ${release}'s brief template (${r.stderr.trim() || `exit ${r.status}`})`);
  return r.stdout;
};

/**
 * Kanon's latest stable release, as GitHub's latest release names it (plan 0009 §4): a candidate
 * is a pre-release, which GitHub never makes the latest. Null when the call fails or names no
 * stable release, so the caller says it couldn't tell.
 * @param {Deps} deps
 * @returns {Promise<string | null>}
 */
export const latestStable = async (deps) => {
  try {
    const r = await deps.gh(['api', `repos/${KANON_REPO}/releases/latest`]);
    if (r.status !== 0) return null;
    const tag = JSON.parse(r.stdout)?.tag_name;
    return typeof tag === 'string' && STABLE_RELEASE.test(tag) ? tag : null;
  } catch {
    return null;
  }
};

// ── The run ───────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {{ id: string, category: string, blocking: boolean, subject: string, message: string,
 *   fix: { text: string, commands: string[], url: string | null } }} Finding
 * @typedef {Finding & { items: string[], line: number, reason: string }} Waived
 * @typedef {{ text: string, commands?: string[], url?: string | null }} FixIn
 * @typedef {{ workflow: string, job: string, grant: 'job' | 'workflow', how: 'id-token' | 'write-all',
 *   calls: string | null, status: 'kanon-lane' | 'accepted' | 'unaccepted', reason: string | null }} Holder
 */

/**
 * `kanon doctor`. Returns the exit code (`EXIT`).
 * @param {string[]} argv @param {Partial<Deps>} [overrides]
 */
export const doctor = async (argv, overrides = {}) => {
  const deps = { ...realDeps, ...overrides };
  const wantsJson = argv.includes('--json');
  /** @type {ReturnType<typeof parseArgs>} */
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    const message = /** @type {Error} */ (e).message;
    if (wantsJson) deps.out(JSON.stringify(errorDocument(deps, EXIT.usage, message), null, 2));
    else {
      deps.err(`kanon doctor: ${message}`);
      deps.err(USAGE);
    }
    return EXIT.usage;
  }
  if (opts.help) {
    deps.out(USAGE);
    return EXIT.healthy;
  }
  // An error `diagnose` did not expect is the error document too, so `--json` always prints one
  // (#375). Doctor changes nothing, so there is nothing done to record.
  /** @type {Awaited<ReturnType<typeof diagnose>>} */
  let result;
  try {
    result = await diagnose(deps, opts);
  } catch (e) {
    result = { error: `stopped on an unexpected error: ${/** @type {Error} */ (e).message}` };
  }
  if (result.error !== undefined || !result.report) {
    const error = result.error ?? 'no report';
    if (opts.json) deps.out(JSON.stringify(errorDocument(deps, EXIT.error, error), null, 2));
    else deps.err(`kanon doctor: ${error}`);
    return EXIT.error;
  }
  if (opts.json) deps.out(JSON.stringify(result.report, null, 2));
  else for (const line of prose(result.report)) deps.out(line);
  return result.report.exitCode;
};

/** @param {Deps} deps @param {number} exitCode @param {string} error */
const errorDocument = (deps, exitCode, error) => ({ schema: SCHEMA, kanon: deps.release(), status: 'error', exitCode, error });

/**
 * Everything `doctor` finds, as the JSON document it prints, or the reason it could not run.
 * @param {Deps} deps @param {ReturnType<typeof parseArgs>} opts
 */
export const diagnose = async (deps, opts) => {
  // The checkout, and the repository it is of: as `kanon init` finds them.
  const top = deps.git(['-C', resolve(opts.dir), 'rev-parse', '--show-toplevel']);
  if (top.status !== 0) return { error: `${resolve(opts.dir)} is not a git checkout. Run it from your repository's checkout, or pass --dir.` };
  let repo = opts.repo;
  if (!repo) {
    const origin = deps.git(['-C', top.stdout.trim(), 'remote', 'get-url', 'origin']);
    repo = (origin.status === 0 && remoteRepo(origin.stdout)) || '';
    if (!repo) return { error: `${top.stdout.trim()} has no origin remote on GitHub; pass --repo <owner>/<repo>.` };
  }
  const [ownerName = '', repoName = ''] = repo.split('/');
  const where = checkoutCheck(/** @type {import('./apps.mjs').Deps} */ (/** @type {unknown} */ ({ git: deps.git })), opts.dir, ownerName, repoName);
  if (where.refusal) return { error: `${where.refusal[0]} Run it from the checkout of ${repo}, or pass --repo for the checkout's own repository.` };
  const root = where.root;
  const read = (/** @type {string} */ rel) => deps.readFile(join(root, rel));
  const branch = deps.git(['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const head = deps.git(['-C', root, 'rev-parse', 'HEAD']);

  const who = await whoami(deps.gh, deps.env);
  if (who.refusal) return { error: who.refusal.join(' ') };

  // The files under `.github/`, and the workflows parsed.
  const github = deps.listFiles(join(root, '.github')).map((f) => `.github/${f}`);
  /** @type {Map<string, string>} */
  const texts = new Map();
  for (const f of github.filter((x) => /\.ya?ml$/.test(x))) texts.set(f, read(f) ?? '');
  /** @type {Array<{ check: string, subject: string, reason: string }>} */
  const unchecked = [];
  /** @type {Map<string, Record<string, any>>} */
  const workflows = new Map();
  for (const f of github.filter((x) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(x))) {
    try {
      const doc = parseYaml(texts.get(f) ?? '');
      if (isMap(doc)) workflows.set(f, doc);
    } catch (e) {
      unchecked.push({ check: 'workflow', subject: f, reason: `could not read it: ${/** @type {Error} */ (e).message}` });
    }
  }

  // The release the callers pin, and the one to check against.
  // A prebuilt notify hook's pin of Kanon's own notify action is not the callers' pin: it follows
  // theirs, and `notify.hook-pin-behind` notes a mismatch without blocking (plan 0011 decision 18).
  const pins = kanonPins(new Map([...texts].map(([p, t]) => [p, p === NOTIFY_HOOK ? t.split('\n').filter((l) => !PREBUILT_REF.test(l)).join('\n') : t])));
  const exact = [...pins.keys()].filter((r) => EXACT_RELEASE.test(r));
  if (!exact.length) return { error: `nothing in ${repo}'s .github/ pins Kanon to an exact release (yedeya-labs/kanon/...@vX.Y.Z, or @candidate-vX.Y.Z). Install it with kanon init first.` };
  const laneCallers = [...workflows].flatMap(([, wf]) => Object.values(isMap(wf.jobs) ? wf.jobs : {}).map((j) => kanonCall(j?.uses)).filter((c) => c && c.workflow.startsWith('agent-')).map((c) => /** @type {{ ref: string }} */ (c).ref));
  const count = (/** @type {string} */ r) => laneCallers.filter((x) => x === r).length;
  const pinned = /** @type {string} */ ([...exact].sort((a, b) => count(b) - count(a) || newer(b, a))[0]);
  const checked = opts.to ?? pinned;
  /** @type {Requirements} */
  let req;
  try {
    req = await requirementsAt(deps, checked);
  } catch (e) {
    return { error: /** @type {Error} */ (e).message };
  }

  /** @type {Inspection} */
  let s;
  try {
    // `inspect` reads through `gh` alone.
    s = await inspect(/** @type {import('./init.mjs').Deps} */ (/** @type {unknown} */ (deps)), repo);
  } catch (e) {
    return { error: /** @type {Error} */ (e).message };
  }

  /** @type {Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const notes = [];
  /**
   * @param {string} id @param {string} subject @param {string} message
   * @param {{ text: string, commands?: string[], url?: string | null }} fix
   * @param {boolean} [warnOnly] a finding of a blocking id that doesn't block yet: a fixed
   *   caller's name or job id against a release before `FAILS_FROM`, which lane-check warns of,
   *   or a deploy check a fallback marker turns into a note (plan 0010 §13)
   * @param {boolean} [escalate] a finding of a note's id that blocks here: `deploy.tag-ruleset`
   *   under the `no-reviewers` marker
   */
  const find = (id, subject, message, fix, warnOnly = false, escalate = false) => {
    const kind = FINDINGS[id];
    if (!kind) throw new Error(`no finding "${id}" in FINDINGS`);
    findings.push({ id, category: kind.category, blocking: (kind.blocking && !warnOnly) || escalate, subject, message, fix: { text: fix.text, commands: fix.commands ?? [], url: fix.url ?? null } });
  };
  /**
   * The items each finding of an `ITEMIZED` id lists, and how to write it again for some of them,
   * so a waiver that names only some leaves the rest a finding (#406).
   * @type {Map<Finding, { items: string[], build: (items: string[]) => [string, FixIn] }>}
   */
  const itemized = new Map();
  /**
   * A finding that lists `items`: `build` writes its message and fix for any of them.
   * @param {string} id @param {string} subject @param {string[]} items
   * @param {(items: string[]) => [string, FixIn]} build
   */
  const findItems = (id, subject, items, build) => {
    if (!ITEMIZED[id]) throw new Error(`no finding "${id}" in ITEMIZED`);
    const [message, fix] = build(items);
    find(id, subject, message, fix);
    itemized.set(/** @type {Finding} */ (findings[findings.length - 1]), { items, build });
  };
  /** The finding `f` written again for some of its items. @param {Finding} f @param {string[]} items @returns {Finding} */
  const remake = (f, items) => {
    const [message, fix] = /** @type {{ build: (items: string[]) => [string, FixIn] }} */ (itemized.get(f)).build(items);
    return { ...f, message, fix: { text: fix.text, commands: fix.commands ?? [], url: fix.url ?? null } };
  };
  // The workflows are read from the checkout, not from the default branch through the API.
  const branchName = branch.status === 0 ? branch.stdout.trim() : null;
  const onCheckout = branchName && branchName !== 'HEAD' ? branchName : 'this checkout';
  const checking = opts.to ? `${checked} (the release you are moving to)` : `${checked} (the release the callers pin)`;

  if (exact.length > 1 || pins.size > exact.length) {
    const list = [...pins].map(([r, files]) => `${r} (${files.join(', ')})`).join('; ');
    find('pin.mixed', '.github', `Kanon's references pin more than one release, or a ref that is not an exact release: ${list}. lane-check requires one exact release everywhere (K-ADOPT-11).`, {
      text: `Pin every yedeya-labs/kanon reference under .github/ to ${checked}.`,
    });
  }

  // ── A candidate pin (plan 0009 §4, K-ADOPT-11) ─────────────────────────────────────────
  // Running ahead of stable is allowed, so it is a note with the latest stable release beside it,
  // never a fault. The same for every repository: nothing here asks which one it is.
  const stable = await latestStable(deps);
  if (!STABLE_RELEASE.test(pinned)) {
    const promoted = pinned.replace(/^candidate-/, '');
    find('pin.candidate', '.github', stable
      ? `Kanon's references pin a candidate, ${pinned}; the latest stable release is ${stable}. A candidate is an exact release, the same code before it is promoted to ${promoted}, so running ahead of stable is allowed (K-ADOPT-11).`
      : `Kanon's references pin a candidate, ${pinned}; doctor couldn't tell the latest stable release (it could not read ${KANON_REPO}'s latest release). Running ahead of stable is allowed (K-ADOPT-11).`, {
      text: stable && newer(stable, pinned) >= 0
        ? `Nothing to do while you mean to run ahead. To follow stable, move every yedeya-labs/kanon reference under .github/, and the plugin's ref, to ${stable}; the upgrade skill does it.`
        : `Nothing to do while you mean to run ahead. To follow stable, move every yedeya-labs/kanon reference under .github/, and the plugin's ref, to ${promoted} once it is promoted.`,
    });
  }

  // ── The kanon plugin's release ──────────────────────────────────────────────────────────
  // Declared in the project's .claude/settings.json (#376, cli/plugin.mjs), the plugin's release
  // is in the repository, where doctor can compare it with the release it checks against: the
  // skills run `kanon` from the release they ship in, and install that release. Not blocking: no
  // lane reads it, and the two move at different times (the upgrade skill moves the ref with the
  // pins, Dependabot the pins alone, release-please in Kanon's own repository the ref first).
  const plugin = readPluginDeclaration(read(SETTINGS_PATH));
  if (plugin.status === 'unreadable') unchecked.push({ check: 'plugin', subject: SETTINGS_PATH, reason: `could not read it: ${plugin.reason}` });
  else if (plugin.status === 'declared') {
    if (plugin.ref !== checked) {
      find('plugin.version-mismatch', SETTINGS_PATH, `declares the kanon plugin's marketplace "${plugin.name}" ${plugin.ref ? `at ${plugin.ref}` : "with no ref, so it follows Kanon's default branch"}, not at ${checking}; the skills run kanon from the release they ship in, and install it (K-ADOPT-11).`, {
        text: `Set the "${plugin.name}" marketplace's ref in ${SETTINGS_PATH} to ${checked}. Claude Code fetches the marketplace again from the changed source; run /reload-plugins in a session that is open.`,
        commands: [`"ref": "${checked}"`],
      });
    }
    if (!plugin.enabled) notes.push(`${SETTINGS_PATH} declares the kanon plugin's marketplace "${plugin.name}" but doesn't enable kanon@${plugin.name} under enabledPlugins, so nobody gets its skills from it (docs/skills.md).`);
  } else {
    notes.push(`${SETTINGS_PATH} doesn't declare the kanon plugin${plugin.status === 'undeclared' && plugin.enabled.length ? ` (it enables ${plugin.enabled.join(', ')}, from a marketplace each person added themselves)` : ''}, so its release lives in each person's Claude Code configuration, where doctor can't compare it with the callers' (docs/skills.md).`);
  }

  // ── The callers ─────────────────────────────────────────────────────────────────────────
  /** @type {Array<{ file: string, wf: Record<string, any>, jobName: string, job: Record<string, any>, lane: string }>} */
  const callers = [];
  /** @type {Array<{ file: string, job: Record<string, any> }>} */
  const appsCheckCallers = [];
  // Each job that calls the release workflow, by Kanon's pin, `$/` or a local path (#441): read
  // only to tell whether the Releaser is in use, so a `$/` caller meets no rule of a pinned one.
  /** @type {Array<{ file: string, job: Record<string, any> }>} */
  const releaseCallers = [];
  for (const [file, wf] of workflows) {
    for (const [jobName, job] of Object.entries(isMap(wf.jobs) ? wf.jobs : {})) {
      if (!isMap(job)) continue;
      if (releaseCall(job.uses)) releaseCallers.push({ file, job });
      const call = kanonCall(job.uses);
      if (!call) continue;
      if (call.workflow === 'apps-check') appsCheckCallers.push({ file, job });
      else if (call.workflow.startsWith('agent-') && call.workflow !== 'agent-lane') callers.push({ file, wf, jobName, job, lane: call.workflow });
    }
  }
  const installed = [...new Set(callers.map((c) => c.lane))].filter((l) => req.lanes[l]).sort();
  // THE QA STORE (kanon#433): its two secrets are the store-coupled lanes' optional ones, which a
  // caller maps once the repository has a store hook, and may leave out until then. So they are
  // asked for only where the hook exists.
  const storeSecrets = req.qaStore?.secrets ?? [];
  const hasStore = Boolean(req.qaStore && read(req.qaStore.hook) !== null);
  // From kanon#479 the `qa-store` block takes no `variables`, so the hook reads the secrets alone:
  // a store secret is then needed even where a variable still holds its value. A release whose
  // requirements file doesn't say so (v0.34.x) still passed the variables, as a fallback.
  const secretsOnly = req.qaStore?.secretsOnly === true;
  /**
   * The pair of Claude credentials a lane takes, of which its caller maps exactly one (plan 0009
   * §10): requirements.json's `claude`. None for a lane that runs no model, or against a release
   * whose requirements file has no `claude`, where the token is one of the lane's `secrets`.
   * @param {string} lane @returns {string[]}
   */
  const pairOf = (lane) => {
    const pair = /** @type {{ claude?: unknown }} */ (/** @type {unknown} */ (req.lanes[lane] ?? {})).claude;
    return Array.isArray(pair) ? pair.map(String) : [];
  };
  /** Each caller of a lane with a pair that maps exactly one of it, and which (`claude.mixed`). @type {Array<{ file: string, lane: string, maps: string }>} */
  const onCredential = [];
  // CHAT NOTIFICATIONS (plan 0011 §9): the checked release's `notify` entry, none before it.
  const notify = /** @type {NotifyRequirements | undefined} */ (/** @type {any} */ (req).notify);
  /** The kind a lane notifies at the checked release, or null. @param {string} lane */
  const kindOf = (lane) => (notify ? Object.entries(notify.kinds).find(([, k]) => k.lanes.includes(lane))?.[0] ?? null : null);
  /** @param {string} kind */
  const kindSecret = (kind) => /** @type {NotifyRequirements} */ (notify).kinds[kind]?.secret ?? '';
  /** `notify.legacy-secret` on one caller. @param {string} file @param {string} lane @param {string} kind */
  const legacyFinding = (file, lane, kind) => {
    const old = /** @type {NotifyRequirements} */ (notify).legacySecret;
    const name = kindSecret(kind);
    find('notify.legacy-secret', file, `maps ${old}, which the lane ${lane} no longer takes at ${checked}: it posts through the hook at ${NOTIFY_HOOK} with one secret per message kind, ${name} for ${kind}, and no lane accepts ${old} (plan 0011 decision 17). GitHub refuses a call that passes a secret the called workflow doesn't declare, so the lane doesn't start at all until the line goes, health job included.`, {
      text: `Remove the first line from the job's secrets: and add the second in its place. Then store the kind's secret ${OWN_TERMINAL} (GitHub never shows ${old}'s value, so fetch the webhook's URL from your chat system again), and add a hook at ${NOTIFY_HOOK} (doctor's notify.none says how). Without both, ${kind} is not posted, and the rest of the lane runs:`,
      commands: [`      ${old}: \${{ secrets.${old} }}`, `      ${name}: \${{ secrets.${name} }}`, `gh secret set ${name} -R ${repo}`],
    });
  };

  for (const c of callers) {
    const spec = req.lanes[c.lane];
    if (!spec) {
      find('caller.lane-removed', c.file, `calls the lane ${c.lane}, which Kanon ${checked} does not ship.`, { text: `Remove ${c.file}, or replace it with the lane that took ${c.lane}'s place (the release notes of ${checked} say which).` });
      continue;
    }
    if (c.file !== `.github/workflows/${c.lane}.yml`) {
      find('caller.misplaced', c.file, `calls the lane ${c.lane}, so it must live at .github/workflows/${c.lane}.yml (K-LAYOUT-18): that is the name Kanon's scripts fall back to when they can't find the lane's caller on the default branch.`, {
        text: `Rename it to .github/workflows/${c.lane}.yml.`,
        commands: [`git mv ${c.file} .github/workflows/${c.lane}.yml`],
      });
    }
    const want = spec.secrets;
    if (!isMap(c.job.secrets)) {
      find('caller.secrets-inherited', c.file, `maps no secrets by name (secrets: ${String(c.job.secrets ?? 'none')}); the lane ${c.lane} takes exactly ${want.join(', ') || 'none'}, each mapped explicitly (plan 0001 decision 7).`, {
        text: `Replace the job's secrets: with one line per secret the lane takes.`,
        commands: want.map((n) => `      ${n}: \${{ secrets.${n} }}`),
      });
    } else {
      const got = Object.keys(c.job.secrets);
      const optional = spec.optionalSecrets ?? [];
      // The Claude credential is one of a pair, which the two findings below hold instead.
      const pair = pairOf(c.lane);
      const missing = want.filter((n) => !got.includes(n) && !optional.includes(n) && !pair.includes(n));
      const staleAll = got.filter((n) => !want.includes(n) && !pair.includes(n));
      // The chat secret the kind secrets replace (plan 0011 decision 17): a notifying caller that
      // still maps it is `notify.legacy-secret`, in place of `caller.secret-stale`, with the
      // notify fix.
      const kind = kindOf(c.lane);
      const legacy = notify && kind && staleAll.includes(notify.legacySecret) ? notify.legacySecret : null;
      const stale = staleAll.filter((n) => n !== legacy);
      if (legacy && kind) legacyFinding(c.file, c.lane, kind);
      const maps = pair.filter((n) => got.includes(n));
      if (pair.length && maps.length > 1) {
        find('caller.claude-both', c.file, `maps both ${maps.join(' and ')}; the lane ${c.lane} runs on one Claude credential at ${checked}, so its run fails before the agent starts. Map one (plan 0009 §10).`, {
          text: `Keep the line of the credential this lane runs on, and remove the other's from the job's secrets (the subscription's token, or an Anthropic API key):`,
          commands: maps.map((n) => `      ${n}: \${{ secrets.${n} }}`),
        });
      } else if (pair.length && !maps.length) {
        find('caller.claude-none', c.file, `maps neither ${pair.join(' nor ')}; the lane ${c.lane} runs on one Claude credential at ${checked}, so its run fails before the agent starts, with no Claude credential. Map one (plan 0009 §10).`, {
          text: `Add one of these under the job's secrets: the first for a Claude subscription's token, the second for an Anthropic API key:`,
          commands: pair.map((n) => `      ${n}: \${{ secrets.${n} }}`),
        });
      } else if (maps.length === 1) onCredential.push({ file: c.file, lane: c.lane, maps: /** @type {string} */ (maps[0]) });
      const unmapped = optional.filter((n) => !got.includes(n) && storeSecrets.includes(n));
      if (missing.length) {
        findItems('caller.secret-missing', c.file, missing, (xs) => [`does not map ${xs.join(', ')}, which the lane ${c.lane} takes at ${checked}.`, {
          text: `Add under the job's secrets:`,
          commands: xs.map((n) => `      ${n}: \${{ secrets.${n} }}`),
        }]);
      }
      if (stale.length) {
        findItems('caller.secret-stale', c.file, stale, (xs) => [`maps ${xs.join(', ')}, which the lane ${c.lane} does not take at ${checked}; GitHub refuses a call that passes a secret the called workflow does not declare.`, {
          text: `Remove these lines from the job's secrets:`,
          commands: xs.map((n) => `      ${n}: \${{ secrets.${n} }}`),
        }]);
      }
      if (hasStore && unmapped.length) {
        findItems('qa-store.unmapped', c.file, unmapped, (xs) => [`does not map ${xs.join(' or ')}, so the lane ${c.lane} hands ${req.qaStore?.hook} no store secrets: its store jobs ${secretsOnly ? `reach no store, since Kanon ${checked} passes the hook no variables to fall back to` : "read the deprecated variables, which every store job's log prints, or reach no store"} (docs/qa-store.md, "Move the coordinates to secrets").`, {
          text: `Add under the job's secrets:`,
          commands: xs.map((n) => `      ${n}: \${{ secrets.${n} }}`),
        }]);
      }
    }
    const stale = Object.keys(isMap(c.job.with) ? c.job.with : {}).filter((k) => !spec.inputs[k]);
    if (stale.length) {
      findItems('caller.input-stale', c.file, stale, (xs) => [`passes ${xs.join(', ')}, which the lane ${c.lane} does not declare at ${checked}.`, { text: `Remove ${xs.map((k) => `\`${k}\``).join(', ')} from the job's with:, and the dispatch input${xs.length > 1 ? 's' : ''} that feed${xs.length > 1 ? '' : 's'} ${xs.length > 1 ? 'them' : 'it'}.` }]);
    }
    const grant = c.job.permissions !== undefined ? c.job.permissions : c.wf.permissions;
    const short = Object.entries(spec.grant).filter(([k, v]) => !isMap(grant) || level(grant[k]) < level(v));
    if (short.length) {
      findItems('caller.grant-missing', c.file, short.map(([k]) => k), (xs) => {
        const some = short.filter(([k]) => xs.includes(k));
        return [isMap(grant)
        ? `grants ${some.map(([k]) => `${k}: ${grant[k] ?? 'none'}`).join(', ')}; the lane ${c.lane} needs ${some.map(([k, v]) => `${k}: ${v}`).join(', ')} at ${checked}.`
        : grant === undefined
          ? `grants no explicit permissions; the calling job's permissions: are the lane ${c.lane}'s ceiling (plan 0001 §3).`
          : `grants \`permissions: ${String(grant)}\` rather than a map; the calling job's permissions: are the lane ${c.lane}'s ceiling, so lane-check requires the lane's grant written out (plan 0001 §3).`, {
        text: isMap(grant) ? `Grant under the caller's permissions:` : `Replace the caller's permissions: with the lane's grant:`,
        commands: isMap(grant) ? some.map(([k, v]) => `  ${k}: ${v}`) : ['permissions:', ...Object.entries(spec.grant).map(([k, v]) => `  ${k}: ${v}`)],
      }];
      });
    }
    // The review, implement-revise and merge-reconcile callers' names, and the two racers' job
    // ids, which the Merger tells their checks apart by (kanon#728, #743): lane-check's own table
    // and wording, and its switch, a warning before `FAILS_FROM` and a failure from it, read here
    // at the checked release, which is the one the callers' lane-check runs at once they pin it.
    // What they must be is the checked release's `# CALLER NAME:` and `# CALLER JOB:` lines, as
    // its requirements file records them, or the table for a release from before the lines.
    const fixed = FIXED_CALLERS[c.lane];
    if (fixed) {
      const want = spec.callerName ? { name: spec.callerName, ...(spec.callerJob ? { job: spec.callerJob } : {}) } : fixed;
      const jobs = Object.keys(isMap(c.wf.jobs) ? c.wf.jobs : {});
      const [named] = callerNameFindings(c.lane, String(c.wf.name ?? ''), null, checked, want);
      const [jobbed] = callerNameFindings(c.lane, want.name, jobs.length === 1 ? c.jobName : null, checked, want);
      if (named) find('caller.name', c.file, `${named.message}.`, { text: `Set the workflow's name:`, commands: [`name: ${want.name}`] }, named.level === 'warning');
      if (jobbed && want.job) find('caller.job-id', c.file, `${jobbed.message}.`, { text: `Rename the calling job from \`${c.jobName}:\` to:`, commands: [`  ${want.job}:`] }, jobbed.level === 'warning');
    } else if (spec.callerName && c.wf.name !== spec.callerName) {
      find('caller.name', c.file, `is named "${String(c.wf.name ?? '')}"; the lane ${c.lane} tells its own checks apart by its caller's name, which must be "${spec.callerName}".`, { text: `Set the workflow's name:`, commands: [`name: ${spec.callerName}`] });
    }
    if (spec.callerRunNameEndsWith && !String(c.wf['run-name'] ?? '').endsWith(` ${spec.callerRunNameEndsWith}`)) {
      find('caller.run-name', c.file, `has a run-name that does not end with \` ${spec.callerRunNameEndsWith}\`; the lane ${c.lane}'s runs are found by it.`, { text: `End the workflow's run-name: with that text, as its last token.` });
    }
  }
  // ── Callers on different Claude credentials (plan 0009 §10, Owner decision 9) ───────────
  // Allowed: each caller decides. A note naming which lanes run on which, never a fault.
  const credentials = [...new Set(onCredential.map((x) => x.maps))].sort();
  if (credentials.length > 1) {
    const on = (/** @type {string} */ n) => [...new Set(onCredential.filter((x) => x.maps === n).map((x) => x.lane))].sort();
    find('claude.mixed', '.github/workflows', `The callers map different Claude credentials: ${credentials.map((n) => `${on(n).join(', ')} on ${n}`).join('; ')}. Each caller may choose (plan 0009 §10); the repository must hold each one mapped, and the lanes on the token share the subscription's weekly usage.`, {
      text: `Nothing to do if the mix is meant. To run every lane on one, map that one in each caller, as kanon init --claude-auth subscription or --claude-auth api-key writes them.`,
    });
  }

  // ── The Apps the lanes run as ─────────────────────────────────────────────────────────────
  const identities = [...new Set(installed.flatMap((l) => req.lanes[l]?.identities ?? []))];
  const releaserSecrets = appSecrets('releaser');
  if (req.identities.apps.releaser && releaseCallers.some((c) => isMap(c.job.secrets) && releaserSecrets.some((n) => n in c.job.secrets))) identities.push('releaser');
  identities.sort();
  const registerText = read(REGISTER_PATH);
  const rows = registerRows(registerText);
  // The Apps installed that aren't agents (K-AGENT-3): no lane runs as one, so only the slug they
  // may not share, and the installed Apps the register still names, read them.
  const otherApps = registerOtherApps(registerText);
  /** @type {Map<string, string>} identity → its one slug */
  const slugOf = new Map();
  /** @type {Map<string, string[]>} slug → identities */
  const bySlug = new Map();
  for (const id of identities) {
    /** @type {string[]} */
    let roles;
    try {
      roles = registerRolesOf(id, req);
    } catch (e) {
      return { error: `Kanon ${checked}'s requirements file is inconsistent: ${/** @type {Error} */ (e).message}` };
    }
    const missingRows = roles.filter((r) => !rows.has(r));
    const slugs = [...new Set(roles.map((r) => rows.get(r)).filter((x) => x !== undefined))];
    const apps = (() => {
      try {
        return `kanon apps --owner ${s.owner} --repo ${repoName} ${appsArgs([id], req).join(' ')}`;
      } catch {
        return `kanon apps --owner ${s.owner} --repo ${repoName}`;
      }
    })();
    if (missingRows.length) {
      findItems('register.missing-row', REGISTER_PATH, missingRows, (xs) => [`lists no ${xs.join(', ')} row, which the ${id} App's lanes read their App slug from (K-LAYOUT-6).`, {
        text: slugs.length === 1
          ? `Add the row${xs.length > 1 ? 's' : ''} naming the ${id} App's slug \`${slugs[0]}\`, or let kanon apps write them, and commit the register.`
          : `Create the ${id} App from this checkout, and commit the register rows it writes.`,
        commands: slugs.length === 1 ? [] : [apps],
      }]);
    }
    if (slugs.length > 1) {
      findItems('register.split-slug', REGISTER_PATH, [id], () => [`names more than one App for the ${id} App's roles (${roles.map((r) => `${r}: ${rows.get(r) ?? 'none'}`).join(', ')}); since plan 0005 each App's roles share one slug (§3.4).`, {
        text: `Create the ${id} App, or reuse the owner's, and point each of its roles' rows at its slug; then commit the register.`,
        commands: [apps],
      }]);
    }
    if (slugs.length === 1) {
      const slug = /** @type {string} */ (slugs[0]);
      slugOf.set(id, slug);
      bySlug.set(slug, [...(bySlug.get(slug) ?? []), id]);
    }
  }
  for (const [slug, ids] of bySlug) {
    if (ids.length > 1) {
      find('register.shared-slug', REGISTER_PATH, `names the App \`${slug}\` for ${ids.join(' and ')}; ${ids.includes('author') && ids.includes('judge') ? 'an App that authors and approves approves its own pull requests' : 'each App holds its own roles alone'} (plan 0005 §3.4).`, {
        text: `Give each its own App, and point its roles' rows at that App's slug.`,
      });
    }
  }
  // An Other App row names an App no role's row names ([REG-2], issue #990): every role's, not only
  // the lanes' in use here, as the lanes' own parser reads it.
  const reLabelled = [...new Set(otherApps)].flatMap((slug) => {
    const roles = [...rows].filter(([, s]) => s === slug).map(([r]) => r);
    return roles.length ? [`\`${slug}\` on an Other App row and the ${roles.join(', ')} row${roles.length > 1 ? 's' : ''}`] : [];
  });
  if (reLabelled.length) {
    find('register.other-app-slug', REGISTER_PATH, `names ${reLabelled.join(', and ')}. An Other App row is an App that isn't an agent, so it names an App no role's row names: one naming an agent's App would re-label it, and the lanes refuse the register (K-LAYOUT-6).`, {
      text: `Remove the Other App row of an App that already has a role's row; if it is another App, write that App's own slug.`,
    });
  }
  // GitHub shows a private App only to the App itself: GET /apps/<slug> answers 404 to a person's
  // token and the workflow's alike (#417). apps-check reads each installation with the App's own
  // key and prints what it found (cli/apps-check.mjs), and a run's log is readable with
  // Actions: read. Only the latest completed run dispatched on the default branch counts: its
  // workflow is the reviewed one, and an older run may predate a change. The branch filter alone
  // doesn't hold that: it matches a run's head_branch, and a pull request from a fork's own `main`
  // has that too, and runs the fork's workflow. So the query asks the server for workflow_dispatch
  // runs only, the one trigger the caller declares and one a fork can't start, and a run from
  // another repository or another trigger is refused, never read.
  const appsCheckPath = appsCheckCallers[0]?.file ?? (workflows.has('.github/workflows/apps-check.yml') ? '.github/workflows/apps-check.yml' : null);
  const appsCheckName = appsCheckPath ? basename(appsCheckPath) : 'apps-check.yml';
  const runAppsCheck = appsCheckPath
    ? `run ${appsCheckName} on ${s.defaultBranch} (gh workflow run ${appsCheckName} -R ${repo}), then doctor again`
    : `add the apps-check caller (docs/apps.md), run it on ${s.defaultBranch}, then doctor again`;
  const ghJsonOf = (/** @type {GhResult} */ r) => {
    try {
      return r.status === 0 ? JSON.parse(r.stdout) : null;
    } catch {
      return null;
    }
  };
  /** @type {Promise<{ run: any, jobs: any[] } | { reason: string }> | null} */
  let latestAppsCheck = null;
  const appsCheckRun = () =>
    (latestAppsCheck ??= (async () => {
      if (!appsCheckPath) return { reason: `no apps-check workflow is there to read it from: ${runAppsCheck}` };
      const runs = await deps.gh(['api', `repos/${repo}/actions/workflows/${appsCheckName}/runs?branch=${encodeURIComponent(s.defaultBranch)}&event=workflow_dispatch&status=completed&per_page=1`]);
      const list = ghJsonOf(runs)?.workflow_runs;
      if (!Array.isArray(list)) return { reason: `the token can't list ${appsCheckName}'s runs, which needs Actions: read (${runs.stderr.trim() || `exit ${runs.status}`})` };
      const run = list[0];
      if (!isMap(run)) return { reason: `${appsCheckName} has no completed run on ${s.defaultBranch}: ${runAppsCheck}` };
      const from = isMap(run.head_repository) ? String(run.head_repository.full_name ?? '') : '';
      if (run.event !== 'workflow_dispatch' || from.toLowerCase() !== repo.toLowerCase()) {
        return { reason: `the latest ${appsCheckName} run on ${s.defaultBranch} (${run.html_url}) was started by ${run.event || 'an unknown event'} from ${from || 'an unknown repository'}, not dispatched in ${repo}, so its workflow may not be the reviewed one: ${runAppsCheck}` };
      }
      const jobs = await deps.gh(['api', `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`]);
      const all = ghJsonOf(jobs)?.jobs;
      if (!Array.isArray(all)) return { reason: `the token can't list the jobs of ${run.html_url}, which needs Actions: read (${jobs.stderr.trim() || `exit ${jobs.status}`})` };
      return { run, jobs: all };
    })());
  /**
   * What the latest apps-check run found on the App's installation, or why it can't be used.
   * @param {string} id @param {string} slug
   * @returns {Promise<{ result: import('./apps-check.mjs').Result, when: string } | { reason: string }>}
   */
  const fromAppsCheck = async (id, slug) => {
    const found = await appsCheckRun();
    if ('reason' in found) return found;
    const when = `the ${appsCheckName} run of ${String(found.run.created_at ?? '').slice(0, 10)} (${found.run.html_url})`;
    const name = req.identities.apps[id]?.name;
    const job = name ? found.jobs.find((j) => isMap(j) && (j.name === name || String(j.name).endsWith(` / ${name}`))) : undefined;
    if (!job) return { reason: `${when} has no job for the ${id} App: ${runAppsCheck}` };
    const path = `repos/${repo}/actions/jobs/${job.id}/logs`;
    // The log holds terminal escapes, which gh prints only when asked; a gh too old to know the
    // flag prints them anyway.
    let log = await deps.gh(['api', '--allow-escape-sequences', path]);
    if (log.status !== 0 && /unknown flag/.test(log.stderr)) log = await deps.gh(['api', path]);
    if (log.status !== 0) return { reason: `the token can't read the log of ${when}, which needs Actions: read (${log.stderr.trim() || `exit ${log.status}`})` };
    const result = readResult(log.stdout, id);
    if (!result && resultMasked(log.stdout)) return { reason: `${when} printed a result for the ${id} App that the runner masked part of, where a secret's value appeared in it, so it can't be read; this is apps-check's to fix, not yours` };
    if (!result) return { reason: `${when} printed no result for the ${id} App, as an apps-check from before #417 doesn't, nor one that couldn't mint the App's token: ${runAppsCheck}` };
    if (result.slug !== slug) return { reason: `${when} checked the App \`${result.slug}\` as the ${id} App, but the register names \`${slug}\`: ${runAppsCheck}` };
    return { result, when };
  };

  /**
   * The owner's App installations, read once: only an owner of an organisation can list them,
   * with its Administration permission (read); a repository's token never can (#417).
   * @type {Promise<{ listed: GhResult, installs: any[] | null }> | null}
   */
  let installations = null;
  const ownerInstallations = () =>
    (installations ??= listInstallations(deps.gh, s.owner, s.kind));

  // An App's grant widens only where the adoption record declares it (`K-AGENT-3`): doctor then
  // expects the extra permission on that repository's App, and on no other repository's.
  const appExtras = readAppExtras(read(ADOPTION_RECORD), Object.keys(req.identities.apps));
  for (const e of appExtras.errors) find('declaration.malformed', ADOPTION_RECORD, e, { text: `Write each extra permission under ## Choices as \`- **${EXTRA_LABEL}:** \`<app>\` \`<permission>: <read | write>\` (<why the App holds it>)\`, or remove it.` });

  /** @type {Map<string, number>} identity → its App's id, read with its permissions */
  const appIdOf = new Map();
  for (const [id, slug] of slugOf) {
    const base = req.identities.apps[id]?.permissions ?? req.identities.roles[id]?.permissions ?? {};
    const need = req.identities.apps[id] ? withExtras(base, appExtras.extras[id]) : base;
    const r = await deps.gh(['api', `apps/${slug}`]);
    /** @type {any} */
    let app = ghJsonOf(r);
    if (!isMap(app) || !isMap(app.permissions)) {
      const found = await fromAppsCheck(id, slug);
      if ('reason' in found) {
        unchecked.push({ check: 'app-permissions', subject: slug, reason: `could not read the App ${slug} (${r.stderr.trim() || `exit ${r.status}`}), and ${found.reason}` });
        continue;
      }
      // No id: the App's id is a secret's value, which the run's log masks (#417).
      app = { permissions: found.result.permissions };
      notes.push(`GitHub shows the ${id} App \`${slug}\` only to itself, so its permissions are its installation's, as ${found.when} found them; run apps-check again after you change them.`);
    }
    if (Number.isInteger(app.id)) appIdOf.set(id, Number(app.id));
    const have = /** @type {Record<string, string>} */ (app.permissions);
    const ownerLogin = String(app.owner?.login ?? s.owner);
    const url = app.owner?.type === 'Organization' || (!app.owner && s.kind === 'Organization') ? `https://github.com/organizations/${ownerLogin}/settings/apps/${slug}/permissions` : `https://github.com/settings/apps/${slug}/permissions`;
    const missing = Object.entries(need).filter(([k, v]) => level(have[k]) < level(v));
    const extra = Object.entries(have).filter(([k, v]) => level(v) > level(need[k]));
    if (missing.length) {
      findItems('app.permission-missing', slug, missing.map(([k]) => k), (xs) => {
        const some = missing.filter(([k]) => xs.includes(k));
        return [`The ${id} App \`${slug}\` holds ${some.map(([k]) => `${k}: ${have[k] ?? 'none'}`).join(', ')}; Kanon ${checked} needs ${some.map(([k, v]) => `${k}: ${v}`).join(', ')}${some.some(([k]) => appExtras.extras[id]?.[k]) ? `, with what ${ADOPTION_RECORD} declares under ## Choices (${EXTRA_LABEL})` : ''}.`, {
          text: `Widen the App's permissions on its settings page, then accept the new permissions on its installation (GitHub asks the installation's owner), and run your apps-check caller.`,
          url,
        }];
      });
    }
    if (extra.length) {
      findItems('app.permission-extra', slug, extra.map(([k]) => k), (xs) => [`The ${id} App \`${slug}\` holds ${extra.filter(([k]) => xs.includes(k)).map(([k, v]) => `${k}: ${v}`).join(', ')}, beyond what Kanon ${checked} grants it (${extra.filter(([k]) => xs.includes(k)).map(([k]) => `${k}: ${need[k] ?? 'none'}`).join(', ')}). Each lane narrows its token to what it uses (K-AGENT-46), so this blocks nothing, but the App holds more than it needs (K-ADOPT-8).`, {
        text: `Narrow the App's permissions on its settings page.`,
        url,
      }]);
    }
  }

  // ── Apps the register no longer names, still installed ───────────────────────────────────────
  // After the move to two Apps (plan 0005 §3.1, L5/L6), the per-role Apps of earlier releases stay
  // installed until someone deletes them, holding keys no lane reads (the Owner, 2026-10-06). An
  // App counts when the register's own history on this checkout once named it and its current
  // copy doesn't, and the owner still has an installation of it. Never blocking: deleting an App
  // is the Owner's, after a week of green runs on the new ones (L5).
  const nowSlugs = new Set([...rows.values(), ...otherApps]);
  const history = deps.git(['-C', root, 'log', '--format=', '-p', '--', REGISTER_PATH]);
  const formerSlugs = history.status === 0
    ? [...new Set([...history.stdout.matchAll(/^[+-][ \t]*\|[^|\n]*\|[ \t]*\*{0,2}`([a-z0-9]+(?:-[a-z0-9]+)*)`/gm)].map((m) => /** @type {string} */ (m[1])))].filter((x) => !nowSlugs.has(x)).sort()
    : [];
  if (formerSlugs.length) {
    const { listed, installs } = await ownerInstallations();
    // Only an owner of the organisation can list its installations, with the organisation's
    // Administration permission (read); a repository's token never can (#417).
    if (!installs) {
      unchecked.push({
        check: 'unused-apps',
        subject: s.owner,
        reason: `the token can't list ${s.owner}'s App installations (${listed.stderr.trim() || `exit ${listed.status}`}), so ${formerSlugs.join(', ')}, which the register once named, can't be looked for. ${
          s.kind === 'Organization'
            ? `Only an owner of ${s.owner} can list them, with a token that holds the organisation's Administration permission (read): run doctor once with one (docs/doctor.md, "The token it needs")`
            : 'Look for them on https://github.com/settings/installations'
        }`,
      });
    }
    else {
      for (const slug of formerSlugs) {
        const inst = installs.find((/** @type {any} */ i) => i?.app_slug === slug && String(i?.account?.login ?? '').toLowerCase() === s.owner.toLowerCase());
        if (!inst) continue;
        const base = s.kind === 'Organization' ? `https://github.com/organizations/${s.owner}/settings` : 'https://github.com/settings';
        find('app.unused', slug, `The App \`${slug}\` is still installed for ${s.owner}, but ${REGISTER_PATH} no longer names it, so no lane of ${checked} runs as it; it holds a key nothing reads (plan 0005 §3.1).`, {
          text: `Once the Apps that replaced it have run green for a week (plan 0005 L5), uninstall it on its installation page, delete it on its Advanced page (${base}/apps/${slug}/advanced, "Delete GitHub App"), and delete its secrets if secret.stale lists them. Keep it while another repository's register still names it.`,
          url: `${base}/installations/${inst.id}`,
        });
      }
    }
  }

  // ── The secrets ───────────────────────────────────────────────────────────────────────────
  // What each workflow maps, read as #414 reads it: any `secrets.<NAME>` outside its on:, whatever
  // the job calls. A secret of Kanon's that a workflow maps is needed whether or not the job calls
  // a lane doctor recognises (a local path, `$/`), and the secrets of each of the checked release's
  // Apps that one maps, both of them, so the Releaser's too when a local release caller maps it
  // (#415). A reusable workflow's own `secrets.<NAME>` of a secret its on.workflow_call.secrets
  // declares reads what its caller passes it, not the repository's: the caller is what maps it, so
  // it doesn't count here, though it still counts as read for secret.stale (#414).
  const mapping = [...workflows].map(([file, wf]) => ({ file, ...secretReads(wf), takes: callTakes(wf) }));
  /** @param {string} n */
  const mappedBy = (n) => mapping.filter((m) => m.names.has(n) && !m.takes.has(n)).map((m) => m.file);
  // The Claude credentials of every lane's pair: a caller maps one, so only one a workflow maps
  // is needed (plan 0009 §11). A caller of a lane with a pair that maps no secrets by name
  // (`caller.secrets-inherited`) still needs the token its lane names among its `secrets`.
  const pairs = new Set(Object.keys(req.lanes).flatMap(pairOf));
  const laneSecrets = new Set([...Object.values(req.lanes).flatMap((l) => l?.secrets ?? []), ...pairs]);
  const chatSecrets = new Set(notify ? [notify.legacySecret, ...Object.values(notify.kinds).map((k) => k.secret)] : []);
  const unnamed = callers.filter((c) => !isMap(c.job.secrets) && req.lanes[c.lane]).flatMap((c) => pairOf(c.lane).filter((n) => req.lanes[c.lane]?.secrets.includes(n)));
  const secretApps = [...new Set([...identities, ...Object.keys(req.identities.apps).filter((a) => appSecrets(a).some((n) => mappedBy(n).length))])].sort();
  // The QA store's two secrets are optional (kanon#433): a caller maps them, empty, whether or not
  // the repository has a store, so they are needed only once its store hook exists.
  const needSecrets = [...new Set([...installed.flatMap((l) => (req.lanes[l]?.secrets ?? []).filter((n) => !pairOf(l).includes(n))), ...unnamed, ...secretApps.flatMap(appSecrets), ...[...laneSecrets].filter((n) => mappedBy(n).length)])]
    .filter((n) => hasStore || !storeSecrets.includes(n))
    // A chat secret is never `secret.missing` (plan 0011 §9): a kind not posted is a choice, which
    // `notify.kind-unset` notes, and the secret the kind secrets replace is `notify.legacy-secret`.
    .filter((n) => !chatSecrets.has(n))
    .sort();
  /**
   * The workflows that map these secrets, and the callers of a lane that takes them and doesn't
   * map them yet (caller.secret-missing names those lines), for the finding's message.
   * @param {string[]} names
   */
  const whoNeeds = (names) => {
    const maps = [...new Set(names.flatMap(mappedBy))].sort();
    const must = [...new Set(callers.filter((c) => names.some((n) => req.lanes[c.lane]?.secrets.includes(n) && !pairOf(c.lane).includes(n))).map((c) => c.file))].filter((f) => !maps.includes(f)).sort();
    const them = names.length > 1 ? 'them' : 'it';
    return [
      ...(maps.length ? [`${maps.join(', ')} map${maps.length > 1 ? '' : 's'} ${them}`] : []),
      ...(must.length ? [`${must.join(', ')} call${must.length > 1 ? '' : 's'} a lane that takes ${them} at ${checked}`] : []),
    ].join('; ');
  };
  // The QA store's coordinates as repository variables (kanon#433): v0.33.0's way, which prints
  // them, and the account id they carry, in every store job's log. Never blocking: against a
  // release that still passes them (v0.34.x) the hook falls back to them, so the store still
  // works; against one that doesn't (kanon#479, `secretsOnly`) a variable is only a leftover, and
  // the store secret it doesn't replace is `secret.missing`, below, which blocks. Only where the
  // store hook exists and a store-coupled lane is installed.
  /** @type {string[]} */
  let storeVariables = [];
  if (hasStore && storeSecrets.length && installed.some((l) => (req.lanes[l]?.optionalSecrets ?? []).length)) {
    const listed = await deps.gh(['variable', 'list', '-R', repo, '--json', 'name']);
    try {
      if (listed.status === 0) storeVariables = storeSecrets.filter((n) => JSON.parse(listed.stdout).some((/** @type {any} */ v) => String(v.name) === n));
      else notes.push(`The token can't list ${repo}'s variables, so doctor can't tell whether ${storeSecrets.join(' or ')} is still a variable, which every store job's log prints (docs/qa-store.md, "Move the coordinates to secrets").`);
    } catch {
      storeVariables = [];
    }
    if (storeVariables.length) {
      findItems('qa-store.variables', repo, storeVariables, (xs) => [secretsOnly
        ? `holds ${xs.join(' and ')} as ${xs.length > 1 ? 'repository variables' : 'a repository variable'}, which Kanon ${checked}'s lanes no longer read or print: they hand the QA store's hook its coordinates as secrets alone (kanon#479). ${xs.length > 1 ? 'They are' : 'It is'} left over from v0.33.0, and any workflow that reads ${xs.length > 1 ? 'them' : 'it'} prints the AWS account id in ${xs.length > 1 ? 'them' : 'it'}.`
        : `holds ${xs.join(' and ')} as ${xs.length > 1 ? 'repository variables' : 'a repository variable'}, which the runner never masks: every store job's log prints ${xs.length > 1 ? 'them' : 'it'}, and the AWS account id in ${xs.length > 1 ? 'them' : 'it'}. Kanon's lanes take the QA store's coordinates as secrets since kanon#433.`, {
        text: secretsOnly
          ? `Copy each into a secret of the same name where none is set yet, then, once a store job has run green on the secrets, delete the variables (docs/qa-store.md, "Move the coordinates to secrets"):`
          : `Copy each into a secret of the same name, map both secrets in the caller of each store-coupled lane (${installed.filter((l) => (req.lanes[l]?.optionalSecrets ?? []).length).join(', ')}) at ${checked} or later, make the hook read inputs.secrets first, and once a store job has run green on the secrets, delete the variables (docs/qa-store.md, "Move the coordinates to secrets"):`,
        commands: [
          ...xs.filter((n) => !s.secrets?.has(n)).map((n) => `gh variable get ${n} -R ${repo} | gh secret set ${n} -R ${repo}`),
          ...xs.map((n) => `gh variable delete ${n} -R ${repo}`),
        ],
      }]);
    }
  }
  if (!s.secrets) unchecked.push({ check: 'secrets', subject: repo, reason: "the token can't list the repository's secret names (it needs admin access)" });
  else {
    // `kanon apps` is the person's step (#420): its pre-check first, which creates nothing, then
    // the line that creates the App, or stores a key for the one the register already names.
    const preflight = `kanon apps --owner ${s.owner} --repo ${repoName} --preflight`;
    for (const id of secretApps) {
      const lacks = appSecrets(id).filter((n) => needSecrets.includes(n) && !s.secrets?.has(n));
      if (!lacks.length) continue;
      const slug = slugOf.get(id) ?? (() => {
        try {
          const slugs = [...new Set(registerRolesOf(id, req).map((r) => rows.get(r)).filter((x) => x !== undefined))];
          return slugs.length === 1 ? slugs[0] : undefined;
        } catch {
          return undefined;
        }
      })();
      findItems('secret.missing', repo, lacks, (xs) => {
        const who = whoNeeds(xs);
        // The App's id alone isn't secret, so it goes on the line with --body, which works at the
        // Claude Code prompt with `!`, where a line that reads standard input stores an empty
        // secret (#625); and it needs no new key. GitHub shows a private App's id only on its page.
        const [idName] = appSecrets(id);
        const appId = appIdOf.get(id);
        return [`lacks ${xs.join(' and ')}, the ${id} App's ${xs.length > 1 ? 'secrets' : 'secret'}${who ? `: ${who}` : ''}.`, slug && xs.length === 1 && xs[0] === idName
        ? {
          text: `Store the App's id${appId === undefined ? ", the App ID its settings page shows, in place of the line's <…>" : ''}. It isn't secret, so it goes on the line with --body, which works at the Claude Code prompt with \`!\` as well:`,
          commands: [`gh secret set ${idName} -R ${repo} --body ${appId ?? '<the App ID on its settings page>'}`],
          url: s.kind === 'Organization' ? `https://github.com/organizations/${s.owner}/settings/apps/${slug}` : `https://github.com/settings/apps/${slug}`,
        }
        : slug
        ? { text: `Add ${repoName} to the ${id} App's installation, ${NEW_KEY}, and copy its App ID from the same page. kanon apps is your step: check the token with the first command (it creates nothing), then store the key with the second (it checks the key, stores both secrets and deletes the file):`, commands: [preflight, `kanon apps --owner ${s.owner} --repo ${repoName} --reuse ${id}:${slug}@<App ID>=<downloaded>.pem`] }
        : { text: `Create the ${id} App from this checkout. kanon apps is your step: check the token with the first command (it creates nothing), then create the App with the second, which stores its secrets:`, commands: [preflight, `kanon apps --owner ${s.owner} --repo ${repoName} ${(() => { try { return appsArgs([id], req).join(' '); } catch { return ''; } })()}`.trim()] }];
      });
    }
    // A store secret a variable still holds is `qa-store.variables`, above, while the checked
    // release still passes the variables, so the store still works; once it doesn't (kanon#479),
    // the secret is missing, and the fix copies it from the variable.
    const output = (/** @type {string} */ n) => (n === 'QA_STORE_ROLE_ARN' ? 'RoleArn' : 'BucketName');
    for (const n of needSecrets.filter((x) => !/_APP_(ID|PRIVATE_KEY)$/.test(x) && !s.secrets?.has(x) && (secretsOnly || !storeVariables.includes(x)))) {
      // A Claude credential is needed by the lanes whose callers map it, not by every lane whose
      // pair names it (plan 0009 §11).
      const by = installed.filter((l) => pairs.has(n)
        ? callers.some((c) => c.lane === l && (isMap(c.job.secrets) ? n in c.job.secrets : req.lanes[l]?.secrets.includes(n)))
        : req.lanes[l]?.secrets.includes(n));
      const who = whoNeeds([n]);
      // Doctor lists the repository's own secrets, so one an organisation shares with it isn't seen.
      const orgNote = pairs.has(n) ? ` Doctor lists the repository's own secrets: an organisation secret shared with ${repo} isn't counted.` : '';
      findItems('secret.missing', repo, [n], () => [`lacks ${n}${by.length ? `, which ${by.join(', ')} ${by.length > 1 ? 'take' : 'takes'}` : ''}${who ? `: ${who}` : ''}.${orgNote}`, {
        text: n === CLAUDE_TOKEN ? `Store the token of the Claude subscription the agents run on, made with \`claude setup-token\` (docs/lanes.md), ${OWN_TERMINAL}${pairs.has(n) ? '. To run the lanes on an Anthropic API key instead, kanon init --claude-auth api-key maps it in every caller; store it as ANTHROPIC_API_KEY.' : ':'}`
          : n === CLAUDE_KEY ? `Store an Anthropic API key, made in the Claude Console in a workspace for CI with a spend limit (docs/lanes.md), ${OWN_TERMINAL}:`
          : storeVariables.includes(n) ? `${req.qaStore?.hook} exists, and Kanon ${checked} hands it the store's coordinates as secrets alone, never the variable ${n} that holds this one (kanon#479): copy the variable into the secret, through a pipe, so the value is never printed (docs/qa-store.md, "Move the coordinates to secrets"):`
          : storeSecrets.includes(n) ? `${req.qaStore?.hook} exists, so the store-coupled lanes need the store's coordinates: store the stack's ${output(n)} output, putting it in for the line's <${output(n)}>. It isn't secret, so it goes on the line with --body, which works at the Claude Code prompt with \`!\` as well (docs/qa-store.md, "Provision a store"):`
          : `Store it ${OWN_TERMINAL}:`,
        commands: [storeVariables.includes(n) ? `gh variable get ${n} -R ${repo} | gh secret set ${n} -R ${repo}` : storeSecrets.includes(n) ? `gh secret set ${n} -R ${repo} --body '<${output(n)}>'` : `gh secret set ${n} -R ${repo}`],
        url: n === CLAUDE_KEY ? CONSOLE_KEYS : null,
      }]);
    }
    // An App secret no App in use reads and no workflow maps: left from the per-role Apps, or from
    // an App dropped. A secret any job maps counts as read, whatever the job calls (#414).
    // And a Claude credential no workflow maps, such as the token after a move to the key (plan
    // 0009 §11): against a release whose lanes take the pair.
    const known = new Set([...[...Object.keys(req.identities.roles), ...Object.keys(req.identities.apps)].flatMap(appSecrets), ...pairs]);
    const used = new Set(identities.flatMap(appSecrets));
    for (const m of mapping) for (const n of m.names) used.add(n);
    const stale = [...s.secrets].filter((n) => known.has(n) && !used.has(n.toUpperCase())).sort();
    const inheriting = mapping.flatMap((m) => m.inherits.map((j) => `${m.file}'s job ${j}`));
    const unread = unchecked.filter((u) => u.check === 'workflow').map((u) => u.subject);
    const computing = mapping.filter((m) => m.computed).map((m) => m.file);
    if (stale.length && inheriting.length) notes.push(`${inheriting.join(', ')} inherit${inheriting.length > 1 ? '' : 's'} every secret, so doctor lists none of ${stale.join(', ')} as stale: it can't tell which the called workflow reads.`);
    else if (stale.length && computing.length) notes.push(`${computing.join(', ')} read${computing.length > 1 ? '' : 's'} secrets by a computed name or as a whole (\`secrets[<expression>]\`, \`toJSON(secrets)\`), which can reach any of them, so doctor lists none of ${stale.join(', ')} as stale: it can't tell which ${computing.length > 1 ? 'they read' : 'it reads'} (#440).`);
    else if (stale.length && unread.length) notes.push(`doctor lists none of ${stale.join(', ')} as stale: it could not read ${unread.join(', ')}, which may map them.`);
    else if (stale.length) {
      findItems('secret.stale', repo, stale, (xs) => [`holds ${xs.join(', ')}, which no App the lanes of ${checked} run as here reads, and no job of a workflow under .github/workflows/ on ${onCheckout} names: doctor reads every \`secrets.<NAME>\` in each workflow outside its on:, in a job's secrets:, env:, with: or steps alike, whatever the job calls.`, {
        text: `Delete them${branchName === s.defaultBranch ? '' : `, once ${s.defaultBranch}'s workflows map none of them either`}${xs.some((n) => pairs.has(n)) ? `; a Claude credential no caller maps any more, once the lanes have run green for a week on the one they map` : ''}${xs.some((n) => !pairs.has(n)) ? ', and uninstall the Apps they belong to if no repository uses them' : ''}:`,
        commands: xs.map((n) => `gh secret delete ${n} -R ${repo}`),
      }]);
    }
  }

  // ── A telemetry register tracked in the checkout (#1071) ──────────────────────────────────
  // docs/telemetry.md, "Where the register lives": never in a repository where Kanon's lanes
  // run, public or private, which this one is. The Reviewer reads any diff that touches it, and
  // every agent reads the checkout. Read by shape, from the tracked files alone, and named by its
  // path alone: what doctor prints never holds a key or a repository from it.
  const marked = deps.git(['-C', root, 'grep', '-l', '-z', '-I', '-F', ...REGISTER_MARKERS.flatMap((m) => ['-e', m])]);
  if (marked.status !== 0 && marked.status !== 1) {
    unchecked.push({ check: 'telemetry-register', subject: repo, reason: `git could not search the tracked files (${marked.stderr.trim() || `exit ${marked.status}`}), so doctor can't tell whether a telemetry register is tracked here` });
  }
  const quoted = (/** @type {string} */ p) => `'${p.replace(/'/g, `'\\''`)}'`;
  for (const path of (marked.status === 0 ? marked.stdout : '').split('\0').filter(Boolean).sort()) {
    const shape = registerShape(read(path) ?? '');
    if (!shape) continue;
    const what = shape === 'register'
      ? 'has the shape of a telemetry register: an owner_principal_arn, and repositories that pair each key with its repository'
      : `has the shape of render.mjs's ${shape}.json, which holds the telemetry register's ${shape === 'template' ? 'keys and repositories' : 'owner ARN and the store\'s cursor key'}`;
    find('telemetry.register-tracked', path, `${what}. It is tracked in ${repo}, where Kanon's lanes run: the Reviewer reads any diff that touches it, and every agent reads the checkout, so it never lives in such a repository, public or private (docs/telemetry.md, "Where the register lives").`, {
      text: `Move it out of the checkout first, to a place "Where the register lives" names, such as an untracked file under ~/kanon-private/telemetry/. Then, on a branch, run these and merge them in a pull request with no review label (review:please, agent:triage or agent:implement), so the Reviewer doesn't read the deletion's diff. Its history still holds every version: treat each key in it as paired with its repository for anyone who can read that history.`,
      commands: [`git rm --cached -- ${quoted(path)}`, `printf '\\n%s\\n' ${quoted(`/${path}`)} >> .gitignore`],
      url: `https://github.com/${KANON_REPO}/blob/${checked}/docs/telemetry.md#where-the-register-lives`,
    });
  }

  // ── The Claude credential: the token's age, and runs that never reached the model ─────────
  // (plan 0009 §11). Doctor reads secret names and dates, never a value.
  if (s.secrets?.has(CLAUDE_TOKEN) && mappedBy(CLAUDE_TOKEN).length) {
    // The secret's `updatedAt` is when it was last stored, so the token is at least that old,
    // never younger; its own creation date is not on GitHub.
    const dated = await deps.gh(['secret', 'list', '-R', repo, '--json', 'name,updatedAt']);
    /** @type {number | null} */
    let updated = null;
    try {
      if (dated.status === 0) {
        const row = JSON.parse(dated.stdout).find((/** @type {any} */ x) => String(x?.name) === CLAUDE_TOKEN);
        const at = Date.parse(String(row?.updatedAt ?? ''));
        if (Number.isFinite(at)) updated = at;
      }
    } catch {
      updated = null;
    }
    if (updated === null) unchecked.push({ check: 'token-age', subject: repo, reason: `doctor couldn't read when ${CLAUDE_TOKEN} was last updated (${dated.status === 0 ? 'the listing gave no date' : dated.stderr.trim() || `exit ${dated.status}`}); the listing needs the token that lists the secrets' names` });
    else {
      const days = Math.floor((deps.now() - updated) / DAY);
      if (days > TOKEN_AGE.note) {
        const year = days > TOKEN_AGE.year;
        find('claude.token-age', repo, `${CLAUDE_TOKEN} was last updated ${days} days ago, on ${new Date(updated).toISOString().slice(0, 10)}, so the subscription token it holds is at least that old: GitHub keeps the day a secret was last stored, not the day its token was made. ${year ? 'A subscription token lasts a year; this one is at least that old, so the lanes on it may no longer reach the model.' : `A subscription token lasts a year: renew it before day ${TOKEN_AGE.year}.`}`, {
          text: `Make a new token with claude setup-token, signed in to the subscription the agents run on, and store it ${OWN_TERMINAL}:`,
          commands: ['claude setup-token', `gh secret set ${CLAUDE_TOKEN} -R ${repo}`],
        }, !year);
      }
    }
  }
  // The callers on the subscription's token whose runs ended in agent-classify's notice for a
  // model never reached: the last runs of each, its failed ones in the window, and those runs'
  // failed jobs' annotations. Each run counts once, however many of its jobs carry the notice.
  const tokenCallers = [...new Set(callers.filter((c) => isMap(c.job.secrets) && CLAUDE_TOKEN in c.job.secrets).map((c) => c.file))].sort();
  if (tokenCallers.length) {
    const since = deps.now() - UNREACHABLE.days * DAY;
    /**
     * Whether a run's failed jobs carry the notice; null when the token can't read them.
     * @param {number} id @returns {Promise<boolean | null>}
     */
    const reachedNoModel = async (id) => {
      const jobs = await deps.gh(['api', `repos/${repo}/actions/runs/${id}/jobs?per_page=100`]);
      try {
        if (jobs.status !== 0) return null;
        for (const job of JSON.parse(jobs.stdout).jobs ?? []) {
          if (job?.conclusion !== 'failure') continue;
          const notes = await deps.gh(['api', `repos/${repo}/check-runs/${Number(job.id)}/annotations?per_page=100`]);
          if (notes.status !== 0) return null;
          if (JSON.parse(notes.stdout).some((/** @type {any} */ a) => a?.title === UNREACHABLE_TITLE)) return true;
        }
        return false;
      } catch {
        return null;
      }
    };
    /** @type {Array<{ file: string, id: number }>} */
    const unreachable = [];
    for (const file of tokenCallers) {
      const listed = await deps.gh(['run', 'list', '-R', repo, '--workflow', basename(file), '--limit', String(UNREACHABLE.perCaller), '--json', 'databaseId,conclusion,createdAt']);
      // A caller not yet on the default branch has no runs: GitHub knows no such workflow.
      if (listed.status !== 0 && /could not find any workflows|HTTP 404/i.test(listed.stderr)) continue;
      /** @type {any[] | null} */
      let runs = null;
      try {
        if (listed.status === 0) runs = JSON.parse(listed.stdout);
      } catch {
        runs = null;
      }
      if (!Array.isArray(runs)) {
        unchecked.push({ check: 'unreachable-runs', subject: file, reason: `the token can't list its runs (${listed.stderr.trim() || `exit ${listed.status}`}); it needs Actions: read` });
        continue;
      }
      for (const r of runs.filter((x) => x?.conclusion === 'failure' && Date.parse(String(x?.createdAt)) >= since)) {
        const id = Number(r.databaseId);
        const hit = await reachedNoModel(id);
        if (hit === null) {
          unchecked.push({ check: 'unreachable-runs', subject: file, reason: `the token can't read the jobs or annotations of its run ${id}; it needs Actions: read and Checks: read, which a classic token's repo scope holds: a fine-grained personal access token has no Checks permission, so on a private repository it can't read them` });
          break;
        }
        if (hit) unreachable.push({ file, id });
      }
    }
    if (unreachable.length >= UNREACHABLE.runs) {
      find('claude.unreachable-runs', repo, `${unreachable.length} runs of the callers on ${CLAUDE_TOKEN} in the last ${UNREACHABLE.days} days ended without reaching the model, with agent-classify's notice "${UNREACHABLE_TITLE}": ${unreachable.map((u) => `${u.file} run ${u.id}`).join(', ')}. A run can't tell three causes apart: the Claude subscription's usage limit, an Anthropic outage, or a configuration fault such as an expired token, so doctor can't either.`, {
        text: `Read the runs' notices. If the lanes keep waiting on the subscription's usage limit, they can run on an Anthropic API key instead, billed per token at API list price: store it as ${CLAUDE_KEY} and map it in place of the token, as kanon init --claude-auth api-key writes the callers. If the token has expired, make a new one with claude setup-token.`,
        commands: unreachable.map((u) => `gh run view ${u.id} -R ${repo}`),
      });
    }
  }

  // ── The declarations, hooks and workflows the lanes read ────────────────────────────────────
  /** @type {Map<string, string[]>} path → lanes */
  const reads = new Map();
  for (const l of installed) for (const d of req.lanes[l]?.reads ?? []) reads.set(d, [...(reads.get(d) ?? []), l]);
  const declared = /** @type {Record<string, { baseline: boolean, requiredSections: string[] }> | undefined} */ (/** @type {any} */ (req).declarations);
  // The capability ledger is needed only where the adoption record turns the capability watch on
  // (kanon#477); off by default. A malformed choice is named below, and holds the ledger as needed.
  const capabilityWatchOn = (() => {
    const record = read(ADOPTION_RECORD);
    try { return record !== null && parseCapabilityWatch(record) === 'on'; } catch { return true; }
  })();
  for (const [path, by] of [...reads].sort(([a], [b]) => a.localeCompare(b))) {
    const decl = declared?.[path] ?? { baseline: /-playbook\.md$/.test(path), requiredSections: path === 'docs/qa/stack.md' ? ['## Gates'] : [] };
    const text = read(path);
    if (text === null && path === CAPABILITY_LEDGER && !capabilityWatchOn) {
      notes.push(`${path} doesn't exist, which is fine: ${ADOPTION_RECORD} doesn't turn the capability watch on, so ${by.join(', ')} skip${by.length > 1 ? '' : 's'} the capability review and don't read it (K-LAYOUT-10).`);
      continue;
    }
    if (text === null) {
      if (decl.baseline) notes.push(`${path} doesn't exist, so ${by.join(', ')} read${by.length > 1 ? '' : 's'} Kanon's baseline for it (plan 0005 §5.2).`);
      else {
        find('declaration.missing', path, `is missing; ${by.join(', ')} read${by.length > 1 ? '' : 's'} it at ${checked} (K-LAYOUT-17).`, {
          text: path === 'docs/qa/stack.md' ? `Write it with its ## Gates, or let kanon init write it:` : `Write it (K-LAYOUT-17), or let kanon init write it where it can:`,
          commands: ['kanon init --dry-run'],
        });
      }
      continue;
    }
    for (const h of decl.requiredSections) {
      const n = headingCount(text, h);
      if (n !== 1) findItems('declaration.section-missing', path, [h], () => [`has the heading \`${h}\` ${n} times; ${by.join(', ')} read${by.length > 1 ? '' : 's'} that section, which has no default, so it is there exactly once (K-LAYOUT-17).`, { text: `Write \`${h}\` exactly once, outside any fenced block.` }]);
    }
  }
  if (installed.length) {
    const hook = read(req.hook.path);
    if (hook === null) {
      find('hook.missing', req.hook.path, `the project-setup hook is missing; every lane that checks out calls it (plan 0001 §5).`, { text: `Write it, or let kanon init write a starting one that installs nothing yet.`, commands: ['kanon init --dry-run'] });
    } else {
      /** @type {unknown} */
      let doc = null;
      try {
        doc = parseYaml(hook);
      } catch (e) {
        unchecked.push({ check: 'hook', subject: req.hook.path, reason: `could not read it: ${/** @type {Error} */ (e).message}` });
      }
      if (isMap(doc)) {
        const inputs = isMap(doc.inputs) ? doc.inputs : {};
        const lacks = req.hook.inputs.filter((k) => !(k in inputs));
        if (lacks.length) {
          findItems('hook.input-missing', req.hook.path, lacks, (xs) => [`does not declare ${xs.join(', ')}, which Kanon ${checked}'s lanes pass it.`, {
            text: `Add under inputs:`,
            commands: xs.flatMap((k) => [`  ${k}:`, `    description: Passed by Kanon's lanes (docs/lanes.md).`, '    default: ""']),
          }]);
        }
      }
    }
  }
  for (const l of installed) {
    for (const h of req.lanes[l]?.hooks ?? []) {
      if (read(h) === null) find('hook.missing', h, `is missing; the lane ${l} calls it at ${checked}.`, { text: `Write the hook (docs/lanes.md says what it receives and returns).` });
    }
    for (const w of req.lanes[l]?.readsWorkflows ?? []) {
      if (!workflows.has(`.github/workflows/${w}`) && read(`.github/workflows/${w}`) === null) {
        find('workflow.missing', `.github/workflows/${w}`, `is missing; the lane ${l} reads its runs by that file name (K-LAYOUT-18).`, { text: `Name the project's CI workflow .github/workflows/${w}, or let kanon init write one.` });
      }
    }
  }
  // The Lead writes each brief from the brief template, which an adopter copies unchanged from
  // Kanon's (K-LAYOUT-11), and init writes beside the Lead's caller (#749).
  const leadCallers = [...new Set(callers.filter((c) => c.lane === LEAD_LANE).map((c) => c.file))];
  const template = leadCallers.length ? read(BRIEF_TEMPLATE_PATH) : null;
  const lead = `the Lead, which ${leadCallers.join(', ')} call${leadCallers.length > 1 ? '' : 's'}, writes each brief from it`;
  const copy = {
    commands: [
      `mkdir -p ${dirname(BRIEF_TEMPLATE_PATH)}`,
      `gh api -H 'Accept: application/vnd.github.raw+json' 'repos/${KANON_REPO}/contents/rulebook/templates/brief.md?ref=${checked}' > ${BRIEF_TEMPLATE_PATH}`,
    ],
    url: `https://github.com/${KANON_REPO}/blob/${checked}/rulebook/templates/brief.md`,
  };
  if (leadCallers.length && template === null) {
    find('lead.template-missing', BRIEF_TEMPLATE_PATH, `is missing; ${lead} (K-LAYOUT-11).`, {
      text: `Copy Kanon's brief template to it unchanged, as kanon init writes it, from the release you check (${checked}):`,
      ...copy,
    });
  } else if (template !== null) {
    // The adopter replaces the copy when Kanon's template changes (#755), and nothing else says
    // that it has: a checkout's line endings are not a change.
    /** @type {string | null} */
    let kanons = null;
    try {
      kanons = await briefTemplateAt(deps, checked);
    } catch (e) {
      unchecked.push({ check: 'brief-template', subject: BRIEF_TEMPLATE_PATH, reason: `${/** @type {Error} */ (e).message}, so doctor can't tell whether the copy is Kanon's` });
    }
    const lf = (/** @type {string} */ t) => t.replace(/\r\n/g, '\n');
    if (kanons !== null && lf(template) !== lf(kanons)) {
      find('lead.template-stale', BRIEF_TEMPLATE_PATH, `differs from Kanon's brief template at ${checked}; ${lead}, and the brief guard holds those briefs to ${checked}'s rules (K-LAYOUT-11).`, {
        text: `Replace it with Kanon's brief template, unchanged, as kanon init writes it, from the release you check (${checked}):`,
        ...copy,
      });
    }
  }

  // ── The apps-check caller ───────────────────────────────────────────────────────────────────
  const kind = identities.some((i) => req.identities.apps[i]) ? req.identities.apps : req.identities.roles;
  const takes = new Set(Object.keys(kind).flatMap(appSecrets));
  for (const c of appsCheckCallers) {
    const got = isMap(c.job.secrets) ? Object.keys(c.job.secrets) : [];
    const lacks = identities.flatMap(appSecrets).filter((n) => !got.includes(n));
    const stale = got.filter((n) => !takes.has(n));
    if (lacks.length) {
      findItems('apps-check.secret-missing', c.file, lacks, (xs) => {
        const blind = identities.filter((i) => appSecrets(i).some((n) => xs.includes(n)));
        return [`does not map ${xs.join(', ')}, so apps-check can't check the ${blind.join(' and ')} App${blind.length > 1 ? 's' : ''}.`, { text: `Add under the job's secrets:`, commands: xs.map((n) => `      ${n}: \${{ secrets.${n} }}`) }];
      });
    }
    if (stale.length) findItems('apps-check.secret-stale', c.file, stale, (xs) => [`maps ${xs.join(', ')}, which Kanon ${checked}'s apps-check does not take; GitHub refuses the call.`, { text: `Remove these lines from the job's secrets:`, commands: xs.map((n) => `      ${n}: \${{ secrets.${n} }}`) }]);
  }

  // ── The labels ──────────────────────────────────────────────────────────────────────────────
  const taxonomy = new Map(deps.labels().map((l) => [l.name, l]));
  const missingLabels = (req.labels ?? []).filter((n) => !/<[a-z]+>$/.test(n) && !s.labels.has(n));
  if (missingLabels.length) {
    findItems('label.missing', repo, missingLabels, (xs) => [`lacks ${xs.length} of the taxonomy's labels: ${xs.join(', ')}. A lane creates a label it needs on first use (plan 0005 §5.3), so this blocks nothing.`, {
      text: `Let kanon init create them, or create them yourself:`,
      commands: xs.map((n) => {
        const l = taxonomy.get(n);
        return l ? `gh label create ${JSON.stringify(n)} --color ${l.color} --description ${JSON.stringify(l.description)} -R ${repo}` : `gh label create ${JSON.stringify(n)} -R ${repo}`;
      }),
    }]);
  }

  // ── The ruleset ─────────────────────────────────────────────────────────────────────────────
  // The workflows on the default branch, read once: the required check's job and the review
  // lane's caller are both looked for there.
  /** @type {Promise<Awaited<ReturnType<typeof branchWorkflows>>> | null} */
  let defaultRead = null;
  const defaultWorkflows = () => (defaultRead ??= branchWorkflows(deps, repo, s.defaultBranch));
  if (s.rulesets === 'no') notes.push(`${repo} is a private repository on a plan without rulesets: nothing on the platform refuses a merge without the Reviewer's approval, and the repository stays in bootstrap (K-ADOPT-3, K-ADOPT-6).`);
  else if (s.rulesets === 'unknown') unchecked.push({ check: 'ruleset', subject: repo, reason: "the token can't read the repository's rulesets" });
  else if (!s.covering.length) {
    find('ruleset.missing', s.defaultBranch, `no active ruleset covers ${s.defaultBranch}${s.inactive.length ? ` (${s.inactive.map((c) => `"${c.name}" is ${c.enforcement}`).join(', ')})` : ''} (K-ADOPT-1 step 8).`, {
      text: `Let kanon init create "${RULESET_NAME}"; it needs Administration: write.`,
      commands: ['kanon init'],
    });
  } else {
    for (const gap of await checkGaps({ defaultWorkflows, s, checked, gaps: rulesetGaps(s.covering), checkout: workflows, find, unchecked })) {
      find('ruleset.rule-missing', s.defaultBranch, `The ruleset on ${s.defaultBranch} (${s.covering.map((c) => c.name).join(', ')}) does not ${gap} (K-ADOPT-1 step 8).`, { text: `In the repository's Settings, Rules, Rulesets: ${gap}.`, url: `https://github.com/${repo}/settings/rules` });
    }
    // THE RELEASER'S BYPASS (K-MERGE-8, plan 0005 §3.1, #49), only where the release caller maps
    // the Releaser: it is then the one bypass actor, through pull requests only. Without it, the
    // admin's bypass is what merges a release PR that runs no CI (docs/release.md), so nothing
    // is asked. Another actor's bypass is asked off only against a release whose dco check
    // passes the Releaser's release PR (#337); before that, it is what merges that PR.
    if (identities.includes('releaser')) {
      const slug = slugOf.get('releaser');
      let appId = appIdOf.get('releaser');
      /** @type {string | null} */
      let noId = null;
      // A private Releaser's permissions come from apps-check, but not its id: that is the
      // <RELEASER>_APP_ID secret's value, which the run's log masks, and doctor never works
      // around a mask (K-AGENT-47). Its installation, which an organisation's owner can list,
      // names it.
      if (slug !== undefined && appId === undefined && !unchecked.some((u) => u.check === 'app-permissions' && u.subject === slug)) {
        const { listed, installs } = await ownerInstallations();
        const inst = installs?.find((/** @type {any} */ i) => i?.app_slug === slug && String(i?.account?.login ?? '').toLowerCase() === s.owner.toLowerCase());
        if (Number.isInteger(inst?.app_id)) appId = Number(inst.app_id);
        else if (installs) noId = `the Releaser App \`${slug}\` is private and ${s.owner}'s installations list no installation of it, so its id, and with it its bypass, can't be looked for`;
        else {
          noId = `the Releaser App \`${slug}\` is private, so GitHub shows its id only in ${s.owner}'s App installations, which the token can't list (${listed.stderr.trim() || `exit ${listed.status}`}); apps-check can't print it, because it is the value of a secret the run's log masks. ${
            s.kind === 'Organization'
              ? `An owner of ${s.owner} runs doctor once with a token that holds the organisation's Administration permission (read) (docs/doctor.md, "The token it needs")`
              : 'On a personal account only a GitHub App\'s user token can list them, so check the bypass list yourself on the ruleset\'s page'
          }`;
        }
      }
      if (slug === undefined || appId === undefined) {
        unchecked.push({ check: 'ruleset-bypass', subject: s.defaultBranch, reason: noId ?? `the Releaser App ${slug ? `\`${slug}\` could not be read` : 'has no register row'}, so its bypass can't be looked for` });
      } else {
        const where = releaserBypass(s.covering, appId);
        for (const r of where.hidden) unchecked.push({ check: 'ruleset-bypass', subject: s.defaultBranch, reason: `the token can't see the bypass list of the ruleset "${r.name}" (only someone who can edit it can)` });
        for (const r of where.lacking) {
          find('ruleset.releaser-bypass-missing', s.defaultBranch, `The ruleset "${r.name}" on ${s.defaultBranch} does not list the Releaser App \`${slug}\` as a bypass actor; K-MERGE-8 makes it the only one, through pull requests only.`, {
            text: r.source_type === 'Organization' ? `Add the App to the organisation ruleset's bypass list, "For pull requests only".` : `Add it, through pull requests only, keeping the ruleset's other actors (kanon apps adds it when it creates the Releaser):`,
            commands: r.source_type === 'Organization' ? [] : bypassCommand(repo, r, [...r.bypass_actors, releaserActor(appId)]),
            url: rulesetUrl(repo, r),
          });
        }
        if (where.others.length && req.release?.dcoExemptsReleaser) {
          for (const r of [...new Set(where.others.map((o) => o.ruleset))]) {
            const extra = where.others.filter((o) => o.ruleset === r).map((o) => actorName(o.actor));
            find('ruleset.bypass-extra', s.defaultBranch, `The ruleset "${r.name}" on ${s.defaultBranch} lets ${extra.join(', ')} bypass it; K-MERGE-8 makes the Releaser App \`${slug}\` the only bypass actor. Kanon ${checked}'s dco check passes the Releaser's release PR (#337), so release PRs merge through the front door without it.`, {
              text: r.source_type === 'Organization' ? `Remove the other actors from the organisation ruleset's bypass list.` : `Leave the Releaser as the ruleset's only bypass actor, once your dco caller pins ${checked}:`,
              commands: r.source_type === 'Organization' ? [] : bypassCommand(repo, r, [releaserActor(appId)]),
              url: rulesetUrl(repo, r),
            });
          }
        } else if (where.others.length) {
          notes.push(`The ruleset on ${s.defaultBranch} lets ${where.others.map((o) => actorName(o.actor)).join(', ')} bypass it beside the Releaser. Keep that while you pin ${checked}: its dco check fails the Releaser's release PR (#337), and that bypass is what merges it.`);
        }
      }
    }
  }

  // ── The end of bootstrap (`K-ADOPT-6`, #706) ───────────────────────────────────────────────────
  // Bootstrap ends when the Judge App is installed and the ruleset requires an approving review,
  // and never returns. Two findings hold that: the reminder, once the Reviewer can approve on the
  // default branch and nothing requires it to; and the guard, once the adoption record says
  // bootstrap ended and nothing requires the approval it ended on. The reminder waits for the
  // review lane's caller to merge, like the required check's job: an approval required before the
  // Reviewer runs on the default branch is one nobody can give, so every pull request waits.
  if (s.rulesets !== 'unknown') {
    const approvals = s.rulesets === 'yes' ? requiredApprovals(s.covering) : 0;
    const ended = bootstrapEnded(read(ADOPTION_RECORD));
    const judge = slugOf.get('judge');
    // The ruleset to switch it on in: the repository's own, the one with the pull request rule
    // first. An organisation's ruleset is edited on its page.
    const own = s.covering.filter((r) => (r.source_type ?? 'Repository') === 'Repository');
    const target = own.find((r) => (r.rules ?? []).some((/** @type {any} */ x) => x?.type === 'pull_request')) ?? own[0];
    const switchOn = () => {
      if (s.rulesets === 'no') return { text: `A private repository on a plan without rulesets can't require it (K-ADOPT-3): make the repository public, or move to a plan with rulesets, and require one approving review there.` };
      if (!target) {
        return s.covering.length
          ? { text: `Require one approving review, dismissed when a new commit is pushed (K-MERGE-6), in the organisation's ruleset "${s.covering[0].name}".`, url: rulesetUrl(repo, s.covering[0]) }
          : { text: `Let kanon init create "${RULESET_NAME}", then require one approving review in it, dismissed when a new commit is pushed (K-MERGE-6).`, url: `https://github.com/${repo}/settings/rules` };
      }
      const prRule = /** @type {any} */ (rulesetBody(false).rules.find((x) => x.type === 'pull_request'));
      const rules = /** @type {any[]} */ (target.rules ?? []).map((x) => ({ type: x.type, ...(x.parameters ? { parameters: x.parameters } : {}) }));
      if (!rules.some((x) => x.type === 'pull_request')) rules.push(prRule);
      const approved = rules.map((x) => (x.type === 'pull_request' ? { ...x, parameters: { ...x.parameters, required_approving_review_count: 1, dismiss_stale_reviews_on_push: true } } : x));
      return {
        text: `Require one approving review in the ruleset "${target.name}", dismissed when a new commit is pushed (K-MERGE-6). The command sends its rules as they are, with the pull request rule's two settings changed; it needs Administration: write:`,
        commands: [`gh api -X PUT repos/${repo}/rulesets/${target.id} --input - <<'JSON'`, JSON.stringify({ rules: approved }), 'JSON'],
        url: rulesetUrl(repo, target),
      };
    };
    if (ended && approvals < 1) {
      const fix = switchOn();
      find('ruleset.approval-off', s.defaultBranch, `${ADOPTION_RECORD} says bootstrap \`ended ${ended}\`, but ${s.rulesets === 'no' ? `${repo} has no rulesets on its plan, so nothing requires an approving review` : s.covering.length ? `the ruleset on ${s.defaultBranch} (${s.covering.map((c) => c.name).join(', ')}) requires no approving review` : `no active ruleset covers ${s.defaultBranch}, so nothing requires an approving review`}. Bootstrap never returns: an approval no longer required is an incident to fix, and until it is, any merge needs no approval (K-ADOPT-6).`, fix);
    } else if (!ended && approvals < 1 && judge && s.rulesets === 'yes' && s.covering.length) {
      const onDefault = await defaultWorkflows();
      if (onDefault.error !== null) {
        unchecked.push({ check: 'ruleset', subject: s.defaultBranch, reason: `could not read the workflows on ${s.defaultBranch} (${onDefault.error}), so doctor can't tell whether the review lane runs there, and whether bootstrap can end` });
      } else {
        const reviewCallers = [...(onDefault.workflows ?? new Map())].filter(([, wf]) => Object.values(isMap(wf.jobs) ? wf.jobs : {}).some((j) => isMap(j) && kanonCall(j.uses)?.workflow === REVIEW_LANE)).map(([f]) => f);
        if (reviewCallers.length) {
          const fix = switchOn();
          find('ruleset.bootstrap-can-end', s.defaultBranch, `The Judge App \`${judge}\` is installed, and ${reviewCallers.join(', ')} on ${s.defaultBranch} calls the review lane, so the Reviewer can approve; but the ruleset on ${s.defaultBranch} (${s.covering.map((c) => c.name).join(', ')}) requires no approving review, so any merge still needs none, and the repository is still in bootstrap. Requiring one is what ends it (K-ADOPT-6, K-ADOPT-1 step 14).`, {
            ...fix,
            text: `${fix.text} Then record the date in ${ADOPTION_RECORD}: under ## Bootstrap, write \`ended YYYY-MM-DD\` with the day you switched it on, in place of \`in bootstrap since\` (K-ADOPT-6, K-LAYOUT-10). From then on doctor fails a ruleset that stops requiring it (ruleset.approval-off).`,
          });
        }
      }
    }
  }

  // ── A merge queue (#452) ────────────────────────────────────────────────────────────────────
  // A merge through the queue is pushed by the queue's bot, which a lane's gate turns away, so a
  // lane that starts on CI finishing on the default branch waits for its schedule. The release's
  // lane catalogue says so of each such lane; it blocks nothing.
  // A lane whose caller starts it on the merged pull request as well (kanon#484) has no such
  // sentence from a release that admits that trigger. Its caller still needs the trigger, which
  // an upgrade of the pin alone doesn't add, so a caller without it is noted, with what to add.
  if (mergeQueueOn(s.covering)) {
    for (const l of installed) {
      const said = req.catalogue?.lanes[l]?.mergeQueue;
      if (said) notes.push(`${s.defaultBranch} merges through a merge queue, and you call ${l}. ${said}`);
      else if (TRIGGERS[l]?.merged) {
        for (const file of [...new Set(callers.filter((c) => c.lane === l && !startsOnMerge(c.wf, s.defaultBranch)).map((c) => c.file))]) {
          notes.push(`${s.defaultBranch} merges through a merge queue, and ${file} calls ${l} without a trigger on a merged pull request, so a merge through the queue doesn't start it: the CI run on the merge is the queue's, which the lane's gate turns away. Add \`pull_request_target: { types: [closed], branches: [${s.defaultBranch}] }\` to its \`on:\`, as \`kanon init\` writes it (#484).`);
        }
      }
    }
  }

  // ── The telemetry collector (#428; plan 0008 §8, step J5) ─────────────────────────────────
  // A caller of Kanon's collector registers the repository on its first default-branch run, and
  // sends with GitHub's OIDC token: nothing is set beside it. So what doctor reads is the caller's
  // last run on the default branch: `telemetry.not-run` while there is none,
  // `telemetry.unpublished` when it skipped because its release doesn't publish the hosted store's
  // URL (#843), and `telemetry.refused` when the store refused it (a 403, 410 or 429, which the
  // collector says with its own annotation title), with the run's own words. None blocks: no lane
  // needs it.
  const collector = req.telemetry?.collector;
  const collectorCallers = collector
    ? [...workflows].filter(([, wf]) => Object.values(isMap(wf.jobs) ? wf.jobs : {}).some((j) => isMap(j) && kanonCall(j.uses)?.workflow === collector)).map(([f]) => f)
    : [];
  // A called workflow's job can only narrow its caller's grant, and GitHub refuses to start a run
  // whose called job asks for more (plan 0001 §3). So a caller whose permissions: lack what the
  // collector's job asks for at the checked release (`contents: read` since plan 0006 F4, to read
  // the record's upstream-findings level) would stop every sweep once the pin moves: named here,
  // as a lane caller's grant is.
  const telemetryGrant = req.telemetry?.grant ?? {};
  for (const file of collectorCallers) {
    const wf = /** @type {Record<string, any>} */ (workflows.get(file));
    for (const j of Object.values(isMap(wf.jobs) ? wf.jobs : {})) {
      if (!isMap(j) || kanonCall(j.uses)?.workflow !== collector) continue;
      const grant = j.permissions !== undefined ? j.permissions : wf.permissions;
      const short = Object.entries(telemetryGrant).filter(([k, v]) => !isMap(grant) || level(grant[k]) < level(v));
      if (!short.length) continue;
      findItems('caller.grant-missing', file, short.map(([k]) => k), (xs) => {
        const some = short.filter(([k]) => xs.includes(k));
        return [`grants ${some.map(([k]) => `${k}: ${isMap(grant) ? grant[k] ?? 'none' : 'none'}`).join(', ')}; Kanon's telemetry collector needs ${some.map(([k, v]) => `${k}: ${v}`).join(', ')} at ${checked}, and GitHub refuses to start a run whose called job asks for more than its caller grants.`, {
          text: `Grant under the caller's permissions:`,
          commands: some.map(([k, v]) => `  ${k}: ${v}`),
        }];
      });
    }
  }
  // Only against a release on the token path: before it, the collector waited on two variables the
  // operator gave, which this release of doctor no longer asks for.
  if (collectorCallers.length && req.telemetry?.token) {
    for (const file of collectorCallers) {
      // The SigV4 path's inputs without `audience` (Owner decision of 2026-10-14, #842): the
      // collector refuses them before any token, so the caller sends nothing and registers nothing.
      const wf = /** @type {Record<string, any>} */ (workflows.get(file));
      const legacy = [...new Set(Object.values(isMap(wf.jobs) ? wf.jobs : {}).filter((j) => isMap(j) && kanonCall(j.uses)?.workflow === collector && isMap(j.with) && !('audience' in j.with))
        .flatMap((j) => ['url', 'writer-role'].filter((k) => k in j.with)))];
      if (legacy.length) {
        find('telemetry.legacy-inputs', file, `passes ${legacy.map((k) => `\`${k}:\``).join(' and ')} to Kanon's telemetry collector without \`audience:\`, the inputs of the SigV4 path ${checked} no longer takes. The collector refuses them before it mints a token, so every run is red, and nothing is sent or registered.`, {
          text: "Run kanon init again to write the new caller, which passes neither and sends to Kanon's hosted store: init never overwrites a workflow, so it lists this one as differing, with the new caller's content to write in its place. Then delete the repository variables the old lines read. Or, for a store of your own, add `audience:` beside `url:` and remove `writer-role:` (docs/telemetry.md, \"Collect the rows\").",
          commands: ['kanon init --telemetry'],
        });
      }
      const listed = await deps.gh(['run', 'list', '-R', repo, '--workflow', basename(file), '--branch', s.defaultBranch, '--status', 'completed', '--limit', '1', '--json', 'databaseId,conclusion,createdAt']);
      // A caller not yet on the default branch has no runs: GitHub knows no such workflow.
      const unknown = listed.status !== 0 && /could not find any workflows|HTTP 404/i.test(listed.stderr);
      /** @type {any[] | null} */
      let runs = unknown ? [] : null;
      try {
        if (listed.status === 0) runs = JSON.parse(listed.stdout);
      } catch {
        runs = null;
      }
      if (!Array.isArray(runs)) {
        unchecked.push({ check: 'telemetry-runs', subject: file, reason: `the token can't list its runs (${listed.stderr.trim() || `exit ${listed.status}`}); it needs Actions: read` });
        continue;
      }
      const last = runs[0];
      if (!last) {
        find('telemetry.not-run', file, `calls Kanon's telemetry collector, and has no finished run on ${s.defaultBranch} yet. Its first run registers ${repo} with the store and sends its rows: the next hourly schedule after it merges, or a dispatch.`, {
          text: 'Wait for the next hourly run, or dispatch it now on the default branch:',
          commands: [`gh workflow run ${basename(file)} -R ${repo} --ref ${s.defaultBranch}`],
        });
        continue;
      }
      const id = Number(last.databaseId);
      /** @type {string | null} */
      let words = null;
      let readable = true;
      let unpublished = false;
      try {
        const jobs = await deps.gh(['api', `repos/${repo}/actions/runs/${id}/jobs?per_page=100`]);
        if (jobs.status !== 0) readable = false;
        else {
          const listedJobs = JSON.parse(jobs.stdout).jobs ?? [];
          // The skip's own job name (#843): green, and nothing sent or registered.
          unpublished = listedJobs.some((/** @type {any} */ j) => (j?.name === UNPUBLISHED_JOB || String(j?.name).endsWith(` / ${UNPUBLISHED_JOB}`)) && j?.conclusion === 'success');
          for (const job of listedJobs) {
            const got = await deps.gh(['api', `repos/${repo}/check-runs/${Number(job.id)}/annotations?per_page=100`]);
            if (got.status !== 0) { readable = false; break; }
            const hit = JSON.parse(got.stdout).find((/** @type {any} */ a) => a?.title === REFUSED_TITLE && typeof a?.message === 'string');
            if (hit) { words = String(hit.message).split('\n', 1).join('').slice(0, 600); break; }
          }
        }
      } catch {
        readable = false;
      }
      if (!readable) {
        unchecked.push({ check: 'telemetry-runs', subject: file, reason: `the token can't read the jobs or annotations of its run ${id}; it needs Actions: read and Checks: read, which a classic token's repo scope holds: a fine-grained personal access token has no Checks permission, so on a private repository it can't read them` });
        continue;
      }
      if (unpublished) {
        find('telemetry.unpublished', file, `calls Kanon's telemetry collector, and its last run on ${s.defaultBranch}, ${id}, sent nothing: Kanon's hosted telemetry store's URL is not published in the release of Kanon it calls, so the collector skipped, and registers nothing until it is. The skips are not sweeps: the first sweep at a release that publishes it reaches back to the last sweep before them, up to 7 days.`, {
          text: 'Move the caller\'s pin to a Kanon release that publishes the hosted store\'s URL (docs/telemetry.md, "Publish the hosted URLs"), or name a store of your own with `url:` and `audience:` together. Read the run\'s summary:',
          commands: [`gh run view ${id} -R ${repo}`],
        });
      }
      if (words !== null) {
        find('telemetry.refused', file, `calls Kanon's telemetry collector, and its last run on ${s.defaultBranch}, ${id}, ended with the store's refusal: ${words}`, {
          text: 'Read the run, and do what its words say: wait for a quota to reset, dispatch with register: yes after an erasure, ask Kanon\'s operator about a suspension, or delete the caller to stop (docs/telemetry.md, "Collect the rows").',
          commands: [`gh run view ${id} -R ${repo}`],
        });
      }
    }
  }

  // ── A lane whose runs keep ending at its turn limit (#1004) ─────────────────────────────────
  // Each run of a lane writes a version-2 run row, uploaded as `kanon-telemetry-<lane>-<run>-<attempt>`,
  // with the limit that bound it (`max_turns`), the turns it took (`num_turns`) and how it ended
  // (`terminal_reason`). The rows stay in the repository, so doctor reads them as the dispatch sweep
  // does (`scripts/lib/telemetry-artifacts.mjs`): this repository's own runs only, a fork's ignored.
  // It prints run ids and counts, never a row (`K-OBS-16`). The terminal reason decides, never the
  // turns against the limit, as in `agent-classify`: a run can finish cleanly on its last turn.
  const turnLanes = installed
    .map((l) => ({ lane: l, telemetry: l.replace(/^agent-/, ''), turns: /** @type {any} */ (req.lanes[l])?.turns, file: callers.filter((c) => c.lane === l).map((c) => c.file).sort()[0] ?? l }))
    .filter((t) => isMap(t.turns) && Number.isInteger(t.turns.default) && Number.isInteger(t.turns.ceiling) && TELEMETRY_LANES.includes(t.telemetry));
  if (turnLanes.length) {
    const from = deps.now() - TURN_CAP.days * DAY;
    // The listing's pages are read here, through `gh`, and handed to the shared reader, which
    // keeps this repository's own runs. The listing is newest first, and the check wants only each
    // lane's newest `perLane` runs, so it stops at the window's start or once every lane read holds
    // `perLane` artifacts, whichever comes first. A busy repository's CI uploads thousands of
    // artifacts in 14 days (Kanon's own, about 5,000), so the second is the usual stop. At
    // `maxPages` it stops anyway: a lane still short of `perLane` was read over less than the
    // window, which a note and its message say. That is coverage, never `unchecked`.
    /** @type {Map<string, any>} */
    const pages = new Map();
    /** @type {string | null} */
    let listError = null;
    /** @type {ReturnType<typeof listTelemetryArtifacts>['artifacts']} */
    let listed = [];
    /** When the listing stopped at `maxPages` short of the window, the oldest artifact it reached. */
    let cutoff = null;
    for (let page = 1; ; page += 1) {
      const path = `repos/${repo}/actions/artifacts?per_page=100&page=${page}`;
      const got = await deps.gh(['api', path]);
      /** @type {any} */
      let body = null;
      try {
        if (got.status === 0) body = JSON.parse(got.stdout);
      } catch {
        body = null;
      }
      if (!isMap(body) || !Array.isArray(body.artifacts)) {
        listError = `the token can't list the repository's artifacts (${got.stderr.trim() || `exit ${got.status}`}); it needs Actions: read`;
        break;
      }
      pages.set(path, body);
      // A page not read yet reads as empty, which ends the reader's listing there.
      listed = listTelemetryArtifacts({ repo, from, maxPages: page + 1, api: (p) => pages.get(p) ?? { artifacts: [] } }).artifacts.filter((a) => a.kind === 'run');
      const created = body.artifacts.map((/** @type {any} */ a) => Date.parse(a?.created_at)).filter(Number.isFinite);
      if (body.artifacts.length < 100 || Math.max(...created) < from - LISTING_SLACK) break;
      if (turnLanes.every((t) => listed.filter((a) => a.lane === t.telemetry).length >= TURN_CAP.perLane)) break;
      if (page >= TURN_CAP.maxPages) {
        cutoff = Math.min(...created);
        break;
      }
    }
    if (listError !== null) unchecked.push({ check: 'turn-cap-runs', subject: repo, reason: listError });
    const newest = new Map((listError === null ? turnLanes : []).map((t) => [t, listed
      .filter((a) => a.lane === t.telemetry)
      .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
      .slice(0, TURN_CAP.perLane)]));
    const since = cutoff === null ? null : `${new Date(cutoff).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    const short = since === null ? [] : [...newest].filter(([, mine]) => mine.length < TURN_CAP.perLane).map(([t]) => t.file);
    if (short.length) notes.push(`The artifact listing reached its ${TURN_CAP.maxPages}-page cap at artifacts from ${since}, before the ${TURN_CAP.days}-day window's start, so the turn-limit check (\`lane.turn-cap\`) read ${short.join(', ')} over their runs since then, fewer than the newest ${TURN_CAP.perLane}.`);
    // Every lane's artifacts, downloaded `downloads` at a time: one at a time, 16 lanes of 20 runs
    // would add minutes to a run.
    /** @type {Map<typeof turnLanes[number], (TurnRow | 'skip' | null)[]>} */
    const read = new Map([...newest].map(([t, mine]) => [t, mine.map(() => null)]));
    const queue = [...newest].flatMap(([t, mine]) => mine.map((a, i) => ({ t, a, i })));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(TURN_CAP.downloads, queue.length) }, async () => {
      while (next < queue.length) {
        const { t, a, i } = /** @type {typeof queue[number]} */ (queue[next++]);
        const got = await deps.download(repo, a.id);
        /** @type {(TurnRow | 'skip' | null)[]} */ (read.get(t))[i] = got.status === 0 ? turnRow(got.bytes, a, t.telemetry) : null;
      }
    }));
    for (const [t, mine] of newest) {
      const got = /** @type {(TurnRow | 'skip' | null)[]} */ (read.get(t));
      const rows = /** @type {TurnRow[]} */ (got.filter((r) => r !== null && r !== 'skip'));
      const unread = got.filter((r) => r === null).length;
      if (unread) unchecked.push({ check: 'turn-cap-runs', subject: t.file, reason: `${unread} of its ${mine.length} telemetry artifacts in the window could not be read: a download the token can't make, which needs Actions: read, or a row doctor can't read. A run that ended at the turn limit may be missing from the count` });
      const reached = rows.filter((r) => r.reason !== null);
      const hit = reached.filter((r) => r.reason === 'max_turns');
      if (hit.length < TURN_CAP.runs || hit.length < TURN_CAP.share * reached.length) continue;
      const { default: limit, ceiling } = t.turns;
      const shown = reached.map((r) => {
        const cap = r.maxTurns ?? limit;
        return `${r.numTurns ?? '?'} of ${cap} (run ${r.runId}${cap > limit ? ', raised' : ''}${r.reason === 'max_turns' ? ', at the limit' : ''})`;
      });
      const taken = reached.flatMap((r) => (r.numTurns === null ? [] : [r.numTurns])).sort((a, b) => a - b);
      const mid = taken.length >> 1;
      const median = taken.length % 2 ? taken[mid] : ((taken[mid - 1] ?? 0) + (taken[mid] ?? 0)) / 2;
      const atCeiling = hit.filter((r) => r.maxTurns !== null && r.maxTurns >= ceiling).map((r) => r.runId);
      const split = atCeiling.length
        ? ` ${atCeiling.length > 1 ? 'Runs' : 'Run'} ${atCeiling.join(', ')} ${atCeiling.length > 1 ? 'were' : 'was'} raised to the ceiling, ${ceiling}, and still ended at it: this work wants splitting, since no dispatch can raise it further.`
        : '';
      find('lane.turn-cap', t.file, `calls ${t.lane}: ${hit.length} of its ${reached.length} runs that reached the model ${since !== null && mine.length < TURN_CAP.perLane ? `since ${since}, where the artifact listing's cap stopped,` : `in the last ${TURN_CAP.days} days`} ended at the turn limit (\`terminal_reason: max_turns\`). Turns taken, newest first: ${shown.join(', ')}${taken.length ? `; median ${median}, most ${taken[taken.length - 1]}` : ''}. The lane's limit is ${limit} turns, and its ceiling for one dispatched run ${ceiling}.${split}`, {
        text: `Read the runs that ended at the limit. A plain re-run fails the same way. If the work is divisible, split it into parts each finishable in one run; for the implement lanes that is the default answer, and the split lane does it. If it is one change that can't be divided, dispatch that run again with max_turns at most ${ceiling} and a reason (docs/lanes.md, "The turn budget").`,
        commands: hit.map((r) => `gh run view ${r.runId} -R ${repo}`),
      });
    }
  }

  // A run of the deploy caller counts when it is this repository's own, a `release` run or a
  // dispatch, at a release's tag (the dispatch decision), whose commit is on the default branch:
  // its workflow, and the hook its jobs call, are the reviewed ones. It never runs on the default
  // branch. The trust probe's line and the deploy announcements are read only from one (#1046).
  /** @returns {Promise<boolean | string>} whether it counts, or why the token can't tell */
  const deployRunCounts = async (/** @type {any} */ run) => {
    const from = isMap(run?.head_repository) ? String(run.head_repository.full_name ?? '') : '';
    if (!isMap(run) || run.status !== 'completed' || from.toLowerCase() !== repo.toLowerCase()) return false;
    if (run.event !== 'release' && run.event !== 'workflow_dispatch') return false;
    const tag = String(run.head_branch ?? '');
    if (!tag || tag === s.defaultBranch) return false;
    const release = await deps.gh(['api', `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`]);
    if (!isMap(ghJsonOf(release))) return false;
    const compared = ghJsonOf(await deps.gh(['api', `repos/${repo}/compare/${encodeURIComponent(String(run.head_sha ?? ''))}...${encodeURIComponent(s.defaultBranch)}`]));
    if (!isMap(compared)) return `the token can't compare ${run.html_url}'s commit with ${s.defaultBranch}`;
    return compared.behind_by === 0;
  };

  // ── Chat notifications (plan 0011 §9, step N10) ─────────────────────────────────────────────
  // Only where a workflow calls a lane that notifies at the checked release, read from its
  // requirements file's `notify` entry: none before the release that ships one, and no lane
  // before the release whose lane has a `notify` job. Doctor says nothing of the branch exposure
  // (decision 22): the weakness is stated in the plan and docs/notifications.md alone.
  // The deploy lane's caller notifies too (plan 0011 N9): each job calling the lane's
  // per-environment workflow, at a release whose `deploy.yml` has a `notify` job, which
  // requirements.json's `notify.kinds` lists by its file name. Its kind's secret is optional there.
  // The organisation's secrets shared with the repository, by name, listed once on the first
  // check that asks, which only an organisation's repository does: null where the token can't
  // list them. `notify.kind-unset` and `deploy.secret-organization` read them.
  /** @type {Promise<Set<string> | null> | null} */
  let orgListed = null;
  const orgSecrets = () =>
    (orgListed ??= (async () => {
      const r = await deps.gh(['api', `repos/${repo}/actions/organization-secrets?per_page=100`]);
      const list = ghJsonOf(r)?.secrets;
      return Array.isArray(list) ? new Set(list.map((/** @type {any} */ x) => String(x?.name ?? '').toUpperCase())) : null;
    })());
  const deployNotifyJobs = notify
    ? [...workflows].flatMap(([file, wf]) => Object.values(isMap(wf.jobs) ? wf.jobs : {}).filter(isMap).flatMap((job) => {
      const lane = kanonCall(job.uses)?.workflow ?? '';
      return !Object.hasOwn(req.lanes, lane) && kindOf(lane) ? [{ file, lane, job }] : [];
    }))
    : [];
  const notifyCallers = notify ? [...callers.filter((c) => req.lanes[c.lane] && kindOf(c.lane)), ...deployNotifyJobs] : [];
  if (notify && notifyCallers.length) {
    const hookPath = notify.hook.path;
    const hookText = read(hookPath);
    const files = [...new Set(notifyCallers.map((c) => c.file))].sort();
    const posting = `${files.join(', ')} call${files.length > 1 ? '' : 's'} ${[...new Set(notifyCallers.map((c) => c.lane))].sort().join(', ')}`;
    const prebuiltNames = Object.keys(notify.prebuilt).sort();
    if (hookText === null) {
      // ── `notify.none`: no hook, nothing posts, and no model runs for a post (decision 2, §8).
      find('notify.none', hookPath, `is missing, so nothing posts: ${posting}, whose chat messages, and the model runs that write their narratives, are skipped. The rest of each lane still runs: the project digest's health job files its issues. That is a choice; to post, add a hook (plan 0011 §8).`, {
        text: `Write one of Kanon's prebuilt hooks there, from the release you check (${checked}): the first command, then the line of ${prebuiltNames.map((n) => `Kanon's ${n} hook`).join(' or ')}. Or write your own composite action at ${hookPath}, taking the inputs ${notify.hook.inputs.join(', ')} (docs/notifications.md). Then store each kind's secret.`,
        commands: [
          `mkdir -p ${dirname(hookPath)}`,
          ...prebuiltNames.map((n) => `gh api -H 'Accept: application/vnd.github.raw+json' 'repos/${KANON_REPO}/contents/${notify.prebuilt[n]?.hook}?ref=${checked}' > ${hookPath}`),
        ],
        url: `https://github.com/${KANON_REPO}/blob/${checked}/docs/notifications.md`,
      });
    } else {
      /** @type {unknown} */
      let doc = null;
      /** @type {string | null} */
      let unreadable = null;
      try {
        doc = parseYaml(hookText);
      } catch (e) {
        unreadable = /** @type {Error} */ (e).message;
      }
      const inputs = isMap(doc) && isMap(doc.inputs) ? Object.keys(doc.inputs) : [];
      const runs = isMap(doc) && isMap(doc.runs) ? doc.runs : {};
      const steps = Array.isArray(runs.steps) ? runs.steps.filter(isMap) : [];
      const declared = inputs.map((k) => /^message-v(\d+)$/.exec(k)?.[1]).filter((v) => v !== undefined).map(Number).sort((a, b) => a - b);
      const written = declared.filter((v) => notify.versions.includes(v));
      const newest = Math.max(...notify.versions);
      // ── `notify.hook-malformed`: a composite action that declares `secret` and a version this
      // release writes (§6.2, item 1). The block reads it to choose what to pass.
      const problems = [
        ...(unreadable !== null ? [`doctor can't read it as YAML (${unreadable})`] : []),
        ...(unreadable === null && runs.using !== 'composite' ? [`its runs.using is ${runs.using === undefined ? 'missing' : `\`${String(runs.using)}\``}, not \`composite\``] : []),
        ...(unreadable === null && !written.length ? [`it declares no input \`message-v<N>\` for a version ${checked} writes (${notify.versions.map((v) => `message-v${v}`).join(', ')})${declared.length ? `: it declares ${declared.map((v) => `message-v${v}`).join(', ')}` : ''}`] : []),
        ...(unreadable === null && !inputs.includes('secret') ? ['it declares no input `secret`, which carries the kind\'s secret'] : []),
      ];
      if (problems.length) {
        find('notify.hook-malformed', hookPath, `is not a hook the lanes can call at ${checked}: ${problems.join('; ')}. The notify job fails before it posts (plan 0011 §6.2).`, {
          text: `Make it a composite action (runs: using: composite) that declares these inputs, as Kanon's prebuilt hooks do (docs/notifications.md):`,
          commands: ['inputs:', ...notify.hook.inputs.flatMap((k) => [`  ${k}:`, '    required: true'])],
          url: `https://github.com/${KANON_REPO}/blob/${checked}/${notify.prebuilt[prebuiltNames[0] ?? '']?.hook ?? 'docs/notifications.md'}`,
        });
      } else if (!written.includes(newest)) {
        // ── `notify.hook-version-old`: on a version this release still writes, not its newest (§3.4).
        find('notify.hook-version-old', hookPath, `declares ${written.map((v) => `message-v${v}`).join(', ')}, and ${checked} writes message-v${newest} too: it still hands this hook the version it declares, until a later release stops writing it (plan 0011 §3.4).`, {
          text: `Read message-v${newest} in the hook, and declare the input, before a release stops writing message-v${Math.max(...written)}. A prebuilt hook moves when its pin does (notify.hook-pin-behind).`,
          commands: [`  message-v${newest}:`, '    required: true'],
        });
      }
      // ── `notify.hook-unpinned` (`K-ADOPT-12`, §6.2 item 3) and `notify.hook-pin-behind` (decision 18).
      const uses = steps.map((st) => (typeof st.uses === 'string' ? st.uses.trim() : null)).filter((u) => u !== null);
      const unpinned = uses.filter((u) => !pinnedUses(u));
      if (unpinned.length) {
        find('notify.hook-unpinned', hookPath, `calls ${unpinned.map((u) => `\`${u}\``).join(', ')}, not pinned: a hook's action names a version tag or a full commit SHA, never a branch, and a docker:// image names a digest (@sha256:…), never a tag alone (K-ADOPT-12, plan 0011 §6.2). Whatever the ref points at runs with this kind's chat secret.`, {
          text: `Pin each to a release tag or a full commit SHA, and each image to its digest.`,
        });
      }
      const prebuiltActions = new Map(Object.entries(notify.prebuilt).map(([n, p]) => [`${KANON_REPO}/${p.action}`, n]));
      for (const u of uses) {
        const m = /^([^@\s]+)@(\S+)$/.exec(u);
        const name = m ? prebuiltActions.get(/** @type {string} */ (m[1])) : undefined;
        if (!m || name === undefined || m[2] === pinned) continue;
        // Ahead of the callers, `lane-check` fails it (its `HOOK_PINS`, `K-ADOPT-11`): the pin
        // follows theirs, never leads it, so doctor blocks on it too (#958). A candidate is level
        // with its stable release here, as there.
        if (EXACT_RELEASE.test(/** @type {string} */ (m[2])) && newer(/** @type {string} */ (m[2]), pinned) > 0) {
          find('notify.hook-pin-ahead', hookPath, `is Kanon's ${name} hook at ${m[2]}, ahead of the callers' ${pinned}: its pin follows theirs, never leads it, so lane-check fails it on the next pull request (K-ADOPT-11, plan 0011 decision 18).`, {
            text: `Move its pin back to the callers', or move the callers to ${m[2]} with the upgrade skill:`,
            commands: [`    - uses: ${m[1]}@${pinned}`],
          });
          continue;
        }
        const behind = EXACT_RELEASE.test(/** @type {string} */ (m[2])) && newer(/** @type {string} */ (m[2]), pinned) < 0;
        find('notify.hook-pin-behind', hookPath, `is Kanon's ${name} hook at ${m[2]}, and the callers pin ${pinned}: ${behind ? 'it is behind them' : 'they differ'}. It works while it declares a contract version the callers' release still writes; the upgrade skill moves it with the callers (plan 0011 decision 18).`, {
          text: `Move its pin to the callers', as the upgrade skill does:`,
          commands: [`    - uses: ${m[1]}@${pinned}`],
        });
      }
      // ── `notify.hook-unreviewed` (§6.2, item 2): every repository path the hook runs escalates.
      /** @type {import('../scripts/lib/escalation-paths.mjs').EscalationFile | null} */
      let escalation = null;
      const escalationText = read(ESCALATION_FILE);
      try {
        escalation = escalationText === null ? defaultEscalationFile() : parseEscalationFile(escalationText);
      } catch (e) {
        unchecked.push({ check: 'notify-hook', subject: hookPath, reason: `could not read ${ESCALATION_FILE} (${/** @type {Error} */ (e).message}), so doctor can't tell whether every repository path the hook runs escalates` });
      }
      const exists = (/** @type {string} */ p) => read(p) !== null || deps.listFiles(join(root, p)).length > 0;
      const reviewed = (/** @type {string} */ p) => p.startsWith('.github/') || (escalation?.pipeline ?? []).some((e) => inPipelineCode(e.dir, p) || inPipelineCode(e.dir, `${p}/`));
      const local = uses.filter((u) => u.startsWith('./')).map((u) => u.slice(2).replace(/\/+$/, ''));
      const runTexts = steps.map((st) => (typeof st.run === 'string' ? st.run : '')).filter(Boolean);
      const named = [...new Set([...local, ...runTexts.flatMap((r) => runPaths(r, exists))])];
      const outside = escalation ? named.filter((p) => !reviewed(p)) : [];
      const installs = runTexts.map((r) => PACKAGE_INSTALL.exec(r)?.[0]).filter((x) => x !== undefined);
      if (outside.length || installs.length) {
        find('notify.hook-unreviewed', hookPath, [
          ...(outside.length ? [`runs ${outside.map((p) => `\`${p}\``).join(', ')}, which ${outside.length > 1 ? 'are' : 'is'} neither under .github/ nor a ## Pipeline code entry of ${ESCALATION_FILE}, so a change to ${outside.length > 1 ? 'them' : 'it'} can merge without a person and then run with the kind's chat secret (K-MERGE-4).`] : []),
          ...(installs.length ? [`installs packages (\`${installs.join('`, `')}\`): a lockfile outside .github/ brings in code nobody reviewed.`] : []),
        ].join(' ') + ' Every repository file the hook runs must escalate (plan 0011 §6.2).', {
          text: [
            ...(outside.length ? [`Move ${outside.length > 1 ? 'them' : 'it'} under .github/ (beside the hook is simplest), or declare ${outside.length > 1 ? 'them' : 'it'} under ## Pipeline code in ${ESCALATION_FILE} (K-LAYOUT-8):`] : []),
            ...(installs.length ? ['Run no package install in the hook: vendor what it needs under .github/, or call a pinned action or an image by digest instead.'] : []),
          ].join(' '),
          commands: outside.map((p) => `- \`${p}${exists(p) && read(p) === null ? '/' : ''}\` — the notify hook runs it`),
        });
      }
      // ── `notify.kind-unset`: each notifying caller's kind secret is held (decision 3), else a
      // note. An organisation's secret shared with the repository counts, where the token can
      // list them; where it can't, the check is unchecked, never a finding.
      const seen = new Set();
      for (const c of notifyCallers) {
        const kind = /** @type {string} */ (kindOf(c.lane));
        const name = kindSecret(kind);
        if (seen.has(`${c.file} ${kind}`)) continue;
        seen.add(`${c.file} ${kind}`);
        // A deploy caller's job that doesn't map the optional secret hands its notify job none, so
        // it records `skipped` whatever the repository holds: its line is part of the fix.
        const unmapped = deployNotifyJobs.filter((x) => x.file === c.file && kindOf(x.lane) === kind && !(x.job.secrets === 'inherit' || (isMap(x.job.secrets) && Object.hasOwn(x.job.secrets, name))));
        const jobsOf = Object.entries(isMap(workflows.get(c.file)?.jobs) ? /** @type {Record<string, unknown>} */ (workflows.get(c.file)?.jobs) : {});
        const unmappedIds = unmapped.map((x) => jobsOf.find(([, j]) => j === x.job)?.[0] ?? x.lane);
        const mapLine = `      ${name}: \${{ secrets.${name} }}`;
        // Whether the secret is held: the repository's listing, then, on an organisation's
        // repository, the organisation's secrets shared with it. `lacks` is null where neither can
        // be read, and `blind` then says why.
        /** @type {boolean | null} */
        let lacks = null;
        /** @type {string | null} */
        let blind = null;
        if (!s.secrets) blind = `the token can't list ${repo}'s secret names (it needs admin access), so doctor can't tell whether ${name}, ${kind}'s secret, is held`;
        else if (s.secrets.has(name)) lacks = false;
        else if (s.kind === 'Organization') {
          const org = await orgSecrets();
          if (org === null) blind = `${repo} doesn't hold ${name}, ${kind}'s secret, and an organisation secret of ${s.owner} shared with it could, which the token can't list`;
          else lacks = !org.has(name);
        } else lacks = true;
        if (blind) unchecked.push({ check: 'notify-secrets', subject: c.file, reason: blind });
        // A deploy job that doesn't map the optional secret is the finding whatever is held: its
        // line is the fix, with the `gh secret set` line only where a listing shows the secret missing.
        if (unmapped.length) {
          const plural = unmappedIds.length > 1;
          find('notify.kind-unset', c.file, `calls ${c.lane}, whose ${kind} messages are posted only with ${name}, and its job${plural ? 's' : ''} ${unmappedIds.join(', ')} map${plural ? '' : 's'} none${lacks ? `, nor does ${repo} hold it` : ''}: so ${kind} is not posted. That is a choice (plan 0011 decision 3).`, lacks
            ? {
              text: `To post ${kind}, store what your hook needs for it (for Kanon's Slack hook, the URL of a Slack incoming webhook for that channel; for its generic webhook hook, an https URL) ${OWN_TERMINAL}, and add the second line under the secrets: of each of those jobs:`,
              commands: [`gh secret set ${name} -R ${repo}`, mapLine],
            }
            : { text: `To post ${kind}, add the line under the secrets: of each of those jobs, as kanon init writes it:`, commands: [mapLine] });
          continue;
        }
        if (!lacks) continue;
        find('notify.kind-unset', c.file, `calls ${c.lane}, whose ${kind} messages are posted only with ${name}, which ${repo} doesn't hold: so ${kind} is not posted${req.lanes[c.lane] ? ', and the model run that writes it is skipped' : ''}. That is a choice (plan 0011 decision 3).`, {
          text: `To post ${kind}, store what your hook needs for it (for Kanon's Slack hook, the URL of a Slack incoming webhook for that channel; for its generic webhook hook, an https URL) ${OWN_TERMINAL}:`,
          commands: [`gh secret set ${name} -R ${repo}`],
        });
      }
    }
    // ── `notify.failing`: the latest notify jobs that ran, on a completed run of the caller on the
    // default branch, printed `outcome: posted` or `skipped` (§5.1, step 6), as apps-check's line
    // is read. A run from another branch or repository is never read, whatever the server filtered.
    // The deploy caller runs at a release's tag, never on the default branch, so its runs are
    // listed at every ref and read only where one counts, as the trust probe's are (#1046); each
    // environment's call has its own notify job, and every one of the run's that ran is read.
    const deployFiles = new Set(deployNotifyJobs.map((x) => x.file));
    for (const file of files) {
      const name = basename(file);
      const deploy = deployFiles.has(file);
      const digest = notifyCallers.some((c) => c.file === file && !deployNotifyJobs.includes(c));
      const listed = await deps.gh(['api', `repos/${repo}/actions/workflows/${name}/runs?${deploy ? '' : `branch=${encodeURIComponent(s.defaultBranch)}&`}status=completed&per_page=${NOTIFY_RUNS}`]);
      const list = ghJsonOf(listed)?.workflow_runs;
      if (!Array.isArray(list)) {
        if (!/HTTP 404|Not Found/i.test(listed.stderr)) unchecked.push({ check: 'notify-runs', subject: file, reason: `the token can't list its runs (${listed.stderr.trim() || `exit ${listed.status}`}); it needs Actions: read` });
        continue;
      }
      /** @type {{ run: any, jobs: any[], tag: boolean } | null} */
      let latest = null;
      /** @type {string | null} */
      let blind = null;
      for (const run of list) {
        const from = isMap(run?.head_repository) ? String(run.head_repository.full_name ?? '') : '';
        if (!isMap(run) || run.status !== 'completed' || from.toLowerCase() !== repo.toLowerCase()) continue;
        const onDefault = digest && run.head_branch === s.defaultBranch;
        const counts = onDefault || !deploy ? onDefault : await deployRunCounts(run);
        if (typeof counts === 'string') { blind = counts; break; }
        if (!counts) continue;
        const jobs = ghJsonOf(await deps.gh(['api', `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`]))?.jobs;
        if (!Array.isArray(jobs)) { blind = `the token can't list the jobs of its runs; it needs Actions: read`; break; }
        const ran = jobs.filter((j) => isMap(j) && (j.name === NOTIFY_JOB || String(j.name).endsWith(` / ${NOTIFY_JOB}`)) && (j.conclusion === 'success' || j.conclusion === 'failure'));
        if (ran.length) { latest = { run, jobs: ran, tag: !onDefault }; break; }
      }
      if (blind) {
        unchecked.push({ check: 'notify-runs', subject: file, reason: blind });
        continue;
      }
      if (!latest) continue;
      const { run } = latest;
      /** @type {{ job: any, said: any } | null} */
      let failing = null;
      /** @type {string | null} */
      let unread = null;
      for (const job of latest.jobs) {
        const which = `the notify job${latest.jobs.length > 1 ? ` \`${String(job.name)}\`` : ''} of ${run.html_url}`;
        const path = `repos/${repo}/actions/jobs/${job.id}/logs`;
        let log = await deps.gh(['api', '--allow-escape-sequences', path]);
        if (log.status !== 0 && /unknown flag/.test(log.stderr)) log = await deps.gh(['api', path]);
        if (log.status !== 0) {
          unread ??= `the token can't read the log of ${which}, which needs Actions: read (${log.stderr.trim() || `exit ${log.status}`})`;
          continue;
        }
        /** @type {any} */
        let said = null;
        for (const line of log.stdout.split('\n')) {
          const at = line.indexOf(`${NOTIFY_LINE} {`);
          if (at === -1) continue;
          try {
            said = JSON.parse(line.slice(at + NOTIFY_LINE.length + 1).trim());
          } catch {
            said = null;
          }
        }
        if (!isMap(said) || typeof said.outcome !== 'string') {
          unread ??= `${which} printed no ${NOTIFY_LINE} line doctor can read`;
          continue;
        }
        if (said.outcome === 'posted' || said.outcome === 'skipped') continue;
        failing = { job, said };
        break;
      }
      if (!failing) {
        if (unread) unchecked.push({ check: 'notify-runs', subject: file, reason: unread });
        continue;
      }
      const { said } = failing;
      const date = String(run.created_at ?? '').slice(0, 10);
      const where = latest.tag
        ? `The latest notify job that ran at a release's tag, \`${String(failing.job.name)}\` in ${run.html_url} (${run.event === 'release' ? 'a release' : 'a dispatch'} at ${String(run.head_branch)}, ${date}),`
        : `The latest notify job on ${s.defaultBranch}, in ${run.html_url} of ${date},`;
      find('notify.failing', file, `${where} says ${said.kind ? `${String(said.kind)} was` : 'its message was'} ${String(said.outcome)}${said.hook ? `, through the ${String(said.hook)} hook` : ''}: the hook's step failed, or Kanon refused the message, so nothing was posted. The producing job stays green (K-SHIP-10).`, {
        text: `Read the job's log for the hook's error, fix the hook or the kind's secret, then re-run the failed job, which posts the same message again (plan 0011 §5.4)${latest.tag ? `. Re-running the failed jobs re-runs a failed deploy job of the run too, and the jobs that need it` : ''}:`,
        commands: [`gh run view ${run.id} -R ${repo} --log-failed`, `gh run rerun ${run.id} -R ${repo} --failed`],
      });
    }
  }

  // ── The backlog feeder (#609) ─────────────────────────────────────────────────────────────
  // Where a caller runs a dispatch sweep that feeds the backlog at the checked release, the state
  // of its valve, as a note: unset is the feeder's default, off, and no finding.
  const feeders = callers.filter((c) => req.lanes[c.lane]?.optionalVariables?.includes(BACKLOG_FEED)).map((c) => c.file);
  if (feeders.length) {
    const listed = await deps.gh(['variable', 'list', '-R', repo, '--json', 'name,value']);
    /** @type {Map<string, string> | null} */
    let vars = null;
    try {
      if (listed.status === 0) vars = new Map(JSON.parse(listed.stdout).map((/** @type {any} */ v) => [String(v.name), String(v.value ?? '')]));
    } catch {
      vars = null;
    }
    notes.push(backlogFeedNote(feeders, vars, repo));
  }

  // ── The deploy lane (plan 0010 §12, step D7) ─────────────────────────────────────────────────
  // The declaration is read through the one parser every reader uses, from the checkout, with
  // the reference bullets `deploy.declaration-moved` reports (below) set aside, so a record with
  // only those to move isn't malformed too. Three checks concern the reference deploy and run for
  // every adopter; the rest only where the record declares an environment or a deploy caller
  // exists (decision 2): an adopter with neither has no deploy lane.
  const deployRecord = read(ADOPTION_RECORD);
  const movedLines = new Set(deployRecord === null ? [] : movedReferenceBullets(deployRecord).map((m) => m.line));
  /** @type {import('../scripts/lib/deploy-declaration.mjs').DeployDeclaration | null} */
  let deployDecl = null;
  let deployBroken = false;
  if (deployRecord !== null) {
    try {
      deployDecl = parseDeployDeclaration(deployRecord.replace(/\r\n?/g, '\n').split('\n').map((l, i) => (movedLines.has(i + 1) ? '' : l)).join('\n'));
    } catch (e) {
      if (!(e instanceof DeclarationError)) throw e;
      deployBroken = true;
      find('deploy.declaration', ADOPTION_RECORD, `${/** @type {Error} */ (e).message}. The deploy lane's gate, \`kanon init\` and the reconciler read ${DEPLOY_HEADING} through one parser, which refuses it (plan 0010 §4).`, {
        text: `Write ${DEPLOY_HEADING} as docs/lanes.md ("The deploy lane") shows: the environments in deploy order, the CI wait, the three reference deploy bullets (all or none) and the fallback's marker, each a \`- \` bullet with its bold label and one code span:`,
        commands: [DEPLOY_HEADING, '', '- **Environments:** `<first>`, `<production>`', '- **Reference environment:** `<first>`', '- **Reference deploy workflow:** `deploy.yml`', '- **Reference deploy job:** `<first> / deploy`'],
      });
    }
  }
  /** The fallback's marker the record declares (plan 0010 §13), or null. */
  const deployFallback = deployDecl?.fallback ?? null;
  const chain = deployDecl?.environments ?? [];
  const laneWorkflows = deployWorkflows(req);
  const deployDeclared = /** @type {{ deploy?: { workflows: { release: string, environment: string }, hooks: Array<{ path: string, inputs: string[] }> } }} */ (/** @type {unknown} */ (req)).deploy;
  // A deploy caller: any workflow with a job that calls one of the lane's two workflows.
  const deployCallers = [...workflows].filter(([, wf]) => Object.values(isMap(wf.jobs) ? wf.jobs : {}).some((j) => isMap(j) && laneWorkflows.includes(kanonCall(j.uses)?.workflow ?? ''))).map(([f]) => f).sort();
  // ── `deploy.reference-undeclared` (a note): with no chain, the three reference bullets in
  // `## Deploy`, naming any workflow and job, as today; with one, the first environment's job of
  // the caller, as `init` writes it. Not while bullets wait to move, which is that finding's fix.
  if (deployRecord !== null && !deployBroken && deployDecl && !movedLines.size) {
    const ref = deployDecl.reference;
    const callerName = basename(deployCallers[0] ?? DEPLOY_CALLER_PATH);
    if (!ref) {
      find('deploy.reference-undeclared', ADOPTION_RECORD, `${ADOPTION_RECORD} declares no reference deploy under ${DEPLOY_HEADING}, so no project can close: the reconciler confirms a project's merges are deployed by that deploy job's run (K-PROJ-11). ${chain.length ? `With the chain declared, it is the first environment's, \`${chain[0]}\`.` : 'A repository that deploys nothing keeps it so, and can waive this note with its reason.'}`, {
        text: chain.length ? `Add the three bullets under ${DEPLOY_HEADING}, as kanon init writes them for the first environment:` : `Add the three bullets under ${DEPLOY_HEADING}, naming the environment a project's merges reach, the workflow file that deploys it and its job as a run lists it:`,
        commands: chain.length
          ? [`- **Reference environment:** \`${chain[0]}\``, `- **Reference deploy workflow:** \`${callerName}\``, `- **Reference deploy job:** \`${chain[0]} / deploy\``]
          : ['- **Reference environment:** `<environment>`', '- **Reference deploy workflow:** `<workflow>.yml`', '- **Reference deploy job:** `<job, as a run lists it>`'],
      });
    } else if (chain.length && (ref.workflow !== callerName || ref.job !== `${ref.environment} / deploy`)) {
      find('deploy.reference-undeclared', ADOPTION_RECORD, `${ADOPTION_RECORD}'s reference deploy names ${ref.workflow}'s job \`${ref.job}\`, not the deploy caller's job for \`${ref.environment}\`, \`${ref.environment} / deploy\` in ${callerName}. Doctor can't tell a deliberate choice from a stale one: the reconciler confirms a project by the job named there (K-PROJ-11).`, {
        text: `Keep it if it is meant, and waive this note with the reason; otherwise name the caller's job:`,
        commands: [`- **Reference deploy workflow:** \`${callerName}\``, `- **Reference deploy job:** \`${ref.environment} / deploy\``],
      });
    }
  }
  if (!deployBroken && (chain.length || deployCallers.length) && !deployDeclared) {
    notes.push(`${chain.length ? `${ADOPTION_RECORD} declares the deploy environments ${chain.join(', ')}` : `${deployCallers.join(', ')} call${deployCallers.length > 1 ? '' : 's'} a deploy lane`}, but Kanon ${checked} ships no deploy lane, so doctor checks none of it (plan 0010).`);
  }
  if (!deployBroken && (chain.length || deployCallers.length) && deployDeclared) {
    const lane = deployDeclared.workflows;
    const marker = deployFallback ? ` (the adoption record's fallback, \`${deployFallback}\`, plan 0010 §13)` : '';
    // ── `deploy.caller-mismatch`: the caller against the declaration, as `kanon init` writes it.
    const own = deployCallers.includes(DEPLOY_CALLER_PATH) ? DEPLOY_CALLER_PATH : deployCallers[0];
    const initFix = { text: `Run kanon init again: it writes ${DEPLOY_CALLER_PATH} from the ${DEPLOY_HEADING} list, one job per environment, in order (docs/lanes.md, "The deploy lane").`, commands: ['kanon init'] };
    if (!own) {
      find('deploy.caller-mismatch', DEPLOY_CALLER_PATH, `is missing: ${ADOPTION_RECORD} declares the environments ${chain.join(', ')}, and no workflow calls the deploy lane, so no release deploys.`, initFix);
    }
    for (const file of deployCallers) {
      const problems = file === own
        ? deployCallerProblems(/** @type {Record<string, any>} */ (workflows.get(file)), chain, lane, deployEnvironmentSecrets(req))
        : [`it calls the deploy lane beside ${own}, the repository's deploy caller: a release would deploy twice`];
      if (problems.length) {
        find('deploy.caller-mismatch', file, `doesn't match ${ADOPTION_RECORD}'s ${DEPLOY_HEADING} (${chain.length ? chain.join(', ') : 'no environment'}): ${problems.join('; ')}. The gate refuses a caller whose list isn't the declaration's (plan 0010 §4, §12).`, file === own
          ? (chain.length ? initFix : { text: `Remove it, or declare the environments under ${DEPLOY_HEADING} and run kanon init again (docs/lanes.md, "The deploy lane").`, commands: [`git rm ${file}`] })
          : { text: `Remove it: the deploy lane has one caller, ${own}.`, commands: [`git rm ${file}`] });
      }
    }
    if (chain.length) {
      // ── `deploy.hook-missing`: the three hooks, each declaring the inputs the lane passes.
      for (const hook of deployDeclared.hooks) {
        const text = read(hook.path);
        /** @type {unknown} */
        let doc = null;
        if (text !== null) {
          try {
            doc = parseYaml(text);
          } catch (e) {
            unchecked.push({ check: 'deploy-hook', subject: hook.path, reason: `could not read it: ${/** @type {Error} */ (e).message}` });
            continue;
          }
        }
        const inputs = isMap(doc) && isMap(doc.inputs) ? Object.keys(doc.inputs) : [];
        const lacks = hook.inputs.filter((k) => !inputs.includes(k));
        if (text === null || lacks.length) {
          find('deploy.hook-missing', hook.path, text === null ? `is missing; the deploy lane calls it at ${checked} (plan 0010 §7).` : `does not declare ${lacks.join(', ')}, which the deploy lane passes it at ${checked} (plan 0010 §7).`, text === null
            ? { text: `Let kanon init write its stub, which fails by name until you replace its step with your own; it never overwrites a hook.`, commands: ['kanon init'] }
            : { text: `Add under inputs:`, commands: lacks.flatMap((k) => [`  ${k}:`, "    description: Passed by Kanon's deploy lane (docs/lanes.md).", '    default: ""']) });
        }
      }
      // ── `deploy.releaser-missing`: a release made with the workflow's token starts no run.
      if (!releaseCallers.some((c) => isMap(c.job.secrets) && releaserSecrets.every((n) => n in c.job.secrets))) {
        const file = releaseCallers[0]?.file ?? '.github/workflows/release.yml';
        find('deploy.releaser-missing', file, `${releaseCallers.length ? `calls Kanon's release workflow without mapping the Releaser's ${releaserSecrets.join(' and ')}` : 'is not there: no workflow calls Kanon\'s release workflow'}, so a release is made with the workflow's token, which starts no run: the deploy lane never starts on a release (plan 0010 §3).`, {
          text: `Install the Releaser App (kanon apps), and map its two secrets in the release caller's job, as kanon init writes it (docs/release.md):`,
          commands: releaserSecrets.map((n) => `      ${n}: \${{ secrets.${n} }}`),
        });
      }
      // ── `deploy.ci-push-missing`: the gate waits for the release commit's `ci.yml` push run.
      const onDefault = await defaultWorkflows();
      if (onDefault.error !== null) unchecked.push({ check: 'deploy-ci', subject: '.github/workflows/ci.yml', reason: `could not read the workflows on ${s.defaultBranch} (${onDefault.error}), so doctor can't tell whether ci.yml runs on push there, which the deploy lane's gate waits for` });
      else {
        const ci = onDefault.workflows?.get('.github/workflows/ci.yml');
        if (!ci || !runsOnPush(ci, s.defaultBranch)) {
          find('deploy.ci-push-missing', '.github/workflows/ci.yml', `${ci ? `on ${s.defaultBranch} doesn't run on push to ${s.defaultBranch}` : `is not on ${s.defaultBranch}`}: the deploy lane's gate waits for the release commit's ci.yml push run, and refuses ci-timeout without one (plan 0010 §3, K-SHIP-8).`, {
            text: `Run ci.yml on push to ${s.defaultBranch}, as kanon init writes it, and merge it:`,
            commands: ['on:', '  push:', `    branches: [${s.defaultBranch}]`],
          });
        }
      }
      // ── The environments: each declared one exists, production has reviewers, every one
      // admits the release tags alone, and production's two notes.
      const production = /** @type {string} */ (chain[chain.length - 1]);
      const envsRead = await deps.gh(['api', `repos/${repo}/environments?per_page=100`]);
      const envList = ghJsonOf(envsRead)?.environments;
      const settingsUrl = `https://github.com/${repo}/settings/environments`;
      if (!Array.isArray(envList)) {
        unchecked.push({ check: 'deploy-environments', subject: repo, reason: `the token can't read ${repo}'s environments (${envsRead.stderr.trim() || `exit ${envsRead.status}`}); it needs Actions: read, or Environments: read on a fine-grained token` });
      } else {
        /** @type {Map<string, any>} */
        const envs = new Map(envList.filter(isMap).map((e) => [String(e.name), e]));
        const noEnvironments = deployFallback === 'no-environments';
        for (const name of chain) {
          if (envs.has(name)) continue;
          find('deploy.environment-missing', name, noEnvironments
            ? `is declared and isn't one of ${repo}'s environments, as the \`no-environments\` fallback says: its job sets no environment, so its role trusts the release tags' subject, and any job at a release tag with id-token: write can assume it. Weaker, as the record states (plan 0010 §13).`
            : `is declared in ${ADOPTION_RECORD} and isn't one of ${repo}'s environments: a job that names it creates it with no protection rule and no deployment policy (plan 0010 §4).`, {
            text: noEnvironments ? `Nothing to do on a plan without environments. Once the plan has them, create it, and remove the marker.` : `Create it on the environments page, with required reviewers where it is production, and the release tags alone as its deployment refs:`,
            url: settingsUrl,
          }, noEnvironments);
        }
        const reviewersOf = (/** @type {any} */ e) => (Array.isArray(e?.protection_rules) ? e.protection_rules : []).find((/** @type {any} */ r) => r?.type === 'required_reviewers') ?? null;
        const prod = envs.get(production);
        const prodReviewers = prod ? reviewersOf(prod) : null;
        if (!prodReviewers && (prod || deployFallback)) {
          find('deploy.reviewers-missing', production, deployFallback
            ? `is production, and has no required reviewers${marker}: production deploys only on the Maintainer's dispatch, a check of the lane's own code at the release's commit, not the platform's. Weaker, as the record states.`
            : `is production, and has no required reviewers: nothing on the platform stands between a release and production (plan 0010 §4).`, {
            text: deployFallback ? `Nothing to do while the plan offers no reviewers. Once it does, add them, and remove the marker.` : `Add a required reviewers rule to ${production} on the environments page, or declare the fallback's marker where the plan offers none (plan 0010 §13).`,
            url: settingsUrl,
          }, Boolean(deployFallback));
        }
        for (const name of chain.slice(0, -1).filter((n) => envs.has(n))) {
          notes.push(`The pre-production environment ${name} ${reviewersOf(envs.get(name)) ? 'has' : 'has no'} required reviewers rule; the declaration names none, so either is the project's choice (plan 0010 §12).`);
        }
        for (const name of chain.filter((n) => envs.has(n))) {
          const e = envs.get(name);
          const policy = isMap(e.deployment_branch_policy) ? e.deployment_branch_policy : null;
          /** @type {string | null} */
          let wrong = null;
          if (!policy) wrong = 'admits every branch and tag ("No restriction")';
          else if (policy.protected_branches) wrong = 'admits the protected branches ("Protected branches only"), the default branch among them';
          else {
            const listed = await deps.gh(['api', `repos/${repo}/environments/${encodeURIComponent(name)}/deployment-branch-policies?per_page=100`]);
            const rules = ghJsonOf(listed)?.branch_policies;
            if (!Array.isArray(rules)) {
              unchecked.push({ check: 'deploy-environments', subject: name, reason: `the token can't read its deployment refs (${listed.stderr.trim() || `exit ${listed.status}`})` });
              continue;
            }
            const branches = rules.filter((r) => r?.type !== 'tag').map((r) => String(r?.name ?? ''));
            if (branches.length) wrong = `admits the branch${branches.length > 1 ? 'es' : ''} ${branches.map((b) => `\`${b}\``).join(', ')}`;
            else if (!rules.length) wrong = 'restricts its deployment refs to an empty list';
          }
          if (wrong) {
            find('deploy.branch-policy', name, `${wrong}: the lane asks for the release tags' pattern alone, since every job of it runs at a release tag. Any job on an admitted branch that names ${name} gets its secrets and its role${deployFallback === 'no-reviewers' ? ', with no reviewer in front of them under the `no-reviewers` fallback' : ''} (plan 0010 §4, §15.1).`, {
              text: `On the environments page, set its deployment branches and tags to "Selected branches and tags", with one tag rule, the release tags' pattern, and no branch rule.`,
              url: settingsUrl,
            });
          }
        }
        if (prodReviewers && prodReviewers.prevent_self_review !== true) {
          find('deploy.self-review', production, `lets a reviewer approve a run they started. Never a block: with self-review prevention on, a maintainer can't approve a run their own token started, a release they published by hand or any dispatch, rollback included, so for a project whose only reviewer is the person who dispatches or publishes it must stay off (plan 0010 §4, decision 18).`, {
            text: `Nothing to do where one person reviews and publishes. With a second reviewer, turn "Prevent self-review" on for ${production}.`,
            url: settingsUrl,
          });
        }
        if (prod && prod.can_admins_bypass !== false) {
          find('deploy.admin-bypass', production, `lets administrators bypass its protection rules, which is GitHub's default: an administrator can deploy to production with no reviewer (plan 0010 §12).`, {
            text: `Turn "Allow administrators to bypass configured protection rules" off for ${production}, unless an administrator deploying alone is meant.`,
            url: settingsUrl,
          });
        }
      }
      // ── `deploy.subject-custom`: the environment must be in the OIDC subject (plan 0010 §5).
      const sub = await deps.gh(['api', `repos/${repo}/actions/oidc/customization/sub`]);
      const subject = ghJsonOf(sub);
      if (!isMap(subject)) unchecked.push({ check: 'deploy-subject', subject: repo, reason: `the token can't read ${repo}'s OIDC subject template (${sub.stderr.trim() || `exit ${sub.status}`}), so doctor can't tell whether the environment is in each deploy job's subject` });
      else if (subject.use_default !== true && !(Array.isArray(subject.include_claim_keys) && subject.include_claim_keys.includes('context'))) {
        find('deploy.subject-custom', repo, `uses a custom OIDC subject template whose claims (${(Array.isArray(subject.include_claim_keys) ? subject.include_claim_keys : []).join(', ') || 'none'}) leave out \`context\`, so the environment isn't in a deploy job's subject, and a role that trusts \`…:environment:<name>\` can't tell a job inside the environment from one outside it (plan 0010 §5).`, {
          text: `Go back to the default template, or add \`context\` to the template's claims:`,
          commands: [`gh api -X PUT repos/${repo}/actions/oidc/customization/sub -F use_default=true`],
        });
      }
      // ── `deploy.trust-unproven`: the probe's line, from the latest run of the caller that counts.
      const unproven = (/** @type {string} */ message, /** @type {boolean} */ note, /** @type {string[]} */ commands = []) => find('deploy.trust-unproven', own ?? DEPLOY_CALLER_PATH, message, {
        text: note && deployFallback === 'no-environments' ? `Nothing to do on a plan without environments: nothing outside an environment can be proved where no job is inside one.` : `Make each environment's role trust only its own subject, \`…:environment:<name>\`, and let the deploy hook find each role from outside its environment (docs/lanes.md, "The trust probe"); the next release's run proves it, or dispatch the caller at a release's tag:`,
        commands,
      }, note);
      const dispatch = `gh workflow run ${basename(own ?? DEPLOY_CALLER_PATH)} -R ${repo} --ref <tag> -f release=<tag>`;
      if (deployFallback === 'no-environments') {
        unproven(`The lane skips the trust probe under the \`no-environments\` fallback: every role trusts the release tags' subject, which the probe's own job carries, so nothing proves that a job outside an environment is refused. Weaker, as the record states (plan 0010 §5, §13).`, true);
      } else if (own) {
        const name = basename(own);
        const listed = await deps.gh(['api', `repos/${repo}/actions/workflows/${name}/runs?status=completed&per_page=${DEPLOY_RUNS}`]);
        const runs = ghJsonOf(listed)?.workflow_runs;
        /** @type {{ run: any, said: Record<string, unknown> | null } | null} */
        let latest = null;
        /** @type {string | null} */
        let blind = Array.isArray(runs) || /HTTP 404|Not Found/i.test(listed.stderr) ? null : `the token can't list ${name}'s runs (${listed.stderr.trim() || `exit ${listed.status}`}); it needs Actions: read`;
        for (const run of Array.isArray(runs) ? runs : []) {
          if (blind || latest) break;
          const counts = await deployRunCounts(run);
          if (typeof counts === 'string') { blind = counts; break; }
          if (!counts) continue;
          const jobs = ghJsonOf(await deps.gh(['api', `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`]))?.jobs;
          if (!Array.isArray(jobs)) { blind = `the token can't list the jobs of ${run.html_url}; it needs Actions: read`; break; }
          const job = jobs.find((j) => isMap(j) && (j.name === 'probe' || String(j.name).endsWith(' / probe')) && (j.conclusion === 'success' || j.conclusion === 'failure'));
          if (!job) continue;
          const path = `repos/${repo}/actions/jobs/${job.id}/logs`;
          let log = await deps.gh(['api', '--allow-escape-sequences', path]);
          if (log.status !== 0 && /unknown flag/.test(log.stderr)) log = await deps.gh(['api', path]);
          if (log.status !== 0) { blind = `the token can't read the log of the probe job of ${run.html_url}, which needs Actions: read (${log.stderr.trim() || `exit ${log.status}`})`; break; }
          latest = { run, said: probeAnswer(log.stdout) };
        }
        if (blind) unchecked.push({ check: 'deploy-runs', subject: own, reason: blind });
        else if (!latest) {
          unproven(`No run of ${own} that counts has probed the environments yet: a \`release\` run, or a dispatch at a release's tag, of this repository, on a commit of ${s.defaultBranch}. Until one does, nothing shows that each environment's role refuses a job outside it (plan 0010 §5). It blocks once the lane has run.`, true, [dispatch]);
        } else {
          const said = latest.said;
          const where = `${latest.run.html_url} (${latest.run.event === 'release' ? 'a release' : 'a dispatch'} at ${String(latest.run.head_branch)}, ${String(latest.run.created_at ?? '').slice(0, 10)})`;
          const keys = said ? Object.keys(said).sort() : [];
          const missing = chain.filter((e) => !keys.includes(e));
          const extra = keys.filter((e) => !chain.includes(e));
          const notRefused = chain.filter((e) => keys.includes(e) && said?.[e] !== 'refused');
          if (!said) unproven(`The probe job of ${where}, the latest run that counts, printed no ${PROBE_LINE} line doctor can read, so nothing shows that each environment's role refuses a job outside it (plan 0010 §5).`, false, [`gh run view ${latest.run.id} -R ${repo} --log`]);
          else if (missing.length || extra.length || notRefused.length) {
            unproven(`The probe of ${where}, the latest run that counts, said ${JSON.stringify(said)}: ${[
              ...(notRefused.length ? [`${notRefused.join(', ')} ${notRefused.length > 1 ? 'were' : 'was'} not refused`] : []),
              ...(missing.length ? [`${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} declared and unproven, added since that run`] : []),
              ...(extra.length ? [`it probed ${extra.join(', ')}, which the declaration no longer names`] : []),
            ].join('; ')}. The probe must answer exactly the declared environments, each refused (plan 0010 §5).`, false, [`gh run view ${latest.run.id} -R ${repo} --log`, dispatch]);
          }
        }
      }
      // ── `deploy.secret-repository` (a note, kanon#1049): the caller maps the deploy hook's
      // secret as `${{ secrets.NAME }}`, which GitHub evaluates in the deploy job's scope, the
      // environment's first, then the repository's. An environment that holds none then hands the
      // hook a repository secret of that name, which any workflow of any branch can also read.
      if (own && s.secrets) {
        for (const name of deployEnvironmentSecrets(req).filter((n) => s.secrets?.has(n))) {
          find('deploy.secret-repository', name, `is a repository secret: the deploy caller maps ${name} by name, which GitHub resolves in each deploy job from the environment first, then the repository, so a declared environment that holds no ${name} hands the deploy hook this one, which every workflow on every branch can read (plan 0010 §7, §15.1). Keep it an environment secret only.`, {
            text: `Move it into each environment that needs it, then delete the repository secret:`,
            commands: [...chain.map((e) => `gh secret set ${name} --env ${e} -R ${repo}`), `gh secret delete ${name} -R ${repo}`],
          });
        }
      }
      // ── `deploy.secret-organization` (a note, kanon#1051): after the repository's, GitHub
      // resolves the name from the organisation's secrets shared with the repository, which
      // every workflow of every repository they are shared with can read. Noted whether or not
      // the repository holds one too: `deploy.secret-repository`'s fix deletes that one.
      const deploySecrets = own && s.kind === 'Organization' ? deployEnvironmentSecrets(req) : [];
      const org = deploySecrets.length ? await orgSecrets() : null;
      for (const name of deploySecrets) {
        if (org === null) unchecked.push({ check: 'deploy-secrets', subject: name, reason: `the token can't list the organisation secrets of ${s.owner} shared with ${repo}, so doctor can't tell whether an organisation secret of ${s.owner} shared with it is named ${name}, which a deploy job whose environment holds none would hand the deploy hook; it needs Secrets: read` });
        else if (org.has(name)) {
          find('deploy.secret-organization', name, `is an organisation secret of ${s.owner} shared with ${repo}: the deploy caller maps ${name} by name, which GitHub resolves in each deploy job from the environment first, then the repository, then the organisation, so a declared environment that holds no ${name} hands the deploy hook this one, which every workflow on every branch of every repository it is shared with can read (plan 0010 §7, §15.1). Keep it an environment secret only.`, {
            text: `Move it into each environment that needs it, then stop sharing ${s.owner}'s ${name} with ${repo}: on the organisation's Actions secrets page, narrow its repository access to the repositories that need it, or delete it if none does.`,
            commands: chain.map((e) => `gh secret set ${name} --env ${e} -R ${repo}`),
            url: `https://github.com/organizations/${s.owner}/settings/secrets/actions`,
          });
        }
      }
      // ── `deploy.artifact-retention` (a note): the artifact must outlive a production approval.
      const kept = await deps.gh(['api', `repos/${repo}/actions/permissions/artifact-and-log-retention`]);
      const days = Number(ghJsonOf(kept)?.days);
      if (!Number.isFinite(days)) unchecked.push({ check: 'deploy-retention', subject: repo, reason: `the token can't read ${repo}'s artifact retention (${kept.stderr.trim() || `exit ${kept.status}`}); it needs Administration: read` });
      else if (days < 30) {
        find('deploy.artifact-retention', repo, `keeps artifacts ${days} days, which caps the build's 35: a production job may wait up to 30 days for its reviewer, and fails at the build stage, by name, once its artifact has expired (plan 0010 §4).`, {
          text: `Raise the repository's artifact retention to at least 30 days, under Settings, Actions, General:`,
          commands: [`gh api -X PUT repos/${repo}/actions/permissions/artifact-and-log-retention -F days=35`],
        });
      }
      // ── `deploy.tag-ruleset`: who may create, move or delete a release tag. A note, but a
      // block under `no-reviewers`, where it is what guards production's tag path (§13).
      const tagRules = await deps.gh(['api', `repos/${repo}/rulesets?includes_parents=true&per_page=100`]);
      const listedRules = ghJsonOf(tagRules);
      const noRulesets = /upgrade to github pro|make this repository public/i.test(tagRules.stderr);
      if (!Array.isArray(listedRules) && !noRulesets) unchecked.push({ check: 'deploy-rulesets', subject: repo, reason: `the token can't read ${repo}'s rulesets (${tagRules.stderr.trim() || `exit ${tagRules.status}`})` });
      else {
        let restricted = false;
        for (const r of (Array.isArray(listedRules) ? listedRules : []).filter((x) => isMap(x) && x.target === 'tag')) {
          const whole = ghJsonOf(await deps.gh(['api', `repos/${repo}/rulesets/${r.id}`]));
          if (restrictsTags(whole)) { restricted = true; break; }
        }
        if (!restricted) {
          const blocks = deployFallback === 'no-reviewers';
          find('deploy.tag-ruleset', repo, blocks
            ? `has no active tag ruleset restricting who may create, move and delete the release tags. Under the \`no-reviewers\` fallback no reviewer stands in front of production, so a release tag is an admitted ref to its secret and its role for any workflow that names the environment: whoever creates or moves one deploys (plan 0010 §13, §15.1).`
            : deployFallback === 'no-environments'
              ? `has no tag ruleset restricting who may create, move and delete the release tags${noRulesets ? ', and its plan offers none' : ''}. Under the \`no-environments\` fallback any workflow at a release tag reaches every role, so the tag path stays open: weaker, as the record states (plan 0010 §13).`
              : `has no active tag ruleset restricting who may create, move and delete the release tags (creation, update and deletion); a ruleset that restricts creation alone leaves moving a tag onto another commit open (plan 0010 §12).`, {
            text: noRulesets ? (blocks ? `The plan offers no rulesets: make the repository public, or move to a plan with them, then add a tag ruleset on the release tags' pattern with the creation, update and deletion rules.` : `Nothing to do on a plan without rulesets.`) : `Add a tag ruleset on the release tags' pattern with the creation, update and deletion rules, letting the Releaser and the Maintainer bypass it:`,
            url: `https://github.com/${repo}/settings/rules`,
          }, false, blocks);
        }
      }
    }
  }

  // ── The id-token holders ────────────────────────────────────────────────────────────────────
  const record = readHolderAcceptances(read(ADOPTION_RECORD));
  for (const e of record.errors) find('declaration.malformed', ADOPTION_RECORD, e, { text: `Write each acceptance under ## Choices as \`- **${HOLDER_LABEL}:** \`<workflow>.yml\` job \`<job>\` (<why it holds the grant>)\` (K-LAYOUT-10).` });
  const holders = idTokenHolders({ workflows, accepted: record.accepted, pinned: (ref) => ref === pinned, req });
  // An acceptance is used when its job still holds the grant, a Kanon lane's caller among them.
  const used = new Set(holders.map((h) => `${h.workflow.slice('.github/workflows/'.length)}#${h.job}`).filter((key) => record.accepted.has(key)));
  for (const h of holders.filter((x) => x.status === 'unaccepted')) {
    const u = unacceptedHolder(h, s.defaultBranch);
    find('id-token.unaccepted', u.subject, u.message, u.fix);
  }
  for (const key of record.accepted.keys()) {
    if (used.has(key) || unchecked.some((u) => u.check === 'workflow' && u.subject === `.github/workflows/${key.split('#')[0]}`)) continue;
    const [wfFile, job] = key.split('#');
    find('id-token.stale-acceptance', ADOPTION_RECORD, `accepts ${wfFile}'s job ${job} as an id-token holder, but no such job holds the grant.`, { text: `Remove the bullet, so the record says only what is true.` });
  }
  // ── Where the Overseer's upstream findings go (`K-LAYOUT-10`, kanon#423) ──────────────────────
  // The lane reads it from the default branch and stops before its agent on a malformed one; this
  // names it first, from the checkout, as lane-check does.
  const recordText = read(ADOPTION_RECORD);
  if (recordText !== null) {
    try {
      parseUpstreamFindings(recordText);
      // `sent` and `sent with evidence` travel over the telemetry channel (plan 0006 §3.1): with
      // no caller of Kanon's collector, nothing is sent, so the record says what isn't true.
      const unsent = unsentMessage(recordText, collectorCallers.length > 0);
      if (unsent) {
        find('upstream.unsent', ADOPTION_RECORD, unsent, {
          text: `Opt in to telemetry, which writes the collector's caller: run \`kanon init --telemetry\` (docs/telemetry.md). Or choose \`drafted\`, which drafts each upstream finding and sends nothing: write this bullet in its place, or remove it for Kanon's default (K-LAYOUT-10).`,
          commands: [`- **${UPSTREAM_LABEL}:** \`drafted\``],
        });
      }
    } catch (e) {
      find('declaration.malformed', ADOPTION_RECORD, /** @type {Error} */ (e).message, { text: 'Write it under ## Choices as `- **Upstream findings:** `filed here`` or `drafted`, `sent` or `sent with evidence`, or remove it for Kanon\'s default, `drafted` (K-LAYOUT-10).' });
    }
    // ── The reference deploy's bullets, moved into `## Deploy` (plan 0010 D2, follow-up decision 1) ──
    // Read from `## Deploy` alone since that release, with no period of reading both places: a
    // bullet left under `## Choices` fails the reconciler and lane-check. Checked for every
    // adopter, chain or none: one that deploys with its own workflow is the likeliest to have them.
    const moved = movedReferenceBullets(recordText);
    if (moved.length) {
      find('deploy.declaration-moved', ADOPTION_RECORD, `${ADOPTION_RECORD} declares the reference deploy under ## Choices, on line${moved.length > 1 ? 's' : ''} ${moved.map((m) => m.line).join(', ')}, but Kanon reads it from ${DEPLOY_HEADING} alone (plan 0010): the reconciler can't close a project, and lane-check fails, until the bullets move (K-LAYOUT-10, K-PROJ-11).`, {
        text: `Move ${moved.length > 1 ? 'these bullets' : 'this bullet'} out of ## Choices into a ${DEPLOY_HEADING} section of ${ADOPTION_RECORD}, after ## Choices (and after ## Data, where the record has it), unchanged, as the upgrade skill does; where the record already has ${DEPLOY_HEADING}, move them under it.`,
        commands: [DEPLOY_HEADING, '', ...moved.map((m) => m.text)],
      });
    }
    // ── Whether the Overseer runs the capability watch (`K-LAYOUT-10`, kanon#477) ─────────────────
    try {
      parseCapabilityWatch(recordText);
    } catch (e) {
      find('declaration.malformed', ADOPTION_RECORD, /** @type {Error} */ (e).message, { text: 'Write it under ## Choices as `- **Capability watch:** `on`` or `off`, or remove it for Kanon\'s default, `off` (K-LAYOUT-10).' });
    }
  }
  // ── The waivers ─────────────────────────────────────────────────────────────────────────────
  // Last, over every finding: one bullet waives one id on one subject, as doctor reported it.
  const waiverRecord = readWaivers(read(ADOPTION_RECORD));
  for (const e of waiverRecord.errors) find('declaration.malformed', ADOPTION_RECORD, e, { text: `Write each waiver under ## Choices as \`- **${WAIVER_LABEL}:** \`<finding id>\` on \`<subject>\` (<why the finding stands>)\`, for a finding that can be waived; for one that lists items, name those it waives before the parentheses, \`for \`<item>\`, \`<item>\`\` (docs/doctor.md).` });
  /** @type {Waived[]} */
  const waived = [];
  const spans = (/** @type {string[]} */ xs) => xs.map((x) => `\`${x}\``).join(', ');
  /** @type {Map<string, typeof waiverRecord.waivers>} the bullets of each finding id on each subject */
  const groups = new Map();
  for (const w of waiverRecord.waivers) groups.set(`${w.id} ${w.subject}`, [...(groups.get(`${w.id} ${w.subject}`) ?? []), w]);
  for (const ws of groups.values()) {
    const { id, subject } = /** @type {(typeof ws)[number]} */ (ws[0]);
    // A finding no waiver waives under the record's fallback marker (plan 0010 §12): the bullet is
    // malformed there, and waives nothing.
    const under = UNWAIVABLE_UNDER[id];
    if (under && under.fallback === deployFallback) {
      for (const w of ws) find('declaration.malformed', ADOPTION_RECORD, `${ADOPTION_RECORD}:${w.line} waives \`${id}\`, which can't be waived under the \`${under.fallback}\` fallback the record declares: ${under.why}.`, { text: `Remove the bullet, and fix the finding (docs/doctor.md, "What can't be waived").` });
      continue;
    }
    const hits = findings.filter((f) => f.id === id && f.subject === subject);
    const category = /** @type {{ category: string }} */ (FINDINGS[id]).category;
    const blind = unchecked.find((u) => u.subject === subject || UNCHECKED_CATEGORY[u.check] === category);
    if (!ITEMIZED[id]) {
      // A finding that lists no items: its one bullet waives it whole.
      const w = /** @type {(typeof ws)[number]} */ (ws[0]);
      for (const f of hits) {
        findings.splice(findings.indexOf(f), 1);
        waived.push({ ...f, items: [], line: w.line, reason: w.reason });
      }
      if (hits.length) continue;
      if (blind) notes.push(`${ADOPTION_RECORD}:${w.line} waives ${id} on ${subject}, which doctor did not report; the ${blind.check} check could not run, so it can't tell whether the waiver is still needed.`);
      else find('waiver.stale', ADOPTION_RECORD, `${ADOPTION_RECORD}:${w.line} waives ${id} on ${subject}, but doctor reports no such finding.`, { text: `Remove the bullet, so the record says only what is true.` });
      continue;
    }
    // A finding that lists items: each bullet waives the items it names, and an item none names
    // stays a finding. A bullet that names none would waive what a later release adds too, so it
    // is malformed and waives nothing; its fix is the bullet to write, from today's items.
    const named = ws.filter((w) => w.items);
    const claimed = new Set(named.flatMap((w) => w.items ?? []));
    const today = [...new Set(hits.flatMap((f) => itemized.get(f)?.items ?? []))].filter((x) => !claimed.has(x));
    for (const w of ws.filter((x) => !x.items)) {
      find('declaration.malformed', ADOPTION_RECORD, `${ADOPTION_RECORD}:${w.line} waives ${id} on ${subject} without naming its items, so it would waive whatever a later release adds to that finding too; it waives nothing until it names them (#406). ${today.length ? `Doctor reports ${today.join(', ')} there today${named.length ? ', besides what the other bullets name' : ''}.` : `Doctor reports no item there today${named.length ? ' that the other bullets don\'t name' : ''}.`}`, today.length
        ? { text: `Name the items the repository keeps after \`for\`, as doctor reports them today, and drop any it doesn't keep (docs/doctor.md, "Waiving a finding"):`, commands: [`- **${WAIVER_LABEL}:** \`${id}\` on \`${subject}\` for ${spans(today)} (${w.reason})`] }
        : { text: `Remove the bullet, or name the items it keeps after \`for\` (docs/doctor.md, "Waiving a finding"):`, commands: [`- **${WAIVER_LABEL}:** \`${id}\` on \`${subject}\` for \`<item>\` (${w.reason})`] });
    }
    /** @type {Map<(typeof ws)[number], Set<string>>} */
    const covered = new Map(named.map((w) => [w, new Set()]));
    for (const f of hits) {
      const items = itemized.get(f)?.items ?? [];
      const takes = /** @type {Array<[(typeof ws)[number], string[]]>} */ (named.map((w) => [w, items.filter((x) => w.items?.includes(x))])).filter(([, t]) => t.length);
      if (!takes.length) continue;
      const keep = items.filter((x) => !claimed.has(x));
      const at = findings.indexOf(f);
      if (keep.length) {
        const rest = remake(f, keep);
        findings.splice(at, 1, { ...rest, message: `${rest.message} ${takes.map(([w, t]) => `${ADOPTION_RECORD}:${w.line} waives ${t.join(', ')}`).join('; ')}, not ${keep.length > 1 ? 'these' : 'this'}.` });
      } else findings.splice(at, 1);
      for (const [w, t] of takes) {
        for (const x of t) covered.get(w)?.add(x);
        waived.push({ ...remake(f, t), items: t, line: w.line, reason: w.reason });
      }
    }
    for (const w of named) {
      const got = /** @type {Set<string>} */ (covered.get(w));
      const gone = (w.items ?? []).filter((x) => !got.has(x));
      if (!gone.length) continue;
      if (blind) notes.push(`${ADOPTION_RECORD}:${w.line} waives ${id} on ${subject} for ${gone.join(', ')}, which doctor did not report; the ${blind.check} check could not run, so it can't tell whether the waiver is still needed.`);
      else if (got.size) find('waiver.stale', ADOPTION_RECORD, `${ADOPTION_RECORD}:${w.line} waives ${id} on ${subject} for ${gone.join(', ')}, but doctor reports no such ${gone.length > 1 ? 'items' : 'item'} there.`, { text: `Remove ${spans(gone)} from the bullet, so the record says only what is true.` });
      else find('waiver.stale', ADOPTION_RECORD, `${ADOPTION_RECORD}:${w.line} waives ${id} on ${subject} for ${gone.join(', ')}, but doctor reports ${hits.length ? `none of ${gone.length > 1 ? 'them' : 'it'} there` : 'no such finding'}.`, { text: `Remove the bullet, so the record says only what is true.` });
    }
  }

  if (branchName !== s.defaultBranch) notes.push(`The id-token holders and the secrets the workflows map are counted on ${onCheckout}, not on ${s.defaultBranch}; the roles trust ${s.defaultBranch}'s jobs, and its workflows are the ones that run, so run it there for their count.`);

  findings.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
  waived.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
  const blocking = findings.some((f) => f.blocking);
  const status = blocking ? 'findings' : unchecked.length ? 'incomplete' : 'healthy';
  return {
    report: {
      schema: SCHEMA,
      kanon: deps.release(),
      repository: repo,
      checkout: { branch: branchName, defaultBranch: s.defaultBranch, head: head.status === 0 ? head.stdout.trim() : null },
      token: { source: who.source, login: who.login },
      releases: { pins: [...pins.keys()].sort(newer), pinned, to: opts.to, checked, stable },
      checking,
      status,
      exitCode: EXIT[status],
      lanes: installed,
      apps: identities.map((id) => ({ identity: id, slug: slugOf.get(id) ?? null })),
      findings,
      waived,
      idTokenHolders: holders,
      unchecked,
      notes,
    },
  };
};

/**
 * THE REQUIRED CHECK'S JOB (#418, L5's G14). A ruleset that requires a status check no job on the
 * default branch reports blocks every pull request but the one that adds the job, approved and
 * green, until that one merges. So before doctor asks the person to require Kanon's check
 * (`ruleset.rule-missing`), a workflow on the default branch must report it on every pull request
 * into that branch, with no trigger filter that skips one (#446); otherwise it asks
 * for the job first, and for the rule only once the job has merged. It asks the same of a ruleset
 * that requires the check already. A job only the checkout has is not on the default branch: it
 * is a branch's, and the rule waits for its merge. Returns the ruleset's gaps still to ask for.
 * @param {{ defaultWorkflows: () => ReturnType<typeof branchWorkflows>, s: Inspection, checked: string, gaps: string[],
 *   checkout: Map<string, Record<string, any>>,
 *   find: (id: string, subject: string, message: string, fix: { text: string, commands?: string[], url?: string | null }) => void,
 *   unchecked: Array<{ check: string, subject: string, reason: string }> }} c
 * @returns {Promise<string[]>}
 */
const checkGaps = async ({ defaultWorkflows, s, checked, gaps, checkout, find, unchecked }) => {
  const gap = requiredCheckGap(LANE_CHECK);
  const required = !gaps.includes(gap);
  const rest = gaps.filter((g) => g !== gap);
  const onDefault = await defaultWorkflows();
  if (onDefault.error !== null) {
    unchecked.push({ check: 'required-check', subject: LANE_CHECK, reason: `could not read the workflows on ${s.defaultBranch} (${onDefault.error}), so doctor can't tell whether a job there reports the status check "${LANE_CHECK}"${required ? '' : ", and doesn't ask you to require it yet"}` });
    return rest;
  }
  // With a merge queue, the queue waits for the check on its own `merge_group` run, so the job must
  // run on that event as well (#459).
  const queue = mergeQueueOn(s.covering);
  const jobs = checkJobs(onDefault.workflows, LANE_CHECK, s.defaultBranch, queue);
  if (jobs.some((j) => !j.filters.length && !j.missing.length)) return gaps;
  const here = checkReporters(checkout, LANE_CHECK, s.defaultBranch, queue);
  const every = queue ? 'every pull request and every queued merge' : 'every pull request';
  const then = required ? 'Until it merges, every other pull request waits on the check.' : `Then require the check: doctor asks for it (ruleset.rule-missing) once the job is on ${s.defaultBranch}.`;
  // A job whose workflow skips some pull requests (#446): GitHub never reports the check on one
  // it skips, so that pull request waits on the check once it is required.
  const filters = [...new Set(jobs.flatMap((j) => j.filters))];
  const filtered = jobs.filter((j) => j.filters.length);
  const skipping = filtered.length ? ` The ${queue ? '' : 'only '}job${filtered.length > 1 ? 's' : ''} there that report${filtered.length > 1 ? '' : 's'} it (${filtered.map((j) => j.job).join(', ')}) run${filtered.length > 1 ? '' : 's'} on some ${queue ? 'runs' : 'pull requests'} only (${filters.join(', ')}), and a ${queue ? 'run' : 'pull request'} ${filtered.length > 1 ? 'they skip' : 'it skips'} never gets the check.` : '';
  // A job whose workflow doesn't run on the merge queue's event (#459).
  const unqueued = jobs.filter((j) => j.missing.length).map((j) => j.job);
  const lacking = unqueued.length ? ` ${unqueued.join(', ')} ${unqueued.length > 1 ? "don't" : "doesn't"} run on merge_group, the event the merge queue on ${s.defaultBranch} runs its checks on, so a queued merge never gets the check and waits on it.` : '';
  const workflowsOf = (/** @type {string[]} */ list) => [...new Set(list.map((j) => j.split('#')[0]))].join(', ');
  const fixes = [...(filters.length ? [`take ${filters.join(', ')} off the workflow's trigger`] : []), ...(unqueued.length ? [`add merge_group to the triggers of ${workflowsOf(unqueued)}`] : [])];
  find('ruleset.check-unreported', LANE_CHECK, required
    ? `The ruleset on ${s.defaultBranch} requires the status check "${LANE_CHECK}", but no job of a workflow on ${s.defaultBranch} reports it on ${every}, so every ${queue ? 'one' : 'pull request'} that doesn't get it waits on it (K-ADOPT-1 step 8).${skipping}${lacking}`
    : `No job of a workflow on ${s.defaultBranch} reports the status check "${LANE_CHECK}" on ${every}, so the ruleset can't require it yet: a required check that nothing reports blocks every pull request (K-ADOPT-1 step 8).${skipping}${lacking}`, {
    text: here.length
      ? `This checkout adds it (${here.join(', ')}): merge the pull request that adds it to ${s.defaultBranch} first. ${then}`
      : jobs.length
        ? `Run the job on ${every}: ${fixes.join(', and ')}, or move the job to a workflow of its own on pull_request${queue ? ' and merge_group' : ''} with no filter, as actions/lane-check's README shows, and merge it. ${then}`
        : `Add a job of its own named "${LANE_CHECK}", in a workflow that runs on pull_request${queue ? ' and merge_group' : ''}, as actions/lane-check's README shows (a step in another job reports nothing under that name), and merge it. ${then}`,
    url: `https://github.com/${KANON_REPO}/blob/${checked}/actions/lane-check/README.md`,
  });
  return rest;
};

/** @typedef {Extract<Awaited<ReturnType<typeof diagnose>>, { report: any }>['report']} Report */

const TITLES = /** @type {Record<string, string>} */ ({ pin: 'Pin', app: 'App', secret: 'Secret', declaration: 'Declaration', caller: 'Caller', label: 'Label', ruleset: 'Ruleset', deploy: 'Deploy', 'id-token': 'id-token' });

/**
 * The report as prose for a person.
 * @param {Report} r
 * @returns {string[]}
 */
export const prose = (r) => {
  const out = [];
  out.push(`Using ${r.token.source === 'gh' ? "gh's stored login" : `the token in ${r.token.source}`}${r.token.login ? `, which belongs to ${r.token.login}` : ''}.`);
  out.push('');
  out.push(`== ${r.repository}: Kanon ${r.releases.pinned} pinned${r.releases.to ? `, checked against ${r.releases.to}` : ''} ==`);
  out.push(`- Lanes called: ${r.lanes.length ? r.lanes.join(', ') : 'none'}.`);
  out.push(`- Apps they run as: ${r.apps.length ? r.apps.map((a) => `${a.identity} (${a.slug ? `\`${a.slug}\`` : 'not in the register'})`).join(', ') : 'none'}.`);
  out.push('');
  if (!r.findings.length) out.push(`Nothing is missing or stale for ${r.checking}.`);
  else {
    out.push(`What ${r.checking} needs, in the order to do it:`);
    r.findings.forEach((f, i) => {
      out.push(`${i + 1}. [${TITLES[f.category] ?? f.category}${f.blocking ? '' : ', not blocking'}] ${f.subject}: ${f.message}`);
      out.push(`   Fix: ${f.fix.text}`);
      if (f.fix.url) out.push(`   ${f.fix.url}`);
      for (const c of f.fix.commands) out.push(`     ${c}`);
    });
  }
  if (r.waived.length) {
    out.push('');
    out.push(`Waived under ## Choices in ${ADOPTION_RECORD}, so they don't count:`);
    for (const w of r.waived) out.push(`- [${TITLES[w.category] ?? w.category}] ${w.id}, ${w.subject}${w.items.length ? ` (${w.items.join(', ')})` : ''}, by ${ADOPTION_RECORD}:${w.line}: ${w.reason}.`);
  }
  out.push('');
  if (!r.idTokenHolders.length) out.push('No job of your workflows holds id-token: write.');
  else {
    out.push('Jobs of your workflows that hold id-token: write:');
    for (const h of r.idTokenHolders) {
      const how = `${h.how === 'write-all' ? 'write-all' : 'id-token: write'}, ${h.grant === 'job' ? 'its own grant' : "the workflow's"}${h.calls ? `, passed to ${h.calls}` : ''}`;
      const verdict = h.status === 'kanon-lane' ? "Kanon's store-coupled lane at the pinned release: accepted" : h.status === 'accepted' ? `accepted in the adoption record: ${h.reason}` : 'NOT ACCEPTED: narrow it, or accept it in the adoption record';
      out.push(`- ${h.workflow}, job ${h.job} (${how}): ${verdict}.`);
    }
  }
  if (r.unchecked.length) {
    out.push('');
    out.push('Not checked:');
    for (const u of r.unchecked) out.push(`- ${u.check}, ${u.subject}: ${u.reason}.`);
  }
  if (r.notes.length) {
    out.push('');
    for (const n of r.notes) out.push(`Note: ${n}`);
  }
  out.push('');
  const blocking = r.findings.filter((f) => f.blocking).length;
  const waivedToo = r.waived.length ? ` ${r.waived.length} finding(s) waived in ${ADOPTION_RECORD}.` : '';
  out.push(
    (r.status === 'healthy'
      ? 'Healthy. doctor wrote nothing.'
      : r.status === 'incomplete'
        ? `Nothing blocking found, but ${r.unchecked.length} check(s) could not run, so health can't be claimed (exit ${r.exitCode}). doctor wrote nothing.`
        : `${blocking} blocking finding(s)${r.findings.length > blocking ? `, ${r.findings.length - blocking} not blocking` : ''} (exit ${r.exitCode}). doctor wrote nothing; kanon init fixes what it can from the checkout.`) + waivedToo,
  );
  return out;
};
