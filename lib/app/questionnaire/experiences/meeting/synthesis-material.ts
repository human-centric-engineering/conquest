/**
 * What the breakout synthesiser reads (P15.5).
 *
 * **Data slots, rationales, movement, and the questionnaire's own background — never raw chat.**
 * That is the point of the data-slot layer: it is the semantic answer vocabulary, already
 * normalised away from how any individual happened to phrase things. Feeding transcripts to a
 * synthesis that gets read aloud to the room would drag in verbatim wording, side remarks and
 * disclosures that were never meant for the group, and it would make de-identification a
 * post-hoc filtering problem instead of a structural property of the input.
 *
 * ## Movement is material, not metadata
 *
 * `refinementHistory` carries `previousValue → newValue` plus the rationale for the change and the
 * confidence either side. A position that MOVED during a conversation is often the most
 * interesting thing in the room — "four of you started one place and ended somewhere else, and
 * here is what shifted you" is a better facilitation prompt than any static tally. So movement is
 * assembled as first-class material, not left implicit in a final value.
 *
 * ## Participants are indices, never people
 *
 * Every participant is `P1`, `P2`, … within one breakout's material. The synthesiser needs to know
 * that two positions came from the SAME person (otherwise it cannot tell a genuine split from one
 * person contradicting themselves) but it must never see a name, an email, or a session id. The
 * indices are local to the material and carry no meaning outside it.
 *
 * Pure — the Prisma read lives in the service layer and hands rows to {@link buildSynthesisMaterial}.
 */

import type { RefinementHistoryEntry } from '@/lib/app/questionnaire/refinement/types';

/* -------------------------------------------------------------------------- */
/* Input rows                                                                 */
/* -------------------------------------------------------------------------- */

/** One data slot's definition — the background that tells the synthesiser what was being asked. */
export interface SynthesisSlotDefinition {
  key: string;
  name: string;
  description: string | null;
  theme: string | null;
}

/** One respondent's fill for one slot, as loaded from `AppDataSlotFill`. */
export interface SynthesisFillRow {
  /** Groups rows by respondent WITHOUT identifying them; mapped to `P1`, `P2`, … below. */
  sessionId: string;
  slotKey: string;
  value: unknown;
  /** The respondent's position in natural words — preferred over `value` for reading. */
  paraphrase: string | null;
  confidence: number | null;
  /** Why the pipeline recorded this — the reasoning behind the fill. */
  rationale: string | null;
  provenanceLabel: string;
  /** `RefinementHistoryEntry[]`, already narrowed by the caller. */
  refinementHistory: RefinementHistoryEntry[];
}

/** The questionnaire's own framing — what this breakout was actually asking the room. */
export interface SynthesisBackground {
  questionnaireTitle: string;
  goal: string | null;
  /** The breakout's authored framing, so the synthesis answers the question that was posed. */
  breakoutTitle: string;
  briefing: string | null;
  /** What the author wants this particular breakout's synthesis to look for. */
  synthesisFocus: string | null;
}

/* -------------------------------------------------------------------------- */
/* Assembled material                                                         */
/* -------------------------------------------------------------------------- */

/** One participant's stated position on one slot. */
export interface MaterialPosition {
  /** `P1`, `P2`, … — local to this material, meaningless outside it. */
  participant: string;
  /** The position in words. Falls back to the structured value when no paraphrase exists. */
  text: string;
  confidence: number | null;
  rationale: string | null;
  /** True when the pipeline inferred this rather than the respondent stating it directly. */
  inferred: boolean;
}

/** One position that MOVED during the conversation — the story worth telling. */
export interface MaterialMovement {
  participant: string;
  from: string;
  to: string;
  /** Why it moved, in the refiner's words. */
  rationale: string;
  /** Confidence either side, when scored — a position can firm up without changing. */
  confidenceBefore: number | null;
  confidenceAfter: number | null;
}

/** Everything the synthesiser gets about one data slot. */
export interface MaterialSlot {
  key: string;
  name: string;
  description: string | null;
  theme: string | null;
  /** How many participants answered this slot at all — the denominator for any claim. */
  respondedCount: number;
  positions: MaterialPosition[];
  movements: MaterialMovement[];
}

/** The complete input to a breakout synthesis. */
export interface SynthesisMaterial {
  background: SynthesisBackground;
  /** How many participants completed the breakout — the denominator for the whole synthesis. */
  participantCount: number;
  slots: MaterialSlot[];
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Render a fill's position as readable text.
 *
 * Paraphrase first: it is the respondent's position in natural words, which is what a synthesis
 * should reason over. `String(value)` is the fallback and is guarded — an object-valued slot would
 * otherwise stringify to `[object Object]` and silently replace a real answer with a meaningless
 * token the model has no way to recognise as a substitution. (The same bug lint caught in the
 * carry-over prompts; the fix belongs everywhere a fill reaches a prompt.)
 */
export function positionText(fill: { paraphrase: string | null; value: unknown }): string {
  const paraphrase = fill.paraphrase?.trim();
  if (paraphrase) return paraphrase;
  const { value } = fill;
  if (value === null || value === undefined) return '(no answer)';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Arrays and objects: JSON rather than `[object Object]`.
  try {
    return JSON.stringify(value);
  } catch {
    return '(unreadable answer)';
  }
}

/** Render one side of a movement, reusing the same value-safety rules. */
function movementSide(value: unknown): string {
  return positionText({ paraphrase: null, value });
}

/**
 * Stable anonymous labels for the participants in one breakout.
 *
 * Assigned in the order sessions first appear so the labels are deterministic for a given input —
 * which matters for tests, for a re-run producing comparable material, and for a facilitator who
 * regenerates a synthesis mid-meeting and would otherwise see everything renumbered.
 */
function labelParticipants(rows: readonly SynthesisFillRow[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const row of rows) {
    if (!labels.has(row.sessionId)) labels.set(row.sessionId, `P${labels.size + 1}`);
  }
  return labels;
}

/**
 * Assemble everything the synthesiser reads for one breakout.
 *
 * `participantCount` is passed in rather than derived from the rows: it is the number of people who
 * COMPLETED the breakout, which is the honest denominator. Deriving it from fills would count only
 * those who answered something, quietly inflating every proportion — "everyone agreed" when in
 * truth half the room said nothing.
 */
export function buildSynthesisMaterial(params: {
  background: SynthesisBackground;
  definitions: readonly SynthesisSlotDefinition[];
  fills: readonly SynthesisFillRow[];
  participantCount: number;
}): SynthesisMaterial {
  const { background, definitions, fills, participantCount } = params;
  const labels = labelParticipants(fills);

  const byKey = new Map<string, SynthesisFillRow[]>();
  for (const fill of fills) {
    const list = byKey.get(fill.slotKey);
    if (list) list.push(fill);
    else byKey.set(fill.slotKey, [fill]);
  }

  const slots: MaterialSlot[] = definitions.map((def) => {
    const rows = byKey.get(def.key) ?? [];

    const positions: MaterialPosition[] = rows.map((row) => ({
      participant: labels.get(row.sessionId) ?? 'P?',
      text: positionText(row),
      confidence: row.confidence,
      rationale: row.rationale,
      // An inferred position carries less weight than a stated one, and a synthesis that treated
      // them alike would report the pipeline's guesses back to the room as the room's own words.
      inferred: row.provenanceLabel !== 'direct',
    }));

    const movements: MaterialMovement[] = rows.flatMap((row) =>
      row.refinementHistory
        // A movement with no rationale tells no story — it is a bare value swap, usually a
        // mechanical correction, and including it would pad the material with noise.
        .filter((entry) => entry.rationale?.trim())
        .map((entry) => ({
          participant: labels.get(row.sessionId) ?? 'P?',
          from: movementSide(entry.previousValue),
          to: movementSide(entry.newValue),
          rationale: entry.rationale,
          confidenceBefore: entry.previousConfidence ?? null,
          confidenceAfter: entry.newConfidence ?? null,
        }))
    );

    return {
      key: def.key,
      name: def.name,
      description: def.description,
      theme: def.theme,
      respondedCount: rows.length,
      positions,
      movements,
    };
  });

  return { background, participantCount, slots };
}

/**
 * Whether there is enough here to synthesise at all.
 *
 * Below the support floor the gate would suppress every finding anyway, so running the model would
 * spend money to produce nothing. The caller shows "not enough responses yet" instead — which is
 * also the honest thing to tell a facilitator watching a room of three.
 */
export function hasEnoughToSynthesise(material: SynthesisMaterial, minSupport: number): boolean {
  const floor = Math.max(2, Math.floor(minSupport));
  return material.slots.some((slot) => slot.respondedCount >= floor);
}
