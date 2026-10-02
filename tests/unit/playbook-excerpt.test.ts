import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  EXCERPT_PATH,
  PLAYBOOK,
  buildExcerpt,
  extractSections,
  rebaseLinks,
} from '../../scripts/playbook-excerpt.mjs';
import { effectiveSteps } from './helpers/spine.js';

/**
 * RA-2488 option 2 — merge-reconcile reads only the reviewer-playbook sections it uses.
 *
 * The extractor fails SAFE (a missing heading writes the whole playbook), which is also
 * how it would fail SILENTLY: a renamed heading quietly restores the full 44 KB read and
 * nothing looks wrong. So the headings it keys on are asserted against the real
 * playbook, and so is the other silent failure — an excerpt that links to a section it
 * does not carry.
 *
 * KANON'S HALF (plan 0001, step 3): the extractor, on a fixture playbook, and the
 * merge-reconcile lane that runs it. The reference adopter keeps the half that reads its
 * own playbook, and its telemetry cutover record.
 */

const playbook = readFileSync('tests/fixtures/kanon-path/docs/qa/reviewer-playbook.md', 'utf8');


describe('the extractor', () => {
  const doc = [
    '# Title', 'intro',
    '## Keep me', 'a', '### sub stays', 'b', '```', '## not a heading inside a fence', '```', 'c',
    '## Drop me', 'x',
    '## Also keep', 'y',
  ].join('\n');

  it('cuts each section to the next level-2 heading, keeping ### and fenced ## inside it', () => {
    const { sections, missing } = extractSections(doc, ['Keep', 'Also keep']);
    expect(missing).toEqual([]);
    expect(sections[0]).toBe(['## Keep me', 'a', '### sub stays', 'b', '```', '## not a heading inside a fence', '```', 'c'].join('\n'));
    expect(sections[1]).toBe('## Also keep\ny');
  });

  it('does not end a fence on a shorter or different marker', () => {
    const nested = ['## Keep', '````md', '```', '## inside', '```', '````', 'tail', '## Next', 'n'].join('\n');
    expect(extractSections(nested, ['Keep']).sections[0]).toBe(['## Keep', '````md', '```', '## inside', '```', '````', 'tail'].join('\n'));
    const tilde = ['## Keep', '~~~', '```', '## inside', '~~~', '## Next'].join('\n');
    expect(extractSections(tilde, ['Keep']).sections[0]).toBe(['## Keep', '~~~', '```', '## inside', '~~~'].join('\n'));
  });

  it('re-roots relative links to docs/qa and leaves anchors and URLs alone', () => {
    expect(rebaseLinks('[a](./explorer-playbook.md) [b](../agentic-lead-engineer.md) [c](#x) [d](https://e.x/y)'))
      .toBe('[a](docs/qa/explorer-playbook.md) [b](docs/agentic-lead-engineer.md) [c](#x) [d](https://e.x/y)');
  });

  it('falls back to the WHOLE playbook, and says so, when any heading is missing', () => {
    const renamed = playbook.replace('## Capturing follow-ups', '## Filing follow-ups');
    const out = buildExcerpt(renamed);
    expect(out.fallback).toBe(true);
    expect(out.missing).toEqual(['Capturing follow-ups']);
    expect(out.text.endsWith(rebaseLinks(renamed))).toBe(true);
    expect(out.text).toContain('IN FULL');
  });
});

describe('the workflow writes it and points the prompt at it', () => {
  type Step = { name?: string; uses?: string; run?: string; 'continue-on-error'?: boolean; with?: { prompt?: string } };
  const wf = parse(readFileSync('.github/workflows/agent-merge-reconcile.yml', 'utf8'));
  // AS THE JOB RUNS (RA-2660): the job calls the agent-lane blocks directly, so the agent
  // step and its prompt sit inside `agent-run` — read through the shared resolver.
  const steps = effectiveSteps(wf.jobs.reconcile.steps) as Step[];
  const at = steps.findIndex((s) => s.run?.includes('scripts/playbook-excerpt.mjs'));
  const agent = steps.findIndex((s) => s.uses?.startsWith('anthropics/claude-code-action'));
  const checkout = steps.findIndex((s) => s.uses?.startsWith('actions/checkout'));

  it('runs after the default-branch checkout and before the agent, never failing the run', () => {
    expect(at).toBeGreaterThan(checkout);
    expect(at).toBeLessThan(agent);
    expect(steps[at]!['continue-on-error']).toBe(true);
    // No arguments: the section list and the output path are the script's own constants.
    // Kanon's copy, from the action cache at the pinned tag (plan 0001 §3).
    expect(steps[at]!.run?.trim()).toBe('node "$KANON/scripts/playbook-excerpt.mjs"');
    expect(steps[at - 1]!.uses).toBe('$/actions/kanon-path');
  });

  it('the prompt reads the excerpt first, and the full playbook only as a fallback', () => {
    const prompt = steps[agent]!.with?.prompt ?? '';
    expect(prompt.indexOf(EXCERPT_PATH)).toBeGreaterThan(-1);
    expect(prompt.indexOf(EXCERPT_PATH)).toBeLessThan(prompt.indexOf(PLAYBOOK));
    expect(prompt).toMatch(/Only if that excerpt file is missing,\s+read docs\/qa\/reviewer-playbook\.md/);
    // The one severity rule the excerpt drops (it lives under "What to check") is restated.
    expect(prompt).toMatch(/data migration[\s\S]{0,200}worst database state/);
  });

});
