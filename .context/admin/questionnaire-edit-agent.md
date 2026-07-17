# Structure Edit Agent — instruction-driven whole-doc editing

> "Edit with AI." On the version **Structure editor**, an admin types a plain-English instruction
> for the WHOLE questionnaire — "renumber the sections", "use CAPS for every section title", "remove
> required from all free-text questions" — and the agent applies it across every matching section and
> question. It **always previews the exact changes and waits for a confirm click** before writing.

## Two modes

| Mode                  | What the LLM does                                                | Persistence path                                | Use for                                    |
| --------------------- | ---------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| **Precise** (default) | Translates the instruction into a list of deterministic edit-ops | Granular per-entity updates in one transaction  | Mechanical bulk edits — never drifts       |
| **Rewrite**           | Rewrites the whole structure (the `compose/refine` capability)   | `replaceVersionStructure` (whole-graph rewrite) | Broad/semantic changes ("make it shorter") |

In **precise** mode the model's only job is interpretation — the edit-ops execute in code (`resolve.ts`),
so untouched fields are preserved and the result is identical every time. This is deliberately NOT routed
through `replaceVersionStructure`, which rewrites the whole graph and **resets `weight`→0.5 and
`required`→optional** — fine for a regenerate, wrong for a surgical edit.

## The edit-op vocabulary

`lib/app/questionnaire/edit-agent/edit-ops.ts` defines the validated `EditOp` union:
`set_required`, `set_weight`, `transform_prompt`, `rename_prompt`, `transform_title`,
`set_section_title`, `renumber_sections`, `reorder_sections`, `move_question`. Targets are selected by
a `QuestionSelector` (`all` | `section` | `type` | `keys`) or a `SectionSelector` (`all` | `ordinals`).
Anything needing semantic rewriting of content belongs in **rewrite** mode, not here.

## Flow

```
plan  (POST .../edit-agent/plan)   →  preview, NO write
        precise: translateInstruction → resolveOps → ResolvedChange[]
        rewrite: refine capability    → proposed structure + outline
apply (POST .../edit-agent/apply)  →  write
        precise: re-load live structure → re-resolve ops → granular updates (1 tx)
        rewrite: assertPersistable → replaceVersionStructure
```

Apply **re-resolves against the live DB** (the preview is advisory), so a concurrent edit can't be
silently clobbered. Both routes are guarded to **draft** versions with **no respondent sessions**
(`loadEditableStructure` / `loadRefinableStructure`), admin-only, and rate-limited by the shared
per-admin `composeLimiter`.

## Files

| Concern                       | File                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------- |
| Edit-op schema + JSON shape   | `lib/app/questionnaire/edit-agent/edit-ops.ts`                                   |
| Deterministic executor (diff) | `lib/app/questionnaire/edit-agent/resolve.ts`                                    |
| Instruction → ops (LLM)       | `lib/app/questionnaire/edit-agent/translate.ts` (+ `translate-prompt.ts`)        |
| Server loader + apply (tx)    | `app/api/v1/app/questionnaires/_lib/edit-agent-pipeline.ts`                      |
| Routes                        | `app/api/v1/app/questionnaires/[id]/versions/[vid]/edit-agent/{plan,apply}`      |
| Panel UI                      | `components/admin/questionnaires/edit-agent-panel.tsx` (in `version-editor.tsx`) |
| Agent + flag                  | seeds `060-edit-agent.ts`, `059-edit-agent-flag.ts`                              |

## The agent

A distinct seeded `AiAgent` (`app-questionnaire-structure-editor`) carries its own budget and persona
and ships with empty `model`/`provider` (resolved at runtime via `agent-resolver.ts`, reasoning tier).
It is registered in `AGENT_RECOMMENDATIONS`, so it appears on the admin **Agent Settings** page
automatically (no extra wiring) with its recommended temperature / maxTokens / reasoning effort.

## Availability

Always on — there is no feature flag. Both routes and the editor panel are permanently available.
(Questionnaire features are always on; see
[`../app/questionnaire/feature-flags.md`](../app/questionnaire/feature-flags.md).)
