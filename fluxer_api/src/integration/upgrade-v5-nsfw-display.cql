-- Apply once to the native schema before rolling out any enforcement build.
-- Existing records stay hidden in the configured Forum guild until explicitly enabled.
ALTER TABLE user_guild_settings ADD show_nsfw boolean;
ALTER TABLE user_guild_settings ADD nsfw_version bigint;
