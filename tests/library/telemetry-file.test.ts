import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers/adopter.js';
import { validate } from '../../actions/agent-telemetry/schema.mjs';
import { kanonFileIn } from '../../scripts/lib/finding-rows.mjs';
import { checkAggregate } from '../../scripts/aggregate-read.mjs';
import {
  LABELS,
  MAX_FILED,
  milestoneFor,
  checkFinding,
  fileFindings,
  parseReport,
  proseProblem,
  renderEvidence,
  signatureIn,
  signatureOf,
} from '../../scripts/telemetry-file.mjs';

/**
 * Plan 0004 step 14 (decision 13) and plan 0002 §6.1, item 3: the telemetry Explorer files what
 * is wrong, never another adopter's numbers. Its agent's token reads only; this step checks each
 * finding against the aggregate the lane read and files it, or refuses it. An issue's figures are
 * rendered here from the aggregate, so the only figures it can hold are a cross-adopter cell's,
 * an own cell's or a signal's, and the agent's prose holds none. The Explorer's filing gate
 * (`K-AGENT-9`): a finding on a failure signal is a bug, one on cells alone a spec delta, and an
 * open issue with the same signature gets a comment instead of a second issue.
 */

const ownCell = { lane: 'review', model: 'claude-opus-5-5', runs: 47, median_cost_usd: 0.4213, p90_cost_usd: 3.0987 };
const crossCell = { lane: 'implement', model: 'claude-opus-5-5', runs: 311, median_cost_usd: 2.5, p90_cost_usd: 6.25 };
const sig = { lane: 'review', reason: 'did_not_finish', failed_stage: 'agent', kanon_error: null, kanon_version: '0.32.0', adopters_affected: 2 };
const AGG = {
  computed_at: '2026-10-07T12:00:00.000Z', min_adopters: 3, signal_days: 7,
  cross_adopter: [crossCell], own: [{ label: 'kanon', cells: [ownCell] }], signals: [sig],
};
const A = checkAggregate(AGG);
const sigRef = { lane: 'review', reason: 'did_not_finish', failed_stage: 'agent', kanon_error: null, kanon_version: '0.32.0' };
const ownRef = { source: 'own', label: 'kanon', lane: 'review', model: 'claude-opus-5-5' };
const crossRef = { source: 'cross_adopter', lane: 'implement', model: 'claude-opus-5-5' };
const finding = (extra: Record<string, unknown> = {}) => ({
  title: 'The review lane stops in its agent stage on Kanon 0.32.0',
  body: 'Runs of the review lane end without finishing, at the agent stage, on 0.32.0 only, at more than one adopter (#41).',
  severity: 'sev:medium', signals: [sigRef], cells: [], ...extra,
});
const report = (findings: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ examined: 'every cell and signal', held_back: [], findings, ...extra });

type Call = { args: string[]; input?: string };
const fakeGh = (open: Array<{ number: number; body: string }> = []) => {
  const calls: Call[] = [];
  let next = 100;
  const gh = (args: string[], input?: string) => {
    calls.push({ args, input });
    if (args[0] === 'issue' && args[1] === 'create') return `https://github.com/o/r/issues/${next++}\n`;
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(open);
    return '';
  };
  return { gh, calls, creates: () => calls.filter((c) => c.args[1] === 'create'), comments: () => calls.filter((c) => c.args[1] === 'comment') };
};
const run = (text: string | null, gh = fakeGh(), aggregateText: string | null = JSON.stringify(AGG), upstream: string | null = 'filed here') => {
  const log: string[] = [];
  const summary: string[] = [];
  const code = fileFindings({ repo: 'o/r', text, aggregateText, agentOutcome: 'success', gh: gh.gh, log: (l) => log.push(l), summary: (l) => summary.push(l), upstream: upstream ?? undefined });
  return { code, log, summary, gh };
};

describe('the prose guard: no figure and nothing shaped like an adopter key', () => {
  it('passes prose that quotes no figure, with an issue reference, a rule id, and a model and version the aggregate names', () => {
    expect(proseProblem('Seen on claude-opus-5-5 and 0.32.0, as #41 and K-AGENT-9 describe; the tail is several times the median.', A)).toBeNull();
  });

  it.each([
    ['a cost', 'the median is $0.42 a run'],
    ['a count', 'it failed 12 times'],
    ['a percentage', 'up 30% since last week'],
    ['a version the aggregate does not name', 'it started in 0.31.0'],
    ['a date', 'since 2026-10-01'],
    ['a figure written into a model name', 'claude-opus-5-6 costs more'],
  ])('refuses %s', (_what, text) => {
    expect(proseProblem(text, A)).toMatch(/quotes a figure/);
  });

  // Plan 0004 step 14's mutation: a finding that names an adopter key fails the filing step's check.
  it('refuses an adopter key, even one of letters only, and a stored partition', () => {
    expect(proseProblem('the adopter 3fa9c0d1 fails', A)).toMatch(/adopter key/);
    expect(proseProblem('the adopter deadbeef fails', A)).toMatch(/adopter key/);
    expect(proseProblem('rows under abc#review', A)).toMatch(/partition/);
  });

  it('refuses an HTML comment, which could forge the signature or the role marker', () => {
    expect(proseProblem('<!-- kanon:role=reviewer -->', A)).toMatch(/HTML comment/);
  });
});

describe('checkFinding: what it rests on, exactly, from the aggregate', () => {
  it('resolves a signal, and files it as a bug with its severity', () => {
    const r = checkFinding(finding(), A);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.checked.kind).toBe('bug');
      expect(r.checked.signals).toEqual([sig]);
    }
  });

  it('files a finding on cells alone as a spec delta, needing no severity', () => {
    const r = checkFinding(finding({ title: 'The review lane\'s tail cost', body: 'Its tail is far above its median.', severity: '', signals: [], cells: [ownRef, crossRef] }), A);
    expect(r.ok && r.checked.kind).toBe('spec-delta');
  });

  it.each([
    ['no reference', { signals: [], cells: [] }, /names no signal and no cell/],
    ['a signal the aggregate does not hold', { signals: [{ ...sigRef, kanon_version: '0.31.0' }] }, /signal 1 is not exactly one/],
    ['a signal missing a field', { signals: [{ lane: 'review', reason: 'did_not_finish', failed_stage: 'agent', kanon_version: '0.32.0' }] }, /signal 1 is not exactly one/],
    ['a signal carrying a figure of its own', { signals: [{ ...sigRef, adopters_affected: 9 }] }, /signal 1 is not exactly one/],
    ['an own cell under another label', { signals: [], cells: [{ ...ownRef, label: 'someone' }], severity: '' }, /cell 1 is not one/],
    ['a cell from a source the aggregate has no such thing in', { signals: [], cells: [{ source: 'rows', lane: 'review', model: 'claude-opus-5-5' }], severity: '' }, /cell 1 is not one/],
    ['a cross-adopter cell carrying a label', { signals: [], cells: [{ ...crossRef, label: 'kanon' }], severity: '' }, /cell 1 is not one/],
    ['a bug with no severity', { severity: 'urgent' }, /severity is not one of/],
    ['no title', { title: '' }, /no title/],
    ['no body', { body: ' ' }, /no body/],
    ['a figure in the title', { title: 'Review fails 3 times' }, /quotes a figure/],
  ])('refuses %s', (_what, extra, why) => {
    const r = checkFinding(finding(extra), A);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toMatch(why);
  });

  it('signs by what it rests on, never by a figure, so this week\'s figures match last week\'s issue', () => {
    const a = signatureOf('bug', [sig], []);
    expect(signatureOf('bug', [{ ...sig, adopters_affected: 5 }], [])).toBe(a);
    expect(signatureOf('spec-delta', [sig], [])).not.toBe(a);
    expect(signatureOf('bug', [{ ...sig, kanon_version: '0.33.0' }], [])).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe('renderEvidence: the figures come from the aggregate, not the agent', () => {
  it('renders the signal and the cells it rests on, and the signature', () => {
    const r = checkFinding(finding({ cells: [ownRef, crossRef] }), A);
    if (!r.ok) throw new Error(r.why);
    const text = renderEvidence(r.checked, A);
    expect(text).toContain('| `review` | `did_not_finish` | `agent` | — | `0.32.0` | 2 |');
    expect(text).toContain('| own: kanon | `review` | `claude-opus-5-5` | 47 | $0.4213 | $3.0987 |');
    expect(text).toContain('| cross-adopter (at least 3 adopters) | `implement` | `claude-opus-5-5` | 311 | $2.50 | $6.25 |');
    expect(signatureIn(text)).toBe(r.checked.signature);
  });
});

describe('fileFindings', () => {
  it('files a bug in the bucket the project\'s routing gives its labels (K-WORK-4, kanon#476), with the Explorer\'s labels, signed, prose first and the figures after', () => {
    const { code, gh } = run(report([finding()]));
    expect(code).toBe(0);
    const [create] = gh.creates();
    expect(create!.args).toEqual(['issue', 'create', '--repo', 'o/r', '--title', finding().title, '--body-file', '-',
      ...[...LABELS.bug, 'sev:medium'].flatMap((l) => ['--label', l]), '--milestone', 'Product Backlog']);
    expect(create!.input).toMatch(/^\*\*Explorer\*\* <!-- kanon:role=explorer -->\n\nRuns of the review lane/);
    expect(create!.input).toContain('## What the aggregate shows');
  });

  it('files a spec delta with its two labels and no severity', () => {
    const { gh } = run(report([finding({ title: 'A tail cost', body: 'The tail is far above the median.', severity: 'sev:high', signals: [], cells: [ownRef] })]));
    const labels = gh.creates()[0]!.args.filter((_, i, a) => a[i - 1] === '--label');
    expect(labels).toEqual(LABELS['spec-delta']);
    expect(gh.creates()[0]!.args.at(-1)).toBe('Product Backlog');
  });

  it('files nothing and stays green when there are no findings', () => {
    const { code, gh, log } = run(report([]));
    expect(code).toBe(0);
    expect(gh.calls).toEqual([]);
    expect(log).toContain('No findings this run: nothing to file.');
  });

  it('refuses a finding that breaks the rules, files the others, and turns the step red', () => {
    const { code, gh, log, summary } = run(report([finding({ body: 'It failed 12 times.' }), finding({ title: 'Another', signals: [{ ...sigRef }], cells: [crossRef] })]));
    expect(code).toBe(1);
    expect(gh.creates()).toHaveLength(1);
    expect(log.join('\n')).toMatch(/finding 1: its prose quotes a figure.*It was not filed/);
    // The refusal names the finding by position, never by its text.
    expect(summary.join('\n')).not.toContain('12 times');
  });

  it('refuses a finding that names an adopter key (plan 0004 step 14\'s mutation)', () => {
    const { code, gh } = run(report([finding({ body: 'Adopter 3fa9c0d1 is the one failing.' })]));
    expect(code).toBe(1);
    expect(gh.creates()).toEqual([]);
  });

  it('comments on the open issue with the same signature instead of filing again', () => {
    const r = checkFinding(finding(), A);
    if (!r.ok) throw new Error(r.why);
    const { code, gh } = run(report([finding()]), fakeGh([{ number: 41, body: `old\n<!-- kanon:telemetry-signature=${r.checked.signature} -->` }]));
    expect(code).toBe(0);
    expect(gh.creates()).toEqual([]);
    expect(gh.comments()[0]!.args.slice(0, 3)).toEqual(['issue', 'comment', '41']);
    expect(gh.comments()[0]!.input).toContain('| `review` | `did_not_finish` |');
  });

  it(`files at most ${MAX_FILED} a run, and one per signature`, () => {
    const many = ['lead', 'triage', 'rebase', 'merge'].map((lane) => finding({ title: `The ${lane} lane`, signals: [sigRef], cells: [{ source: 'own', label: 'kanon', lane: 'review', model: 'claude-opus-5-5' }], body: `About ${lane}.` }));
    const { gh, summary } = run(report([finding(), finding(), ...many]));
    // The first two share a signature, and so do the four others with each other.
    expect(gh.creates()).toHaveLength(2);
    expect(summary.join('\n')).toMatch(/same signature/);
    const distinct = ['implement', 'review'].flatMap((lane) => [
      finding({ title: `${lane} a`, signals: [], severity: '', cells: [lane === 'review' ? ownRef : crossRef] }),
    ]);
    const all = run(report([finding(), ...distinct, finding({ title: 'both', cells: [ownRef, crossRef] })]));
    expect(all.gh.creates()).toHaveLength(MAX_FILED);
    expect(all.summary.join('\n')).toMatch(/issues were filed this run already/);
  });

  it('reds and files nothing with no report, an unparseable one, one that says nothing of what was examined, or no aggregate', () => {
    expect(run(null).code).toBe(1);
    expect(run('{').code).toBe(1);
    expect(run(JSON.stringify({ findings: [] })).code).toBe(1);
    const noAgg = run(report([finding()]), fakeGh(), null);
    expect(noAgg.code).toBe(1);
    expect(noAgg.gh.calls).toEqual([]);
    // An aggregate below the threshold is not one this step will judge against.
    expect(run(report([finding()]), fakeGh(), JSON.stringify({ ...AGG, min_adopters: 2 })).code).toBe(1);
  });

  it('reds and files nothing when the open issues can\'t be listed, rather than filing duplicates', () => {
    const gh = fakeGh();
    const failing = { ...gh, gh: (args: string[], input?: string) => { if (args[1] === 'list') throw new Error('HTTP 502'); return gh.gh(args, input); } };
    const r = run(report([finding()]), failing);
    expect(r.code).toBe(1);
    expect(gh.creates()).toEqual([]);
  });
});

describe('parseReport', () => {
  it('reads the report, and defaults what an agent may leave out', () => {
    expect(parseReport(report([]))).toEqual({ examined: 'every cell and signal', held_back: [], findings: [] });
    expect(parseReport(JSON.stringify({ examined: 'x' })).findings).toEqual([]);
  });
  it('refuses held_back that is not a list of strings, and findings that are not an array', () => {
    expect(() => parseReport(JSON.stringify({ examined: 'x', held_back: [1] }))).toThrow(/held_back/);
    expect(() => parseReport(JSON.stringify({ examined: 'x', findings: {} }))).toThrow(/findings/);
  });
});

describe('drafted, unless the repository declares `filed here` (kanon#471, as the Overseer, kanon#426)', () => {
  it.each([null, '', 'drafted', 'filed elsewhere'])('with UPSTREAM %j, files, comments and lists nothing, and drafts each checked finding in the summary', (upstream) => {
    const { code, gh, summary, log } = run(report([finding(), finding({ title: 'A tail cost', body: 'The tail is far above the median.', severity: '', signals: [], cells: [ownRef] })]), fakeGh(), JSON.stringify(AGG), upstream);
    expect(code).toBe(0);
    expect(gh.calls).toEqual([]);
    const text = summary.join('\n');
    expect(text).toContain(`### Draft: ${finding().title}\n\nLabels: \`bug\`, \`agent:explorer\`, \`qa:needs-triage\`, \`sev:medium\`. Milestone: Product Backlog.`);
    expect(text).toContain('### Draft: A tail cost\n\nLabels: `spec-delta`, `agent:explorer`. Milestone: Product Backlog.');
    expect(text).toContain('| own: kanon | `review` | `claude-opus-5-5` | 47 | $0.4213 | $3.0987 |');
    expect(log.join('\n')).toContain('none filed');
    if (upstream === 'filed elsewhere') expect(log.join('\n')).toMatch(/neither `drafted` nor `filed here`/);
  });

  it('still refuses a finding that breaks the rules, never drafting it, and turns red', () => {
    const { code, summary } = run(report([finding({ body: 'Adopter 3fa9c0d1 fails.' })]), fakeGh(), JSON.stringify(AGG), 'drafted');
    expect(code).toBe(1);
    expect(summary.join('\n')).not.toContain('### Draft');
    expect(summary.join('\n')).not.toContain('3fa9c0d1');
  });

  it('drafts one finding per signature', () => {
    const { summary } = run(report([finding(), finding({ title: 'The same, again' })]), fakeGh(), JSON.stringify(AGG), 'drafted');
    expect(summary.filter((l) => l.includes('### Draft'))).toHaveLength(1);
    expect(summary.join('\n')).toMatch(/"The same, again": another finding this run has the same signature/);
  });

  it('files only with `filed here`, exactly', () => {
    expect(run(report([finding()]), fakeGh(), JSON.stringify(AGG), 'filed here').gh.creates()).toHaveLength(1);
  });
});

describe('milestoneFor: the backstop\'s routing, never a fixed bucket (K-WORK-4, kanon#476)', () => {
  it('routes by the labels, as the backstop does for every filer', () => {
    expect(milestoneFor([...LABELS.bug, 'sev:high'])).toBe('Product Backlog');
    expect(milestoneFor(LABELS['spec-delta'])).toBe('Product Backlog');
    expect(milestoneFor([...LABELS['spec-delta'], 'pipeline-improvement'])).toBe('Development Automation');
  });
});

// Plan 0006 §5, steps 1 and 2 (F3, kanon#588). With `sent` or `sent with evidence`, each drafted
// finding is also written as a finding row for Kanon's telemetry store: its codes are the signal
// it rests on, checked against the aggregate, never the agent's own; its text is the report's
// `upstream.evidence` and `upstream.suggested_fix`, through the scrub, and through the same
// figure check the prose gets, since the draft is the run's summary.
describe('findings sent to Kanon (plan 0006 §5, F3)', () => {
  const REPO = 'acme-corp/widget-shop';
  const sending = (upstream: string | null, findings: unknown[], o: { nameHashes?: string[] | null } = {}) => {
    const gh = fakeGh();
    const written: Array<Record<string, unknown>[]> = [];
    const summary: string[] = [];
    const log: string[] = [];
    const code = fileFindings({
      repo: REPO, text: report(findings), aggregateText: JSON.stringify(AGG), agentOutcome: 'success', gh: gh.gh,
      log: (l) => log.push(l), summary: (l) => summary.push(l), upstream: upstream ?? undefined,
      send: {
        run: { id: 99, attempt: 2 }, tag: 'test', recordedAt: '2026-10-07T12:00:00.000Z', kanonVersion: '0.38.0', actor: 'run-actor',
        nameHashes: o.nameHashes === undefined ? [] : o.nameHashes, isKanonFile: kanonFileIn(ROOT), write: (rows: Record<string, unknown>[]) => written.push(rows),
      },
    });
    return { code, gh, written, rows: written.flat(), summary: summary.join('\n'), log };
  };
  const withUpstream = (upstream: Record<string, unknown>, extra: Record<string, unknown> = {}) => finding({ upstream, ...extra });

  it('with `sent`, writes one row per drafted finding at `codes`, from the signal it rests on, and files nothing', () => {
    const r = sending('sent', [withUpstream({ lane: 'implement', reason: 'turn_cap', fix_category: 'lane-behaviour', rules: ['K-AGENT-9'], evidence: 'some text' })]);
    expect(r.code).toBe(0);
    expect(r.gh.calls).toEqual([]);
    expect(r.rows).toHaveLength(1);
    expect(validate(r.rows[0])).toEqual({ ok: true });
    // The signal's codes, not the agent's: `implement` and `turn_cap` are its own claim.
    expect(r.rows[0]).toEqual({
      schema_version: 1, row_kind: 'finding', tag: 'test', recorded_at: '2026-10-07T12:00:00.000Z', run_id: 99, run_attempt: 2, finding_index: 0,
      reporter: 'explore-telemetry', subject: 'lane', lane: 'review', failed_stage: 'agent', reason: 'did_not_finish', kanon_version: '0.32.0',
      rules: 'K-AGENT-9', fix_category: 'lane-behaviour', evidence_level: 'codes',
    });
    expect(r.summary).toContain('**Sent to Kanon**');
    expect(r.summary).toMatch(/1 finding row\(s\) written for Kanon's telemetry store, at `codes`/);
  });

  it('a finding on cells alone is about the cell\'s lane, at the lane\'s own release', () => {
    const r = sending('sent', [withUpstream({ fix_category: 'other' }, { title: 'A tail cost', body: 'The tail is far above the median.', severity: '', signals: [], cells: [ownRef] })]);
    expect(r.rows[0]).toMatchObject({ lane: 'review', kanon_version: '0.38.0', subject: 'lane' });
    expect(r.rows[0]).not.toHaveProperty('reason');
  });

  it('with `sent with evidence`, the text in the artifact equals the draft\'s, placeholders included', () => {
    const r = sending('sent with evidence', [withUpstream({ fix_category: 'lane-behaviour', evidence: '**Observed:** the review lane stops at its agent stage; widget-shop saw it, per https://example.test/x.', suggested_fix: 'Ask @someone first.' })]);
    const row = r.rows[0]!;
    expect(validate(row)).toEqual({ ok: true });
    expect(row.evidence).toBe('**Observed:** the review lane stops at its agent stage; [name] saw it, per [url]');
    expect(row.suggested_fix).toBe('Ask [login] first.');
    const at = (what: string) => new RegExp(`Its ${what}, as sent:\\n\\n(\`{3,})text\\n([\\s\\S]*?)\\n\\1\\n`).exec(r.summary)?.[2];
    expect(at('evidence')).toBe(row.evidence);
    expect(at('suggested fix')).toBe(row.suggested_fix);
  });

  it('FAILS CLOSED: evidence that quotes a figure is withheld, as the prose would be refused, and the draft says why', () => {
    const r = sending('sent with evidence', [withUpstream({ fix_category: 'lane-behaviour', evidence: 'It failed 12 times this week.' })]);
    expect(r.rows[0]!.evidence_level).toBe('codes');
    expect(r.summary).toMatch(/withheld, and the finding was sent as codes only: its prose quotes a figure/);
    expect(r.summary).not.toContain('12 times');
  });

  it('FAILS CLOSED: without the App register\'s names, the text is withheld', () => {
    const r = sending('sent with evidence', [withUpstream({ fix_category: 'lane-behaviour', evidence: 'plain words' })], { nameHashes: null });
    expect(r.rows[0]!.evidence_level).toBe('codes');
  });

  it('with `drafted` or `filed here`, no artifact', () => {
    for (const upstream of ['drafted', 'filed here', null]) {
      expect(sending(upstream, [withUpstream({ fix_category: 'guard' })]).written, String(upstream)).toEqual([]);
    }
  });

  it('sends no refused finding, and one row per signature', () => {
    const r = sending('sent', [finding(), finding({ title: 'The same, again' }), finding({ body: 'Adopter 3fa9c0d1 fails.' })]);
    expect(r.rows).toHaveLength(1);
    expect(r.code).toBe(1);
  });
});
