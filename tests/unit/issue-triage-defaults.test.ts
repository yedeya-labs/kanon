import { describe, expect, it } from 'vitest';
import {
  BUCKET_MILESTONES,
  DEFAULT_MILESTONE,
  GATE_CANDIDATE_LABEL,
  PIPELINE_MILESTONE,
  PlanRefusal,
  cli,
  decide,
  plan,
  shadow,
} from '../../scripts/issue-triage-defaults.mjs';

/**
 * #164, step 1 of its migration order: `plan()`, the one module a filer asks for the exact
 * `--label` and `--milestone` arguments of one atomic `gh issue create` (`K-WORK-2`, `K-WORK-8`),
 * and the backstop's shadow of it, which logs what `plan()` would have chosen next to what the
 * filer chose and writes nothing.
 */

const reviewer = (...more: string[]) => ['follow-up', 'agent:reviewer', ...more];
const explorer = (...more: string[]) => ['bug', 'agent:explorer', 'qa:needs-triage', ...more];

describe('plan: bucket routing, pipeline work beats product work (K-WORK-4)', () => {
  it('sends pipeline-improvement work to the platform bucket at any severity', () => {
    for (const sev of ['sev:critical', 'sev:low']) {
      expect(plan(reviewer(sev, 'pipeline-improvement')).milestone).toBe(PIPELINE_MILESTONE);
    }
    expect(plan(['pipeline-improvement']).milestone).toBe(PIPELINE_MILESTONE);
  });

  it('sends everything else to the product bucket', () => {
    expect(plan(reviewer('sev:low')).milestone).toBe(DEFAULT_MILESTONE);
    expect(plan(explorer('sev:critical')).milestone).toBe(DEFAULT_MILESTONE);
    expect(plan(['enhancement']).milestone).toBe(DEFAULT_MILESTONE);
  });

  it('never writes anything but a bucket on its own (K-WORK-5)', () => {
    for (const labels of [reviewer('sev:critical'), explorer('sev:high'), ['pipeline-improvement'], []]) {
      expect(BUCKET_MILESTONES).toContain(plan(labels).milestone);
    }
  });
});

/**
 * The shadow's finding (#164, step 2). Replayed over the week's real filings, the commonest
 * disagreement was a review follow-up about a guard, a test or a doc of the pipeline, which its
 * filer put on the platform bucket with no `pipeline-improvement` label. The filer was right
 * (`K-WORK-4`: route by subject, and the platform bucket wins), and a label-only `plan()` would
 * have moved every one of them to the product bucket. So the subject is the filer's to name.
 */
describe('plan: the subject is the filer\'s judgment (K-WORK-4)', () => {
  it('sends work the filer names pipeline to the platform bucket, with no label for it', () => {
    const p = plan(reviewer('sev:low'), { subject: 'pipeline' });
    expect(p.milestone).toBe(PIPELINE_MILESTONE);
    expect(p.reason).toBe('the filer named the subject pipeline');
    expect(p.labels).not.toContain('pipeline-improvement');
  });

  it('makes no candidate of pipeline work the filer named, however severe (K-WORK-11)', () => {
    expect(plan(reviewer('sev:critical'), { subject: 'pipeline' }).gateCandidate).toBe(false);
    expect(plan(reviewer('sev:critical'), { subject: 'pipeline', explicitMilestone: DEFAULT_MILESTONE }).gateCandidate).toBe(false);
    expect(() => plan(reviewer('sev:critical', GATE_CANDIDATE_LABEL), { subject: 'pipeline' })).toThrow(PlanRefusal);
  });

  it('holds pipeline work the filer named off a roadmap milestone (K-WORK-11)', () => {
    expect(() => plan(['enhancement'], { subject: 'pipeline', explicitMilestone: 'Launch' })).toThrow(/K-WORK-11/);
  });

  it('routes product as it routes no subject', () => {
    expect(plan(reviewer('sev:high'), { subject: 'product' })).toEqual(plan(reviewer('sev:high')));
  });

  it('refuses a subject it does not know, and product beside the pipeline label', () => {
    expect(() => plan(['enhancement'], { subject: 'platform' })).toThrow(/neither product nor pipeline/);
    expect(() => plan(['pipeline-improvement'], { subject: 'product' })).toThrow(/K-WORK-4/);
  });
});

describe('plan: the gate-candidate rule (K-WORK-10)', () => {
  it('adds gate-candidate to a critical or high reviewer follow-up, which stays on its bucket', () => {
    for (const sev of ['sev:critical', 'sev:high']) {
      const p = plan(reviewer(sev));
      expect(p.gateCandidate).toBe(true);
      expect(p.labels).toContain(GATE_CANDIDATE_LABEL);
      expect(p.milestone).toBe(DEFAULT_MILESTONE);
    }
  });

  it('adds it to no medium or low follow-up: a workaround is what "not launch-gating" means', () => {
    for (const sev of ['sev:medium', 'sev:low']) {
      expect(plan(reviewer(sev)).gateCandidate).toBe(false);
      expect(plan(reviewer(sev)).labels).not.toContain(GATE_CANDIDATE_LABEL);
    }
  });

  it('adds it only to the reviewer cohort: both follow-up and agent:reviewer', () => {
    expect(plan(['follow-up', 'sev:critical']).gateCandidate).toBe(false);
    expect(plan(['agent:reviewer', 'sev:critical']).gateCandidate).toBe(false);
  });

  it('accepts a gate-candidate the filer already passed where the rule gives one, without doubling it', () => {
    const p = plan(reviewer('sev:high', GATE_CANDIDATE_LABEL));
    expect(p.labels.filter((l: string) => l === GATE_CANDIDATE_LABEL)).toHaveLength(1);
  });

  it('refuses a gate-candidate the rule does not give, rather than file a false claim', () => {
    expect(() => plan(reviewer('sev:medium', GATE_CANDIDATE_LABEL))).toThrow(PlanRefusal);
    expect(() => plan(reviewer('sev:medium', GATE_CANDIDATE_LABEL))).toThrow(/gate-candidate/);
  });
});

describe('plan: streams never become gate candidates or go on a roadmap milestone (K-WORK-11)', () => {
  it('never makes pipeline work a candidate, however severe', () => {
    expect(plan(reviewer('sev:critical', 'pipeline-improvement')).gateCandidate).toBe(false);
    expect(() => plan(reviewer('sev:critical', 'pipeline-improvement', GATE_CANDIDATE_LABEL))).toThrow(PlanRefusal);
  });

  it('never makes an Explorer bug a candidate, however severe', () => {
    expect(plan(explorer('sev:critical')).gateCandidate).toBe(false);
    expect(() => plan(explorer('sev:critical', GATE_CANDIDATE_LABEL))).toThrow(PlanRefusal);
  });

  it('refuses an explicit roadmap milestone for an Explorer bug or pipeline work', () => {
    expect(() => plan(explorer('sev:high'), { explicitMilestone: 'Launch' })).toThrow(PlanRefusal);
    expect(() => plan(explorer('sev:high'), { explicitMilestone: 'Launch' })).toThrow(/K-WORK-11/);
    expect(() => plan(['pipeline-improvement'], { explicitMilestone: 'Launch' })).toThrow(/K-WORK-11/);
  });

  it('still lets either stream take a bucket explicitly', () => {
    expect(plan(explorer('sev:low'), { explicitMilestone: PIPELINE_MILESTONE }).milestone).toBe(PIPELINE_MILESTONE);
  });
});

describe('plan: an explicit milestone transcribed from an approved brief passes through (K-WORK-5)', () => {
  it('writes the brief\'s milestone as given, a roadmap milestone included', () => {
    expect(plan(['enhancement'], { explicitMilestone: 'Launch' }).milestone).toBe('Launch');
    expect(plan(['pipeline-improvement'], { explicitMilestone: PIPELINE_MILESTONE }).milestone).toBe(PIPELINE_MILESTONE);
  });

  it('makes a placed follow-up no candidate: it is already on the roadmap', () => {
    expect(plan(reviewer('sev:critical'), { explicitMilestone: 'Launch' }).gateCandidate).toBe(false);
  });
});

describe('plan: severity stays with the filer (K-WORK-9)', () => {
  it('reads the filer\'s severity and never derives one', () => {
    expect(plan(reviewer('sev:medium')).severity).toBe('sev:medium');
    expect(plan(['enhancement']).severity).toBeNull();
    expect(plan(['enhancement']).labels).not.toContain('sev:medium');
  });

  it('refuses a reviewer follow-up with no severity, which only its filer can judge', () => {
    expect(() => plan(reviewer())).toThrow(PlanRefusal);
    expect(() => plan(reviewer())).toThrow(/K-WORK-9/);
  });

  it('refuses more than one severity rather than pick one', () => {
    expect(() => plan(reviewer('sev:low', 'sev:critical'))).toThrow(/exactly one/);
  });
});

describe('plan: one atomic gh issue create (K-WORK-2)', () => {
  it('returns every label and the milestone as the arguments of one call', () => {
    expect(plan(reviewer('sev:high')).args).toEqual([
      '--label', 'follow-up', '--label', 'agent:reviewer', '--label', 'sev:high', '--label', GATE_CANDIDATE_LABEL,
      '--milestone', DEFAULT_MILESTONE,
    ]);
  });

  it('keeps the filer\'s labels, once each, in the order given', () => {
    expect(plan(['bug', 'bug', 'enhancement']).labels).toEqual(['bug', 'enhancement']);
  });
});

describe('plan agrees with decide on a bare issue (one module, one rule)', () => {
  const cases = [reviewer('sev:critical'), reviewer('sev:low'), reviewer('sev:high', 'pipeline-improvement'), explorer('sev:high'), ['pipeline-improvement'], []];
  for (const labels of cases) {
    it(`routes [${labels.join(', ')}] as the backstop does`, () => {
      const p = plan(labels);
      const d = decide({ labels, milestone: '' });
      expect(p.milestone).toBe(d.milestone);
      expect(p.gateCandidate).toBe(d.addGateCandidate);
    });
  }
});

describe('shadow: the backstop logs what plan() would have chosen, and writes nothing', () => {
  it('compares plan() with what the filer chose', () => {
    expect(shadow({ labels: reviewer('sev:high', GATE_CANDIDATE_LABEL), milestone: DEFAULT_MILESTONE })).toMatchObject({
      planned: { milestone: DEFAULT_MILESTONE, gateCandidate: true },
      filed: { milestone: DEFAULT_MILESTONE, gateCandidate: true },
      agrees: true,
      refused: null,
    });
  });

  it('reads a filing on the platform bucket as the filer naming the subject pipeline, and compares the rest', () => {
    const s = shadow({ labels: reviewer('sev:low'), milestone: PIPELINE_MILESTONE });
    expect(s?.agrees).toBe(true);
    expect(s?.planned?.milestone).toBe(PIPELINE_MILESTONE);
    // A gate-candidate on pipeline work is still a disagreement: plan() would refuse it.
    expect(shadow({ labels: reviewer('sev:high', GATE_CANDIDATE_LABEL), milestone: PIPELINE_MILESTONE })?.refused).toMatch(/K-WORK-10/);
  });

  it('reports a disagreement: pipeline-improvement work the filer put on the product bucket', () => {
    const s = shadow({ labels: ['pipeline-improvement'], milestone: DEFAULT_MILESTONE });
    expect(s?.agrees).toBe(false);
    expect(s?.planned?.milestone).toBe(PIPELINE_MILESTONE);
  });

  it('reports a missing gate-candidate as a disagreement', () => {
    expect(shadow({ labels: reviewer('sev:critical'), milestone: DEFAULT_MILESTONE })?.agrees).toBe(false);
  });

  it('reports what plan() would have refused', () => {
    const s = shadow({ labels: reviewer(), milestone: DEFAULT_MILESTONE });
    expect(s?.agrees).toBe(false);
    expect(s?.refused).toMatch(/K-WORK-9/);
  });

  it('has nothing to compare on a bare issue, which is the backstop\'s alone', () => {
    expect(shadow({ labels: reviewer('sev:low'), milestone: '' })).toBeNull();
  });
});

describe('cli', () => {
  it('plan: prints the decision and the arguments for one gh issue create', () => {
    const r = cli(['plan', '--label', 'follow-up', '--label', 'agent:reviewer', '--label', 'sev:critical'], '');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.milestone).toBe(DEFAULT_MILESTONE);
    expect(out.args).toContain(GATE_CANDIDATE_LABEL);
    expect(out.ghArgs).toBe(`--label follow-up --label agent:reviewer --label sev:critical --label gate-candidate --milestone 'Product Backlog'`);
  });

  it('plan: passes an explicit milestone through', () => {
    const r = cli(['plan', '--label', 'enhancement', '--explicit-milestone', "Bob's launch"], '');
    expect(JSON.parse(r.out).milestone).toBe("Bob's launch");
    expect(JSON.parse(r.out).ghArgs).toBe(`--label enhancement --milestone 'Bob'\\''s launch'`);
  });

  it('plan: takes the filer\'s subject', () => {
    const r = cli(['plan', '--label', 'follow-up', '--label', 'agent:reviewer', '--label', 'sev:low', '--subject', 'pipeline'], '');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).ghArgs).toBe(`--label follow-up --label agent:reviewer --label sev:low --milestone 'Development Automation'`);
    expect(cli(['plan', '--label', 'bug', '--subject', 'platform'], '').code).toBe(1);
  });

  it('plan: a refusal exits 1, says why on stderr, and prints no arguments', () => {
    const r = cli(['plan', '--label', 'follow-up', '--label', 'agent:reviewer'], '');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/K-WORK-9/);
    expect(JSON.parse(r.out)).toEqual({ refused: expect.stringMatching(/K-WORK-9/) });
  });

  it('plan: an unknown flag is a usage error, never a silent default', () => {
    expect(cli(['plan', '--milestone', 'Launch'], '').code).toBe(2);
    expect(cli(['plan', '--label'], '').code).toBe(2);
  });

  it('backstop: keeps its output, adds the shadow, and logs it on stderr', () => {
    const issue = { labels: [{ name: 'follow-up' }, { name: 'agent:reviewer' }, { name: 'sev:critical' }], milestone: { title: DEFAULT_MILESTONE } };
    const r = cli([], JSON.stringify(issue));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.milestone).toBeNull();
    expect(out.shadow.agrees).toBe(false);
    expect(r.err).toMatch(/^shadow \(writes nothing\): plan\(\) would file on "Product Backlog" with gate-candidate; the filer chose "Product Backlog" — differs$/m);
  });

  it('backstop: logs no shadow for a bare issue', () => {
    const r = cli([], JSON.stringify({ labels: [{ name: 'bug' }], milestone: null }));
    expect(JSON.parse(r.out).milestone).toBe(DEFAULT_MILESTONE);
    expect(JSON.parse(r.out).shadow).toBeNull();
    expect(r.err).toBe('');
  });
});
