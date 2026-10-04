import { escalatingPaths, readEscalationFile } from '../../../scripts/lib/escalation-paths.mjs';

/**
 * The fixture adopter's escalating paths, as the Merger reads them (kanon#135): Kanon's own
 * (`.github/`, the `docs/qa/*.md` documents, the agent instructions), then the pipeline code
 * and the high-risk paths its `docs/qa/escalation-paths.md` declares. The library tests run in
 * the fixture adopter, so this reads its file.
 */
export const ESCALATE_PATHS: Array<readonly [RegExp, string]> = escalatingPaths(readEscalationFile());
