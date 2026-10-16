import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exploreCheck } from '../../scripts/explore-telemetry-check.mjs';
import { HOSTED_AGGREGATE_URL } from '../../scripts/lib/telemetry-token.mjs';
import { COLLECTOR_LANE, OWN_STORE_INPUTS, ownStoreInputs } from '../../scripts/lib/telemetry-consent.mjs';
import { HOSTED_URL, SELF_AUDIENCE, SELF_URL } from '../unit/helpers/token-net.js';
import { SPAWNS } from '../unit/helpers/spawns.js';

/**
 * Plan 0008 §2.1, §3.3, step J5: the telemetry Explorer's gate, before any token is minted. A
 * self-hosted store named by the lane's two variables is read; Kanon's hosted one only for a
 * repository whose collector's caller sends to it. A caller that names a store of its own is
 * refused, naming the variables, and never sent to the hosted store (`K-OBS-18`; the Owner's
 * decision on #842).
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/explore-telemetry-check.mjs', import.meta.url));
const ENV = { GITHUB_REPOSITORY: 'acme/widgets' };
const SELF = { KANON_AGGREGATE_TOKEN_URL: SELF_URL, KANON_TELEMETRY_AUDIENCE: SELF_AUDIENCE };
/** A collector caller, with the `with:` lines given. */
const caller = (withLines = '') => `name: Telemetry\non:\n  schedule:\n    - cron: "17 * * * *"\njobs:\n  collect:\n    uses: yedeya-labs/kanon/.github/workflows/telemetry-collect.yml@v0.41.0\n${withLines ? `    with:\n${withLines}` : ''}`;
const snapshot = (files: Record<string, string>) => () => ({ data: { repository: { workflows: { entries: Object.entries(files).map(([name, text]) => ({ name, type: 'blob', object: { text } })) }, record: null } } });

describe('the collector\'s own-store inputs', () => {
  it('reads url, audience and writer-role from any job calling Kanon\'s collector, a local reusable workflow\'s included', () => {
    expect(COLLECTOR_LANE).toBe('telemetry-collect');
    expect(OWN_STORE_INPUTS).toEqual(['url', 'audience', 'writer-role']);
    expect(ownStoreInputs(new Map([['telemetry.yml', caller()]]))).toEqual([]);
    expect(ownStoreInputs(new Map([['telemetry.yml', caller('      url: https://x\n      audience: acme\n')]]))).toEqual(['audience', 'url']);
    expect(ownStoreInputs(new Map([['telemetry.yml', caller('      url: ${{ vars.KANON_TELEMETRY_URL }}\n      writer-role: ${{ vars.KANON_TELEMETRY_WRITER_ROLE }}\n')]]))).toEqual(['url', 'writer-role']);
    // The call nested in a local reusable workflow: its `with:` is in the inner file.
    const outer = 'name: T\non:\n  schedule:\n    - cron: "1 * * * *"\njobs:\n  t:\n    uses: ./.github/workflows/inner.yml\n';
    const inner = `name: Inner\non: workflow_call\njobs:\n  collect:\n    uses: yedeya-labs/kanon/.github/workflows/telemetry-collect.yml@v0.41.0\n    with:\n      audience: acme\n`;
    expect(ownStoreInputs(new Map([['t.yml', outer], ['inner.yml', inner]]))).toEqual(['audience']);
    // The erase and register inputs name no store; another workflow's `url:` is not the collector's.
    expect(ownStoreInputs(new Map([['telemetry.yml', caller('      erase: no\n      register: no\n')], ['x.yml', 'jobs:\n  a:\n    uses: yedeya-labs/kanon/.github/workflows/agent-review.yml@v1\n    with:\n      url: x\n']]))).toEqual([]);
  });
});

describe('exploreCheck', () => {
  it('reads a self-hosted store by its two variables, without reading the branch', () => {
    const never = () => { throw new Error('must not read the branch'); };
    expect(exploreCheck({ ...ENV, ...SELF }, { json: never, hostedUrl: HOSTED_URL })).toEqual({ configured: 'true' });
  });

  it('reads the hosted store for a repository whose collector sends to it', () => {
    expect(exploreCheck(ENV, { json: snapshot({ 'telemetry.yml': caller() }), hostedUrl: HOSTED_URL })).toEqual({ configured: 'true' });
  });

  // #852's review: a collector that names a store of its own is no consent to the hosted one.
  it('refuses, naming the variables, a repository whose collector names a store of its own, and never sends it to the hosted store', () => {
    for (const w of ['      url: https://x\n      audience: acme\n', '      audience: acme\n', '      url: https://x\n      audience: acme\n      writer-role: arn\n']) {
      const r = exploreCheck(ENV, { json: snapshot({ 'telemetry.yml': caller(w) }), hostedUrl: HOSTED_URL });
      expect(r, w).toEqual({ error: expect.stringMatching(/^telemetry\.yml sends this repository's rows to a store of its own .* set the repository variables KANON_AGGREGATE_TOKEN_URL and KANON_TELEMETRY_AUDIENCE/) });
    }
    // #852's third review: a caller written before vM passes `url:` and `writer-role:`, a hosted
    // adopter's too, so its store can't be told: refused with both ways out, never told it is
    // self-hosted.
    for (const w of ['      url: ${{ vars.KANON_TELEMETRY_URL }}\n      writer-role: ${{ vars.KANON_TELEMETRY_WRITER_ROLE }}\n', '      url: https://x\n']) {
      const r = exploreCheck(ENV, { json: snapshot({ 'telemetry.yml': caller(w) }), hostedUrl: HOSTED_URL }) as { error: string };
      expect(r.error, w).toMatch(/^telemetry\.yml still passes `url:`.* to Kanon's collector without `audience:`.*for Kanon's hosted store, write the new caller with `kanon init --telemetry`.*for a store of your own, add `audience:` to the caller and set the repository variables KANON_AGGREGATE_TOKEN_URL and KANON_TELEMETRY_AUDIENCE/);
      expect(r.error, w).not.toContain('store of its own');
    }
    // With its own two variables set, the same repository reads its own store.
    expect(exploreCheck({ ...ENV, ...SELF }, { json: snapshot({ 'telemetry.yml': caller('      url: https://x\n      audience: acme\n') }), hostedUrl: HOSTED_URL })).toEqual({ configured: 'true' });
  });

  it('skips, green, with no collector or no published URL, and refuses a lone variable or an unreadable branch', () => {
    expect(exploreCheck(ENV, { json: snapshot({}), hostedUrl: HOSTED_URL })).toEqual({ configured: 'false', note: expect.stringMatching(/no workflow on the default branch calls Kanon's telemetry collector/) });
    expect(exploreCheck(ENV, { json: snapshot({ 'telemetry.yml': caller() }), hostedUrl: '' })).toEqual({ configured: 'false', note: expect.stringMatching(/not published/) });
    expect(exploreCheck({ ...ENV, KANON_AGGREGATE_TOKEN_URL: SELF_URL }, { json: snapshot({}), hostedUrl: HOSTED_URL })).toEqual({ error: expect.stringMatching(/name a self-hosted store together/) });
    expect(exploreCheck(ENV, { json: () => { throw new Error('HTTP 502\nmore'); }, hostedUrl: HOSTED_URL })).toEqual({ error: expect.stringMatching(/could not be read \(HTTP 502\)$/) });
  });
});

describe('the script, as the gate runs it', SPAWNS, () => {
  const run = (env: Record<string, string>) => spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });

  it('prints only true or false on stdout, and names a refusal on stderr, which `$(…)` under bash -e can\'t swallow', () => {
    const self = run({ ...ENV, ...SELF });
    expect([self.status, self.stdout]).toEqual([0, 'true\n']);
    const alone = run({ ...ENV, KANON_AGGREGATE_TOKEN_URL: SELF_URL });
    expect(alone.status).toBe(1);
    expect(alone.stdout).toBe('');
    expect(alone.stderr).toMatch(/^::error title=explore-telemetry::`the KANON_AGGREGATE_TOKEN_URL variable` and `the KANON_TELEMETRY_AUDIENCE variable` name a self-hosted store together/);
    const step = spawnSync('bash', ['-e', '-c', `configured="$(${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)})"; echo reached`], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...ENV, KANON_AGGREGATE_TOKEN_URL: SELF_URL } });
    expect(step.status).toBe(1);
    expect(step.stdout).not.toContain('reached');
    expect(step.stderr).toMatch(/::error title=explore-telemetry::.*name a self-hosted store together/);
    if (!HOSTED_AGGREGATE_URL) {
      const hosted = run(ENV);
      expect([hosted.status, hosted.stdout]).toEqual([0, 'false\n']);
      expect(hosted.stderr).toContain('not published');
    } else {
      // Published, the script would read the default branch through `gh`, which is a network call,
      // so the published constant is checked in-process with a snapshot instead.
      expect(exploreCheck(ENV, { json: snapshot({ 'telemetry.yml': caller() }) })).toEqual({ configured: 'true' });
    }
  });
});
