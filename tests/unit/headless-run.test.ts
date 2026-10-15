import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { claudeArgWords } from '../../scripts/lib/claude-args.mjs';

const { HEADLESS_RULE, withHeadless } = await import('../../actions/agent-run/persona-prompt.mjs');

/**
 * kanon#621 — a headless run must not end its session with work still running.
 *
 * WHAT HAPPENED. Implement runs in the reference adopter ended `success` with no branch, no PR
 * and no comment, six times in three days, each after backgrounding its own gates
 * (`run_in_background`, then `Monitor`) and ending its turn to wait for them. In `claude -p`
 * ending the turn ends the session, and nothing resumes it, so finished and staged work was lost.
 * The agent backgrounded them because it asked for a 20 and a 40 minute foreground `timeout`
 * first, and the Bash tool's cap is 10 minutes unless `BASH_MAX_TIMEOUT_MS` raises it.
 *
 * So `agent-run`, which every lane's agent runs through, turns background tasks off, raises the
 * foreground cap, takes `Monitor` away, and tells the agent why. Each is pinned here, so none can
 * drop out of the block unnoticed. `empty-check` in `agent-implement.yml` is the backstop for a
 * run that ends empty anyway (kanon#181).
 */

type Step = { id?: string; uses?: string; env?: Record<string, unknown>; with?: Record<string, unknown> };
const steps = (parse(readFileSync('actions/agent-run/action.yml', 'utf8')) as { runs: { steps: Step[] } }).runs.steps;
const agent = steps.find((s) => String(s.uses ?? '').startsWith('anthropics/claude-code-action@'))!;

/** CLI 2.1.292's foreground cap with no `BASH_MAX_TIMEOUT_MS`: 10 minutes. */
const CLI_DEFAULT_MAX_MS = 600_000;

describe('kanon#621: agent-run keeps every command in the foreground', () => {
  it('has one action step to check, so nothing below is vacuous', () => {
    expect(steps.filter((s) => String(s.uses ?? '').startsWith('anthropics/claude-code-action@'))).toHaveLength(1);
  });

  it('turns background tasks off, which takes run_in_background off the Bash tool', () => {
    expect(agent.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
  });

  it('raises the foreground cap above the CLI default, and below the implement lane\'s wall clock', () => {
    const cap = Number(agent.env?.BASH_MAX_TIMEOUT_MS);
    expect(Number.isInteger(cap)).toBe(true);
    expect(cap).toBeGreaterThan(CLI_DEFAULT_MAX_MS);
    const lane = parse(readFileSync('.github/workflows/agent-implement.yml', 'utf8')) as { jobs: { implement: { with: { 'timeout-minutes': number } } } };
    expect(cap).toBeLessThan(lane.jobs.implement.with['timeout-minutes'] * 60_000);
  });

  it('hands the action the lane\'s flags with Monitor denied after them', () => {
    const args = String(agent.with?.claude_args);
    // The lane's flags as the turn-budget step wrote them: its own, or with the caller's
    // `max_turns` in place (kanon#891).
    expect(args.startsWith('${{ steps.turns.outputs.claude-args }}\n')).toBe(true);
    expect(claudeArgWords(args).slice(-2)).toEqual(['--disallowedTools', 'Monitor']);
  });

  it('is the only way any workflow reaches the action, so the switches cover every lane', () => {
    const direct = readdirSync('.github/workflows').filter((f) => /\.ya?ml$/.test(f))
      .filter((f) => /^\s*-?\s*uses:\s*anthropics\/claude-code-action@/m.test(readFileSync(join('.github/workflows', f), 'utf8')));
    expect(direct).toEqual([]);
  });
});

describe('kanon#621: agent-run tells the agent its session ends when it stops', () => {
  it('appends the rule to the prompt, after what the lane wrote', () => {
    const out = withHeadless('Do the work.\n');
    expect(out.startsWith('Do the work.\n\nTHIS IS A HEADLESS RUN')).toBe(true);
    expect(out.endsWith(HEADLESS_RULE)).toBe(true);
  });

  it('says nothing resumes the session, to run in the foreground with a timeout, and never to wait on a background task', () => {
    expect(HEADLESS_RULE).toContain('nothing resumes it');
    expect(HEADLESS_RULE).toMatch(/foreground/);
    expect(HEADLESS_RULE).toMatch(/explicit\s+`timeout`/);
    expect(HEADLESS_RULE).toMatch(/Never end your turn to wait/);
  });
});
