/**
 * Read-time staleness + applicability derivation for evaluation findings (F5.3).
 *
 * A finding's suggestion can be made obsolete by intervening edits — the question it
 * rewords gets reworded by hand, the section it moves into is deleted, the goal it
 * corrects is rewritten. The review queue must surface that so an admin never applies a
 * stale suggestion. Rather than store a `stale` flag (which would rot the instant the
 * structure changed again), we derive it at read time by diffing the **targeted slice** of
 * the run's `structureSnapshot` (the `VersionStructureInput` captured when the judges ran)
 * against the live structure. Only the specific thing the finding addresses is compared —
 * an unrelated edit elsewhere never falsely stales a finding.
 *
 * Pure: operates on two {@link VersionStructureInput}s + the finding's `targetKey` and
 * effective op. No Prisma — the caller (the run-detail read seam) supplies both structures.
 */

import type {
  FindingApplicability,
  ProposedEdit,
  VersionStructureInput,
  StructureQuestion,
} from '@/lib/app/questionnaire/evaluation';

/** The `section:` prefix a `targetKey` uses to address a section by title. */
const SECTION_PREFIX = 'section:';

/** What the deriver needs about one finding (no DB row dependency). */
export interface StalenessInput {
  /** The finding's `targetKey`: slot `key` | `section:<title>` | `goal` | `audience`. */
  targetKey: string;
  /** The effective op (`editedOverride ?? proposedEdit`), or `null` when prose-only/degraded. */
  op: ProposedEdit | null;
}

/** The derived read-time facts the view carries. */
export interface DerivedFindingState {
  stale: boolean;
  applicable: FindingApplicability;
}

/** A slot located within a structure, with the position fields a `reorder` cares about. */
interface LocatedSlot {
  question: StructureQuestion;
  sectionTitle: string;
  indexInSection: number;
}

/** Find a slot by its stable `key` anywhere in the structure, with its position. */
function locateSlot(structure: VersionStructureInput, key: string): LocatedSlot | null {
  for (const section of structure.sections) {
    const idx = section.questions.findIndex((q) => q.key === key);
    if (idx !== -1) {
      return { question: section.questions[idx], sectionTitle: section.title, indexInSection: idx };
    }
  }
  return null;
}

/** Count sections whose title matches (a title is non-unique + mutable — ambiguity matters). */
function countSectionsByTitle(structure: VersionStructureInput, title: string): number {
  return structure.sections.filter((s) => s.title === title).length;
}

/** Whether the targetKey addresses a section, and the title it names. */
function asSectionTitle(targetKey: string): string | null {
  return targetKey.startsWith(SECTION_PREFIX) ? targetKey.slice(SECTION_PREFIX.length) : null;
}

/**
 * How a finding can be actioned, from its effective op alone:
 * - no op → `manual` (prose-only; the admin edits by hand);
 * - `add_question` → `deep-link` (a draft with no ids — never blind-applied);
 * - any other op → `apply` (a clean structured op).
 */
export function deriveApplicability(op: ProposedEdit | null): FindingApplicability {
  if (!op) return 'manual';
  if (op.op === 'add_question') return 'deep-link';
  return 'apply';
}

/**
 * Is the slot-targeted finding stale? Compares only the fields the op touches; a prose-only
 * finding compares the whole slot content. `delete_question` is stale only if the slot is
 * already gone (deleting an edited question is still valid). `reorder` compares position.
 */
function isSlotFindingStale(
  op: ProposedEdit | null,
  snap: LocatedSlot,
  live: LocatedSlot | null
): boolean {
  if (!live) return true; // target removed since the run
  const a = snap.question;
  const b = live.question;
  switch (op?.op) {
    case 'replace_prompt':
      return a.prompt !== b.prompt;
    case 'edit_guidelines':
      return (a.guidelines ?? null) !== (b.guidelines ?? null);
    case 'change_type':
      return a.type !== b.type;
    case 'reorder':
      return snap.sectionTitle !== live.sectionTitle || snap.indexInSection !== live.indexInSection;
    case 'delete_question':
      return false; // present in both → still deletable, not stale
    default:
      // Prose-only (or an unexpected op): stale if any addressed content changed.
      return (
        a.prompt !== b.prompt ||
        a.type !== b.type ||
        (a.guidelines ?? null) !== (b.guidelines ?? null)
      );
  }
}

/**
 * Derive `{ stale, applicable }` for one finding (F5.3). With no snapshot (a pre-F5.3 run),
 * staleness can't be derived — returns `stale: false` (best-effort), applicability still from
 * the op. Applied/declined findings are terminal and should be short-circuited by the caller
 * before this runs; this function makes no status assumption.
 */
export function deriveFindingState(
  input: StalenessInput,
  snapshot: VersionStructureInput | null,
  current: VersionStructureInput
): DerivedFindingState {
  const op = input.op;
  const applicable = deriveApplicability(op);
  if (!snapshot) return { stale: false, applicable };

  // An `add_question` draft is stale only when it names a section target that's gone or now
  // ambiguous — the place it wanted to land no longer resolves. A goal-targeted add (or one whose
  // section still resolves) stays applyable: adding a question isn't invalidated by edits to the
  // goal text or to existing questions, so those must not falsely stale it.
  if (op?.op === 'add_question') {
    const title = op.sectionKey ?? asSectionTitle(input.targetKey);
    const stale = title !== null ? countSectionsByTitle(current, title) !== 1 : false;
    return { stale, applicable };
  }

  const sectionTitle = asSectionTitle(input.targetKey);
  let stale: boolean;

  if (input.targetKey === 'goal') {
    stale = (snapshot.goal ?? null) !== (current.goal ?? null);
  } else if (input.targetKey === 'audience') {
    if (op?.op === 'edit_audience') {
      // Only the patched sub-fields matter — a change to an untouched field isn't stale.
      const patch = op.audience;
      const patched = Object.keys(patch) as (keyof typeof patch)[];
      stale = patched.some(
        (f) => (snapshot.audience?.[f] ?? null) !== (current.audience?.[f] ?? null)
      );
    } else {
      stale =
        JSON.stringify(snapshot.audience ?? null) !== JSON.stringify(current.audience ?? null);
    }
  } else if (sectionTitle !== null) {
    // A section is addressed by title (non-unique, mutable). Gone or now-ambiguous → stale.
    const liveCount = countSectionsByTitle(current, sectionTitle);
    stale = liveCount !== 1;
  } else {
    // A slot, addressed by key.
    const snap = locateSlot(snapshot, input.targetKey);
    if (!snap) {
      // The key wasn't in the snapshot either — can't reason about drift; defer to apply-time guards.
      stale = false;
    } else {
      stale = isSlotFindingStale(op, snap, locateSlot(current, input.targetKey));
    }
  }

  return { stale, applicable };
}
