import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { MAP_PATH } from '../../scripts/starting-map.mjs';

/**
 * RA-2456 part 2 — the implement lane's prompt points at the starting map first (plan 0001,
 * step 3, from the reference adopter's starting-map test).
 *
 * The adopter's project-setup hook writes the map for the lane whose `agent` is
 * `implementer`. A map nobody is told to read costs a minute and saves nothing.
 */
const lane = parse(readFileSync('.github/workflows/agent-implement.yml', 'utf8')) as {
  jobs: { implement: { with: { agent: string; prompt: string } } };
};

describe('the implement lane is told to read the starting map', () => {
  it('opts in by its name, and its prompt points at the file before the playbook', () => {
    const { agent, prompt } = lane.jobs.implement.with;
    expect(agent).toBe('implementer');
    expect(prompt.indexOf(MAP_PATH)).toBeGreaterThan(-1);
    expect(prompt.indexOf(MAP_PATH)).toBeLessThan(prompt.indexOf('docs/qa/triage-fix-playbook.md'));
  });
});
