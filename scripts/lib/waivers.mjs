// The adoption record's waivers of doctor's findings, and the readers that `kanon doctor` and
// the status core share (kanon#1345). They moved out of `cli/doctor.mjs`, which still imports
// and re-exports them, so that the hosted status server, which reads a lane caller's waivers
// through `scripts/lib/lane-caller.mjs`, links this module alone and not doctor and init with it.
// The server's every linked module is the Owner's (`docs/qa/escalation-paths.md`), so this one is
// kept small: doctor's catalogue of finding ids, the waiver reader, and nothing that reads a repo.
// No imports.

/** The adoption record (`K-LAYOUT-10`), where an id-token holder is accepted. */
export const ADOPTION_RECORD = 'docs/qa/adoption.md';

/** The bullet's bold label that accepts an id-token holder, under the adoption record's `## Choices` (`K-LAYOUT-10`). `kanon init` writes the bullet (`holderBullet`), and doctor reads it. */
export const HOLDER_LABEL = 'Accepted id-token holder';

/** The bullet's bold label that waives one finding, under `## Choices`. */
export const WAIVER_LABEL = 'Waived doctor finding';

/**
 * The finding ids no waiver waives, each with why (docs/doctor.md, "Waiving a finding"). A
 * waiver of one is malformed. The record's own findings can't be waived, or a waiver could hide
 * a broken or stale waiver; an id-token holder has its own form of waiver, the acceptance above;
 * and the rest protect a rule that keeps review independent or keeps secrets in their place.
 * @type {Record<string, string>}
 */
export const UNWAIVABLE = {
  'declaration.malformed': 'it is about the adoption record itself, so a waiver could hide a malformed waiver',
  'waiver.stale': 'it is about the adoption record itself, so a waiver could keep a stale waiver alive',
  'id-token.stale-acceptance': 'it is about the adoption record itself; remove the stale acceptance instead',
  'id-token.unaccepted': `a job is accepted as an id-token holder by its own bullet, \`- **${HOLDER_LABEL}:** \`<workflow>.yml\` job \`<job>\` (<why>)\``,
  'register.shared-slug': 'one App authoring and approving its own work defeats independent review (K-LAYOUT-6)',
  'register.other-app-slug': 'an Other App row naming an agent\'s App would re-label that App as one that isn\'t an agent (K-LAYOUT-6)',
  'caller.secrets-inherited': 'it hands the lane every secret of the repository (plan 0001 decision 7)',
  'ruleset.missing': 'without it nothing enforces review on the default branch (K-ADOPT-1 step 8)',
  'ruleset.rule-missing': 'without it nothing enforces that rule of review on the default branch (K-ADOPT-1 step 8)',
  'ruleset.bypass-extra': 'it lets an actor other than the Releaser merge around review (K-MERGE-8)',
  'ruleset.approval-off': 'the adoption record says bootstrap ended, and bootstrap never returns: a ruleset that stopped requiring approval is an incident to fix (K-ADOPT-6)',
  'upstream.unsent': 'it is about the adoption record itself, which says findings are sent when nothing sends them, and lane-check fails it whatever a waiver says',
  'deploy.declaration-moved': 'it is about the adoption record itself: the reconciler and lane-check read the reference deploy from `## Deploy` alone, and fail on bullets left under `## Choices` whatever a waiver says (plan 0010 D2)',
  'deploy.declaration': 'it protects production: the lane, `kanon init` and the gate read the chain from it, and the gate refuses a record it can\'t read (plan 0010 §12)',
  'deploy.caller-mismatch': 'it protects production: the gate refuses a caller that differs from the declaration, so no environment deploys until `kanon init` writes it again (plan 0010 §12)',
  'deploy.environment-missing': 'it protects production: a declared environment that doesn\'t exist has no protection rule and no deployment policy, and a job naming it creates it with none (plan 0010 §12)',
  'deploy.reviewers-missing': 'it protects production: with no required reviewer, nothing stands between a release and production but the lane\'s own code (plan 0010 §12)',
  'deploy.subject-custom': 'it protects production: a subject without the environment lets a job outside it assume its role (plan 0010 §5, §12)',
};

/**
 * The finding ids whose findings list items, each with what an item is (#406). A later release
 * can add an item to such a finding, a permission an App needs or a secret a lane takes, so a
 * waiver of one names the items it waives after `for`, and doctor still reports any other. Several
 * bullets may waive items of one finding, each with its reason, but no item twice. A waiver of one
 * that names no items is malformed (the Owner, 2026-10-07), its fix the bullet built from the
 * items doctor reports today.
 * @type {Record<string, string>}
 */
export const ITEMIZED = {
  'register.missing-row': 'a role whose row is missing',
  'register.split-slug': 'an App whose roles name more than one slug',
  'app.permission-missing': 'a permission',
  'app.permission-extra': 'a permission',
  'secret.missing': 'a secret',
  'secret.stale': 'a secret',
  'declaration.section-missing': 'a heading',
  'hook.input-missing': 'an input',
  'caller.secret-missing': 'a secret',
  'caller.secret-stale': 'a secret',
  'caller.input-stale': 'an input',
  'caller.grant-missing': 'a permission',
  'caller.workflow-run-missing': 'a workflow',
  'apps-check.secret-missing': 'a secret',
  'apps-check.secret-stale': 'a secret',
  'label.missing': 'a label',
  'label.github-default': 'a label',
  'qa-store.unmapped': 'a secret',
  'qa-store.variables': 'a variable',
};

/**
 * Every finding `doctor` can report, by its stable id: its category, and whether it blocks (sets
 * exit code 1). docs/doctor.md lists the same ids; tests/unit/kanon-doctor.test.ts holds the two
 * to each other.
 * @type {Record<string, { category: string, blocking: boolean }>}
 */
export const FINDINGS = {
  'pin.mixed': { category: 'pin', blocking: true },
  'pin.candidate': { category: 'pin', blocking: false },
  'pin.dependabot-unreached': { category: 'pin', blocking: true },
  'pin.dependabot-ungrouped': { category: 'pin', blocking: true },
  'plugin.version-mismatch': { category: 'pin', blocking: false },
  'notify.hook-pin-behind': { category: 'pin', blocking: false },
  'notify.hook-pin-ahead': { category: 'pin', blocking: true },
  'register.missing-row': { category: 'app', blocking: true },
  'register.split-slug': { category: 'app', blocking: true },
  'register.shared-slug': { category: 'app', blocking: true },
  'register.other-app-slug': { category: 'app', blocking: true },
  'app.permission-missing': { category: 'app', blocking: true },
  'app.permission-extra': { category: 'app', blocking: false },
  'app.unused': { category: 'app', blocking: false },
  'secret.missing': { category: 'secret', blocking: true },
  'secret.stale': { category: 'secret', blocking: false },
  'claude.token-age': { category: 'secret', blocking: true },
  'claude.unreachable-runs': { category: 'secret', blocking: false },
  'telemetry.register-tracked': { category: 'secret', blocking: true },
  'declaration.missing': { category: 'declaration', blocking: true },
  'declaration.section-missing': { category: 'declaration', blocking: true },
  'declaration.malformed': { category: 'declaration', blocking: true },
  'upstream.unsent': { category: 'declaration', blocking: true },
  'deploy.declaration-moved': { category: 'declaration', blocking: true },
  'deploy.declaration': { category: 'declaration', blocking: true },
  'deploy.reference-undeclared': { category: 'declaration', blocking: false },
  'deploy.hook-missing': { category: 'declaration', blocking: true },
  'hook.missing': { category: 'declaration', blocking: true },
  'hook.input-missing': { category: 'declaration', blocking: true },
  'workflow.missing': { category: 'declaration', blocking: true },
  'lead.template-missing': { category: 'declaration', blocking: false },
  'lead.template-stale': { category: 'declaration', blocking: false },
  'waiver.stale': { category: 'declaration', blocking: false },
  'caller.lane-removed': { category: 'caller', blocking: true },
  'caller.misplaced': { category: 'caller', blocking: true },
  'caller.secrets-inherited': { category: 'caller', blocking: true },
  'caller.secret-missing': { category: 'caller', blocking: true },
  'caller.secret-stale': { category: 'caller', blocking: true },
  'caller.input-stale': { category: 'caller', blocking: true },
  'caller.grant-missing': { category: 'caller', blocking: true },
  'caller.name': { category: 'caller', blocking: true },
  'caller.run-name': { category: 'caller', blocking: true },
  'caller.job-id': { category: 'caller', blocking: true },
  'caller.claude-both': { category: 'caller', blocking: true },
  'caller.claude-none': { category: 'caller', blocking: true },
  'caller.workflow-run-missing': { category: 'caller', blocking: false },
  'claude.mixed': { category: 'caller', blocking: false },
  'apps-check.secret-missing': { category: 'caller', blocking: true },
  'apps-check.secret-stale': { category: 'caller', blocking: true },
  'telemetry.refused': { category: 'caller', blocking: false },
  'telemetry.not-run': { category: 'caller', blocking: false },
  'telemetry.unpublished': { category: 'caller', blocking: false },
  'telemetry.legacy-inputs': { category: 'caller', blocking: true },
  'lane.turn-cap': { category: 'caller', blocking: false },
  'qa-store.unmapped': { category: 'caller', blocking: false },
  'qa-store.variables': { category: 'secret', blocking: false },
  'notify.kind-unset': { category: 'secret', blocking: false },
  'notify.none': { category: 'declaration', blocking: false },
  'notify.hook-malformed': { category: 'declaration', blocking: true },
  'notify.hook-version-old': { category: 'declaration', blocking: false },
  'notify.hook-unpinned': { category: 'declaration', blocking: true },
  'notify.hook-unreviewed': { category: 'declaration', blocking: true },
  'notify.legacy-secret': { category: 'caller', blocking: true },
  'notify.failing': { category: 'caller', blocking: false },
  'deploy.caller-mismatch': { category: 'caller', blocking: true },
  'deploy.releaser-missing': { category: 'caller', blocking: true },
  'deploy.ci-push-missing': { category: 'caller', blocking: true },
  'label.missing': { category: 'label', blocking: false },
  'label.github-default': { category: 'label', blocking: false },
  'ruleset.missing': { category: 'ruleset', blocking: true },
  'ruleset.unreadable': { category: 'ruleset', blocking: true },
  'ruleset.rule-missing': { category: 'ruleset', blocking: true },
  'ruleset.check-unreported': { category: 'ruleset', blocking: true },
  'ruleset.releaser-bypass-missing': { category: 'ruleset', blocking: true },
  'ruleset.bypass-extra': { category: 'ruleset', blocking: true },
  'ruleset.bootstrap-can-end': { category: 'ruleset', blocking: true },
  'ruleset.approval-off': { category: 'ruleset', blocking: true },
  // The deploy lane's platform state (plan 0010 §12). A fallback marker turns some blocks into
  // notes and one note into a block: `find`'s `warnOnly` and `escalate`.
  'deploy.environment-missing': { category: 'deploy', blocking: true },
  'deploy.reviewers-missing': { category: 'deploy', blocking: true },
  'deploy.branch-policy': { category: 'deploy', blocking: true },
  'deploy.self-review': { category: 'deploy', blocking: false },
  'deploy.admin-bypass': { category: 'deploy', blocking: false },
  'deploy.subject-custom': { category: 'deploy', blocking: true },
  'deploy.trust-unproven': { category: 'deploy', blocking: true },
  'deploy.artifact-retention': { category: 'deploy', blocking: false },
  'deploy.secret-repository': { category: 'deploy', blocking: false },
  'deploy.secret-organization': { category: 'deploy', blocking: false },
  'deploy.tag-ruleset': { category: 'deploy', blocking: false },
  'id-token.unaccepted': { category: 'id-token', blocking: true },
  'id-token.stale-acceptance': { category: 'id-token', blocking: false },
};

/** The line numbers (0-based) inside fenced code blocks. @param {string[]} lines */
export const fenced = (lines) => {
  /** @type {Set<number>} */
  const set = new Set();
  let open = false;
  lines.forEach((l, i) => {
    if (/^[ \t]*(```|~~~)/.test(l)) {
      set.add(i);
      open = !open;
    } else if (open) set.add(i);
  });
  return set;
};

/**
 * The waivers the adoption record declares under `## Choices`, one bullet each:
 * `- **Waived doctor finding:** \`caller.misplaced\` on \`.github/workflows/review.yml\` (why)`.
 * Each names one finding id, one subject exactly as doctor reports it, and the reason; for a
 * finding that lists items (`ITEMIZED`), it may name the items it waives, each a code span after
 * `for`, separated by commas (`items`, null when it names none). A bullet in another shape,
 * outside `## Choices`, with no reason, naming an id doctor doesn't report or one it doesn't
 * waive (`UNWAIVABLE`), naming items of a finding that lists none, waiving a finding that lists
 * none twice, or naming an item another bullet of the same finding names, is returned as an error
 * naming its line. A bullet of an `ITEMIZED` finding that names no items is returned as read:
 * `diagnose` reports it malformed, with the bullet to write from the items it finds.
 * @param {string | null} text
 * @returns {{ waivers: Array<{ id: string, subject: string, items: string[] | null, reason: string, line: number }>, errors: string[] }}
 */
export const readWaivers = (text) => {
  /** @type {Array<{ id: string, subject: string, items: string[] | null, reason: string, line: number }>} */
  const waivers = [];
  /** @type {string[]} */
  const errors = [];
  if (!text) return { waivers, errors };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const inFence = fenced(lines);
  const mention = new RegExp(`^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)?\\*\\*${WAIVER_LABEL}:\\*\\*`, 'i');
  const entry = new RegExp(`^[-*] \\*\\*${WAIVER_LABEL}:\\*\\* \`([^\`\\s]+)\` on \`([^\`]*\\S[^\`]*)\`(?: for (\`[^\`]*\\S[^\`]*\`(?:, \`[^\`]*\\S[^\`]*\`)*))? \\((.*\\S.*)\\)\\s*$`);
  let section = '';
  lines.forEach((line, i) => {
    if (inFence.has(i)) return;
    if (/^#{1,6} /.test(line)) section = line.trimEnd();
    if (!mention.test(line)) return;
    const m = entry.exec(line);
    const where = `${ADOPTION_RECORD}:${i + 1}`;
    if (!m) return errors.push(`${where} is not \`- **${WAIVER_LABEL}:** \`<finding id>\` on \`<subject>\` (<why the finding stands>)\`, with \`for \`<item>\`, \`<item>\`\` before the parentheses for a finding that lists items`);
    if (section !== '## Choices') return errors.push(`${where} waives a finding outside \`## Choices\``);
    const [id, subject, reason] = [/** @type {string} */ (m[1]), /** @type {string} */ (m[2]), /** @type {string} */ (m[4]).trim()];
    const items = m[3] === undefined ? null : [...new Set([...m[3].matchAll(/`([^`]+)`/g)].map((x) => /** @type {string} */ (x[1])))];
    if (!FINDINGS[id]) return errors.push(`${where} waives \`${id}\`, which is no finding doctor reports`);
    if (UNWAIVABLE[id]) return errors.push(`${where} waives \`${id}\`, which can't be waived: ${UNWAIVABLE[id]}`);
    if (items && !ITEMIZED[id]) return errors.push(`${where} names items after \`for\`, but \`${id}\` lists none: waive it on its subject alone`);
    const same = waivers.filter((w) => w.id === id && w.subject === subject);
    if (!ITEMIZED[id] && same.length) return errors.push(`${where} waives \`${id}\` on \`${subject}\` a second time`);
    for (const w of same) {
      const twice = items && w.items ? items.filter((x) => w.items?.includes(x)) : [];
      if (twice.length) return errors.push(`${where} waives ${twice.map((x) => `\`${x}\``).join(', ')} of \`${id}\` on \`${subject}\`, which ${ADOPTION_RECORD}:${w.line} waives already`);
    }
    waivers.push({ id, subject, items, reason, line: i + 1 });
  });
  return { waivers, errors };
};

/** A call of one of Kanon's reusable workflows: its file name without `.yml`, and its ref. @param {unknown} uses */
export const kanonCall = (uses) => {
  const m = typeof uses === 'string' ? /^yedeya-labs\/kanon\/\.github\/workflows\/([A-Za-z0-9_.-]+)\.ya?ml@(\S+)$/.exec(uses.trim()) : null;
  return m ? { workflow: /** @type {string} */ (m[1]), ref: /** @type {string} */ (m[2]) } : null;
};
