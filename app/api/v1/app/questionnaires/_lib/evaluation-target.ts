/**
 * Read-time resolution of a finding's `targetKey` into something an admin can read.
 *
 * A judge addresses its finding by `targetKey` — a slot `key` (`q_role`), `section:<title>`,
 * `goal`, or `audience` — because the pure core has no ids to hand it (see `JudgeFinding`).
 * That key is the right *machine* handle (it survives reordering and is what apply resolves
 * against), but on its own it tells the reviewer nothing: "q_role · Rewrite the question prompt"
 * gives no way to judge the suggestion without opening the structure editor in another tab.
 *
 * So we resolve the key to its subject — the question's prompt, its section, its position —
 * at read time, the same posture as `deriveFindingState`: never stored (a stored prompt would
 * rot the moment the question was reworded), always derived from the structures the read seam
 * already loads. Resolution prefers the **live** structure (what the admin would edit now) and
 * falls back to the run's snapshot, flagging `removed` when only the snapshot knows the target —
 * a question deleted since the run still gets named rather than showing a bare key.
 *
 * Pure: two {@link VersionStructureInput}s in, a view out. No Prisma.
 */

import type { ProposedEdit } from '@/lib/app/questionnaire/evaluation';
import type { StructureQuestion, VersionStructureInput } from '@/lib/app/questionnaire/evaluation';
import { ALWAYS_PHASES } from '@/lib/app/questionnaire/scope/types';
import type { FindingDestinationView, FindingTargetView } from '@/lib/app/questionnaire/views';
import { locateSlot } from '@/app/api/v1/app/questionnaires/_lib/evaluation-staleness';

/** The `section:` prefix a `targetKey` uses to address a section by title. */
const SECTION_PREFIX = 'section:';

/**
 * Whether routing can withhold this question, and from which topic(s) — the reviewer-facing half of
 * the F17.34 overlay.
 *
 * Two things this gets right that the obvious version does not:
 *
 *  - **Gated on `routing.enabled`, not on "the version has topics".** Ingest seeds one `core` topic
 *    per section on every questionnaire, so with the feature off — the default — nearly every
 *    version has full topic coverage. A presence test would chip every finding card in the product
 *    "Always asked", which trains reviewers to ignore the chip.
 *  - **The answer is reach, not phase.** A question can belong to several topics; if ANY of them
 *    always runs, so does the question, whatever the others say. Reporting one topic's phase would
 *    call a question that everyone is asked "conditional".
 *
 * Read from whichever structure named the question — live for a live target, the run's snapshot for
 * one deleted since, so a removed question is not silently reported as unreachable.
 */
function resolveRoutingReach(
  question: StructureQuestion,
  structure: VersionStructureInput | null
): Pick<FindingTargetView, 'routingReach' | 'topicLabel'> {
  const routing = structure?.routing;
  const topicKeys = question.topicKeys;
  if (!routing?.enabled || topicKeys === undefined) {
    return { routingReach: null, topicLabel: null };
  }

  const owning = routing.topics.filter((t) => topicKeys.includes(t.key));
  if (owning.length === 0) return { routingReach: 'never', topicLabel: null };

  const alwaysRuns = owning.some((t) => (ALWAYS_PHASES as readonly string[]).includes(t.phase));
  return {
    routingReach: alwaysRuns ? 'always' : 'conditional',
    topicLabel: owning.map((t) => t.label).join(', '),
  };
}

/** Human labels for the two version-level targets, which have no structure node to name. */
const GOAL_LABEL = 'Questionnaire goal';
const AUDIENCE_LABEL = 'Target audience';

/**
 * Resolve one finding's `targetKey` against the live structure, falling back to the run's
 * snapshot. Returns `null` only when there is no structure to resolve against at all (both
 * loads failed) — the UI then falls back to showing the raw key.
 *
 * A key that resolves in neither structure yields `kind: 'unknown'` with the key as its label:
 * judges occasionally invent a key, and a review card must still render (fail-cleanly, the same
 * posture apply takes when a key doesn't reconcile).
 */
export function resolveFindingTarget(
  targetKey: string,
  current: VersionStructureInput | null,
  snapshot: VersionStructureInput | null
): FindingTargetView | null {
  if (!current && !snapshot) return null;

  if (targetKey === 'goal') {
    return {
      kind: 'goal',
      key: targetKey,
      label: GOAL_LABEL,
      sectionTitle: null,
      position: null,
      sectionPosition: null,
      questionType: null,
      routingReach: null,
      topicLabel: null,
      removed: false,
    };
  }
  if (targetKey === 'audience') {
    return {
      kind: 'audience',
      key: targetKey,
      label: AUDIENCE_LABEL,
      sectionTitle: null,
      position: null,
      sectionPosition: null,
      questionType: null,
      routingReach: null,
      topicLabel: null,
      removed: false,
    };
  }

  if (targetKey.startsWith(SECTION_PREFIX)) {
    const title = targetKey.slice(SECTION_PREFIX.length);
    // A section is addressed by title, which is neither unique nor stable — "removed" here means
    // no live section carries that title any more (the staleness deriver treats ambiguity too,
    // but for *naming* the target a single match isn't required).
    const liveIdx = current?.sections.findIndex((s) => s.title === title) ?? -1;
    // Fall back to the snapshot for *ordering* a since-removed section, the same way a removed
    // question is still named from the snapshot below.
    const idx =
      liveIdx !== -1 ? liveIdx : (snapshot?.sections.findIndex((s) => s.title === title) ?? -1);
    return {
      kind: 'section',
      key: targetKey,
      label: title,
      sectionTitle: null,
      position: null,
      sectionPosition: idx !== -1 ? idx + 1 : null,
      questionType: null,
      routingReach: null,
      topicLabel: null,
      removed: current !== null && liveIdx === -1,
    };
  }

  // A question, addressed by slot key. Prefer the live structure; fall back to the snapshot so a
  // since-deleted question is still named (marked `removed`) rather than shown as a bare key.
  const live = current ? locateSlot(current, targetKey) : null;
  const located = live ?? (snapshot ? locateSlot(snapshot, targetKey) : null);
  if (!located) {
    return {
      kind: 'unknown',
      key: targetKey,
      label: targetKey,
      sectionTitle: null,
      position: null,
      sectionPosition: null,
      questionType: null,
      routingReach: null,
      topicLabel: null,
      removed: false,
    };
  }
  return {
    kind: 'question',
    key: targetKey,
    label: located.question.prompt,
    sectionTitle: located.sectionTitle,
    // 1-based for display — the stored indices are 0-based.
    position: located.indexInSection + 1,
    sectionPosition: located.sectionIndex + 1,
    questionType: located.question.type,
    ...resolveRoutingReach(located.question, live ? current : snapshot),
    removed: live === null,
  };
}

/**
 * Where an `add_question`'s drafted question would land, resolved against the live structure.
 *
 * This mirrors `applyAddQuestion`'s own placement rules on purpose, and the mirroring is the point:
 * the card is telling a reviewer what a click is about to do, so any disagreement between the two
 * is a lie told at the moment it matters most. The rules, in the order apply applies them:
 *
 *  1. `op.sectionKey`, when the judge named one.
 *  2. A `section:<title>` `targetKey`, when the finding itself targets a section.
 *  3. Otherwise the **last** section. Nothing in the suggestion hints at this, which is why the
 *     card says it in words rather than leaving the reviewer to find out afterwards.
 *
 * A named title that no longer resolves to exactly one live section keeps its name but loses its
 * position: that is the same condition `deriveFindingState` reports as `stale`, so the card is
 * already blocking Apply and does not need this to say so twice.
 *
 * One caveat the mirroring does NOT cover, and the reason it is written down rather than left to
 * be discovered: `current` is always built from the URL's version, while `applyAddQuestion` writes
 * into this run's reused review draft once one has been forked. No op in the set mutates the
 * section table, so a fresh draft's sections are byte-identical and the two agree; they can drift
 * only if someone edits sections directly on that draft (via the editor deep-link) between this
 * read and a later apply. The write stays safe either way, because `validateSectionTarget`
 * re-checks live state at write time. The sibling `stale`/`applicable` fields inherit the same
 * seam and the batch-apply route documents it there.
 *
 * Returns `null` for every op that is not `add_question`, including `null` itself, which is a
 * prose-only finding with nothing to place, and for a structure that could not be loaded: an
 * unknown destination has to read as unknown, never as a claim about the questionnaire.
 */
export function resolveAddDestination(
  op: ProposedEdit | null,
  targetKey: string,
  current: VersionStructureInput | null
): FindingDestinationView | null {
  if (op?.op !== 'add_question') return null;

  // "Could not load" is not "has no sections". `loadCurrentStructureSafe` returns null on any DB
  // hiccup, and collapsing that into `origin: 'none'` made the card state a falsehood about the
  // questionnaire ("This questionnaire has no sections") on a transient failure. Worse on the PATCH
  // path, where the destination is recomputed per request but the section list is not: a null
  // title beside a populated list leaves the picker with no matching option, so the browser shows
  // the first section and the reviewer reads a placement nothing chose. Say nothing instead.
  if (!current) return null;

  const sections = current.sections;
  if (sections.length === 0) {
    // A version that genuinely has no sections. Apply answers `needs_authoring`, and the reviewer
    // has to author one before this suggestion can land anywhere.
    return { sectionTitle: null, sectionPosition: null, origin: 'none' };
  }

  const named =
    op.sectionKey ??
    (targetKey.startsWith(SECTION_PREFIX) ? targetKey.slice(SECTION_PREFIX.length) : null);

  if (named !== null) {
    const matches = sections.filter((s) => s.title === named);
    const idx = sections.findIndex((s) => s.title === named);
    return {
      sectionTitle: named,
      // Exactly one match, or no position: a title matching two sections does not identify a place
      // in the questionnaire, and numbering the first of them would invent a certainty apply itself
      // refuses (it answers `op_invalid`).
      sectionPosition: matches.length === 1 ? idx + 1 : null,
      origin: 'chosen',
    };
  }

  const last = sections.length - 1;
  return { sectionTitle: sections[last].title, sectionPosition: last + 1, origin: 'default' };
}
