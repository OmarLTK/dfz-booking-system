# DST-safe `+30 minutes` pattern

**Lives on:** wherever setup/teardown offsets need to be computed from `{Start}`
**Field type:** Formula
**Returns:** Datetime, offset from `{Start}` by the specified amount, safe across DST transitions

## Purpose

Compute `{Start} + 30 minutes` (or any other offset) in a way that survives DST transitions. Naive `DATEADD({Start}, 30, "minutes")` produces 1-hour-off results twice a year because Airtable's date arithmetic operates in UTC under the hood — adding 30 UTC minutes to a value that crosses a DST wall does not give you 30 wall-clock minutes.

## Formula

```airtableFormulas
SET_TIMEZONE(
  DATEADD(
    DATETIME_PARSE(
      DATETIME_FORMAT(SET_TIMEZONE({Start}, 'America/Toronto'), 'YYYY-MM-DD HH:mm:ss'),
      'YYYY-MM-DD HH:mm:ss'
    ),
    0.5, 'hours'
  ),
  'America/Toronto'
)
```

## How it works (inside out)

1. **`SET_TIMEZONE({Start}, 'America/Toronto')`** — converts the stored UTC datetime to a Toronto-local datetime.
2. **`DATETIME_FORMAT(..., 'YYYY-MM-DD HH:mm:ss')`** — renders that Toronto-local datetime as a plain string with no timezone information. This is the critical step: after this point, the value is just a wall-clock string like `"2026-03-08 02:15:00"` with no UTC offset attached.
3. **`DATETIME_PARSE(..., 'YYYY-MM-DD HH:mm:ss')`** — parses the string back into a datetime, treating it as if it were UTC (because that's the default). The value is no longer aware of Toronto timezone; it's a naive wall-clock datetime.
4. **`DATEADD(..., 0.5, 'hours')`** — adds 30 minutes in wall-clock terms, since the value has no timezone context to interfere with. `2:15 + 30 min = 2:45`, even on the morning when clocks jump from `2:00` to `3:00` for spring-forward.
5. **`SET_TIMEZONE(..., 'America/Toronto')`** — re-applies Toronto timezone to the result.

## Why this is necessary

Consider a slot at `1:30 AM` Toronto on the morning of spring-forward (the second Sunday of March, when clocks jump from 2:00 AM EST to 3:00 AM EDT). The stored UTC datetime is `06:30 UTC`.

**Naive `DATEADD({Start}, 30, "minutes")`:**
- Adds 30 minutes in UTC: `06:30 UTC + 30 min = 07:00 UTC`.
- Renders in Toronto local: `07:00 UTC = 3:00 AM EDT` (because the clock has jumped).
- Result: `1:30 AM → 3:00 AM`. That's a 1-hour-30-minute jump in wall clock time, not 30 minutes.

**String round-trip pattern:**
- Strips timezone: `"2026-03-08 01:30:00"`.
- Adds 30 min in wall-clock: `"2026-03-08 02:00:00"`.
- Re-applies Toronto: `2:00 AM` (the value the user expects, even though that wall-clock moment doesn't technically exist on DST morning — Airtable handles it gracefully).

The same logic applies in the opposite direction in November (fall-back), where naive arithmetic can produce duplicate timestamps.

## Where it's used

Anywhere a setup or teardown offset needs to be computed from `{Start}` for use in further date comparisons, lookups, or rollups — i.e., places where the resulting datetime is fed back into Airtable arithmetic, not just displayed.

For display-only formulas (e.g., [`booked-slots-display-max.md`](booked-slots-display-max.md)), the naive `DATEADD` is acceptable because the result is immediately rendered as a string and never participates in further arithmetic.

## Background

This pattern was introduced after a live DST transition exposed timezone bugs in the original implementation. See [`../docs/dst-handling.md`](../docs/dst-handling.md) for the broader story and the parallel pattern in the JavaScript layer.
