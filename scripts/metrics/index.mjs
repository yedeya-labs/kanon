// The metrics module (plan 0003, M2): pure functions over the input shape in `types.mjs`, with
// no network and no file reads. The dry run (`kanon metrics dry-run`), the report and its views
// (`kanon metrics report`, M6 and kanon#669) and the collector's work-item step (M4) import it
// from here.

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
export { closingIssues, joinRuns } from './join.mjs';
export {
  DELIVERY_LANES, ESCAPE_DAYS, IDLE_DAYS, LEAD_LANES, MINIMUM, OVERHEAD_LANES, WINDOW_DAYS, cellText, measure, metricsReport, notEnough, pooledHeadline,
  prepareRows, renderReport, sortRows, yieldRatio,
} from './report.mjs';
export { AB_MARGINS, AB_VERDICTS, TREND_WINDOWS, compareVersions, metricsViews, renderViews } from './views.mjs';
export { PRICES, cacheSavings, priceOf } from './prices.mjs';
export {
  RESAMPLES, SEED, binomialCdf, bootstrap, bootstrapDifference, kendallTauB, newcombe, orderStatisticInterval, quantile, seededRandom, wilson,
} from './stats.mjs';
export { FOLLOWUP_LABELS, followupsOf, isReviewerFollowup } from './followups.mjs';
export { deriveRows } from './derive.mjs';
