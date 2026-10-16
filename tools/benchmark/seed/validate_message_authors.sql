\set ON_ERROR_STOP on
-- Read-only corpus-reference audit. Prints counts only, no credentials or bodies.
CREATE TEMP TABLE benchmark_reference_validation AS
WITH members AS (
 SELECT row_data->'thread_id'->>'value' AS thread_id,row_data->'user_id'->>'value' AS user_id
 FROM fluxer_kv WHERE table_name='thread_members'
), guild_members AS (
 SELECT row_data->'user_id'->>'value' AS user_id,row_data->'guild_id'->>'value' AS guild_id
 FROM fluxer_kv WHERE table_name='guild_members'
)
SELECT 'historical_author_not_thread_member' AS check_name,count(*) AS errors
FROM fluxer_kv m LEFT JOIN members tm ON tm.thread_id=m.row_data->'channel_id'->>'value' AND tm.user_id=m.row_data->'author_id'->>'value'
WHERE m.table_name='messages' AND tm.user_id IS NULL
UNION ALL
SELECT 'thread_member_not_guild_member',count(*)
FROM fluxer_kv m LEFT JOIN guild_members gm ON gm.user_id=m.row_data->'user_id'->>'value' AND gm.guild_id=m.row_data->'guild_id'->>'value'
WHERE m.table_name='thread_members' AND gm.user_id IS NULL
UNION ALL
SELECT 'thread_owner_not_thread_member',count(*)
FROM fluxer_kv c LEFT JOIN members tm ON tm.thread_id=c.row_data->'channel_id'->>'value' AND tm.user_id=c.row_data->'owner_id'->>'value'
WHERE c.table_name='channels' AND (c.row_data->>'type')::int=11 AND tm.user_id IS NULL;
SELECT * FROM benchmark_reference_validation ORDER BY check_name;
DO $check$ BEGIN IF EXISTS(SELECT 1 FROM benchmark_reference_validation WHERE errors<>0) THEN RAISE EXCEPTION 'Message/member/owner reference violation'; END IF; END $check$;
