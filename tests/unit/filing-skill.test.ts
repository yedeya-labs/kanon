import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { BUCKET_MILESTONES, PLAN_FLAGS, cli } from '../../scripts/issue-triage-defaults.mjs';
import { readFlattened } from './helpers/called-workflow.js';
import { effectiveSteps } from './helpers/spine.js';
import { agentPrompt, agentStep, type WorkflowStep } from './helpers/workflow-step.js';

/**
 * #164, step 2: the filing skill, and the filers moved onto it (`K-WORK-8`: the routing rule has
 * one home, and every filer calls it).
 *
 * The skill, `skills/file-issue/SKILL.md`, is instructions: it tells a filer to ask `plan` in
 * `scripts/issue-triage-defaults.mjs` for the labels and the milestone, and to file with exactly
 * the arguments it prints. Nothing runs those instructions in CI, so this holds them to the
 * command: the skill runs `plan`, passes only flags `plan` takes, reads only fields `plan`
 * prints, and restates none of the routing itself.
 *
 * Each filer moved onto the skill is listed in `MOVED`. Its prompt must send its agent to the
 * skill, and must restate no routing: no bucket's name, no milestone of its own, no
 * gate-candidate rule. A prompt that puts its routing prose back fails here, which is the drift
 * the rule exists to end. The filers not yet moved are left out until their own change moves
 * them, one at a time, as #164's migration order says.
 */
const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const SKILL_PATH = 'skills/file-issue/SKILL.md';
const SKILL_TEXT = read(SKILL_PATH);
const front = parse(/^---\n([\s\S]*?)\n---\n/.exec(SKILL_TEXT)![1]!) as Record<string, unknown>;
const body = SKILL_TEXT.replace(/^---\n[\s\S]*?\n---\n/, '');
const fenced = [...body.matchAll(/^\s*```[a-z]*\n([\s\S]*?)^\s*```$/gm)].flatMap((m) => m[1]!.split('\n').map((l) => l.trim()));

/**
 * The ways a text can restate the routing (`K-WORK-4`, `K-WORK-5`, `K-WORK-10`, `K-WORK-11`), each
 * named. A prompt or a skill that matches none leaves the milestone and the candidacy to `plan`.
 */
const routingRestated =(text: string, { allowGateCandidate = false } = {}): string[] => {
  const flat = text.replace(/\s+/g, ' ');
  const found: string[] = [];
  for (const bucket of BUCKET_MILESTONES) if (flat.includes(bucket)) found.push(`names the bucket "${bucket}"`);
  if (/--milestone\b/.test(flat)) found.push('passes a --milestone of its own');
  if (/\bmilestone\s*:/i.test(flat)) found.push('gives a "Milestone:" line');
  if (/\broadmap milestone\b/i.test(flat)) found.push('rules on roadmap milestones');
  if (!allowGateCandidate && /\bgate-candidate\b/.test(flat)) found.push('names gate-candidate');
  return found;
};

/**
 * The filers moved onto the skill: each lane's caller-facing workflow, the job that files, and
 * the playbook section its prompt sends the agent to, which is part of what the agent reads
 * before it files and so must restate no routing either. `readAs` is the path the prompt names
 * when the file held here is Kanon's baseline, which `agent-setup` copies to that path in a
 * project that keeps no playbook of its own (`K-LAYOUT-17`).
 *
 * The Reviewer and merge-reconcile read the same section, the Reviewer playbook's "Capturing
 * follow-ups" (merge-reconcile through an excerpt cut from it), so each lists both copies of it:
 * Kanon's own, and the baseline a project without one is given.
 */
type Playbook = { path: string; section: string; readAs?: string };
const REVIEWER_PLAYBOOKS: Playbook[] = [
  { path: 'docs/qa/reviewer-playbook.md', section: 'Capturing follow-ups' },
  {
    path: 'rulebook/templates/playbooks/reviewer-playbook.md',
    section: 'Capturing follow-ups',
    readAs: 'docs/qa/reviewer-playbook.md',
  },
];
const MOVED: Array<{ lane: string; workflow: string; job: string; playbooks?: Playbook[] }> = [
  { lane: 'explore', workflow: '.github/workflows/agent-explore.yml', job: 'explore' },
  {
    lane: 'code-audit',
    workflow: '.github/workflows/agent-code-audit.yml',
    job: 'audit',
    playbooks: [{ path: 'docs/qa/explorer-playbook.md', section: 'Code-reading mode' }],
  },
  {
    lane: 'verify-acs',
    workflow: '.github/workflows/agent-verify-acs.yml',
    job: 'verify',
    playbooks: [{
      path: 'rulebook/templates/playbooks/explorer-playbook.md',
      section: 'Targeted-invariant mode',
      readAs: 'docs/qa/explorer-playbook.md',
    }],
  },
  {
    lane: 'merge-reconcile',
    workflow: '.github/workflows/agent-merge-reconcile.yml',
    job: 'reconcile',
    playbooks: REVIEWER_PLAYBOOKS,
  },
  { lane: 'review', workflow: '.github/workflows/agent-review.yml', job: 'review', playbooks: REVIEWER_PLAYBOOKS },
];

/** One `## ` section of a Markdown file, to the next `## ` heading. */
const sectionOf = (text: string, heading: string): string => {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) return '';
  const rest = text.slice(start + 1);
  const next = rest.indexOf('\n## ', 1);
  return next < 0 ? rest : rest.slice(0, next);
};

const promptOf = (workflow: string, job: string): string => {
  const wf = readFlattened(join(ROOT, workflow)) as { jobs: Record<string, { steps: WorkflowStep[] }> };
  return agentPrompt(effectiveSteps(wf.jobs[job]!.steps));
};

describe('the filing skill (K-WORK-8)', () => {
  it('is one the model may start, and no command in a person\'s menu', () => {
    expect(front.name).toBe('file-issue');
    expect(front['disable-model-invocation']).toBeUndefined();
    expect(front['user-invocable']).toBe(false);
  });

  it('runs plan in the planning module, from Kanon\'s tree', () => {
    const calls = fenced.filter((l) => l.includes('scripts/issue-triage-defaults.mjs'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^node "\$KANON\/scripts\/issue-triage-defaults\.mjs" plan /);
  });

  it('passes only flags plan takes, and names each of them', () => {
    const call = fenced.find((l) => l.includes('issue-triage-defaults.mjs" plan'))!;
    const passed = [...call.matchAll(/(?:^|\s)(--[a-z-]+)/g)].map((m) => m[1]!);
    expect(passed.length).toBeGreaterThan(0);
    for (const flag of passed) expect(PLAN_FLAGS, flag).toContain(flag);
    const named = [...body.matchAll(/`(--[a-z-]+)`/g)].map((m) => m[1]!);
    for (const flag of PLAN_FLAGS) expect(named, flag).toContain(flag);
  });

  // kanon#1247, `K-WORK-14`: `plan` checks the body, so the skill passes the body file it files.
  it('passes the body file to plan, and files that same file', () => {
    const call = fenced.find((l) => l.includes('issue-triage-defaults.mjs" plan'))!;
    expect(call).toMatch(/ --body <file>$/);
    expect(fenced.find((l) => l.startsWith('gh issue create'))).toContain('--body-file <file>');
    expect(body).toContain('## What must be true');
    expect(body).toContain('## Possible approach — UNVERIFIED, not acceptance criteria');
  });

  it('files with plan\'s arguments alone, in one gh issue create', () => {
    const creates = fenced.filter((l) => l.startsWith('gh issue create'));
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatch(/ <ghArgs>$/);
    expect(body).toMatch(/Never follow it with a `gh issue edit` that changes the labels or the milestone/);
  });

  it('reads only fields plan prints: ghArgs and args on a plan, refused on a refusal', () => {
    const good = join(mkdtempSync(join(tmpdir(), 'filing-skill-')), 'body.md');
    writeFileSync(good, '## What must be true\n\nThe constraint.\n');
    const planned = JSON.parse(cli(['plan', '--label', 'bug', '--label', 'sev:low', '--body', good], '').out) as Record<string, unknown>;
    const refused = cli(['plan', '--label', 'follow-up', '--label', 'agent:reviewer', '--body', good], '');
    expect(refused.code).toBe(1);
    for (const field of ['ghArgs', 'args']) {
      expect(body).toContain(`\`${field}\``);
      expect(planned).toHaveProperty(field);
    }
    expect(body).toContain('{"refused": "<why>"}');
    expect(Object.keys(JSON.parse(refused.out) as object)).toEqual(['refused']);
    for (const code of ['Exit 0', 'Exit 1', 'Exit 2']) expect(body, code).toContain(`**${code}:**`);
    expect(cli(['plan', '--label'], '').code).toBe(2);
  });

  it('leaves the severity and the subject to the filer, and restates no routing', () => {
    expect(body).toContain('`K-WORK-9`');
    expect(body).toContain('--subject pipeline');
    expect(routingRestated(body, { allowGateCandidate: true })).toEqual([]);
  });
});

describe('each filer moved onto the skill files through it, and restates no routing (K-WORK-8)', () => {
  for (const { lane, workflow, job, playbooks = [] } of MOVED) {
    const prompt = promptOf(workflow, job);

    it(`${lane}: sends its agent to the skill by its path in Kanon's tree`, () => {
      expect(prompt.replace(/\s+/g, ' ')).toContain(`read and follow \`$KANON/${SKILL_PATH}\``);
    });

    it(`${lane}: names no bucket, no milestone and no gate-candidate rule of its own`, () => {
      expect(routingRestated(prompt)).toEqual([]);
    });

    for (const playbook of playbooks) {
      it(`${lane}: the "${playbook.section}" section of ${playbook.path} restates no routing either`, () => {
        const section = sectionOf(read(playbook.path), playbook.section);
        expect(section, `${playbook.path} has no "## ${playbook.section}"`).not.toBe('');
        expect(prompt).toContain(playbook.readAs ?? playbook.path);
        expect(routingRestated(section)).toEqual([]);
        expect(section).toContain('filing skill');
      });
    }
  }

  // The code audit files product bugs and pipeline bugs alike, so its prompt says how to tell
  // them apart, by what the cited code is and never by who found it (`K-WORK-4`).
  it('code-audit: tells its agent how to choose the subject, by the cited code', () => {
    const prompt = promptOf('.github/workflows/agent-code-audit.yml', 'audit').replace(/\s+/g, ' ');
    expect(prompt).toContain('never by who found it (K-WORK-4)');
    expect(prompt).toContain('`--subject pipeline`');
    expect(prompt).toContain('`--subject product`');
  });

  // A failed acceptance criterion is about whatever its project builds, so the verify-acs
  // prompt says how to choose the subject too: by what the criterion is about (`K-WORK-4`).
  it('verify-acs: tells its agent how to choose the subject, by what the criterion is about', () => {
    const prompt = promptOf('.github/workflows/agent-verify-acs.yml', 'verify').replace(/\s+/g, ' ');
    expect(prompt).toContain('by what its failed criterion is about, never by who found it (K-WORK-4)');
    expect(prompt).toContain('`--subject pipeline`');
    expect(prompt).toContain('`--subject product`');
  });

  // Merge-reconcile files the follow-ups a review left out, product and pipeline alike, so its
  // prompt says how to choose the subject (`K-WORK-4`), and reads the subject line from the
  // Reviewer's "Capturing follow-ups", through its excerpt.
  it('merge-reconcile: chooses the subject by the work', () => {
    const prompt = promptOf('.github/workflows/agent-merge-reconcile.yml', 'reconcile').replace(/\s+/g, ' ');
    expect(prompt).toContain('by what its work is about, never by who found it (K-WORK-4)');
    expect(prompt).toContain('When it is about both, K-WORK-4 decides: the platform wins.');
    expect(prompt).toContain('`--subject pipeline`');
    expect(prompt).toContain('`--subject product`');
    expect(prompt).toContain('.agent/reviewer-playbook-excerpt.md');
  });

  // The Reviewer keeps choosing the severity (#164's migration order) and chooses the subject.
  // Its shell is an allow-list that refuses `node` and `$KANON`, so its prompt names the
  // skill's path for this run and the plan command by its wrapper's name (review-verdict.test.ts
  // runs the wrapper).
  it('review: chooses the subject by the work, and runs plan by the name its shell allows', () => {
    const prompt = promptOf('.github/workflows/agent-review.yml', 'review').replace(/\s+/g, ' ');
    expect(prompt).toContain('by what its work is about, never by who found it (K-WORK-4)');
    expect(prompt).toContain('When it is about both, K-WORK-4 decides: the platform wins.');
    expect(prompt).toContain('`--subject pipeline`');
    expect(prompt).toContain('`--subject product`');
    expect(prompt).toContain('In this run `$KANON` is `${{ steps.kanon.outputs.path }}`');
    expect(prompt).toContain('run `kanon-plan` with the same flags instead');
    // The body it checks is a draft where the Reviewer may write (kanon#1247).
    expect(prompt).toMatch(/kanon-plan --label follow-up [^`]*--body \$\{\{ runner\.temp \}\}\/qa-review-<name>\.md`/);
    expect(prompt).toContain('ALWAYS APPLY A `sev:*` (RA-729) TO EACH FOLLOW-UP ISSUE YOU FILE');
  });

  // #164's last guard: not only the lanes listed above. Every agent prompt in every lane workflow
  // Kanon ships that files an issue (`gh issue create`) sends its agent to the skill and restates
  // no routing, so a lane added later, or a smoke copy of one, can't file by a routing table of
  // its own. A prompt that files nothing (the Lead's brief, which writes a `**Milestone:**` line
  // for the reconcile tick to transcribe through `plan()`) is not a filer.
  it('every lane prompt that files an issue goes through the skill, not a routing table of its own', () => {
    const dir = join(ROOT, '.github/workflows');
    const filers: string[] = [];
    for (const file of readdirSync(dir).filter((f) => /^agent-.*\.yml$/.test(f))) {
      const wf = readFlattened(join(dir, file)) as { jobs?: Record<string, { steps?: WorkflowStep[]; with?: { prompt?: unknown } }> };
      for (const [job, j] of Object.entries(wf.jobs ?? {})) {
        // A job that calls the agent through its steps, or one that hands a prompt to the spine.
        const step = agentStep(effectiveSteps(j.steps ?? []));
        const prompt = String(step?.with?.prompt ?? j.with?.prompt ?? '');
        if (!/gh issue create/.test(prompt)) continue;
        filers.push(`${file}#${job}`);
        expect(prompt.replace(/\s+/g, ' '), `${file}#${job}`).toContain(`read and follow \`$KANON/${SKILL_PATH}\``);
        expect(routingRestated(prompt), `${file}#${job}`).toEqual([]);
      }
    }
    for (const { workflow, job } of MOVED) expect(filers, 'the scan finds each moved lane').toContain(`${workflow.split('/').pop()}#${job}`);
  });

  it('catches a prompt that restates the routing, each way it can', () => {
    expect(routingRestated('Milestone: Product Backlog, a bucket (it is a product bug)')).toEqual([
      'names the bucket "Product Backlog"',
      'gives a "Milestone:" line',
    ]);
    expect(routingRestated('gh issue create --milestone "$M"')).toEqual(['passes a --milestone of its own']);
    expect(routingRestated('never a roadmap milestone such as the launch gate')).toEqual(['rules on roadmap milestones']);
    expect(routingRestated('also apply gate-candidate')).toEqual(['names gate-candidate']);
    expect(routingRestated('to Development Automation')).toEqual(['names the bucket "Development Automation"']);
  });
});
