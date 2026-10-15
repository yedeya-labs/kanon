import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { KIND_SECRETS } from '../../scripts/lib/notify-contract.mjs';
import {
  type Job, type NotifyWorld, type Workflow, DEPLOY_NOTIFY_IF, NOTIFY_IF, NOTIFYING_LANES,
  gateJobOf, notifyJob, notifyJobProblems, notifyJobsOf, producersOf, startsNotify,
} from './helpers/notify-jobs.js';

/**
 * Plan 0011 step N6, `K-OBS-19`: a lane notifies only through Kanon's notification contract, and a
 * hook runs only in a `notify` job. In every Kanon workflow and script:
 *
 *   - every `notify` job is of `notify-jobs.ts`'s shape, in a notifying lane, with that lane's kind;
 *   - each `KANON_CHAT_*` secret appears only in the `notify` job of its kind's lane, in that lane's
 *     gate as one presence boolean, in that lane's declared `secrets:`, and in a caller's mapping
 *     of it into that lane;
 *   - each lane that declares a chat secret has a `notify` job and exactly one producing job;
 *   - `DIGEST_WEBHOOK` appears in no lane that has moved behind the `notify` job, nor in any caller
 *     of one (decision 17, the clean break). The two digests move in N7 and N8, which ship together:
 *     the project digest has moved (N7), and a lane still to move is named below with its step, and
 *     must still hold the old secret, so a lane that moves leaves the list;
 *   - no `notify` job is in a workflow a `pull_request` or `pull_request_target` event starts;
 *   - no script under `scripts/` calls `fetch` on a host other than GitHub's, or reads a chat
 *     secret, but the named exceptions, each with its reason, and each still a hit;
 *   - no producer script holds Slack's syntax: a `<…|…>` link, a `:shortcode:` emoji, `mrkdwn`.
 */

const WF = '.github/workflows';
const FILES = readdirSync(WF).filter((f) => /\.ya?ml$/.test(f)).sort();
const read = (f: string) => parse(readFileSync(join(WF, f), 'utf8')) as Workflow & { on?: { workflow_call?: { secrets?: Record<string, unknown> } } };
const DOCS: Record<string, ReturnType<typeof read>> = Object.fromEntries(FILES.map((f) => [f, read(f)]));

/** The lanes still posting from their own job, until the step that moves each (decision 17): none since N7 and N8. */
const PENDING_LANES: Record<string, string> = {};
/** The chat secret the digests used before the contract, which no moved lane may take. */
const LEGACY = 'DIGEST_WEBHOOK';
const KIND_OF_SECRET: Record<string, string> = Object.fromEntries(Object.entries(KIND_SECRETS).map(([k, s]) => [s, k]));

/** The lane file a job calls, Kanon's own `$/` or by release, or `undefined`. */
const calledLane = (job: Job): string | undefined =>
  /^(?:\$\/|yedeya-labs\/kanon\/)\.github\/workflows\/([\w.-]+\.ya?ml)(?:@.*)?$/.exec(String(job.uses ?? ''))?.[1];
/**
 * The lane file a job calls at the running commit (`$/`), or `undefined`. A caller that pins a
 * release calls that release's lane, which lane-check and doctor judge when its pin moves
 * (`caller.secret-stale`, `notify.legacy-secret`); Kanon's own `project-digest.yml` drops
 * `DIGEST_WEBHOOK` in the pull request that moves its pin to N7's release.
 */
const runningLane = (job: Job): string | undefined => /^\$\/\.github\/workflows\/([\w.-]+\.ya?ml)$/.exec(String(job.uses ?? ''))?.[1];

const eventsOf = (on: unknown): string[] =>
  typeof on === 'string' ? [on] : Array.isArray(on) ? on.map(String) : on && typeof on === 'object' ? Object.keys(on) : [];

const CHAT = /KANON_CHAT_[A-Z0-9_]+/g;

/**
 * Every place a `KANON_CHAT_*` name appears where the guard doesn't admit it, as `file:where: NAME`.
 */
export const chatSecretProblems = (docs: Record<string, ReturnType<typeof read>>): string[] => {
  const out: string[] = [];
  for (const [f, wf] of Object.entries(docs)) {
    const laneKind = NOTIFYING_LANES[f];
    const { jobs = {}, ...rest } = wf;
    const declared = Object.keys(wf.on?.workflow_call?.secrets ?? {});
    for (const name of declared.filter((n) => /^KANON_CHAT_/.test(n))) {
      if (KIND_OF_SECRET[name] === undefined || KIND_OF_SECRET[name] !== laneKind) out.push(`${f}:on.workflow_call.secrets: ${name}`);
    }
    const restText = JSON.stringify({ ...rest, on: { ...(typeof rest.on === 'object' ? rest.on : {}), workflow_call: { ...(wf.on?.workflow_call ?? {}), secrets: undefined } } });
    for (const m of restText.matchAll(CHAT)) out.push(`${f}:(workflow): ${m[0]}`);
    const gate = gateJobOf(wf);
    const notifies = new Set(notifyJobsOf(wf));
    for (const [id, job] of Object.entries(jobs)) {
      for (const name of new Set([...JSON.stringify(job).matchAll(CHAT)].map((m) => m[0]))) {
        const kind = KIND_OF_SECRET[name];
        const where = `${f}:${id}: ${name}`;
        if (kind === undefined) { out.push(`${where} (not a message kind's secret)`); continue; }
        if (kind === laneKind && notifies.has(id)) continue;
        if (kind === laneKind && id === gate) {
          // One presence boolean in a step's env, and nothing else in the job names it.
          const presence = new RegExp(`^\\$\\{\\{\\s*secrets\\.${name}\\s*!=\\s*''\\s*\\}\\}$`);
          const uses = (job.steps ?? []).flatMap((s) => Object.values(s.env ?? {}).filter((v) => String(v).includes(name)));
          const total = [...JSON.stringify(job).matchAll(new RegExp(name, 'g'))].length;
          if (uses.length === 1 && presence.test(String(uses[0])) && total === 1) continue;
        }
        const lane = calledLane(job);
        if (lane && NOTIFYING_LANES[lane] === kind) {
          const { secrets, ...other } = job;
          const keys = secrets && typeof secrets === 'object' ? Object.keys(secrets) : [];
          if (keys.includes(name) && !JSON.stringify(other).includes(name)) continue;
        }
        out.push(where);
      }
    }
  }
  return out;
};

/** Every way the workflows break the `notify` job's rules but the chat secrets' placement. */
export const notifyLaneProblems = (docs: Record<string, ReturnType<typeof read>>): string[] => {
  const out: string[] = [];
  for (const [f, wf] of Object.entries(docs)) {
    const notifies = notifyJobsOf(wf);
    const kind = NOTIFYING_LANES[f];
    if (notifies.length && !kind) out.push(`${f}: a notify job in a workflow that is not a notifying lane`);
    if (notifies.length || kind) {
      const prs = eventsOf(wf.on).filter((e) => e === 'pull_request' || e === 'pull_request_target');
      if (prs.length) out.push(`${f}: a notifying lane started by ${prs.join(', ')}`);
    }
    if (kind) for (const id of notifies) for (const p of notifyJobProblems(wf, id, kind)) out.push(`${f}:${id}: ${p}`);
    const declaresChat = Object.keys(wf.on?.workflow_call?.secrets ?? {}).some((n) => /^KANON_CHAT_/.test(n));
    if ((declaresChat || notifies.length) && (notifies.length !== 1 || producersOf(wf).length !== 1)) {
      out.push(`${f}: a lane that takes a chat secret has ${notifies.length} notify jobs and ${producersOf(wf).length} producing jobs, not one of each`);
    }
    // kanon#972: a skipped `notify` job is green, so nothing may act on its result; what acts only
    // on a post reads its `outcome` output.
    for (const id of notifies) {
      for (const [other, job] of Object.entries(wf.jobs ?? {})) {
        if (new RegExp(`needs\\.${id}\\.result\\b`).test(JSON.stringify(job))) out.push(`${f}:${other}: reads the ${id} job's result, which a skip leaves green; read its outcome output (kanon#972)`);
      }
    }
    // The clean break (decision 17): a moved lane neither declares nor reads DIGEST_WEBHOOK, and
    // no workflow maps it into one.
    if (kind && notifies.length && JSON.stringify(wf).includes(LEGACY)) out.push(`${f}: a moved lane still names ${LEGACY}`);
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      const lane = runningLane(job);
      if (lane && NOTIFYING_LANES[lane] && docs[lane] && notifyJobsOf(docs[lane]).length && JSON.stringify(job).includes(LEGACY)) {
        out.push(`${f}:${id}: maps ${LEGACY} into ${lane}, which no longer declares it`);
      }
    }
  }
  return out;
};

// ── Scripts ──────────────────────────────────────────────────────────────────────────────────

/**
 * A script's source, read the way the checks need it: the text with its comments blanked out, and
 * each string and template literal's text (a template's `${…}` kept as written).
 */
export const lex = (src: string): { code: string; literals: string[] } => {
  const literals: string[] = [];
  let code = '';
  let i = 0;
  const quoted = (start: number): number => {
    const q = src[start];
    let j = start + 1;
    while (j < src.length && src[j] !== q && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
    literals.push(src.slice(start + 1, j));
    return j + 1;
  };
  const skipComment = (j: number): number => (src[j + 1] === '/' ? (src.indexOf('\n', j) === -1 ? src.length : src.indexOf('\n', j)) : (src.indexOf('*/', j + 2) === -1 ? src.length : src.indexOf('*/', j + 2) + 2));
  const template = (start: number): number => {
    let j = start + 1;
    while (j < src.length && src[j] !== '`') {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '$' && src[j + 1] === '{') { j = expression(j + 2); continue; }
      j += 1;
    }
    literals.push(src.slice(start + 1, j));
    return j + 1;
  };
  const expression = (start: number): number => {
    let j = start;
    let depth = 0;
    while (j < src.length) {
      const c = src[j]!;
      if (c === "'" || c === '"') { j = quoted(j); continue; }
      if (c === '`') { j = template(j); continue; }
      if (c === '/' && (src[j + 1] === '/' || src[j + 1] === '*')) { j = skipComment(j); continue; }
      if (c === '{') depth += 1;
      if (c === '}') { if (depth === 0) return j + 1; depth -= 1; }
      j += 1;
    }
    return j;
  };
  /** Whether a `/` here opens a regular expression, from the code before it. */
  const regexHere = () => /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof|\bcase)\s*$/.test(code.slice(-40));
  while (i < src.length) {
    const c = src[i]!;
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      const end = skipComment(i);
      code += src.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    if (c === "'" || c === '"') { const end = quoted(i); code += src.slice(i, end); i = end; continue; }
    if (c === '`') { const end = template(i); code += src.slice(i, end); i = end; continue; }
    if (c === '/' && regexHere()) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== '\n' && (inClass || src[j] !== '/')) {
        if (src[j] === '\\') j += 1;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        j += 1;
      }
      j += 1;
      while (/[a-z]/.test(src[j] ?? '')) j += 1;
      code += src.slice(i, j);
      i = j;
      continue;
    }
    code += c;
    i += 1;
  }
  return { code, literals };
};

/** GitHub's hosts: the API, the site, uploads and raw content. */
const GITHUB = /^https:\/\/(?:api\.github\.com|github\.com|uploads\.github\.com|raw\.githubusercontent\.com)(?:[/?#]|\$\{|$)/;

/** The first argument of the call whose `(` is at `open`. */
const firstArgument = (code: string, open: number): { arg: string; end: number } => {
  let depth = 0;
  let j = open;
  let arg = '';
  for (; j < code.length; j += 1) {
    const c = code[j]!;
    if ('([{'.includes(c)) { depth += 1; if (depth === 1) continue; }
    if (')]}'.includes(c)) { depth -= 1; if (depth === 0) break; }
    if (c === ',' && depth === 1) { j = code.indexOf(')', j); break; }
    if (depth >= 1) arg += c;
  }
  return { arg: arg.trim(), end: j };
};

/**
 * Every `fetch(…)` call in a script whose URL is not a GitHub host, by its first argument as
 * written. A URL counts as GitHub's when it is a literal of a GitHub host, or a constant this file
 * declares as one (`const API = 'https://api.github.com'`), or opens with one in a template.
 */
export const nonGithubFetches = (src: string): string[] => {
  const { code } = lex(src);
  const constants = new Map([...code.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`]*)\2/g)].map((m) => [m[1]!, m[3]!]));
  const out: string[] = [];
  for (const m of code.matchAll(/(?<![\w$])((?:[\w$]+\.)?)fetch\s*\(/g)) {
    if (m[1] === 'git.') continue;
    const { arg, end } = firstArgument(code, m.index + m[0].length - 1);
    // A method called `fetch` declared on an object (`fetch(sha) {`) is not a call.
    if (/^\s*\{/.test(code.slice(end + 1))) continue;
    const literal = /^(['"`])([^'"`]*)/.exec(arg)?.[2];
    const head = /^`?\$\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(arg)?.[1] ?? /^([A-Za-z_$][\w$]*)$/.exec(arg)?.[1];
    const url = literal !== undefined && !literal.startsWith('${') ? literal : head !== undefined ? constants.get(head) : undefined;
    if (url !== undefined && GITHUB.test(url)) continue;
    out.push(arg);
  }
  return out;
};

/** Every chat secret a script reads from its environment. */
export const chatSecretReads = (src: string): string[] =>
  [...lex(src).code.matchAll(/\benv\s*(?:\.\s*|\[\s*['"`])(KANON_CHAT_[A-Z0-9_]+|DIGEST_WEBHOOK|SLACK_RELEASE_WEBHOOK)\b/g)].map((m) => m[1]!);

/**
 * Slack's syntax in a producer's string and template literals, comments removed: a `<…|…>` link,
 * a `:shortcode:` emoji bounded by a non-word character or the literal's edge (so an `a:b:c` key, a
 * `16:30:` time or a `https://` URL is never one), or the word `mrkdwn`.
 */
export const slackSyntax = (src: string): string[] => lex(src).literals.flatMap((lit) => [
  ...[...lit.matchAll(/<[^<>\s|]+\|[^<>\n]*>/g)].map((m) => `link ${m[0]}`),
  ...[...lit.matchAll(/(?<![\w:])(:[a-z0-9_+-]+:)(?![\w:])/g)].map((m) => `emoji ${m[1]}`),
  ...(/\bmrkdwn\b/.test(lit) ? ['mrkdwn'] : []),
]);

const SCRIPTS = readdirSync('scripts', { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.mjs')).map((f) => join('scripts', f)).sort();
const SOURCES = Object.fromEntries(SCRIPTS.map((f) => [f, readFileSync(f, 'utf8')]));

/**
 * The scripts that may fetch a host that isn't GitHub's, each by its call's first argument, with
 * why. None posts to a chat system: each is a service of Kanon's own, or a step of plan 0011 that
 * moves it. Each must still be a hit, so one that stops calling leaves the list.
 */
const FETCH_EXCEPTIONS: Record<string, string> = {
  'scripts/telemetry/jev.mjs: ENDPOINT': "Jev, the upstream-finding judge (plan 0006 §7): Kanon's own private job, never a lane, posts no message",
};
/** The scripts that read a chat secret until the step that moves their lane: none since N7 and N8. */
const SECRET_EXCEPTIONS: Record<string, string> = {};
/** The producers of each kind's message (§3.2), and the step that moves each still to move. */
const PRODUCERS: Record<string, string | null> = {
  'scripts/project-digest.mjs': null,
  'scripts/weekly-digest.mjs': null,
  'scripts/announce-deploy.mjs': null,
};

describe('K-OBS-19: every notify job is of its shape, in a notifying lane (plan 0011 §5)', () => {
  it('reads every workflow, and knows the notifying lanes', () => {
    expect(FILES.length).toBeGreaterThan(30);
    for (const f of Object.keys(NOTIFYING_LANES)) expect(FILES).toContain(f);
  });

  it('holds for every Kanon workflow', () => {
    expect(notifyLaneProblems(DOCS)).toEqual([]);
  });

  it('each lane not yet moved is named with its step, and still holds DIGEST_WEBHOOK', () => {
    for (const [f, step] of Object.entries(PENDING_LANES)) {
      expect(notifyJobsOf(DOCS[f]!), `${f} has moved: remove it from PENDING_LANES (${step})`).toEqual([]);
      expect(JSON.stringify(DOCS[f]), f).toContain(LEGACY);
    }
    for (const f of Object.keys(NOTIFYING_LANES).filter((x) => !(x in PENDING_LANES))) {
      expect(notifyJobsOf(DOCS[f]!), `${f} is a notifying lane without a notify job`).toEqual(['notify']);
    }
  });
});

describe('K-OBS-19: a chat secret appears only where the guard admits it', () => {
  it('holds for every Kanon workflow', () => {
    expect(chatSecretProblems(DOCS)).toEqual([]);
  });
});

describe('the guard on a moved lane (the project digest, as N7 left it)', () => {
  /** The project digest: its gate reads the hook and the secret's presence, its digest publishes a message, and it has a notify job. */
  const moved = () => structuredClone(DOCS['agent-project-digest.yml']!);
  /** Kanon's smoke: its project-digest job maps the kind's secret, and no DIGEST_WEBHOOK. */
  const smoke = () => structuredClone(DOCS['agent-lanes-smoke.yml']!);
  const with_ = (wf: ReturnType<typeof moved>) => ({ ...DOCS, 'agent-project-digest.yml': wf, 'agent-lanes-smoke.yml': smoke() });

  it('passes as N7 left it, a lane of notify-jobs.ts\'s shape', () => {
    expect(notifyJobsOf(moved())).toEqual(['notify']);
    expect(notifyJobProblems(moved(), 'notify', 'project-digest')).toEqual([]);
    expect(notifyLaneProblems(with_(moved()))).toEqual([]);
    expect(chatSecretProblems(with_(moved()))).toEqual([]);
    // The notify job the helper builds is the lane's own.
    expect(moved().jobs!.notify).toEqual(notifyJob('project-digest', 'digest'));
  });

  it("fails a step in the digest job that curls the chat secret with raw text (the issue's mutation)", () => {
    const wf = moved();
    wf.jobs!.digest!.steps!.push({ name: 'Post', env: { URL: '${{ secrets.KANON_CHAT_PROJECT_DIGEST }}' }, run: 'curl -fsS -d "{\\"text\\": \\"$TEXT\\"}" "$URL"' });
    expect(chatSecretProblems(with_(wf))).toEqual(['agent-project-digest.yml:digest: KANON_CHAT_PROJECT_DIGEST']);
  });

  it('fails the gate reading the secret as anything but one presence boolean', () => {
    const wf = moved();
    wf.jobs!.gate!.steps!.at(-1)!.env = { URL: '${{ secrets.KANON_CHAT_PROJECT_DIGEST }}' };
    expect(chatSecretProblems(with_(wf))).toEqual(['agent-project-digest.yml:gate: KANON_CHAT_PROJECT_DIGEST']);
  });

  it("fails the weekly digest's secret mapped into the project digest's notify job, or declared by it", () => {
    const wf = moved();
    wf.jobs!.notify!.steps![0]!.with!.secret = '${{ secrets.KANON_CHAT_WEEKLY_DIGEST }}';
    expect(notifyLaneProblems(with_(wf))).toEqual(expect.arrayContaining(['agent-project-digest.yml:notify: its secret is not KANON_CHAT_PROJECT_DIGEST']));
    expect(chatSecretProblems(with_(wf))).toEqual(['agent-project-digest.yml:notify: KANON_CHAT_WEEKLY_DIGEST']);
    const declared = moved();
    declared.on!.workflow_call!.secrets!.KANON_CHAT_WEEKLY_DIGEST = { required: false };
    expect(chatSecretProblems(with_(declared))).toEqual(['agent-project-digest.yml:on.workflow_call.secrets: KANON_CHAT_WEEKLY_DIGEST']);
  });

  it('fails issues: write on the notify job, or CLAUDE_CODE_OAUTH_TOKEN mapped into it', () => {
    const write = moved();
    write.jobs!.notify!.permissions = { contents: 'read', issues: 'write' };
    expect(notifyLaneProblems(with_(write))).toEqual(['agent-project-digest.yml:notify: its permissions are {"contents":"read","issues":"write"}, not contents: read alone']);
    const claude = moved();
    claude.jobs!.notify!.env = { CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}' };
    expect(notifyLaneProblems(with_(claude))).toEqual([
      'agent-project-digest.yml:notify: the job declares `env:`',
      'agent-project-digest.yml:notify: it reads the secrets KANON_CHAT_PROJECT_DIGEST, CLAUDE_CODE_OAUTH_TOKEN, not KANON_CHAT_PROJECT_DIGEST alone',
    ]);
  });

  it('fails a pull_request trigger on a notifying lane', () => {
    const wf = moved() as ReturnType<typeof moved> & { on: Record<string, unknown> };
    wf.on.pull_request = null;
    expect(notifyLaneProblems(with_(wf))).toEqual(['agent-project-digest.yml: a notifying lane started by pull_request']);
    const target = moved() as ReturnType<typeof moved> & { on: Record<string, unknown> };
    target.on.pull_request_target = { types: ['opened'] };
    expect(notifyLaneProblems(with_(target))).toEqual(['agent-project-digest.yml: a notifying lane started by pull_request_target']);
  });

  it('fails DIGEST_WEBHOOK kept in a moved lane, or mapped into it by a caller (decision 17)', () => {
    const wf = moved();
    wf.on!.workflow_call!.secrets![LEGACY] = { required: false };
    expect(notifyLaneProblems(with_(wf))).toEqual([`agent-project-digest.yml: a moved lane still names ${LEGACY}`]);
    // Kanon's smoke mapped it into the lane until N7 changed it in the same commit; mapped back, it is caught.
    const legacy = smoke();
    (legacy.jobs!['project-digest']!.secrets as Record<string, string>)[LEGACY] = '${{ secrets.KANON_SMOKE_UNSET }}';
    expect(notifyLaneProblems({ ...with_(moved()), 'agent-lanes-smoke.yml': legacy }))
      .toEqual([`agent-lanes-smoke.yml:project-digest: maps ${LEGACY} into agent-project-digest.yml, which no longer declares it`]);
    const caller = { ...with_(moved()), 'x-caller.yml': { on: 'workflow_dispatch', jobs: { digest: { uses: '$/.github/workflows/agent-project-digest.yml', secrets: { [LEGACY]: '${{ secrets.X }}' } } } } as ReturnType<typeof read> };
    expect(notifyLaneProblems(caller)).toEqual([`x-caller.yml:digest: maps ${LEGACY} into agent-project-digest.yml, which no longer declares it`]);
  });

  it('fails a lane that declares a chat secret with no notify job, or two producers', () => {
    const none = moved();
    delete none.jobs!.notify;
    expect(notifyLaneProblems(with_(none))).toEqual(['agent-project-digest.yml: a lane that takes a chat secret has 0 notify jobs and 1 producing jobs, not one of each']);
    const two = moved();
    two.jobs!.health!.outputs = { 'message-artifact': '${{ steps.x.outputs.name }}' };
    expect(notifyLaneProblems(with_(two))).toEqual(expect.arrayContaining(['agent-project-digest.yml: a lane that takes a chat secret has 1 notify jobs and 2 producing jobs, not one of each']));
  });

  it('fails a notify job outside a notifying lane', () => {
    const other = structuredClone(DOCS['agent-overseer.yml']!);
    other.jobs!.notify = notifyJob('project-digest', 'gate');
    expect(notifyLaneProblems({ ...DOCS, 'agent-overseer.yml': other })).toEqual(expect.arrayContaining(['agent-overseer.yml: a notify job in a workflow that is not a notifying lane']));
  });

  it('admits a caller mapping the kind\'s secret into its own lane, and nothing else', () => {
    const ok = { ...with_(moved()), 'x-caller.yml': { on: 'workflow_dispatch', jobs: { digest: { uses: 'yedeya-labs/kanon/.github/workflows/agent-project-digest.yml@v1.0.0', secrets: { KANON_CHAT_PROJECT_DIGEST: '${{ secrets.KANON_CHAT_PROJECT_DIGEST }}' } } } } as ReturnType<typeof read> };
    expect(chatSecretProblems(ok)).toEqual([]);
    const wrong = { ...with_(moved()), 'x-caller.yml': { on: 'workflow_dispatch', jobs: { digest: { uses: '$/.github/workflows/agent-weekly-digest.yml', secrets: { KANON_CHAT_PROJECT_DIGEST: '${{ secrets.KANON_CHAT_PROJECT_DIGEST }}' } } } } as ReturnType<typeof read> };
    expect(chatSecretProblems(wrong)).toEqual(['x-caller.yml:digest: KANON_CHAT_PROJECT_DIGEST']);
  });
});

describe('the weekly digest, moved (plan 0011 N8)', () => {
  const WEEKLY = 'agent-weekly-digest.yml';
  const lane = () => structuredClone(DOCS[WEEKLY]!);
  const with_ = (wf: ReturnType<typeof lane>, smoke = DOCS['agent-lanes-smoke.yml']!) => ({ ...DOCS, [WEEKLY]: wf, 'agent-lanes-smoke.yml': smoke });

  it('has one notify job of its shape, with its own kind and secret, and declares no DIGEST_WEBHOOK', () => {
    expect(notifyJobsOf(DOCS[WEEKLY]!)).toEqual(['notify']);
    expect(producersOf(DOCS[WEEKLY]!)).toEqual(['digest']);
    expect(notifyJobProblems(DOCS[WEEKLY]!, 'notify', 'weekly-digest')).toEqual([]);
    expect(Object.keys(DOCS[WEEKLY]!.on!.workflow_call!.secrets!)).toContain('KANON_CHAT_WEEKLY_DIGEST');
    expect(JSON.stringify(DOCS[WEEKLY])).not.toContain(LEGACY);
    expect(JSON.stringify(DOCS[WEEKLY])).not.toContain('KANON_CHAT_PROJECT_DIGEST');
  });

  it("fails a step in the digest job that curls the chat secret with raw text (the issue's mutation)", () => {
    const wf = lane();
    wf.jobs!.digest!.steps!.push({ name: 'Post', env: { URL: '${{ secrets.KANON_CHAT_WEEKLY_DIGEST }}' }, run: 'curl -fsS -d "{\\"text\\": \\"$TEXT\\"}" "$URL"' });
    expect(chatSecretProblems(with_(wf))).toEqual([`${WEEKLY}:digest: KANON_CHAT_WEEKLY_DIGEST`]);
  });

  it("fails the project digest's secret in the weekly digest's notify job, or a second read of its own in the gate", () => {
    const wf = lane();
    wf.jobs!.notify!.steps![0]!.with!.secret = '${{ secrets.KANON_CHAT_PROJECT_DIGEST }}';
    expect(notifyLaneProblems(with_(wf))).toEqual(expect.arrayContaining([`${WEEKLY}:notify: its secret is not KANON_CHAT_WEEKLY_DIGEST`]));
    expect(chatSecretProblems(with_(wf))).toEqual([`${WEEKLY}:notify: KANON_CHAT_PROJECT_DIGEST`]);
    const gate = lane();
    gate.jobs!.gate!.steps!.at(-1)!.env = { ...gate.jobs!.gate!.steps!.at(-1)!.env, URL: '${{ secrets.KANON_CHAT_WEEKLY_DIGEST }}' };
    expect(chatSecretProblems(with_(gate))).toEqual([`${WEEKLY}:gate: KANON_CHAT_WEEKLY_DIGEST`]);
  });

  it('fails DIGEST_WEBHOOK declared back in the lane, or left in agent-lanes-smoke.yml (decision 17)', () => {
    const wf = lane();
    wf.on!.workflow_call!.secrets![LEGACY] = { required: false };
    expect(notifyLaneProblems(with_(wf))).toEqual([`${WEEKLY}: a moved lane still names ${LEGACY}`]);
    const smoke = structuredClone(DOCS['agent-lanes-smoke.yml']!);
    (smoke.jobs!['weekly-digest']!.secrets as Record<string, string>)[LEGACY] = '${{ secrets.KANON_SMOKE_UNSET }}';
    expect(notifyLaneProblems(with_(lane(), smoke))).toEqual([`agent-lanes-smoke.yml:weekly-digest: maps ${LEGACY} into ${WEEKLY}, which no longer declares it`]);
  });
});

describe('the deploy lane, wired (plan 0011 N9; the Owner\'s decisions of 2026-10-15)', () => {
  const DEPLOY = 'deploy.yml';
  const lane = () => structuredClone(DOCS[DEPLOY]!);
  const with_ = (wf: ReturnType<typeof lane>) => ({ ...DOCS, [DEPLOY]: wf });

  it('has one notify job of its shape, gated by declare, with no exception to the guard', () => {
    expect(notifyJobsOf(DOCS[DEPLOY]!)).toEqual(['notify']);
    expect(producersOf(DOCS[DEPLOY]!)).toEqual(['announce']);
    expect(notifyJobProblems(DOCS[DEPLOY]!, 'notify', 'deploy')).toEqual([]);
    expect(DOCS[DEPLOY]!.jobs!.notify).toEqual(notifyJob('deploy', 'announce'));
    expect(Object.keys(DOCS[DEPLOY]!.on!.workflow_call!.secrets!)).toEqual(['KANON_CHAT_DEPLOY']);
    expect(notifyLaneProblems(with_(lane()))).toEqual([]);
    expect(chatSecretProblems(with_(lane()))).toEqual([]);
  });

  it('fails the chat secret read by the announcing job, or a digest\'s secret in its notify job', () => {
    const wf = lane();
    wf.jobs!.announce!.steps!.find((s) => s.id === 'message')!.env!.URL = '${{ secrets.KANON_CHAT_DEPLOY }}';
    expect(chatSecretProblems(with_(wf))).toEqual([`${DEPLOY}:announce: KANON_CHAT_DEPLOY`]);
    const other = lane();
    other.jobs!.notify!.steps![0]!.with!.secret = '${{ secrets.KANON_CHAT_WEEKLY_DIGEST }}';
    expect(notifyLaneProblems(with_(other))).toEqual(expect.arrayContaining([`${DEPLOY}:notify: its secret is not KANON_CHAT_DEPLOY`]));
  });

  it('fails an if: without the admitting declare, the digests\' if:, or no position', () => {
    const noDeclare = lane();
    noDeclare.jobs!.notify!.if = "${{ !cancelled() && needs.announce.outputs.hook == 'present' }}";
    expect(notifyLaneProblems(with_(noDeclare))).toEqual([`${DEPLOY}:notify: its if: is not \`${DEPLOY_NOTIFY_IF}\``]);
    const digest = lane();
    digest.jobs!.notify!.if = `\${{ ${NOTIFY_IF} }}`;
    expect(notifyLaneProblems(with_(digest))).toEqual([`${DEPLOY}:notify: its if: is not \`${DEPLOY_NOTIFY_IF}\``]);
    const noPosition = lane();
    delete noPosition.jobs!.notify!.steps![0]!.with!.position;
    expect(notifyLaneProblems(with_(noPosition))).toEqual([`${DEPLOY}:notify: its position is not \`\${{ inputs.position }}\``]);
    // A digest's notify job may not hand the block a position.
    const weekly = structuredClone(DOCS['agent-weekly-digest.yml']!);
    weekly.jobs!.notify!.steps![0]!.with!.position = '${{ inputs.position }}';
    expect(notifyLaneProblems({ ...DOCS, 'agent-weekly-digest.yml': weekly })).toEqual(['agent-weekly-digest.yml:notify: its step hands the block `position`']);
  });

  it('fails a pull_request trigger on the deploy lane', () => {
    const wf = lane() as ReturnType<typeof lane> & { on: Record<string, unknown> };
    wf.on.pull_request = null;
    expect(notifyLaneProblems(with_(wf))).toEqual([`${DEPLOY}: a notifying lane started by pull_request`]);
  });

  it("fails a job that acts on the notify job's result rather than its outcome (kanon#972)", () => {
    const wf = lane();
    wf.jobs!.after = { needs: ['notify'], if: "${{ needs.notify.result == 'success' }}", 'runs-on': 'ubuntu-latest', steps: [{ run: 'true' }] };
    expect(notifyLaneProblems(with_(wf))).toEqual([`${DEPLOY}:after: reads the notify job's result, which a skip leaves green; read its outcome output (kanon#972)`]);
    const outcome = lane();
    outcome.jobs!.after = { needs: ['notify'], if: "${{ needs.notify.outputs.outcome == 'posted' }}", 'runs-on': 'ubuntu-latest', steps: [{ run: 'true' }] };
    expect(notifyLaneProblems(with_(outcome))).toEqual([]);
  });

  describe('its if:, evaluated', () => {
    const job = notifyJob('deploy', 'announce');
    const needs = ['declare', 'announce'];
    const world = (held: string, hook: string, over: Partial<NotifyWorld> = {}): NotifyWorld => ({
      member: '', hook: '', dryRun: '', cancelled: false, gate: 'success', producer: 'success', outputs: { 'declare.held': held, 'announce.hook': hook }, ...over,
    });
    const starts = (cond: string | undefined, w: NotifyWorld) => startsNotify(cond, needs, w, 'declare');

    it('starts past an admitting declare with a hook, and after a failed announce, to record what happened', () => {
      expect(starts(job.if, world('false', 'present'))).toBe(true);
      expect(starts(job.if, world('false', 'present', { producer: 'failure' }))).toBe(true);
    });

    it('does not start for a held environment, a declare that refused (any event but a release or a dispatch), no hook, a skipped announce, or a cancel', () => {
      expect(starts(job.if, world('true', 'present'))).toBe(false);
      expect(starts(job.if, world('', 'present', { gate: 'failure' }))).toBe(false);
      expect(starts(job.if, world('false', 'none'))).toBe(false);
      expect(starts(job.if, world('false', '', { producer: 'skipped' }))).toBe(false);
      expect(starts(job.if, world('false', 'present', { cancelled: true }))).toBe(false);
    });

    it('the mutations: without the declare condition it would start after a refusal, and with always() in a cancelled run', () => {
      expect(starts("!cancelled() && needs.announce.outputs.hook == 'present'", world('', 'present', { gate: 'failure' }))).toBe(true);
      expect(starts(DEPLOY_NOTIFY_IF.replace('!cancelled()', 'always()'), world('false', 'present', { cancelled: true }))).toBe(true);
    });
  });
});

describe("the notify job's if: (plan 0011 §5.1)", () => {
  const job = notifyJob('project-digest', 'digest');
  const needs = ['gate', 'digest'];
  const world = (over: Partial<NotifyWorld> = {}): NotifyWorld => ({ member: 'true', hook: 'present', dryRun: '', cancelled: false, gate: 'success', producer: 'success', ...over });
  const starts = (cond: string | undefined, over: Partial<NotifyWorld> = {}) => startsNotify(cond, needs, world(over));

  it('starts past an admitting gate with a hook, and after a failed or skipped producer, to record skipped', () => {
    expect(starts(job.if)).toBe(true);
    expect(starts(job.if, { producer: 'failure' })).toBe(true);
    expect(starts(job.if, { producer: 'skipped' })).toBe(true);
  });

  it('does not start with the gate refusing, with no hook, on a dry run, or on a cancelled run', () => {
    expect(starts(job.if, { member: 'false' })).toBe(false);
    expect(starts(job.if, { member: '', gate: 'skipped', hook: '' })).toBe(false);
    expect(starts(job.if, { member: '', gate: 'failure', hook: '' })).toBe(false);
    expect(starts(job.if, { hook: 'none' })).toBe(false);
    expect(starts(job.if, { hook: '' })).toBe(false);
    expect(starts(job.if, { dryRun: 'true' })).toBe(false);
    // Cancelled after the producer published its artifact.
    expect(starts(job.if, { cancelled: true })).toBe(false);
  });

  it("fails an if: reading hook != 'none', one without the dry-run condition, and a job-level always()", () => {
    const hookNotNone = NOTIFY_IF.replace("needs.gate.outputs.hook == 'present'", "needs.gate.outputs.hook != 'none'");
    expect(starts(hookNotNone, { hook: '' })).toBe(true);
    const noDryRun = NOTIFY_IF.replace(" && inputs.dry_run != 'true'", '');
    expect(starts(noDryRun, { dryRun: 'true' })).toBe(true);
    const always = NOTIFY_IF.replace('!cancelled()', 'always()');
    expect(starts(always, { cancelled: true })).toBe(true);
    // …each of which the shape refuses, so no lane can carry one.
    for (const cond of [hookNotNone, noDryRun, always]) {
      const wf: Workflow = { jobs: { gate: { steps: [{ id: 'gate' }] }, digest: { outputs: { 'message-artifact': 'x' } }, notify: { ...job, if: `\${{ ${cond} }}` } } };
      expect(notifyJobProblems(wf, 'notify', 'project-digest')).toEqual([`its if: is not \`${NOTIFY_IF}\``]);
    }
  });
});

describe('K-OBS-19: no script fetches a host other than GitHub\'s, or reads a chat secret', () => {
  const fetches = Object.entries(SOURCES).flatMap(([f, src]) => nonGithubFetches(src).map((a) => `${f}: ${a}`));
  const reads = Object.entries(SOURCES).flatMap(([f, src]) => chatSecretReads(src).map((a) => `${f}: ${a}`));

  it('reads the scripts, and sees their GitHub calls as GitHub\'s', () => {
    expect(SCRIPTS.length).toBeGreaterThan(50);
    expect(nonGithubFetches("const API = 'https://api.github.com';\nawait io.fetch(`${API}/repos/${r}`, {});")).toEqual([]);
    expect(nonGithubFetches('await fetch(`https://api.github.com${path}`, { headers });')).toEqual([]);
    expect(nonGithubFetches('// fetch(webhook)\nconst o = { fetch(sha) { return git.fetch(sha); } };')).toEqual([]);
  });

  it('holds for every script but the named exceptions, and each exception is still a hit', () => {
    expect([...new Set(fetches)].sort()).toEqual(Object.keys(FETCH_EXCEPTIONS).sort());
    expect([...new Set(reads)].sort()).toEqual(Object.keys(SECRET_EXCEPTIONS).sort());
  });

  it('fails a fetch(webhook…) added back to a producer, and a chat secret read', () => {
    const src = SOURCES['scripts/announce-deploy.mjs']!;
    expect(nonGithubFetches(`${src}\nawait fetch(webhook, { method: 'POST', body });\n`)).toEqual(['webhook']);
    expect(nonGithubFetches(`${src}\nawait fetch('https://hooks.slack.com/services/x', {});\n`)).toEqual(["'https://hooks.slack.com/services/x'"]);
    expect(chatSecretReads(`${src}\nconst url = process.env.KANON_CHAT_DEPLOY;\n`)).toEqual(['KANON_CHAT_DEPLOY']);
  });
});

describe('K-OBS-19: no producer holds Slack\'s syntax', () => {
  it('holds for every producer moved behind the contract, and each one still to move still holds it', () => {
    for (const [f, step] of Object.entries(PRODUCERS)) {
      const hits = slackSyntax(SOURCES[f]!);
      if (step === null) expect(hits, f).toEqual([]);
      else expect(hits.length, `${f} holds no Slack syntax: mark it moved (${step})`).toBeGreaterThan(0);
    }
  });

  it('fails a :rotating_light: in a string and a <url|#n> link, and not an a:b:c key, a time or a URL', () => {
    const src = SOURCES['scripts/announce-deploy.mjs']!;
    expect(slackSyntax(`${src}\nconst stop = ':rotating_light: stopped';\n`)).toEqual(['emoji :rotating_light:']);
    expect(slackSyntax(`${src}\nconst link = \`<\${url}|#\${n}>\`;\n`)).toEqual(['link <${url}|#${n}>']);
    expect(slackSyntax(`${src}\nconst k = 'a:b:c'; const t = '16:30:'; const u = 'https://x.example/a:b';\n// ':warning:' in a comment\n`)).toEqual([]);
    expect(slackSyntax("const b = { type: 'section', text: { type: 'mrkdwn' } };")).toEqual(['mrkdwn']);
  });
});
