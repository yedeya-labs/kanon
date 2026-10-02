import { describe, expect, it } from 'vitest';
import {
  CONFLICT_FIELDS, CONFLICT_JSON, CONFLICT_SHORT, CONFLICT_WHY, ConflictFieldsUnread,
  blocksChurn, conflictState,
} from '../../scripts/conflict-state.mjs';

/**
 * RA-1722 — a conflicting PR dispatches no `pull_request` events, so every lever the
 * reconciler owns is a label churn that raises an event nothing receives.
 *
 * Measured on PR RA-1708: the documented remedy applied 25 times over 36 hours, zero
 * workflow runs. Nothing in the pipeline read mergeability, so three lanes each
 * described a hard-stopped PR as one whose review was merely late.
 *
 * The failure mode to defend against here is NOT "said conflicting when it was not" —
 * that costs a suppressed churn the next tick retries. It is answering "clear" for a
 * reason that has nothing to do with the PR: a field nobody asked for, or a value
 * GitHub has not computed yet. Both would silently restore the pre-RA-1722 behaviour on
 * every PR at once, which is why `unread` throws rather than returning.
 */
describe('what a PR object says about whether a churn can reach it', () => {
  it.each([
    // GraphQL, as `gh pr view --json mergeable,mergeStateStatus` returns it
    ['conflicting', { mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' }],
    ['clear', { mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' }],
    ['computing', { mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN' }],
    // BLOCKED is a ruleset state, not a git one: the merge ref exists, so events flow
    // and this lane has nothing to say about it.
    ['clear', { mergeStateStatus: 'BLOCKED', mergeable: 'MERGEABLE' }],
    ['clear', { mergeStateStatus: 'BEHIND', mergeable: 'MERGEABLE' }],
    // REST, as `/repos/{repo}/pulls/{n}` spells it — lowercase, and a boolean
    ['conflicting', { mergeable: false, mergeable_state: 'dirty' }],
    ['clear', { mergeable: true, mergeable_state: 'clean' }],
    ['computing', { mergeable: null, mergeable_state: 'unknown' }],
    // One field alone still answers
    ['conflicting', { mergeStateStatus: 'DIRTY' }],
    ['clear', { mergeable: 'MERGEABLE' }],
  ])('reads %s from %j', (expected, pr) => {
    expect(conflictState(pr)).toBe(expected);
  });

  it('believes a positive conflict over a stale clear', () => {
    // The two fields come from one computation, so a disagreement means one is stale
    // rather than that the truth is in between. Of the two directions, believing the
    // conflict costs a churn the next hourly tick retries; disbelieving it costs the
    // 25 no-op churns this module exists to stop.
    expect(conflictState({ mergeStateStatus: 'DIRTY', mergeable: 'MERGEABLE' })).toBe('conflicting');
    expect(conflictState({ mergeStateStatus: 'CLEAN', mergeable: 'CONFLICTING' })).toBe('conflicting');
  });

  it('reads an unknown paired with a definite answer as that answer', () => {
    expect(conflictState({ mergeStateStatus: 'UNKNOWN', mergeable: 'MERGEABLE' })).toBe('clear');
    expect(conflictState({ mergeStateStatus: 'CLEAN', mergeable: 'UNKNOWN' })).toBe('clear');
  });

  it('THROWS when the caller never asked, and does not answer "clear"', () => {
    // The mutation this pins: return `'clear'` here instead of throwing and every
    // assertion in this file still passes except this one, while the detector goes
    // inert in all four consumers the moment anyone trims a `--json` list.
    expect(() => conflictState({ number: 7, state: 'OPEN' })).toThrow(ConflictFieldsUnread);
    expect(() => conflictState({})).toThrow(ConflictFieldsUnread);
    expect(() => conflictState(null as never)).toThrow(ConflictFieldsUnread);
  });

  it('names the fix in the message, because the reader is whoever trimmed the read', () => {
    expect(() => conflictState({})).toThrow(/CONFLICT_JSON/);
    expect(() => conflictState({})).toThrow(/RA-1722/);
  });

  it('distinguishes a present-but-null field from an absent one', () => {
    // `mergeable: null` is REST saying "still computing"; no `mergeable` key at all is
    // the caller not asking. Conflating them is the whole defect above.
    expect(conflictState({ mergeable: null })).toBe('computing');
    expect(() => conflictState({ headRefOid: 'abc' })).toThrow(ConflictFieldsUnread);
  });
});

describe('what the lanes act on', () => {
  it('blocks a churn only on a positive conflict', () => {
    expect(blocksChurn('conflicting')).toBe(true);
    // `computing` PROCEEDS, deliberately: GitHub resolves it within seconds, a churn
    // against a PR that turns out clean is the ordinary path, and one against a
    // conflicting PR costs a no-op event. Refusing would park a healthy PR on a
    // transient value — the direction `merge-gate.mjs` already rejected for UNKNOWN.
    expect(blocksChurn('computing')).toBe(false);
    expect(blocksChurn('clear')).toBe(false);
  });

  it('exports the field list the reads must request, in both shapes', () => {
    expect(CONFLICT_FIELDS).toEqual(['mergeable', 'mergeStateStatus']);
    expect(CONFLICT_JSON).toBe('mergeable,mergeStateStatus');
  });

  it('says the part that is invisible, not the part GitHub already shows', () => {
    // A reader can see "this branch has conflicts" in the GitHub UI. What no surface
    // says is that the pipeline has stopped, which is the sentence that has to travel.
    expect(CONFLICT_WHY).toMatch(/no `pull_request` events/);
    expect(CONFLICT_WHY).toMatch(/Nothing was churned/);
    expect(CONFLICT_WHY).toMatch(/RA-1722/);
  });

  it('does not call review `pull_request`-triggered: its label trigger is `pull_request_target` (RA-2302)', () => {
    // Since RA-2299 a `review:please` churn on a conflicting PR DOES start a run, so the
    // sentence that merge-gate posts on the PR must not say review cannot start. It
    // names what still cannot (CI, revise) and why a review that can start is useless.
    expect(CONFLICT_WHY).not.toMatch(/review[^.]*`pull_request`-triggered/);
    expect(CONFLICT_WHY).toMatch(/CI and revise are `pull_request`-triggered/);
  });

  it('names the remedy and NOT the actor, so a lane can land without editing it (RA-2150)', () => {
    // A draft of this named the workflow that would perform the update. That workflow
    // did not survive review, and the sentence is on five surfaces — so naming an actor
    // makes this string false twice for every attempt at one. The remedy is stable.
    expect(CONFLICT_WHY).toContain(CONFLICT_SHORT);
    expect(CONFLICT_WHY).not.toMatch(/\.yml/);
  });

  it('carries a short form for a surface that cannot fit the sentence', () => {
    // The digest's member row is one Slack line. Re-wording it there made the digest a
    // seventh reader of the same fact, which is exactly what RA-2154 was filed about.
    expect(CONFLICT_SHORT.length).toBeLessThan(40);
    // AND IT SAYS THE REMEDY, which length and containment alone do not check (RA-2184).
    // `CONFLICT_WHY).toContain(CONFLICT_SHORT)` plus a length bound admits ANY short
    // substring of the long sentence — `'review and revise are all'` passes both and
    // renders in Slack as "PR conflicts — review and revise are all".
    expect(CONFLICT_SHORT).toMatch(/base/);
    expect(CONFLICT_SHORT).toMatch(/merge/);
    // Read as the digest actually renders it, because that is the only place it appears.
    expect(`PR conflicts — ${CONFLICT_SHORT}`).toBe('PR conflicts — needs its base merged in');
  });
});
