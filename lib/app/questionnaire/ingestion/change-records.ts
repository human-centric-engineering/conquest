/**
 * Change-record normalisation (F1.1 / PR2).
 *
 * Pure data-in / data-out: takes the LLM-reported `changes` (already
 * schema-valid) plus the admin's supplied metadata, and returns the
 * version-agnostic `ChangeRecordIntent[]` the route persists (PR4). Two jobs:
 *
 *  1. Per-`changeType` coherence — `prune_*` must have a null `afterJson`
 *     (the removed data lives in `beforeJson` for revert); `infer_*` must target
 *     the version. Incoherent records (e.g. a non-infer change claiming to target
 *     `version`) are dropped rather than persisted wrong.
 *  2. Inference suppression — drop `infer_goal` / `infer_audience` decisions for
 *     fields the admin supplied (admin-wins-per-field). Audience suppression is
 *     per key: a partly-suppressed `infer_audience` keeps its un-supplied keys.
 *
 * No Prisma / Next.js. `versionId` and `targetEntityId` are attached later, once
 * the graph is persisted.
 */

import { isRecord } from '@/lib/utils';
import type { AudienceShape } from '@/lib/app/questionnaire/types';
import {
  INFER_CHANGE_TYPES,
  PRUNE_CHANGE_TYPES,
  type AdminSuppliedMetadata,
  type ChangeRecordIntent,
  type ChangeType,
} from '@/lib/app/questionnaire/ingestion/types';
import type { ExtractedChange } from '@/lib/app/questionnaire/ingestion/extraction-schema';

const PRUNE = new Set<ChangeType>(PRUNE_CHANGE_TYPES);
const INFER = new Set<ChangeType>(INFER_CHANGE_TYPES);

export interface DroppedChange {
  change: ExtractedChange;
  reason: string;
}

export interface NormalizeChangeRecordsResult {
  /** Coherent, suppression-filtered intents ready for persistence. */
  intents: ChangeRecordIntent[];
  /** Records removed (incoherent or fully admin-suppressed) — for logging. */
  dropped: DroppedChange[];
}

/** Carry through the optional provenance fields, omitting `undefined`. */
function baseIntent(
  change: ExtractedChange,
  overrides: Pick<ChangeRecordIntent, 'changeType' | 'targetEntityType'> &
    Partial<ChangeRecordIntent>
): ChangeRecordIntent {
  const intent: ChangeRecordIntent = {
    changeType: overrides.changeType,
    targetEntityType: overrides.targetEntityType,
  };
  if (change.sourceQuote !== undefined) intent.sourceQuote = change.sourceQuote;
  if (change.rationale !== undefined) intent.rationale = change.rationale;
  if (change.confidence !== undefined) intent.confidence = change.confidence;
  // `undefined` means "the model omitted it" → leave the key off the intent.
  // An explicit `null` (prune's afterJson, an inference with no prior value) is
  // meaningful and kept.
  if (overrides.beforeJson !== undefined) intent.beforeJson = overrides.beforeJson;
  if (overrides.afterJson !== undefined) intent.afterJson = overrides.afterJson;
  return intent;
}

/**
 * Normalise and suppress the extractor's reported changes. See module doc.
 */
export function normalizeChangeRecords(
  changes: ExtractedChange[],
  adminSupplied?: AdminSuppliedMetadata
): NormalizeChangeRecordsResult {
  const intents: ChangeRecordIntent[] = [];
  const dropped: DroppedChange[] = [];

  const goalSupplied = adminSupplied?.goal !== undefined;
  const suppliedAudience = adminSupplied?.audience;

  for (const change of changes) {
    const { changeType } = change;

    // --- Inference decisions (target the version; suppressed per field) -------
    if (INFER.has(changeType)) {
      if (changeType === 'infer_goal') {
        if (goalSupplied) {
          dropped.push({ change, reason: 'suppressed: admin supplied goal' });
          continue;
        }
        intents.push(
          baseIntent(change, {
            changeType,
            targetEntityType: 'version',
            afterJson: change.afterJson ?? null,
          })
        );
        continue;
      }

      if (changeType === 'infer_audience') {
        // Prune the keys the admin already owns.
        if (!isRecord(change.afterJson)) {
          dropped.push({
            change,
            reason: 'incoherent: infer_audience afterJson is not an object',
          });
          continue;
        }
        const inferredKeyCount = Object.keys(change.afterJson).length;
        const kept: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(change.afterJson)) {
          const adminOwnsKey = suppliedAudience?.[key as keyof AudienceShape] !== undefined;
          if (!adminOwnsKey) kept[key] = value;
        }
        if (Object.keys(kept).length === 0) {
          // Distinguish a vacuous record (model inferred nothing) from a real
          // suppression (model inferred fields the admin already owns) — the
          // reason drives diagnosis/retry decisions downstream.
          dropped.push({
            change,
            reason:
              inferredKeyCount === 0
                ? 'incoherent: infer_audience afterJson has no fields'
                : 'suppressed: all inferred audience fields admin-supplied',
          });
          continue;
        }
        intents.push(
          baseIntent(change, { changeType, targetEntityType: 'version', afterJson: kept })
        );
        continue;
      }

      // Defensive: an INFER_CHANGE_TYPES member added without a handler above.
      // Drop with an honest reason rather than misrouting it through the
      // audience path (which would misdiagnose it as a bad object).
      dropped.push({ change, reason: `incoherent: unhandled inference type ${changeType}` });
      continue;
    }

    // --- Prune decisions (afterJson must be null; target an entity) -----------
    if (PRUNE.has(changeType)) {
      if (change.targetEntityType === 'version') {
        dropped.push({ change, reason: 'incoherent: prune cannot target the version' });
        continue;
      }
      intents.push(
        baseIntent(change, {
          changeType,
          targetEntityType: change.targetEntityType,
          beforeJson: change.beforeJson ?? null,
          afterJson: null,
        })
      );
      continue;
    }

    // --- Edits / structural changes (target section or question) -------------
    if (change.targetEntityType === 'version') {
      dropped.push({
        change,
        reason: `incoherent: ${changeType} cannot target the version`,
      });
      continue;
    }
    intents.push(
      baseIntent(change, {
        changeType,
        targetEntityType: change.targetEntityType,
        beforeJson: change.beforeJson,
        afterJson: change.afterJson,
      })
    );
  }

  return { intents, dropped };
}
