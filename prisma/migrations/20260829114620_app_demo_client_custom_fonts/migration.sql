-- Custom type for a demo client: the client's own Google Fonts families, plus the woff2 files we
-- fetched and stored for them. Read only when `fontPairing = 'custom'`.
--
-- `customFontFiles` holds storage URLs rather than derived keys because Vercel Blob appends a
-- random suffix to every pathname, so a key alone cannot be turned back into a fetchable URL.
ALTER TABLE "app_demo_client" ADD COLUMN     "customFontBody" TEXT,
ADD COLUMN     "customFontDisplay" TEXT,
ADD COLUMN     "customFontFiles" JSONB;
