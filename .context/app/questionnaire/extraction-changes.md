# Questionnaire — extraction change records

> The revertible audit trail of every editorial decision the extractor makes. The
> write path is built by **F1.1** ([`../planning/features/f1.1.md`](../planning/features/f1.1.md));
> the list/revert review surface is **F2.3**.

## Why it exists

The extractor is **opinionated, not literal** — it prunes boilerplate, fixes
typos, rewrites terse prompts, infers question types, merges duplicates, splits
compound questions, and infers a goal/audience. Every such decision is recorded
as one `AppQuestionnaireExtractionChange` row so the admin can see what the model
changed and, in F2.3, revert it. A **verbatim, unedited question produces no
record** — the log is a diff against the source, not a transcript.

Conservative default: when unsure whether a span is content or boilerplate,
**keep it**. Pruning is reversible; a question the admin remembers but the model
dropped is the worse failure.

## The model

`AppQuestionnaireExtractionChange` (see
[`schema.md`](./schema.md) and `prisma/schema/app-questionnaire.prisma`):

| Field              | Meaning                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| `changeType`       | The decision (vocabulary below).                                                |
| `targetEntityType` | `section` \| `question` \| `version`.                                           |
| `targetEntityId`   | Resolved to the version for `infer_*`; null for section/question edits.         |
| `sourceQuote`      | The span in the source document the decision came from.                         |
| `beforeJson`       | Pre-change state — **the only place pruned data survives**. Restored on revert. |
| `afterJson`        | Post-change state. **Null for `prune_*`.**                                      |
| `rationale`        | One-line, LLM-reported.                                                         |
| `confidence`       | 0–1, optional.                                                                  |
| `status`           | `applied` \| `reverted` (F2.3 flips it; sets `revertedAt`/`revertedByUserId`).  |

## Vocabulary

The model + write helper support the full deep-spec set; the F1.1 extractor emits
the editorial + inference decisions a conservative-but-opinionated pass produces:

`prune_section`, `prune_question`, `correct_spelling`, `correct_grammar`,
`rewrite_prompt`, `infer_type`, `merge_questions`, `split_question`,
`add_section`, `augment_question`, `infer_goal`, `infer_audience`.

Single source of truth: `CHANGE_TYPES` in
`lib/app/questionnaire/ingestion/types.ts` (the Zod schema derives its enum from
it).

## How records are produced

1. The LLM returns a `changes[]` array alongside the structure (the PR2 Zod
   contract validates each entry **structurally** — valid enum members, in-range
   confidence).
2. `normalizeChangeRecords` (`lib/app/questionnaire/ingestion/change-records.ts`,
   pure) applies **semantic** coherence and **suppression**:
   - `prune_*` ⇒ `afterJson` forced null, must target an entity (not the version);
   - `infer_*` ⇒ must target the version; `infer_audience` keeps only the keys the
     admin did **not** supply;
   - inference for an admin-supplied field is **dropped entirely** (no record);
   - incoherent records (e.g. a non-infer change claiming `version`) are dropped
     with a logged reason rather than persisted wrong.
     It returns version-agnostic `ChangeRecordIntent[]`.
3. `persistIngestion` (`app/api/v1/app/questionnaires/_lib/persist.ts`) attaches
   `versionId`, resolves `targetEntityId` (version-level for `infer_*`, null
   otherwise — the LLM intent carries no entity-id linkage), and writes the rows in
   the same transaction as the graph.

### `targetEntityId` is null for section/question edits — by design

The LLM's reported change does not carry a stable link to the specific persisted
section/question it edited. Rather than guess, F1.1 leaves `targetEntityId` null
for entity-targeted edits; F2.3's review surface reconciles them against
`sourceQuote` + `beforeJson`/`afterJson`. `infer_goal` / `infer_audience` target
the version, so their `targetEntityId` is the version id and revert clears exactly
those version fields.

## Revert (F2.3)

F2.3 lists a version's records and reverts any one of them, restoring the graph to
its pre-change state and flipping `status` to `reverted` (with
`revertedAt`/`revertedByUserId`). A **pure planner** (`planRevert` in
`lib/app/questionnaire/extraction-review/`) decides what a revert _means_ as
primitive graph ops; the executor (`_lib/extraction-review-routes.ts`) applies
them. The honest posture is **fail cleanly, never guess-and-corrupt** — any
ambiguity returns a typed `RevertImpossible` reason (→ `422 REVERT_IMPOSSIBLE`),
not a silent wrong mutation.

Revert semantics by confidence:

- **Faithful.** `infer_goal` / `infer_audience` clear the version field(s) the
  inference set (`infer_audience` clears only the still-inferred key subset; a
  drift guard refuses a field the admin re-supplied since). `prune_section` /
  `prune_question` re-create the dropped entity from `beforeJson` (the only copy),
  appended at the end with a fresh per-version key.
- **Best-effort, fails cleanly.** `rewrite_prompt`, `correct_*`, `infer_type`,
  `augment_question` have a null `targetEntityId`, so revert reconciles the target
  by matching `afterJson` against the live graph (tie-broken by `sourceQuote`).
  Zero matches → `target_not_found`; multiple → `ambiguous_target`.
- **Structural, default-fail.** `merge_questions` / `split_question` /
  `add_section` have no faithful inverse from free-form JSON; they revert only when
  `beforeJson` carries enough to reconstruct and all products reconcile uniquely,
  else `structural_inverse_unavailable` / `graph_drift`. Never a half-restored graph.

**Block, don't cascade.** The reconciliation _is_ the dependency guard: a later
edit to the same entity makes `afterJson` stop matching, so the revert is refused
(`target_not_found` / `graph_drift`) rather than undoing intervening work. The
review UI orders changes newest-first and pre-computes each row's `revertable`
verdict so the admin reverts in the safe order.

**Fork marks the source row.** A fork starts a clean editorial lineage (it copies
no change records), so reverting on a launched version applies the inverse mutation
to the forked **draft** and marks the change row — which records the decision —
`reverted` on the **source** version. The planner is dry-run _before_ the fork so a
doomed revert leaves no orphan draft. Only `applied` rows are revertible; a
re-revert is a `409`.
