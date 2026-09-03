# Resolving duplicate site identities

## Why duplicates exist

Until now a site's identity was `(builder session, origin)`. Clearing browser
storage created a new anonymous session, which then registered a *second*
public id for a website Forge already knew about. The same real site ended up
with two `data-wmf-site` values.

Identity is now the **origin** alone. Authorization moved to `site_access`, so
a cleared cookie costs you permission to edit (recoverable) rather than
rotating an installation id embedded in a live website (not recoverable
without editing that website).

## Current duplicates

Run this read-only query to see them:

```sql
SELECT origin, COUNT(*) AS rows
FROM sites
GROUP BY origin
HAVING COUNT(*) > 1;
```

To see the candidates for one origin, with the information that decides which
is canonical:

```sql
SELECT
  s.id,
  s.public_id,
  s.created_at,
  s.published_config_version_id IS NOT NULL AS is_published,
  (SELECT COUNT(*) FROM scan_runs r WHERE r.site_id = s.id)              AS scans,
  (SELECT COUNT(*) FROM config_versions c WHERE c.site_id = s.id)        AS configs,
  (SELECT COUNT(*) FROM verification_runs v WHERE v.site_id = s.id)      AS verifications,
  (SELECT COUNT(*) FROM ai_usage_events a WHERE a.site_id = s.id)        AS ai_events
FROM sites s
WHERE s.origin = 'https://REPLACE-ME'
ORDER BY s.created_at ASC;
```

## Which row is canonical

The application already resolves this deterministically and never picks the
newest row — see `pickCanonicalSite` in `src/lib/services/site-service.ts`:

1. a site that has published a configuration (something installed points at
   its public id);
2. otherwise the earliest created site for the origin.

**So targeting a duplicated origin is already safe** — it returns the canonical
row and never creates a third. Cleanup is only needed before applying the
unique index in `20260903030000_site_identity_per_origin_global`.

## Cleanup — review before running

> Nothing below is run automatically. Read it, substitute the ids, and run it
> yourself inside a transaction.

Reparent the duplicate's history onto the canonical row, then delete the empty
duplicate. Every child table that references `site_id` is covered:

```sql
BEGIN;

-- The row whose public_id is already installed in the live website.
\set canonical  '00000000-0000-0000-0000-000000000000'
-- The accidental row created after a cookie reset.
\set duplicate  '11111111-1111-1111-1111-111111111111'

-- Sanity: same origin, and you are not about to delete the published one.
SELECT id, public_id, origin, published_config_version_id
FROM sites WHERE id IN (:'canonical', :'duplicate');

-- 1. Detach the duplicate's published pointer so its config rows can move.
UPDATE sites SET published_config_version_id = NULL WHERE id = :'duplicate';

-- 2. Reparent history. config_versions has a UNIQUE (site_id, version), so
--    offset the incoming versions past the canonical row's highest.
UPDATE config_versions
SET site_id = :'canonical',
    version = version + (SELECT COALESCE(MAX(version), 0) FROM config_versions WHERE site_id = :'canonical')
WHERE site_id = :'duplicate';

UPDATE scan_runs               SET site_id = :'canonical' WHERE site_id = :'duplicate';
UPDATE verification_challenges SET site_id = :'canonical' WHERE site_id = :'duplicate';
UPDATE verification_runs       SET site_id = :'canonical' WHERE site_id = :'duplicate';
UPDATE ai_usage_events         SET site_id = :'canonical' WHERE site_id = :'duplicate';
UPDATE live_test_sessions      SET site_id = :'canonical' WHERE site_id = :'duplicate';

-- site_pages has UNIQUE (site_id, url); drop rows that would collide, since a
-- re-scan regenerates them anyway.
DELETE FROM site_pages p
WHERE p.site_id = :'duplicate'
  AND EXISTS (SELECT 1 FROM site_pages q WHERE q.site_id = :'canonical' AND q.url = p.url);
UPDATE site_pages SET site_id = :'canonical' WHERE site_id = :'duplicate';

-- site_access has UNIQUE (site_id, builder_session_id); same treatment.
DELETE FROM site_access a
WHERE a.site_id = :'duplicate'
  AND EXISTS (
    SELECT 1 FROM site_access b
    WHERE b.site_id = :'canonical' AND b.builder_session_id = a.builder_session_id
  );
UPDATE site_access SET site_id = :'canonical' WHERE site_id = :'duplicate';

-- 3. Confirm nothing still references the duplicate.
SELECT
  (SELECT COUNT(*) FROM scan_runs               WHERE site_id = :'duplicate') AS scans,
  (SELECT COUNT(*) FROM site_pages              WHERE site_id = :'duplicate') AS pages,
  (SELECT COUNT(*) FROM config_versions         WHERE site_id = :'duplicate') AS configs,
  (SELECT COUNT(*) FROM verification_challenges WHERE site_id = :'duplicate') AS challenges,
  (SELECT COUNT(*) FROM verification_runs       WHERE site_id = :'duplicate') AS verifications,
  (SELECT COUNT(*) FROM ai_usage_events         WHERE site_id = :'duplicate') AS ai_events,
  (SELECT COUNT(*) FROM live_test_sessions      WHERE site_id = :'duplicate') AS live_sessions,
  (SELECT COUNT(*) FROM site_access             WHERE site_id = :'duplicate') AS access_grants;
-- All zero before continuing.

DELETE FROM sites WHERE id = :'duplicate';

-- COMMIT;   -- review the output above first
ROLLBACK;
```

Note: `live_test_commands` and repair/insights data are derived from the tables
above (commands cascade from `live_test_sessions`; insights and repair are
computed, not stored), so nothing else needs reparenting.

## After cleanup

```bash
# Should return no rows:
psql "$DIRECT_URL" -c "SELECT origin FROM sites GROUP BY origin HAVING COUNT(*) > 1;"

pnpm exec prisma migrate deploy    # applies the origin unique index
pnpm exec prisma migrate status
```

## Deciding not to clean up

Leaving the duplicate is safe. The application resolves the canonical row on
every request and will never create a third. The only consequence is that
`20260903030000_site_identity_per_origin_global` stays unapplied, so the
database itself does not yet enforce the invariant — the advisory lock in
`createSiteForOrigin` does.
