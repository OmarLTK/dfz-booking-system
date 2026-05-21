// =============================================================================
// 05-rejection-cleanup.js
//
// Inverse of 03-setup-teardown-pending.js. When a Booking Request is rejected
// (or otherwise needs slot release), this clears the Type field on the linked
// slots AND on neighboring Setup/Teardown/Pending slots that belonged to this
// booking.
//
// ASYMMETRIC NEIGHBOR RULES:
//   - Above the booking (earlier slots): clear if Type is Setup or Pending.
//     A Teardown slot above the booking belongs to the PREVIOUS booking and
//     must not be cleared.
//   - Below the booking (later slots): clear if Type is Teardown or Pending.
//     A Setup slot below belongs to the NEXT booking and must not be cleared.
//
// DUAL-SOURCE TRIGGER:
//   The script can be invoked with recordId from either:
//     - the Available Bookings table directly (recordId is a slot), OR
//     - the SandBox Booking Request table (recordId is a request, the script
//       resolves the linked slots via the Booked Slots field).
//   This lets the same script be wired into multiple automations.
//
// TRIGGER:  When Booking Status = "rejected" (typically), or any other event
//           where slot release is required.
// INPUTS:   recordId (from trigger record, via input.config())
//
// ENVIRONMENT: Airtable Scripting Extension (sandboxed JavaScript).
// =============================================================================

/***** SETTINGS *****/
const SLOT_TABLE_NAME = "Available Bookings";
const START_FIELD     = "Start";     // datetime in slots table
const TYPE_FIELD      = "Type";      // single select to clear

// If the automation trigger record is from a different table:
const TRIGGER_TABLE_NAME  = "SandBox Booking Request"; // change if needed
const LINK_TO_SLOTS_FIELD = "Booked Slots";            // link field on trigger table

const NEIGHBOR_SLOTS = 3;
// 3 = max possible chain length above/below a booking: 2 Setup/Teardown + 1 Pending.
// Asymmetric with 03's SETUP_SLOTS=2/TEARDOWN_SLOTS=2 because cleanup also
// needs to release the Pending buffer slot that sits beyond the Setup/Teardown.

// Allowed types to clear
const CLEAR_ABOVE_TYPES = new Set(["Setup", "Pending"]);
const CLEAR_BELOW_TYPES = new Set(["Teardown", "Pending"]);
/********************/

const { recordId } = input.config();
if (!recordId) throw new Error('Missing input "recordId".');

const slotTable = base.getTable(SLOT_TABLE_NAME);

// 1) Decide which slot record IDs we are starting from
let seedSlotIds = [];

// If recordId is a slot record, use it directly
const maybeSlot = await slotTable.selectRecordAsync(recordId);
if (maybeSlot) {
  seedSlotIds = [recordId];
} else {
  // Otherwise treat recordId as a trigger-table record and pull linked slots
  const triggerTable = base.getTable(TRIGGER_TABLE_NAME);
  const triggerRec = await triggerTable.selectRecordAsync(recordId);
  if (!triggerRec) {
    throw new Error(
      `Record ${recordId} not found in "${SLOT_TABLE_NAME}" or "${TRIGGER_TABLE_NAME}". ` +
      `Check which Record ID you're passing into the script.`
    );
  }

  const linked = triggerRec.getCellValue(LINK_TO_SLOTS_FIELD) || [];
  seedSlotIds = (Array.isArray(linked) ? linked : [])
    .map(x => x.id ?? x)
    .filter(Boolean);

  if (seedSlotIds.length === 0) {
    console.log(`No linked records in "${LINK_TO_SLOTS_FIELD}". Nothing to clear.`);
    return;
  }
}

// 2) Load all slots, sort by Start, and build helpers
const slotsQuery = await slotTable.selectRecordsAsync({ fields: [START_FIELD, TYPE_FIELD] });

const rows = slotsQuery.records
  .map(r => ({
    r,
    t: r.getCellValue(START_FIELD) ? new Date(r.getCellValue(START_FIELD)).getTime() : NaN
  }))
  .filter(x => !Number.isNaN(x.t))
  .sort((a, b) => a.t - b.t);

const indexById = new Map(rows.map((x, i) => [x.r.id, i]));

function typeName(rec) {
  const v = rec.getCellValue(TYPE_FIELD);
  // single select -> {name, id, color}, sometimes string if misconfigured
  if (!v) return null;
  if (typeof v === "string") return v;
  return v?.name ?? null;
}

// 3) Build set of records to clear
const toClearIds = new Set();

for (const id of seedSlotIds) {
  const idx = indexById.get(id);
  if (idx == null) continue;

  // Always clear the seed slot itself
  toClearIds.add(rows[idx].r.id);

  // Clear up to NEIGHBOR_SLOTS above if type is Setup or Pending
  for (let k = 1; k <= NEIGHBOR_SLOTS; k++) {
    const i = idx - k;
    if (i < 0) break;

    const tn = typeName(rows[i].r);
    if (CLEAR_ABOVE_TYPES.has(tn)) {
      toClearIds.add(rows[i].r.id);
    }
  }

  // Clear up to NEIGHBOR_SLOTS below if type is Teardown or Pending
  for (let k = 1; k <= NEIGHBOR_SLOTS; k++) {
    const i = idx + k;
    if (i >= rows.length) break;

    const tn = typeName(rows[i].r);
    if (CLEAR_BELOW_TYPES.has(tn)) {
      toClearIds.add(rows[i].r.id);
    }
  }
}

if (toClearIds.size === 0) {
  console.log("No matching slot records found to clear (missing Start values or IDs not in slot table).");
  return;
}

// 4) Update in batches
const updates = Array.from(toClearIds).map(id => ({
  id,
  fields: { [TYPE_FIELD]: null }
}));

for (let i = 0; i < updates.length; i += 50) {
  await slotTable.updateRecordsAsync(updates.slice(i, i + 50));
}

console.log(
  `Cleared "${TYPE_FIELD}" on ${updates.length} slot(s). ` +
  `Above cleared if Setup/Pending; below cleared if Teardown/Pending; range=${NEIGHBOR_SLOTS}.`
);
