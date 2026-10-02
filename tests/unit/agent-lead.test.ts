import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { callsSpine, jobPrompt, spineJobFor } from './helpers/spine.js';

/**
 * RA-951 — the Lead's brief mode.
 *
 * The prompt is the artifact here, and prompts are not unit-testable. What IS
 * testable is the envelope around it: that nothing but a human can start it, that
 * it cannot acquire authority it was not granted, and that a missing permission
 * fails loudly. Those are the properties that would let a brief-authoring agent
 * turn into something else without anyone deciding to.
 */

const wf = parse(readFileSync(join(process.cwd(), '.github/workflows/agent-lead.yml'), 'utf8'));
// Since RA-2609 the lane's one job CALLS the spine (`agent-lane.yml`), so its prompt is an
// input and its steps are the spine's, resolved for THIS lane's inputs — a step another
// caller switches off is not one this lane runs, and one this lane switches on is.
const prompt: string = jobPrompt(wf.jobs.brief);
const brief = spineJobFor(wf.jobs.brief);
// BY IDENTITY, not position (RA-960). `.at(-1)` resolved correctly only while the
// agent step happened to be last: append a step — an upload, a cleanup — and every
// assertion below silently moves onto the wrong object and fails about the wrong
// thing. The agent step is the one carrying a `prompt`, which is what these actually
// mean.
const agentStep = brief.steps.find((s) => s.with?.prompt) as { with: Record<string, string> };
const stepNames = brief.steps.map((s) => s.name ?? s.uses ?? s.run ?? '');

describe('trigger surface', () => {
  it('can only be started by a human', () => {
    // No `issues`, no `pull_request`, no `schedule`. An App-token event cascade is
    // what makes MODE: reconcile self-driving (§5.4) — and that mode is explicitly
    // not built here, so nothing should be able to fire this but a dispatch.
    //
    // A KANON LANE (plan 0001 step 5) is called, never triggered, so the caller holds the
    // trigger and this file can't refuse another one by omission any more: the filter
    // job admits a dispatch alone, and the spine's job waits for its membership gate.
    expect(Object.keys(wf.on)).toEqual(['workflow_call']);
    expect(wf.jobs.filter.if).toBe("github.event_name == 'workflow_dispatch'");
    expect(wf.jobs.brief.needs).toBe('filter');
    expect(wf.jobs.brief.if).toBe("needs.filter.outputs.member == 'true'");
    expect(Object.keys(wf.on.workflow_call.inputs).sort()).toEqual(['context', 'mandate']);
  });

  it('serialises runs so two briefs cannot race', () => {
    expect(wf.concurrency.group).toBe('agent-lead-brief');
    expect(wf.concurrency['cancel-in-progress']).toBe(false);
  });

  it('keeps the default token minimal and carries scope on the App token', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    // The spine declares no `permissions:` (RA-2592), so this block is still the whole
    // default-token grant — a job-level one on the caller would be a second place.
    expect(wf.jobs.brief.permissions).toBeUndefined();
    expect(agentStep.with.github_token).toContain('app-token');
  });

  it('mints as the Lead — its App, not another arm’s', () => {
    // The spine mints from whatever the caller hands it, so the identity is decided HERE.
    expect(wf.jobs.brief.secrets).toEqual({
      'app-id': '${{ secrets.LEAD_APP_ID }}',
      'app-private-key': '${{ secrets.LEAD_APP_PRIVATE_KEY }}',
      'claude-token': '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}',
    });
  });
});

describe('the spine runs what this lane ran before it was converted (RA-2609)', () => {
  it('calls the spine rather than carrying its own copy', () => {
    expect(callsSpine(wf.jobs.brief)).toBe(true);
  });

  it('keeps the timeout, the arm and the telemetry name', () => {
    expect(brief.inputs['timeout-minutes']).toBe(100);
    expect(brief.inputs.agent).toBe('lead');
    expect(brief.inputs.arm).toBe('lead agent');
    // No issue and no PR: a brief is dispatched from a mandate, and the row said so.
    expect(brief.inputs['issue-number']).toBe('');
    expect(brief.inputs['pr-number']).toBe('');
  });

  it('checks out the triggering commit with full history, as its own checkout did', () => {
    expect(brief.inputs.ref).toBe('');
    expect(brief.inputs['fetch-depth']).toBe(0);
  });

  it('adds no database, no browser and no switch it never had', () => {
    // A brief is prose. The spine defaults both on; this lane must turn both off.
    expect(brief.services).toEqual({});
    expect(stepNames).not.toContain('npm run db:init');
    expect(stepNames).not.toContain('Point the job at its database');
    // Since RA-2694 the database's app role, the browser, the failures-only switch, the
    // starting map and the slug assertion are project-setup hook steps keyed on this
    // lane's switches and name — resolved here as the lane runs them, not as inputs.
    expect(stepNames).not.toContain("Point the app role at the lane's database");
    expect(stepNames).not.toContain("Install Playwright's Chromium");
    expect(stepNames).not.toContain('Print failures only on the implementer lanes');
    expect(stepNames).not.toContain('Write the starting map');
    expect(stepNames).not.toContain('Assert the minted App is the one the pipeline expects');
    expect(brief.inputs['prompt-cache-ttl']).toBe('');
    expect(brief.inputs['quality-pr-label']).toBe('');
  });
});

describe('the permission probe', () => {
  // The probe is the spine's since RA-2609, switched on by this lane's `push-probe`.
  const probe = brief.steps.find((s) => s.name?.includes('Probe that the App can push')) as { name: string; run: string; if?: string };

  it('is switched on for this lane, and off for a lane that does not ask for it', () => {
    expect(probe, 'the lead lane no longer runs the push probe').toBeDefined();
    expect(wf.jobs.brief.with['push-probe']).toBe(true);
    // Default OFF: a lane converted later must not start probing (and failing) on a
    // grant it never needed. `lead-revise` pushes too, but never had the probe.
    const revise = parse(readFileSync(join(process.cwd(), '.github/workflows/agent-lead-revise.yml'), 'utf8'));
    expect(spineJobFor(revise.jobs.revise).steps.map((s) => s.name ?? '')).not.toContain(probe.name);
  });

  it('probes the capability instead of asking the API about it', () => {
    // The first version read `/installation/repositories` -> `.permissions`, which
    // is the COLLABORATOR set (admin/maintain/push/triage/pull) and never contains
    // `contents` or `pull_requests` — so it failed closed on every dispatch and the
    // workflow could not reach the agent at all. Same defect class as RA-929's
    // `repository.nameWithOwner`: a guard written against a field that does not
    // exist. A dry-run push negotiates over receive-pack, which requires write, so
    // it tests the real thing and creates nothing.
    expect(probe.run).toContain('git push --dry-run');
    expect(probe.run).not.toContain('installation/repositories');
  });

  it('runs before a single turn of reasoning is paid for', () => {
    // A 403 on push 90 turns in costs the whole run, and reads identically to "the
    // agent had nothing to say" — silent-absence (RA-946) in the newest component.
    const at = stepNames.findIndex((n) => n.includes('Probe that the App can push'));
    const claude = stepNames.findIndex((n) => n.includes('claude-code-action'));
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(claude);
    // After the project setup since RA-2694 (Kanon plan 0001 §5: the hook runs after the
    // checkout and BEFORE `agent-setup`, whose step this is): the one ordering the hook
    // boundary changes. It still fails before any turn, now one install later.
    expect(stepNames.indexOf('npm ci')).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(stepNames.indexOf('npm ci'));
    // After the App-token checkout, or it probes the default token's credential.
    expect(at).toBeGreaterThan(stepNames.findIndex((n) => n.startsWith('actions/checkout')));
  });

  it('fails the job with a readable message rather than warning', () => {
    expect(probe.run).toContain('::error');
    expect(probe.run).toContain('exit 1');
    // The likeliest cause is a grant made but never accepted, so the message must
    // say so — the settings page can show a scope the installation does not hold.
    expect(probe.run).toContain('re-authorized');
  });

  it('mints before checkout, so the push credential is the App token', () => {
    const checkout = brief.steps.find((s) => s.uses?.startsWith('actions/checkout')) as { with: Record<string, string> };
    expect(stepNames.findIndex((n) => n === 'Mint App token'))
      .toBeLessThan(stepNames.findIndex((n) => n.startsWith('actions/checkout')));
    expect(checkout.with.token).toBe('${{ steps.app-token.outputs.token }}');
  });
});

describe('the prompt withholds authority it must not have', () => {
  it('forbids merging, and says a human merges', () => {
    expect(prompt).toMatch(/NEVER merge/);
  });

  it('forbids creating the issues it proposes', () => {
    // The brief PROPOSES a decomposition; a human approves before anything is filed.
    // Filing first would make the gate retrospective.
    expect(prompt).toMatch(/Do NOT create the issues you propose/);
  });

  it('forbids self-promoting an invariant to [confirmed]', () => {
    // §6.1: approving a brief is agreeing to the PLAN; confirming behaviour is a
    // separate, later act. This is the oracle-laundering guard.
    expect(prompt).toMatch(/lands as `\[seed\]`/);
    expect(prompt).toMatch(/Never write `\[confirmed\]`/);
  });

  it('points at the DERIVED template rather than restating a section list', () => {
    // RA-949 originally forbade a template here, because writing the format from
    // imagination is the failure mode behind every Tier-1 finding in the RA-946 session.
    // Five real briefs later the template exists and was derived from them, so the
    // prompt now POINTS at it — and still does not restate the section list, because a
    // twelfth copy of a rule is how the copies drift (AGENTS.md).
    expect(prompt).toMatch(/docs\/projects\/_template\.md/);
    expect(prompt).toMatch(/§5\.7/);
    expect(prompt).toMatch(/brief-guard\.mjs/);
    expect(prompt).toMatch(/eight\s+required sections/);
  });

  it('tells the Lead that a PR body spells a closing reference differently (RA-1634)', () => {
    // The repo squash-merges with the body as the commit message, where backticks are
    // not syntax — so the safe spelling in the brief FILE closes issues from the PR
    // body. Two briefs hit this before the rule was hoisted out of docs/projects/1291.md.
    expect(prompt).toMatch(/backticks are NOT syntax/);
    expect(prompt).toMatch(/backtick the REFERENCE and not the phrase/);
  });
});

describe('the prompt names each decision with a rule behind it', () => {
  it.each([
    ['AWS cost', /AWS COST delta/],
    ['observability add-or-skip', /OBSERVABILITY: add or skip, WITH A REASON/],
    ['blast radius / bail list', /SCOPE-FIRST BAIL/],
    ['milestone routing', /MILESTONE for each issue/],
    ['reconciliation gaps as issues', /RECONCILIATION GAPS, AS ISSUES/],
    ['what is not in scope', /WHAT IT IS NOT/],
    ['invariant IDs as the ONLY AC form', /`\[PREFIX-N\]` ids with a stable allocation/],
  ])('requires a decision on %s', (_label, re) => {
    expect(prompt).toMatch(re);
  });

  it('requires the brief to state what it did NOT examine', () => {
    // A brief silent on an area reads identically to one that checked it and found
    // nothing. That is the class §12.7 names, applied to the brief itself.
    expect(prompt).toMatch(/STATE WHAT YOU DID NOT EXAMINE/);
    expect(prompt).toMatch(/silent-absence/);
  });

  it('requires evidence to be re-measurable rather than dated', () => {
    // RA-1742: the prompt is what an agent actually executes, so the new contract has to
    // be stated HERE and not only in §5.7. Both halves are pinned — a coordinate is
    // refused, and the header line that used to date one is gone with the machinery
    // that read it.
    expect(prompt).toMatch(/every count carries the command that produces\s+it/);
    expect(prompt).toMatch(/NO `file:line` COORDINATES/);
    expect(prompt).toMatch(/ACCEPTANCE CRITERIA LIVE ONLY IN THE SPEC LAYER/);
    expect(prompt).toMatch(/AIM AT ~300 LINES/);
    expect(prompt).toMatch(/IMMUTABLE ONCE THE DEVELOPER APPROVES IT/);
    expect(prompt).not.toMatch(/DATE THE EVIDENCE/);
  });
});
