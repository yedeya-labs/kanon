import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { askStep, bailAsk, callerOf, claimLabel, isBail, lastWordOf, restartStep, takesComments } from '../../scripts/bail-restart.mjs';
import { DECISION_LABEL, isWholeAsk } from '../../scripts/lib/decision-asks.mjs';
import { evaluate } from './helpers/expression.js';

// kanon#1649 (the Owner's option A, 2026-11-06): a scope-first bail labels the issue
// `decision:needed` with a fixed-form ask, so `kanon inbox` lists it, and a member's reply to the
// bail restarts the run at once, taking the label off before the run goes on.
const IMPL = 'example-author[bot]';
const at = (m: number) => `2026-11-06T10:${String(m).padStart(2, '0')}:00Z`;
const bail = { id: 1, body: 'SCOPE-FIRST BAIL: this writes the deploy role\'s trust policy.\n\nPlan: …\n\nReply on this issue: `approved`…', created_at: at(10), html_url: 'https://github.com/o/r/issues/7#issuecomment-1', user: { login: IMPL, type: 'Bot' } };
const ask = { id: 2, body: bailAsk(bail.html_url), created_at: at(11), user: { login: 'github-actions[bot]', type: 'Bot' } };
const reply = { id: 3, body: 'approved', created_at: at(20), user: { login: 'owner', type: 'User' } };

describe('a scope-first bail waits where a person sees it (#1649)', () => {
  it('knows a bail by its opening words, and the Implementer\'s last word by its login', () => {
    expect(isBail(bail.body)).toBe(true);
    expect(isBail('Built it; see the PR.')).toBe(false);
    expect(lastWordOf([reply, ask, bail], IMPL)?.id).toBe(1);
    expect(lastWordOf([reply, ask], IMPL)).toBeNull();
  });

  it('asks once, in the fixed form, for a bail posted during this run', () => {
    const d = askStep({ comments: [bail], implementer: IMPL, labels: ['agent:implement'], since: at(0) });
    expect(d.ask).toBe(true);
    if (d.ask) {
      expect(isWholeAsk(d.body)).toBe(true);
      expect(d.body).toContain(bail.html_url);
      expect(d.body).toContain('restarts at once');
    }
    // Not twice, not for an earlier run's bail, not for any other last word.
    expect(askStep({ comments: [bail], implementer: IMPL, labels: ['agent:implement', DECISION_LABEL], since: at(0) }).ask).toBe(false);
    expect(askStep({ comments: [bail], implementer: IMPL, labels: [], since: at(15) }).ask).toBe(false);
    expect(askStep({ comments: [bail, { ...bail, id: 9, body: 'Opened the PR.', created_at: at(12) }], implementer: IMPL, labels: [], since: at(0) }).ask).toBe(false);
    expect(askStep({ comments: [bail], implementer: IMPL, labels: [], since: '' }).ask).toBe(false);
  });

  it('restarts on a person\'s reply after the bail, while the issue still waits', () => {
    const labels = ['agent:implement', DECISION_LABEL];
    expect(restartStep({ comments: [bail, ask, reply], implementer: IMPL, labels, commentId: 3 })).toMatchObject({ restart: true });
    // The label already off: a second reply, or an issue nobody asked about.
    expect(restartStep({ comments: [bail, ask, reply], implementer: IMPL, labels: ['agent:implement'], commentId: 3 }).restart).toBe(false);
    // An App's comment, and the ask itself, restart nothing.
    expect(restartStep({ comments: [bail, ask, reply], implementer: IMPL, labels, commentId: 2 }).restart).toBe(false);
    expect(restartStep({ comments: [bail, ask, { ...reply, user: { login: 'helper[bot]', type: 'User' } }], implementer: IMPL, labels, commentId: 3 }).restart).toBe(false);
    // No bail before the reply, or the Implementer spoke since.
    const other = { ...bail, body: 'Which of the two endpoints did you mean?' };
    expect(restartStep({ comments: [other, reply], implementer: IMPL, labels, commentId: 3 }).restart).toBe(false);
    expect(restartStep({ comments: [bail, reply, { ...bail, id: 4, body: 'Opened the PR.', created_at: at(30) }], implementer: IMPL, labels, commentId: 3 }).restart).toBe(false);
    // A comment before the bail is no reply to it.
    expect(restartStep({ comments: [{ ...reply, created_at: at(5) }, bail], implementer: IMPL, labels, commentId: 3 }).restart).toBe(false);
    expect(restartStep({ comments: [bail], implementer: IMPL, labels, commentId: 3 }).restart).toBe(false);
  });
});

describe('the ask promises a restart only when the caller takes issue_comment (#1678)', () => {
  it('finds the caller\'s file and ref in github.workflow_ref, for this repository only', () => {
    expect(callerOf('acme/widgets/.github/workflows/implement.yml@refs/heads/main', 'acme/widgets')).toEqual({ path: '.github/workflows/implement.yml', ref: 'refs/heads/main' });
    expect(callerOf('Acme/Widgets/.github/workflows/implement.yml@refs/heads/main', 'acme/widgets')).not.toBeNull();
    expect(callerOf('other/repo/.github/workflows/implement.yml@refs/heads/main', 'acme/widgets')).toBeNull();
    expect(callerOf('', 'acme/widgets')).toBeNull();
    expect(callerOf(undefined, 'acme/widgets')).toBeNull();
  });

  it('reads issue_comment from the caller\'s on:, in block and flow form, never from a comment or an if:', () => {
    expect(takesComments('on:\n  issues:\n    types: [labeled]\n  issue_comment:\n    types: [created]\n')).toBe(true);
    expect(takesComments('on: [issues, issue_comment, workflow_dispatch]\n')).toBe(true);
    expect(takesComments('on:\n  issues:\nenv:\n  log_issue_comment: x\n')).toBe(false);
    expect(takesComments('on:\n  issues:\n    types: [labeled]\n  workflow_dispatch:\n')).toBe(false);
    expect(takesComments('on:\n  issues:\n    types: [labeled]\n  # issue_comment:\n  #   types: [created]\n')).toBe(false);
    expect(takesComments("on:\n  issues:\njobs:\n  a:\n    if: github.event_name != 'issue_comment'\n")).toBe(false);
  });

  it('says how to restart by hand when a reply restarts nothing, or the lane couldn\'t tell', () => {
    for (const restarts of [false, null] as const) {
      const body = bailAsk(bail.html_url, restarts);
      expect(isWholeAsk(body)).toBe(true);
      expect(body).toContain(bail.html_url);
      expect(body).not.toContain('restarts at once');
      expect(body).toContain('remove `decision:needed` and apply `agent:implement` again, or dispatch the implement lane');
    }
    expect(bailAsk(bail.html_url, false)).toContain('takes no `issue_comment`');
    expect(bailAsk(bail.html_url, null)).toContain('could not read this repository\'s implement caller');
    const d = askStep({ comments: [bail], implementer: IMPL, labels: [], since: at(0), restarts: false });
    expect(d.ask && d.body).toBe(bailAsk(bail.html_url, false));
    const yes = askStep({ comments: [bail], implementer: IMPL, labels: [], since: at(0), restarts: true });
    expect(yes.ask && yes.body).toContain('restarts at once');
  });
});

describe('a reply that asks a question waits on the person again (#1679)', () => {
  it('asks again for the restarted run\'s answer, and the next reply restarts it', () => {
    const question = { ...reply, body: 'Why the trust policy and not a new role?' };
    const answer = { ...bail, id: 5, body: 'SCOPE-FIRST BAIL: a new role needs the same trust edit.\n\nPlan: …', created_at: at(30), html_url: 'https://github.com/o/r/issues/7#issuecomment-5' };
    // The restart took the label off; the answer, a bail of this run, is asked about again.
    const d = askStep({ comments: [bail, ask, question, answer], implementer: IMPL, labels: ['agent:implement'], since: at(25) });
    expect(d.ask && d.body).toContain(answer.html_url);
    const ask2 = { ...ask, id: 6, body: bailAsk(answer.html_url), created_at: at(31) };
    const next = { ...reply, id: 7, created_at: at(40) };
    expect(restartStep({ comments: [bail, ask, question, answer, ask2, next], implementer: IMPL, labels: ['agent:implement', DECISION_LABEL], commentId: 7 })).toMatchObject({ restart: true });
  });
});

describe('two replies close together restart one run (#1677)', () => {
  it('restarts only the run whose removal of the label succeeds', () => {
    expect(claimLabel(() => '[]')).toBe(true);
    expect(claimLabel(() => { throw Object.assign(new Error('Command failed: gh api -X DELETE …'), { stderr: 'gh: Label does not exist (HTTP 404)' }); })).toBe(false);
    expect(() => claimLabel(() => { throw Object.assign(new Error('Command failed'), { stderr: 'gh: Resource not accessible by integration (HTTP 403)' }); })).toThrow('Command failed');
  });

  it('takes the label off through the endpoint that answers 404, as the claim', () => {
    const src = readFileSync('scripts/bail-restart.mjs', 'utf8');
    expect(src).toContain("claimLabel(() => gh(['api', '-X', 'DELETE', `repos/${REPO}/issues/${ISSUE}/labels/${encodeURIComponent(DECISION_LABEL)}`]))");
    expect(src).not.toContain("'--remove-label', DECISION_LABEL");
  });
});

describe('the implement lane on a comment (#1649)', () => {
  const wf = parse(readFileSync('.github/workflows/agent-implement.yml', 'utf8'));
  const filter = wf.jobs.filter;
  const ctx = (over: { labels?: string[]; type?: string; pr?: boolean; state?: string; action?: string } = {}) => ({
    github: {
      event_name: 'issue_comment',
      event: {
        action: over.action ?? 'created',
        issue: { number: 7, state: over.state ?? 'open', labels: (over.labels ?? ['agent:implement', DECISION_LABEL]).map((name) => ({ name })), ...(over.pr ? { pull_request: { url: 'x' } } : {}) },
        comment: { id: 3, user: { login: 'owner', type: over.type ?? 'User' } },
      },
    },
  });

  it('turns away every comment but a possible reply to a bail before a runner starts', () => {
    expect(evaluate(String(filter.if), ctx())).toBe(true);
    expect(evaluate(String(filter.if), ctx({ labels: ['agent:implement'] }))).toBe(false);
    expect(evaluate(String(filter.if), ctx({ labels: [DECISION_LABEL] }))).toBe(false);
    expect(evaluate(String(filter.if), ctx({ type: 'Bot' }))).toBe(false);
    expect(evaluate(String(filter.if), ctx({ pr: true }))).toBe(false);
    expect(evaluate(String(filter.if), ctx({ state: 'closed' }))).toBe(false);
    expect(evaluate(String(filter.if), ctx({ action: 'edited' }))).toBe(false);
  });

  it('admits a comment only as a restart, which takes the label off before the run goes on', () => {
    const steps = filter.steps as Array<{ id?: string; if?: string; run?: string; env?: Record<string, string> }>;
    const gate = steps.findIndex((s) => s.id === 'gate');
    const restart = steps.findIndex((s) => s.id === 'restart');
    expect(restart).toBe(gate + 1);
    expect(steps[restart]!.env).toMatchObject({ MODE: 'restart', COMMENT_ID: '${{ github.event.comment.id }}', GH_TOKEN: '${{ github.token }}' });
    expect(steps[restart]!.run).toContain('scripts/bail-restart.mjs');
    expect(filter.permissions).toMatchObject({ issues: 'write' });
    const member = String(filter.outputs.member).replace(/^\$\{\{\s*|\s*\}\}$/g, '');
    const out = (gate: string, restart: string, event = 'issue_comment') => evaluate(member, { github: { event_name: event }, steps: { gate: { outputs: { member: gate } }, decision: { outputs: { admit: 'true' } }, restart: { outputs: { restart } } } });
    expect(out('true', 'true')).toBe('true');
    expect(out('true', 'false')).toBe('false');
    expect(out('false', 'true')).toBe('false');
    expect(out('true', '', 'issues')).toBe('true');
  });

  it('asks after a green run, on the default token, and never reds the lane', () => {
    const job = wf.jobs['bail-ask'];
    expect(job.needs).toEqual(['filter', 'implement']);
    expect(job.if).toBe("needs.implement.result == 'success' && needs.filter.outputs.member == 'true'");
    expect(job.permissions).toMatchObject({ issues: 'write' });
    const step = job.steps.find((s: { run?: string }) => String(s.run ?? '').includes('bail-restart.mjs'));
    expect(step['continue-on-error']).toBe(true);
    expect(step.env).toMatchObject({ MODE: 'ask', GH_TOKEN: '${{ github.token }}', SINCE: '${{ needs.filter.outputs.since }}', WORKFLOW_REF: '${{ github.workflow_ref }}' });
    expect(job.permissions).toMatchObject({ contents: 'read' });
  });

  it('tells the Implementer to open a bail with the words the job finds, and that a reply restarts it', () => {
    const text = readFileSync('.github/workflows/agent-implement.yml', 'utf8').replace(/\s+/g, ' ');
    expect(text).toContain('Open that plan-comment with the words `SCOPE-FIRST BAIL` (kanon#1649)');
    expect(text).toContain('this run IS that restart: the reply is the answer');
    // A reply that asks a question waits on the person again (#1679).
    expect(text).toContain('answer it in a new plan-comment that opens with `SCOPE-FIRST BAIL` again');
  });
});
