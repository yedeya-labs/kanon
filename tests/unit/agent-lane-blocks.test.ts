import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LANE_BLOCKS, PIPELINE, readBlock, selfRefOf } from './helpers/blocks.js';
import { type WorkflowStep } from './helpers/workflow-step.js';

/**
 * RA-2666 — a lane is built from composite actions, `agent-setup`, `agent-run` and
 * `agent-finish`, which calls the fourth, `agent-classify`, so a lane with steps BETWEEN
 * the stages can use the same blocks directly. This suite owns the properties of the blocks
 * themselves: the platform rules a composite action imposes, which a YAML parser accepts
 * either way and only a run would otherwise catch. What each lane passes them is tested
 * with the lanes.
 */

describe('the blocks are composite actions that reach each other only through `$/`', () => {
  it.each([...LANE_BLOCKS])('%s is a composite action with steps', (name) => {
    const b = readBlock(name);
    expect(b.runs.using).toBe('composite');
    expect(b.runs.steps.length).toBeGreaterThan(0);
  });

  it('calls no action of its own but agent-classify and agent-telemetry, both from agent-finish', () => {
    // Inside the blocks: `agent-finish` calls `agent-classify`, and the telemetry action —
    // deliberately not a lane block (`LANE_BLOCKS`' header). Nothing else is called locally.
    const nested = PIPELINE.flatMap((b) => readBlock(b).runs.steps
      .map((st) => selfRefOf(st.uses))
      .filter((r) => r !== undefined)
      .map((r) => `${b} → ${r}`));
    expect(nested).toEqual(['agent-finish → agent-classify', 'agent-finish → agent-telemetry']);
  });

  it('gives a nested block every input it requires, and nothing it does not declare', () => {
    // A block's own call to a block (RA-2691: `agent-finish` → `agent-classify`), which the
    // runner checks no more strictly than it checks a lane's.
    const nestedCalls = PIPELINE.flatMap((b) => readBlock(b).runs.steps.filter((st) => selfRefOf(st.uses)));
    expect(nestedCalls).toHaveLength(2);
    for (const call of nestedCalls) {
      const declared = readBlock(String(selfRefOf(call.uses))).inputs ?? {};
      for (const [k, d] of Object.entries(declared)) {
        if (d.required) expect(call.with, `${call.uses} requires \`${k}\``).toHaveProperty([k]);
      }
      for (const k of Object.keys(call.with ?? {})) expect(declared, `${call.uses} does not declare \`${k}\``).toHaveProperty([k]);
    }
  });
});

describe('the composite-action rules each block has to live with', () => {
  it.each([...LANE_BLOCKS])('%s runs every `run` step under the workflow default shell, `bash -e {0}`', (name) => {
    // A composite `run` step MUST name its shell, and `bash` adds `pipefail` — which the
    // spine's steps never ran under. The spelled-out default keeps them byte-for-byte.
    for (const st of readBlock(name).runs.steps.filter((s) => s.run !== undefined)) {
      expect(st.shell, `${name}: ${st.name ?? st.run}`).toBe('bash -e {0}');
    }
  });

  it.each([...LANE_BLOCKS])('%s never tests an input for bare truth', (name) => {
    // A composite input is a STRING: the spine's `false` arrives as 'false', which is
    // truthy. So a block's switch must compare (`== 'true'`) or test emptiness (`!= ''`);
    // a bare `inputs.x` term would switch the step ON for every lane that turned it off.
    for (const st of readBlock(name).runs.steps) {
      for (const term of String(st.if ?? '').split('&&').map((t) => t.trim())) {
        if (!term.startsWith('inputs.')) continue;
        expect(term, `${name}: ${st.name ?? st.uses}`).toMatch(/^inputs\.[\w-]+ (==|!=) '[^']*'$/);
      }
    }
  });

  it.each([...LANE_BLOCKS])('%s never asks `failure()`, which inside a composite reads the BLOCK\'s status', (name) => {
    // The runner decides a composite main step's `failure()` on `action_status` — the
    // action's own steps — so in a block run after the agent failed it is false.
    for (const st of readBlock(name).runs.steps) expect(String(st.if ?? ''), `${name}: ${st.name ?? st.uses}`).not.toMatch(/failure\(\)/);
  });

  it('has `agent-run` take nothing back out of the tree, because nothing was put there', () => {
    const run = readBlock('agent-run');
    expect(Object.keys(run.inputs ?? {})).not.toContain('restore-paths');
    // The start stamp is the block's first step, as the agent's lower bound (RA-1627).
    expect(run.runs.steps[0]?.name).toBe('Record when the agent started');
  });
});

// RA-2697. A `$/` reference resolves to this repository at the commit that defined the
// workflow, downloaded into the runner's action cache during `Set up job` (nested
// references too), so a block's scripts are read from that cache, never from the workspace.
describe('the blocks run their scripts from the action cache, never from the workspace (RA-2697)', () => {
  type Step = WorkflowStep & { uses?: string; run?: string; name?: string };
  // The script a `node` call runs — an expression with spaces in it (`${{ github.action_path }}`)
  // included, which a plain `\S+` would stop inside and so never check.
  const NODE_SCRIPT = /\bnode\s+"?((?:\$\{\{[^}]*\}\}|[^\s"])+\.m?js)/g;
  const ACTION_PATH = /^(\$GITHUB_ACTION_PATH|\$\{\{ github\.action_path \}\})\//;

  it.each([...PIPELINE])('%s runs its scripts through its action path, from its own directory', (name) => {
    const action = parse(readFileSync(`actions/${name}/action.yml`, 'utf8'));
    for (const st of (action.runs.steps as Step[]).filter((s) => s.run !== undefined)) {
      for (const [, path] of String(st.run).matchAll(NODE_SCRIPT)) {
        expect(path, `${name}: ${st.name}`).toMatch(ACTION_PATH);
        // In Kanon a script lives beside the action that runs it, so nothing climbs out of
        // the action's directory.
        const rel = String(path).replace(ACTION_PATH, '');
        expect(rel, `${name}: ${rel}`).not.toContain('/');
        expect(() => readFileSync(join('actions', name, rel)), `${name}: ${rel}`).not.toThrow();
      }
    }
  });

  it('has every script-running block reach a script, so the rule above is not vacuous', () => {
    const scripts = PIPELINE.flatMap((name) => (parse(readFileSync(`actions/${name}/action.yml`, 'utf8')).runs.steps as Step[])
      .flatMap((st) => [...String(st.run ?? '').matchAll(NODE_SCRIPT)].map((m) => `${name}: ${m[1]}`)));
    expect(scripts.sort()).toEqual([
      'agent-classify: $GITHUB_ACTION_PATH/classify-agent-result.mjs',
      'agent-finish: $GITHUB_ACTION_PATH/agent-quality-prs.mjs',
      'agent-telemetry: ${{ github.action_path }}/agent-telemetry.mjs',
    ]);
  });

  it('keeps every script on Node built-ins, so a block needs no install', () => {
    // The blocks run before, or without, any install, and from the action cache, where no
    // node_modules exists. A bare import would fail only on the runner.
    const dirs = readdirSync('actions').filter((d) => PIPELINE.includes(d));
    const imports = dirs.flatMap((d) => readdirSync(join('actions', d)).filter((f) => f.endsWith('.mjs'))
      .flatMap((f) => [...readFileSync(join('actions', d, f), 'utf8').matchAll(/^import [^;]*? from ['"]([^'"]+)['"]/gm)]
        .map((m) => `${d}/${f}: ${m[1]}`)));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((i) => !/: (node:|\.\.?\/)/.test(i))).toEqual([]);
  });
});
