# Questionnaire ingestion test fixtures (F1.1)

Synthetic content for testing the ingestion pipeline. **No third-party content is
reproduced here** — every fixture was written for this repository.

These exist so the extractor's opinionated editorial behaviour can be exercised
end-to-end (PR3 capability dispatch with a mocked provider; PR4 route + manual
`curl` verification against a real dev provider).

## Files

- **`sample-questionnaire.md`** — a deliberately messy questionnaire. By design it
  contains, so the editorial change types fire:
  - a **typo** (`adress`) → `correct_spelling`
  - a superfluous **"For office use only"** block → `prune_section`
  - a **compound question** ("name and email") → `split_question`
  - a **duplicate pair** (the phone number asked twice) → `merge_questions`
  - terse prompts an opinionated pass should rewrite → `rewrite_prompt`
  - no explicit goal/audience statement → `infer_goal` / `infer_audience`

The route/integration tests mock the LLM, so they assert wiring and persistence,
not the model's editorial judgement. Use this fixture with a real provider for the
manual verification step in `.context/app/planning/features/f1.1.md`.
