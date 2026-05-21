# Race condition handling between concurrent automations

## The problem

Airtable automations run independently. There is no native synchronization between them — no transactions, no event ordering guarantees, no way to declare "automation B should only run after automation A has finished writing field X."

In practice this means: when a booking is confirmed, several automations fire in response. Some are fast (the Slack notification). Some take longer (writing computed fields, triggering formula recalculation, populating lookup fields that depend on the linked record graph).

[`scripts/02-booking-range-fill.js`](../scripts/02-booking-range-fill.js) needs the `Internal End` field on the trigger record to know how far to walk through the slot array. But `Internal End` is populated by a *separate* automation that runs in response to the same "confirmed" status change. The two automations race.

If `02-booking-range-fill.js` runs before `Internal End` is populated, it reads an empty value, the `End` resolution fails, and the script exits without doing its job — leaving the booking confirmed but with no slots actually marked as `Booking`.

## The fix: retry with backoff

```javascript
async function resolveEnd(rec) {
  // 1) Internal End
  let endMs = toMs(rec.getCellValue(INTERNAL_END));
  if (endMs) return endMs;

  // 2) optional lookup/rollup End
  if (CAL_END_LOOKUP && table.fields.some(f => f.name === CAL_END_LOOKUP)) {
    const v = rec.getCellValue(CAL_END_LOOKUP);
    if (Array.isArray(v) && v[0]) {
      endMs = toMs(v[0]);
      if (endMs) return endMs;
    } else if (v) {
      endMs = toMs(v);
      if (endMs) return endMs;
    }
  }

  // 3) retry (other automation might still be writing)
  for (let i = 0; i < 10; i++) {
    await rec.reloadAsync?.();
    endMs = toMs(rec.getCellValue(INTERNAL_END));
    if (endMs) return endMs;
    await new Promise(r => setTimeout(r, 500));
  }

  return null;
}
```

Three fallback tiers:

1. **Direct read.** If `Internal End` is already populated when the script first runs, use it. This is the happy path and covers most real cases (the writing automation usually finishes within a few hundred ms).
2. **Alternate lookup field.** If `Internal End` is empty but a `End (lookup)` field is configured and populated, use that instead. This handles cases where `Internal End` is mid-computation but a related lookup has already settled.
3. **Retry loop.** Up to 10 attempts, 500ms apart, calling `rec.reloadAsync?.()` each time to force a fresh read of the record from Airtable's backend. Total maximum wait: 5 seconds. If still empty after 10 attempts, return `null` and the calling code exits cleanly with a log message rather than crashing.

## Why `reloadAsync?.()` and not `reloadAsync()`

The optional chaining (`?.`) is defensive. Different parts of Airtable's scripting API surface different record types — some have `reloadAsync`, some don't. If the API version running the script doesn't expose `reloadAsync` on this record type, `rec.reloadAsync()` would throw a `TypeError`. With optional chaining, the call silently returns `undefined` if the method doesn't exist, the loop continues, and the next iteration's `getCellValue` may or may not pick up new data depending on whether Airtable refreshes the in-memory record some other way.

This is belt-and-suspenders engineering. The script works on the version of the scripting API I tested against, and it will keep working if Airtable changes the API surface in a backwards-compatible way that removes `reloadAsync`.

## Why this is not distributed consensus

This is genuinely a race condition between concurrent processes, but the resolution is much simpler than what "race condition" might evoke in a backend-engineering context. We're not implementing two-phase commit or Raft. We're polling a database field with backoff. The reason this is sufficient:

- There's only one writer to `Internal End` (the upstream automation).
- The write is eventually consistent — it will happen, the only question is when.
- The script has a clean fallback if the timeout expires (log and exit; the booking is still confirmed, the slots just don't get marked, and a human can re-trigger the script manually).
- The retry interval (500ms) and count (10) are tuned so that the 99th-percentile case completes within a few hundred ms and the 99.9th-percentile case still completes within 5 seconds.

The correct framing for an interview question about this is: "the system has eventual consistency between automations, and the script handles it with a bounded retry loop." Not: "I built a distributed coordination protocol."

## Why this matters for portfolio purposes

Most no-code / low-code work doesn't deal with concurrency at all. The fact that this script handles a real race condition that arose in production is the kind of detail that distinguishes a Real System That People Use from a demo project. It's also the kind of detail interviewers ask follow-up questions about — "how did you find this bug?" and "how confident are you that 10 retries is enough?" are both fair game.

The honest answers:

- **How I found the bug:** confirmed bookings occasionally had no Booking-typed slots in `Available Bookings`. Logs showed the script exited at the "End not available yet" branch. Adding a single retry exposed the race.
- **Why 10 retries / 500ms:** empirical. Most cases resolved within 1 retry. 10 retries with 500ms spacing gives a 5-second budget, which is well within Airtable automation timeout limits and well beyond any case I observed. Tunable if needed.
