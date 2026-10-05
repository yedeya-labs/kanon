// #77: no lane reads an output of the adopter's project-setup hook. The hook contract
// (plan 0001 §5, `lane-check`'s hook rule) defines the hook's inputs and no outputs, so a
// lane that reads one depends on something an adopter is never told to provide. The review
// lane did, for `install` and `database`, until #77; actionlint reported it ("property … is
// not defined") once Kanon's own hook, which declares none, existed. A lane judges the hook
// by its outcome alone.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { id?: string; uses?: string };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

const dir = new URL('../../.github/workflows/', import.meta.url);
const HOOK = /^\.\/\.github\/actions\/project-setup\/?$/;

const calls = readdirSync(dir)
  .filter((f) => /\.ya?ml$/.test(f))
  .flatMap((file) => {
    const wf = parse(readFileSync(new URL(file, dir), 'utf8')) as Workflow;
    return Object.entries(wf.jobs ?? {}).flatMap(([name, job]) =>
      (job.steps ?? []).filter((s) => HOOK.test(s.uses ?? '')).map((s) => ({ at: `${file} jobs.${name}`, id: s.id, job })),
    );
  });

/** Every `steps.<id>.outputs` read of the step, in any form an expression can spell it. */
const reads = (id: string, job: unknown): string[] => {
  const name = id.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const pattern = new RegExp(`steps\\s*(?:\\.\\s*${name}|\\[\\s*['"]${name}['"]\\s*\\])\\s*(?:\\.\\s*outputs|\\[\\s*['"]outputs['"]\\s*\\])`, 'gi');
  return strings(job).flatMap((text) => text.match(pattern) ?? []);
};

/** Every string in a parsed YAML value: keys and values, so no field is skipped. */
const strings = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [k, ...strings(v)]);
  return [];
};

describe('#77 no lane reads an output of the project-setup hook', () => {
  it('finds the hook calls, so the check below is not vacuous', () => {
    // The review lane calls no hook since kanon#185; the four lanes below still do.
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(calls.map((c) => c.at)).toEqual(expect.arrayContaining([expect.stringMatching(/^agent-verify-acs\.yml /)]));
    expect(calls.filter((c) => c.id).map((c) => c.id)).toContain('project');
  });

  it('no job that calls the hook reads its outputs; it judges the hook by its outcome', () => {
    const found = calls.flatMap((c) => (c.id ? reads(c.id, c.job).map((r) => `${c.at}: ${r}`) : []));
    expect(found).toEqual([]);
  });

  it.each([
    ['steps.project.outputs.install'],
    ["steps['project'].outputs.database"],
    ['steps.project["outputs"].x'],
    ['STEPS.Project.Outputs.x'],
  ])('recognises the read %s', (expression) => {
    expect(reads('project', { if: `\${{ ${expression} }}` })).toHaveLength(1);
  });

  it('does not mistake the outcome, or another step, for an output read', () => {
    expect(reads('project', { if: "steps.project.outcome != 'success' && steps.projectx.outputs.y && steps.hook.outputs.sha" })).toEqual([]);
  });
});
