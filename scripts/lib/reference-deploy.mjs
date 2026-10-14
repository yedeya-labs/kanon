// The reference environment's deploy (`K-LAYOUT-10`, `K-PROJ-11`; plan 0004 step P6, kanon#54),
// now one part of the adoption record's `## Deploy` section, which
// `scripts/lib/deploy-declaration.mjs` reads (plan 0010 §4, step D2). Its three bullets moved
// there from `## Choices` at once, with no period of reading both places (plan 0010, follow-up
// decision 1).
//
// This module is that parser's re-export, kept so the scripts and readers that import the
// record's path, `## Choices`' heading or the reference deploy's readers from here keep working.
// New code imports `deploy-declaration.mjs`.

export {
  ADOPTION_RECORD,
  CHOICES_HEADING,
  DeclarationError,
  declaredEnvironmentFrom,
  LABELS,
  parseReferenceDeploy,
  readReferenceDeploy,
  readReferenceDeployFrom,
  requireReferenceDeploy,
} from './deploy-declaration.mjs';

/** @typedef {import('./deploy-declaration.mjs').ReferenceDeploy} ReferenceDeploy */
