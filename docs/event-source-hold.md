# Event source ranges on hold

`memory_hold.source_ranges` is an optional list of `{start_seq, end_seq}` in the
current verified conversation. It is independent of `quotes`. Every visible
message in a range must have been read in full at the current revision and have
a matching durable archive receipt. Missing revisions, unsynced evidence,
overlap, reversed ranges and mixed source conversations fail before memory.hold.

The host sends only stable references and hashes to Mariposa, never another copy
of the raw conversation. Mariposa validates the entire parent path and commits
the memory plus event spans atomically. Quotes continue to use their own source
references, but no longer create memory source ranges. Missing event selection
returns saved:true plus source_status:unbound; missing source never deletes a
memory. A receipt-count mismatch remains an unknown write outcome.

No provider request, prefix, history or frozen tool catalog is rewritten. New
catalogs advertise source_ranges; older frozen contracts remain usable without
claiming event coverage. No model call or automatic last-hold boundary inference
is introduced. Cross-day/window reads reuse conversation_read sequence markers.
