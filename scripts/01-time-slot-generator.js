// =============================================================================
// 01-time-slot-generator.js
//
// Bulk-creates 30-minute time slots in the "Available Bookings" table for a
// rolling 4-month horizon, respecting weekday/weekend operating hours.
//
// DST-AWARE: looks up Toronto's UTC offset for each specific calendar date the
// slot lives on (via Intl.DateTimeFormat with timeZoneName: "shortOffset"), so
// "10:00 AM Toronto local time" lands at the correct UTC instant in both EST
// (UTC-5, winter) and EDT (UTC-4, summer). A naive new Date(y, m-1, d, hh, mm)
// would silently produce 1-hour-off slots twice a year on DST transitions.
//
// TRIGGER:  Scheduled — runs on the 1st of every month.
//           Can also be run manually from the Airtable scripting extension to
//           backfill the initial slot ledger after first deployment.
// INPUTS:   None (uses constants below).
// OUTPUTS:  Creates records in "Available Bookings" with Start (datetime) and
//           Duration (text, "30 Minutes") fields populated. Skips any slots
//           whose Start timestamp already exists in the table.
//
// ENVIRONMENT: Airtable Scripting Extension (sandboxed JavaScript).
// =============================================================================

/***** SETTINGS *****/
const TABLE_NAME     = "Available Bookings";
const START_FIELD    = "Start";                // datetime
const DURATION_FIELD = "Duration";             // optional text
const DURATION_TEXT  = "30 Minutes";

const SLOT_MINUTES   = 30;                     // 30-minute slots
const STEP_MIN       = 30;                     // step by 30 minutes
const DAYS_TO_CREATE = 121;                    // ~4 months
const TZ             = "America/Toronto";

// Hours are "end time" (close). Example: open 6, close 23 => last start 22:30 (10:30–11:00pm).
const WEEKDAY_OPEN_H = 6;   // 6:00 AM
const WEEKDAY_CLOSE_H= 23;  // 11:00 PM

const WEEKEND_OPEN_H = 8;   // 8:00 AM
const WEEKEND_CLOSE_H= 21;  // 9:00 PM
/********************/

/**
 * Get the timezone offset (in minutes) for Toronto on a given calendar date.
 * Uses noon UTC for the day to avoid midnight-edge weirdness around DST cutover.
 * Returns e.g. -240 for EDT, -300 for EST.
 */
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

/** Build a UTC Date for a given Toronto local wall time. */
function torontoLocalToUtc(y, m, d, hh, mm) {
  const offsetMin = torontoOffsetMinutes(y, m, d);
  // UTC = Local - offset
  const utcMs = Date.UTC(y, m - 1, d, hh, mm, 0, 0) - offsetMin * 60 * 1000;
  return new Date(utcMs);
}

/** Midnight in local JS environment (not used for TZ math) */
function atLocalMidnight(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

const table = base.getTable(TABLE_NAME);
const hasDurationField = table.fields.some(f => f.name === DURATION_FIELD);

// Pull existing Start values once to avoid duplicates
const query = await table.selectRecordsAsync({ fields: [START_FIELD] });
const existingStarts = new Set(
  query.records
    .map(r => r.getCellValue(START_FIELD))
    .filter(Boolean)
    .map(s => new Date(s).getTime())
);

// Start from tomorrow
const todayMid = atLocalMidnight(new Date());
const startDay = new Date(todayMid);
startDay.setDate(startDay.getDate() + 1);

const creates = [];

for (let dayOffset = 0; dayOffset < DAYS_TO_CREATE; dayOffset++) {
  const d = new Date(startDay);
  d.setDate(d.getDate() + dayOffset);

  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();

  // Toronto weekday/weekend based on the date
  const dow = d.getDay(); // 0=Sun ... 6=Sat
  const isWeekend = (dow === 0 || dow === 6);

  const OPEN_LOCAL_H  = isWeekend ? WEEKEND_OPEN_H  : WEEKDAY_OPEN_H;
  const CLOSE_LOCAL_H = isWeekend ? WEEKEND_CLOSE_H : WEEKDAY_CLOSE_H;

  // Total open minutes in the day window (e.g., 6:00 -> 23:00 = 1020 minutes)
  const openWindowMinutes = (CLOSE_LOCAL_H - OPEN_LOCAL_H) * 60;

  // Last valid start is such that start + SLOT_MINUTES <= close
  for (let minutesFromOpen = 0; minutesFromOpen <= openWindowMinutes - SLOT_MINUTES; minutesFromOpen += STEP_MIN) {
    const hh = OPEN_LOCAL_H + Math.floor(minutesFromOpen / 60);
    const mm = minutesFromOpen % 60;

    // Build the exact UTC instant that displays as hh:mm in Toronto on that date
    const dt = torontoLocalToUtc(y, m, day, hh, mm);

    // Skip duplicates
    if (existingStarts.has(dt.getTime())) continue;

    const fields = { [START_FIELD]: dt };
    if (hasDurationField) fields[DURATION_FIELD] = DURATION_TEXT;
    creates.push({ fields });
  }
}

// Create records in batches (Airtable's batch limit is 50 per call)
for (let i = 0; i < creates.length; i += 50) {
  await table.createRecordsAsync(creates.slice(i, i + 50));
}

console.log(
  `Created ${creates.length} slots for ${DAYS_TO_CREATE} day(s) in Toronto (DST-safe). ` +
  `Weekdays ${WEEKDAY_OPEN_H}:00–${WEEKDAY_CLOSE_H}:00, Weekends ${WEEKEND_OPEN_H}:00–${WEEKEND_CLOSE_H}:00.`
);
