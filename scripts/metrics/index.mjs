// The metrics module (plan 0003, M2): pure functions over the input shape in `types.mjs`, with
// no network and no file reads. The dry run (`kanon metrics dry-run`) and, later, the
// collector's work-item step import it from here.

export { BAND_THRESHOLDS, BAND_VERSION, BANDS, bandOf, diffSize, isExcludedFromSize } from './band.mjs';
export { AREAS, areaCounts, areaOf, escalationFlags } from './areas.mjs';
export { DEPENDENCY_BOTS, classifyActor, isAgentClass, isDependencyBot } from './actors.mjs';
export {
  BUG_LABEL, INTRODUCED_BY, accuracyFields, codeAreaTest, detectorCounts, explicitLink, explicitLinks, fixesOf,
  introducedBy, isFixPr, oldRanges, revertedBy, reverts, revertsOf, sharedCodeFiles, szzLinks,
} from './detectors.mjs';
export { AdapterError, toDetectorPr } from './adapter.mjs';
export {
  DISPUTE_FIELD, DISPUTE_FORM, disputedRule, healthView, releaseList, ruleDisputes, timeToFix, upgradeLag,
} from './health.mjs';
export { ORIGINS, originOf } from './origin.mjs';
export { RELEASE_LABELS, RELEASE_TITLE, isReleasePr } from './release.mjs';
export {
  DISPATCH_LABELS, STAGE_FIELDS, STAGE_ORDER, dispatchedAt, partitionProblem, partitionStages, reviewerVerdicts, seconds, stageIntervals,
} from './stages.mjs';
export { WorkItemError, checkWorkItemRow, workItemRow } from './work-item.mjs';
