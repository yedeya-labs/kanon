// actions/create-github-app-token deprecated its `app-id` input in v3.1.0 in favour of
// `client-id`. Both feed the same value to the JWT's issuer (`core.getInput("client-id") ||
// core.getInput("app-id")`, passed to createAppAuth as `appId`), and GitHub accepts either an
// App's client ID or its numeric App ID as the issuer, so Kanon passes the `<ROLE>_APP_ID`
// secret it already has under the new name, and adopters need no new secret.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { uses?: string; with?: Record<string, unknown> };
type Doc = { jobs?: Record<string, { steps?: Step[] }>; runs?: { steps?: Step[] } };

const root = fileURLToPath(new URL('../../', import.meta.url));
const yamlIn = (dir: string, recurse = false): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true, recursive: recurse })
    .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
    .map((e) => relative(root, join(e.parentPath, e.name)));

const files = [...yamlIn('.github/workflows/'), ...yamlIn('actions/', true), ...yamlIn('tests/fixtures/', true)];
const mints = files.flatMap((file) => {
  const doc = parse(readFileSync(join(root, file), 'utf8')) as Doc | null;
  const steps = [...Object.values(doc?.jobs ?? {}).flatMap((j) => j.steps ?? []), ...(doc?.runs?.steps ?? [])];
  return steps.filter((s) => (s.uses ?? '').startsWith('actions/create-github-app-token@')).map((s) => ({ file, step: s }));
});

describe("Kanon mints App tokens with create-github-app-token's `client-id` input, not the deprecated `app-id`", () => {
  it('finds the mint steps, so the check below is not vacuous', () => {
    expect(mints.length).toBeGreaterThanOrEqual(10);
    expect(mints.map((m) => m.file)).toEqual(expect.arrayContaining(['.github/workflows/apps-check.yml', '.github/workflows/agent-lane.yml']));
  });

  it('every mint passes `client-id`, from an `_APP_ID` secret, and none passes `app-id`', () => {
    // `actions/implementer-status` mints from its `app-id` input, which every caller fills from
    // the `AUTHOR_APP_ID` secret (`tests/unit/implementer-status.test.ts` holds them to it).
    const viaInput = (file: string, id: string) => file === 'actions/implementer-status/action.yml' && id === '${{ inputs.app-id }}';
    const wrong = mints
      .filter(({ file, step }) => 'app-id' in (step.with ?? {})
        || !(/_APP_ID\b|secrets\.app-id\b/.test(String(step.with?.['client-id'] ?? '')) || viaInput(file, String(step.with?.['client-id'] ?? ''))))
      .map(({ file, step }) => `${file}: ${JSON.stringify(step.with)}`);
    expect(wrong).toEqual([]);
  });
});
