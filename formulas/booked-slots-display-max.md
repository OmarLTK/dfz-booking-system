# `Booked Slots Display (Max)` formula field

**Lives on:** `SandBox Booking Request`
**Field type:** Formula
**Returns:** Formatted datetime string (e.g. `Jul 8, 2026 10:00 am`)

## Purpose

Renders the **end** of a booking in a human-readable Toronto-local format. This is the latest booked slot's `Start` plus 30 minutes (the slot length) — i.e., when the booking actually ends.

Used in confirmation emails ("Your booking ends at...") and in views where staff need to see the booking's end time at a glance.

## Formula

```airtableFormulas
IF(
  {maxBookedSlots},
  DATETIME_FORMAT(
    SET_TIMEZONE(DATEADD({maxBookedSlots}, 30, "minutes"), "America/Toronto"),
    "MMM D, YYYY hh:mm a"
  )
)
```

## How it works

1. `{maxBookedSlots}` is a rollup field that takes the `MAX(values)` of the `Start` field across all linked Available Bookings records. If a user booked `1:00 PM`, `1:30 PM`, and `2:00 PM` slots, `maxBookedSlots = 2:00 PM` — the start of the *last* slot, not the end of the booking.
2. `DATEADD({maxBookedSlots}, 30, "minutes")` adds 30 minutes to that latest slot's start time. Now we have the actual end of the booking — `2:30 PM` in this example.
3. `SET_TIMEZONE(..., "America/Toronto")` converts to Toronto local time.
4. `DATETIME_FORMAT(..., "MMM D, YYYY hh:mm a")` produces the human-readable form.

## Why this isn't the DST-safe pattern

This formula uses `DATEADD(..., 30, "minutes")` directly, which is fine *here* because:
- The rollup value comes from a stored datetime field (not computed live from `NOW()` or a date input).
- We're only displaying the result, not feeding it into further arithmetic.
- 30 minutes is short enough that it can't cross a DST boundary in any practical case.

For computations that DO need DST safety — particularly the setup/teardown time calculations that feed back into slot lookups — see [`dst-safe-add-30min.md`](dst-safe-add-30min.md) for the string round-trip pattern.

## Companion field

See [`booked-slots-display-min.md`](booked-slots-display-min.md) for the matching "start of booking" formula.
