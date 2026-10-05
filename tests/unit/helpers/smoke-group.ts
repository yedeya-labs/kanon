/**
 * The lanes' `smoke` input and the concurrency-group suffix it drives (smoke-concurrency.test.ts).
 *
 * Every lane's concurrency group ends with SMOKE_SUFFIX, which is `-smoke-<run id>` on a call
 * from `agent-lanes-smoke.yml` and nothing on a real run. The tests of each lane's own group
 * are about its real runs, so they read the group through `realGroup`, and the tests of a
 * lane's inputs are about its caller's, so they read them through `callerInputs`.
 */
export const SMOKE_SUFFIX = "${{ inputs.smoke && format('-smoke-{0}', github.run_id) || '' }}";

/** A lane's concurrency group as its real runs have it. Throws when the suffix is missing. */
export function realGroup(group: string): string {
  if (!group.endsWith(SMOKE_SUFFIX)) throw new Error(`concurrency group without the smoke suffix: ${group}`);
  return group.slice(0, -SMOKE_SUFFIX.length);
}

/** A lane's `workflow_call` inputs without `smoke`, which no caller passes; undefined when none are left. */
export function callerInputs<T>(inputs: Record<string, T> | undefined): Record<string, T> | undefined {
  if (!inputs || !('smoke' in inputs)) throw new Error('a lane without the `smoke` input');
  const rest = Object.fromEntries(Object.entries(inputs).filter(([k]) => k !== 'smoke'));
  return Object.keys(rest).length ? rest : undefined;
}
