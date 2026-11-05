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
    const d = parse(await run(dir, fakeGitHub(), json(['--test-database', 'none'])));
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
    expect(stale(d)).toEqual([expect.objectContaining({ category: 'file', blocking: false, subject: DB, message: expect.stringContaining('--test-database none'), fix: expect.objectContaining({ commands: [`git rm ${DB}`] }) })]);
  });

  it('removes an edited copy never committed only with --replace-uncommitted, the person\'s word (#1586, #1551)', async () => {
    const dir = checkout();
    await run(dir, fakeGitHub(), json(['--test-database', 'hook']));
    writeFileSync(join(dir, DB), `${read(dir, DB)}\nEdited.\n`);
    const kept = parse(await run(dir, fakeGitHub(), json(['--test-database', 'none'])));
    expect(existsSync(join(dir, DB))).toBe(true);
    expect(stale(kept)[0]!.fix).toMatchObject({ commands: [`rm ${DB}`], text: expect.stringContaining('--replace-uncommitted') });
    const d = parse(await run(dir, fakeGitHub(), json(['--test-database', 'none', '--replace-uncommitted'])));
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

  it('does the same for the delegation, the telemetry caller and the release files', async () => {
    const cases: Array<[string[], string[], string[]]> = [
      [['--delegate-name', 'Ada', '--delegate-email', 'ada@example.com'], ['--no-delegation'], ['docs/qa/sign-off-delegation.md']],
      [['--consent', 'yes'], ['--consent', 'no'], ['.github/workflows/telemetry.yml']],
      [['--releaser'], ['--no-releaser'], ['.github/workflows/release.yml', 'release-please-config.json', '.release-please-manifest.json', 'version.txt']],
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
