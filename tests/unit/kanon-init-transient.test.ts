import { describe, expect, it, vi } from 'vitest';
import { realDeps as initDeps } from '../../cli/init.mjs';
import { RATE_LINE, realDeps as milestonesDeps } from '../../cli/milestones.mjs';
import { RETRYING, TRANSIENT_WHY } from '../../cli/gh-retry.mjs';
import { SPAWNS } from './helpers/spawns.js';
import { checkout, fakeGitHub, parse, run } from './helpers/kanon-init.js';

// kanon#1607 point 9: init created 38 of 39 labels, then GitHub's secondary rate limit refused
// the rest, the milestones, the merge settings and the ruleset, and init reported each as a
// permission the token had just been shown to hold. The real `gh` retries such answers
// (cli/gh-retry.mjs); what still fails is reported as GitHub limiting the rate, never as a
// permission, which is named only on a 403 without a rate-limit marker, or a 404.
vi.setConfig({ testTimeout: SPAWNS.timeout });

const SECONDARY = 'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)';

describe('init and a transient GitHub failure (#1607)', () => {
  it('runs init and kanon milestones through the retrying gh', () => {
    expect((initDeps.gh as unknown as Record<symbol, unknown>)[RETRYING]).toBe(true);
    expect((milestonesDeps.gh as unknown as Record<symbol, unknown>)[RETRYING]).toBe(true);
  });

  it('reports a write refused by a rate limit, or a 5xx, as GitHub limiting the rate, not a permission', async () => {
    for (const answer of [SECONDARY, 'gh: HTTP 429', 'gh: Bad Gateway (HTTP 502)']) {
      const d = parse(await run(checkout(), fakeGitHub({ writesFail: answer }), ['--yes', '--json', '--no-apps']));
      for (const id of ['label.create', 'merge.settings', 'ruleset.create']) {
        const f = d.findings.find((x) => x.id === id);
        expect(f, `${answer}: ${id}`).toBeDefined();
        const said = `${f!.message} ${f!.fix.text}`;
        expect(said, `${answer}: ${id}`).not.toMatch(/needs (Issues|Administration)|a token that has/);
        expect(said, `${answer}: ${id}`).toMatch(/GitHub limited the rate \(or failed\)/);
        expect(said, `${answer}: ${id}`).toMatch(/run(ning)? kanon init again/);
        expect(f!.message, `${answer}: ${id}`).toMatch(/GitHub limited the rate \(or failed\) when init tried/);
        expect(f!.message, `${answer}: ${id}`).not.toContain('the token could not');
      }
      expect(d.findings.find((x) => x.id === 'label.create')!.message, answer).toContain(TRANSIENT_WHY);
    }
  });

  it('names the permission on a 403 without a rate-limit marker, or a 404, and gives any other refusal as GitHub said it', async () => {
    for (const answer of ['gh: Resource not accessible by personal access token (HTTP 403)', 'gh: Not Found (HTTP 404)']) {
      const d = parse(await run(checkout(), fakeGitHub({ writesFail: answer }), ['--yes', '--json', '--no-apps']));
      expect(d.findings.find((x) => x.id === 'label.create')!.message, answer).toContain('(it needs Issues: write)');
      expect(d.findings.find((x) => x.id === 'ruleset.create')!.fix.text, answer).toContain('a token that has Administration: write');
    }
    const d = parse(await run(checkout(), fakeGitHub({ writesFail: 'gh: Validation Failed (HTTP 422)' }), ['--yes', '--json', '--no-apps']));
    expect(d.findings.find((x) => x.id === 'label.create')!.message).toContain('(GitHub refused it: gh: Validation Failed (HTTP 422))');
    // kanon#1633: a refusal that is neither the rate nor the token never asks for another token.
    for (const id of ['label.create', 'merge.settings', 'ruleset.create']) {
      const f = d.findings.find((x) => x.id === id)!;
      expect(f.fix.text, id).toContain('the same token, once what GitHub refused is fixed');
      expect(`${f.message} ${f.fix.text}`, id).not.toMatch(/a token that has|the token could not/);
    }
  });

  it("reports kanon milestones' rate limit as GitHub's, not the token's", async () => {
    const limited = async (argv: string[], io?: { err: (l: string) => void }) => {
      void argv;
      io?.err(`kanon milestones: could not create "Product Backlog" on acme/widgets: ${SECONDARY}`);
      io?.err(`kanon milestones: ${RATE_LINE}`);
      return 1;
    };
    const d = parse(await run(checkout(), fakeGitHub(), ['--yes', '--json', '--no-apps'], undefined, undefined, { milestones: limited }));
    const f = d.findings.find((x) => x.id === 'milestone.buckets')!;
    expect(f.message).toContain(TRANSIENT_WHY);
    expect(f.fix.text).not.toContain('a token that has');
    const refused = async () => 1;
    const p = parse(await run(checkout(), fakeGitHub(), ['--yes', '--json', '--no-apps'], undefined, undefined, { milestones: refused }));
    expect(p.findings.find((x) => x.id === 'milestone.buckets')!.fix.text).toContain('a token that has Issues: write');
  });

  // kanon#1623: Issues: write only on a refusal of the token; anything else as kanon milestones said it.
  it("names Issues: write for kanon milestones only on the token's refusal, and quotes any other cause", async () => {
    const saying = (...lines: string[]) => async (_argv: string[], io?: { err: (l: string) => void }) => {
      for (const l of lines) io?.err(`kanon milestones: ${l}`);
      return 1;
    };
    const finding = async (m: ReturnType<typeof saying>) => parse(await run(checkout(), fakeGitHub(), ['--yes', '--json', '--no-apps'], undefined, undefined, { milestones: m })).findings.find((x) => x.id === 'milestone.buckets')!;
    const denied = await finding(saying('could not create "Product Backlog" on acme/widgets: gh: Resource not accessible by personal access token (HTTP 403)'));
    expect(denied.message).toContain('(it needs Issues: write)');
    expect(denied.fix.text).toContain('a token that has Issues: write');
    for (const l of ['could not create "Product Backlog" on acme/widgets: gh: Validation Failed (HTTP 422)', '"Product Backlog" (#3) has a due date, 2026-12-01, so it reads as a roadmap milestone, not a bucket (K-WORK-3).']) {
      const f = await finding(saying(l));
      expect(f.message, l).toContain(`(kanon milestones said: ${l})`);
      expect(f.fix.text, l).toBe('Fix what kanon milestones said, then run it again.');
      expect(`${f.message} ${f.fix.text}`, l).not.toContain('Issues: write');
    }
  });
});
