-- CreateIndex
CREATE UNIQUE INDEX "sites_created_by_session_id_origin_key" ON "sites"("created_by_session_id", "origin");
