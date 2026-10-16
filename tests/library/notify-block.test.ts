import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  ARTIFACT, HOOK_PATH, LINE, check, chooseVersion, declaredVersions, finish, hookKind, masks, prepare, verdict,
} from '../../actions/notify/notify.mjs';
import { renderText } from '../../scripts/lib/notify-contract.mjs';
import { validate as validateRow } from '../../actions/agent-telemetry/schema.mjs';
import { DELIVERY_ARTIFACT } from '../../scripts/lib/telemetry-artifacts.mjs';
import { parseCondition } from '../unit/helpers/job-condition.js';
import { runWorkflowStep } from '../unit/helpers/workflow-step.js';
import { SPAWNS } from '../unit/helpers/spawns.js';
import { ROOT } from './helpers/adopter.js';

/**
 * Plan 0011 step N6: the `notify` block, `actions/notify` (§5, §6). Every "What must be true" of
 * the N6 row about the block is a case here, by name. The block's `action.yml` is run step by step
 * by a small harness: each step's `if:` and `${{ }}` evaluated, its `node notify.mjs <mode>` run
 * in-process with the step's own `env:`, the checkout, the download and the upload stood in for,
 * and the hook at the path run as the runner would: the fixture hook's own `run:` step in bash, and
 * Kanon's two prebuilt hooks to the point where they call Kanon's action, whose inputs are recorded.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the harness reads YAML as it comes
type Any = any;
type Step = { name?: string; id?: string; if?: string; uses?: string; run?: string; shell?: string; with?: Record<string, unknown>; env?: Record<string, unknown>; 'continue-on-error'?: boolean };

const ACTION = parse(readFileSync(join(ROOT, 'actions/notify/action.yml'), 'utf8')) as { inputs: Record<string, { default?: string }>; outputs: Record<string, { value: string }>; runs: { steps: Step[] } };
const FIXTURE_HOOK = readFileSync(join(ROOT, 'tests/fixtures/notify-hook', HOOK_PATH), 'utf8');
const SLACK_HOOK = readFileSync(join(ROOT, 'actions/notify/hooks/slack.yml'), 'utf8');
const WEBHOOK_HOOK = readFileSync(join(ROOT, 'actions/notify/hooks/webhook.yml'), 'utf8');
const SECRET = 'https://receiver.example/kanon/notarealsecretvalue';
const RUN_ID = '77';
const NOW = Date.parse('2026-10-15T08:00:00Z');

const message = (over: Any = {}): Any => ({
  schema_version: 1,
  kind: 'project-digest',
  severity: 'warning',
  title: 'Projects, Wednesday 15 October',
  summary: 'Three projects open. One is stopped on a decision you owe.',
  sections: [{ heading: 'Stopped', body: '- [#812](https://github.com/acme/widgets/issues/812) Support Array\\<string\\>' }],
  links: [{ label: 'The board', url: 'https://github.com/orgs/acme/projects/1' }],
  source: { repository: 'acme/widgets', lane: 'project-digest', run_url: 'https://github.com/acme/widgets/actions/runs/77' },
  ...over,
});
const producerArtifact = (attempt = 1) => `kanon-notify-project-digest-digest-${RUN_ID}-${attempt}`;

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'notify-block-')); });
afterEach(() => rmSync(work, { recursive: true, force: true }));

type Run = {
  inputs: Record<string, string>;
  /** The hook at the path, at the run's commit, or none. */
  hook?: string | null;
  /** The run's artifacts, by name: the producer's `message.json`. */
  artifacts?: Record<string, string>;
  attempt?: string;
  ref?: string;
  /** The hook's step fails, as a hook whose post was refused does. */
  hookFails?: boolean;
};

/** Run the block's steps as the runner would, and say what happened. */
const runBlock = ({ inputs: given, hook = FIXTURE_HOOK, artifacts = {}, attempt = '1', ref = 'refs/heads/main', hookFails = false }: Run) => {
  const temp = join(work, 'temp');
  const workspace = join(work, 'ws');
  mkdirSync(temp, { recursive: true });
  const inputs: Record<string, string> = { ...Object.fromEntries(Object.entries(ACTION.inputs).map(([k, v]) => [k, v.default ?? ''])), ...given };
  const steps: Record<string, { outputs: Record<string, string>; outcome: string }> = {};
  const context: Record<string, Record<string, string>> = {
    github: { workspace, run_id: RUN_ID, run_attempt: attempt, action_ref: '', ref, sha: 'c'.repeat(40) },
    runner: { temp },
    job: { workflow_ref: '', workflow_sha: '' },
  };
  let failed = false;
  const log: string[] = [];
  const hookCalls: Record<string, string>[] = [];
  const prebuilt: { uses: string; with: Record<string, string> }[] = [];
  const uploads: { name: string; content: string }[] = [];
  const checkouts: Record<string, unknown>[] = [];

  /** The value of one expression, in this run. */
  const value = (expr: string, scope: Record<string, string> = inputs): Any => {
    const tree = parseCondition(expr.trim());
    const ev = (n: Any): Any => {
      switch (n.kind) {
        case 'lit': return n.value;
        case 'ref': {
          const [head, ...rest] = String(n.path).split('.');
          if (head === 'inputs') return scope[rest.join('.')] ?? '';
          if (head === 'steps') {
            const s = steps[rest[0]!];
            if (!s) return '';
            return rest[1] === 'outcome' ? s.outcome : s.outputs[rest.slice(2).join('.')] ?? '';
          }
          return context[head!]?.[rest.join('.')] ?? '';
        }
        case 'call':
          if (n.name === 'always') return true;
          if (n.name === 'success') return !failed;
          if (n.name === 'failure') return failed;
          throw new Error(`unmodelled ${n.name}()`);
        case 'not': return !ev(n.arg);
        case 'and': { const l = ev(n.left); return l ? ev(n.right) : l; }
        case 'or': { const l = ev(n.left); return l ? l : ev(n.right); }
        case 'cmp': {
          const eq = String(ev(n.left) ?? '').toLowerCase() === String(ev(n.right) ?? '').toLowerCase();
          return n.op === '==' ? eq : !eq;
        }
      }
      throw new Error(`unmodelled ${n.kind}`);
    };
    return ev(tree);
  };
  const expand = (v: unknown, scope?: Record<string, string>) => String(v ?? '').replace(/\$\{\{([\s\S]*?)\}\}/g, (_, e: string) => String(value(e, scope)));
  const expandAll = (o: Record<string, unknown> | undefined, scope?: Record<string, string>) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, expand(v, scope)]));

  /** The hook, as the runner runs a local composite action. */
  const runHook = (withs: Record<string, string>) => {
    hookCalls.push(withs);
    const doc = parse(readFileSync(join(workspace, HOOK_PATH), 'utf8')) as { runs: { steps: Step[] } };
    for (const s of doc.runs.steps) {
      if (s.uses) {
        prebuilt.push({ uses: s.uses, with: expandAll(s.with, withs) });
        continue;
      }
      const r = runWorkflowStep({ run: s.run, shell: s.shell }, { env: { ...expandAll(s.env, withs), RUNNER_TEMP: temp } });
      if (r.status !== 0) throw new Error(`the hook's step failed: ${r.output}`);
    }
    if (hookFails) throw new Error('the hook\'s step failed: 400 invalid_payload');
  };

  /** One `node notify.mjs <mode>` step, in-process, as its CLI entry would run it. */
  const runMode = (mode: string, env: Record<string, string>): Record<string, string> => {
    switch (mode) {
      case 'mask': for (const m of masks(env.SECRET)) log.push(`::add-mask::${m}`); return {};
      case 'prepare': { const r = prepare(env, NOW); log.push(...r.lines); return r.outputs; }
      case 'check': return check(env).outputs;
      case 'finish': { const r = finish(env, NOW + 1500); log.push(...r.notices, ...r.lines, r.summary); return r.outputs; }
      case 'fail': { const e = verdict(env); if (e) { log.push(`::error title=notify::${e}`); throw new Error(e); } return {}; }
    }
    throw new Error(`unknown mode ${mode}`);
  };

  for (const s of ACTION.runs.steps) {
    const cond = s.if === undefined ? 'success()' : s.if;
    if (!value(cond.replace(/^\$\{\{([\s\S]*)\}\}$/, '$1'))) { if (s.id) steps[s.id] = { outputs: {}, outcome: 'skipped' }; continue; }
    let outputs: Record<string, string> = {};
    let ok = true;
    try {
      const withs = expandAll(s.with);
      if (s.run) {
        const mode = /notify\.mjs" (\w+)/.exec(s.run)?.[1];
        if (!mode) throw new Error(`a step the harness doesn't know: ${s.run}`);
        outputs = runMode(mode, expandAll(s.env));
      } else if (String(s.uses).startsWith('actions/checkout@')) {
        checkouts.push(s.with ?? {});
        rmSync(workspace, { recursive: true, force: true });
        mkdirSync(workspace, { recursive: true });
        if (hook !== null) {
          mkdirSync(dirname(join(workspace, HOOK_PATH)), { recursive: true });
          writeFileSync(join(workspace, HOOK_PATH), hook);
        }
      } else if (String(s.uses).startsWith('actions/download-artifact@')) {
        const content = artifacts[withs.name!];
        if (content === undefined) throw new Error(`Unable to download artifact(s): Artifact not found for name: ${withs.name}`);
        mkdirSync(withs.path!, { recursive: true });
        writeFileSync(join(withs.path!, 'message.json'), content);
      } else if (s.uses === './.github/actions/notify') {
        runHook(withs);
      } else if (String(s.uses).startsWith('actions/upload-artifact@')) {
        uploads.push({ name: withs.name!, content: readFileSync(withs.path!, 'utf8') });
      } else {
        throw new Error(`a step the harness doesn't know: ${s.uses}`);
      }
    } catch (e) {
      ok = false;
      log.push(String((e as Error).message));
    }
    if (s.id) steps[s.id] = { outputs, outcome: ok ? 'success' : 'failure' };
    if (!ok && !s['continue-on-error']) failed = true;
  }
  const outputs = Object.fromEntries(Object.entries(ACTION.outputs).map(([k, o]) => [k, expand(o.value)]));
  const receivedFile = join(temp, 'notify-hook-received.json');
  const received = existsSync(receivedFile) ? JSON.parse(readFileSync(receivedFile, 'utf8')) : undefined;
  const doctor = log.filter((l) => l.startsWith(`${LINE} `)).map((l) => JSON.parse(l.slice(LINE.length + 1)));
  const rows = uploads.map((u) => JSON.parse(u.content));
  return { failed, outputs, log: log.join('\n'), hookCalls, prebuilt, uploads, rows, doctor, received, checkouts };
};

const posting = (over: Partial<Run> = {}) => runBlock({
  inputs: { kind: 'project-digest', artifact: producerArtifact(), secret: SECRET },
  artifacts: { [producerArtifact()]: JSON.stringify(message()) },
  ...over,
});

describe('the block posts a valid message through the hook at the path (§5.1, §6.1)', SPAWNS, () => {
  it('the fixture hook receives message-v1, text, kind and secret', () => {
    const r = posting();
    expect(r.failed).toBe(false);
    expect(r.hookCalls).toHaveLength(1);
    expect(Object.keys(r.hookCalls[0]!).sort()).toEqual(['kind', 'message-v1', 'secret', 'text']);
    expect(r.received.message).toEqual(message());
    expect(r.received.text).toBe(renderText(message()));
    expect(r.received.kind).toBe('project-digest');
    expect(r.received.secret_sha256).toBe(createHash('sha256').update(SECRET).digest('hex'));
    expect(r.outputs.outcome).toBe('posted');
  });

  it('the hook is called on a branch ref as on the default branch (decision 8)', () => {
    const main = posting({ ref: 'refs/heads/main' });
    const branch = posting({ ref: 'refs/heads/someone/changed-the-hook' });
    expect(branch.hookCalls).toEqual(main.hookCalls);
    expect(branch.outputs.outcome).toBe('posted');
    // The checkout names no ref, so it is the run's commit whatever branch it is on, and keeps no credential.
    expect(branch.checkouts).toEqual([{ 'persist-credentials': false }]);
  });

  it('masks the secret, and each of its lines, before anything prints', () => {
    const r = posting({ inputs: { kind: 'project-digest', artifact: producerArtifact(), secret: `${SECRET}\nsecond-line` } });
    expect(r.log.split('\n').slice(0, 2)).toEqual([`::add-mask::${SECRET}`, '::add-mask::second-line']);
    expect(masks(SECRET)).toEqual([SECRET]);
    expect(ACTION.runs.steps[0]!.run).toMatch(/notify\.mjs" mask$/);
  });
});

describe('an invalid message fails before any hook runs (§5.1, step 2)', SPAWNS, () => {
  it.each([
    ['breaks the contract', JSON.stringify(message({ title: 'x'.repeat(121) })), 'title (range)'],
    ['is not JSON', '{"kind": ', 'is not JSON'],
    ['is another kind than the job\'s', JSON.stringify(message({ kind: 'weekly-digest', source: { ...message().source, lane: 'weekly-digest' } })), "kind is not this job's kind"],
  ])('a message that %s calls no hook, fails the job by name, and is recorded', (_, content, says) => {
    const r = posting({ artifacts: { [producerArtifact()]: content } });
    expect(r.hookCalls).toEqual([]);
    expect(r.failed).toBe(true);
    expect(r.log).toContain(says);
    expect(r.outputs).toEqual({ outcome: 'failed' });
    expect(r.rows[0]).toMatchObject({ outcome: 'failed', failure: 'invalid-message' });
    expect(r.rows[0]).not.toHaveProperty('contract_version');
  });

  it('a message artifact that can\'t be downloaded calls no hook and is recorded as an unreadable message', () => {
    const r = posting({ artifacts: {} });
    expect(r.hookCalls).toEqual([]);
    expect(r.failed).toBe(true);
    expect(r.rows[0]).toMatchObject({ outcome: 'failed', failure: 'invalid-message' });
  });
});

describe('nothing to post is skipped, and calls no hook (§5.1, step 1; decision 21)', SPAWNS, () => {
  it.each([
    ['an empty secret', { kind: 'project-digest', artifact: producerArtifact(), secret: '' }, 'no-secret'],
    ['an empty artifact', { kind: 'project-digest', artifact: '', secret: SECRET }, 'no-message'],
    ['both empty, which records no-secret', { kind: 'project-digest', artifact: '', secret: '' }, 'no-secret'],
  ])('%s', (_, inputs, reason) => {
    const r = runBlock({ inputs, artifacts: { [producerArtifact()]: JSON.stringify(message()) } });
    expect(r.hookCalls).toEqual([]);
    expect(r.failed).toBe(false);
    expect(r.outputs).toEqual({ outcome: 'skipped' });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ outcome: 'skipped', skip_reason: reason, hook: 'custom' });
    expect(r.rows[0]).not.toHaveProperty('contract_version');
    expect(r.doctor).toEqual([{ hook: 'custom', kind: 'project-digest', outcome: 'skipped' }]);
  });

  it('says which secret is missing, in the summary', () => {
    const r = runBlock({ inputs: { kind: 'weekly-digest', artifact: '', secret: '' } });
    expect(r.log).toContain('No `KANON_CHAT_WEEKLY_DIGEST`: this kind was not posted.');
  });
});

describe("the hook's contract version (§6.2, item 1)", SPAWNS, () => {
  it('a hook declaring only message-v2 is refused by name, and is not called', () => {
    const v2 = FIXTURE_HOOK.replace('  message-v1:\n', '  message-v2:\n');
    const r = posting({ hook: v2 });
    expect(r.hookCalls).toEqual([]);
    expect(r.failed).toBe(true);
    expect(r.log).toContain(`the hook at ${HOOK_PATH} declares only message-v2, and this release writes message-v1`);
    expect(r.rows[0]).toMatchObject({ outcome: 'failed', failure: 'hook-step-failed' });
  });

  it('chooses the newest version the hook declares that the release writes', () => {
    expect(declaredVersions(FIXTURE_HOOK)).toEqual([1]);
    expect(declaredVersions('inputs:\n  message-v2: {}\n  message-v1: {}\n  secret: {}\n')).toEqual([1, 2]);
    expect(chooseVersion([1, 2], [1])).toBe(1);
    expect(chooseVersion([1, 2], [1, 2])).toBe(2);
    expect(chooseVersion([2], [1])).toBeUndefined();
    expect(chooseVersion([], [1])).toBeUndefined();
  });
});

describe("the hook's kind, for telemetry (§5.1, step 4)", SPAWNS, () => {
  it("Kanon's two hook files are slack and webhook, and the fixture is custom", () => {
    expect(hookKind(SLACK_HOOK)).toBe('slack');
    expect(hookKind(WEBHOOK_HOOK)).toBe('webhook');
    expect(hookKind(FIXTURE_HOOK)).toBe('custom');
    // Edited, a prebuilt hook is the adopter's own.
    expect(hookKind(SLACK_HOOK.replace('    - uses:', '    - run: echo first\n      shell: bash\n    - uses:'))).toBe('custom');
    expect(hookKind(SLACK_HOOK.replace('yedeya-labs/kanon/actions/notify/slack@', 'someone/fork/actions/notify/slack@'))).toBe('custom');
    expect(hookKind('not: [yaml')).toBe('custom');
  });

  it.each([['slack', SLACK_HOOK], ['webhook', WEBHOOK_HOOK]])("Kanon's %s hook, at the path, is handed the four inputs, which it passes to Kanon's action", (name, hook) => {
    const r = posting({ hook });
    expect(r.prebuilt).toHaveLength(1);
    expect(r.prebuilt[0]!.uses).toMatch(new RegExp(`^yedeya-labs/kanon/actions/notify/${name}@v\\d+\\.\\d+\\.\\d+$`));
    expect(r.prebuilt[0]!.with).toEqual(r.hookCalls[0]);
    expect(r.doctor).toEqual([{ hook: name, kind: 'project-digest', outcome: 'posted' }]);
    expect(r.rows[0]).toMatchObject({ hook: name, outcome: 'posted', contract_version: 1 });
  });
});

describe('a re-run of notify alone posts the producer\'s message (§4, §5.4)', SPAWNS, () => {
  it("with run_attempt 2 and the producer's output naming …-1, it downloads and posts that message, and the row says producer_attempt 1", () => {
    const r = posting({ attempt: '2', artifacts: { [producerArtifact(1)]: JSON.stringify(message()) } });
    expect(r.failed).toBe(false);
    expect(r.hookCalls).toHaveLength(1);
    expect(r.received.message).toEqual(message());
    expect(r.rows[0]).toMatchObject({ run_attempt: 2, producer_attempt: 1, outcome: 'posted' });
    expect(r.uploads.map((u) => u.name)).toEqual([`kanon-delivery-project-digest-${RUN_ID}-2`]);
  });

  it('reads the producer\'s attempt from the name it is handed, and refuses a name that isn\'t a message artifact\'s', () => {
    expect(ARTIFACT.exec('kanon-notify-project-digest-digest-123-4')?.slice(1)).toEqual(['123', '4']);
    const r = posting({ inputs: { kind: 'project-digest', artifact: 'something-else', secret: SECRET } });
    expect(r.hookCalls).toEqual([]);
    expect(r.failed).toBe(true);
    expect(r.rows[0]).toMatchObject({ outcome: 'failed', failure: 'invalid-message' });
  });
});

describe('the doctor line and the notify row, on every outcome (§5.1, steps 6 and 7; §11)', SPAWNS, () => {
  const cases = {
    posted: () => posting(),
    failed: () => posting({ hookFails: true }),
    skipped: () => posting({ inputs: { kind: 'project-digest', artifact: producerArtifact(), secret: '' } }),
  };
  it.each(Object.keys(cases) as (keyof typeof cases)[])('%s: one line, one valid row, and no URL, text or secret in either', (outcome) => {
    const r = cases[outcome]();
    expect(r.doctor).toEqual([{ hook: 'custom', kind: 'project-digest', outcome }]);
    expect(r.rows).toHaveLength(1);
    expect(validateRow(r.rows[0])).toEqual({ ok: true });
    expect(r.rows[0]).toMatchObject({ row_kind: 'notify', lane: 'project-digest', kind: 'project-digest', run_id: 77, run_attempt: 1, outcome, kanon_version: 'dev', duration_ms: 1500, tag: 'run' });
    expect(r.uploads.map((u) => u.name)).toEqual([`kanon-delivery-project-digest-${RUN_ID}-1`]);
    expect(r.outputs.outcome).toBe(outcome);
    expect(r.failed).toBe(outcome === 'failed');
    const said = [JSON.stringify(r.doctor), JSON.stringify(r.rows)].join('\n');
    for (const leak of [SECRET, 'receiver.example', message().title, message().summary, 'https://']) expect(said).not.toContain(leak);
  });

  it('a hook that fails fails the job, after the row is uploaded (K-SHIP-10)', () => {
    const r = posting({ hookFails: true });
    expect(r.rows[0]).toMatchObject({ outcome: 'failed', failure: 'hook-step-failed', contract_version: 1 });
    expect(r.log).toContain("nothing was posted: the hook's step failed");
  });

  it("a deploy message's row is the deploy-announce lane's, its artifact named for the environment's position (plan 0011 N9)", () => {
    const deploy = message({ kind: 'deploy', severity: 'critical', source: { ...message().source, lane: 'deploy' } });
    const name = `kanon-notify-deploy-announce-2-${RUN_ID}-1`;
    const r = runBlock({ inputs: { kind: 'deploy', artifact: name, secret: SECRET, position: '2' }, artifacts: { [name]: JSON.stringify(deploy) } });
    expect(r.outputs.outcome).toBe('posted');
    expect(r.rows).toHaveLength(1);
    expect(validateRow(r.rows[0])).toEqual({ ok: true });
    expect(r.rows[0]).toMatchObject({ row_kind: 'notify', lane: 'deploy-announce', kind: 'deploy', outcome: 'posted', producer_attempt: 1 });
    // Two environments' notify jobs in one run upload two names, which the collector reads back.
    expect(r.uploads.map((u) => u.name)).toEqual([`kanon-delivery-deploy-announce-${RUN_ID}-1-2`]);
    expect(DELIVERY_ARTIFACT.exec(r.uploads[0]!.name)?.slice(1)).toEqual(['deploy-announce', RUN_ID, '1', '2']);
    // With no secret mapped, it is recorded as skipped, under the same lane.
    const none = runBlock({ inputs: { kind: 'deploy', artifact: name, secret: '', position: '1' }, artifacts: { [name]: JSON.stringify(deploy) } });
    expect(none.rows[0]).toMatchObject({ lane: 'deploy-announce', outcome: 'skipped', skip_reason: 'no-secret' });
    expect(none.uploads.map((u) => u.name)).toEqual([`kanon-delivery-deploy-announce-${RUN_ID}-1-1`]);
  });
});

describe('the outcome is an output, so a later step acts on posted alone (kanon#972)', SPAWNS, () => {
  it('a skip leaves the job green with outcome skipped, so a green job never means posted', () => {
    const r = posting({ inputs: { kind: 'project-digest', artifact: producerArtifact(), secret: '' } });
    expect(r.failed).toBe(false);
    expect(r.outputs.outcome).toBe('skipped');
    expect(ACTION.outputs.outcome!.value).toBe('${{ steps.finish.outputs.outcome }}');
  });
});

describe('the parts', () => {
  it('masks nothing for an empty secret', () => {
    expect(masks('')).toEqual([]);
    expect(masks('  \n')).toEqual([]);
  });

  it('refuses a kind or a tag it doesn\'t know, by name', () => {
    expect(() => prepare({ KIND: 'health', DIR: join(work, 'd') })).toThrow("kind 'health' is not one of project-digest, weekly-digest, deploy");
    expect(() => prepare({ KIND: 'deploy', TAG: 'prod', DIR: join(work, 'd') })).toThrow("tag 'prod' is not one of run, smoke, test");
  });

  it('fails the job when the block did not finish', () => {
    expect(verdict({ OUTCOME: '', DIR: join(work, 'none') })).toBe('nothing was posted: the block did not finish');
    expect(verdict({ OUTCOME: 'posted' })).toBeUndefined();
    expect(verdict({ OUTCOME: 'skipped' })).toBeUndefined();
  });
});
