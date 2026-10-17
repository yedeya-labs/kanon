/**
 * The ref a pin of Kanon's own holds (`K-ADOPT-11`): an exact release, either a stable one,
 * `vX.Y.Z`, or a candidate, `candidate-vX.Y.Z`, which Kanon's own callers, CI's `Lane check` and
 * its two judging checks pin during the candidate's soak (plan 0009 S3/S4; docs/release.md,
 * "Channels: candidates and stable"; ADR 0011, decision 2). Never a branch, a commit, the moving
 * major tag (`v0`) or `$/`.
 *
 * The guards that hold Kanon's callers to "an exact release" read this one pattern, so a pin
 * move to a candidate passes them and nothing looser does. It is a pattern's source, without
 * anchors, for a guard to embed in its own; `isReleaseRef` tests a whole ref.
 */
export const RELEASE_REF = String.raw`(?:candidate-)?v\d+\.\d+\.\d+`;

/** Whether `ref` is a whole exact release, stable or candidate. */
export const isReleaseRef = (ref: string): boolean => new RegExp(`^${RELEASE_REF}$`).test(ref);

/** A `uses:` of Kanon's `path` (`actions/dco`, `.github/workflows/agent-review.yml`) at an exact release. */
export const releasedUses = (path: string): RegExp =>
  new RegExp(`^yedeya-labs/kanon/${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@${RELEASE_REF}$`);
