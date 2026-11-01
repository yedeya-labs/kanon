import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CONFLICTS, laneCatalogue, parseArgs, realDeps, SCHEMA, usage, USAGE } from '../../cli/init.mjs';
import { pluginSettingsFile, readPluginDeclaration } from '../../cli/plugin.mjs';
import { consentQuestion } from '../../cli/init.mjs';
import { SPAWNS } from './helpers/spawns.js';
import { ROOT, REQ, REPO, PINNED, dirs, checkout, fakeGitHub, writes, run, CONFIRM, changing, read, tableColumn, fields, type Doc, parse, keys } from './helpers/kanon-init.js';

// Its cases run `kanon init` against a real git checkout, and several run lane-check, so every
// case takes the spawn budget (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

// `kanon init --json` against docs/init.md, the release it pins, its flags, the plugin, the lane
// catalogue and a merge queue. Split out of kanon-init.test.ts (#1204); the fixtures are in
// tests/unit/helpers/kanon-init.ts.

describe('kanon init --json, the contract (docs/init.md)', () => {
  const STATUSES = ['complete', 'steps-left', 'failed', 'error'];
  // The document's own fields are the rows of its table that come before the status table.
  const DOC_FIELDS = fields('### The document').filter((f) => !STATUSES.includes(f));

  it('prints one document on standard output, the prose on standard error, with every field docs/init.md lists and no other', async () => {
    const dir = checkout();
    const r = await run(dir, fakeGitHub(), ['--yes', '--json']);
    expect(r.status, r.err).toBe(0);
    const d = parse(r);
    expect(r.err).toContain('== Summary ==');
    expect(r.out).not.toContain('== Summary ==');
    expect(keys(d)).toEqual([...DOC_FIELDS].sort());
    expect(d.schema).toBe(SCHEMA);
    expect(SCHEMA).toBe('kanon-init/v1');
    expect(d.kanon).toBe(`v${JSON.parse(read(ROOT, 'package.json')).version}`);
    expect(d.status).toBe('steps-left');
    expect(d.exitCode).toBe(0);
    expect(d.repository).toBe(REPO);
    expect(d.token).toEqual({ source: 'gh', login: 'octo' });
    expect(keys(d.inspection)).toEqual(fields('### The inspection').sort());
    expect(keys(d.answers)).toEqual(fields('### The answers').sort());
    expect(keys(d.apps)).toEqual(fields('### The Apps').sort());
    expect(d.files.length).toBeGreaterThan(0);
    for (const f of d.files) expect(keys(f)).toEqual(fields('### A file').sort());
    for (const c of d.changes) expect(keys(c)).toEqual(fields('### A change').sort());
    expect(d.features.map((f) => f.feature)).toEqual(['review', 'build', 'full']);
    for (const f of d.features) expect(keys(f)).toEqual(fields('### A feature').sort());
    expect(d.summary.length).toBeGreaterThan(15);
    for (const l of d.summary) expect(keys(l)).toEqual(fields('### A summary line').sort());
    for (const f of d.findings) {
      expect(keys(f)).toEqual(['blocking', 'category', 'fix', 'id', 'message', 'subject']);
      expect(keys(f.fix)).toEqual(['commands', 'text', 'url']);
    }
    expect(d.inspection).toMatchObject({ owner: 'acme', ownerKind: 'user', private: false, defaultBranch: 'main', rulesets: 'yes', installedLanes: [], callsRelease: false });
    expect(d.answers).toEqual({
      projectOwner: 'octo', maintainer: 'octo', stakeholder: 'octo', lanes: ['agent-review'], gates: [], testDatabase: 'none', delegation: null, deleteDefaultLabels: false, releaser: false,
      reuseApps: null, plugin: true, telemetry: false, upstreamFindings: 'drafted', upstreamEvidence: null, feature: 'review', reviewTrigger: 'labelled', sensitiveData: null, consent: 'no', claudeAuth: 'subscription', acceptedIdTokenHolders: [], deployEnvironments: [], chat: null,
    });
    expect(d.inspection.codeowners).toBeNull();
    expect(d.apps).toEqual({ identities: ['judge'], missing: ['judge'], reuse: [], command: expect.stringMatching(/^kanon apps --owner acme --repo widgets --apps judge --dir /), outcome: 'ran', exitCode: 0 });
    expect(d.files.find((f) => f.path === '.github/workflows/agent-review.yml')).toMatchObject({ status: 'new', content: read(dir, '.github/workflows/agent-review.yml'), diff: [] });
    expect(d.findings.map((f) => f.id)).toEqual(['secret.claude-code-oauth-token']);
    expect(d.findings[0]!.fix.commands).toEqual(['gh secret set CLAUDE_CODE_OAUTH_TOKEN -R acme/widgets   # in your own terminal, never with ! at the Claude Code prompt']);
    expect(d.notes).toContain('init commits nothing: review the files, then commit them on a branch and open a pull request.');
  });

  // #625: with `!` at the Claude Code prompt, standard input isn't a terminal, so a `gh secret set`
  // that reads the value there stores an empty secret without a word. A real secret's step says
  // to run it in the person's own terminal, or read the value from a file.
  it("sends a real secret's gh secret set to the person's own terminal or a file, never `!` (#625)", async () => {
    const all = Object.keys(REQ.lanes).map((l) => l.slice('agent-'.length)).join(',');
    const d = parse(await run(checkout(), fakeGitHub(), ['--yes', '--json', '--no-apps', '--lanes', all, '--chat', 'slack']));
    const real = d.findings.filter((f) => ['secret.claude-code-oauth-token', 'secret.chat-project-digest', 'secret.chat-weekly-digest'].includes(f.id));
    // No lane takes DIGEST_WEBHOOK since plan 0011 N7 and N8: each chat kind's secret is a step of its own.
    expect(real.map((f) => f.id)).toEqual(['secret.claude-code-oauth-token', 'secret.chat-project-digest', 'secret.chat-weekly-digest']);
    for (const f of real) {
      expect(f.fix.text, f.id).toMatch(/in your own terminal/);
      expect(f.fix.text, f.id).toMatch(/never with `!` at the Claude Code prompt/);
      expect(f.fix.text, f.id).toMatch(/empty secret/);
      expect(f.fix.text, f.id).toContain('`< <file>`');
      expect(f.fix.commands, f.id).toEqual([`gh secret set ${f.subject} -R ${REPO}   # in your own terminal, never with ! at the Claude Code prompt`]);
    }
  });

  it('is the same run as the prose: the same exit code, changes in the summary\'s order, findings in its numbering', async () => {
    const opts = { admin: false, labelCreateFails: true };
    const prose = await run(checkout(), fakeGitHub(opts), ['--yes']);
    const json = await run(checkout(), fakeGitHub(opts), ['--yes', '--json']);
    expect(json.status).toBe(prose.status);
    expect(json.err.replace(/kanon-init-[^/\s]+/g, '<dir>')).toBe(prose.out.replace(/kanon-init-[^/\s]+/g, '<dir>'));
    const d = parse(json);
    const summary = prose.out.split('== Summary ==\n')[1]!;
    expect(d.changes.map((c) => `- ${c.message}`)).toEqual(summary.split('\n').filter((l) => l.startsWith('- ')));
    const numbered = [...summary.matchAll(/^\d+\. (.*)$/gm)].map((m) => m[1]);
    expect(d.findings).toHaveLength(numbered.length);
    expect(d.findings.map((f) => f.id)).toEqual(['label.create', 'merge.settings', 'ruleset.create', 'secret.claude-code-oauth-token']);
    expect(numbered[0]).toBe('Create the labels the token could not (it needs Issues: write):');
  });

  // GitHub leaves the merge settings out of its answer to a token without Administration: read,
  // such as a fine-grained token of a person who administers the repository. Absent is unknown,
  // not different: init said it would set settings that were already K-SHIP-3's.
  it("doesn't claim to set the merge settings when the token can't read them", async () => {
    const known = (n: string) => n.startsWith('Merge settings not known');
    const dry = parse(await run(checkout(), fakeGitHub({ settings: {} }), ['--json', '--dry-run']));
    expect(dry.changes.filter((c) => c.kind === 'merge-settings')).toEqual([]);
    expect(dry.notes.some(known)).toBe(true);
    const github = fakeGitHub({ settings: {} });
    const d = parse(await run(checkout(), github, ['--json']));
    expect(d.changes.filter((c) => c.kind === 'merge-settings')).toEqual([]);
    expect(d.findings.map((f) => f.id)).not.toContain('merge.settings');
    expect(writes(github.calls).filter((a) => a.includes('PATCH'))).toEqual([]);
    expect(d.notes.some(known)).toBe(true);
    // Readable, they are checked and set as before, and no note says otherwise.
    const readable = parse(await run(checkout(), fakeGitHub(), ['--json', '--dry-run']));
    expect(readable.changes.filter((c) => c.kind === 'merge-settings')).toHaveLength(1);
    expect(readable.notes.some(known)).toBe(false);
  });

  // A fine-grained token whose repository access leaves the repository out still reads a public
  // one, and GitHub's `permissions` are the account's role, so the dry run said `admin: true`
  // while every write then failed, each step asking for a permission the token already had (#1551).
  it("says the token doesn't cover the repository, from its grants, not the account's role", async () => {
    const dry = parse(await run(checkout(), fakeGitHub({ admin: true, tokenCovers: false }), ['--json', '--dry-run']));
    expect(dry.inspection.admin).toBe(false);
    expect(dry.inspection.tokenCoversRepository).toBe(false);
    expect(dry.notes.some((n) => n.startsWith("The token gh uses doesn't cover acme/widgets"))).toBe(true);
    const github = fakeGitHub({ admin: true, tokenCovers: false });
    const real = await run(checkout(), github, ['--json', '--no-apps']);
    expect(real.err).toContain("Your token doesn't cover acme/widgets");
    const d = parse(real);
    const label = d.findings.find((f) => f.id === 'label.create');
    expect(label?.message).toMatch(/repository access doesn't cover acme\/widgets/);
    expect(label?.message).not.toMatch(/needs Issues: write/);
    expect(d.findings.find((f) => f.id === 'ruleset.create')?.fix.text).toMatch(/^Create it with a token whose repository access covers acme\/widgets/);
    // A token that covers it is read as before, and the account's role decides.
    const covered = parse(await run(checkout(), fakeGitHub({ admin: true }), ['--json', '--dry-run']));
    expect(covered.inspection.admin).toBe(true);
    expect(covered.inspection.tokenCoversRepository).toBe(true);
    expect(covered.notes.some((n) => n.includes("doesn't cover"))).toBe(false);
  });

  it('says what a dry run would do, and does nothing', async () => {
    const dir = checkout();
    const github = fakeGitHub();
    const r = await run(dir, github, ['--json', '--dry-run']);
    const d = parse(r);
    expect(d.dryRun).toBe(true);
    expect(writes(github.calls)).toEqual([]);
    expect(r.appsCalls).toEqual([]);
    expect(d.apps.outcome).toBe('would-run');
    expect(d.files.every((f) => f.status === 'new')).toBe(true);
    expect(d.changes.map((c) => c.kind)).toContain('ruleset');
    expect(execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
  });

  it('reports complete when nothing is left, and the files already as init writes them', async () => {
    const dir = checkout();
    const github = fakeGitHub();
    await run(dir, github);
    github.st.secrets!.add('CLAUDE_CODE_OAUTH_TOKEN');
    const d = parse(await run(dir, github, ['--json']));
    expect(d.status).toBe('complete');
    expect(d.findings).toEqual([]);
    expect(d.changes).toEqual([]);
    expect(d.apps.outcome).toBe('registered');
    expect(new Set(d.files.map((f) => f.status))).toEqual(new Set(['same']));
  });

  it('reports failed, exit 1, and a blocking finding when kanon apps does not finish', async () => {
    const r = await run(checkout(), fakeGitHub(), ['--json'], undefined, REQ, { apps: async () => 3 });
    expect(r.status).toBe(1);
    const d = parse(r);
    expect(d).toMatchObject({ status: 'failed', exitCode: 1, failures: ['kanon apps did not finish (exit 3).'] });
    expect(d.apps).toMatchObject({ outcome: 'failed', exitCode: 3 });
    expect(d.findings.find((f) => f.id === 'app.failed')).toMatchObject({ blocking: true, category: 'app', subject: 'judge' });
  });

  it('prints the error document, and nothing else, when it cannot start', async () => {
    const bad = await run(checkout(), fakeGitHub(), ['--json', '--bogus']);
    expect(bad.status).toBe(2);
    const d = JSON.parse(bad.out);
    expect(keys(d)).toEqual(['error', 'exitCode', 'kanon', 'schema', 'status']);
    expect(d).toMatchObject({ schema: SCHEMA, status: 'error', exitCode: 2, error: 'unknown argument "--bogus"' });
    const none = mkdtempSync(join(tmpdir(), 'kanon-init-json-none-'));
    dirs.push(none);
    const notCheckout = await run(none, fakeGitHub(), ['--json']);
    expect(notCheckout.status).toBe(1);
    expect(JSON.parse(notCheckout.out)).toMatchObject({ status: 'error', exitCode: 1, error: expect.stringContaining('is not a git checkout') });
  });

  it('prints a failed document listing the files already written when a write throws (#375)', async () => {
    const dir = checkout();
    const github = fakeGitHub();
    let n = 0;
    const r = await run(dir, github, ['--json'], undefined, REQ, {
      writeFile: (path: string, text: string) => {
        if (++n === 3) throw new Error(`EROFS: read-only file system, open '${path}'`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      },
    });
    expect(r.status).toBe(1);
    const d = parse(r);
    expect(d).toMatchObject({ schema: SCHEMA, status: 'failed', exitCode: 1, repository: REPO });
    expect(d.failures).toEqual([expect.stringMatching(/^stopped on an unexpected error: EROFS: read-only file system/)]);
    const written = d.files.filter((f) => f.status === 'new').map((f) => String(f.path));
    expect(written).toHaveLength(2);
    for (const f of written) expect(existsSync(join(dir, f)), f).toBe(true);
    expect(d.changes.map((c) => c.subject)).toEqual(written);
    expect(r.err).toContain('kanon init: stopped on an unexpected error: EROFS');
    // Nothing after the throw ran: no label, ruleset or App.
    expect(writes(github.calls)).toEqual([]);
    expect(r.appsCalls).toEqual([]);
  });

  it('prints the error document when it throws before inspecting, or cannot read its requirements (#375)', async () => {
    const early = await run(checkout(), fakeGitHub(), ['--json'], undefined, REQ, {
      git: () => {
        throw new Error('spawnSync git ENOENT');
      },
    });
    expect(early.status).toBe(1);
    expect(JSON.parse(early.out)).toEqual({ schema: SCHEMA, kanon: expect.any(String), status: 'error', exitCode: 1, error: 'stopped on an unexpected error: spawnSync git ENOENT. Nothing was changed.' });
    const noReq = await run(checkout(), fakeGitHub(), ['--json'], undefined, REQ, {
      requirements: () => {
        throw new Error('ENOENT: requirements.json');
      },
    });
    expect(noReq.status).toBe(1);
    expect(JSON.parse(noReq.out)).toMatchObject({ status: 'error', exitCode: 1, error: expect.stringContaining("could not read this release's requirements file (ENOENT: requirements.json)") });
    // Without --json, the same sentence on standard error, and no stack trace.
    const prose = await run(checkout(), fakeGitHub(), ['--yes'], undefined, REQ, {
      git: () => {
        throw new Error('spawnSync git ENOENT');
      },
    });
    expect(prose.status).toBe(1);
    expect(prose.out).toBe('');
    expect(prose.err).toBe('kanon init: stopped on an unexpected error: spawnSync git ENOENT');
  });

  it('prints the error document for --help with --json, not an empty standard output (#372)', async () => {
    for (const h of ['--help', '-h']) {
      const github = fakeGitHub();
      const r = await run(checkout(), github, [h, '--json']);
      expect(r.status, h).toBe(2);
      expect(JSON.parse(r.out), h).toMatchObject({ schema: SCHEMA, status: 'error', exitCode: 2, error: '--help and --json contradict each other; give one' });
      expect(r.err, h).toContain('Usage: kanon init');
      expect(github.calls).toEqual([]);
    }
    // Without --json, --help prints the usage on standard output, as before.
    const help = await run(checkout(), fakeGitHub(), ['--help']);
    expect(help.status).toBe(0);
    expect(help.out).toContain('Usage: kanon init');
  });

  it('sends the prose of kanon apps and kanon milestones to standard error too', async () => {
    const r = await run(checkout(), fakeGitHub(), ['--json'], undefined, REQ, {
      apps: async (_argv: string[], io?: { out: (l: string) => void }) => (io?.out('APPS PROSE'), 0),
      milestones: async (_argv: string[], io?: { out: (l: string) => void }) => (io?.out('MILESTONES PROSE'), 0),
    });
    expect(() => JSON.parse(r.out)).not.toThrow();
    expect(r.err).toContain('APPS PROSE');
    expect(r.err).toContain('MILESTONES PROSE');
  });

  it('gives every finding a documented id, and documents only ids the code gives', async () => {
    const source = readFileSync(join(ROOT, 'cli/init.mjs'), 'utf8');
    const inCode = [...new Set([...source.matchAll(/\bid: '([a-z-]+\.[a-z-]+)'/g)].map((m) => m[1]!))].sort();
    const documented = fields('### The findings').sort();
    expect(inCode).toEqual(documented);
    const categories = new Map(tableColumn('### The findings').map((id, i) => [id.replace(/`/g, ''), tableColumn('### The findings', 1)[i]!.replace(/`/g, '')]));
    // The findings these fixtures produce carry their documented category.
    const dep = checkout({ '.github/dependabot.yml': 'version: 2\nupdates: []\n', '.claude/settings.json': '{}\n' });
    const d = parse(await run(dep, fakeGitHub({ admin: false, labelCreateFails: true, secrets: null }), ['--json', '--no-apps']));
    expect(d.findings.map((f) => f.id)).toEqual(['dependabot.kanon-entry', 'plugin.declare', 'label.create', 'merge.settings', 'ruleset.create', 'app.create', 'secret.unreadable']);
    for (const f of d.findings) expect(f.category, f.id).toBe(categories.get(f.id));
    expect(d.apps.outcome).toBe('left-to-you');
  });

  it('documents each status the document can carry', () => {
    expect(tableColumn('### The document').filter((c) => /^`[a-z-]+`$/.test(c) && STATUSES.includes(c.replace(/`/g, '')))).toHaveLength(STATUSES.length);
  });
});
describe('kanon init pins the release it runs from (plan 0012 decision 5, CLI-1)', () => {
  const CANDIDATE = `candidate-${PINNED}`;
  /** Every Kanon reference in the files a run wrote: each `yedeya-labs/kanon/...@<ref>`, and the plugin's marketplace ref. */
  const refsWritten = (d: Doc) =>
    d.files
      .filter((f) => f.status === 'new' || f.status === 'rewritten')
      .map((f) => String(f.content))
      .flatMap((t) => [...t.matchAll(/yedeya-labs\/kanon\/[\w./-]+@([\w.-]+)/g), ...t.matchAll(/"ref":\s*"([^"]+)"/g)].map((m) => m[1]));
  const FULL = ['--yes', '--json', '--no-apps', '--feature', 'full', '--consent', 'yes'];
  const lookedFor = (calls: Array<{ args: string[] }>) => calls.map((c) => c.args.find((a) => a.includes('/git/ref/tags/'))).filter(Boolean);
  /** What the checkout holds besides git's own directory. */
  const tree = (dir: string) => readdirSync(dir).filter((f) => f !== '.git');

  it('pins vX.Y.Z when Kanon has both that tag and its candidate', async () => {
    const r = await run(checkout(), fakeGitHub({ kanonTags: new Set([PINNED, CANDIDATE]) }), FULL);
    expect(r.status, r.err).toBe(0);
    const d = parse(r);
    expect(d.pin).toBe(PINNED);
    expect(d.kanon).toBe(PINNED);
    const refs = refsWritten(d);
    expect(refs.length).toBeGreaterThan(5);
    expect(new Set(refs)).toEqual(new Set([PINNED]));
  });

  it('pins candidate-vX.Y.Z when Kanon has only that tag: every reference it writes is the candidate', async () => {
    const dir = checkout();
    const github = fakeGitHub({ kanonTags: new Set([CANDIDATE]) });
    // With Kanon's Slack hook, whose one step pins Kanon's notify action (plan 0011 §7.1).
    const r = await run(dir, github, [...FULL, '--chat', 'slack']);
    expect(r.status, r.err).toBe(0);
    const d = parse(r);
    expect(d.pin).toBe(CANDIDATE);
    // `kanon` stays the release of the init that ran, its package.json's version.
    expect(d.kanon).toBe(PINNED);
    const refs = refsWritten(d);
    expect(refs.length).toBeGreaterThan(5);
    expect(new Set(refs)).toEqual(new Set([CANDIDATE]));
    expect(read(dir, '.github/actions/notify/action.yml')).toContain(`uses: yedeya-labs/kanon/actions/notify/slack@${CANDIDATE} `);
    // And the generic webhook hook, the same way.
    const hooked = parse(await run(checkout(), fakeGitHub({ kanonTags: new Set([CANDIDATE]) }), [...FULL, '--chat', 'webhook']));
    expect(hooked.files.find((f) => f.path === '.github/actions/notify/action.yml')!.content).toContain(`uses: yedeya-labs/kanon/actions/notify/webhook@${CANDIDATE} `);
    expect(new Set(refsWritten(hooked))).toEqual(new Set([CANDIDATE]));
    expect(read(dir, '.claude/settings.json')).toBe(pluginSettingsFile(CANDIDATE));
    expect(r.err).toContain(`at Kanon ${CANDIDATE}`);
    expect(lookedFor(github.calls)).toEqual([`repos/yedeya-labs/kanon/git/ref/tags/${PINNED}`, `repos/yedeya-labs/kanon/git/ref/tags/${CANDIDATE}`]);
  });

  it('refuses when Kanon has neither tag, naming both, and changes nothing', async () => {
    const dir = checkout();
    const github = fakeGitHub({ kanonTags: new Set(['v0.0.1', 'candidate-v0.0.1']) });
    const r = await run(dir, github, ['--yes', '--json']);
    expect(r.status).toBe(1);
    const d = parse(r);
    expect(d.status).toBe('error');
    expect(d.error).toContain(`neither the tag ${PINNED} nor ${CANDIDATE}`);
    expect(d.error).toContain('Nothing was changed.');
    expect(r.err).toContain(`kanon init: this is Kanon ${PINNED}`);
    expect(writes(github.calls)).toEqual([]);
    expect(tree(dir)).toEqual([]);
    expect(r.appsCalls).toEqual([]);
  });

  // An organisation's policy can refuse the person's fine-grained token on Kanon's repository
  // (one whose lifetime is over 366 days) while it works on their own (#1551). Kanon's
  // repository is public, so the tag is read anonymously instead, with no credential.
  it('reads the tag anonymously when GitHub refuses the token on Kanon\'s repository', async () => {
    const POLICY = "gh: The 'yedeya-labs' organization forbids access via a fine-grained personal access tokens if the token's lifetime is greater than 366 days. (HTTP 403)";
    const remote: string[][] = [];
    const tags = new Set([CANDIDATE]);
    const git = (args: string[]) => {
      if (!args.includes('ls-remote')) return realDeps.git(args);
      remote.push(args);
      const ref = args[args.length - 1]!;
      return tags.has(ref.replace('refs/tags/', '')) ? { status: 0, stdout: `0123abcd\t${ref}\n`, stderr: '' } : { status: 2, stdout: '', stderr: '' };
    };
    const dir = checkout();
    const r = await run(dir, fakeGitHub({ kanonTagsFail: POLICY }), ['--yes', '--json'], undefined, REQ, { git });
    expect(r.status, r.err).toBe(0);
    expect(parse(r).pin).toBe(CANDIDATE);
    expect(remote.map((a) => a[a.length - 1])).toEqual([`refs/tags/${PINNED}`, `refs/tags/${CANDIDATE}`]);
    // With no credential helper, so neither the token nor gh's login is sent.
    for (const a of remote) expect(a.slice(0, 2)).toEqual(['-c', 'credential.helper=']);
    // An anonymous read that fails too leaves the tag unknown, and init refuses as before.
    const down = (args: string[]) => (args.includes('ls-remote') ? { status: 128, stdout: '', stderr: 'fatal: unable to access' } : realDeps.git(args));
    const refused = await run(checkout(), fakeGitHub({ kanonTagsFail: POLICY }), ['--yes', '--json'], undefined, REQ, { git: down });
    expect(refused.status).toBe(1);
    expect(parse(refused).error).toContain('reading it anonymously failed too (fatal: unable to access)');
  });

  it("refuses when it can't tell whether a tag exists, rather than guess", async () => {
    const dir = checkout();
    const r = await run(dir, fakeGitHub({ kanonTagsFail: 'error connecting to api.github.com' }), ['--yes', '--json']);
    expect(r.status).toBe(1);
    expect(parse(r).error).toContain(`could not tell whether yedeya-labs/kanon has the tag ${PINNED} (error connecting to api.github.com)`);
    expect(tree(dir)).toEqual([]);
  });
});
describe('kanon init, a flag for each question (#367)', () => {
  const never = async (q: string): Promise<string> => {
    throw new Error(`asked "${q}"`);
  };
  const RELEASE_CALLER = 'name: Release\non:\n  push:\n    branches: [main]\npermissions: {}\njobs:\n  release:\n    uses: yedeya-labs/kanon/.github/workflows/release.yml@v1.2.3\n';

  it('answers every question from its flag with --yes, asking nothing', async () => {
    const dir = checkout({ '.github/workflows/release.yml': RELEASE_CALLER });
    const github = fakeGitHub();
    const r = await run(dir, github, [
      '--yes', '--project-owner', 'grace', '--maintainer', 'linus', '--stakeholder=ada', '--lanes', 'review', '--gates', 'make check, make lint',
      '--test-database', 'hook', '--delegate-name', 'Grace Hopper', '--delegate-email', 'grace@example.com', '--delete-default-labels', '--releaser', '--create-apps',
    ], undefined, REQ, { ask: never });
    expect(r.status, r.err).toBe(0);
    const adoption = read(dir, 'docs/qa/adoption.md');
    for (const row of ['| Owner | `@grace` |', '| Maintainer | `@linus` |', '| Stakeholder | `@ada` |']) expect(adoption).toContain(row);
    expect(read(dir, 'docs/qa/stack.md')).toContain('1. `make check`\n2. `make lint`');
    expect(read(dir, 'docs/qa/test-database.md')).toContain('**Test database:** `hook`');
    expect(read(dir, 'docs/qa/sign-off-delegation.md')).toContain('| Grace Hopper | grace@example.com | 2026-10-05 |');
    expect(github.st.labels.has('question')).toBe(false);
    expect(r.appsCalls).toEqual([['--owner', 'acme', '--repo', 'widgets', '--apps', 'judge,releaser', '--dir', expect.any(String)]]);
  });

  it('answers the other way from the negative flags, and with --gates none', async () => {
    const dir = checkout({ '.github/workflows/release.yml': RELEASE_CALLER, 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }) });
    const github = fakeGitHub();
    const r = await run(dir, github, ['--yes', '--gates', 'none', '--test-database', 'none', '--no-delegation', '--keep-default-labels', '--no-releaser', '--no-apps'], undefined, REQ, { ask: never });
    expect(r.status, r.err).toBe(0);
    expect(read(dir, 'docs/qa/stack.md')).toContain('None yet');
    expect(existsSync(join(dir, 'docs/qa/sign-off-delegation.md'))).toBe(false);
    expect(existsSync(join(dir, 'docs/qa/test-database.md'))).toBe(false);
    expect(github.st.labels.has('question')).toBe(true);
    expect(r.appsCalls).toEqual([]);
    expect(r.out).toContain('Create the Apps the lanes run as, from this checkout');
  });

  it('asks, without --yes, only the questions no flag answers, then confirms the summary', async () => {
    const asked: string[] = [];
    const r = await run(checkout(), fakeGitHub(), ['--feature', 'review', '--sensitive-data', '--project-owner', 'grace', '--create-apps'], undefined, REQ, {
      ask: async (q: string, d: string) => (asked.push(q), d),
    });
    expect(r.status, r.err).toBe(0);
    expect(asked.map((q) => q.split('\n')[0])).toEqual([consentQuestion(PINNED), CONFIRM]);
    expect(r.appsCalls).toHaveLength(1);
  });

  it('holds a negative flag against a person who would say yes, without --yes', async () => {
    const dir = checkout({ '.github/workflows/release.yml': RELEASE_CALLER });
    const github = fakeGitHub();
    const asked: string[] = [];
    const r = await run(dir, github, ['--no-releaser', '--keep-default-labels', '--no-delegation', '--no-plugin', '--no-telemetry', '--no-apps'], undefined, REQ, {
      ask: async (q: string, d: string) => (asked.push(q), q.endsWith('(y/n)') ? 'y' : d),
    });
    expect(r.status, r.err).toBe(0);
    expect(asked.filter((q) => q.endsWith('(y/n)'))).toEqual([]);
    expect(github.st.labels.has('question')).toBe(true);
    expect(existsSync(join(dir, 'docs/qa/sign-off-delegation.md'))).toBe(false);
    expect(existsSync(join(dir, '.claude/settings.json'))).toBe(false);
    expect(existsSync(join(dir, '.github/workflows/telemetry.yml'))).toBe(false);
    expect(read(dir, '.github/workflows/apps-check.yml')).not.toContain('RELEASER_APP_ID');
    expect(r.appsCalls).toEqual([]);
  });

  it('fails by name on an unknown flag, a value flag given twice, a bad value, or a flag that takes none', () => {
    expect(() => parseArgs(['--maintainers', 'x'], REQ)).toThrow('unknown argument "--maintainers"');
    expect(() => parseArgs(['--project-owner', 'a', '--project-owner', 'b'], REQ)).toThrow('--project-owner is given twice');
    expect(() => parseArgs(['--owner', 'grace'], REQ)).toThrow('unknown argument "--owner": the project\'s Owner is --project-owner');
    expect(() => parseArgs(['--gates=x', '--gates', 'y'], REQ)).toThrow('--gates is given twice');
    expect(() => parseArgs(['--test-database', 'docker'], REQ)).toThrow('--test-database takes none or hook, not "docker"');
    expect(() => parseArgs(['--lanes', 'reviews'], REQ)).toThrow('"agent-reviews" is not a Kanon lane');
    expect(() => parseArgs(['--releaser=yes'], REQ)).toThrow('--releaser takes no value, not "yes"');
    expect(() => parseArgs(['--delegate-name'], REQ)).toThrow('--delegate-name needs a value');
  });

  it('fails by name on each pair of flags that contradict each other', () => {
    expect(CONFLICTS.length).toBe(18);
    const values: Record<string, string> = { '--delegate-name': 'v', '--delegate-email': 'v', '--consent': 'yes', '--upstream-findings': 'drafted', '--feature': 'review', '--lanes': 'review' };
    for (const [x, y] of CONFLICTS) {
      const argv = [x, y].flatMap((f) => (values[f] ? [f, values[f]] : [f]));
      expect(() => parseArgs(argv, REQ), `${x} ${y}`).toThrow(`${x} and ${y} contradict each other; give one`);
    }
    expect(parseArgs(['--delegate-email', 'e@x'], REQ).given.delegation).toBe(true);
    expect(parseArgs(['--json'], REQ).yes).toBe(true);
    // -h is --help.
    expect(() => parseArgs(['-h', '--json'], REQ)).toThrow('--help and --json contradict each other; give one');
  });

  it('never takes the next flag as a value flag\'s value, and takes a value beginning with "-" inline (#372)', () => {
    const valueFlags = ['--repo', '--dir', '--lanes', '--project-owner', '--maintainer', '--stakeholder', '--gates', '--test-database', '--delegate-name', '--delegate-email'];
    for (const f of valueFlags) {
      expect(() => parseArgs([f, '--yes', '--json'], REQ), f).toThrow(`${f} needs a value, not the flag "--yes"; to give a value that begins with "-", write ${f}=<value>`);
      expect(() => parseArgs([f, '-h'], REQ), f).toThrow(`${f} needs a value, not the flag "-h"`);
    }
    expect(parseArgs(['--gates=--fast-check', '--yes'], REQ).given.gates).toBe('--fast-check');
    expect(parseArgs(['--project-owner', 'grace', '--yes'], REQ).given.projectOwner).toBe('grace');
  });

  it('records no flag as the Owner, and prints the error document, when a value flag is followed by a flag (#372)', async () => {
    const github = fakeGitHub();
    const dir = checkout();
    const r = await run(dir, github, ['--project-owner', '--yes', '--json']);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.out)).toMatchObject({ schema: SCHEMA, status: 'error', exitCode: 2, error: expect.stringContaining('--project-owner needs a value, not the flag "--yes"') });
    expect(github.calls).toEqual([]);
    expect(existsSync(join(dir, 'docs/qa/adoption.md'))).toBe(false);
  });

  it('exits 2 on a contradiction and touches nothing', async () => {
    const github = fakeGitHub();
    const r = await run(checkout(), github, ['--yes', '--releaser', '--no-releaser']);
    expect(r.status).toBe(2);
    expect(r.err).toContain('kanon init: --releaser and --no-releaser contradict each other; give one');
    expect(github.calls).toEqual([]);
  });

  it("refuses --releaser for a repository that doesn't call Kanon's release workflow, before any call to GitHub", async () => {
    const github = fakeGitHub();
    const r = await run(checkout(), github, ['--yes', '--releaser']);
    expect(r.status).toBe(2);
    expect(r.err).toContain("kanon init: --releaser is for a repository that calls Kanon's release workflow");
    expect(github.calls).toEqual([]);
    expect(writes(github.calls)).toEqual([]);
  });

  it('lists every flag it takes in its usage text and in docs/init.md, and only those', () => {
    const source = readFileSync(join(ROOT, 'cli/init.mjs'), 'utf8');
    // `--owner` is matched only to be refused with a hint (Owner, 2026-10-06), so it is not a flag init takes.
    const parsed = new Set([...source.matchAll(/flag === '(--[a-z-]+)'/g)].map((m) => m[1]!).filter((f) => f !== '--owner'));
    const usage = new Set([...USAGE.matchAll(/^ {2}(?:-h, )?(--[a-z-]+)/gm)].map((m) => m[1]!));
    expect([...usage].sort()).toEqual([...parsed].sort());
    const documented = new Set(tableColumn('## Answering without a terminal', 1).flatMap((c) => [...c.matchAll(/`(--[a-z-]+)/g)].map((m) => m[1]!)));
    const answers = [...parsed].filter((f) => !['--repo', '--dir', '--yes', '--dry-run', '--json', '--help'].includes(f));
    expect([...documented].sort()).toEqual(answers.sort());
  });
});
// #376: init offers to declare the kanon plugin in .claude/settings.json, pinned to its release
// (docs/skills.md), and never rewrites a settings file the project already has.
describe('kanon init and the kanon plugin (#376)', () => {
  const RELEASE = `v${JSON.parse(read(ROOT, 'package.json')).version}`;
  const SETTINGS = '.claude/settings.json';

  it('declares it by default, pinned to the release it runs from, and leaves it as written on a second run', async () => {
    const dir = checkout();
    const first = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps']));
    expect(first.answers.plugin).toBe(true);
    expect(read(dir, SETTINGS)).toBe(pluginSettingsFile(RELEASE));
    expect(readPluginDeclaration(read(dir, SETTINGS))).toEqual({ status: 'declared', name: 'kanon', ref: RELEASE, enabled: true });
    expect(first.files.find((f) => f.path === SETTINGS)).toMatchObject({ status: 'new' });
    expect(first.findings.map((f) => f.id)).not.toContain('plugin.declare');
    const second = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps']));
    expect(second.files.find((f) => f.path === SETTINGS)).toMatchObject({ status: 'same' });
    expect(second.findings.map((f) => f.id)).not.toContain('plugin.declare');
  });

  it('writes nothing with --no-plugin, and a dry run writes nothing either', async () => {
    const no = checkout();
    const d = parse(await run(no, fakeGitHub(), ['--yes', '--json', '--no-plugin', '--no-apps']));
    expect(d.answers.plugin).toBe(false);
    expect(existsSync(join(no, SETTINGS))).toBe(false);
    expect(d.files.map((f) => f.path)).not.toContain(SETTINGS);
    const dry = checkout();
    const dd = parse(await run(dry, fakeGitHub(), ['--yes', '--json', '--dry-run']));
    expect(dd.files.find((f) => f.path === SETTINGS)).toMatchObject({ status: 'new', content: pluginSettingsFile(RELEASE) });
    expect(existsSync(join(dry, SETTINGS))).toBe(false);
  });

  it('leaves a settings file the project has alone, and names the keys to merge into it', async () => {
    const own = '{\n  "permissions": { "allow": ["Bash(npm test)"] }\n}\n';
    const dir = checkout({ [SETTINGS]: own });
    const d = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps']));
    expect(read(dir, SETTINGS)).toBe(own);
    expect(d.files.map((f) => f.path)).not.toContain(SETTINGS);
    const f = d.findings.find((x) => x.id === 'plugin.declare')!;
    expect(f).toMatchObject({ category: 'plugin', blocking: false, subject: SETTINGS });
    expect(f.message).toBe(`${SETTINGS} exists, and doesn't declare the kanon plugin.`);
    // The lines are the declaration's keys, which merged into an empty object give what init writes.
    expect(JSON.parse(`{${f.fix.commands.join('\n')}}`)).toEqual(JSON.parse(pluginSettingsFile(RELEASE)));
  });

  it('names a declaration at another release, or not enabled, and says nothing of one at its release', async () => {
    const stale = JSON.parse(pluginSettingsFile('v0.1.0'));
    const off = { ...JSON.parse(pluginSettingsFile(RELEASE)), enabledPlugins: { 'kanon@kanon': false }, permissions: {} };
    const at = { ...JSON.parse(pluginSettingsFile(RELEASE)), permissions: {} };
    const message = async (doc: unknown) => parse(await run(checkout({ [SETTINGS]: JSON.stringify(doc) }), fakeGitHub(), ['--yes', '--json', '--no-apps'])).findings.find((x) => x.id === 'plugin.declare')?.message;
    expect(await message(stale)).toBe(`${SETTINGS} declares the kanon plugin's marketplace "kanon" at v0.1.0, not at ${RELEASE}.`);
    expect(await message(off)).toBe(`${SETTINGS} declares the kanon plugin's marketplace "kanon" at ${RELEASE}, and doesn't enable kanon@kanon.`);
    expect(await message(at)).toBeUndefined();
  });

  it('asks the question through Change something, and takes the answer', async () => {
    const asked: string[] = [];
    const dir = checkout();
    const r = await run(dir, fakeGitHub(), ['--no-apps'], undefined, REQ, { ask: changing('4', { 'Declare the kanon plugin': 'n' }, asked) });
    expect(r.status, r.err).toBe(0);
    expect(asked.filter((q) => q.startsWith('Declare the kanon plugin'))).toHaveLength(1);
    expect(existsSync(join(dir, SETTINGS))).toBe(false);
  });
});
// kanon#428: the lane catalogue (docs/lanes.json) is what a person chooses lanes from, in
// --help and in the JSON's `catalogue`, which the adopt skill asks a question per group from.
describe('kanon init and the lane catalogue (#428)', () => {
  const CATALOGUE = JSON.parse(readFileSync(join(ROOT, 'docs/lanes.json'), 'utf8')) as { groups: Array<{ id: string; title: string; header: string }>; lanes: Record<string, { group: string; does: string; when: string; cost: string; minutes: string }> };

  it('prints every group and every lane of the catalogue in its JSON, with the fields docs/init.md lists', async () => {
    const r = await run(checkout(), fakeGitHub(), ['--yes', '--json', '--dry-run']);
    const d = parse(r) as Doc & { catalogue: Array<Record<string, unknown> & { group: string; lanes: Array<Record<string, unknown> & { lane: string }> }> };
    expect(d.catalogue.map((g) => g.group)).toEqual(CATALOGUE.groups.map((g) => g.id));
    for (const g of d.catalogue) {
      expect(keys(g)).toEqual(fields('### The lane catalogue').sort());
      for (const l of g.lanes) {
        expect(keys(l)).toEqual(fields('### A catalogue lane').sort());
        const e = CATALOGUE.lanes[l.lane]!;
        expect(l, l.lane).toMatchObject({ does: e.does, when: e.when, cost: e.cost, minutes: e.minutes });
        expect(e.group).toBe(g.group);
      }
    }
    expect(d.catalogue.flatMap((g) => g.lanes.map((l) => l.lane)).sort()).toEqual(Object.keys(REQ.lanes).sort());
    expect(d.catalogue[0]!.lanes[0]).toMatchObject({ lane: 'agent-review', app: 'judge', recommended: true, installed: false, qaStore: false, schedule: null });
    expect(d.catalogue.flatMap((g) => g.lanes).find((l) => l.lane === 'agent-explore')).toMatchObject({ app: 'author', qaStore: true, schedule: '0 3 * * *', hooks: ['.github/actions/explore-sweep/action.yml'] });
    // Its id-token grant is for the aggregate function, not a QA store (kanon#471's review).
    expect(d.catalogue.flatMap((g) => g.lanes).find((l) => l.lane === 'agent-explore-telemetry')).toMatchObject({ app: 'author', qaStore: false, schedule: '30 6 * * 2' });
  });

  it('recommends only the review lane on a repository that calls none', () => {
    const rec = laneCatalogue(REQ, []).flatMap((g) => g.lanes).filter((l) => l.recommended).map((l) => l.lane);
    expect(rec).toEqual(['agent-review']);
  });

  it('recommends what the repository calls already, and what is recommended with it', () => {
    const lanes = laneCatalogue(REQ, ['agent-implement']).flatMap((g) => g.lanes);
    expect(lanes.filter((l) => l.recommended).map((l) => l.lane).sort()).toEqual(['agent-dispatch-sweep', 'agent-implement', 'agent-implement-revise', 'agent-issue-backstop', 'agent-overseer', 'agent-rebase', 'agent-review']);
    expect(lanes.filter((l) => l.installed).map((l) => l.lane)).toEqual(['agent-implement']);
    // Transitively: the Lead recommends the reconciler, which recommends verify-acs and the daily digest.
    const lead = laneCatalogue(REQ, ['agent-lead']).flatMap((g) => g.lanes).filter((l) => l.recommended).map((l) => l.lane);
    expect(lead).toEqual(expect.arrayContaining(['agent-lead-reconcile', 'agent-verify-acs', 'agent-project-digest']));
  });

  // #478: the Overseer audits lanes that run unattended; with only the Reviewer it isn't recommended.
  it('recommends the Overseer only beside the Implementer or the Lead, never to a Reviewer-only repository', () => {
    const rec = (installed: string[]) => laneCatalogue(REQ, installed).flatMap((g) => g.lanes).filter((l) => l.recommended).map((l) => l.lane);
    expect(rec([])).not.toContain('agent-overseer');
    expect(rec(['agent-review'])).not.toContain('agent-overseer');
    expect(rec(['agent-implement'])).toContain('agent-overseer');
    expect(rec(['agent-lead'])).toContain('agent-overseer');
    const overseer = laneCatalogue(REQ, []).flatMap((g) => g.lanes).find((l) => l.lane === 'agent-overseer')!;
    expect(overseer.recommendedWith).toEqual(['agent-implement', 'agent-lead']);
    expect(overseer.when).toMatch(/^Once you run the Implementer, the Lead or the Merger unattended/);
  });

  it('recommends the same lanes whatever order the catalogue lists them in', () => {
    const cat = REQ.catalogue!;
    const reversed = { ...REQ, catalogue: { ...cat, lanes: Object.fromEntries(Object.entries(cat.lanes).reverse()) } };
    const rec = (req: typeof REQ, installed: string[]) => laneCatalogue(req, installed).flatMap((g) => g.lanes).filter((l) => l.recommended).map((l) => l.lane).sort();
    for (const installed of [[], ['agent-lead'], ['agent-implement'], ['agent-explore']]) expect(rec(reversed, installed), installed.join()).toEqual(rec(REQ, installed));
    expect(rec(reversed, ['agent-lead'])).toEqual(expect.arrayContaining(['agent-project-digest']));
  });

  it('lists every lane of the catalogue in --help, with what it does, by group', async () => {
    const r = await run(checkout(), fakeGitHub(), ['--help']);
    expect(r.status).toBe(0);
    expect(r.out).toBe(usage(REQ));
    for (const g of CATALOGUE.groups) expect(r.out).toContain(`\n  ${g.title}\n`);
    for (const [lane, e] of Object.entries(CATALOGUE.lanes)) expect(r.out).toMatch(new RegExp(`^ {4}${lane.slice('agent-'.length)} +${e.does.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'));
    expect(r.out).toMatch(/^ {4}review +.* \(recommended\)$/m);
  });
});
// #428: telemetry is asked, off by default, and installed only on an explicit yes. On yes, init
// writes the collector's caller exactly as docs/telemetry.md gives it, and leaves the operator's
// side (the register entry and the two variables) as a step.
// #452 (#79): a merge through a merge queue doesn't start a lane that runs on CI finishing on the
// default branch, so init says when the default branch has one, and the catalogue what it changes.
describe('kanon init and a merge queue on the default branch (#452)', () => {
  const queue = { type: 'merge_queue', parameters: { merge_method: 'SQUASH' } };
  const ruleset = (rules: unknown[]) => ({ id: 7, name: 'protect main', target: 'branch', enforcement: 'active', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } }, rules: [{ type: 'pull_request', parameters: { allowed_merge_methods: ['squash'] } }, ...rules] });
  const inspect = async (over: Parameters<typeof fakeGitHub>[0]) => parse(await run(checkout(), fakeGitHub(over), ['--json', '--dry-run', '--no-apps'])).inspection.defaultBranchMergeQueue;

  it('says whether the default branch merges through a merge queue: its ruleset has one, or the one init creates will', async () => {
    expect(await inspect({ rulesets: [ruleset([queue])] })).toBe(true);
    expect(await inspect({ kind: 'Organization', rulesets: [ruleset([])] })).toBe(false);
    expect(await inspect({ kind: 'Organization' })).toBe(true);
    expect(await inspect({})).toBe(false);
    expect(await inspect({ kind: 'Organization', private: true, orgPlan: 'enterprise', rulesetsOnPlan: false })).toBe(false);
  });

  it("gives each catalogue lane what a merge queue changes for it, from docs/lanes.json", async () => {
    const d = parse(await run(checkout(), fakeGitHub(), ['--json', '--dry-run', '--no-apps']));
    const lanes = (d.catalogue as Array<{ lanes: Array<{ lane: string; mergeQueue: string | null }> }>).flatMap((g) => g.lanes);
    expect(lanes.find((l) => l.lane === 'agent-merge')!.mergeQueue).toBe(REQ.catalogue!.lanes['agent-merge']!.mergeQueue);
    expect(lanes.find((l) => l.lane === 'agent-merge')!.mergeQueue).toMatch(/^Through a merge queue, a merge doesn't start its sweep/);
    // #484: the rebase lane's caller starts it on the merged pull request, which a queue doesn't change.
    expect(lanes.find((l) => l.lane === 'agent-rebase')!.mergeQueue).toBeNull();
    expect(lanes.find((l) => l.lane === 'agent-review')!.mergeQueue).toBeNull();
  });
});
