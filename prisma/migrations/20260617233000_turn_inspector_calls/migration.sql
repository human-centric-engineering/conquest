-- AddColumn: persisted Turn Inspector dump (AgentCallTrace[]) for every session, so a chat looked
-- up by its publicRef can be re-evaluated against the exact calls it ran.
ALTER TABLE "app_questionnaire_turn" ADD COLUMN "inspectorCalls" JSONB NOT NULL DEFAULT '[]';
