-- A site must outlive the browser session that created it.
--
-- `sites.created_by_session_id` cascaded from `builder_sessions`, so deleting
-- an expired session would delete the site — and with it every scan, config
-- and verification, while the real website kept serving a `data-wmf-site` that
-- no longer resolved. Attribution should not own the row's lifetime.
--
-- Widening a column to nullable and relaxing a foreign key deletes no data.

-- AlterTable
ALTER TABLE "sites" ALTER COLUMN "created_by_session_id" DROP NOT NULL;

-- DropForeignKey
ALTER TABLE "sites" DROP CONSTRAINT "sites_created_by_session_id_fkey";

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_created_by_session_id_fkey"
  FOREIGN KEY ("created_by_session_id") REFERENCES "builder_sessions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
