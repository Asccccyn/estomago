# OpenRouter automatic memory delivery

OpenRouter is supported without changing provider, model, session, frozen tools,
or cached history. For Opus 4.6/Bedrock, append a separate user-channel data
message before the current real input. It has a fixed host-origin notice plus
the existing compact memories JSON. No mid-conversation system message is added,
and no synthetic tool call or chat/source message is created. The notice is
included in the surfacing text budget. DS behavior is unchanged; SDK remains
unsupported. Existing identity/revision/final-admission gates remain in force.

Tests use OpenRouterRunner with injected synthetic transport and the exact
anthropic/claude-opus-4.6 + amazon-bedrock payload configuration. They cover same
turn delivery, first injection into an existing trajectory, prefix immutability,
coverage deduplication, direct source reading and final-admission rejection.
No real OpenRouter credential or request is used. These tests establish host wire
behavior, not a measurement of upstream cache hits or a live vendor acceptance.

Manual rotation uses the existing history selection UI. Selected messages retain
stable sequence and revision manifests in the new window. New windows freeze the
new hold source_ranges schema. Do not paste duplicate originals. Automatic memory
delivery itself works in the existing window; rotation is needed only to obtain
new frozen tool definitions. A fresh window establishes a fresh cache prefix;
the previous window's cached history is not rewritten.

Protocol references: https://platform.claude.com/docs/en/api/messages/create
and https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
