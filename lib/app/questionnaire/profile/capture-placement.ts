/**
 * Respondent profile capture — per-field placement split (F-capture, hybrid).
 *
 * A version's `captureMode` is the DEFAULT placement; each field may override it with its own
 * `captureVia`. Splitting the fields on that effective placement is what makes a questionnaire
 * **hybrid**: e.g. name + email ride the blocking form gate (`form`) while everything else is gathered
 * by the interviewer in-chat (`conversational`). Both the runtime resolver (`resolve-capture.ts`, which
 * owns the form-gate subset) and the interviewer turn loop (`messages/route.ts`, which owns the
 * conversational subset) read the split from here so they never disagree on where a field belongs.
 *
 * Pure: no Prisma / Next / LLM. `values` arguments are a already-persisted snapshot's values.
 */

import {
  CAPTURE_MODES,
  narrowToEnum,
  type CaptureMode,
  type ProfileFieldConfig,
} from '@/lib/app/questionnaire/types';
import {
  parseProfileFields,
  type ProfileValues,
} from '@/lib/app/questionnaire/profile/profile-values';

/** The effective placement of one field: its own `captureVia` override, else the version default. */
export function effectiveCaptureVia(
  field: ProfileFieldConfig,
  defaultMode: CaptureMode
): CaptureMode {
  return field.captureVia ?? defaultMode;
}

/** The fields split by effective placement, preserving authored order within each subset. */
export interface CapturePlacementSplit {
  /** Collected up front via the blocking form gate. */
  formFields: ProfileFieldConfig[];
  /** Gathered by the interviewer during the conversation. */
  conversationalFields: ProfileFieldConfig[];
}

/** Partition `fields` into the form-gate subset and the conversational subset (`captureVia` ?? default). */
export function splitFieldsByPlacement(
  fields: ProfileFieldConfig[],
  defaultMode: CaptureMode
): CapturePlacementSplit {
  const formFields: ProfileFieldConfig[] = [];
  const conversationalFields: ProfileFieldConfig[] = [];
  for (const field of fields) {
    if (effectiveCaptureVia(field, defaultMode) === 'conversational')
      conversationalFields.push(field);
    else formFields.push(field);
  }
  return { formFields, conversationalFields };
}

/** Whether a snapshot's `values` carry a non-blank entry for `key`. */
function hasValue(values: ProfileValues, key: string): boolean {
  const v = values[key];
  return v !== undefined && v !== null && String(v).trim() !== '';
}

/**
 * Whether the interviewer should still be asked to gather the conversational subset — i.e. whether
 * {@link import('./conversational-capture').buildProfileCaptureInstructions} is injected this turn.
 * The injected directive lists ALL conversational fields (required and optional), so within the active
 * window the interviewer weaves in the optional asks too; this only decides how long that window lasts.
 *
 * Active while any REQUIRED conversational field is still missing (the interviewer keeps the ask alive
 * until it's answered — optionals ride along during that window and are taken as-offered). The rule
 * then depends on whether the subset has any required fields:
 *   - **Mixed / has required fields** — once every required field is captured the window closes
 *     immediately; a required field that just landed makes `anyCaptured` true. Optionals the respondent
 *     hasn't volunteered by then are let go (never blocking, never nagged) — the confirmed
 *     "persist partial, don't block" rule, and identical to the pre-hybrid behaviour (which stopped as
 *     soon as the snapshot — written when all required were in — existed).
 *   - **All-optional subset (no required fields)** — stays active for one opportunistic pass, until the
 *     FIRST value lands, then goes quiet so the extraction call isn't re-run every turn (and the
 *     respondent isn't nudged) over optionals they chose to skip.
 *
 * Returns `false` when there is no conversational subset at all.
 */
export function conversationalCaptureActive(
  conversationalFields: ProfileFieldConfig[],
  values: ProfileValues
): boolean {
  if (conversationalFields.length === 0) return false;
  const requiredMissing = conversationalFields.some((f) => f.required && !hasValue(values, f.key));
  if (requiredMissing) return true;
  // Every required conversational field is captured (or there are none). Close the window once any
  // value has landed — for a has-required subset that's already true (a required one just landed, so
  // this returns false immediately); for an all-optional subset it grants exactly one opportunistic pass.
  const anyCaptured = conversationalFields.some((f) => hasValue(values, f.key));
  return !anyCaptured;
}

/**
 * Resolve the CONVERSATIONAL subset of a version's profile fields from its raw config — the exact
 * assembly the interviewer turn loop (`messages/route.ts`) needs: honour the anonymous PII-free
 * invariant (no capture at all), narrow the stored `captureMode` to a valid default, parse the stored
 * `profileFields`, and return only the fields whose effective placement is `conversational`. Pure
 * (no Prisma) so the route's capture wiring is unit-testable end-to-end; the route then reads the
 * snapshot values and calls {@link conversationalCaptureActive} to decide injection.
 */
export function conversationalCaptureFieldsForConfig(config: {
  anonymousMode: boolean;
  captureMode: string | null;
  profileFields: unknown;
}): ProfileFieldConfig[] {
  if (config.anonymousMode) return [];
  const defaultMode = narrowToEnum<CaptureMode>(config.captureMode ?? '', CAPTURE_MODES, 'form');
  return splitFieldsByPlacement(parseProfileFields(config.profileFields), defaultMode)
    .conversationalFields;
}
