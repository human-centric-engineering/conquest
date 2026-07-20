/**
 * Token-authed session boot reads, shared by every no-login respondent surface.
 *
 * Extracted from `anonymous-session-boot.tsx` when the experience run surface (`/x/<publicRef>`,
 * P15.3) needed the same four reads to open a session it did not create. Two copies of a
 * fail-soft fetch is the shape that drifts: the copy that gets a fix and the copy that does not.
 *
 * Every one of these FAILS SOFT to null/empty by design, and that is load-bearing rather than
 * lazy. None of them is the enforcing boundary — the server routes are — so the worst case of a
 * soft failure is a slightly plainer surface (no intro splash, no persona step, a re-asked opening
 * question). The worst case of throwing is a respondent who cannot answer at all. Validated with
 * Zod at the wire boundary, so no `as` on a response body.
 */

import { z } from 'zod';

import { API } from '@/lib/api/endpoints';
import type { QuestionnaireTurn } from '@/lib/app/questionnaire/chat/types';
import type { TurnInspectorData } from '@/lib/app/questionnaire/inspector';
import type { ResolvedSessionIntro } from '@/lib/app/questionnaire/intro/resolve';
import type { ResolvedSessionPersonas } from '@/lib/app/questionnaire/persona/resolve';
import type { ResolvedSessionCapture } from '@/lib/app/questionnaire/profile/resolve-capture';
import {
  ANSWER_PROVENANCES,
  CAPTURE_MODES,
  PERSONA_SWITCHERS,
  PROFILE_FIELD_TYPES,
  PROFILE_FIELD_VALIDATION_MODES,
} from '@/lib/app/questionnaire/types';
import { REASONING_STEP_KINDS, REASONING_TONES } from '@/lib/app/questionnaire/reasoning';
import { inspectorTurnSchema } from '@/lib/app/questionnaire/inspector/schema';

function authHeaders(accessToken: string): Record<string, string> {
  return { 'X-Session-Token': accessToken };
}

/* -------------------------------------------------------------------------- */
/* Transcript                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The transcript wire shape, validated in full — `reasoning` included.
 *
 * Every field is enumerated rather than waved through as `unknown` so the parsed result IS a
 * `QuestionnaireTurn[]` and needs no cast. A partial schema plus an `as` would put unvalidated
 * wire data behind a type assertion, which is the exact thing the boundary exists to prevent.
 */
const transcriptTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  warnings: z
    .array(z.object({ code: z.string(), message: z.string(), detail: z.string().optional() }))
    .optional(),
  reasoning: z
    .array(
      z.object({
        kind: z.enum(REASONING_STEP_KINDS),
        label: z.string(),
        tone: z.enum(REASONING_TONES),
        detail: z.string().optional(),
        rationale: z.string().optional(),
        sourceQuote: z.string().optional(),
        confidence: z.number().optional(),
        provenance: z.enum(ANSWER_PROVENANCES).optional(),
      })
    )
    .optional(),
});

const transcriptResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      turns: z.array(transcriptTurnSchema).optional(),
      // `.catch([])` keeps a malformed admin-only trace from failing the whole parse — debug data
      // must never wipe the respondent's replayed transcript.
      inspectorTurns: z.array(inspectorTurnSchema).catch([]).optional(),
    })
    .optional(),
});

/**
 * Fetch the session's replayed transcript. Fails soft to an empty transcript — the worst case is a
 * fresh greeting and a re-asked opening question, exactly the pre-replay behaviour.
 */
export async function fetchTranscript(
  sessionId: string,
  accessToken: string
): Promise<{ turns: QuestionnaireTurn[]; inspectorTurns: TurnInspectorData[] }> {
  const empty = { turns: [], inspectorTurns: [] };
  try {
    const res = await fetch(API.APP.QUESTIONNAIRE_SESSIONS.transcript(sessionId), {
      headers: authHeaders(accessToken),
    });
    if (!res.ok) return empty;
    const parsed = transcriptResponseSchema.safeParse(await res.json());
    if (!parsed.success) return empty;
    return {
      turns: parsed.data.data?.turns ?? [],
      inspectorTurns: parsed.data.data?.inspectorTurns ?? [],
    };
  } catch {
    return empty;
  }
}

/* -------------------------------------------------------------------------- */
/* Intro                                                                      */
/* -------------------------------------------------------------------------- */

const introSectionSchema = z.object({ heading: z.string(), body: z.string() });
const resolvedIntroSchema = z.object({
  enabled: z.boolean(),
  questionnaireTitle: z.string(),
  background: z.string(),
  videoUrl: z.string(),
  copy: z.object({
    howItWorks: introSectionSchema,
    whatYouGet: introSectionSchema.nullable(),
    goodToKnow: z.array(z.string()),
    buttonLabel: z.string(),
  }),
});
const introResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({ intro: resolvedIntroSchema.nullable() }).optional(),
});

/** Fetch the resolved intro. Fails soft to `null` — the worst case is no intro screen. */
export async function fetchIntro(
  sessionId: string,
  accessToken: string
): Promise<ResolvedSessionIntro | null> {
  try {
    const res = await fetch(API.APP.QUESTIONNAIRE_SESSIONS.intro(sessionId), {
      headers: authHeaders(accessToken),
    });
    if (!res.ok) return null;
    const parsed = introResponseSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    return parsed.data.data?.intro ?? null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Personas                                                                   */
/* -------------------------------------------------------------------------- */

const personaMenuSchema = z.object({
  enabled: z.boolean(),
  personas: z.array(z.object({ key: z.string(), label: z.string(), description: z.string() })),
  selectedPersonaKey: z.string().nullable(),
  defaultPersonaKey: z.string(),
  // Fail-soft: an unknown/missing switcher falls back to the pre-chat page (original behaviour).
  switcher: z.enum(PERSONA_SWITCHERS).catch('page'),
});
const personaResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({ persona: personaMenuSchema.nullable() }).optional(),
});

/** Fetch the resolved persona menu. Fails soft to `null` — the picker is an enhancement. */
export async function fetchPersonas(
  sessionId: string,
  accessToken: string
): Promise<ResolvedSessionPersonas | null> {
  try {
    const res = await fetch(API.APP.QUESTIONNAIRE_SESSIONS.persona(sessionId), {
      headers: authHeaders(accessToken),
    });
    if (!res.ok) return null;
    const parsed = personaResponseSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    return parsed.data.data?.persona ?? null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Profile capture                                                            */
/* -------------------------------------------------------------------------- */

const profileFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(PROFILE_FIELD_TYPES),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
  validation: z.enum(PROFILE_FIELD_VALIDATION_MODES),
  captureVia: z.enum(CAPTURE_MODES).optional(),
});
const resolvedCaptureSchema = z.object({
  captureMode: z.enum(CAPTURE_MODES),
  // Only the form-gate subset reaches the client; a hybrid version's conversational fields are
  // gathered server-side by the interviewer and never gate the carousel.
  formFields: z.array(profileFieldSchema),
  satisfied: z.boolean(),
});
const captureResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({ capture: resolvedCaptureSchema.nullable() }).optional(),
});

/**
 * Fetch the resolved profile capture. Fails soft to `null` — the server PUT remains the enforcing
 * boundary, so a soft failure at worst skips the client gate; it can never smuggle an unvalidated
 * profile through. Returns `null` for anonymous versions (the PII-free path).
 */
export async function fetchCapture(
  sessionId: string,
  accessToken: string
): Promise<ResolvedSessionCapture | null> {
  try {
    const res = await fetch(API.APP.QUESTIONNAIRE_SESSIONS.profile(sessionId), {
      headers: authHeaders(accessToken),
    });
    if (!res.ok) return null;
    const parsed = captureResponseSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    return parsed.data.data?.capture ?? null;
  } catch {
    return null;
  }
}
