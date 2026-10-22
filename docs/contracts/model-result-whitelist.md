# Final model tool-result whitelist (2026-10-21)

HostToolExecutor.execute projects only after executeInner completes, including receipt
validation and side-effect accounting. Both direct tools and deferred tool_invoke use
this boundary. supervisor serializes exec.output exactly once into the next tool message.
seenAdditions remains internal and is not altered by presentation projection.

model-results.ts covers memory recall/pages, open/confirm/recollection/keep, corrections,
deletion review, episodes, I, plans, conversation reads and model-visible failures.
Business strings are copied without trimming or summaries. Existing historical tool
messages, persisted window toolsets, cache markers and prefixes are not rewritten.

Metadata purposes:
- Object IDs: next get/revise/revoke/correct call.
- Episode revision, plan version, I revision: next CAS write against the observed version.
- View receipt: confirm/recollect; source binding version: source correction.
- Cursor/result set/session/continuation parameters: same-result pagination or refinement.
- Episode source hashes and anchors: mandatory evidence parameters in episode_apply.
- Incomplete/invalidated/unconfirmed/revoked/historical/current-state/error signals:
  prevent missing, stale or unconfirmed output being interpreted as current success.
- Conversation sequence: quote selection; fragment offsets/cursors: lossless continuation.

No internal operation IDs, successful commit timestamps, scope echoes or diagnostic
scores enter the ordinary projected result. Failure remains failure. No retry is performed
by the projection. Other tools retain their own contracts; external provider raw evidence
and explicit history are not recursively stripped with a generic null/false/zero filter.

Bootstrap already assembles business text after completing/validating pages in supervisor;
it is not a JSON dump. Automatic surfacing renders only occurrence date and original text.
Unknown occurrence dates remain null there; an available date is no longer erased because
of date_confidence. UI mappings and internal source/message/version checks remain separate.
