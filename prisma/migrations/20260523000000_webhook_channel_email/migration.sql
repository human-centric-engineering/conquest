-- Add a delivery-channel discriminator to event subscriptions so a single
-- subscription can route either to a webhook URL (with HMAC signing) or to
-- an email address (rendered via the generic event-notification template).
-- url / secret become nullable because email rows don't have them; existing
-- rows default to channel = 'webhook' and keep their populated url + secret.

ALTER TABLE "ai_webhook_subscription"
  ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'webhook',
  ADD COLUMN "emailAddress" TEXT,
  ALTER COLUMN "url" DROP NOT NULL,
  ALTER COLUMN "secret" DROP NOT NULL;

CREATE INDEX "ai_webhook_subscription_channel_idx"
  ON "ai_webhook_subscription"("channel");
