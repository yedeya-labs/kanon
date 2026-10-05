import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parse } from 'yaml';

/**
 * A lane as its runs see it, across the called workflows it is split into (kanon#279).
 *
 * WHY THIS EXISTS. `K-AGENT-49` keeps an App's private key out of every job that runs an
 * agent, so each lane mints its token in a `mint` job and runs its agent in a called workflow
 * of its own (`review-agent-job.yml` for `agent-review.yml`, and so on), because a called
 * workflow's `secrets:` is the one channel that hands the token over masked. The lane's
 * agent job is therefore a `uses: $/.github/workflows/<file>` job in the lane, and its steps
 * live in that file. Every test about what a lane's agent job RUNS reads it through here, so
 * the split moves no assertion: it reads the same job, wherever its steps now live.
 */

/** `uses: $/.github/workflows/<file>`, Kanon's call to one of its own workflows. */
const CALL = /^\$\/\.github\/workflows\/([\w.-]+\.ya?ml)$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = any;

const read = (path: string): Doc => parse(readFileSync(path, 'utf8')) as Doc;

/** The file a job calls through `$/`, as a path beside the calling file, or undefined. */
const calledBy = (from: string, job: Doc): string | undefined => {
  const m = typeof job?.uses === 'string' ? CALL.exec(job.uses) : null;
  return m ? join(dirname(from), m[1]!) : undefined;
};

/**
 * The job a call runs, when the called workflow is a lane's agent job: its only job, or the
 * one named as the calling job is (`rebase-pr.yml`, which holds `mint` and `resolve`).
 * Undefined for a workflow with several jobs and none of that name: `agent-lane.yml`, the
 * spine, is a mint and a call, not a job of the lane's own.
 */
const calledJob = (doc: Doc, name: string): Doc => {
  const jobs = Object.entries(doc?.jobs ?? {});
  if (jobs.length === 1) return jobs[0]![1];
  return doc?.jobs?.[name];
};

/**
 * One job, flattened: a `$/` call to a lane's agent job becomes that job's steps, with the
 * calling job's `needs`, `if`, `strategy`, `concurrency` and `permissions` (a called job
 * holds none of those: they are the caller's, and its permissions are the call's ceiling).
 */
export const flattenJob = (from: string, name: string, job: Doc): Doc => {
  const file = calledBy(from, job);
  if (!file) return job;
  const inner = calledJob(read(file), name);
  if (!inner) return job;
  const flat = flattenJob(file, name, inner);
  const { uses: _uses, with: _with, secrets: _secrets, ...outer } = job;
  void _uses; void _with; void _secrets;
  return { ...flat, ...outer, permissions: outer.permissions ?? flat.permissions };
};

/** A workflow parsed, with each job that calls a lane's agent job through `$/` flattened into it. */
export const readFlattened = (path: string): Doc => {
  const doc = read(path);
  for (const [name, job] of Object.entries(doc?.jobs ?? {})) doc.jobs[name] = flattenJob(path, name, job);
  return doc;
};

/** Every file a workflow calls through `$/`, transitively, after the workflow itself. */
export const calledFiles = (path: string, seen = new Set<string>()): string[] => {
  if (seen.has(path)) return [];
  seen.add(path);
  const doc = read(path);
  return [path, ...Object.values(doc?.jobs ?? {}).flatMap((j) => {
    const f = calledBy(path, j);
    return f ? calledFiles(f, seen) : [];
  })];
};

/** A lane's text and the text of every agent job it calls, for a test that reads the prompt. */
export const workflowText = (path: string, { spine = false } = {}): string =>
  calledFiles(path).filter((f) => spine || !/\/(agent-lane|lane-agent-job)\.yml$/.test(f) || f === path)
    .map((f) => readFileSync(f, 'utf8')).join('\n');

/**
 * The workflows in a directory that are not part of another: every file but those another file
 * calls through `$/`, except a lane (`agent-*.yml`), which the lanes smoke also calls. Read
 * each through `readFlattened` and every lane's agent job is seen exactly once, as its lane's.
 */
export const topLevelWorkflows = (dir: string): string[] => {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const called = new Set(files.flatMap((f) => Object.values(read(join(dir, f))?.jobs ?? {})
    .map((j) => calledBy(join(dir, f), j)).filter((c): c is string => !!c).map((c) => basename(c))));
  return files.filter((f) => f.startsWith('agent-') || !called.has(f));
};

/**
 * What a lane hands its agent job as input `name`, through its call chain: the value on the
 * lane's own call, when every workflow between hands it on unchanged as `${{ inputs.<name> }}`.
 * Throws when one does not, so a test of "the agent job reads X from the filter" still means it.
 */
export const handedIn = (path: string, job: string, name: string): unknown => {
  const outer = read(path)?.jobs?.[job];
  let file = calledBy(path, outer);
  if (!file) throw new Error(`${path}:${job} calls no workflow of Kanon's own`);
  for (let inner = calledJob(read(file), job); inner && calledBy(file, inner); inner = calledJob(read(file), job)) {
    const v = inner.with?.[name];
    if (v !== `\${{ inputs.${name} }}`) throw new Error(`${file}:${job} hands \`${name}\` on as ${String(v)}, not unchanged`);
    file = calledBy(file, inner)!;
  }
  return outer.with?.[name];
};

/**
 * The mint a lane's agent job gets its token from (kanon#279): the token step of the `mint` job
 * in the workflow the lane's job calls, with the App id and key that call hands it in place of
 * the `app-id` / `app-private-key` it reads them as, so a test still reads which App it mints.
 */
export const mintFor = (path: string, job: string): Doc => {
  const outer = read(path)?.jobs?.[job];
  const file = calledBy(path, outer);
  if (!file) throw new Error(`${path}:${job} calls no workflow of Kanon's own`);
  const step = (read(file)?.jobs?.mint?.steps ?? []).find((s: Doc) => String(s?.uses ?? '').startsWith('actions/create-github-app-token@'));
  if (!step) throw new Error(`${file} has no mint job that mints a token`);
  return { ...step, with: { ...step.with, 'client-id': outer.secrets?.['app-id'], 'private-key': outer.secrets?.['app-private-key'] } };
};
