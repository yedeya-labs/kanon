import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { type WorkflowStep } from './workflow-step.js';

/**
 * The agent-lane blocks under `actions/`, and a reader for them.
 *
 * `LANE_BLOCKS` are the four blocks a lane is built from. Each follows the composite rules
 * in `agent-lane-blocks.test.ts` (the workflow default shell, string inputs, no
 * `failure()`). `agent-telemetry` is not one of them: it predates the blocks, runs under
 * `shell: bash`, and is called by `agent-finish` and directly by the store-coupled lanes.
 * `PIPELINE` is all five.
 */
export const LANE_BLOCKS = Object.freeze(['agent-setup', 'agent-run', 'agent-finish', 'agent-classify']);
export const PIPELINE = Object.freeze([...LANE_BLOCKS, 'agent-telemetry']);

export type Block = {
  name?: string;
  inputs?: Record<string, { default?: string; required?: boolean }>;
  outputs?: Record<string, { value: string }>;
  runs: { using: string; steps: WorkflowStep[] };
};

/** A block's parsed `action.yml`, by name (`agent-run`, …). */
export const readBlock = (name: string): Block =>
  parse(readFileSync(join(process.cwd(), 'actions', name, 'action.yml'), 'utf8')) as Block;

/**
 * The Kanon action a `uses:` names through the self-reference, `$/actions/<name>`, or
 * undefined. A remote, a `./` path, a pinned ref or a nested path is not one.
 */
export const selfRefOf = (uses: unknown): string | undefined =>
  typeof uses === 'string' ? /^\$\/actions\/([a-z0-9-]+)$/.exec(uses)?.[1] : undefined;
