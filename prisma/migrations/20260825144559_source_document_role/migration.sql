-- A version's source documents are no longer all the same kind of thing.
--
-- `primary` is the document the version's structure was extracted from; re-ingest appends a newer
-- one that supersedes it. `supplementary` is a companion an admin attached for context — a routing
-- memo beside a question bank — which never touches the extracted structure.
--
-- The default is `primary`, so every existing row keeps exactly the meaning it had: readers that
-- took "the newest document" now take "the newest primary document", and on a database written
-- before this migration those are the same row.

ALTER TABLE "app_questionnaire_source_document"
  ADD COLUMN "role" TEXT NOT NULL DEFAULT 'primary';
