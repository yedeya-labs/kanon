import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers/adopter.js';
import { validate } from '../../actions/agent-telemetry/schema.mjs';
import { kanonFileIn } from '../../scripts/lib/finding-rows.mjs';
import {
  BUCKET,
  LABELS,
  SUBJECTS,
  auditTitle,
  classify,
  fileAudit,
  filedHere,
  neutralise,
  nextAuditNumber,
  parseReport,
  renderAudit,
  route,
  upstreamChoice,
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
const run = (text: string | null, opts: { prior?: Array<{ number: number; title: string; state: string }>; interlock?: number | 'throws'; agentOutcome?: string; upstream?: string } = {}) => {
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
    ...(opts.upstream === undefined ? {} : { upstream: opts.upstream }),
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

describe('a repository that declares `Upstream findings: filed here` (K-LAYOUT-10, kanon#423)', () => {
  const kanonFinding = finding('guard', 'The citation guard passes a stale line range');
  const mixed = () => report([finding('playbook', 'The playbook names no liveness query'), kanonFinding, finding('vibes', 'Something feels off')]);

  it('files a finding only Kanon can act on in this repository, like the adopter\'s own', () => {
    const r = run(mixed(), { upstream: 'filed here' });
    expect(r.code).toBe(0);
    expect(r.findings.map((f) => f.title)).toEqual(['The playbook names no liveness query', kanonFinding.title]);
    const filed = r.findings[1]!;
    // In this repository, and no other: the same `--repo`, labels and bucket as the adopter's own.
    expect(filed.args.slice(0, 4)).toEqual(['issue', 'create', '--repo', 'o/r']);
    expect(r.calls.every((c) => !c.args.includes('--repo') || c.args[c.args.indexOf('--repo') + 1] === 'o/r')).toBe(true);
    expect(filed.args).toEqual(expect.arrayContaining(['--label', 'pipeline-improvement', '--label', 'agent:overseer', '--milestone', BUCKET]));
    expect(filed.body).toContain(kanonFinding.body);
    const body = r.audit!.body;
    expect(body).toContain(`- #101 ${kanonFinding.title} (only Kanon can act on it)`);
    expect(body).toContain('`Upstream findings: filed here`');
    expect(body.slice(body.indexOf('\n## Upstream\n'))).not.toContain(`### ${kanonFinding.title}`);
  });

  it('still drafts a finding whose subject it doesn\'t know: nothing is filed on a guess', () => {
    const r = run(mixed(), { upstream: 'filed here' });
    expect(r.calls.some((c) => c.args.includes('Something feels off'))).toBe(false);
    const upstream = r.audit!.body.slice(r.audit!.body.indexOf('\n## Upstream\n'));
    expect(upstream).toContain('### Something feels off');
    expect(upstream).toContain('subject `vibes` is not one of the known subjects');
    expect(filedHere(finding('', 'no subject'), 'filed here')).toBe(false);
  });

  it('holds a filed upstream finding to the same guards: the anchor\'s title, and the capability interlock', () => {
    const anchor = finding('lane', 'The audit-summary anchor drifts');
    const cap = finding('library', 'Adopt the new runtime flag', { capability: true });
    let counted = 0;
    const fake = fakeGh();
    const code = fileAudit({ repo: 'o/r', text: report([anchor, cap]), agentOutcome: 'success', gh: fake.gh, upstream: 'filed here',
      interlock: () => { counted += 1; return { count: 99 }; }, log: () => {} });
    expect(code).toBe(0);
    expect(counted).toBe(1);
    expect(fake.created().map((c) => c.title)).toEqual([auditTitle(1)]);
    const body = fake.created()[0]!.body;
    expect(body).toContain('- **Held:** The audit-summary anchor drifts');
    expect(body).toContain('- **Held:** Adopt the new runtime flag: the capability interlock is closed');
  });

  it('WITHOUT THE CHOICE, nothing changes: the same calls and the same audit, byte for byte', () => {
    const baseline = run(mixed());
    for (const upstream of ['drafted', '']) {
      const r = run(mixed(), { upstream });
      expect(r.calls, upstream).toEqual(baseline.calls);
      expect(r.log, upstream).toEqual(baseline.log);
    }
    expect(baseline.findings.map((f) => f.title)).toEqual(['The playbook names no liveness query']);
    // A capability finding only Kanon can act on is not counted against the interlock either.
    let counted = 0;
    fileAudit({ repo: 'o/r', text: report([finding('library', 'x', { capability: true })]), agentOutcome: 'success', gh: fakeGh().gh,
      interlock: () => { counted += 1; return { count: 0 }; }, log: () => {} });
    expect(counted).toBe(0);
  });

  it('drafts on a value it doesn\'t know, and says so, rather than filing on a guess', () => {
    const r = run(mixed(), { upstream: 'filed on kanon' });
    expect(r.findings.map((f) => f.title)).toEqual(['The playbook names no liveness query']);
    expect(r.log).toContain('::warning title=overseer upstream choice::the lane passed `filed on kanon`, which is neither `drafted` nor `filed here`, so findings only Kanon can act on are drafted, not filed (K-LAYOUT-10)');
    expect(upstreamChoice(' filed here ')).toEqual({ upstream: 'filed here' });
    expect(upstreamChoice(undefined)).toEqual({ upstream: 'drafted' });
    expect(upstreamChoice('Filed Here')).toEqual({ upstream: 'drafted', unknown: 'Filed Here' });
  });

  // Plan 0006 §3.1 (kanon#585): a sent finding is also drafted, so `sent` and `sent with evidence`
  // route as drafts, without the warning an unknown value gets, at the level each sends (F3).
  it('routes `sent` and `sent with evidence` as drafts, knowing both', () => {
    expect(upstreamChoice('sent')).toEqual({ upstream: 'drafted', level: 'codes' });
    expect(upstreamChoice('sent with evidence')).toEqual({ upstream: 'drafted', level: 'evidence' });
    expect(upstreamChoice('sent  with evidence')).toEqual({ upstream: 'drafted', unknown: 'sent  with evidence' });
  });

  it('routes by the choice in the pure router too', () => {
    const fs = [finding('rule'), finding('declaration')];
    expect(route(fs, 0).file.map((f) => f.subject)).toEqual(['declaration']);
    expect(route(fs, 0, 'drafted').upstream.map((u) => u.finding.subject)).toEqual(['rule']);
    expect(route(fs, 0, 'filed here').file.map((f) => f.subject)).toEqual(['rule', 'declaration']);
    expect(route(fs, 0, 'filed here').upstream).toEqual([]);
    expect(renderAudit({ audit: 'a', filed: [], held: [], upstream: [] })).toBe(renderAudit({ audit: 'a', filed: [], held: [], upstream: [], choice: 'drafted' }));
  });
});

// Plan 0006 §5, steps 1 and 2 (F3, kanon#588). With `sent` or `sent with evidence`, the filing
// step also builds one finding row per upstream finding, from the report's `upstream` object,
// keeps a code only when it is in the schema's list, runs the scrub on the text for level 2,
// validates every row and writes them for one `kanon-finding-overseer-*` artifact. Each such
// finding is still drafted, showing exactly what was sent.
describe('upstream findings sent to Kanon (plan 0006 §5, F3)', () => {
  const REPO = 'acme-corp/widget-shop';
  const guard = finding('guard', 'The citation guard passes a stale line range', {
    upstream: {
      fix_category: 'guard', rules: ['K-SELF-11', 'K-NOPE-1'], kanon_paths: ['scripts/overseer-file.mjs', 'src/app.ts'],
      evidence: '**Expected:** K-SELF-11 holds.\n**Observed:** see https://example.test/run/1, raised by @octo-reviewer in src/app.ts.',
      suggested_fix: 'Re-read the range in scripts/overseer-file.mjs before judging.',
    },
  });
  const lane = finding('lane', 'The Overseer lane stops before its audit', {
    upstream: { lane: 'overseer', failed_stage: 'agent', reason: 'did_not_finish', fix_category: 'lane-behaviour', evidence: '**Observed:** the agent stage ended without a report.' },
  });
  const fixture = (findings: unknown[] = [finding('playbook', 'The playbook names no liveness query'), guard, lane, finding('vibes', 'Something feels off')]) => report(findings);

  type Opts = { nameHashes?: string[] | null; participants?: 'throws'; write?: 'throws' };
  /** A `gh` that also answers the participants' reads, as the filing token sees them. */
  const sendingGh = (o: Opts) => {
    const calls: Call[] = [];
    let next = 100;
    const gh = (args: string[], input?: string) => {
      calls.push({ args, input });
      const json = args[args.indexOf('--json') + 1] ?? '';
      if (args[0] === 'issue' && args[1] === 'create') return `https://github.com/${REPO}/issues/${next++}\n`;
      if ((args[0] === 'issue' || args[0] === 'pr') && args[1] === 'list' && json.includes('author')) {
        if (o.participants === 'throws') throw new Error('HTTP 403');
        return JSON.stringify(args[0] === 'pr'
          ? [{ author: { login: 'pat-author' }, assignees: [], comments: [], latestReviews: [{ author: { login: 'octo-reviewer' } }], reviewRequests: [{ login: 'req-person' }, { name: 'a-team' }] }]
          : [{ author: { login: 'issue-opener' }, assignees: [{ login: 'assigned-one' }], comments: [{ author: { login: 'chatty-commenter' } }] }]);
      }
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'api' && String(args[1]).endsWith('/collaborators')) return 'collab-person\n';
      return '';
    };
    return { gh, calls };
  };
  const sending = (upstream: string | undefined, text = fixture(), o: Opts = {}) => {
    const fake = sendingGh(o);
    const written: Array<Record<string, unknown>[]> = [];
    const log: string[] = [];
    const code = fileAudit({
      repo: REPO, text, agentOutcome: 'success', gh: fake.gh, interlock: () => ({ count: 0 }), log: (l) => log.push(l), upstream,
      send: {
        run: { id: 4242, attempt: 1 }, tag: 'test', recordedAt: '2026-10-07T12:00:00.000Z', kanonVersion: '0.38.0', actor: 'run-actor',
        nameHashes: o.nameHashes === undefined ? [] : o.nameHashes, isKanonFile: kanonFileIn(ROOT),
        write: (rows: Record<string, unknown>[]) => { if (o.write === 'throws') throw new Error('disk full'); written.push(rows); },
      },
    });
    const audit = fake.calls.filter((c) => c.args[1] === 'create').map((c) => c.input ?? '').find((b) => b.includes('## Upstream'))!;
    return { code, written, rows: written.flat(), audit, upstream: audit.slice(audit.indexOf('\n## Upstream\n')), log, calls: fake.calls };
  };
  /** The text a draft shows as sent, from its fenced block. */
  const drafted = (upstream: string, title: string, what: 'evidence' | 'suggested fix') => {
    const at = upstream.slice(upstream.indexOf(`### ${title}`));
    const m = new RegExp(`Its ${what}, as sent:\\n\\n(\`{3,})text\\n([\\s\\S]*?)\\n\\1\\n`).exec(at);
    return m?.[2];
  };

  it('with `sent`, a fixture audit with two Kanon findings uploads two rows at `codes`, and no text', () => {
    const r = sending('sent');
    expect(r.code).toBe(0);
    expect(r.written).toHaveLength(1);
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) {
      expect(validate(row)).toEqual({ ok: true });
      expect(row.evidence_level).toBe('codes');
      for (const k of ['evidence', 'suggested_fix', 'scrub_version', 'title', 'body']) expect(row).not.toHaveProperty(k);
    }
    expect(r.rows.map((x) => [x.finding_index, x.reporter, x.subject, x.fix_category])).toEqual([[0, 'overseer', 'guard', 'guard'], [1, 'overseer', 'lane', 'lane-behaviour']]);
    expect(r.rows[0]).toMatchObject({ rules: 'K-SELF-11', kanon_paths: 'scripts/overseer-file.mjs', kanon_version: '0.38.0', run_id: 4242, run_attempt: 1, tag: 'test' });
    expect(r.rows[1]).toMatchObject({ lane: 'overseer', failed_stage: 'agent', reason: 'did_not_finish' });
    // No text of the agent's, nor the adopter's own finding or the unknown-subject one.
    const sent = JSON.stringify(r.rows);
    for (const t of [guard.title, guard.body, 'Observed', 'liveness', 'feels off', 'K-NOPE-1', 'src/app.ts']) expect(sent).not.toContain(t);
    // Codes only: nothing is read for the scrub.
    expect(r.calls.some((c) => c.args[0] === 'pr')).toBe(false);
  });

  it('with `sent`, each Kanon finding is still drafted, marked as sent, and the heading says at which level and who reads it', () => {
    const r = sending('sent');
    expect(r.upstream).toContain('`Upstream findings: sent`');
    expect(r.upstream).toMatch(/codes .*no text/);
    expect(r.upstream).toMatch(/Kanon's operator's private job reads/);
    expect(r.upstream.match(/\*\*Sent to Kanon\*\*/g)).toHaveLength(2);
    expect(r.upstream).toContain(`### ${guard.title}`);
    expect(r.upstream).toContain('`rules: K-SELF-11`');
    expect(r.upstream).toContain('Not sent, outside Kanon\'s vocabulary: `rules`, `kanon_paths`.');
    const vibes = r.upstream.slice(r.upstream.indexOf('### Something feels off'));
    expect(vibes).toContain('**Not sent to Kanon:**');
  });

  it('with `sent with evidence`, the text in the artifact equals the draft\'s, placeholders included', () => {
    const r = sending('sent with evidence');
    expect(r.code).toBe(0);
    const [g, l] = r.rows;
    expect(validate(g)).toEqual({ ok: true });
    expect(g!.evidence_level).toBe('evidence');
    expect(g!.scrub_version).toBe(1);
    expect(g!.evidence).toBe('**Expected:** K-SELF-11 holds.\n**Observed:** see [url] raised by [login] in [path].');
    expect(drafted(r.upstream, guard.title, 'evidence')).toBe(g!.evidence);
    expect(g!.suggested_fix).toBe('Re-read the range in scripts/overseer-file.mjs before judging.');
    expect(drafted(r.upstream, guard.title, 'suggested fix')).toBe(g!.suggested_fix);
    expect(drafted(r.upstream, lane.title, 'evidence')).toBe(l!.evidence);
    expect(r.upstream).toContain('`Upstream findings: sent with evidence`');
    expect(r.upstream).toMatch(/third-party decision provider/);
  });

  it('with `drafted`, `filed here` or nothing declared, no artifact', () => {
    for (const upstream of ['drafted', 'filed here', undefined]) {
      const r = sending(upstream);
      expect(r.written, String(upstream)).toEqual([]);
      expect(r.audit).not.toContain('Sent to Kanon');
    }
  });

  it('MUTATION: an agent `upstream.lane` outside the lane list is dropped, not sent', () => {
    const bad = finding('lane', 'A lane we made up', { upstream: { lane: 'acme-deploy', fix_category: 'lane-behaviour' } });
    const r = sending('sent', fixture([bad]));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).not.toHaveProperty('lane');
    expect(validate(r.rows[0])).toEqual({ ok: true });
    expect(JSON.stringify(r.rows)).not.toContain('acme-deploy');
    expect(r.upstream).toContain('Not sent, outside Kanon\'s vocabulary: `lane`.');
  });

  it('MUTATION: a report whose evidence holds the repository\'s own name sends `[name]`', () => {
    const named = finding('guard', 'A guard misses a case', { upstream: { fix_category: 'guard', evidence: 'The widget-shop review lane stopped, and acme-corp saw it.' } });
    const r = sending('sent with evidence', fixture([named]));
    expect(r.rows[0]!.evidence).toBe('The [name] review lane stopped, and [name] saw it.');
    expect(drafted(r.upstream, named.title, 'evidence')).toBe(r.rows[0]!.evidence);
  });

  it('removes a bare login the lane can see, with no `@`: a PR reviewer\'s, a commenter\'s, a collaborator\'s and the run\'s actor\'s', () => {
    const named = finding('guard', 'A guard misses a case', { upstream: { fix_category: 'guard', evidence: 'octo-reviewer, chatty-commenter, req-person, collab-person and run-actor saw it.' } });
    const r = sending('sent with evidence', fixture([named]));
    expect(r.rows[0]!.evidence).toBe('[name], [name], [name], [name] and [name] saw it.');
  });

  it('FAILS CLOSED: with the App register\'s names unread, or the participants unread, the text is withheld and the draft says why', () => {
    const noNames = sending('sent with evidence', fixture(), { nameHashes: null });
    expect(noNames.rows.map((x) => x.evidence_level)).toEqual(['codes', 'codes']);
    expect(noNames.upstream).toContain('The evidence and suggested fix were withheld, and the finding was sent as codes only: the App register\'s names were not read in the gate job.');
    const noParticipants = sending('sent with evidence', fixture(), { participants: 'throws' });
    expect(noParticipants.rows.map((x) => x.evidence_level)).toEqual(['codes', 'codes']);
    expect(noParticipants.upstream).toContain('the run\'s issue and pull request participants could not be read');
  });

  it('a collaborator list it can\'t read is not a failure: the plan reads them only where the token may', () => {
    const fake = sendingGh({});
    const gh = (args: string[], input?: string) => {
      if (args[0] === 'api') throw new Error('HTTP 403');
      return fake.gh(args, input);
    };
    const written: Array<Record<string, unknown>[]> = [];
    const log: string[] = [];
    fileAudit({ repo: REPO, text: fixture(), agentOutcome: 'success', gh, interlock: () => ({ count: 0 }), log: (l) => log.push(l), upstream: 'sent with evidence',
      send: { run: { id: 1, attempt: 1 }, tag: 'test', recordedAt: '2026-10-07T12:00:00.000Z', kanonVersion: '0.38.0', actor: 'a', nameHashes: [], isKanonFile: kanonFileIn(ROOT), write: (rows: Record<string, unknown>[]) => written.push(rows) } });
    expect(written.flat().map((x) => x.evidence_level)).toEqual(['evidence', 'evidence']);
    expect(log.join('\n')).toMatch(/collaborators could not be listed/);
  });

  it('a write that fails sends nothing, says so in each draft, and reds the step', () => {
    const r = sending('sent', fixture(), { write: 'throws' });
    expect(r.code).toBe(1);
    expect(r.upstream).not.toContain('**Sent to Kanon**');
    expect(r.upstream).toContain('**Not sent to Kanon:** the finding rows could not be written');
    expect(r.log.join('\n')).toMatch(/::error title=overseer finding rows::/);
  });

  it('without a place to write rows, sends nothing and warns', () => {
    const log: string[] = [];
    fileAudit({ repo: REPO, text: fixture(), agentOutcome: 'success', gh: sendingGh({}).gh, interlock: () => ({ count: 0 }), log: (l) => log.push(l), upstream: 'sent' });
    expect(log.join('\n')).toMatch(/::warning title=overseer finding rows::/);
  });
});
