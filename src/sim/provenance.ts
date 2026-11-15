// Where a value, dataset or model comes from. Kept as plain data so it can travel in snapshots.

/**
 * What kind of evidence backs a value:
 * - `source-value`       taken from a cited document (e.g. NASA ILN Case 1)
 * - `derived`            computed from source values (e.g. panel area from panel size)
 * - `project-assumption` a transparent project preset, not a measured value or a NASA rule
 * - `dataset`            a numeric data product (e.g. a LOLA DEM)
 * - `model`              an algorithmic or modelling choice
 * - `unverified`         taken from a reference that has not been checked against its original
 */
export type ProvenanceKind = 'source-value' | 'derived' | 'project-assumption' | 'dataset' | 'model' | 'unverified'

/**
 * How far a source was actually checked in this project (see the source register in sources.md):
 * - `read-original`   the original document, label or file was read
 * - `metadata-only`   only an abstract, catalogue entry or metadata was read
 * - `agent-reported`  retrieved by a research helper and not re-read
 * - `not-verified`    cited by a project document, not opened
 * - `access-failed`   an attempt failed; this says nothing about whether the data exist
 * - `not-applicable`  a project-defined value with no external source
 */
export type SourceVerification =
  | 'read-original' | 'metadata-only' | 'agent-reported' | 'not-verified' | 'access-failed' | 'not-applicable'

export type SourceRef = {
  /** Stable identifier, e.g. 'nasa-iln-tm-20210025878' or 'lola-ldem-4'. */
  id: string
  title: string
  kind: ProvenanceKind
  url?: string
  /** Free-text scope, page numbers or caveats. */
  note?: string
}

/**
 * Provenance of one configurable parameter. `sourceIds` and `assumptionIds` are IDs in the source register
 * (sources.md): SRC-* for external sources, ASM-* for project assumptions, REQ-* for project requirements.
 */
export type ParameterProvenance = {
  kind: ProvenanceKind
  source?: SourceRef
  sourceIds?: string[]
  assumptionIds?: string[]
  verification?: SourceVerification
  note?: string
}
