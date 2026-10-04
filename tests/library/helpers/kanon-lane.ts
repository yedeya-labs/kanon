import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ROOT } from './adopter.js';

/**
 * A caller's job that calls one of Kanon's lanes, and the lane it calls. The reference
 * adopter's tests read their own callers and, through them, the lane at the pinned tag; here
 * the callers are the fixture callers (`tests/fixtures/lane-check/`) and the lane is this tree's.
 */
export const kanonLaneOf = (job: unknown): { file: string } | undefined => {
  const uses = (job as { uses?: unknown } | undefined)?.uses;
  const m = typeof uses === 'string' ? /^yedeya-labs\/kanon\/\.github\/workflows\/(agent-[a-z-]+\.yml)@/.exec(uses) : null;
  return m ? { file: m[1]! } : undefined;
};

type Lane = { jobs: Record<string, Record<string, unknown>> } & Record<string, unknown>;

/** The lane a caller's job calls, from this Kanon tree. */
export const readKanonLane = (job: unknown): Lane => {
  const lane = kanonLaneOf(job);
  if (!lane) throw new Error(`\`${String((job as { uses?: unknown })?.uses)}\` is not a call to a Kanon lane`);
  return readLane(lane.file);
};

/** One of this tree's lanes, by file name. */
export const readLane = (file: string): Lane => parse(readFileSync(join(ROOT, '.github/workflows', file), 'utf8')) as Lane;

/** The fixture callers an adopter writes, one per lane (`tests/fixtures/lane-check/`). */
export const CALLER_DIRS = ['tests/fixtures/lane-check/adopter/.github/workflows', 'tests/fixtures/lane-check/extra'].map((d) => join(ROOT, d));
