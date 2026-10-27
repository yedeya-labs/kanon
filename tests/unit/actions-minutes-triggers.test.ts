import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRIGGERS } from '../../cli/callers.mjs';

/**
 * kanon#808: the "What starts it" column of docs/actions-minutes.md's lane table restates each
 * lane's caller triggers in prose, and `TRIGGERS` in cli/callers.mjs is their one home. Each
 * lane's phrases are built here from its `TRIGGERS` entry and compared with its row, so a trigger
 * added to or taken from a lane turns this red until the doc says so too.
 */

const ROOT = join(import.meta.dirname, '..', '..');

type Trigger = {
  name: string;
  job: string;
  issues?: string[];
  pr?: string[];
  prTarget?: string[];
  review?: boolean;
  ci?: 'any' | 'default';
  openers?: string[];
  merged?: boolean;
  pinMoved?: boolean;
  schedule?: string;
  dispatch?: Record<string, boolean>;
  deployRun?: boolean;
  reask?: string[];
  release?: boolean;
};

/** Every key a `TRIGGERS` entry may carry. A new kind of trigger needs a phrase below first. */
const KNOWN = new Set(['name', 'job', 'issues', 'pr', 'prTarget', 'review', 'ci', 'openers', 'merged', 'pinMoved', 'schedule', 'dispatch', 'deployRun', 'reask', 'release']);

const VERB: Record<string, string> = { labeled: 'labelled', opened: 'opened', closed: 'closed', milestoned: 'put on a milestone' };
const verbs = (events: string[]) => events.map((e) => {
  if (!VERB[e]) throw new Error(`no phrase for the event type ${e}: add it to VERB`);
  return VERB[e];
}).join(' or ');

const NUMBER = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];

/** The cadence a caller's cron gives, in the doc's words; anything else must be phrased by hand. */
const cadence = (cron: string): string => {
  const [minute, hour, dom, month, dow, ...rest] = cron.split(' ');
  const fixed = (f: string | undefined) => /^\d+$/.test(f ?? '');
  if (rest.length || !fixed(minute) || month !== '*') throw new Error(`no phrase for the schedule ${cron}`);
  if (hour === '*' && dom === '*' && dow === '*') return 'an hourly schedule';
  if (!fixed(hour)) throw new Error(`no phrase for the schedule ${cron}`);
  if (dom === '*' && dow === '*') return 'a daily schedule';
  if (dom === '*' && fixed(dow)) return 'a weekly schedule';
  const every = /^\*\/(\d)$/.exec(dom ?? '');
  if (every && dow === '*' && NUMBER[+every[1]!]) return `a schedule every ${NUMBER[+every[1]!]} days`;
  throw new Error(`no phrase for the schedule ${cron}`);
};

/** What starts a lane, one phrase per trigger, as the table's first column words it. */
const phrases = (t: Trigger): string[] => {
  const out: string[] = [];
  if (t.ci === 'any') out.push("CI finishing on a pull request's head");
  else if (t.ci === 'default') out.push('CI finishing on the default branch');
  else if (t.ci !== undefined) throw new Error(`no phrase for ci: ${String(t.ci)}`);
  // kanon#1427: a run of a lane that opens pull requests, which may conflict from the start.
  if (t.openers) out.push('a run of a lane that opens pull requests finishing');
  // The same events on pull requests and issues read as one phrase.
  if (t.pr && t.issues && verbs(t.pr) === verbs(t.issues)) out.push(`a pull request or issue ${verbs(t.pr)}`);
  else {
    if (t.pr) out.push(`a pull request ${verbs(t.pr)}`);
    if (t.issues) out.push(`an issue ${verbs(t.issues)}`);
  }
  // kanon#1190: a release published, a stable release or a pre-release.
  if (t.release) out.push('a release published');
  if (t.prTarget) out.push(`a pull request ${verbs(t.prTarget)}`);
  if (t.review) out.push('a review submitted');
  if (t.merged) out.push('a pull request merged');
  if (t.schedule) out.push(cadence(t.schedule));
  if (t.pinMoved) out.push('a merged change to its caller');
  // kanon#833: the re-ask, a run of a lane whose runs this one recovers.
  if (t.reask) out.push('a run of a lane it recovers completing');
  // Plan 0010 D8: a run of the deploy caller, and no dispatch with it.
  if (t.deployRun) out.push('a run of the deploy caller completing');
  else if (t.dispatch) out.push('a dispatch');
  return out;
};

/** A phrase as compared: the table capitalises the first one of each cell. */
const norm = (p: string) => (p.startsWith('CI ') ? p : p.charAt(0).toLowerCase() + p.slice(1));

const rows = (): Map<string, string> => {
  const doc = readFileSync(join(ROOT, 'docs/actions-minutes.md'), 'utf8');
  const section = doc.split('\n## What starts each lane\n')[1]!.split('\n## ')[0]!;
  return new Map([...section.matchAll(/^\| `(agent-[a-z-]+)` \| ([^|]+) \|/gm)].map((m) => [m[1]!, m[2]!.trim()]));
};

describe("docs/actions-minutes.md's trigger column is TRIGGERS, in words (kanon#808)", () => {
  const table = rows();
  const triggers = TRIGGERS as Record<string, Trigger>;

  it('has a row for every lane TRIGGERS has, and no other', () => {
    expect([...table.keys()].sort()).toEqual(Object.keys(triggers).sort());
  });

  it('knows a phrase for every kind of trigger a lane has', () => {
    for (const [lane, t] of Object.entries(triggers)) {
      expect(Object.keys(t).filter((k) => !KNOWN.has(k)), lane).toEqual([]);
    }
  });

  it.each(Object.keys(TRIGGERS))("%s's row names exactly the triggers of its caller", (lane) => {
    const cell = table.get(lane);
    expect(cell, lane).toBeDefined();
    const said = cell!.split('; ').map(norm).sort();
    expect(said).toEqual(phrases(triggers[lane]!).map(norm).sort());
  });

  it('words a cron the way the table does, and refuses one it has no words for', () => {
    expect(cadence('7 * * * *')).toBe('an hourly schedule');
    expect(cadence('0 3 * * *')).toBe('a daily schedule');
    expect(cadence('0 8 * * 1')).toBe('a weekly schedule');
    expect(cadence('30 7 */3 * *')).toBe('a schedule every three days');
    for (const odd of ['*/5 * * * *', '0 */6 * * *', '0 0 1 * *', '0 0 * 1 *']) expect(() => cadence(odd), odd).toThrow(/no phrase/);
  });

  it('turns red when a lane gains or loses a trigger and its row does not follow', () => {
    const review = triggers['agent-review']!;
    const cell = table.get('agent-review')!.split('; ').map(norm).sort();
    expect(cell).not.toEqual(phrases({ ...review, review: true }).map(norm).sort());
    expect(cell).not.toEqual(phrases({ ...review, dispatch: undefined }).map(norm).sort());
    expect(cell).not.toEqual(phrases({ ...review, ci: 'default' }).map(norm).sort());
  });
});
