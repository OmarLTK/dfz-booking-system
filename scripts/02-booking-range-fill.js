// =============================================================================
// 02-booking-range-fill.js
//
// When a request is confirmed, walks every 30-minute slot in [Start, End) and
// marks each one with Type = "Booking", additionally filling Booked Slots only
// if currently empty (preserves existing data).
//
// RACE CONDITION HANDLING:
// This script depends on the Internal End field, which is populated by a
// separate Airtable automation that may not have finished writing yet when
// this script fires (Airtable automations run independently with no native
// synchronization). The resolveEnd() function implements a retry-with-sleep
// loop: up to 10 attempts at 500ms intervals, calling reloadAsync() defensively
// (with optional chaining in case the API doesn't expose it on this record
// type), exiting cleanly if the upstream automation never completes.
//
// TRIGGER:  When a record matches conditions: Booking Status = "confirmed"
//           AND External = 1 (or whatever the appropriate trigger is in your
//           automation builder).
// INPUTS:   recordId (from trigger record, via input.config())
// OUTPUTS:  Updates Type = "Booking" on every slot in [Start, End), and
//           Booked Slots if previously empty.
//
// ENVIRONMENT: Airtable Scripting Extension (sandboxed JavaScript).
// =============================================================================

/***** SETTINGS *****/
const TABLE_NAME      = "Available Bookings";
const START_FIELD     = "Start";
const INTERNAL_END    = "Internal End";

const CAL_END_LOOKUP  = "End (lookup)";   // optional

const BOOKED_FIELD     = "Booked Slots";
const TYPE_FIELD       = "Type";
const SET_TYPE_TO      = "Booking";       // set null to skip
const SLOT_LENGTH_MINS = 30;
/********************/

const STEP_MS = SLOT_LENGTH_MINS * 60 * 1000;

const table = base.getTable(TABLE_NAME);
const hasTypeField = table.fields.some(f => f.name === TYPE_FIELD);

function isNonEmptyCellValue(v) {
  if (!v) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v.trim() !== "";
  return true;
}

function isEmptyCellValue(v) {
  return !isNonEmptyCellValue(v);
}

function toMs(v) {
  return v ? new Date(v).getTime() : null;
}

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

// ---- main ----
const { recordId } = input.config();
if (!recordId) throw new Error('Missing input "recordId" (Record → ID from trigger).');

const rec = await table.selectRecordAsync(recordId);
if (!rec) throw new Error("Trigger record not found.");

const startMs = toMs(rec.getCellValue(START_FIELD));
if (!startMs) {
  console.log("Start is blank; exiting.");
  return;
}

const endMs = await resolveEnd(rec);
if (!endMs || !(endMs > startMs)) {
  console.log("Internal End not available yet or not after Start; exiting.");
  return;
}

// Decide what booked value to use if we need to fill empties
let triggerBookedValue = rec.getCellValue(BOOKED_FIELD);
const bookedFallback = "Calendar Booking";
const bookedToApply = isNonEmptyCellValue(triggerBookedValue) ? triggerBookedValue : bookedFallback;

// index all slots by Start timestamp
const fetchFields = [START_FIELD, TYPE_FIELD, BOOKED_FIELD];
const q = await table.selectRecordsAsync({ fields: fetchFields });

const slotByTs = new Map();
for (const r of q.records) {
  const s = r.getCellValue(START_FIELD);
  if (s) slotByTs.set(new Date(s).getTime(), r);
}

// cover each slot in [Start, End) INCLUDING the first slot
const updates = [];

for (let t = startMs; t < endMs; t += STEP_MS) {
  const slot = slotByTs.get(t);
  if (!slot) continue;

  const slotBookedValue = slot.getCellValue(BOOKED_FIELD);
  const slotTypeValue   = slot.getCellValue(TYPE_FIELD); // usually {name: "..."} or null

  const fields = {};

  // Only fill Booked Slots if empty (do not overwrite existing)
  if (isEmptyCellValue(slotBookedValue)) {
    fields[BOOKED_FIELD] = bookedToApply;
  }

  // Always set Type for slots in the booking range (even if Booked Slots already exists)
  if (hasTypeField && SET_TYPE_TO) {
    const currentTypeName = slotTypeValue?.name;
    if (currentTypeName !== SET_TYPE_TO) {
      fields[TYPE_FIELD] = { name: SET_TYPE_TO };
    }
  }

  if (Object.keys(fields).length > 0) {
    updates.push({ id: slot.id, fields });
  }
}

// batch update
for (let i = 0; i < updates.length; i += 50) {
  await table.updateRecordsAsync(updates.slice(i, i + 50));
}

console.log(`Updated ${updates.length} slot(s) in the booking range (including the first slot).`);
