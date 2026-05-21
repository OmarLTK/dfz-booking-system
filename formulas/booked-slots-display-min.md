# `Booked Slots Display (Min)` formula field

**Lives on:** `SandBox Booking Request`
**Field type:** Formula
**Returns:** Formatted datetime string (e.g. `Jul 8, 2026 09:30 am`)

## Purpose

Renders the **earliest** booked time slot for a given Booking Request in a human-readable Toronto-local format. Used in confirmation emails, the request grid views, and anywhere staff need to see "what time does this booking actually start."

The request itself stores the booked slots as a linked-record array (because slots live in a different table — see [`sync-inversion-pattern.md`](../docs/sync-inversion-pattern.md) for why). This formula extracts the minimum `Start` value from the linked slots via a rollup field (`minBookedSlots`) and formats it.

## Formula

```airtableFormulas
IF(
  {minBookedSlots},
  DATETIME_FORMAT(
    SET_TIMEZONE({minBookedSlots}, 'America/Toronto'),
    'MMM D, YYYY hh:mm a'
  )
)
```

## How it works

1. `{minBookedSlots}` is a rollup field on the same Booking Request record that takes the `MIN(values)` of the `Start` field across all linked Available Bookings records. If the linked field is empty, this rollup returns nothing and the outer `IF` short-circuits to an empty string rather than rendering an "Invalid date."
2. `SET_TIMEZONE({minBookedSlots}, 'America/Toronto')` converts the underlying UTC datetime to Toronto local time before formatting.
3. `DATETIME_FORMAT(..., 'MMM D, YYYY hh:mm a')` produces the human-readable form, e.g. `Jul 8, 2026 09:30 am`.

## Companion field

See [`booked-slots-display-max.md`](booked-slots-display-max.md) for the matching "end of booking" formula, which uses a different rollup (`maxBookedSlots`) and adds 30 minutes to the latest slot's `Start` to get the booking's actual end time.
