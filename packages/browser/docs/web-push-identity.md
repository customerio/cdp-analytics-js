# Web push identity and registration delivery

## Ordering contract with Journeys

`Device Deleted` and `Device Created or Updated` carry an explicit top-level
`timestamp` set when their SDK event is created. Destination retries retain the
original event and timestamp, not the time of the retry. Created events do not
supply a separate `last_used` value.

The matching services change (`FIX-services-delivery`) ignores web deletes whose
timestamp is less than or equal to the device's latest update. The destination,
edge and services compare **whole seconds**. Thus an old logout delete cannot
remove a newer registration for the same person/endpoint, including events in
the same second. Registration also transfers an endpoint from another person.

Do not future-date these events: services clamps future registration times to
its clock. The accepted server trade-off is that a genuine logout/unsubscribe in
the same second as registration is ignored. Client/server clock skew and clock
rollback are not solved by this contract. The stale-delete protection requires
the coordinated services deployment; SDK timestamping alone cannot protect an
unmodified server from a delete already in flight or in its retry queue.

## Acceptance and recovery

`analytics.track()` resolving does not imply server acceptance: the destination
can have queued a retry. Web device lifecycle events therefore use acknowledged
single-event HTTP delivery, even if regular analytics uses batching. Only a
successful HTTP response from the Customer.io destination marks the returned
Context accepted. This is transport acceptance, not proof of downstream Journeys
processing. The acknowledgement is not in the event payload or persisted queue;
it works across separately loaded analytics and plugin bundles.

During an attempt the local endpoint/owner record has `registered: false`.
`subscribe()` rejects if its attempt is not acknowledged; it does not unsubscribe
the browser. Destination retries still run, and registration remains retryable
through another `subscribe()`, identify, a persisted pageshow, a worker change
message, or a full page load. A successful acknowledged attempt clears the flag.
The owner remains available for reset/unsubscribe cleanup. This does not change
native device events or ordinary analytics delivery.

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
