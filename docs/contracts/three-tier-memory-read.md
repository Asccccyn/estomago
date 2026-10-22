# Three-tier memory reading

1. Surfaced item: `memory_ref`, occurrence `date`, complete original event `text`.
2. `memory_read_full({memory_ref, section:"memory"})`: ordinary bucket content only
   (date/title/mood/body/words/categories plus necessary object IDs and read controls).
3. The same tool/ref can directly select `relations` or `source`. Neither requires
   a prior memory read. Source uses the existing Mariposa source.memory.open service;
   relations read one-hop actual relationships and target content. Neither performs
   retrieval, calls JEV, issues a view-confirmation receipt or writes a memory.

Keep `section` when passing `next_cursor`. Cursors are section-specific; stale snapshots
are rejected rather than merging versions. Existing room/window/sent-request checks
on memory_ref still apply. Raw detail_ref, hashes and domain vectors remain internal.
Existing reference authorization/expiry rules are unchanged.

Existing cached tool schemas are not rewritten. Old schemas without section retain
legacy detail behavior; new windows receive the three-tier schema. Existing frozen
augmentation text is never rerendered. UI provides independent details/relations/source
buttons and can open original records directly.
