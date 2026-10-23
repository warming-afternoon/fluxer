\set ON_ERROR_STOP on
-- Run immediately after seed, before application mutation. No secrets printed.
CREATE TEMP TABLE benchmark_count_validation AS
WITH expected(table_name,expected_rows) AS (VALUES
 ('users',200000),('users_by_email',200000),('user_email_owners',200000),('users_by_username',200000),
 ('guild_members',200000),('guild_members_by_user_id',200000),('channels',30002),
 ('thread_state',30000),('thread_stats',30000),('threads_by_parent',30000),
 ('active_threads_by_guild',5000),('archived_threads_by_parent',25000),
 ('thread_members',1027000),('thread_members_by_user',1027000),
 ('messages',1092000),('messages_by_author_id_v2',1092000),('channel_state',30000),('channel_message_buckets',120000)
), actual AS (SELECT table_name,count(*) AS rows FROM fluxer_kv GROUP BY table_name)
SELECT e.table_name,e.expected_rows,a.rows AS actual_rows,COALESCE(a.rows=e.expected_rows,false) AS matches FROM expected e LEFT JOIN actual a USING(table_name) ORDER BY e.table_name;
SELECT * FROM benchmark_count_validation ORDER BY table_name;
DO $check$ BEGIN IF EXISTS(SELECT 1 FROM benchmark_count_validation WHERE NOT matches) THEN RAISE EXCEPTION 'Reduced d10 exact corpus count mismatch'; END IF; END $check$;
SELECT (row_data->>'member_count')::int AS joined_members,count(*) AS posts FROM fluxer_kv WHERE table_name='thread_state' GROUP BY 1 ORDER BY 1;
SELECT (row_data->>'message_count')::int AS floors,count(*) AS posts FROM fluxer_kv WHERE table_name='thread_stats' GROUP BY 1 ORDER BY 1;
SELECT length(row_data->>'content') AS chinese_characters,octet_length(row_data->>'content') AS utf8_bytes,count(*) AS messages FROM fluxer_kv WHERE table_name='messages' GROUP BY 1,2 ORDER BY 1;
-- Expected member distribution:990→800,50→4200,1→25000.
-- Expected floors:1000→800,10→29200.
-- Expected content:1000chars/3000bytes→30000;20chars/60bytes→1062000.
