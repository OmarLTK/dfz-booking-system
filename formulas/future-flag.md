# `Future?` formula field

**Lives on:** `Available Bookings`
**Field type:** Formula
**Returns:** Boolean (`true` or `false`, rendered as 1/0)

## Purpose

Marks whether a slot's `Start` time is at least 1 hour in the future relative to the current Toronto local time. Slots in the past or imminent (within the next hour) evaluate to `false` and are filtered out of the public booking form's available-slots view.

## Formula

```airtableFormulas
DATETIME_DIFF(
  DATEADD({Start}, 1, 'hours'),
  SET_TIMEZONE(NOW(), 'America/Toronto'),
  'hours'
) > 0
```

## How it works

1. `DATEADD({Start}, 1, 'hours')` shifts the slot's start time forward by 1 hour. This is the threshold the slot must beat — i.e., the slot is "future enough" if `Start + 1 hour` is still later than now.
2. `SET_TIMEZONE(NOW(), 'America/Toronto')` produces "right now" in Toronto local time, normalizing the formula's internal datetime so the diff is comparable.
3. `DATETIME_DIFF(..., ..., 'hours') > 0` returns true when the shifted slot time is later than now.

The 1-hour grace period exists so that a user cannot request a slot that starts in 5 minutes and expect to actually use it — there's no time for staff to acknowledge the request, let alone confirm and prepare the space.

## Use in views

The form's "Available Time Slots" linked-record picker is backed by a view filtered to `Future? = 1`. Slots automatically drop off the picker as they move into the past.
