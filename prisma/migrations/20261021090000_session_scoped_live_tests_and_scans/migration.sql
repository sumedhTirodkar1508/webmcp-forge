-- Tie live tests and scan-rate accounting to the browser session that caused them.
--
-- Sites are permanent per origin, so everything keyed on "the site" is shared
-- by every visitor of that origin:
--
--   * A live test was found, driven and closed by site id alone, so a second
--     visitor of the same site could send commands to the first visitor's
--     connected tab. It now records the session that started it.
--
--   * The hourly scan limit counted scans on sites the session had *created*.
--     Only the first visitor to an origin ever created its site, so scans of an
--     origin someone else registered first were never counted. Scans now record
--     the session that started them and are counted by that.
--
-- Additive: two nullable columns, two indexes, two foreign keys that null the
-- column if the session row is ever deleted. Existing rows keep NULL, which
-- matches no session: old live tests expired within minutes anyway, and old scan
-- rows are more than an hour old, so neither affects any current limit.

-- AlterTable
ALTER TABLE "scan_runs" ADD COLUMN     "session_id" UUID;

-- AlterTable
ALTER TABLE "live_test_sessions" ADD COLUMN     "created_by_session_id" UUID;

-- CreateIndex
CREATE INDEX "scan_runs_session_id_started_at_idx" ON "scan_runs"("session_id", "started_at");

-- CreateIndex
CREATE INDEX "live_test_sessions_site_id_created_by_session_id_status_idx" ON "live_test_sessions"("site_id", "created_by_session_id", "status");

-- AddForeignKey
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "builder_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_test_sessions" ADD CONSTRAINT "live_test_sessions_created_by_session_id_fkey" FOREIGN KEY ("created_by_session_id") REFERENCES "builder_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
