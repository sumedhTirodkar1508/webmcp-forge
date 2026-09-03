-- Separate SITE IDENTITY from BUILDER AUTHORIZATION.
--
-- A site's public_id is embedded permanently in someone's website, so it must
-- survive a cleared cookie. Identity therefore belongs to the origin, and
-- permission to manage the site belongs in its own table.
--
-- This migration is purely additive apart from dropping an index that no
-- longer reflects the model. No rows are deleted and no data is lost.

-- CreateEnum
CREATE TYPE "site_access_grant" AS ENUM ('CREATED', 'DEV_REATTACH');

-- CreateTable
CREATE TABLE "site_access" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "builder_session_id" UUID NOT NULL,
    "granted_via" "site_access_grant" NOT NULL DEFAULT 'CREATED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "site_access_site_id_builder_session_id_key" ON "site_access"("site_id", "builder_session_id");

-- CreateIndex
CREATE INDEX "site_access_builder_session_id_idx" ON "site_access"("builder_session_id");

-- AddForeignKey
ALTER TABLE "site_access" ADD CONSTRAINT "site_access_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_access" ADD CONSTRAINT "site_access_builder_session_id_fkey" FOREIGN KEY ("builder_session_id") REFERENCES "builder_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing site's creating session keeps the access it
-- already effectively had, so no one loses control of a site they built.
INSERT INTO "site_access" ("id", "site_id", "builder_session_id", "granted_via", "created_at")
SELECT gen_random_uuid(), s."id", s."created_by_session_id", 'CREATED', s."created_at"
FROM "sites" s
ON CONFLICT ("site_id", "builder_session_id") DO NOTHING;

-- Identity is no longer scoped to a session. This index is what caused a new
-- anonymous session to mint a second public id for a site Forge already knew
-- about. Dropping an index removes no data.
DROP INDEX IF EXISTS "sites_created_by_session_id_origin_key";
