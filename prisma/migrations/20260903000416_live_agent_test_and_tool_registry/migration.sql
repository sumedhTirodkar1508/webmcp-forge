-- CreateEnum
CREATE TYPE "live_test_status" AS ENUM ('PENDING', 'READY', 'CLOSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "live_test_command_status" AS ENUM ('PENDING', 'DISPATCHED', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "verification_runs" ADD COLUMN     "tool_registry" JSONB;

-- CreateTable
CREATE TABLE "live_test_sessions" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expected_origin" TEXT NOT NULL,
    "status" "live_test_status" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ready_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "runtime_version" TEXT,
    "available_tools" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_test_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_test_commands" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "tool" TEXT NOT NULL,
    "arguments" JSONB NOT NULL,
    "status" "live_test_command_status" NOT NULL DEFAULT 'PENDING',
    "dispatched_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "result" TEXT,
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_test_commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "live_test_sessions_token_hash_key" ON "live_test_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "live_test_sessions_site_id_created_at_idx" ON "live_test_sessions"("site_id", "created_at");

-- CreateIndex
CREATE INDEX "live_test_sessions_expires_at_idx" ON "live_test_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "live_test_commands_session_id_status_created_at_idx" ON "live_test_commands"("session_id", "status", "created_at");

-- AddForeignKey
ALTER TABLE "live_test_sessions" ADD CONSTRAINT "live_test_sessions_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_test_commands" ADD CONSTRAINT "live_test_commands_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "live_test_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
