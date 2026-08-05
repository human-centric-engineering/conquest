-- Retire the mis-attribution of inbound traffic to the operator who
-- configured the trigger (issue #502).
--
-- Until now the inbound route stamped `trigger.createdBy` onto the
-- conversation and execution rows it created. The data on those rows belongs
-- to whoever sent the message: a phone number and message body from Twilio,
-- From/Subject/body and attachments from Postmark. Both `userId` columns are
-- `onDelete: Cascade`, so erasing one operator destroyed every third party's
-- correspondence routed through their triggers, and a subject-access export
-- disclosed it to them as their own data.
--
-- The write paths now record these rows as system-owned (`userId = NULL`).
-- This backfills the history, which carries exactly the same cascade risk.
--
-- Attribution is preserved elsewhere: `ai_workflow_trigger.createdBy` still
-- names the operator, and `triggerSource` still records the channel.

-- Inbound conversations. `channel` is set only by the inbound conversation
-- resolver — the streaming chat handler never writes it — so a non-NULL
-- channel is exactly the inbound set.
UPDATE "ai_conversation"
SET "userId" = NULL
WHERE "channel" IS NOT NULL
  AND "userId" IS NOT NULL;

-- Inbound executions. `triggerSource` is written as `inbound:<channel>` by
-- the inbound route alone.
UPDATE "ai_workflow_execution"
SET "userId" = NULL
WHERE "triggerSource" LIKE 'inbound:%'
  AND "userId" IS NOT NULL;

-- NOT backfilled: historical scheduled runs. The scheduler left
-- `triggerSource` NULL until this change, so a pre-existing scheduled run is
-- indistinguishable from a run an admin started by hand — and nulling the
-- latter would hide a person's own runs from them. Those rows keep their
-- author. What they hold is the operator's own `inputTemplate`, not a third
-- party's message, so the disclosure half does not apply; the residue is that
-- erasing that operator still takes their historical scheduled runs with
-- them. Runs created from now on carry `triggerSource = 'schedule'`, which
-- makes them identifiable if a future backfill is ever wanted.
