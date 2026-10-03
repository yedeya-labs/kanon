import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers/adopter.js';
import { writeStub } from '../unit/helpers/stub-bin.js';
const P = await import('../../scripts/lib/protocol-spellings.mjs');
const { MERGER_LOGIN, apply, checkPartition, readPr } = await import('../../scripts/merge-gate.mjs');
const { execute, splitEvidenceRead } = await import('../../scripts/lead-reconcile.mjs');
const { censusOf } = await import('../../scripts/protocol-census.mjs');

/**
 * #53 — the strings another program reads by their exact text. Writers use the role-based
 * spelling; readers accept it AND the reference adopter's old one, until
 * `protocol-census.mjs` measures that no live artifact carries the old one. Each reader is
 * tested in both spellings, and each old spelling is written out here, so dropping one
 * before the census says so is a red test.
 */

const HEAD = 'ee4530d1111111111111111111111111111111111'.slice(0, 40);
const H12 = HEAD.slice(0, 12);

describe('the writers use the role-based spelling', () => {
  it('names no persona and no adopter issue', () => {
    expect(P.mergerMarker('checks-failed', HEAD)).toBe(`<!-- merger:checks-failed:${H12} -->`);
    expect(P.ESCALATION_HEADER).toBe('🚦 **Merger — not merging.**');
    expect(P.splitBranch(1694)).toBe('lead/split-1694');
    expect(P.adoptedNote(9)).toBe('Adopted into project #9 by the Lead');
    expect(Object.values(P.RETRY_STEPS)).toEqual([
      'Retryable once the cause clears: the model was unreachable',
      'Retryable once the cause clears: the model API failed mid-run',
    ]);
  });
});

describe('the readers accept both spellings', () => {
  it('reads a Merger marker in either spelling, and nothing else', () => {
    const body = `<!-- joshua:checks-failed:${H12} --> <!-- merger:merge-state:${H12} --> <!-- rebase-lane:${H12} -->`;
    expect(P.mergerMarkersIn(body)).toEqual([{ rule: 'checks-failed', sha: H12 }, { rule: 'merge-state', sha: H12 }]);
    expect(P.mergerMarkerSpellings('x', HEAD)).toEqual([`<!-- merger:x:${H12} -->`, `<!-- joshua:x:${H12} -->`]);
  });

  it('reads an escalation header in either spelling', () => {
    expect(P.isEscalation('🚦 **Joshua — not merging.**\n\nRule: x')).toBe(true);
    expect(P.isEscalation('🚦 **Merger — not merging.**\n\nRule: x')).toBe(true);
    expect(P.isEscalation('🔁 the Merger asked for a review')).toBe(false);
  });

  it('asks about every split branch and adoption sentence, the current one first', () => {
    expect(P.splitBranches(7)).toEqual(['lead/split-7', 'bezalel/split-7']);
    expect(P.adoptedNotes(7)).toEqual(['Adopted into project #7 by the Lead', 'Adopted into project #7 by Bezalel']);
  });

  it('knows both spellings of every caller name', () => {
    expect(P.SELF_CHECKS).toEqual(['Review (Reviewer)', 'Merge (Merger)', 'Review (Thomas)', 'Merge (Joshua)']);
    expect(P.REVIEW_EVENT_CHECKS).toEqual([
      { workflow: 'Implement (Implementer) — revise', job: 'revise / filter' },
      { workflow: 'Merge Reconcile (Reviewer)', job: 'reconcile / filter' },
      { workflow: 'Implement (Oholiab) — revise', job: 'revise / filter' },
      { workflow: 'Merge Reconcile (Thomas)', job: 'reconcile / filter' },
    ]);
  });
});

describe('the merge gate reads both spellings', () => {
  const running = (workflowName: string, name: string) => ({ name, workflowName, status: 'IN_PROGRESS', conclusion: null });

  it.each([
    ['current', 'Review (Reviewer)', 'Merge (Merger)', 'Implement (Implementer) — revise', 'Merge Reconcile (Reviewer)'],
    ['old', 'Review (Thomas)', 'Merge (Joshua)', 'Implement (Oholiab) — revise', 'Merge Reconcile (Thomas)'],
  ])('never waits on itself, its review or the review-event racers (%s names)', (_, review, merge, revise, reconcile) => {
    const p = checkPartition([
      running(review, 'review'), running(merge, 'merge'),
      running(revise, 'revise / filter'), running(reconcile, 'reconcile / filter'),
      { name: 'check', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ]);
    expect(p.relevant.map((c) => c.workflowName)).toEqual(['CI']);
    expect(p.pending).toEqual([]);
  });

  const applyWith = (verdict: Record<string, unknown>, said: string, labels: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), 'protocol-apply-'));
    writeStub(join(dir, 'gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/calls"
case "$*" in
  *"/comments"*) printf '%s' ${JSON.stringify(said)} ;;
esac
`);
    const prev = process.env.PATH;
    process.env.PATH = `${dir}:${prev}`;
    try {
      apply({ number: 7, headSha: HEAD, labels }, verdict, 'o/r', { dryRun: false });
    } finally {
      process.env.PATH = prev;
    }
    try { return readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean); } catch { return []; }
  };
  const escalate = { action: 'escalate', rule: 'escalating-path', why: 'x', quiet: false };

  it('writes the current header and marker', () => {
    // The body spans lines, so the log is read whole.
    const comment = applyWith(escalate, '').join('\n');
    expect(comment).toMatch(/^pr comment 7 /m);
    expect(comment).toContain('🚦 **Merger — not merging.**');
    expect(comment).toContain(`<!-- merger:escalating-path:${H12} -->`);
    expect(comment).not.toMatch(/joshua/i);
  });

  it.each([['current', 'merger'], ['old', 'joshua']])('does not repeat an escalation already marked in the %s spelling', (_, m) => {
    const calls = applyWith(escalate, `<!-- ${m}:escalating-path:${H12} -->`, ['needs:human']);
    expect(calls.some((c) => c.startsWith('pr comment'))).toBe(false);
  });

  it('reads who escalated from comments in either spelling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'protocol-read-'));
    const bot = `${MERGER_LOGIN}[bot]`;
    const comments = [
      { login: bot, body: `🚦 **Joshua — not merging.**\n\n<!-- joshua:checks-failed:${H12} -->` },
      { login: bot, body: `🚦 **Merger — not merging.**\n\n<!-- merger:merge-state:${H12} -->` },
      // A recover marker has the same shape and is not an escalation.
      { login: bot, body: `🔁 the Merger asked … <!-- merger:no-review-on-head:${H12} -->` },
    ].map((c) => JSON.stringify(c)).join('\n');
    const meta = {
      number: 1234, author: { login: 'example-implementer[bot]' }, state: 'OPEN', isDraft: false,
      labels: [{ name: 'agent:implement' }, { name: 'needs:human' }], headRefOid: HEAD, statusCheckRollup: [],
      mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', title: 't', body: 'Closes #1',
      closingIssuesReferences: [{ number: 1 }], commits: [{ messageHeadline: 'x', messageBody: '' }],
    };
    writeStub(join(dir, 'gh'), `#!/usr/bin/env bash
case "$*" in
  "run list"*) echo '[]' ;;
  *"/events"*) echo ${JSON.stringify(bot)} ;;
  *"/1234/comments"*) cat <<'__OUT__'
${comments}
__OUT__
 ;;
  "pr view"*) printf '%s' '${JSON.stringify(meta)}' ;;
  *"/reviews"*) echo '[]' ;;
  *) echo '' ;;
esac
`);
    const read = readPr(1234, 'o/r', { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    expect(read.hold?.escalations).toEqual([{ rule: 'checks-failed', sha: H12 }, { rule: 'merge-state', sha: H12 }]);
  });
});

describe('the Lead reads both spellings', () => {
  it('finds a split pull request on either branch', () => {
    const asked: string[] = [];
    const ev = splitEvidenceRead(42, {
      text: () => '',
      json: (args: string[]) => {
        const head = args[args.indexOf('--head') + 1]!;
        asked.push(head);
        return head === 'bezalel/split-42' ? [{ number: 5, state: 'OPEN', createdAt: 'x' }] : [];
      },
    });
    expect(asked).toEqual(['lead/split-42', 'bezalel/split-42']);
    expect(ev?.prs).toEqual([{ number: 5, state: 'OPEN', createdAt: 'x' }]);
  });

  it.each([['current', 'the Lead'], ['old', 'Bezalel']])('writes the adoption sentence once, not again after the %s one', (_, by) => {
    const edits = (body: string) => {
      const calls: string[][] = [];
      execute({ project: 9, briefPath: 'docs/projects/9.md' }, [{ kind: 'adopt', number: 3, title: 'T' }], {
        run: (args: string[]) => {
          calls.push(args);
          return args[1] === 'view' ? JSON.stringify({ body, milestone: null, labels: [] }) : '';
        },
      });
      return calls.find((a) => a[1] === 'edit' && a.includes('--body'));
    };
    const fresh = edits('work');
    expect(fresh?.[fresh.indexOf('--body') + 1]).toContain('Adopted into project #9 by the Lead, from');
    const again = edits(`work\n\nAdopted into project #9 by ${by}, from the item.`);
    expect(again?.[again.indexOf('--body') + 1]).not.toContain('by the Lead, from the decomposition');
  });
});

describe('the census measures when the old spellings can go', () => {
  it('finds each old spelling a live artifact carries', () => {
    const found = censusOf({
      callers: [{ file: 'a.yml', name: 'Review (Thomas)' }, { file: 'b.yml', name: 'Review (Reviewer)' }],
      prs: [{
        number: 1, headRefName: 'bezalel/split-4',
        comments: [{ body: `🚦 **Joshua — not merging.**\n<!-- joshua:x:${H12} -->` }],
        statusCheckRollup: [{ workflowName: 'Merge Reconcile (Thomas)' }],
      }],
      issues: [{ number: 2, body: 'Adopted into project #9 by Bezalel, from x' }, { number: 3, body: 'Adopted into project #9 by the Lead' }],
      branches: ['bezalel/split-4', 'lead/split-5'],
      failedJobs: { 1: [{ name: 'review', steps: [{ name: `${P.RETRY_STEPS.unreachable} (#2519)`, conclusion: 'success' }] }] },
    });
    expect(found.map((f: { protocol: string, where: string }) => `${f.protocol} @ ${f.where}`)).toEqual([
      'caller name @ a.yml',
      'merger marker @ PR #1',
      'escalation header @ PR #1',
      'caller name @ PR #1 (a check on its head)',
      'split branch @ PR #1',
      'retry breadcrumb @ PR #1 (job review)',
      'adoption note @ issue #2',
      'split branch @ branch bezalel/split-4',
    ]);
  });

  it('finds nothing in a world written only in the current spelling', () => {
    expect(censusOf({
      callers: [{ file: 'b.yml', name: 'Review (Reviewer)' }],
      prs: [{
        number: 1, headRefName: 'lead/split-4', comments: [{ body: `${P.ESCALATION_HEADER}\n${P.mergerMarker('x', HEAD)}` }],
        statusCheckRollup: [{ workflowName: 'Merge (Merger)' }],
      }],
      issues: [{ number: 3, body: 'Adopted into project #9 by the Lead' }],
      branches: ['lead/split-5'],
      failedJobs: { 1: [{ name: 'review', steps: [{ name: P.RETRY_STEPS.unreachable, conclusion: 'success' }] }] },
    })).toEqual([]);
  });
});

describe('no persona name outside the protocol strings (#53)', () => {
  // The reference adopter's agents' names. Only `lib/protocol-spellings.mjs` may hold one,
  // as an old spelling a reader still accepts; once the census finds none and those are
  // deleted, this list's allowance goes too.
  const PERSONAS = /\b(joshua|bezalel|oholiab|thomas|caleb|nehemiah)\b/i;
  const ALLOWED = new Set(['scripts/lib/protocol-spellings.mjs']);
  const library = execFileSync('git', ['ls-files', 'scripts', 'actions', '.github', 'cli', 'rulebook'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);

  it('names none in the library, the lanes, the actions or the rulebook', () => {
    expect(library.length).toBeGreaterThan(50);
    const hits = library.filter((f) => !ALLOWED.has(f) && PERSONAS.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(hits).toEqual([]);
  });

  it('holds its old spellings only in the LEGACY_ constants', () => {
    const lines = readFileSync(join(ROOT, 'scripts/lib/protocol-spellings.mjs'), 'utf8').split('\n');
    const code = lines.filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l));
    const outside = code.filter((l) => PERSONAS.test(l) && !/^(const LEGACY_\w+ = |\s+\{ workflow: ')/.test(l));
    expect(outside).toEqual([]);
  });
});
