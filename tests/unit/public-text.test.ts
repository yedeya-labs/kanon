import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { FORBIDDEN_WORD_HASHES, check, forbiddenParts, sha256 } from '../../.github/scripts/public-words.mjs';

// #239: the reference adopter's names must not reach main through the squash commit, whose
// message is the PR's title and body. The real names can't appear here, so the script's
// logic runs against a stand-in list holding the hash of a made-up word.
const STAND_IN = 'zorblaxian';
const HASHES = new Set([sha256(STAND_IN)]);

describe('#239 the PR-text check finds a forbidden word in the title or the body', () => {
  it('passes clean text', () => {
    expect(forbiddenParts({ title: 'fix: a clean title', body: 'A clean body.' }, HASHES)).toEqual([]);
    expect(check({ PR_TITLE: 'fix: a clean title', PR_BODY: 'A clean body.' }, HASHES).code).toBe(0);
  });

  it('finds the word in the title, and in the body, and says which', () => {
    expect(forbiddenParts({ title: `fix: the ${STAND_IN} case`, body: '' }, HASHES)).toEqual(['the title']);
    expect(forbiddenParts({ title: 'fix: x', body: `Seen in ${STAND_IN}.` }, HASHES)).toEqual(['the body']);
    expect(forbiddenParts({ title: STAND_IN, body: STAND_IN }, HASHES)).toEqual(['the title', 'the body']);
  });

  it('finds it whatever its case, and inside a URL, a path or a hyphenated word', () => {
    for (const body of [STAND_IN.toUpperCase(), `https://example.com/${STAND_IN}/x`, `src/${STAND_IN}.ts`, `the ${STAND_IN}-app`]) {
      expect(forbiddenParts({ body }, HASHES), body).toEqual(['the body']);
    }
  });

  it('matches whole words only, not a word that merely contains it', () => {
    expect(forbiddenParts({ body: `${STAND_IN}s and pre${STAND_IN}` }, HASHES)).toEqual([]);
  });

  it('fails the run with an annotation that never prints the word, and says to delete the old revisions', () => {
    const { code, message } = check({ PR_TITLE: 'fix: x', PR_BODY: `Seen in ${STAND_IN}.` }, HASHES);
    expect(code).toBe(1);
    expect(message).toMatch(/^::error /);
    expect(message.toLowerCase()).not.toContain(STAND_IN);
    expect(message).toContain('the body');
    expect(message).toContain('delete each revision');
    expect(message).not.toContain('\n');
  });

  it('reads an unset title or body as empty', () => {
    expect(check({}, HASHES).code).toBe(0);
  });

  it('checks against the real list by default, the one the tree guard uses', () => {
    expect(FORBIDDEN_WORD_HASHES.size).toBeGreaterThan(0);
    for (const h of FORBIDDEN_WORD_HASHES) expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(check({ PR_TITLE: 'fix: a clean title', PR_BODY: 'A clean body.' })).toEqual({
      code: 0,
      message: 'Neither the title nor the body names the reference adopter.',
    });
  });

  it('runs as a script, exiting 0 on clean text', () => {
    const out = execFileSync('node', ['.github/scripts/public-words.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, PR_TITLE: 'fix: a clean title', PR_BODY: 'A clean body.' },
    });
    expect(out.trim()).toBe('Neither the title nor the body names the reference adopter.');
  });
});

type Step = { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { name?: string; if?: string; strategy?: unknown; permissions?: unknown; steps: Step[] };
type Workflow = { on: Record<string, { types?: string[] } | null>; permissions?: Record<string, string>; jobs: Record<string, Job> };

describe('#239 public-text.yml runs the check on every change to the title or body', () => {
  const wf = parse(readFileSync('.github/workflows/public-text.yml', 'utf8')) as Workflow;
  const jobs = Object.values(wf.jobs);
  const steps = jobs.flatMap((j) => j.steps);

  it('runs when a PR is opened, edited, pushed to or reopened, and in the merge queue', () => {
    expect(wf.on.pull_request?.types).toEqual(expect.arrayContaining(['opened', 'edited', 'synchronize', 'reopened']));
    expect(Object.keys(wf.on)).toContain('merge_group');
  });

  it('is one job, under one literal name, skipped on no event (K-MERGE-7)', () => {
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe('No reference-adopter names');
    expect(jobs[0]?.if).toBeUndefined();
    expect(jobs[0]?.strategy).toBeUndefined();
  });

  it('passes on merge_group without checking, and checks only on pull_request', () => {
    const onQueue = steps.filter((s) => s.if === "github.event_name == 'merge_group'");
    expect(onQueue).toHaveLength(1);
    expect(onQueue[0]?.uses).toBeUndefined();
    expect(steps.filter((s) => s !== onQueue[0]).every((s) => s.if === "github.event_name == 'pull_request'")).toBe(true);
  });

  it("judges with the base commit's script, never the PR's own copy (#47)", () => {
    const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.ref).toBe('${{ github.event.pull_request.base.sha }}');
    expect(checkout?.with?.['persist-credentials']).toBe(false);
    const run = steps.find((s) => s.run?.includes('public-words.mjs'));
    expect(run?.run).toContain('node .github/scripts/public-words.mjs');
  });

  it('passes the title and body through env, never interpolated into a run line (K-AGENT-45)', () => {
    const run = steps.find((s) => s.run?.includes('public-words.mjs'));
    expect(run?.env).toEqual({
      PR_TITLE: '${{ github.event.pull_request.title }}',
      PR_BODY: '${{ github.event.pull_request.body }}',
    });
    for (const s of steps) expect(s.run ?? '').not.toContain('${{');
  });

  it('reads contents only', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    for (const j of jobs) expect(j.permissions).toBeUndefined();
  });
});
