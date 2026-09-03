-- Give the builder a place to hold in-progress capability settings.
--
-- Toggling a capability previously appended a ConfigVersion, so the version
-- history filled with states the user never chose to deploy and "latest
-- version" stopped meaning anything. Versions are now append-only snapshots
-- produced only by an explicit generate action; the working draft lives here.
--
-- Additive: one nullable column.

-- AlterTable
ALTER TABLE "sites" ADD COLUMN "draft_settings" JSONB;
