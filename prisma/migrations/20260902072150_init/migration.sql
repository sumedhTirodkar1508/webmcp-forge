-- CreateEnum
CREATE TYPE "site_status" AS ENUM ('DRAFT', 'SCANNED', 'CONFIGURED', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "platform" AS ENUM ('FRAMER', 'WIX', 'WEBFLOW', 'SQUARESPACE', 'NEXTJS', 'CUSTOM', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "page_type" AS ENUM ('HOME', 'ABOUT', 'WORK_INDEX', 'PROJECT_DETAIL', 'EXPERIENCE', 'EDUCATION', 'CONTACT', 'BLOG', 'OTHER');

-- CreateEnum
CREATE TYPE "scan_status" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "verification_outcome" AS ENUM ('SUCCESS', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "ai_purpose" AS ENUM ('SEMANTIC_MAPPING', 'NL_DEMO');

-- CreateEnum
CREATE TYPE "ai_attempt_status" AS ENUM ('SUCCESS', 'TRANSIENT_ERROR', 'RATE_LIMITED', 'QUOTA_EXHAUSTED', 'AUTH_ERROR', 'INVALID_REQUEST', 'SCHEMA_INVALID', 'TIMEOUT', 'UNKNOWN_ERROR');

-- CreateTable
CREATE TABLE "builder_sessions" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "builder_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sites" (
    "id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "created_by_session_id" UUID NOT NULL,
    "owner_user_id" UUID,
    "canonical_url" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "platform" "platform" NOT NULL DEFAULT 'UNKNOWN',
    "title" TEXT,
    "status" "site_status" NOT NULL DEFAULT 'DRAFT',
    "published_config_version_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_pages" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "pathname" TEXT NOT NULL,
    "route_pattern" TEXT,
    "page_type" "page_type" NOT NULL DEFAULT 'OTHER',
    "http_status" INTEGER,
    "content_type" TEXT,
    "byte_size" INTEGER,
    "title" TEXT,
    "low_information" BOOLEAN NOT NULL DEFAULT false,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_runs" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "status" "scan_status" NOT NULL DEFAULT 'PENDING',
    "pages_scanned" INTEGER NOT NULL DEFAULT 0,
    "pages_failed" INTEGER NOT NULL DEFAULT 0,
    "deterministic" JSONB,
    "semantic" JSONB,
    "semantic_model" TEXT,
    "semantic_attempts" INTEGER NOT NULL DEFAULT 0,
    "semantic_fell_back" BOOLEAN NOT NULL DEFAULT false,
    "warnings" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "scan_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "config_versions" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "runtime_config" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "config_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_challenges" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "challenge_hash" TEXT NOT NULL,
    "expected_origin" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_runs" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "challenge_id" UUID,
    "config_version_id" UUID,
    "runtime_version" TEXT,
    "reported_origin" TEXT,
    "reported_path" TEXT,
    "webmcp_available" BOOLEAN NOT NULL DEFAULT false,
    "tools_registered" INTEGER NOT NULL DEFAULT 0,
    "live_counts" JSONB,
    "diagnostics" JSONB,
    "outcome" "verification_outcome" NOT NULL DEFAULT 'FAILED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_events" (
    "id" UUID NOT NULL,
    "site_id" UUID,
    "scan_run_id" UUID,
    "purpose" "ai_purpose" NOT NULL,
    "model" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "ai_attempt_status" NOT NULL,
    "error_code" TEXT,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "builder_sessions_token_hash_key" ON "builder_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "builder_sessions_expires_at_idx" ON "builder_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "sites_public_id_key" ON "sites"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "sites_published_config_version_id_key" ON "sites"("published_config_version_id");

-- CreateIndex
CREATE INDEX "sites_created_by_session_id_idx" ON "sites"("created_by_session_id");

-- CreateIndex
CREATE INDEX "sites_origin_idx" ON "sites"("origin");

-- CreateIndex
CREATE INDEX "site_pages_site_id_route_pattern_idx" ON "site_pages"("site_id", "route_pattern");

-- CreateIndex
CREATE UNIQUE INDEX "site_pages_site_id_url_key" ON "site_pages"("site_id", "url");

-- CreateIndex
CREATE INDEX "scan_runs_site_id_started_at_idx" ON "scan_runs"("site_id", "started_at");

-- CreateIndex
CREATE INDEX "config_versions_site_id_created_at_idx" ON "config_versions"("site_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "config_versions_site_id_version_key" ON "config_versions"("site_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "verification_challenges_challenge_hash_key" ON "verification_challenges"("challenge_hash");

-- CreateIndex
CREATE INDEX "verification_challenges_site_id_created_at_idx" ON "verification_challenges"("site_id", "created_at");

-- CreateIndex
CREATE INDEX "verification_challenges_expires_at_idx" ON "verification_challenges"("expires_at");

-- CreateIndex
CREATE INDEX "verification_runs_site_id_created_at_idx" ON "verification_runs"("site_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_usage_events_site_id_purpose_created_at_idx" ON "ai_usage_events"("site_id", "purpose", "created_at");

-- CreateIndex
CREATE INDEX "ai_usage_events_scan_run_id_idx" ON "ai_usage_events"("scan_run_id");

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_created_by_session_id_fkey" FOREIGN KEY ("created_by_session_id") REFERENCES "builder_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_published_config_version_id_fkey" FOREIGN KEY ("published_config_version_id") REFERENCES "config_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_pages" ADD CONSTRAINT "site_pages_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "config_versions" ADD CONSTRAINT "config_versions_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_challenges" ADD CONSTRAINT "verification_challenges_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "verification_challenges"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_config_version_id_fkey" FOREIGN KEY ("config_version_id") REFERENCES "config_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_scan_run_id_fkey" FOREIGN KEY ("scan_run_id") REFERENCES "scan_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
