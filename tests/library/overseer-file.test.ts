import { describe, expect, it } from 'vitest';
import {
  BUCKET,
  LABELS,
  SUBJECTS,
  auditTitle,
  classify,
  fileAudit,
  neutralise,
  nextAuditNumber,
  parseReport,
  renderAudit,
  route,
} from '../../scripts/overseer-file.mjs';

/**
 * Plan 0004 step 13, decision 12; `K-SELF-11`, `K-AGENT-35`. The Overseer is the adopter's
 * auditor: a finding the adopter can act on is filed in its repository, and one only Kanon can
 * act on is written as a draft under the audit issue's `## Upstream` heading and never filed.
 * The agent's token reads only; this step files from what it wrote down, so the routing is the
 * step's, by each finding's subject, and these tests hold it.
 */

const finding = (subject: string, title = `a ${subject} finding`, extra: Record<string, unknown> = {}) =>
  ({ title, body: `Evidence for ${title}.`, subject, capability: false, ...extra });
const report = (findings: unknown[], audit = '## Progress since the prior audit\n\nAll quiet.\n\n### Capability watch\nCapability watch: not due this audit\n') =>
  JSON.stringify({ audit, findings });

type Call = { args: string[]; input?: string };
/** A `gh` that records every call, numbers each created issue, and lists `prior` audits. */
const fakeGh = (prior: Array<{ number: number; title: string; state: string }> = []) => {
  const calls: Call[] = [];
  let next = 100;
  const gh = (args: string[], input?: string) => {
    calls.push({ args, input });
    if (args[0] === 'issue' && args[1] === 'create') return `https://github.com/o/r/issues/${next++}\n`;
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(prior);
    return '';
  };
  const created = () => calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'create')
    .map((c) => ({ title: c.args[c.args.indexOf('--title') + 1]!, body: c.input ?? '', args: c.args }));
  return { gh, calls, created };
};
const run = (text: string | null, opts: { prior?: Array<{ number: number; title: string; state: string }>; interlock?: number | 'throws'; agentOutcome?: string } = {}) => {
  const fake = fakeGh(opts.prior);
  const log: string[] = [];
  const code = fileAudit({
    repo: 'o/r',
    text,
    agentOutcome: opts.agentOutcome ?? 'success',
    gh: fake.gh,
    interlock: () => {
      if (opts.interlock === 'throws') throw new Error('search failed');
      return { count: opts.interlock ?? 0 };
    },
    log: (l) => log.push(l),
  });
  const created = fake.created();
  const audit = created.find((c) => c.title.startsWith('[pipeline] audit-summary'));
  return { code, log, ...fake, audit, findings: created.filter((c) => c !== audit) };
};

describe('who can act decides where a finding goes', () => {
  it('the subject list is decision 12\'s', () => {
    expect(Object.entries(SUBJECTS).filter(([, w]) => w === 'adopter').map(([s]) => s).sort())
      .toEqual(['app', 'cost', 'coverage', 'declaration', 'hook', 'labels', 'milestones', 'permissions', 'playbook', 'schedule']);
    expect(Object.entries(SUBJECTS).filter(([, w]) => w === 'kanon').map(([s]) => s).sort()).toEqual(['guard', 'lane', 'library', 'rule']);
  });

  it('THE MUTATION THE PLAN NAMES: a finding about a guard\'s behaviour goes upstream, and into no new issue', () => {
    const guard = finding('guard', 'The citation guard passes a stale line range');
    const r = run(report([finding('playbook', 'The playbook names no liveness query'), guard]));
    expect(r.code).toBe(0);
    // Filed: the adopter's finding, and the audit. Not the guard's.
    expect(r.findings.map((f) => f.title)).toEqual(['The playbook names no liveness query']);
    expect(r.calls.some((c) => c.args.includes(guard.title))).toBe(false);
    // In the audit, under `## Upstream`, as a draft.
    const upstream = r.audit!.body.slice(r.audit!.body.indexOf('\n## Upstream\n'));
    expect(upstream).toContain(`### ${guard.title}`);
    expect(upstream).toContain(guard.body);
    expect(upstream).toContain('_Routed here by subject `guard`._');
    expect(r.audit!.body.indexOf('## Filed this run')).toBeLessThan(r.audit!.body.indexOf('## Upstream'));
  });

  it.each(['lane', 'guard', 'rule', 'library'])('a `%s` finding is never filed here', (subject) => {
    const r = run(report([finding(subject)]));
    expect(r.findings).toEqual([]);
    expect(r.audit!.body).toContain(`### a ${subject} finding`);
  });

  it.each(['declaration', 'playbook', 'hook', 'app', 'permissions', 'cost', 'schedule', 'labels', 'milestones', 'coverage'])(
    'a `%s` finding is filed here, as a pipeline-improvement in the platform bucket, in one call', (subject) => {
      const r = run(report([finding(subject)]));
      expect(r.findings).toHaveLength(1);
      const { args, body } = r.findings[0]!;
      // Opened with the Overseer's header and role marker (plan 0005 §3.3).
      expect(body).toBe(`**Overseer** <!-- kanon:role=overseer -->\n\nEvidence for a ${subject} finding.`);
      expect(args.filter((_, i) => args[i - 1] === '--label')).toEqual(LABELS);
      expect(args[args.indexOf('--milestone') + 1]).toBe(BUCKET);
      expect(r.audit!.body).toContain(`- #100 a ${subject} finding`);
    });

  it('an unknown or missing subject goes upstream, unfiled, and says why: nothing is filed on a guess', () => {
    expect(classify(finding('workflow'))).toEqual({ who: 'kanon', why: 'subject `workflow` is not one of the known subjects, so it was not filed here' });
    expect(classify(finding(''))).toEqual({ who: 'kanon', why: 'no subject, so it was not filed here' });
    const r = run(report([finding('workflow'), { title: 'No subject', body: 'b' }]));
    expect(r.findings).toEqual([]);
    expect(r.audit!.body).toContain('### No subject');
  });

  it('never files a finding whose title the capability anchor would search', () => {
    const r = run(report([finding('playbook', 'The audit-summary title is ambiguous')]));
    expect(r.findings).toEqual([]);
    expect(r.audit!.body).toContain('- **Held:** The audit-summary title is ambiguous: its title holds `audit-summary`, which the capability anchor searches for.');
  });

  it('the Upstream heading is in every audit, empty or not', () => {
    const r = run(report([]));
    expect(r.audit!.body).toMatch(/\n## Upstream\n\n[^\n]+\n\nNone this run\.\n$/);
    expect(r.audit!.body).toContain('## Filed this run\n\nNothing.');
  });
});

describe('capability investigations (K-SELF-17)', () => {
  const cap = (title: string, subject = 'playbook') => finding(subject, title, { capability: true });

  it('files one while the interlock is clear, labelled `capability`', () => {
    const r = run(report([cap('Investigate: one')]), { interlock: 6 });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.args.filter((_, i, a) => a[i - 1] === '--label')).toEqual([...LABELS, 'capability']);
  });

  it('holds every one while the interlock is closed, or could not be counted', () => {
    for (const interlock of [7, 'throws'] as const) {
      const r = run(report([cap('Investigate: one')]), { interlock });
      expect(r.findings).toEqual([]);
      expect(r.audit!.body).toMatch(/- \*\*Held:\*\* Investigate: one: the capability interlock (is closed \(7 open, more than 6\)|could not be counted, so it is closed)\./);
    }
  });

  it('files at most one a run', () => {
    const r = run(report([cap('Investigate: one'), cap('Investigate: two')]), { interlock: 0 });
    expect(r.findings.map((f) => f.title)).toEqual(['Investigate: one']);
    expect(r.audit!.body).toContain('- **Held:** Investigate: two: one capability investigation is filed per run.');
  });

  it('sends a capability investigation into a Kanon lane upstream, uncounted', () => {
    let counted = false;
    const fake = fakeGh();
    fileAudit({ repo: 'o/r', text: report([cap('Investigate: a lane flag', 'lane')]), agentOutcome: 'success', gh: fake.gh,
      interlock: () => { counted = true; return { count: 0 }; }, log: () => {} });
    expect(counted).toBe(false);
    expect(fake.created().map((c) => c.title)).toEqual([auditTitle(1)]);
  });
});

describe('the rolling audit issue (K-SELF-11)', () => {
  it('numbers the audit after the newest earlier one, and closes every earlier open one', () => {
    const prior = [
      { number: 7, title: '[pipeline] audit-summary — Overseer audit #14', state: 'OPEN' },
      { number: 5, title: '[pipeline] audit-summary — Overseer audit #13', state: 'CLOSED' },
      { number: 9, title: 'Re: audit-summary discussion', state: 'OPEN' },
    ];
    const r = run(report([]), { prior });
    expect(r.audit!.title).toBe('[pipeline] audit-summary — Overseer audit #15');
    expect(r.calls.filter((c) => c.args[1] === 'comment').map((c) => c.args)).toEqual([['issue', 'comment', '7', '--repo', 'o/r', '--body', '**Overseer** <!-- kanon:role=overseer -->\n\nSuperseded by #100.']]);
    expect(r.calls.filter((c) => c.args[1] === 'close').map((c) => c.args[2])).toEqual(['7']);
  });

  it('starts at 1', () => expect(nextAuditNumber([])).toBe(1));
});

describe('the outcome', () => {
  it('no report files nothing and reds the step: the whole audit was lost', () => {
    const r = run(null, { agentOutcome: 'failure' });
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.log.join('\n')).toMatch(/::error title=overseer produced nothing::The agent wrote no qa-overseer-audit\.json/);
  });

  it.each([
    ['not JSON', '{"audit": '],
    ['no audit', JSON.stringify({ findings: [] })],
    ['a finding with no title', JSON.stringify({ audit: 'x', findings: [{ body: 'b' }] })],
    ['findings that are not a list', JSON.stringify({ audit: 'x', findings: {} })],
  ])('a report with %s files nothing and reds the step', (_name, text) => {
    const r = run(text);
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.log.join('\n')).toContain('::error title=overseer produced nothing::');
  });

  it('an agent that exited non-zero after a valid report is a warning, and its audit is filed', () => {
    const r = run(report([]), { agentOutcome: 'failure' });
    expect(r.code).toBe(0);
    expect(r.audit).toBeDefined();
    expect(r.log.join('\n')).toContain('::warning title=overseer exited non-zero after writing its audit::');
  });

  it('a finding that fails to file is named, the audit is still filed, and the step reds', () => {
    const fake = fakeGh();
    const gh = (args: string[], input?: string) => {
      if (args[1] === 'create' && args.includes('Bad one')) throw new Error('HTTP 422: label not found');
      return fake.gh(args, input);
    };
    const log: string[] = [];
    const code = fileAudit({ repo: 'o/r', text: report([finding('labels', 'Bad one'), finding('labels', 'Good one')]), agentOutcome: 'success', gh, log: (l) => log.push(l) });
    expect(code).toBe(1);
    const audit = fake.created().find((c) => c.title.startsWith('[pipeline]'))!;
    expect(audit.body).toContain('- **Not filed, the create failed:** Bad one (HTTP 422: label not found)');
    expect(audit.body).toContain('- #100 Good one');
  });
});

describe('the watermark anchor stays the agent\'s (K-SELF-17)', () => {
  // The capability review's anchor query, as the prompt runs it, re-expressed: a body is an anchor
  // when any line matches it. Nothing this step adds may make a body match.
  const ANCHOR = /(^|\r?\n)[^A-Za-z0-9\n]*Watermark[^A-Za-z0-9\n:]*:/;

  it('neutralises a `Watermark:` line in a draft or a title, in every decoration', () => {
    for (const line of ['Watermark: 2.1.260', '**Watermark:** 2.1.260', '**Watermark**: none', '- Watermark : x', '> _Watermark_: y']) {
      expect(ANCHOR.test(neutralise(line)), line).toBe(false);
    }
  });

  it('an audit that carried no watermark gains none from what the step adds', () => {
    const quoting = finding('lane', 'Watermark: 2.1.999 is read wrongly', { body: '**Watermark:** 2.1.260\nWatermark: none' });
    const r = run(report([quoting, finding('playbook', 'Watermark: in a title')]));
    expect(ANCHOR.test(r.audit!.body)).toBe(false);
  });

  it('keeps the agent\'s own watermark line, so a real anchor is still one', () => {
    const body = renderAudit({ audit: '### Capability watch\nCapability watch: ran, through 2.1.300\n\nLedger delta — not yet folded in\nWatermark: 2.1.300\n', filed: [], held: [], upstream: [] });
    expect(ANCHOR.test(body)).toBe(true);
  });
});

describe('the report', () => {
  it('reads the agent\'s file, trimming titles and defaulting `capability`', () => {
    expect(parseReport(report([{ title: ' t ', body: 'b', subject: ' guard ' }]))).toEqual({
      audit: expect.any(String),
      findings: [{ title: 't', body: 'b', subject: 'guard', capability: false }],
    });
  });

  it('routes without the network: route() is pure', () => {
    const r = route([finding('guard'), finding('playbook')], null);
    expect(r.upstream.map((u) => u.finding.subject)).toEqual(['guard']);
    expect(r.file.map((f) => f.subject)).toEqual(['playbook']);
  });
});
