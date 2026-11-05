-- 已有集成部署先应用这两条，再部署 Forum 创建来源限定的自动入群。
-- 不回填历史来源，既有 ready/pending 行不会因此获得自动入群资格。
ALTER TABLE integration_discord_identities ADD creation_source text;
ALTER TABLE integration_discord_identities ADD creation_guild_id text;
