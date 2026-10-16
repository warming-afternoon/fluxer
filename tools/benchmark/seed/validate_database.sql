\set ON_ERROR_STOP on
-- Run against isolated fixture DB only; outputs no account credentials.
SELECT table_name, count(*) AS rows FROM fluxer_kv GROUP BY table_name ORDER BY table_name;
WITH members AS (
 SELECT row_data->'thread_id'->>'value' AS thread_id,row_data->'user_id'->>'value' AS user_id
 FROM fluxer_kv WHERE table_name='thread_members'
), reverse_members AS (
 SELECT row_data->'thread_id'->>'value' AS thread_id,row_data->'user_id'->>'value' AS user_id
 FROM fluxer_kv WHERE table_name='thread_members_by_user'
), forward_missing AS (SELECT * FROM members EXCEPT SELECT * FROM reverse_members),
reverse_missing AS (SELECT * FROM reverse_members EXCEPT SELECT * FROM members)
SELECT 'forward_membership_missing_reverse' AS check_name,count(*) AS errors FROM forward_missing
UNION ALL SELECT 'reverse_membership_missing_forward',count(*) FROM reverse_missing;
WITH counts AS (
 SELECT row_data->'thread_id'->>'value' AS thread_id,count(*) AS members
 FROM fluxer_kv WHERE table_name='thread_members' GROUP BY 1
)
SELECT 'thread_member_count_mismatch' AS check_name,count(*) AS errors
FROM fluxer_kv s LEFT JOIN counts c ON c.thread_id=s.row_data->'thread_id'->>'value'
WHERE s.table_name='thread_state' AND (s.row_data->>'member_count')::integer IS DISTINCT FROM c.members;
WITH users AS (SELECT row_data->'user_id'->>'value' AS id FROM fluxer_kv WHERE table_name='users')
SELECT 'guild_member_missing_user' AS check_name,count(*) AS errors FROM fluxer_kv m LEFT JOIN users u ON u.id=m.row_data->'user_id'->>'value' WHERE m.table_name='guild_members' AND u.id IS NULL;
WITH messages AS (SELECT row_data->'channel_id'->>'value' AS channel_id,row_data->'message_id'->>'value' AS id FROM fluxer_kv WHERE table_name='messages')
SELECT 'thread_missing_starter_message' AS check_name,count(*) AS errors FROM fluxer_kv s LEFT JOIN messages m ON m.channel_id=s.row_data->'thread_id'->>'value' AND m.id=m.channel_id WHERE s.table_name='thread_state' AND m.id IS NULL;
SELECT 'test_account_count' AS check_name,count(*) AS value FROM fluxer_kv WHERE table_name='users' AND row_data->>'email' LIKE '%@benchmark.invalid';
