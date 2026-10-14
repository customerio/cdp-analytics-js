# Web push identity and registration delivery

## Ordering contract with Journeys

Every web `Device Deleted` and `Device Created or Updated` includes
`context.device.webpush_event_ms` (the original browser epoch milliseconds) and
`context.device.webpush_seq` (an increasing per-endpoint integer). The sequence
is `max(previous + 1, Date.now())`, persisted in localStorage independently of
the current owner. Clearing an owner or switching worker paths does not restart
it; after storage loss the wall-clock floor assumes time has advanced beyond
the prior sequence. Values use epoch-ms scale and require 64-bit integers at
all downstream hops. Web Locks serialize sequence read/increment/write across
tabs when available; the fallback remains best effort. Events use the current
browser time, never an artificial future offset. Their top-level `timestamp`
uses that same original time; Created events do not supply `last_used`.

Destination retries and plugin recovery after reload retain the event's original
sequence and time. Pipelines and edge must forward both device-context fields
unchanged, and the coordinated services guard must order by sequence, then
milliseconds, ignoring only strictly older events. This distinguishes a genuine
same-second logout from an old Delete retried after a newer registration.
SDK metadata alone cannot fix a server still using whole-second ordering.

**Registration does not itself transfer an endpoint between people.** The SDK
sends the previous owner's Delete before registering the next owner. It waits
for acknowledgement unless cleanup is terminal or reaches its retry bounds
(described below). This acknowledgement is not proof of downstream
Journeys processing; reliable downstream ordering requires the coordinated
Pipelines, edge and services deployment.

Before sending any web Delete (including while offline), the destination removes
queued Creates for that endpoint from both analytics and destination retry
queues, including backing-off and persisted entries. A local endpoint tombstone
also drops stale Creates at send time, so an old page's persisted copy cannot
resurrect the registration after reload. This cancellation applies across owners
of the endpoint; a fresh registration is still allowed, including at the same
millisecond. Plugin identity mutations are serialized, and queued subscribe
operations re-read current identity before creating their event.

This is client-side retry protection, not a server uniqueness guarantee. A
request already dispatched cannot be recalled. Reliable cross-reload recovery
requires available localStorage. Web Locks protect sequence allocation, not
the entire owner record across tabs. After storage loss a backwards clock can
still violate ordering. With retained counters, sequence ordering also protects
client retry cancellation when the wall clock moves backwards.

## Acceptance and recovery

`analytics.track()` resolving does not imply server acceptance: the destination
can have queued a retry. Web device lifecycle events therefore use acknowledged
single-event HTTP delivery with `keepalive: true`, even if regular analytics uses
batching or disables keepalive for ordinary events. Only a
successful HTTP response from the Customer.io destination marks the returned
Context accepted. This is transport acceptance, not proof of downstream Journeys
processing. The acknowledgement is not in the event payload or persisted queue;
it works across separately loaded analytics and plugin bundles.

During an attempt the local endpoint/owner record has `registered: false`.
`subscribe()` rejects if its attempt is not acknowledged; it does not unsubscribe
the browser. Destination retries still run, and registration remains retryable
through another `subscribe()`, identify, a persisted pageshow, a worker change
message, or a full page load. A successful acknowledged attempt clears the flag.
The owner remains available for reset/unsubscribe cleanup. A pending Create's
ordering fields are saved with that record and reused on recovery.

Before sending a Delete, the plugin persists `pendingDelete` with its original
sequence/time, failed-attempt count and next-attempt time. Transient failures
back off from completion (30 seconds, doubling to one hour). Reloads, identify
and subscribe respect that persisted backoff instead of duplicating Deletes.
A page timer also retries cleanup if Analytics short-circuited an offline event
before destination delivery. On reload cleanup runs even without an identified
visitor or a live push subscription.

Cleanup clears on HTTP success, final 4xx (except 408/429), 20 failed attempts,
or seven days of age. Delivery feedback includes buffered acknowledgements and
final rejections, which automatically reconcile the current visitor without
another identify or reload. Concurrent feedback/identify reconciliation does
not duplicate registration. These bounds intentionally unblock registration;
abandoning an unaccepted Delete is not proof the old owner was detached on the
server. Delayed older Deletes cannot supersede newer registrations under the
coordinated ordering contract. If localStorage is denied, recovery is limited
to the current page's memory. This does not change native device events or
ordinary analytics delivery.

## Page lifetime

A `pagehide` with `persisted: true` freezes rather than ends the page. Pending
anonymous subscription promises and their live browser subscription survive that
freeze. Identify on return finishes them; persisted pageshow also reconciles an
already identified visitor. Identify inspects a live subscription even when no
local registration record exists, after queued identity mutations settle.
A non-persisted pagehide or explicit plugin unload still rejects pending anonymous
operations and unload removes both page lifetime listeners. Browser-owned push
subscriptions survive full navigation and are inspected on the next load; no
push keys need to be duplicated in SDK storage.
