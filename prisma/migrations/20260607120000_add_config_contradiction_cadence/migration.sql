-- Contradiction-detection cadence (deferred-gaps audit, Item 5 sibling — the F4.3
-- `every_n_turns` cost knob, deferred to the live loop and never landed).
--
-- Adds the per-version knob that controls how often the live turn loop runs
-- contradiction detection: every N respondent turns. Defaults to 1 (every turn), so
-- an unconfigured version behaves exactly as before. Distinct from
-- `contradictionWindowN`, which is a *comparison window* (how many prior answers to
-- check), not a cadence.

-- AlterTable
ALTER TABLE "app_questionnaire_config" ADD COLUMN     "contradictionEveryNTurns" INTEGER NOT NULL DEFAULT 1;
