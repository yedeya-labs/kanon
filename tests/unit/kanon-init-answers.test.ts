import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GITHUB_DEFAULT_LABELS, INSTALL_WAIVER_REASONS, withChoices } from '../../cli/init.mjs';
import { readWaivers } from '../../scripts/lib/waivers.mjs';
import { SPAWNS } from './helpers/spawns.js';
import { REQ, checkout, fakeGitHub, parse, read, run } from './helpers/kanon-init.js';

// Each case runs `kanon init` against a real git checkout (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

/**
 * #1607 point 11: an answer that turns a file off removes `init`'s own copy and names any other;
 * point 14: the choices made at install write their waivers into the adoption record.
 */
const DB = 'docs/qa/test-database.md';
const RECORD = 'docs/qa/adoption.md';
type Doc = ReturnType<typeof parse>;
const fileOf = (d: Doc, p: string) => d.files.find((f) => f.path === p);
const stale = (d: Doc) => d.findings.filter((f) => f.id === 'file.stale');
const json = (extra: string[]) => ['--yes', '--json', '--no-apps', '--lanes', 'review', ...extra];
const commit = (dir: string) => {
  for (const args of [['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'install']]) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  }
};

describe('kanon init and a file an answer turns off (#1607 point 11)', () => {
  it("removes its own test-database declaration on --test-database none, and a dry run only says so", async () => {
    const dir = checkout();
    await run(dir, fakeGitHub(), json(['--test-database', 'hook']));
    expect(existsSync(join(dir, DB))).toBe(true);
    const dry = parse(await run(dir, fakeGitHub(), json(['--test-database', 'none', '--dry-run'])));
    expect(fileOf(dry, DB)).toMatchObject({ status: 'removed', content: null, diff: expect.arrayContaining(['- **Test database:** `hook`']) });
    expect(dry.changes.map((c) => String(c.message))).toContainEqual(expect.stringMatching(/^Would remove docs\/qa\/test-database\.md, exactly as init writes it, which the test database answer none/));
    expect(existsSync(join(dir, DB))).toBe(true);
    // #1629: the summary the person confirms counts it.
    expect(dry.summary.find((l) => l.answer === 'Files')?.value).toMatch(/, 1 removed \(an answer turns it off\)$/);
    const d = parse(await run(dir, fakeGitHub(), json(['--test-database', 'none'])));
    expect(d.summary.find((l) => l.answer === 'Files')?.value).toContain('1 removed');
    // Nothing to remove on the run after: the count goes.
    const again = parse(await run(dir, fakeGitHub(), json(['--test-database', 'none'])));
    expect(again.summary.find((l) => l.answer === 'Files')?.value).not.toContain('removed');
    expect(fileOf(d, DB)?.status).toBe('removed');
    expect(existsSync(join(dir, DB))).toBe(false);
    expect(stale(d)).toEqual([]);
  });

  it("leaves a copy the project edited and committed, naming it and the answer", async () => {
    const dir = checkout();
    await run(dir, fakeGitHub(), json(['--test-database', 'hook']));
    writeFileSync(join(dir, DB), `${read(dir, DB)}\nOur tests use Postgres.\n`);
    commit(dir);
    const d = parse(await run(dir, fakeGitHub(), json(['--test-database', 'none'])));
    expect(existsSync(join(dir, DB))).toBe(true);
    expect(fileOf(d, DB)).toBeUndefined();
    // A copy it leaves is no removal (#1629).
    expect(d.summary.find((l) => l.answer === 'Files')?.value).not.toContain('removed');
    expect(stale(d)).toEqual([expect.objectContaining({ category: 'file', blocking: false, subject: DB, message: expect.stringContaining('--test-database none'), fix: expect.objectContaining({ commands: [`git rm ${DB}`] }) })]);
  });

  it('removes an edited copy never committed only with --replace-uncommitted, the person\'s word (#1586, #1551)', async () => {
    const dir = checkout();
    await run(dir, fakeGitHub(), json(['--test-database', 'hook']));
    writeFileSync(join(dir, DB), `${read(dir, DB)}\nEdited.\n`);
    const kept = parse(await run(dir, fakeGitHub(), json(['--test-database', 'none'])));
    expect(existsSync(join(dir, DB))).toBe(true);
    expect(stale(kept)[0]!.fix).toMatchObject({ commands: [`rm ${DB}`], text: expect.stringContaining('--replace-uncommitted') });
    expect(kept.summary.find((l) => l.answer === 'Files')?.value).not.toContain('removed');
    // #1638: the dry run's summary counts the removal the flag makes, as the real run then makes it.
    const dry = parse(await run(dir, fakeGitHub(), json(['--test-database', 'none', '--replace-uncommitted', '--dry-run'])));
    expect(dry.summary.find((l) => l.answer === 'Files')?.value).toMatch(/, 1 removed \(an answer turns it off\)$/);
    expect(fileOf(dry, DB)?.status).toBe('removed');
    // A file it removes, even in a dry run that leaves it on disk, is no stale step too.
    expect(stale(dry)).toEqual([]);
    const d = parse(await run(dir, fakeGitHub(), json(['--test-database', 'none', '--replace-uncommitted'])));
    expect(d.summary.find((l) => l.answer === 'Files')?.value).toMatch(/, 1 removed \(an answer turns it off\)$/);
    // The count is the loop's: as many as `.files[]` says it removed.
    expect(d.files.filter((f) => f.status === 'removed')).toHaveLength(1);
    expect(fileOf(d, DB)?.status).toBe('removed');
    expect(existsSync(join(dir, DB))).toBe(false);
  });

  it('turns nothing off on an answer it only inferred', async () => {
    const dir = checkout();
    await run(dir, fakeGitHub(), json(['--test-database', 'hook']));
    // No flag: the inference finds no database, but the file may say what it missed.
    const d = parse(await run(dir, fakeGitHub(), json([])));
    expect(existsSync(join(dir, DB))).toBe(true);
    expect(fileOf(d, DB)).toBeUndefined();
    expect(stale(d)).toEqual([]);
  });

  it('does the same for the delegation and the telemetry caller', async () => {
    const cases: Array<[string[], string[], string[]]> = [
      [['--delegate-name', 'Ada', '--delegate-email', 'ada@example.com'], ['--no-delegation'], ['docs/qa/sign-off-delegation.md']],
      [['--consent', 'yes'], ['--consent', 'no'], ['.github/workflows/telemetry.yml']],
    ];
    for (const [on, off, paths] of cases) {
      const dir = checkout();
      await run(dir, fakeGitHub(), json(on));
      for (const p of paths) expect(existsSync(join(dir, p)), `${on.join(' ')}: ${p}`).toBe(true);
      const d = parse(await run(dir, fakeGitHub(), json(off)));
      for (const p of paths) {
        expect(fileOf(d, p)?.status, `${off.join(' ')}: ${p}`).toBe('removed');
        expect(existsSync(join(dir, p)), p).toBe(false);
      }
      expect(stale(d)).toEqual([]);
    }
  });

  // #1624's review: where the repository calls Kanon's release workflow, --no-releaser declines
  // the Releaser App only, and a release workflow or configuration of the project's own is never
  // init's (docs/init.md, "The release workflow"), so neither is removed or reported.
  const RELEASE = ['.github/workflows/release.yml', 'release-please-config.json', '.release-please-manifest.json', 'version.txt'];
  it("keeps a Kanon release caller and its configuration on --no-releaser, which only declines the Releaser", async () => {
    const dir = checkout();
    await run(dir, fakeGitHub(), json(['--releaser']));
    const before = RELEASE.map((p) => read(dir, p));
    for (const extra of [[], ['--replace-uncommitted']]) {
      const d = parse(await run(dir, fakeGitHub(), json(['--no-releaser', ...extra])));
      expect(RELEASE.map((p) => read(dir, p)), extra.join(' ')).toEqual(before);
      for (const p of RELEASE) expect(fileOf(d, p)?.status, p).not.toBe('removed');
      expect(stale(d)).toEqual([]);
    }
  });

  it("never calls the project's own release machinery stale on --no-releaser", async () => {
    const own = {
      '.github/workflows/release.yml': 'name: Release\non:\n  push:\n    branches: [main]\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./release.sh\n',
      'release-please-config.json': '{ "packages": { ".": { "release-type": "node" } } }\n',
      'version.txt': '3.1.4\n',
    };
    const dir = checkout(own);
    commit(dir);
    const d = parse(await run(dir, fakeGitHub(), json(['--no-releaser'])));
    for (const [p, t] of Object.entries(own)) expect(read(dir, p), p).toBe(t);
    expect(stale(d)).toEqual([]);
  });

  it('removes the apps-check caller when no chosen lane runs as an App', async () => {
    const dir = checkout();
    await run(dir, fakeGitHub(), json([]));
    expect(existsSync(join(dir, '.github/workflows/apps-check.yml'))).toBe(true);
    const d = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps', '--lanes', 'weekly-digest', '--no-releaser']));
    expect(fileOf(d, '.github/workflows/apps-check.yml')?.status).toBe('removed');
    expect(existsSync(join(dir, '.github/workflows/apps-check.yml'))).toBe(false);
  });
});

describe('kanon init and the waivers of choices made at install (#1607 point 14)', () => {
  const kept = GITHUB_DEFAULT_LABELS.filter((n) => ['bug', 'documentation', 'enhancement', 'question'].includes(n) && !REQ.labels.includes(n));
  const labels = `- **Waived doctor finding:** \`label.github-default\` on \`acme/widgets\` for ${kept.map((n) => `\`${n}\``).join(', ')} (${INSTALL_WAIVER_REASONS['label.github-default']})`;
  const deploy = `- **Waived doctor finding:** \`deploy.reference-undeclared\` on \`${RECORD}\` (${INSTALL_WAIVER_REASONS['deploy.reference-undeclared']})`;

  it('writes both bullets into a new record, in the format doctor reads', async () => {
    expect(kept.length).toBeGreaterThan(0);
    const dir = checkout();
    await run(dir, fakeGitHub(), json(['--keep-default-labels', '--deploy-environments', 'none']));
    const record = read(dir, RECORD);
    expect(record).toContain(`${labels}\n${deploy}\n`);
    const { waivers, errors } = readWaivers(record);
    expect(errors).toEqual([]);
    expect(waivers.map((w) => [w.id, w.subject, w.items])).toEqual([['label.github-default', 'acme/widgets', kept], ['deploy.reference-undeclared', RECORD, null]]);
  });

  it('writes none on defaults, or where the labels are deleted', async () => {
    const dir = checkout();
    await run(dir, fakeGitHub(), json([]));
    expect(read(dir, RECORD)).not.toContain('Waived doctor finding');
    const other = checkout();
    await run(other, fakeGitHub(), json(['--delete-default-labels', '--deploy-environments', 'none']));
    expect(read(other, RECORD)).not.toContain('label.github-default');
  });

  // #1624's review: a waiver added to a record that says the Overseer is `not installed` rewrites
  // the record, but the record still doesn't say `installed`, so the step stays.
  it("still raises overseer.declare where it adds a waiver to a record that says the Overseer is not installed", async () => {
    const dir = checkout();
    await run(dir, fakeGitHub(), json([]));
    writeFileSync(join(dir, RECORD), read(dir, RECORD).replace('- **Review trigger:** `labelled`\n', '- **Review trigger:** `labelled`\n- **Overseer:** `not installed`\n'));
    commit(dir);
    const d = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps', '--feature', 'full', '--deploy-environments', 'none']));
    expect(fileOf(d, RECORD)?.status).toBe('rewritten');
    expect(read(dir, RECORD)).toContain(deploy);
    expect(read(dir, RECORD)).toContain('- **Overseer:** `not installed`');
    const f = d.findings.find((x) => x.id === 'overseer.declare');
    expect(f?.message).toMatch(/says the Overseer is `not installed`/);
    // A record init gives the Overseer's bullet raises nothing.
    const fine = checkout();
    await run(fine, fakeGitHub(), json([]));
    commit(fine);
    const ok = parse(await run(fine, fakeGitHub(), ['--yes', '--json', '--no-apps', '--feature', 'full', '--deploy-environments', 'none']));
    expect(ok.findings.map((x) => x.id)).not.toContain('overseer.declare');
    // In a dry run too, where the record on disk is still without the bullet.
    const again = checkout();
    await run(again, fakeGitHub(), json([]));
    commit(again);
    const dry = parse(await run(again, fakeGitHub(), ['--yes', '--json', '--no-apps', '--feature', 'full', '--deploy-environments', 'none', '--dry-run']));
    expect(dry.findings.map((x) => x.id)).not.toContain('overseer.declare');
  });

  // #1624's review: a deploy list the person gave is no "none declared", even where the deploy
  // caller's path is the project's own workflow and init writes no list for now.
  it('writes no deploy waiver for a deploy list given where the deploy caller\'s path is taken', async () => {
    const dir = checkout({ '.github/workflows/deploy.yml': 'name: Deploy\non: workflow_dispatch\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./deploy.sh\n' });
    const d = parse(await run(dir, fakeGitHub(), json(['--deploy-environments', 'staging,production'])));
    expect(d.findings.map((x) => x.id)).toContain('deploy.caller-taken');
    expect(read(dir, RECORD)).not.toContain('deploy.reference-undeclared');
  });

  it('adds them to a record the project has, once, and never a second waiver of the same finding', async () => {
    const dir = checkout();
    await run(dir, fakeGitHub(), json([]));
    commit(dir);
    const d = parse(await run(dir, fakeGitHub(), json(['--keep-default-labels', '--deploy-environments', 'none'])));
    expect(fileOf(d, RECORD)?.status).toBe('rewritten');
    expect(read(dir, RECORD)).toContain(labels);
    expect(read(dir, RECORD)).toContain(deploy);
    // Again: nothing to add.
    const again = parse(await run(dir, fakeGitHub(), json(['--keep-default-labels', '--deploy-environments', 'none'])));
    expect(fileOf(again, RECORD)?.status).toBe('same');
    // The person's own reason stands; no second bullet is added beside it.
    const own = read(dir, RECORD).replace(INSTALL_WAIVER_REASONS['deploy.reference-undeclared'], 'this repository deploys nothing');
    expect(withChoices(own, [deploy])).toBeNull();
    // A waiver of the labels the person narrowed to other items still waives that finding.
    const narrowed = own.replace(labels, `- **Waived doctor finding:** \`label.github-default\` on \`acme/widgets\` for \`wontfix\` (ours)`);
    expect(narrowed).not.toContain(labels);
    expect(withChoices(narrowed, [labels])).toBeNull();
  });
});
