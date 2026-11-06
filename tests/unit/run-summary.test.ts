import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { SUMMARY_SCHEMA, runSummary } from '../../scripts/run-summary.mjs';

// kanon#1593: an adopter's implement runs ended `ok` with no comment and no PR, and the kept log
// stopped early. The Owner chose a safe summary as a short-retention artifact: the final message,
// each tool call's name and error flag, and the counts, never a tool's input or output, which the
// log's masking doesn't reach in the result file.
const SECRET = 'ghs_0123456789abcdefSECRET';
const objects = [
  { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
  { type: 'assistant', message: { content: [{ type: 'text', text: `thinking about ${SECRET}` }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `echo ${SECRET}` } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: SECRET }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/x', new_string: SECRET } }, { type: 'tool_use', id: 't3', name: 'Read', input: {} }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'refused' }] } },
  { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', num_turns: 4, total_cost_usd: 1.5, duration_ms: 1000, result: 'Built it; see the PR.' },
];

describe('the run summary (#1593)', () => {
  it('keeps the final message, each tool call\'s name and error flag, and the counts, and nothing a tool read or wrote', () => {
    const s = runSummary(objects)!;
    expect(s).toEqual({
      schema: SUMMARY_SCHEMA, final_message: 'Built it; see the PR.', subtype: 'success', is_error: false, terminal_reason: 'completed',
      num_turns: 4, total_cost_usd: 1.5, duration_ms: 1000,
      tool_calls: [{ name: 'Bash', error: false }, { name: 'Edit', error: true }, { name: 'Read', error: null }],
    });
    expect(JSON.stringify(s)).not.toContain(SECRET);
    expect(runSummary(objects.slice(0, -1))).toBeNull();
  });

  it('writes it from a result file, and writes nothing without one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanon-run-summary-'));
    const file = join(dir, 'claude-execution-output.json');
    writeFileSync(file, JSON.stringify(objects));
    const out = join(dir, 'out', 'summary.json');
    const r = spawnSync(process.execPath, ['scripts/run-summary.mjs', '--execution-file', file, '--out', out], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).tool_calls).toHaveLength(3);
    expect(readFileSync(out, 'utf8')).not.toContain(SECRET);
    const none = spawnSync(process.execPath, ['scripts/run-summary.mjs', '--execution-file', join(dir, 'missing.json'), '--out', join(dir, 'none.json')], { encoding: 'utf8' });
    expect(none.status).toBe(0);
    expect(none.stdout).toContain('No result file to summarise');
  });

  it('is uploaded for seven days on the implement lane only, and never the result file itself', () => {
    const spine = readFileSync('.github/workflows/lane-agent-job.yml', 'utf8');
    const job = parse(spine).jobs.run;
    const step = job.steps.find((s: { id?: string }) => s.id === 'run-summary');
    expect(step.run).toContain('scripts/run-summary.mjs');
    // #1661: Kanon's path and Node from the `kanon` step's outputs, which neither the project's hook
    // nor the agent, both run by now, can rewrite as they can `$GITHUB_ENV` and `$PATH`.
    expect(job.steps.find((s: { id?: string }) => s.id === 'kanon').uses).toMatch(/actions\/kanon-path$/);
    expect(step.env).toMatchObject({ KANON: '${{ steps.kanon.outputs.path }}', KANON_NODE: '${{ steps.kanon.outputs.node }}' });
    expect(step.run).toMatch(/^"\$KANON_NODE" "\$KANON\/scripts\/run-summary\.mjs" /);
    expect(step['continue-on-error']).toBe(true);
    const upload = job.steps.find((s: { name?: string }) => s.name === 'Upload the run summary');
    expect(upload.with).toMatchObject({ path: '${{ runner.temp }}/kanon-run-summary/summary.json', 'retention-days': 7 });
    expect(spine).not.toMatch(/path: .*execution_file|path: .*claude-execution-output/);
    const implement = parse(readFileSync('.github/workflows/agent-implement.yml', 'utf8'));
    expect(implement.jobs.implement.with['run-summary']).toBe(true);
    expect(parse(readFileSync('.github/workflows/agent-lane.yml', 'utf8')).jobs.run.with['run-summary']).toBe('${{ inputs.run-summary }}');
  });
});
