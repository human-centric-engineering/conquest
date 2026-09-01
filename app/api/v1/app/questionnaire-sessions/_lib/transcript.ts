/**
 * Transcript replay loader for the respondent chat surface (F7.1 — resume).
 *
 * Rebuilds a session's rendered transcript from its persisted {@link AppQuestionnaireTurn} rows
 * so a resumed surface shows the conversation it left off in — including the per-turn side-band
 * notices (seriousness / support / contradiction) the turn surfaced, which were previously
 * transient and lost on the next input or a reload. Ordinal-ordered; the opening kickoff turn
 * (empty `userMessage`) contributes only its assistant message, matching how the live loop
 * renders it.
 *
 * The `warnings` JSON is validated at this boundary (untyped `Json` from Prisma) and fails soft
 * to "no notices" if a row is somehow malformed — a replayed transcript must never throw.
 */

import { z } from 'zod';

import { prisma } from '@/lib/db/client';
import type { QuestionnaireTurn, SessionWarning } from '@/lib/app/questionnaire/chat/types';
import {
  REASONING_STEP_KINDS,
  REASONING_TONES,
  type ReasoningStep,
} from '@/lib/app/questionnaire/reasoning';
import {
  ANSWER_PROVENANCES,
  QUESTION_TYPES,
  narrowQuestionFidelity,
  resolveQuestionFidelity,
  type QuestionType,
} from '@/lib/app/questionnaire/types';
import {
  buildQuestionCard,
  canRenderAnswerControl,
  type QuestionCardPayload,
} from '@/lib/app/questionnaire/chat/question-card';
import { inspectorTurnSchema } from '@/lib/app/questionnaire/inspector/schema';
import type { TurnInspectorData } from '@/lib/app/questionnaire/inspector';

/** Persisted per-turn notices — `{ code, message }[]`; anything malformed degrades to `[]`. */
const warningsSchema = z
  .array(z.object({ code: z.string(), message: z.string(), detail: z.string().optional() }))
  .catch([]);

/**
 * Persisted per-turn reasoning trace — validated at this boundary (untyped `Json` from Prisma) and
 * failing soft to "no trace" if a row is malformed. Mirrors {@link warningsSchema}; the enums keep
 * the replayed steps in lockstep with the live wire shape (`parse-session-event.ts`).
 */
const reasoningSchema = z
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
  .catch([]);

/**
 * Build the rendered transcript for a session from its turn rows, newest last. Each turn yields
 * an optional user bubble (skipped for the empty-message kickoff turn) followed by the assistant
 * reply, with any persisted notices attached so the surface replays them inline beneath the turn.
 */
export async function loadTranscript(sessionId: string): Promise<QuestionnaireTurn[]> {
  const rows = await prisma.appQuestionnaireTurn.findMany({
    where: { sessionId },
    orderBy: { ordinal: 'asc' },
    select: {
      userMessage: true,
      agentResponse: true,
      warnings: true,
      reasoning: true,
      questionCardKey: true,
      // Sectioned interviews (P21): tags both bubbles of an exchange, so the live chat can show one
      // section at a time and the downloads can group by it. Null on every unsectioned session.
      sectionKey: true,
    },
  });

  const cardByKey = await loadReplayableCards(sessionId, rows);

  const turns: QuestionnaireTurn[] = [];
  for (const row of rows) {
    if (row.userMessage.trim().length > 0) {
      turns.push({
        role: 'user',
        content: row.userMessage,
        // Both halves of an exchange carry the same key: they are one turn, and a filter that split
        // them would show an answer with no question above it.
        ...(row.sectionKey ? { sectionKey: row.sectionKey } : {}),
      });
    }
    const warnings = warningsSchema.parse(row.warnings);
    const reasoning = reasoningSchema.parse(row.reasoning);
    const card =
      typeof row.questionCardKey === 'string' ? cardByKey.get(row.questionCardKey) : undefined;
    turns.push({
      role: 'assistant',
      content: row.agentResponse,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(reasoning.length > 0 ? { reasoning } : {}),
      ...(card ? { card } : {}),
      ...(row.sectionKey ? { sectionKey: row.sectionKey } : {}),
    });
  }
  return turns;
}

/**
 * Rebuild the answer controls to replay, keyed by question key.
 *
 * Two deliberate choices:
 *
 *  - **Rebuilt from the LIVE slot, not from a stored copy.** Only the key is persisted, so an admin
 *    who reworded a question or changed its options between sessions doesn't leave a stale snapshot
 *    pinned in a resumed transcript.
 *  - **Suppressed once answered.** Replaying a live control over an answer the respondent already
 *    gave would invite them to answer it twice, and the second submission would overwrite the first.
 *    An answered question replays as the prose turn alone.
 *
 * Returns an empty map when no turn carried a card, which is the overwhelming majority of sessions —
 * so the common path costs no extra query.
 */
async function loadReplayableCards(
  sessionId: string,
  rows: ReadonlyArray<{ questionCardKey: string | null }>
): Promise<Map<string, QuestionCardPayload>> {
  // `typeof === 'string'`, not `!== null`: a row selected without the column (or from an older
  // shape) yields `undefined`, which a null-check would wave through as a lookup key.
  const keys = [
    ...new Set(rows.map((r) => r.questionCardKey).filter((k) => typeof k === 'string')),
  ];
  if (keys.length === 0) return new Map();

  const slots = await prisma.appQuestionSlot.findMany({
    where: { key: { in: keys }, section: { version: { sessions: { some: { id: sessionId } } } } },
    select: {
      id: true,
      key: true,
      prompt: true,
      type: true,
      typeConfig: true,
      required: true,
      fidelity: true,
      answers: { where: { sessionId }, select: { id: true }, take: 1 },
      // The version's gate, fetched through the same traversal (no extra round-trip). Replaying an
      // INTERACTIVE control after an admin switched the feature off would break the inert-when-off
      // guarantee — the respondent could still submit through it.
      section: {
        select: { version: { select: { config: { select: { questionFidelity: true } } } } },
      },
    },
  });

  const cards = new Map<string, QuestionCardPayload>();
  for (const slot of slots) {
    if (!narrowQuestionFidelity(slot.section.version.config?.questionFidelity).enabled) continue;
    if (slot.answers.length > 0) continue; // already answered — don't offer it again
    const type = asQuestionType(slot.type);
    // The question may have been reworded into a type/config that can no longer render a control.
    if (!canRenderAnswerControl(type, slot.typeConfig)) continue;
    cards.set(
      slot.key,
      buildQuestionCard({
        questionKey: slot.key,
        prompt: slot.prompt,
        type,
        typeConfig: slot.typeConfig,
        required: slot.required,
        reason:
          resolveQuestionFidelity(slot.fidelity, slot.section.version.config?.questionFidelity) ===
          'must_ask'
            ? 'must_ask'
            : 'last_resort',
      })
    );
  }
  return cards;
}

/** The saved reply for one persisted turn, re-emitted by the retry dedup-and-replay path. */
export interface ReplayTurn {
  id: string;
  agentResponse: string;
  warnings: SessionWarning[];
  reasoning: ReasoningStep[];
}

/**
 * Look up a single persisted turn by the idempotency key of the send attempt that produced it, for
 * the retry dedup-and-replay path (F7.x). When a retry re-sends a key whose turn the server already
 * persisted — the narrow case where the first attempt's reply streamed AND persisted but the
 * connection dropped before the client saw the stream close — the messages route replays this saved
 * reply instead of re-running the turn, so the retry can never mint a duplicate row or re-spend on
 * the LLM. Returns null when no turn carries the key (the common case: the first attempt failed
 * before persisting, so the retry runs fresh). `warnings`/`reasoning` are validated at this boundary
 * exactly as the transcript replay does, failing soft to empty.
 */
export async function findTurnByIdempotencyKey(
  sessionId: string,
  idempotencyKey: string
): Promise<ReplayTurn | null> {
  const row = await prisma.appQuestionnaireTurn.findUnique({
    where: { sessionId_idempotencyKey: { sessionId, idempotencyKey } },
    select: { id: true, agentResponse: true, warnings: true, reasoning: true },
  });
  if (!row) return null;
  return {
    id: row.id,
    agentResponse: row.agentResponse,
    warnings: warningsSchema.parse(row.warnings),
    reasoning: reasoningSchema.parse(row.reasoning),
  };
}

/**
 * Rebuild the Preview Turn Inspector's per-turn agent-call traces from their persisted rows, so a
 * resumed admin preview re-hydrates the inspector drawer instead of leaving it empty until the next
 * live turn — the drawer's `inspectorTurns` is otherwise fed ONLY by live SSE `inspector` frames,
 * which a reload discards. The data has been persisted on every turn since phase B; this is the
 * read side the drawer hydration was missing.
 *
 * The caller MUST gate this to a preview session with `previewInspectorEnabled` on — the traces are
 * admin-only telemetry (the same gate the live-emit frame in the messages route enforces). Each
 * turn's `turnIndex` reproduces the value the live frame used (`selectionRound` = the number of
 * turns taken before this one = the 1-based `ordinal` minus 1), so a hydrated turn maps to the same
 * transcript user message the drawer derives its evaluation context from. Turns with no captured
 * calls — or a malformed `inspectorCalls` JSON — are skipped; like the transcript replay it backs,
 * this never throws.
 */
export async function loadInspectorTurns(sessionId: string): Promise<TurnInspectorData[]> {
  const rows = await prisma.appQuestionnaireTurn.findMany({
    where: { sessionId },
    orderBy: { ordinal: 'asc' },
    select: { ordinal: true, inspectorCalls: true },
  });

  const inspectorTurns: TurnInspectorData[] = [];
  for (const row of rows) {
    // `inspectorTurnSchema` requires `calls.min(1)`, so a turn that captured nothing fails the
    // parse and is skipped — exactly the live behaviour (the frame only emits when calls exist).
    const parsed = inspectorTurnSchema.safeParse({
      turnIndex: row.ordinal - 1,
      calls: row.inspectorCalls,
    });
    if (parsed.success) inspectorTurns.push(parsed.data);
  }
  return inspectorTurns;
}

/** Narrow the stored `type` string; an unrecognised value degrades to free text (no card). */
function asQuestionType(value: string): QuestionType {
  return (QUESTION_TYPES as readonly string[]).includes(value)
    ? (value as QuestionType)
    : 'free_text';
}
