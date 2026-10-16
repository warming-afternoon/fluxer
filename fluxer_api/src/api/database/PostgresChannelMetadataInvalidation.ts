// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID} from '@app/api/BrandedTypes';
import type {ChannelMetadataCache} from '@app/api/database/ChannelMetadataCache';
import type {GuildAvailabilityCache} from '@app/api/database/GuildAvailabilityCache';
import {type IPostgresClient, quoteIdentifier} from '@pkgs/postgres/src/Client';

const NOTIFICATION_CHANNEL = 'fluxer_channel_metadata_v1';

/** 通过已提交事务的数据库通知使各进程的频道元数据缓存失效 */
export class PostgresChannelMetadataInvalidation {
	private channelEnabled = true;
	private guildEnabled = false;
	private listener: {close(): Promise<void>} | null = null;

	/** 数据库触发器覆盖仓库写入和直接 SQL 写入 */
	constructor(
		private readonly client: IPostgresClient,
		private readonly cache: ChannelMetadataCache,
		private readonly guildCache?: GuildAvailabilityCache,
	) {}

	/** 幂等安装通知设施，完成监听后才允许缓存 */
	async start(channelEnabled = true, guildEnabled = false): Promise<void> {
		this.channelEnabled = channelEnabled;
		this.guildEnabled = guildEnabled;
		if (this.listener || !this.client.listen) return;
		const table = quoteIdentifier(this.client.kvTable());
		await this.client.transaction(async (db) => {
			await db.query("SELECT set_config('statement_timeout', '120s', true)");
			await db.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [0x46584b56, this.client.kvTable()]);
			await db.query('SELECT pg_advisory_xact_lock($1, $2)', [0x46584b56, 0x434d4554]);
			await db.query(`CREATE OR REPLACE FUNCTION fluxer_channel_metadata_notify_v1() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE old_id text; new_id text;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    PERFORM pg_notify('${NOTIFICATION_CHANNEL}', json_build_object('table', TG_TABLE_NAME, 'clear', true)::text);
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' AND OLD.table_name = 'channels' THEN
    old_id := COALESCE(OLD.row_data -> 'channel_id' ->> 'value', OLD.row_data ->> 'channel_id');
    PERFORM pg_notify('${NOTIFICATION_CHANNEL}', json_build_object('table', TG_TABLE_NAME, 'id', old_id)::text);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.table_name = 'channels' THEN
    new_id := COALESCE(NEW.row_data -> 'channel_id' ->> 'value', NEW.row_data ->> 'channel_id');
    IF new_id IS DISTINCT FROM old_id THEN
      PERFORM pg_notify('${NOTIFICATION_CHANNEL}', json_build_object('table', TG_TABLE_NAME, 'id', new_id)::text);
    END IF;
  END IF;
  RETURN NULL;
END
$function$`);
			// 不在消息、角标等高频字段更新时执行通知函数。
			await db.query(`DO $install$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = '${table}'::regclass AND tgname = 'channel_metadata_insert_v1') THEN
    CREATE TRIGGER channel_metadata_insert_v1 AFTER INSERT ON ${table}
    FOR EACH ROW WHEN (NEW.table_name = 'channels') EXECUTE FUNCTION fluxer_channel_metadata_notify_v1();
    CREATE TRIGGER channel_metadata_delete_v1 AFTER DELETE ON ${table}
    FOR EACH ROW WHEN (OLD.table_name = 'channels') EXECUTE FUNCTION fluxer_channel_metadata_notify_v1();
    CREATE TRIGGER channel_metadata_update_v1 AFTER UPDATE ON ${table}
    FOR EACH ROW WHEN (
      (OLD.table_name = 'channels' OR NEW.table_name = 'channels') AND
      ROW(OLD.table_name, OLD.row_key, OLD.row_data -> 'channel_id', OLD.row_data -> 'guild_id', OLD.row_data -> 'type', OLD.row_data -> 'soft_deleted', OLD.expires_at)
      IS DISTINCT FROM ROW(NEW.table_name, NEW.row_key, NEW.row_data -> 'channel_id', NEW.row_data -> 'guild_id', NEW.row_data -> 'type', NEW.row_data -> 'soft_deleted', NEW.expires_at)
    ) EXECUTE FUNCTION fluxer_channel_metadata_notify_v1();
    CREATE TRIGGER channel_metadata_truncate_v1 AFTER TRUNCATE ON ${table}
    FOR EACH STATEMENT EXECUTE FUNCTION fluxer_channel_metadata_notify_v1();
  END IF;
END
$install$`);
			// Guilds share the same notification connection, but have independent caches and toggles.
			if (guildEnabled) {
				await db.query(`CREATE OR REPLACE FUNCTION fluxer_guild_availability_notify_v1() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE old_id text; new_id text;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.table_name = 'guilds' THEN
    old_id := COALESCE(OLD.row_data -> 'guild_id' ->> 'value', OLD.row_data ->> 'guild_id');
    PERFORM pg_notify('${NOTIFICATION_CHANNEL}', json_build_object('table', TG_TABLE_NAME, 'entity', 'guild', 'id', old_id)::text);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.table_name = 'guilds' THEN
    new_id := COALESCE(NEW.row_data -> 'guild_id' ->> 'value', NEW.row_data ->> 'guild_id');
    IF new_id IS DISTINCT FROM old_id THEN
      PERFORM pg_notify('${NOTIFICATION_CHANNEL}', json_build_object('table', TG_TABLE_NAME, 'entity', 'guild', 'id', new_id)::text);
    END IF;
  END IF;
  RETURN NULL;
END
$function$`);
				await db.query(`DO $install$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = '${table}'::regclass AND tgname = 'guild_availability_insert_v1') THEN
    CREATE TRIGGER guild_availability_insert_v1 AFTER INSERT ON ${table}
    FOR EACH ROW WHEN (NEW.table_name = 'guilds') EXECUTE FUNCTION fluxer_guild_availability_notify_v1();
    CREATE TRIGGER guild_availability_delete_v1 AFTER DELETE ON ${table}
    FOR EACH ROW WHEN (OLD.table_name = 'guilds') EXECUTE FUNCTION fluxer_guild_availability_notify_v1();
    CREATE TRIGGER guild_availability_update_v1 AFTER UPDATE ON ${table}
    FOR EACH ROW WHEN (
      (OLD.table_name = 'guilds' OR NEW.table_name = 'guilds') AND
      ROW(OLD.table_name, OLD.row_key, OLD.row_data -> 'guild_id', OLD.row_data -> 'features', OLD.row_data -> 'soft_deleted', OLD.expires_at)
      IS DISTINCT FROM ROW(NEW.table_name, NEW.row_key, NEW.row_data -> 'guild_id', NEW.row_data -> 'features', NEW.row_data -> 'soft_deleted', NEW.expires_at)
    ) EXECUTE FUNCTION fluxer_guild_availability_notify_v1();
  END IF;
END
$install$`);
			}
		});
		this.listener = await this.client.listen(NOTIFICATION_CHANNEL, {
			state: (ready) => this.setReady(ready),
			message: (payload) => this.invalidate(payload),
		});
	}

	/** 通知只接受本 KV 表的标识，异常载荷保守清空缓存 */
	private invalidate(payload: string): void {
		try {
			const notice: {table?: string; id?: string; clear?: boolean; entity?: string} = JSON.parse(payload);
			if (notice.table !== this.client.kvTable()) return;
			if (notice.clear || !notice.id || !/^\d+$/.test(notice.id)) this.setReady(true);
			else if (notice.entity === 'guild') this.guildCache?.invalidate(createGuildID(BigInt(notice.id)));
			else this.cache.invalidate(createChannelID(BigInt(notice.id)));
		} catch {
			this.setReady(false);
		}
	}

	private setReady(ready: boolean): void {
		this.cache.setReady(ready && this.channelEnabled);
		this.guildCache?.setReady(ready && this.guildEnabled);
	}

	/** 在数据库关闭之前停用缓存并结束监听 */
	async shutdown(): Promise<void> {
		this.setReady(false);
		await this.listener?.close();
		this.listener = null;
	}
}
