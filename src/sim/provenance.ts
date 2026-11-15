// Where a value, dataset or model comes from. Kept as plain data so it can travel in snapshots.

/**
 * What kind of evidence backs a value:
 * - `source-value`       taken from a cited document (e.g. NASA ILN Case 1)
 * - `derived`            computed from source values (e.g. panel area from panel size)
 * - `project-assumption` a transparent project preset, not a measured value or a NASA rule
 * - `dataset`            a numeric data product (e.g. a LOLA DEM)
 * - `model`              an algorithmic or modelling choice
 */
export type ProvenanceKind = 'source-value' | 'derived' | 'project-assumption' | 'dataset' | 'model'

export type SourceRef = {
  /** Stable identifier, e.g. 'nasa-iln-tm-20210025878' or 'lola-ldem-4'. */
  id: string
  title: string
  kind: ProvenanceKind
  url?: string
  /** Free-text scope, page numbers or caveats. */
  note?: string
}

/** Provenance of one configurable parameter. */
export type ParameterProvenance = {
  kind: ProvenanceKind
  source?: SourceRef
  note?: string
}
