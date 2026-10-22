# OpenRouter automatic surfacing production verification

Code: 06075e5b6d88a2dee491a057c916ad093a2b17da

Production release: /Users/owner/Projects/estomago-releases/or-surfacing-20261021
The release extends the previous event-source production release with only the
four scoped host files. No unrelated source-branch features were deployed.

77 tests passed across bounded serial batches, including four exact OR runner /
Opus 4.6 / Bedrock synthetic-transport cases. They cover same-turn injection,
first injection into an existing cache trajectory, unchanged prefix and tools,
coverage deduplication, direct reading and final admission rejection. Type checks
passed on both the source tree and the exact production-base release.

Post-restart local activation probe confirmed configured provider=openrouter,
transport supported=true, surfacing enabled=true, deadline=15000ms. The existing
Mariposa service returned empty with zero queries and no blocked reason; policy
revision=4, preparation prompt=surface_prepare_v4. No real OR or JEV call was made.
This verifies host behavior and production admission, not live vendor acceptance
or a measured upstream cache-hit rate.

Protected chat, windows, trajectories, provider requests, runtime settings, memory
business tables and JEV cache hashes remained unchanged. Both services were
healthy. Only estomago restarted; Mariposa's event-source implementation stayed live.

Existing windows can now receive automatic memory data appended to the new tail.
The new hold source_ranges definition requires a new frozen tool catalog/window.
Manual rotation already carries the user-selected original messages and their
sequence/revision manifest. No duplicate manual paste is needed. New windows build
their own cache prefix; old histories and frozen tool definitions are untouched.
