import { describe, expect, it, vi } from 'vitest';
import { briefTemplateAt, latestStable, requirementsAt } from '../../cli/doctor.mjs';
import { SPAWNS } from './helpers/spawns.js';
import { checkout, fakeGitHub, healthyFiles, NEXT, PINNED, REQ, run } from './helpers/doctor.js';

vi.setConfig({ testTimeout: SPAWNS.timeout });

// kanon#1574: the yedeya-labs organisation refuses a fine-grained token whose lifetime is over 366
// days, so doctor's reads of Kanon's public repository failed with a bare 403 though the token
// works on the person's own. Each is read again with no credential, and a failure names why.
describe("kanon doctor reads Kanon's public repository without a token GitHub refuses there (#1574)", () => {
  const depsOf = (github: ReturnType<typeof fakeGitHub>) => ({ gh: github.gh, anon: github.anon, release: () => PINNED, requirements: () => REQ, briefTemplate: () => 'ours' }) as unknown as Parameters<typeof requirementsAt>[0];
  const refused = (over: Parameters<typeof fakeGitHub>[0] = {}) => {
    const g = fakeGitHub(over);
    g.st.kanonRefused = true;
    return g;
  };

  it('reads a release\'s requirements file and brief template from raw.githubusercontent.com, with no credential', async () => {
    const g = refused({ releases: { [NEXT]: REQ }, templates: { [NEXT]: '# Brief\n' } });
    expect(await requirementsAt(depsOf(g), NEXT)).toEqual(REQ);
    expect(await briefTemplateAt(depsOf(g), NEXT)).toBe('# Brief\n');
    expect(g.anonCalls).toEqual([`https://raw.githubusercontent.com/yedeya-labs/kanon/${NEXT}/requirements.json`, `https://raw.githubusercontent.com/yedeya-labs/kanon/${NEXT}/rulebook/templates/brief.md`]);
    // A token that isn't refused reads with it, as before, and nothing anonymous.
    const fine = fakeGitHub({ releases: { [NEXT]: REQ } });
    expect(await requirementsAt(depsOf(fine), NEXT)).toEqual(REQ);
    expect(fine.anonCalls).toEqual([]);
  });

  it('keeps a 404 absent, and names the refusal and the 366-day rule when the read without the token fails too', async () => {
    await expect(requirementsAt(depsOf(refused()), NEXT)).rejects.toThrow(`Kanon ${NEXT} ships no requirements file`);
    const down = refused({ releases: { [NEXT]: REQ } });
    down.st.anonDown = true;
    await expect(requirementsAt(depsOf(down), NEXT)).rejects.toThrow(/GitHub refused the token on yedeya-labs\/kanon \(.*HTTP 403\)\), as the yedeya-labs organisation does a fine-grained token whose lifetime is over 366 days, and reading it without the token failed too/);
    await expect(briefTemplateAt(depsOf(down), NEXT)).rejects.toThrow(/366 days or less/);
    // Any other failure is as before: no anonymous read.
    const other = fakeGitHub();
    await expect(requirementsAt(depsOf(other), NEXT)).rejects.toThrow(`Kanon ${NEXT} ships no requirements file`);
    expect(other.anonCalls).toEqual([]);
  });

  it('reads the latest release from the API with no credential, and leaves it unknown when that fails too', async () => {
    const g = refused({ latest: 'v9.0.0' });
    expect(await latestStable(depsOf(g))).toBe('v9.0.0');
    expect(g.anonCalls).toEqual(['https://api.github.com/repos/yedeya-labs/kanon/releases/latest']);
    const down = refused({ latest: 'v9.0.0' });
    down.st.anonDown = true;
    expect(await latestStable(depsOf(down))).toBeNull();
  });

  it('checks against another release end to end with a token refused on Kanon\'s repository', async () => {
    const g = refused({ releases: { [NEXT]: REQ } });
    const r = await run(checkout(healthyFiles()), g, ['--json', '--to', NEXT]);
    expect(r.json.error ?? null, r.err).toBeNull();
    expect(g.anonCalls).toContain(`https://raw.githubusercontent.com/yedeya-labs/kanon/${NEXT}/requirements.json`);
  });
});
