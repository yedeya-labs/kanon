import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { declaredPluginRef } from '../../actions/lane-check/plugin-ref.mjs';
import { pluginSettingsFile } from '../../cli/plugin.mjs';
import { adopter, check, laneCheck, type Tree } from './helpers/lane-check.js';

/**
 * `actions/lane-check`: the kanon plugin's `ref` in `.claude/settings.json` against the callers'
 * one version (K-ADOPT-11, kanon#1552). Dependabot moves the callers and never that file, so its
 * bump leaves the plugin at the old release; lane-check warns on the pull request, and never fails
 * it. Any repository that declares the plugin gets the warning.
 *
 * One of the lane-check files split by area (kanon#381); `tests/unit/helpers/lane-check.ts`
 * says how every case runs and holds the helpers they share.
 */
laneCheck(() => {
  describe("the kanon plugin's ref follows the callers' pin (kanon#1552)", () => {
    const SETTINGS = '.claude/settings.json';
    const PIN = 'v1.2.3';
    const settings = (text: string) => (t: Tree) => {
      mkdirSync(join(t.dir, '.claude'), { recursive: true });
      t.write(SETTINGS, text);
    };
    const run = (change: (t: Tree) => void) => {
      const t = adopter();
      change(t);
      return check(t);
    };
    const warning = `::warning file=${SETTINGS},title=lane-check::declares the kanon plugin's marketplace`;

    it("warns, without failing, on a plugin ref other than the callers' pin, as a Dependabot bump leaves it", () => {
      const r = run(settings(pluginSettingsFile('v1.2.2')));
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain(`${warning} "kanon" at v1.2.2, but the callers pin ${PIN}`);
      expect(r.out).toContain(`Set its ref to ${PIN} on this pull request`);
      // The closing line counts it as a warning that never fails, not as one a later release fails.
      expect(r.out).toMatch(/^lane-check: .*, and 1 warning\(s\) that never fail$/m);
      expect(r.out).not.toContain('fail in a later release');
    });

    it('warns on a declared marketplace with no ref, under any name, by its source', () => {
      const r = run(settings(JSON.stringify({ extraKnownMarketplaces: { tools: { source: { source: 'git', url: 'https://github.com/yedeya-labs/kanon.git' } } } })));
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain(`${warning} "tools" with no ref, so it follows Kanon's default branch, but the callers pin ${PIN}`);
    });

    it("says nothing of a plugin at the callers' pin, of no settings file, of another marketplace, or of a file that isn't JSON", () => {
      for (const change of [
        settings(pluginSettingsFile(PIN)),
        () => {},
        settings(JSON.stringify({ extraKnownMarketplaces: { kanon: { source: { source: 'github', repo: 'acme/kanon-fork', ref: 'v0.1.0' } } } })),
        settings('{'),
      ]) {
        const r = run(change);
        expect(r.status, r.out).toBe(0);
        expect(r.out).not.toContain(`file=${SETTINGS}`);
      }
    });
  });
});

describe("lane-check's reader of the plugin's declaration (actions/lane-check/plugin-ref.mjs)", () => {
  it('reads the ref of the marketplace whose source is Kanon, the alias only without the canonical key', () => {
    expect(declaredPluginRef(pluginSettingsFile('v1.0.0'))).toEqual({ name: 'kanon', ref: 'v1.0.0' });
    expect(declaredPluginRef(JSON.stringify({ additionalMarketplaces: { k: { source: { source: 'github', repo: 'Yedeya-Labs/Kanon', ref: ' ' } } } }))).toEqual({ name: 'k', ref: null });
    expect(declaredPluginRef(JSON.stringify({ extraKnownMarketplaces: {}, additionalMarketplaces: { k: { source: { source: 'github', repo: 'yedeya-labs/kanon' } } } }))).toBeUndefined();
    for (const text of [null, '[]', '{', '{}']) expect(declaredPluginRef(text), String(text)).toBeUndefined();
  });
});
