# `Blocked Times` formula field

**Lives on:** `Available Bookings`
**Field type:** Formula
**Returns:** Boolean (1 = blocked, 0 = not blocked)

## Purpose

Marks slots that should never be bookable, even though they fall within the DFZ's open operating hours. Two categories of blocks:

1. **Weekend day-of-week blocks** — Friday (5) and Saturday (6) are blocked entirely.
2. **Early-morning and late-evening hour blocks** — slots starting before 9:00 AM or after 8:30 PM on any day are blocked, even though the time-slot generator produces them as part of the full 6:00 AM – 11:00 PM window.

The generator-vs-block split exists deliberately: the generator produces a wide window so the underlying ledger covers everything, and the formula layer filters down to what's actually offered to users. This lets staff change the blocked hours by editing one formula instead of regenerating all the slot records.

## Formula

```airtableFormulas
IF(
  OR(
    WEEKDAY(SET_TIMEZONE({Start}, "America/Toronto")) = 5,
    WEEKDAY(SET_TIMEZONE({Start}, "America/Toronto")) = 6
  ),
  FIND(
    "," & DATETIME_FORMAT(SET_TIMEZONE({Start}, "America/Toronto"), "HH:mm") & ",",
    ",08:00,08:30,20:00,20:30,"
  ) > 0,
  FIND(
    "," & DATETIME_FORMAT(SET_TIMEZONE({Start}, "America/Toronto"), "HH:mm") & ",",
    ",05:30,06:00,06:30,07:00,07:30,08:00,08:30,22:00,22:30,23:00,23:30,"
  ) > 0
)
```

## How it works

The `FIND(",HH:mm,", ",hh1,hh2,...,")` pattern is a set-membership test: it wraps the candidate time in commas and looks for that exact substring inside a comma-delimited list of blocked times. `FIND` returns `0` when there's no match, so `FIND(...) > 0` is the membership predicate.

The string-set-membership pattern is used instead of a series of `OR(... = ...)` comparisons for two reasons:
1. The formula is editable in one place — just add or remove a time from the comma-delimited list.
2. Airtable's formula editor handles long lists better as strings than as deeply nested `OR()` calls.

`SET_TIMEZONE({Start}, "America/Toronto")` is applied to every reference to `{Start}` so the weekday and hour evaluations happen in Toronto local time, not UTC. Without it, a slot at 11:30 PM Toronto on Friday would evaluate to Saturday UTC and either get double-blocked (if Saturday is blocked) or escape blocking entirely (if it isn't).

## Use in views

The form's available-slot view filters to `Blocked Times = 0`. Staff can adjust block windows by editing this single formula.
