import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  EXPORT_FILES, FILES, HOOK_PATH, MANIFEST, MAX_ARG_STRLEN, MAX_ROWS_OUTPUT, OPERATIONS, READ_OPERATIONS, WRITE_OPERATIONS,
  absentLine, checkRequest, deleteExport, finish, prepare, readCostRowsFile,
} from '../../actions/qa-store/qa-store.mjs';

/**
 * Plan 0004 step P9: the QA store contract's block, `actions/qa-store`. The hook is the
 * adopter's; this holds what Kanon fixes: the five operations, the files each reads or writes,
 * and the no-op that says the store is absent when the repository has no hook (§3.2).
 */

type Step = { name?: string; id?: string; if?: string; uses?: string; run?: string; with?: Record<string, string>; env?: Record<string, string>; 'continue-on-error'?: boolean };
const action = parse(readFileSync('actions/qa-store/action.yml', 'utf8')) as {
  inputs: Record<string, { default?: string; required?: boolean; description?: string }>;
  outputs: Record<string, { value: string }>;
  runs: { using: string; steps: Step[] };
};
const steps = action.runs.steps;
const hookSteps = steps.filter((s) => s.uses === './.github/actions/qa-store');
const NOW = Date.parse('2026-10-04T12:00:00Z');

let work: string;
let workspace: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'qa-store-'));
  workspace = join(work, 'ws');
  mkdirSync(workspace);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));
const withHook = () => {
  mkdirSync(join(workspace, '.github/actions/qa-store'), { recursive: true });
  writeFileSync(join(workspace, HOOK_PATH), 'name: hook\n');
};
const env = (e: Record<string, string>) => ({ DIR: join(work, 'store'), WORKSPACE: workspace, ...e });

describe('the contract', () => {
  it('has five operations, two of them writes', () => {
    expect(OPERATIONS).toEqual(['last-green', 'record-skip', 'put', 'export', 'cost-rows']);
    expect([...WRITE_OPERATIONS, ...READ_OPERATIONS].sort()).toEqual([...OPERATIONS].sort());
    expect(HOOK_PATH).toBe('.github/actions/qa-store/action.yml');
  });

  it('refuses a request it can\'t carry, by name', () => {
    expect(checkRequest({ OPERATION: 'scan' }).problems).toEqual(["operation 'scan' is not one of last-green, record-skip, put, export, cost-rows"]);
    expect(checkRequest({ OPERATION: 'put', KIND: 'overseer' }).problems).toEqual(["put needs kind explorer or audit, not 'overseer'"]);
    expect(checkRequest({ OPERATION: 'export', KIND: 'explorer' }).problems).toEqual(["export needs kind audit or overseer, not 'explorer'"]);
    expect(checkRequest({ OPERATION: 'record-skip', COMMIT: 'abc' }).problems).toEqual(['record-skip needs commit, a full 40-character SHA']);
    expect(checkRequest({ OPERATION: 'cost-rows', KIND: 'implementer' }).problems).toEqual(['cost-rows needs from (a store stamp such as 20260904T120245Z) or days']);
    expect(checkRequest({ OPERATION: 'cost-rows', KIND: 'implementer', FROM: '2026-09-20' }).problems).toEqual(["from '2026-09-20' is not a store stamp such as 20260904T120245Z"]);
  });

  it('turns days into a window start in the store\'s stamp, and defaults an export to 30 days', () => {
    expect(checkRequest({ OPERATION: 'cost-rows', KIND: 'implementer', DAYS: '14' }, NOW).from).toBe('20260920T120000Z');
    expect(checkRequest({ OPERATION: 'export', KIND: 'overseer' }, NOW).from).toBe('20260904T120000Z');
  });
});

describe('without a hook, every operation says the store is absent and does nothing (§3.2)', () => {
  it.each(OPERATIONS)('%s', (op) => {
    const request: Record<string, string> = ({
      'last-green': {}, 'record-skip': { COMMIT: 'a'.repeat(40) }, put: { KIND: 'audit', REPORT: join(work, 'none.json') },
      export: { KIND: 'overseer' }, 'cost-rows': { KIND: 'implementer', DAYS: '14' },
    } as Record<string, Record<string, string>>)[op]!;
    const { outputs } = prepare(env({ OPERATION: op, ...request }), NOW);
    expect(outputs.present).toBe('false');
    const done = finish({ OPERATION: op, KIND: request.KIND ?? '', DIR: outputs.dir!, PRESENT: outputs.present!, HOOK_OUTCOME: '' }, NOW);
    // `cost-rows` also hands its answer on as `rows`, saying the store is absent.
    const rows = op === 'cost-rows' ? { rows: JSON.stringify({ rows: [], error: 'the QA store is absent' }) } : {};
    expect(done.outputs).toEqual({ present: 'false', state: 'absent', commit: '', ...rows });
    expect(done.line).toBe(absentLine(op));
    expect(done.line).toMatch(/^The QA store is absent: .* this run has no memory/);
  });

  it('an export still holds a manifest saying so, for the agent job to download', () => {
    const { outputs } = prepare(env({ OPERATION: 'export', KIND: 'audit' }), NOW);
    finish({ OPERATION: 'export', KIND: 'audit', DIR: outputs.dir!, PRESENT: 'false' }, NOW);
    const root = join(outputs.dir!, FILES.export);
    expect(readdirSync(root)).toEqual([MANIFEST]);
    expect(JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'))).toMatchObject({ store: 'absent', kind: 'audit', files: [] });
  });

  it('cost-rows returns no rows and an error naming the absence, which the sweep reads as "use artifacts"', () => {
    const { outputs } = prepare(env({ OPERATION: 'cost-rows', KIND: 'implementer', DAYS: '14' }), NOW);
    finish({ OPERATION: 'cost-rows', KIND: 'implementer', DIR: outputs.dir!, PRESENT: 'false' }, NOW);
    expect(readCostRowsFile(join(outputs.dir!, FILES.costRows))).toEqual({ rows: [], error: 'the QA store is absent' });
  });

  it('cost-rows says the same in its rows output, for a reader in another job (plan 0004 step 9)', () => {
    const { outputs } = prepare(env({ OPERATION: 'cost-rows', KIND: 'implementer', DAYS: '14' }), NOW);
    const done = finish({ OPERATION: 'cost-rows', KIND: 'implementer', DIR: outputs.dir!, PRESENT: 'false' }, NOW);
    expect(done.outputs).toMatchObject({ present: 'false', state: 'absent' });
    expect(JSON.parse(done.outputs.rows!)).toEqual({ rows: [], error: 'the QA store is absent' });
  });
});

describe('with a hook', () => {
  it('prepare writes what the hook reads: the report for put, the skip for record-skip', () => {
    withHook();
    const report = join(work, 'qa-audit-summary.json');
    writeFileSync(report, '{"complete":true,"areas_scanned":["scripts/x.mjs"]}');
    const put = prepare(env({ OPERATION: 'put', KIND: 'audit', REPORT: report }), NOW);
    expect(put.outputs.present).toBe('true');
    expect(JSON.parse(readFileSync(join(put.outputs.dir!, FILES.report), 'utf8'))).toEqual({ complete: true, areas_scanned: ['scripts/x.mjs'] });
    const skip = prepare(env({ OPERATION: 'record-skip', COMMIT: 'b'.repeat(40) }), NOW);
    expect(JSON.parse(readFileSync(join(skip.outputs.dir!, FILES.skip), 'utf8'))).toEqual({ commit: 'b'.repeat(40), trigger: 'schedule', tier: 'all', reason: 'unchanged-commit' });
  });

  it('put refuses a report that isn\'t a JSON object, and leaves a missing one to the hook', () => {
    withHook();
    const report = join(work, 'r.json');
    writeFileSync(report, '[1]');
    expect(() => prepare(env({ OPERATION: 'put', KIND: 'explorer', REPORT: report }), NOW)).toThrow(/not a JSON object/);
    writeFileSync(report, 'not json');
    expect(() => prepare(env({ OPERATION: 'put', KIND: 'explorer', REPORT: report }), NOW)).toThrow(/not JSON/);
    const missing = prepare(env({ OPERATION: 'put', KIND: 'explorer', REPORT: join(work, 'none.json') }), NOW);
    expect(missing.notices).toEqual([`no explorer report at '${join(work, 'none.json')}'`]);
    expect(existsSync(join(missing.outputs.dir!, FILES.report))).toBe(false);
  });

  describe('last-green', () => {
    const run = (content: string | null, outcome = 'success') => {
      withHook();
      const { outputs } = prepare(env({ OPERATION: 'last-green' }), NOW);
      if (content !== null) writeFileSync(join(outputs.dir!, FILES.lastGreen), content);
      return finish({ OPERATION: 'last-green', DIR: outputs.dir!, PRESENT: 'true', HOOK_OUTCOME: outcome }, NOW);
    };
    it('returns the hook\'s commit', () => {
      expect(run(`${'c'.repeat(40)}\n`).outputs).toEqual({ present: 'true', state: 'ok', commit: 'c'.repeat(40) });
    });
    it('returns no commit for an empty file or none, and is ok', () => {
      expect(run('').outputs).toEqual({ present: 'true', state: 'ok', commit: '' });
      expect(run(null).outputs).toEqual({ present: 'true', state: 'ok', commit: '' });
    });
    it('is degraded with no commit when the hook failed, or wrote a non-SHA (the gate\'s tripwire)', () => {
      expect(run('c'.repeat(40), 'failure').outputs).toEqual({ present: 'true', state: 'degraded', commit: '' });
      const tripped = run(`${'c'.repeat(40)}\nNone`);
      expect(tripped.outputs).toEqual({ present: 'true', state: 'degraded', commit: '' });
      expect(tripped.warnings[0]).toMatch(/non-SHA/);
    });
  });

  describe('export', () => {
    const run = (files: Record<string, string>, kind = 'overseer', outcome = 'success') => {
      withHook();
      const { outputs } = prepare(env({ OPERATION: 'export', KIND: kind }), NOW);
      const root = join(outputs.dir!, FILES.export);
      for (const [f, text] of Object.entries(files)) {
        mkdirSync(join(root, f, '..'), { recursive: true });
        writeFileSync(join(root, f), text);
      }
      const done = finish({ OPERATION: 'export', KIND: kind, DIR: outputs.dir!, PRESENT: 'true', HOOK_OUTCOME: outcome }, NOW);
      return { ...done, root, manifest: JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')) };
    };
    const full = Object.fromEntries(EXPORT_FILES.overseer.map((f) => [f, '[{"ts":"20261001T000000Z"}]']));

    it('keeps the files Kanon fixes, and the adopter\'s own Overseer inputs, and lists them', () => {
      const r = run({ ...full, 'token-trend.md': '# trend', 'reports/explorer/20261001T000000Z.json': '{}' });
      expect(r.outputs.state).toBe('ok');
      expect(r.manifest).toMatchObject({ store: 'present', kind: 'overseer', files: ['areas.json', 'coverage.json', 'reports', 'runs-audit.json', 'runs-explorer.json', 'token-trend.md'] });
    });

    it('leaves out a file the contract doesn\'t name, with a warning', () => {
      const r = run({ ...full, 'secrets.txt': 'x' });
      expect(r.outputs.state).toBe('ok');
      expect(existsSync(join(r.root, 'secrets.txt'))).toBe(false);
      expect(r.warnings).toEqual([expect.stringMatching(/'secrets\.txt', which isn't a file the overseer export holds/)]);
    });

    it('an audit export holds the code-reading ledger only', () => {
      const r = run({ 'areas.json': '[]', 'runs-audit.json': '[]' }, 'audit');
      expect(r.manifest.files).toEqual(['areas.json']);
      expect(r.warnings).toEqual([expect.stringMatching(/'runs-audit\.json'/)]);
    });

    it('is degraded, and empty but for its manifest, when a file is missing or malformed, or the hook failed', () => {
      for (const [files, outcome] of [[{ 'areas.json': '[]' }, 'success'], [{ ...full, 'coverage.json': '{"a":1}' }, 'success'], [full, 'failure']] as const) {
        const r = run(files, 'overseer', outcome);
        expect(r.outputs.state).toBe('degraded');
        expect(readdirSync(r.root)).toEqual([MANIFEST]);
        expect(r.manifest).toMatchObject({ store: 'degraded', files: [] });
      }
    });
  });

  describe('cost-rows', () => {
    const run = (content: string | null, outcome = 'success') => {
      withHook();
      const { outputs } = prepare(env({ OPERATION: 'cost-rows', KIND: 'implementer', DAYS: '14' }), NOW);
      const at = join(outputs.dir!, FILES.costRows);
      if (content !== null) writeFileSync(at, content);
      const done = finish({ OPERATION: 'cost-rows', KIND: 'implementer', DIR: outputs.dir!, PRESENT: 'true', HOOK_OUTCOME: outcome }, NOW);
      return { ...done, read: readCostRowsFile(at) };
    };
    const row = { ts: '20261001T000000Z', issue_number: '7', outcome: 'unavailable', run_id: '42' };

    it('passes the hook\'s rows through in readCostRows\' shape', () => {
      const r = run(JSON.stringify({ rows: [row], error: null }));
      expect(r.read).toEqual({ rows: [row], error: null });
      expect(r.line).toBe('QA store `cost-rows` (implementer): 1 rows.');
    });

    it('fails closed, and says why, on a failed hook or a malformed file', () => {
      expect(run(JSON.stringify({ rows: [row], error: null }), 'failure').read).toEqual({ rows: [], error: 'the store hook failed' });
      expect(run(JSON.stringify({ rows: [], error: 'the store query failed (AccessDenied)' }), 'failure').read)
        .toEqual({ rows: [], error: 'the store query failed (AccessDenied)' });
      expect(run(null).read).toEqual({ rows: [], error: expect.stringMatching(/could not be read/) });
      expect(run(JSON.stringify({ rows: [{ ...row, issue_number: 7 }] })).read).toEqual({ rows: [], error: "the store's cost rows are malformed (rows[0].issue_number is neither a string nor null)" });
      expect(run('[]').outputs.state).toBe('degraded');
    });

    it('hands the same answer on as the rows output, one line of JSON', () => {
      const ok = run(JSON.stringify({ rows: [row], error: null }));
      expect(ok.outputs.rows).toBe(JSON.stringify({ rows: [row], error: null }));
      expect(ok.outputs.rows).not.toContain('\n');
      const failed = run(JSON.stringify({ rows: [row], error: null }), 'failure');
      expect(JSON.parse(failed.outputs.rows!)).toEqual({ rows: [], error: 'the store hook failed' });
    });

    it('bounds the answer below the one environment string the sweep\'s step can be handed (MAX_ARG_STRLEN)', () => {
      // The reader gets the answer as `QA_STORE_COST_ROWS_<AGENT>=<json>`: name, `=` and value
      // must fit in 131,072 bytes, or the sweep fails at exec (E2BIG) instead of degrading.
      expect(MAX_ARG_STRLEN).toBe(131_072);
      expect(MAX_ROWS_OUTPUT + 'QA_STORE_COST_ROWS_TRIAGE_FIX='.length + 1).toBeLessThan(MAX_ARG_STRLEN);
    });

    it('measures the answer in bytes, not UTF-16 units', () => {
      // 34,000 three-byte characters: 34,000 units, over 100,000 bytes.
      const wide = { ...row, outcome: '\u20ac'.repeat(34_000) };
      expect(run(JSON.stringify({ rows: [wide], error: null })).outputs.state).toBe('degraded');
    });

    it('degrades an answer too large for the reader, rather than truncating it', () => {
      const many = Array.from({ length: Math.ceil(MAX_ROWS_OUTPUT / 60) }, (_, i) => ({ ...row, run_id: String(1e10 + i) }));
      const r = run(JSON.stringify({ rows: many, error: null }));
      expect(r.outputs.state).toBe('degraded');
      expect(JSON.parse(r.outputs.rows!)).toEqual({ rows: [], error: `${many.length} cost rows are more than a job output holds (${MAX_ROWS_OUTPUT} bytes)` });
      expect(r.read.rows).toEqual([]);
    });
  });
});

describe('the block\'s steps', () => {
  it('runs the hook from the checkout, as `./.github/actions/qa-store`, in one write step and one read step', () => {
    expect(action.runs.using).toBe('composite');
    expect(hookSteps).toHaveLength(2);
    const [write, read] = hookSteps;
    expect(write?.if).toBe("steps.prepare.outputs.present == 'true' && (inputs.operation == 'put' || inputs.operation == 'record-skip')");
    expect(write?.['continue-on-error']).toBeUndefined();
    expect(read?.if).toBe("steps.prepare.outputs.present == 'true' && (inputs.operation == 'last-green' || inputs.operation == 'export' || inputs.operation == 'cost-rows')");
    expect(read?.['continue-on-error']).toBe(true);
    for (const s of hookSteps) expect(Object.keys(s.with ?? {}).sort()).toEqual(['dir', 'from', 'kind', 'operation', 'secrets', 'to', 'variables']);
  });

  // kanon#423: a composite action can't read `vars`, so the lane hands the repository's variables
  // to the block, and the block to the hook, unchanged: the hook reads its store's coordinates
  // there, and nothing account-specific is committed.
  it('hands the hook the variables the lane passed, unchanged, in both hook steps', () => {
    expect(action.inputs.variables).toEqual({ description: expect.stringContaining('toJSON(vars)'), required: false, default: '' });
    for (const s of hookSteps) expect(s.with?.variables).toBe('${{ inputs.variables }}');
  });

  // kanon#433: the store's coordinates are secrets, which the lane builds into one line of JSON
  // by name and the block hands on unchanged; `variables` stays, deprecated, for one move.
  it('hands the hook the store\'s secrets the lane passed, unchanged, in both hook steps', () => {
    expect(action.inputs.secrets).toEqual({ description: expect.stringContaining('QA_STORE_ROLE_ARN'), required: false, default: '' });
    expect(action.inputs.variables?.description).toMatch(/^Deprecated \(kanon#433\)/);
    for (const s of hookSteps) expect(s.with?.secrets).toBe('${{ inputs.secrets }}');
  });

  it('is handed the repository\'s variables by every store step of every lane, and the delete step none', () => {
    const dir = '.github/workflows';
    const store = readdirSync(dir).filter((f) => f.endsWith('.yml')).flatMap((f) => {
      const wf = parse(readFileSync(join(dir, f), 'utf8')) as { jobs?: Record<string, { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }> };
      return Object.entries(wf.jobs ?? {}).flatMap(([job, j]) => (j.steps ?? [])
        .filter((st) => st.uses === '$/actions/qa-store')
        .map((st) => ({ at: `${f}:${job}:${String(st.with?.operation)}`, op: st.with?.operation, variables: st.with?.variables })));
    });
    const reads = store.filter((x) => x.op !== 'delete-export');
    expect(reads.length).toBeGreaterThanOrEqual(8);
    for (const x of reads) expect(x.variables, x.at).toBe('${{ toJSON(vars) }}');
    for (const x of store.filter((y) => y.op === 'delete-export')) expect(x.variables, x.at).toBeUndefined();
  });

  it('reports the read step\'s outcome, which continue-on-error leaves as failure, not its conclusion', () => {
    const fin = steps.find((s) => s.id === 'finish');
    expect(fin?.env?.HOOK_OUTCOME).toBe('${{ steps.read.outcome }}');
  });

  it('checks out without persisting credentials, and never for delete-export', () => {
    const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with).toEqual({ 'persist-credentials': false });
    expect(checkout?.if).toBe("inputs.operation != 'delete-export'");
  });

  it('uploads an export kept one day, and deletes it with the job token', () => {
    const upload = steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.if).toBe("inputs.operation == 'export'");
    expect(upload?.with?.['retention-days']).toBe(1);
    expect(upload?.with?.name).toBe('kanon-qa-store-export-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(action.outputs['artifact-name']?.value).toBe("${{ format('kanon-qa-store-export-{0}-{1}', github.run_id, github.run_attempt) }}");
    const del = steps.find((s) => s.if === "inputs.operation == 'delete-export'");
    expect(del?.run).toBe('node "$GITHUB_ACTION_PATH/qa-store.mjs" delete-export');
    expect(del?.env).toMatchObject({
      GH_TOKEN: '${{ github.token }}', ARTIFACT_ID: '${{ inputs.artifact-id }}', EXPORT_ATTEMPT: '${{ inputs.export-attempt }}',
      RUN_ATTEMPT: '${{ github.run_attempt }}', AGENT_RESULT: '${{ inputs.agent-result }}',
    });
    expect(action.outputs.attempt?.value).toBe('${{ github.run_attempt }}');
  });

  it('interpolates no expression into a run line, and names neither vars nor secrets', () => {
    for (const s of steps.filter((x) => x.run)) expect(s.run).not.toContain('${{');
    expect(readFileSync('actions/qa-store/action.yml', 'utf8')).not.toMatch(/\$\{\{[^}]*\b(vars|secrets)\./);
  });
});

describe('the script, as the block runs it', () => {
  const script = 'actions/qa-store/qa-store.mjs';
  it('fails a bad request by name, and writes the outputs to GITHUB_OUTPUT', () => {
    const out = join(work, 'out');
    const bad = spawnSync(process.execPath, [script, 'prepare'], { env: { ...process.env, OPERATION: 'nope', GITHUB_OUTPUT: out }, encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("::error title=qa-store::operation 'nope' is not one of");
    const ok = spawnSync(process.execPath, [script, 'prepare'], { env: { ...process.env, OPERATION: 'last-green', DIR: join(work, 's'), WORKSPACE: workspace, GITHUB_OUTPUT: out }, encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('present=false\n');
    const summary = join(work, 'summary');
    const fin = spawnSync(process.execPath, [script, 'finish'], { env: { ...process.env, OPERATION: 'last-green', DIR: join(work, 's'), PRESENT: 'false', GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary }, encoding: 'utf8' });
    expect(fin.status).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('state=absent\n');
    expect(readFileSync(summary, 'utf8')).toBe(`${absentLine('last-green')}\n`);
  });
});

describe('delete-export, and a re-run of the agent job alone (kanon#224)', () => {
  const calls: Array<{ url: string; method?: string; auth?: string }> = [];
  const api = (status: number) => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, auth: (init?.headers as Record<string, string>)?.authorization });
    return new Response(null, { status });
  }) as typeof fetch;
  const base = { REPO: 'o/r', GH_TOKEN: 't', GITHUB_API_URL: 'https://api.example', ARTIFACT_ID: '42', EXPORT_ATTEMPT: '1', RUN_ATTEMPT: '1', AGENT_RESULT: 'success' };
  beforeEach(() => { calls.length = 0; });

  it('deletes the export by id with the job token, and stays green', async () => {
    expect(await deleteExport(base, api(204))).toEqual({ lines: ['Deleted the QA store export (artifact 42).'], error: null });
    expect(calls).toEqual([{ url: 'https://api.example/repos/o/r/actions/artifacts/42', method: 'DELETE', auth: 'Bearer t' }]);
  });

  it('takes an export already gone as deleted, and fails any other answer', async () => {
    expect(await deleteExport(base, api(404))).toEqual({ lines: ['The QA store export (artifact 42) was already deleted.'], error: null });
    expect((await deleteExport(base, api(500))).error).toBe('deleting the QA store export (artifact 42) failed: HTTP 500');
    expect((await deleteExport(base, api(403))).error).toBe('deleting the QA store export (artifact 42) failed: HTTP 403');
  });

  it('refuses a malformed id or a missing attempt before calling the API', async () => {
    expect((await deleteExport({ ...base, ARTIFACT_ID: '4 2' }, api(204))).error).toBe("artifact-id '4 2' is not a number");
    expect((await deleteExport({ ...base, EXPORT_ATTEMPT: '' }, api(204))).error).toBe("delete-export needs export-attempt, the export job's attempt output");
    expect(calls).toEqual([]);
    expect(await deleteExport({ ...base, ARTIFACT_ID: '' }, api(204))).toEqual({ lines: ['No export artifact to delete: the export job uploaded none.'], error: null });
  });

  it('turns a partial re-run that skipped the agent job red, and says to re-run all jobs', async () => {
    const r = await deleteExport({ ...base, RUN_ATTEMPT: '2', AGENT_RESULT: 'skipped' }, api(404));
    expect(r.lines).toEqual(['The QA store export (artifact 42) was already deleted.']);
    expect(r.error).toBe('attempt 2 re-ran the agent job without the export job, whose export, from attempt 1, was deleted when that attempt finished. '
      + 'The agent job was skipped rather than run without the store. Use "Re-run all jobs", which exports again.');
  });

  it('leaves green a re-run of the delete job alone, and an agent skipped on the export\'s own attempt', async () => {
    // Attempt 1's agent succeeded and its delete failed: attempt 2 re-runs only the delete.
    expect((await deleteExport({ ...base, RUN_ATTEMPT: '2' }, api(204))).error).toBeNull();
    // The export failed, so the agent was skipped in the same attempt: the export's red is the page.
    expect((await deleteExport({ ...base, AGENT_RESULT: 'skipped' }, api(204))).error).toBeNull();
  });
});
