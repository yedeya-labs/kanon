/**
 * GitHub's answer to `GET repos/<repo>/rules/branches/<branch>` (#1262), as `gh api --paginate
 * --slurp` prints it (one array per page): every rule of each `active` branch ruleset that applies
 * to the branch, each with its `ruleset_id`, `ruleset_source_type` and `ruleset_source`. A ruleset
 * with no rules adds nothing, as on GitHub.
 *
 * The stubs' rulesets name their refs as Kanon's own do, `~DEFAULT_BRANCH`, `~ALL` or
 * `refs/heads/<branch>`, so only those are matched here, in `include` and `exclude`. GitHub's own
 * fnmatch patterns are what `ruleset-bypass.test.ts` stubs GitHub's answer for directly.
 */
type Ruleset = {
  id: number;
  target?: string;
  enforcement?: string;
  source_type?: string;
  source?: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  rules?: Array<Record<string, unknown>>;
};

export const branchRules = (rulesets: unknown[], repo: string, branch = 'main', defaultBranch = 'main') => {
  const ref = `refs/heads/${branch}`;
  const hits = (patterns: string[] | undefined) => (patterns ?? []).some((p) => p === '~ALL' || (p === '~DEFAULT_BRANCH' && branch === defaultBranch) || p === ref);
  const applying = (rulesets as Ruleset[]).filter((r) => r?.target === 'branch' && r.enforcement === 'active' && hits(r.conditions?.ref_name?.include) && !hits(r.conditions?.ref_name?.exclude));
  return [applying.flatMap((r) => (r.rules ?? []).map((rule) => ({ ...rule, ruleset_source_type: r.source_type ?? 'Repository', ruleset_source: r.source ?? repo, ruleset_id: r.id })))];
};
