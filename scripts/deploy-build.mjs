// The deploy lane's build, and the check each environment makes of it (plan 0010 §4, decision 8,
// step D5). One build, one artifact: `deploy-release.yml`'s `build` job, which holds no cloud
// credential, no `id-token` and no secret, runs the adopter's `.github/actions/build` once on the
// release's commit, into `$RUNNER_TEMP/kanon-deploy-artifact/`, and uploads that directory as
// `kanon-deploy-build-<run id>-<attempt>`. Every environment's `deploy` job downloads it by that
// run-scoped name and checks its digest before the deploy hook runs. Nothing is rebuilt per
// environment, and nothing is rebuilt from a different ref.
//
// THE DIGEST is the SHA-256 of the directory's contents (`treeDigest`): one line per regular
// file, `<sha-256 of the file> <its path, as JSON>`, sorted by path, then the SHA-256 of those
// lines. Of the contents and not of the zip archive, because the download unpacks the archive:
// what the deploy hook receives is the directory, so that is what is checked. An artifact keeps
// neither empty directories nor file modes, so neither counts; hidden files do, and the upload
// sends them (`include-hidden-files: true`).
//
// THE DIGEST TRAVELS OUTSIDE THE ARTIFACT. The build job's `build` output (`describeBuild`) is a
// JSON object, `{ artifact, digest, build_ms }`; `deploy-release.yml` publishes it as its
// workflow output `build`, and the caller hands it to each `deploy.yml` call as its `build`
// input. So the digest an environment checks against is the build job's own word, which no
// later job of the run can change, even one that uploaded another artifact under that name.
//
// THREE COMMANDS:
//   • `digest`, in the build job after the hook: refuses an empty directory (the hook built
//     nothing), and writes the `build` output.
//   • `input`, in each environment's `deploy` job: reads the `build` input, refuses one whose
//     artifact isn't this run's (`kanon-deploy-build-<GITHUB_RUN_ID>-<n>`) or whose digest isn't
//     a SHA-256, and writes `artifact` and `digest` for the download and the check.
//   • `check`, in the same job after the download: the downloaded directory's digest must be the
//     build's. A missing or empty directory is an artifact that expired (35 days, or the
//     repository's shorter retention) or was never uploaded; either fails, as a mismatch does,
//     and the `record` job reads all three as the `build` stage (`scripts/deploy-row.mjs`).
//
// ENV  GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_OUTPUT, RUNNER_TEMP
//      STARTED_AT   the build job's first step's mark (`digest`), for `build_ms`
//      BUILD        the `deploy.yml` call's `build` input (`input`)
//      ARTIFACT, DIGEST  the `input` step's outputs (`check`)

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { isCliEntry } from './lib/cli-entry.mjs';

/** The build's artifact name starts with this; the run id and the attempt follow. */
export const BUILD_ARTIFACT_PREFIX = 'kanon-deploy-build-';
/** The directory, under `$RUNNER_TEMP`, the build hook fills and each environment downloads into. */
export const BUILD_DIR = 'kanon-deploy-artifact';
/** @param {number | string} runId @param {number | string} attempt */
export const buildArtifactName = (runId, attempt) => `${BUILD_ARTIFACT_PREFIX}${runId}-${attempt}`;

/** A failure of the build or of its check, by what went wrong; the step fails with its message. */
export class BuildError extends Error {}

/**
 * Every regular file under `dir`, by its path relative to `dir`, `/`-separated, sorted. A link is
 * followed, as the upload follows it, so the download holds its target's contents.
 * @param {string} dir
 * @returns {string[]}
 */
export function listFiles(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ at) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        throw new BuildError(`${relative(dir, path).split(sep).join('/')} is a link to nothing: the upload can't send it`);
      }
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) out.push(relative(dir, path).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * The SHA-256 of a directory's contents, as hex, or `null` when it holds no file.
 * @param {string} dir
 * @returns {string | null}
 */
export function treeDigest(dir) {
  if (!existsSync(dir)) return null;
  const files = listFiles(dir);
  if (!files.length) return null;
  const manifest = files.map((f) => `${createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')} ${JSON.stringify(f)}\n`).join('');
  return createHash('sha256').update(manifest).digest('hex');
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The build job's `build` output, after the hook filled the directory.
 * @param {{ dir: string, runId: string | undefined, attempt: string | undefined, startedAt?: string, now?: Date }} o
 */
export function describeBuild({ dir, runId, attempt, startedAt, now = new Date() }) {
  const digest = treeDigest(dir);
  if (!digest) throw new BuildError(`the build hook, .github/actions/build, wrote nothing into its \`output\` directory (${dir}): there is nothing to deploy`);
  const started = Date.parse(String(startedAt ?? ''));
  const ms = Number.isFinite(started) && now.getTime() >= started ? now.getTime() - started : undefined;
  return { artifact: buildArtifactName(String(runId), String(attempt)), digest, ...(ms === undefined ? {} : { build_ms: ms }) };
}

/**
 * The `build` input of a `deploy.yml` call, read and held to this run.
 * @param {string | undefined} text @param {string | undefined} runId
 * @returns {{ artifact: string, digest: string, build_ms?: number }}
 */
export function readBuild(text, runId) {
  let b;
  try {
    b = JSON.parse(String(text ?? ''));
  } catch {
    b = null;
  }
  if (!b || typeof b !== 'object') throw new BuildError("the `build` input isn't the build's description: the caller passes `needs.release.outputs.build`, which `deploy-release.yml` sets after its build job");
  const own = new RegExp(`^${BUILD_ARTIFACT_PREFIX}${String(runId).replace(/\D/g, '')}-[1-9]\\d*$`);
  if (typeof b.artifact !== 'string' || !runId || !own.test(b.artifact)) throw new BuildError(`the \`build\` input names an artifact that isn't this run's build (${BUILD_ARTIFACT_PREFIX}<run id>-<attempt>)`);
  if (typeof b.digest !== 'string' || !SHA256.test(b.digest)) throw new BuildError("the `build` input's digest isn't a SHA-256");
  return { artifact: b.artifact, digest: b.digest, ...(Number.isInteger(b.build_ms) && b.build_ms >= 0 ? { build_ms: b.build_ms } : {}) };
}

/**
 * The downloaded build, against the build job's digest.
 * @param {{ dir: string, artifact: string, digest: string }} o
 */
export function checkBuild({ dir, artifact, digest }) {
  const got = treeDigest(dir);
  if (!got) throw new BuildError(`the build's artifact \`${artifact}\` wasn't downloaded: it expired (the lane keeps it 35 days, or your repository's shorter artifact retention) or was never uploaded. Deploy a new release, or dispatch this one again`);
  if (got !== digest) throw new BuildError(`the build's artifact \`${artifact}\` isn't what the build job uploaded: its digest is ${got}, the build's is ${digest}. Nothing was deployed`);
  return got;
}

if (isCliEntry(import.meta.url)) {
  const env = process.env;
  const command = process.argv[2];
  const out = (/** @type {string} */ line) => { if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, line); };
  const dir = join(env.RUNNER_TEMP ?? '.', BUILD_DIR);
  try {
    if (command === 'digest') {
      const build = describeBuild({ dir, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, startedAt: env.STARTED_AT });
      console.log(`Built ${build.artifact}, digest ${build.digest}.`);
      out(`build=${JSON.stringify(build)}\n`);
    } else if (command === 'input') {
      const build = readBuild(env.BUILD, env.GITHUB_RUN_ID);
      out(`artifact=${build.artifact}\ndigest=${build.digest}\n`);
    } else if (command === 'check') {
      const digest = checkBuild({ dir, artifact: String(env.ARTIFACT ?? ''), digest: String(env.DIGEST ?? '') });
      console.log(`The build's artifact matches the build job's digest, ${digest}.`);
      out(`path=${dir}\n`);
    } else {
      console.error('usage: deploy-build.mjs digest | input | check');
      process.exit(2);
    }
  } catch (e) {
    console.error(`::error::${e instanceof BuildError ? e.message : String(e)}`);
    process.exit(1);
  }
}
