-- Question reservations, an index for the AI budget, and one redundant index.
--
-- 1. RESERVED attempt status. The per-site question limit counted finished
--    questions and then called the model, so several questions sent together
--    could all pass the check before any of them was recorded. A question now
--    reserves its slot first, under a per-site lock, as a RESERVED row that is
--    deleted when it finishes (and ignored after a short TTL if a request
--    dies). RESERVED rows are not model requests and are excluded from every
--    usage count.
--
-- 2. Index on ai_usage_events(created_at). The deployment-wide AI budget counts
--    every row in a rolling 24 hours before each scan and question.
--
-- 3. Drop sites_origin_idx. The initial migration created it; a later one
--    added the unique index sites_origin_key on the same column, which serves
--    every lookup the plain index did. The schema no longer declares it, so it
--    showed up as drift.
--
-- No data is changed or removed.

-- AlterEnum
ALTER TYPE "ai_attempt_status" ADD VALUE 'RESERVED';

-- CreateIndex
CREATE INDEX "ai_usage_events_created_at_idx" ON "ai_usage_events"("created_at");

-- DropIndex (redundant with the unique index "sites_origin_key")
DROP INDEX IF EXISTS "sites_origin_idx";
