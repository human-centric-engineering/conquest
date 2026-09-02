/**
 * Token-authed session boot reads, shared by every no-login respondent surface.
 *
 * Extracted from `anonymous-session-boot.tsx` when the experience run surface (`/x/<publicRef>`,
 * P15.3) needed the same four reads to open a session it did not create. Two copies of a
 * fail-soft fetch is the shape that drifts: the copy that gets a fix and the copy that does not.
 *
 * {@link fetchSurfaceConfig} joined them later, for the surface that has no server render at all:
 * the facilitated-meeting participant (P15.5) swaps sessions IN PLACE as breakouts start, so it
 * cannot receive per-version config as props the way the page-rendered surfaces do.
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
import type { RespondentSurfaceConfig } from '@/lib/app/questionnaire/session/respondent-surface';
import {
  ANSWER_PROVENANCES,
  ANSWER_SLOT_PANEL_SCOPES,
  CAPTURE_MODES,
  DEFAULT_QUESTIONNAIRE_CONFIG,
  PERSONA_SWITCHERS,
  PRESENTATION_MODES,
  RESPONDENT_DESIGNS,
  RESPONDENT_LAYOUTS,
  PROFILE_FIELD_TYPES,
  PROFILE_FIELD_VALIDATION_MODES,
  REASONING_PLACEMENTS,
} from '@/lib/app/questionnaire/types';
import {
  CHAT_TEXT_SCALES,
  DEFAULT_CHAT_TEXT_SCALE_INDEX,
} from '@/lib/app/questionnaire/chat/text-scale';
import { REASONING_STEP_KINDS, REASONING_TONES } from '@/lib/app/questionnaire/reasoning';
import { DEFAULT_FONT_PAIRING, FONT_PAIRINGS } from '@/lib/app/questionnaire/theming';
import { inspectorTurnSchema } from '@/lib/app/questionnaire/inspector/schema';

function authHeaders(accessToken: string): Record<string, string> {
  return { 'X-Session-Token': accessToken };
}

/**
 * The statuses that mean "this credential does not open a session any more".
 *
 * `404` the row is gone; `401`/`403` the token no longer authorises it. Anything else — a 500, a
 * timeout — is a reason to keep the session, not to abandon it.
 */
const SESSION_GONE_STATUSES: readonly number[] = [401, 403, 404];

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
  // Sectioned interviews (P21): the section this exchange was said in. Enumerated here because Zod
  // strips what it does not know — without it a resumed transcript came back with every turn
  // untagged, and the respondent surface, which divides the conversation by section, showed the
  // whole interview under whichever section they were in.
  sectionKey: z.string().nullable().optional(),
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
 *
 * `sessionGone` is the ONE thing this read reports that the others do not: the server says this
 * credential no longer opens a session (`404` — the row is not there; `401`/`403` — the token no
 * longer authorises it). Failing soft is right for a plainer surface, but not for a session that
 * does not exist: the boot would seed a welcome, the first turn would come back "Session not
 * found", and Try again would ask the same dead session forever. The caller uses it to drop the
 * stored credential and start a real one.
 *
 * Deliberately narrow. A network failure, a 500, or a malformed body all leave it `false`: those
 * are reasons to carry on with what we have, and abandoning a live session over a blip would lose
 * a respondent's thread to fix a problem they did not have.
 */
export async function fetchTranscript(
  sessionId: string,
  accessToken: string
): Promise<{
  turns: QuestionnaireTurn[];
  inspectorTurns: TurnInspectorData[];
  sessionGone: boolean;
}> {
  const empty = { turns: [], inspectorTurns: [], sessionGone: false };
  try {
    const res = await fetch(API.APP.QUESTIONNAIRE_SESSIONS.transcript(sessionId), {
      headers: authHeaders(accessToken),
      // Own API, same origin — a redirect here is never legitimate, and following
      // one would carry the session access token to whatever it pointed at.
      redirect: 'error',
    });
    if (!res.ok) {
      return { ...empty, sessionGone: SESSION_GONE_STATUSES.includes(res.status) };
    }
    const parsed = transcriptResponseSchema.safeParse(await res.json());
    if (!parsed.success) return empty;
    return {
      turns: parsed.data.data?.turns ?? [],
      inspectorTurns: parsed.data.data?.inspectorTurns ?? [],
      sessionGone: false,
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
      // Own API, same origin — a redirect here is never legitimate, and following
      // one would carry the session access token to whatever it pointed at.
      redirect: 'error',
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
      // Own API, same origin — a redirect here is never legitimate, and following
      // one would carry the session access token to whatever it pointed at.
      redirect: 'error',
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
      // Own API, same origin — a redirect here is never legitimate, and following
      // one would carry the session access token to whatever it pointed at.
      redirect: 'error',
    });
    if (!res.ok) return null;
    const parsed = captureResponseSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    return parsed.data.data?.capture ?? null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Surface configuration                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The band's round window. Dates cross the wire as ISO strings, so they are coerced back rather
 * than passed through — the schedule helpers the band uses do real date arithmetic on them.
 */
const bandRoundSchema = z.object({
  name: z.string(),
  status: z.string(),
  opensAt: z.coerce.date().nullable(),
  closesAt: z.coerce.date().nullable(),
  closedAt: z.coerce.date().nullable(),
});

const resolvedThemeSchema = z.object({
  ctaColor: z.string(),
  accentColor: z.string(),
  logoUrl: z.string().nullable(),
  bannerUrl: z.string().nullable(),
  welcomeCopy: z.string(),
  surfaceColor: z.string().nullable(),
  ctaColorEnd: z.string().nullable(),
  logoBackgroundColor: z.string().nullable(),
  hasBrandIdentity: z.boolean(),
  // The brand kit. Every field here is a hand-written mirror of `ResolvedTheme`, and every one
  // carries `.catch()` so a MISSING or unrecognised value degrades that ONE affordance instead
  // of failing the parse. `.nullable()` alone did not do that: an absent key still fails the
  // field, which fails `resolvedThemeSchema`, which fails `surfaceConfigSchema`, which makes
  // `fetchSurfaceConfig` return null — so during a rolling deploy (new bundle, old server) a
  // client-booted surface would lose voice input, layout, answer-panel scope, reasoning,
  // glossary and text size all at once, over one theme field the resolver had not learnt yet.
  canvasColor: z.string().nullable().catch(null),
  onCanvas: z.string().nullable().catch(null),
  canvasColorDark: z.string().nullable().catch(null),
  onCanvasDark: z.string().nullable().catch(null),
  canvasIsDark: z.boolean().catch(false),
  accentColorEnd: z.string().nullable().catch(null),
  logoMarkUrl: z.string().nullable().catch(null),
  logoDarkUrl: z.string().nullable().catch(null),
  bandLogoUrl: z.string().nullable().catch(null),
  bandLogoDarkUrl: z.string().nullable().catch(null),
  fontPairing: z.enum(FONT_PAIRINGS).catch(DEFAULT_FONT_PAIRING),
  // Custom type. `.catch(null)` like every field above: a client-booted surface on an older bundle
  // must lose the custom face alone (falling back to the system stack, which is what the `custom`
  // pairing's own stack already is) rather than losing every affordance at once.
  customFontDisplay: z.string().nullable().catch(null),
  customFontBody: z.string().nullable().catch(null),
  fontFaceCss: z.string().nullable().catch(null),
});

/**
 * Each field `.catch()`es to the same default the server-side resolver would have produced, so a
 * single unrecognised value (an enum widened by a newer deploy, say) degrades that ONE affordance
 * instead of failing the parse and dropping the respondent back to every default at once.
 */
const surfaceConfigSchema = z.object({
  voiceInputEnabled: z.boolean().catch(DEFAULT_QUESTIONNAIRE_CONFIG.voiceEnabled),
  attachmentInputEnabled: z.boolean().catch(DEFAULT_QUESTIONNAIRE_CONFIG.attachmentsEnabled),
  presentationMode: z.enum(PRESENTATION_MODES).catch(DEFAULT_QUESTIONNAIRE_CONFIG.presentationMode),
  // `.catch` rather than a required field: a boot payload from a build that knows a layout this
  // one does not must still render — as Classic — instead of failing the whole parse and leaving
  // the respondent with a dead surface.
  respondentLayout: z.enum(RESPONDENT_LAYOUTS).catch(DEFAULT_QUESTIONNAIRE_CONFIG.respondentLayout),
  // Same `.catch` reasoning, and it matters slightly more here: an unknown DESIGN name would
  // reach the surface as a `data-design` attribute matching no stylesheet block at all, so the
  // failure would be silent rather than obvious.
  respondentDesign: z.enum(RESPONDENT_DESIGNS).catch(DEFAULT_QUESTIONNAIRE_CONFIG.respondentDesign),
  answerPanelScope: z
    .enum(ANSWER_SLOT_PANEL_SCOPES)
    .catch(DEFAULT_QUESTIONNAIRE_CONFIG.answerSlotPanelScope),
  // Already an index on the wire (the server resolved the name), so this validates the range
  // rather than an enum. `.catch` for the same reason every field here has one, and the fallback
  // is the standard rung: a payload from a build with a longer ladder must open the conversation
  // at a readable size rather than fail the parse and drop every other affordance with it.
  chatTextScaleIndex: z
    .number()
    .int()
    .min(0)
    .max(CHAT_TEXT_SCALES.length - 1)
    .catch(DEFAULT_CHAT_TEXT_SCALE_INDEX),
  reasoningPlacement: z.enum(REASONING_PLACEMENTS).nullable().catch(null),
  reasoningDwellMs: z.number().catch(DEFAULT_QUESTIONNAIRE_CONFIG.reasoningStreamDwellMs),
  reasoningPerItemMs: z.number().catch(DEFAULT_QUESTIONNAIRE_CONFIG.reasoningStreamPerItemMs),
  inlineCorrectionEnabled: z.boolean().catch(DEFAULT_QUESTIONNAIRE_CONFIG.inlineCorrectionEnabled),
  showProgressPercentText: z.boolean().catch(DEFAULT_QUESTIONNAIRE_CONFIG.showProgressPercentText),
  anonymous: z.boolean().catch(false),
  theme: resolvedThemeSchema,
  header: z.object({ title: z.string(), round: bandRoundSchema.nullable() }).nullable().catch(null),
  glossary: z
    .array(
      z.object({
        termId: z.string(),
        term: z.string(),
        surfaces: z.array(z.string()),
        definitions: z.array(z.string()),
      })
    )
    .catch([]),
  glossaryAppendix: z
    .object({
      heading: z.string(),
      entries: z.array(z.object({ term: z.string(), definitions: z.array(z.string()) })),
    })
    .nullable()
    .catch(null),
});

const surfaceResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({ surface: surfaceConfigSchema }).optional(),
});

/**
 * Fetch the resolved surface configuration for a session.
 *
 * Fails soft to `null`, and here that is worth being precise about: `null` means "the caller keeps
 * whatever it would have rendered without this read", which is the workspace's own prop defaults —
 * exactly the behaviour every client-booted surface had before this endpoint existed. So a soft
 * failure is a plainer surface, never a respondent who cannot answer. None of these values is a
 * security boundary: the turn, transcript and submit routes enforce access on their own, and the
 * affordances this governs are presentational.
 */
export async function fetchSurfaceConfig(
  sessionId: string,
  accessToken: string
): Promise<RespondentSurfaceConfig | null> {
  try {
    const res = await fetch(API.APP.QUESTIONNAIRE_SESSIONS.surface(sessionId), {
      headers: authHeaders(accessToken),
      // Own API, same origin — a redirect here is never legitimate, and following
      // one would carry the session access token to whatever it pointed at.
      redirect: 'error',
    });
    if (!res.ok) return null;
    const parsed = surfaceResponseSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    return parsed.data.data?.surface ?? null;
  } catch {
    return null;
  }
}
