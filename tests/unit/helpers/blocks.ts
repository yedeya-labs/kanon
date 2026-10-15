import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parse } from 'yaml';
import { actionFiles } from './actions.js';
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

/** A block's parsed `action.yml`, by name (`agent-run`, `notify/slack`, …). */
export const readBlock = (name: string): Block =>
  parse(readFileSync(join(process.cwd(), 'actions', name, 'action.yml'), 'utf8')) as Block;

/** An action's name: its directory under `actions/`, nested ones by their path (`notify/slack`). */
const NAME = String.raw`[a-z0-9-]+(?:\/[a-z0-9-]+)*`;
const SELF_REF = new RegExp(String.raw`^\$\/actions\/(${NAME})$`);
const RELEASE_PIN = new RegExp(String.raw`^yedeya-labs\/kanon\/actions\/(${NAME})@[\w.-]+$`);

/**
 * The Kanon action a `uses:` names through the self-reference, `$/actions/<name>`, or
 * undefined. A remote, a `./` path or a pinned ref is not one.
 */
export const selfRefOf = (uses: unknown): string | undefined =>
  typeof uses === 'string' ? SELF_REF.exec(uses)?.[1] : undefined;

/**
 * Every action under `actions/`, by directory name: each directory holding an `action.yml`
 * (kanon#342), a nested one by its path under `actions/` (`notify/slack`, kanon#927). `PIPELINE`
 * is the five a lane is built from; this is all of them.
 */
export const ACTIONS: readonly string[] = Object.freeze(actionFiles()
  .filter((f) => f.endsWith('.yml'))
  .map((f) => relative('actions', dirname(f)))
  .sort());

/**
 * The Kanon action a `uses:` names in either form this tree calls one by: the self-reference,
 * `$/actions/<name>`, or the release pin, `yedeya-labs/kanon/actions/<name>@<ref>`, which the
 * checks that judge a pull request use (ADR 0011). Undefined for anything else.
 */
export const kanonActionOf = (uses: unknown): string | undefined =>
  selfRefOf(uses) ?? (typeof uses === 'string' ? RELEASE_PIN.exec(uses)?.[1] : undefined);
