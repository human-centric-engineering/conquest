/**
 * The one seam that carries a live "questions so far" callback from the ingest
 * pipeline into the extractor capability.
 *
 * The extractor runs behind the generic capability dispatcher, whose only
 * caller→capability channel is `CapabilityContext.entityContext` (a documented
 * free-form `Record<string, unknown>`). The streaming ingest route wants the
 * extractor to report its running question count as the response streams; the
 * non-streaming ingest/re-ingest routes want nothing. So the route puts an
 * `onExtractionProgress` sink on `entityContext` and the capability reads it
 * back — defensively, since the field is typed `unknown`.
 *
 * Keeping the key name and the narrowing in ONE module means the producer
 * (`extract-pipeline.ts`) and consumer (`extract-questionnaire-structure.ts`)
 * can't drift on the contract. Pure and Prisma/Next-free (safe under
 * `lib/app/**`); it does not fork the platform dispatcher — it rides its seam.
 */

/** A monotonically non-decreasing count of complete questions seen so far. */
export type ExtractionProgressSink = (questionsSoFar: number) => void;

/** The `entityContext` key under which the sink travels. */
export const EXTRACTION_PROGRESS_CONTEXT_KEY = 'onExtractionProgress';

/**
 * Narrow the optional progress sink out of a capability's `entityContext`.
 * Returns `undefined` when absent or not a function (the non-streaming callers),
 * so the capability keeps its blocking path for them.
 */
export function readExtractionProgressSink(
  entityContext: Record<string, unknown> | undefined
): ExtractionProgressSink | undefined {
  const raw = entityContext?.[EXTRACTION_PROGRESS_CONTEXT_KEY];
  return typeof raw === 'function' ? (raw as ExtractionProgressSink) : undefined;
}
