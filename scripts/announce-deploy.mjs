// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
/**
 * Broadcast a categorized digest of release-please notes to the stakeholder
 * Slack channel when a deploy actually lands — all releases since the last
 * announcement are merged into one Features/Fixes/Maintenance summary rather
 * than dumped verbatim. Run by .github/workflows/announce-deploy.yml, which
 * the /deploy runbook dispatches after its smoke test passes — deploys are
 * manual (local `sst deploy`), so CI can't observe them on its own.
 *
 * Announces every non-draft release newer than the ANNOUNCED_<STAGE>_VERSION
 * repo variable up to (and including) the deployed version, as one Slack
 * message, then advances the variable. First run (variable absent) announces
 * only the deployed version's release — never the whole history.
 *
 * Dependency-free (Node 20+: global fetch) so it can be exercised locally,
 * exactly as CI runs it:
 *   GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=<owner>/<repo> \
 *   STAGE=staging VERSION=0.1.6 DRY_RUN=1 node scripts/announce-deploy.mjs
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, STAGE, VERSION (deployed semver,
 * leading v ok), SHA (optional, message footer), SLACK_RELEASE_WEBHOOK,
 * DRY_RUN (print instead of posting/updating the variable).
 */

const {
  GITHUB_TOKEN,
  GITHUB_REPOSITORY: repo,
  STAGE: stage = 'staging',
  VERSION,
  SHA,
  SLACK_RELEASE_WEBHOOK: webhook,
  DRY_RUN,
} = process.env;

if (!GITHUB_TOKEN || !repo || !VERSION) {
  console.error('Missing required env: GITHUB_TOKEN, GITHUB_REPOSITORY, VERSION');
  process.exit(1);
}
if (!webhook && !DRY_RUN) {
  // Graceful no-op so deploys don't fail before the Slack app exists.
  console.warn('SLACK_RELEASE_WEBHOOK not set — skipping announcement.');
  process.exit(0);
}

const API = `https://api.github.com/repos/${repo}`;
const HEADERS = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function gh(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...HEADERS, ...init.headers } });
  if (!res.ok && res.status !== 404) {
    throw new Error(`GitHub ${init.method ?? 'GET'} ${path} → ${res.status}: ${await res.text()}`);
  }
  return res;
}

/** Numeric semver compare on 'v0.1.6'-style tags (release-please never emits prereleases here). */
const parts = (v) => v.replace(/^v/, '').split('.').map(Number);
function cmp(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

// Pure release-note → Slack mrkdwn helpers, shared with the weekly digest (RA-502)
// so the two posts can't categorise the same commit differently.
// Unit-tested in tests/library/release-notes.test.ts.
import {
  parseSections,
  scopeOf,
  classify,
  renderList,
  renderMaint,
} from './lib/release-notes.mjs';

const version = VERSION.replace(/^v/, '');
const varName = `ANNOUNCED_${stage.toUpperCase()}_VERSION`;

// Last announced version (absent on first run).
const varRes = await gh(`/actions/variables/${varName}`);
const last = varRes.status === 404 ? null : (await varRes.json()).value;

// Releases ≤ deployed version and > last announced (first run: deployed only).
const releases = await (await gh('/releases?per_page=100')).json();
const toAnnounce = releases
  .filter((r) => !r.draft && !r.prerelease)
  .filter((r) => cmp(r.tag_name, version) <= 0)
  .filter((r) => (last ? cmp(r.tag_name, last) > 0 : cmp(r.tag_name, version) === 0))
  .sort((a, b) => cmp(a.tag_name, b.tag_name));

if (toAnnounce.length === 0) {
  console.log(`Nothing new to announce (deployed ${version}, last announced ${last ?? 'never'}).`);
  process.exit(0);
}

// Merge every release's bullets into three buckets for a single digest.
const features = [];
const fixes = [];
const maint = [];
for (const r of toAnnounce) {
  for (const [heading, bullets] of Object.entries(parseSections(r.body || ''))) {
    for (const raw of bullets) {
      const bucket = classify(heading, scopeOf(raw));
      (bucket === 'feature' ? features : bucket === 'fix' ? fixes : maint).push(raw);
    }
  }
}

const versions = toAnnounce.map((r) => r.tag_name);
const tags = versions.join(', ');
const isRange = versions.length > 1;
const subject = isRange
  ? `${versions[0]} → ${versions.at(-1)} (${versions.length} releases)`
  : versions[0];

let text =
  `:rocket: *${subject} ${isRange ? 'now live' : 'is now live'} on ${stage}*` +
  (SHA ? ` _(build ${SHA})_` : '') +
  '\n';
text += renderList('Features', features);
text += renderList('Fixes', fixes);
text += renderMaint(maint);
text += `\nFull notes: <https://github.com/${repo}/releases>`;

if (text.length > 12000) {
  text = `${text.slice(0, 11800)}\n… _truncated — full notes: <https://github.com/${repo}/releases>_`;
}

if (DRY_RUN) {
  console.log(`DRY RUN — would announce ${tags} (last announced: ${last ?? 'never'}), then set ${varName}.`);
  console.log('--- Slack message ---\n' + text);
  process.exit(0);
}

const slack = await fetch(webhook, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text }),
});
if (!slack.ok) throw new Error(`Slack webhook → ${slack.status}: ${await slack.text()}`);
console.log(`Announced ${tags} to Slack.`);

// Advance the marker only after the post succeeded.
const newest = toAnnounce[toAnnounce.length - 1].tag_name.replace(/^v/, '');
const body = JSON.stringify({ name: varName, value: newest });
const update = await gh(`/actions/variables/${varName}`, { method: 'PATCH', body });
if (update.status === 404) await gh('/actions/variables', { method: 'POST', body });
console.log(`${varName} → ${newest}`);
