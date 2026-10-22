import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `K-WORK-7`: every search that counts issues says `is:issue` (kanon#1242). GitHub's issue search
 * returns pull requests too, so an unscoped count of "issues" counts both, and a milestone read
 * that way reads high (the reference adopter's read 44 for 38 issues).
 *
 * WHAT SENDS AN UNSCOPED SEARCH, measured with `GH_DEBUG=api` on gh 2.x (2026-10-21):
 *   - the REST endpoint `search/issues`, and GraphQL's `search(type: ISSUE)`, which both return
 *     issues and pull requests alike. Their query must say `is:issue` or `is:pr` (or `type:`).
 *   - `gh search issues` appends `type:issue` itself, unless it is given `--include-prs`.
 *   - `gh issue list --search` appends `type:issue`, and `gh pr list --search` `type:pr`, so
 *     neither can count the other kind, and this test doesn't read them.
 *
 * HOW A QUERY IS FOUND. A line that sends a raw search and names a qualifier must be scoped on
 * that line. A file that sends one through a wrapper (the query a parameter) holds every query
 * literal in it, a string or template that starts with a search qualifier, to the scope; a
 * fragment (`const t = \`milestone:"…"\``) passes when every literal that interpolates it is
 * scoped. A search that counts both kinds on purpose says so, `K-WORK-7: both kinds,
 * deliberately`, in a comment at most three lines above it. A query built in one file and sent
 * by a wrapper in another isn't followed: none is, today.
 */

const SCOPE = /\b(?:is|type):(?:issue|pr|pull-request)\b/;
const QUALIFIER = /(?:^|[\s"'`(=])-?(?:is|in|label|milestone|created|closed|merged|linked|repo|state|author|type|no):\S/;
const STARTS_AS_QUERY = /^-?(?:is|in|label|milestone|created|closed|merged|linked|repo|state|author|type|no):\S/;
const RAW = /search\/issues|\bsearch\s*\([^)]*\btype:\s*ISSUE\b/;
const GH_SEARCH_ISSUES = /\bgh search issues\b|'search',\s*'issues'/;
const WAIVER = 'K-WORK-7: both kinds, deliberately';
/** A query passed through whole, `${q}`, not a value after a qualifier (`repo:${repo}`). */
const PASSED_THROUGH = /(?<![:\w"])\$\{\w+\}/;
const LITERAL = /`(?:[^`\\$]|\\.|\$(?!\{)|\$\{[^}]*\})*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;
const COMMENT = /^\s*(?:\/\/|\*|\/\*|#)/;

type Site = { at: string; kind: 'raw' | 'gh' };

/** Every problem with one file's searches, and the searches it found. */
const searchScope = (file: string, text: string): { problems: string[]; sites: Site[] } => {
  const lines = text.split('\n');
  const problems: string[] = [];
  const sites: Site[] = [];
  const waived = (i: number) => lines.slice(Math.max(0, i - 3), i).some((l) => l.includes(WAIVER));
  const code = /\.(?:m?js|ts)$/.test(file);
  let wrapper = false;
  lines.forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    if (code && COMMENT.test(line)) return;
    if (RAW.test(line)) {
      sites.push({ at, kind: 'raw' });
      if (SCOPE.test(line) || waived(i)) { /* scoped */ }
      else if (code && (PASSED_THROUGH.test(line) || !QUALIFIER.test(line))) wrapper = true;
      else problems.push(`${at} sends a search that counts pull requests with issues: say is:issue or is:pr (K-WORK-7)`);
    }
    if (GH_SEARCH_ISSUES.test(line)) {
      sites.push({ at, kind: 'gh' });
      if (/--include-prs/.test(line) && !SCOPE.test(line) && !waived(i)) problems.push(`${at} runs gh search issues with --include-prs: say is:issue or is:pr (K-WORK-7)`);
    }
  });
  if (!code || !wrapper) return { problems, sites };
  // A wrapper sends a query it is given: every query literal in the file is held to the scope.
  const literals: Array<{ i: number; body: string; name?: string }> = [];
  const all: string[] = [];
  lines.forEach((line, i) => {
    if (COMMENT.test(line)) return;
    for (const m of line.matchAll(LITERAL)) {
      const body = m[0].slice(1, -1).trim();
      all.push(body);
      if (!STARTS_AS_QUERY.test(body)) continue;
      const name = new RegExp(`(?:const|let)\\s+(\\w+)\\s*=\\s*${m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(line)?.[1];
      literals.push({ i, body, ...(name ? { name } : {}) });
    }
  });
  for (const l of literals) {
    if (SCOPE.test(l.body) || waived(l.i)) continue;
    const users = l.name ? all.filter((b) => b.includes(`\${${l.name}}`)) : [];
    if (users.length && users.every((b) => SCOPE.test(b))) continue;
    problems.push(`${file}:${l.i + 1} builds the search \`${l.body}\`, which counts pull requests with issues: say is:issue or is:pr (K-WORK-7)`);
  }
  return { problems, sites };
};

/** The files that send a search: Kanon's scripts, CLI, actions, workflows (the lanes' prompts among them), skills and playbooks. */
const FILES = execFileSync('git', ['ls-files', 'scripts', 'cli', 'actions', '.github', 'skills', 'docs/qa'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(?:mjs|js|ts|ya?ml|sh|md)$/.test(f));

describe('every issue search Kanon sends says is:issue or is:pr (K-WORK-7, kanon#1242)', () => {
  const results = FILES.map((f) => ({ file: f, ...searchScope(f, readFileSync(f, 'utf8')) }));
  const sites = results.flatMap((r) => r.sites);

  it("finds Kanon's searches, so the check below is not vacuous", () => {
    const files = new Set(sites.filter((s) => s.kind === 'raw').map((s) => s.at.split(':')[0]));
    for (const f of ['scripts/weekly-digest.mjs', 'scripts/project-digest.mjs', 'scripts/promote.mjs', 'scripts/actions-minutes.mjs', 'scripts/capability-interlock.mjs', 'scripts/telemetry/kanon-health.mjs', '.github/workflows/overseer-agent-job.yml']) {
      expect(files, f).toContain(f);
    }
    expect(sites.filter((s) => s.kind === 'gh').map((s) => s.at.split(':')[0])).toContain('.github/workflows/overseer-agent-job.yml');
  });

  it('holds every one of them to the scope', () => {
    expect(results.flatMap((r) => r.problems)).toEqual([]);
  });
});

describe('the scope check fails each unscoped shape', () => {
  const js = (body: string) => searchScope('x.mjs', body).problems;
  it('a raw search whose query is on its line', () => {
    expect(js("api(`search/issues?q=${encodeURIComponent(`repo:${r} label:bug`)}`);")).toHaveLength(1);
    expect(js("api(`search/issues?q=${encodeURIComponent(`repo:${r} is:issue label:bug`)}`);")).toEqual([]);
  });
  it('a wrapper given an unscoped query, and a fragment an unscoped query interpolates', () => {
    const wrapper = 'const count = (q) => api(`/search/issues?q=${encodeURIComponent(`repo:${repo} ${q}`)}`);\n';
    expect(js(`${wrapper}count(\`label:bug\`);`)).toHaveLength(1);
    expect(js(`${wrapper}count(\`is:issue label:bug\`);`)).toEqual([]);
    expect(js(`${wrapper}const t = \`milestone:"x"\`;\ncount(\`is:issue \${t}\`);`)).toEqual([]);
    expect(js(`${wrapper}const t = \`milestone:"x"\`;\ncount(\`\${t}\`);\ncount(\`is:issue \${t}\`);`)).toHaveLength(1);
  });
  it('a GraphQL search over issues and pull requests, and its query', () => {
    const graphql = 'const Q = `query($q: String!) { search(type: ISSUE, first: 1, query: $q) { issueCount } }`;\n';
    expect(js(`${graphql}gh(['-f', \`q=\${x}\`]);\nconst q = (r) => \`repo:\${r} label:bug\`;`)).toHaveLength(1);
    expect(js(`${graphql}const q = (r) => \`repo:\${r} is:issue label:bug\`;`)).toEqual([]);
  });
  it('gh search issues with --include-prs', () => {
    expect(searchScope('w.yml', 'run: gh search issues "label:bug" --include-prs').problems).toHaveLength(1);
    expect(searchScope('w.yml', 'run: gh search issues "label:bug"').problems).toEqual([]);
  });
  it('a prompt that sends a raw search', () => {
    expect(searchScope('w.yml', "  `gh api -X GET search/issues -f q='repo:o/r label:bug'`").problems).toHaveLength(1);
    expect(searchScope('w.yml', "  `gh api -X GET search/issues -f q='repo:o/r is:issue label:bug'`").problems).toEqual([]);
  });
  it('passes a search that counts both kinds on purpose, and says so', () => {
    const wrapper = 'const count = (q) => api(`/search/issues?q=${q}`);\n';
    expect(js(`${wrapper}// ${WAIVER}: compared with a REST total.\ncount(\`milestone:"x"\`);`)).toEqual([]);
    expect(js(`${wrapper}count(\`milestone:"x"\`);`)).toHaveLength(1);
  });
});
