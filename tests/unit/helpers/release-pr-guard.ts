import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';


/**
 * The fixtures, the fake `gh` and the runner the release-pr-guard tests share
 * (tests/unit/release-pr-guard*.test.ts, split by area in kanon#381).
 */

export type Step = { id?: string; name?: string; run?: string; shell?: string; if?: string; env?: Record<string, string> };
export type Workflow = { jobs: Record<string, { steps: Step[] }> };
export type PrFile = { filename: string; status: string; patch?: string };

export const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
export const steps = Object.values((parse(read('.github/workflows/release.yml')) as Workflow).jobs).flatMap((j) => j.steps);
export const guard = steps.find((s) => s.id === 'release-pr-guard');

export const REPO = 'acme/widget';
export const SHA = 'feedface';
export const BRANCH = 'release-please--branches--main--components--widget';
export const config = read('tests/fixtures/release-pr-guard/release-please-config.json');

/** A `git diff` split into the per-file entries of GitHub's pull-request files API. */
export const prFiles = (diff: string): PrFile[] =>
  diff
    .split(/^diff --git /m)
    .slice(1)
    .map((chunk) => {
      const filename = /^\+\+\+ b\/(.+)$/m.exec(chunk)?.[1] ?? '';
      const hunks = chunk.slice(chunk.indexOf('\n@@') + 1).replace(/\n$/, '');
      return { filename, status: 'modified', patch: hunks };
    });
export const stale = prFiles(read('tests/fixtures/release-pr-guard/0.10.0-stale.diff'));
export const clean = prFiles(read('tests/fixtures/release-pr-guard/0.11.0-clean.diff'));
// #90: every other release commit Kanon has made (0.4.0 to 0.15.1, the squash commits of its
// release PRs). Releases before 0.4.0 didn't come from a release PR.
export const HISTORY = readdirSync(new URL('../../fixtures/release-pr-guard/history/', import.meta.url))
  .filter((f) => f.endsWith('.diff'))
  .map((f) => [f.replace(/\.diff$/, ''), prFiles(read(`tests/fixtures/release-pr-guard/history/${f}`))] as const);

/** The manifest change of a release PR, which names the versions it releases. */
export const manifest = (...moves: Array<[string, string, string]>): PrFile => ({
  filename: '.release-please-manifest.json',
  status: 'modified',
  patch: `@@ -1,${moves.length + 2} +1,${moves.length + 2} @@\n {\n${moves.map(([path, from]) => `-  "${path}": "${from}"`).join(',\n')}\n${moves.map(([path, , to]) => `+  "${path}": "${to}"`).join(',\n')}\n }`,
});
export const MANIFEST_0_10 = manifest(['.', '0.9.1', '0.10.0']);

export const FAKE_GH = `#!/bin/sh
echo "$*" >> "$FAKE_GH_DIR/calls.log"
path=""; slurp=""
for a in "$@"; do
  case "$a" in repos/*) path="$a" ;; --slurp) slurp=1 ;; esac
done
case "$*" in *"-X POST"*) echo '{}'; exit 0 ;; esac
f="$FAKE_GH_DIR/$(printf %s "$path" | tr -c 'A-Za-z0-9._-' '_').json"
[ -f "$f" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
if [ -n "$slurp" ]; then printf '['; cat "$f"; printf ']'; else cat "$f"; fi
`;

export type Pr = { number: number; head: { ref: string; sha: string; repo: { full_name: string } }; base: { ref: string; sha: string } };
export const BASE_SHA = 'c0ffee00';
export const MERGE_BASE = 'ba5eba11';
export const releasePr = (number = 68, ref = BRANCH, owner = REPO): Pr => ({
  number,
  head: { ref, sha: SHA, repo: { full_name: owner } },
  base: { ref: 'main', sha: BASE_SHA },
});

/**
 * The manifest at the merge base and at the head, rebuilt from its patch: the context and `-`
 * lines, and the context and `+` lines. Every manifest patch here is one hunk over the whole
 * file, which the rebuilt JSON parsing confirms.
 */
export const manifestSides = (patch: string) => {
  const base: string[] = [];
  const head: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('\\')) continue;
    if (!line.startsWith('+')) base.push(line.slice(1));
    if (!line.startsWith('-')) head.push(line.slice(1));
  }
  return { base: `${base.join('\n')}\n`, head: `${head.join('\n')}\n` };
};
export const contents = (text: string) => ({ encoding: 'base64', content: Buffer.from(text).toString('base64') });

export const responses = (opts: { prs?: Pr[]; files?: PrFile[]; comments?: Array<{ body: string }>; manifest?: { base: string; head: string } }): Record<string, unknown> => {
  const patch = opts.files?.find((f) => f.filename === '.release-please-manifest.json')?.patch;
  const sides = opts.manifest ?? (patch === undefined ? undefined : manifestSides(patch));
  return {
    [`repos/${REPO}/pulls?state=open&per_page=100`]: opts.prs ?? [releasePr()],
    [`repos/${REPO}/git/ref/heads/${BRANCH}`]: { object: { sha: SHA } },
    [`repos/${REPO}/contents/release-please-config.json?ref=${SHA}`]: contents(config),
    // The diff of the confirmed head, read by its SHA (#246). `pulls/68/files` is never read,
    // so it isn't answered.
    [`repos/${REPO}/compare/${BASE_SHA}...${SHA}?per_page=1`]: { merge_base_commit: { sha: MERGE_BASE }, files: opts.files ?? [] },
    [`repos/${REPO}/issues/68/comments?per_page=100`]: opts.comments ?? [],
    ...(sides && {
      [`repos/${REPO}/contents/.release-please-manifest.json?ref=${MERGE_BASE}`]: contents(sides.base),
      [`repos/${REPO}/contents/.release-please-manifest.json?ref=${SHA}`]: contents(sides.head),
    }),
  };
};

export const runGuard = (answers: Record<string, unknown>) => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-release-pr-guard-'));
  writeFileSync(join(dir, 'gh'), FAKE_GH);
  chmodSync(join(dir, 'gh'), 0o755);
  for (const [path, body] of Object.entries(answers)) {
    writeFileSync(join(dir, `${path.replace(/[^A-Za-z0-9._-]/g, '_')}.json`), JSON.stringify(body));
  }
  const script = join(dir, 'step');
  writeFileSync(script, guard?.run ?? 'process.exit(99)');
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH ?? ''}`, FAKE_GH_DIR: dir, GITHUB_REPOSITORY: REPO, RELEASE_PR_GUARD_WAIT_MS: '0' },
  });
  const calls = existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8') : '';
  const posted = calls.split('\n').filter((c) => c.includes('-X POST'));
  const bodyFile = /body=@(\S+)/.exec(posted[0] ?? '')?.[1];
  return { ...result, calls, posted, comment: bodyFile && existsSync(bodyFile) ? readFileSync(bodyFile, 'utf8') : '' };
};
