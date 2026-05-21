# DST handling

## The story

The system was built before a daylight-saving-time transition. Slots were being generated correctly, formula calculations were returning correct values, the system was in production.

DST happened. Several timestamp computations started producing 1-hour-off results. Bookings that displayed as `10:00 AM` to the requestor were appearing as `9:00 AM` in confirmation emails. Formula fields that computed `+30 minutes` were producing `+1 hour 30 minutes` results on the morning of the transition.

The fix wasn't to patch the immediate symptoms. The fix was to rebuild the timezone layer in both places it lived — the JavaScript slot generator and the Airtable formula engine — so the system would survive every future DST transition without intervention. I wrote it that way because I knew I would not be the one maintaining the system next year, and the next intern should not have to debug DST bugs in March.

This document explains both fixes.

## Fix 1: JavaScript timezone offset lookup (per date)

**Where:** [`scripts/01-time-slot-generator.js`](../scripts/01-time-slot-generator.js)

**What was broken:** any approach like `new Date(year, month-1, day, hour, min)` uses the *runtime's* local timezone interpretation, which is whatever the Airtable scripting sandbox happens to use (UTC in practice). To produce a UTC datetime that displays as "10:00 AM Toronto," you need to know Toronto's UTC offset for the specific date in question.

**Why the offset varies by date:** Toronto observes DST. From roughly the second Sunday of March to the first Sunday of November, the offset is UTC-4 (EDT). The rest of the year it's UTC-5 (EST). The transition happens at 2:00 AM local time on those Sundays.

A slot for `10:00 AM January 15` needs to be stored as `15:00 UTC`. A slot for `10:00 AM July 15` needs to be stored as `14:00 UTC`. A naive approach gets one of these right and the other wrong, twice a year.

**The fix:**

```javascript
function torontoOffsetMinutes(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    timeZoneName: "shortOffset",
    year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit"
  }).formatToParts(dt);
  const tzName = parts.find(p => p.type === "timeZoneName")?.value || "GMT-0";
  // tzName like "GMT-4" or "GMT-5"
  const sign = tzName.includes("-") ? -1 : 1;
  const hours = parseInt(tzName.split(/GMT[+-]/)[1], 10) || 0;
  return sign * hours * 60;
}
```

`Intl.DateTimeFormat` with `timeZoneName: "shortOffset"` is a standard JavaScript API that returns the UTC offset for a given IANA timezone at a given instant. By asking it the offset *at noon UTC on the target date*, we get back `GMT-4` in summer and `GMT-5` in winter — automatically, for every date, forever, without any DST-rule maintenance.

The reason for noon UTC specifically (rather than midnight) is to avoid edge cases where the transition itself happens around the date boundary. Noon is comfortably in the middle of the day in any timezone reasonably close to UTC.

Then `torontoLocalToUtc(y, m, d, hh, mm)` uses that offset to construct the correct UTC instant for any Toronto wall-clock time on any date.

## Fix 2: Airtable formula round-trip pattern

**Where:** [`formulas/dst-safe-add-30min.md`](../formulas/dst-safe-add-30min.md)

**What was broken:** Airtable's `DATEADD(datetime, n, unit)` operates on the underlying UTC datetime, not on the displayed local datetime. Adding 30 minutes to a value that crosses a DST wall produces a result that's 30 UTC minutes later — but that's not the same as 30 *wall-clock* minutes later, because the wall clock jumped during that 30 minutes.

Concrete: a slot at `1:30 AM Toronto on DST-spring-forward day` is stored as `06:30 UTC`. `DATEADD(slot, 30, "minutes")` gives `07:00 UTC`. Rendered in Toronto local: `3:00 AM EDT` — because the clock jumped from `2:00 AM EST` to `3:00 AM EDT` at exactly `07:00 UTC`. So we asked for "+30 minutes" and got "+1 hour 30 minutes" of wall-clock time.

**The fix: string round-trip.**

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

Read inside-out: convert to Toronto local → render as a timezone-free string → parse back as a naive (timezone-less) datetime → add 30 minutes (now safe, because there's no timezone for DST to interfere with) → re-apply Toronto timezone.

The pattern strips timezone information from the value before doing arithmetic, then re-applies it. By the time `DATEADD` runs, the value is just a wall-clock string with no awareness of EST/EDT. Adding 30 minutes is purely arithmetic on a number.

See [`../formulas/dst-safe-add-30min.md`](../formulas/dst-safe-add-30min.md) for the full breakdown with all four steps walked through.

## What this looks like in production

DST transitions now happen invisibly. The time-slot generator runs on the 1st of every month and produces correct slots for every day in the rolling 4-month window, regardless of whether that window contains a DST transition. Formula fields compute correct offsets even on the morning of the spring-forward or fall-back. Confirmation emails show the right times.

The next intern doesn't have to know any of this is happening.
