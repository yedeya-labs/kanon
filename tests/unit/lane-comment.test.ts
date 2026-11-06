import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { COMMENT_MAX, COMMENT_PATH, postComment, readComment } from '../../scripts/lane-comment.mjs';

// kanon#1591: an installation token lives an hour, and the implement lane's agent may run three, so
// a comment it posted at the end of a long run was refused. The push job posts it instead, with the
// token it mints after the run, from the file the agent writes.
describe('the push job posts the agent\'s closing comment (#1591)', () => {
  it('posts the file as it is on the lane\'s issue, and refuses an empty, oversized or issueless one', async () => {
    expect(readComment('Built it.\n', '12')).toEqual({ body: 'Built it.\n', issue: 12 });
    expect(readComment('  \n', '12')).toEqual({ problem: 'the closing comment is empty' });
    expect(readComment('x'.repeat(COMMENT_MAX + 1), '12')).toHaveProperty('problem');
    for (const n of ['', '0', 'x', '-1']) expect(readComment('ok', n), n).toHaveProperty('problem');
    const calls: unknown[] = [];
    const api = async (...a: unknown[]) => { calls.push(a); return { status: 201, headers: {}, json: { html_url: 'https://example.invalid/issues/12#c' } }; };
    expect(await postComment({ api, repo: 'acme/widgets', body: 'Built it.', issue: 12 })).toEqual({ url: 'https://example.invalid/issues/12#c' });
    expect(calls).toEqual([['POST', 'repos/acme/widgets/issues/12/comments', { body: 'Built it.' }]]);
    const refused = async () => ({ status: 403, headers: {}, json: { message: 'Resource not accessible by integration' } });
    expect(await postComment({ api: refused, repo: 'acme/widgets', body: 'x', issue: 12 })).toEqual({ problem: 'GitHub answered 403 posting the closing comment on #12: Resource not accessible by integration' });
  });

  it('is wired: the implement lane asks for it, the push job posts it with its own token, and the prompt says why', () => {
    const lane = parse(readFileSync('.github/workflows/agent-lane.yml', 'utf8'));
    const steps = lane.jobs.push.steps as Array<{ id?: string; name?: string; if?: string; env: Record<string, string> }>;
    const post = steps.find((s) => s.name === "Post the agent's closing comment")!;
    expect(post.env.GH_TOKEN).toBe('${{ steps.push-token.outputs.token }}');
    expect(post.env.ISSUE).toBe('${{ inputs.issue-number }}');
    expect(post.if).toBe("${{ !cancelled() && inputs.closing-comment && needs.run.outputs.comment == 'true' }}");
    expect(steps.find((s) => s.id === 'push')!.if).toBe("needs.run.outputs.commits == 'true'");
    expect(steps.findIndex((s) => s.id === 'push')).toBeLessThan(steps.indexOf(post));
    const implement = parse(readFileSync('.github/workflows/agent-implement.yml', 'utf8'));
    expect(implement.jobs.implement.with['closing-comment']).toBe(true);
    const prompt = String(implement.jobs.implement.with.prompt);
    expect(prompt).toContain(`WRITE THE COMMENT TO\n\`${COMMENT_PATH}\`, last, and do not post it yourself`);
    expect(prompt).toMatch(/expires about an hour in, so any `gh` call you make after that, a comment\s+included, is refused as `Bad credentials`/);
    expect(prompt).not.toMatch(/post your progress/);
    // kanon#1592: crash recovery is told the run committed, and whether the push job moved anything.
    const recovery = implement.jobs['crash-recovery'].steps.find((st: { env?: Record<string, string> }) => st.env?.COMMITS !== undefined);
    expect(recovery.env.COMMITS).toBe('${{ needs.implement.outputs.commits }}');
    expect(recovery.env.PUSH_HEADS).toBe('${{ needs.implement.outputs.push-heads }}');
    expect(lane.on.workflow_call.outputs.commits.value).toBe('${{ jobs.run.outputs.commits }}');
  });
});
