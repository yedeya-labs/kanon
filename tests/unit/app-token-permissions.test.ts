import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * #48, `K-AGENT-46`: every lane step that mints an App token narrows it, with
 * create-github-app-token's `permission-*` inputs, to what that step uses. Without them a
 * token carries the App's whole grant, and whatever an adopter's App holds beyond its role.
 *
 * The lists below ARE the decision, one per minting step, with what the step does that
 * needs each permission. A step that gains or drops one is a red test until its list says
 * so; a new minting step is red until it has a list. Each list must also stay within its
 * role's grant (`rulebook/agent-permissions.json`), or the mint itself fails.
 *
 * An empty `permission-*` input requests nothing, and a mint with no non-empty one gets the
 * whole grant, so the spine's (`agent-lane.yml`) is checked through each lane that calls it.
 */
type Perms = Record<string, string>;
const DIRECT: Record<string, { step: string; perms: Perms }> = {
  // Reads the merged PR's reviews and the tree; files follow-up issues.
  'agent-merge-reconcile.yml': { step: 'app-token', perms: { contents: 'read', issues: 'write', 'pull-requests': 'read' } },
  // Posts and stamps the review, comments, labels, files follow-ups. `contents: write` is the
  // role's so its approval satisfies the ruleset (03-agents.md), so the review keeps it.
  'agent-review.yml': { step: 'app-token', perms: { contents: 'write', issues: 'write', 'pull-requests': 'write' } },
  // Reads the tree and pull requests; files and comments on issues.
  'agent-verify-acs.yml': { step: 'app-token', perms: { contents: 'read', issues: 'write', 'pull-requests': 'read' } },
  // Reads the tree and the pull requests that touched a failing route; files and comments on issues.
  'agent-explore.yml': { step: 'app-token', perms: { contents: 'read', issues: 'write', 'pull-requests': 'read' } },
  // Pushes the split branch, opens its pull request, comments on the issue.
  'agent-lead-split.yml': { step: 'app-token', perms: { contents: 'write', issues: 'write', 'pull-requests': 'write' } },
  // Pushes a merge that can carry the default branch's workflow changes; comments and labels.
  'agent-rebase.yml': { step: 'app-token', perms: { contents: 'write', issues: 'write', 'pull-requests': 'write', workflows: 'write' } },
  // The round record reads the pull request and comments on it, which either permission allows.
  'agent-lead-revise.yml': { step: 'round-app-token', perms: { issues: 'write', 'pull-requests': 'write' } },
  'agent-implement-revise.yml': { step: 'round-app-token', perms: { issues: 'write', 'pull-requests': 'write' } },
  // The Merger's whole grant, which `merge-gate.mjs` uses: it merges, comments and labels,
  // re-dispatches the review lane, and reads the head's check runs and status contexts.
  'agent-merge.yml': { step: 'app-token', perms: { contents: 'write', issues: 'write', 'pull-requests': 'write', actions: 'write', checks: 'read', statuses: 'read' } },
  // The reconcile files, edits, labels, comments on and closes issues; the re-deliveries churn
  // labels on pull requests; the deploy probe and the recoveries read Actions; the reconcile
  // and the probe read the repository's files.
  'agent-lead-reconcile.yml': { step: 'app-token', perms: { contents: 'read', issues: 'write', 'pull-requests': 'write', actions: 'read' } },
  // The crash recovery adds one label to the issue.
  'agent-implement.yml': { step: 'app-token', perms: { issues: 'write' } },
  // The dispatch sweep comments on, labels and re-labels issues, lists the pull requests that
  // close them, and reads the run behind each cost row, and the run artifacts without a store.
  'agent-dispatch-sweep.yml': { step: 'app-token', perms: { issues: 'write', 'pull-requests': 'read', actions: 'read' } },
  // The code audit reads the tree, and searches, files and comments on issues.
  'agent-code-audit.yml': { step: 'app-token', perms: { contents: 'read', issues: 'write' } },
};
/** Each lane that calls the spine, and the token its agent gets there. */
const SPINE_CALLERS: Record<string, Perms> = {
  // Implement, triage and revise push code (workflow files included), open and comment.
  'agent-implement.yml': { contents: 'write', issues: 'write', 'pull-requests': 'write', workflows: 'write' },
  'agent-triage.yml': { contents: 'write', issues: 'write', 'pull-requests': 'write', workflows: 'write' },
  'agent-implement-revise.yml': { contents: 'write', issues: 'write', 'pull-requests': 'write', workflows: 'write' },
  // The brief's author pushes its branch and opens the pull request.
  'agent-lead.yml': { contents: 'write', issues: 'write', 'pull-requests': 'write' },
  // The brief's reviser also reads the failed runs it is answering.
  'agent-lead-revise.yml': { contents: 'write', issues: 'write', 'pull-requests': 'write', actions: 'read' },
};
/** Minting steps outside the lanes, and why each is exempt. */
const EXEMPT: Record<string, string> = {
  // A by-hand check of each App's installation, one role per matrix row: it reads the whole
  // grant by the App's JWT, and its token only lists the repositories it is installed on.
  'apps-check.yml': 'not a lane',
};
const SPINE = 'agent-lane.yml';
const PERMISSIONS = ['contents', 'issues', 'pull-requests', 'workflows', 'actions'];

const root = fileURLToPath(new URL('../../', import.meta.url));
type Step = { id?: string; uses?: string; with?: Record<string, unknown> };
type Job = { uses?: string; with?: Record<string, unknown>; secrets?: Record<string, string>; steps?: Step[] };
type Doc = { jobs?: Record<string, Job>; runs?: { steps?: Step[] } };
const read = (file: string) => parse(readFileSync(join(root, file), 'utf8')) as Doc;
const yamls = [
  ...readdirSync(join(root, '.github/workflows')).map((f) => `.github/workflows/${f}`),
  ...readdirSync(join(root, 'actions'), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile()).map((e) => relative(root, join(e.parentPath, e.name))),
].filter((f) => /\.ya?ml$/.test(f));

const mints = yamls.flatMap((file) => {
  const doc = read(file);
  return [...Object.values(doc.jobs ?? {}).flatMap((j) => j.steps ?? []), ...(doc.runs?.steps ?? [])]
    .filter((s) => String(s.uses ?? '').startsWith('actions/create-github-app-token@'))
    .map((step) => ({ file, name: file.split('/').pop()!, step }));
});
const requested = (w: Record<string, unknown> = {}): Perms =>
  Object.fromEntries(Object.entries(w).filter(([k, v]) => k.startsWith('permission-') && String(v ?? '') !== '')
    .map(([k, v]) => [k.slice('permission-'.length), String(v)]));
const grants = (JSON.parse(readFileSync(join(root, 'rulebook/agent-permissions.json'), 'utf8')) as {
  roles: Record<string, { permissions: Perms }>;
}).roles;
/** The role whose App the step mints, from the secret it passes (`<ROLE>_APP_ID`). */
const roleOf = (clientId: unknown) => /secrets\.([A-Z]+)_APP_ID\b/.exec(String(clientId))?.[1]?.toLowerCase();
const withinGrant = (role: string | undefined, perms: Perms) => {
  const grant = grants[role ?? ''];
  expect(grant, `no role ${role} in agent-permissions.json`).toBeTruthy();
  for (const [k, v] of Object.entries(perms)) {
    const held = grant!.permissions[k.replace(/-/g, '_')];
    expect(held === 'write' || held === v, `${role} holds ${k}: ${held ?? 'none'}, asked for ${v}`).toBe(true);
  }
};

describe('every token a lane mints is narrowed to what its step uses (#48, K-AGENT-46)', () => {
  it('finds every minting step, and each one has a list or an exemption', () => {
    expect(mints.length).toBeGreaterThanOrEqual(10);
    const unlisted = mints.filter(({ name, step }) =>
      !(name in EXEMPT) && name !== SPINE && DIRECT[name]?.step !== step.id);
    expect(unlisted.map(({ file, step }) => `${file}#${step.id}`)).toEqual([]);
    for (const [name, { step }] of Object.entries(DIRECT)) {
      expect(mints.some((m) => m.name === name && m.step.id === step), `${name}#${step} mints nothing`).toBe(true);
    }
  });

  it.each(Object.entries(DIRECT))('%s requests exactly its list, within its role', (name, { step, perms }) => {
    const mint = mints.find((m) => m.name === name && m.step.id === step)!;
    expect(requested(mint.step.with)).toEqual(perms);
    withinGrant(roleOf(mint.step.with?.['client-id']), perms);
  });

  it('the spine passes every permission input through to its mint, and nothing else', () => {
    const spine = mints.filter((m) => m.name === SPINE);
    expect(spine).toHaveLength(1);
    const w = spine[0]!.step.with ?? {};
    expect(Object.keys(w).filter((k) => k.startsWith('permission-')).sort()).toEqual(PERMISSIONS.map((p) => `permission-${p}`).sort());
    for (const p of PERMISSIONS) expect(String(w[`permission-${p}`])).toBe(`\${{ inputs.permission-${p} }}`);
  });

  it('every lane that calls the spine is listed', () => {
    const callers = yamls.filter((f) => Object.values(read(f).jobs ?? {}).some((j) => String(j.uses ?? '').endsWith(`/${SPINE}`)));
    expect(callers.map((f) => f.split('/').pop()).sort()).toEqual(Object.keys(SPINE_CALLERS).sort());
  });

  it.each(Object.entries(SPINE_CALLERS))('%s narrows the spine\'s token to its list, within its role', (name, perms) => {
    const jobs = Object.values(read(`.github/workflows/${name}`).jobs ?? {}).filter((j) => String(j.uses ?? '').endsWith(`/${SPINE}`));
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(requested(job.with)).toEqual(perms);
      withinGrant(roleOf(job.secrets?.['app-id']), perms);
    }
  });
});
