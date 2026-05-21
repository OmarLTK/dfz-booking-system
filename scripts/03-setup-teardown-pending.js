// =============================================================================
// 03-setup-teardown-pending.js
//
// The algorithmically substantive script in the system. When a booking is
// confirmed, this:
//
//   1. Identifies the contiguous run of slots ("booking block") belonging to
//      the trigger record via a connected-component search across the
//      time-sorted slot array, using set intersection on the Booked Slots
//      linked field as the adjacency predicate.
//
//   2. Applies state transitions outward from the block:
//        - TEARDOWN_SLOTS slots immediately after the block, marked Teardown
//        - 1 slot after the teardown, marked Pending (buffer)
//        - If Setup/Teardown checkbox is checked: SETUP_SLOTS slots before
//          the block, marked Setup
//        - If Setup is enabled: 1 slot before the setup, marked Pending
//
//   3. Enforces priority rules on overwrites:
//        - Setup CAN overwrite Pending (the next booking is claiming the buffer)
//        - Setup CANNOT overwrite any other non-empty Type
//        - Nothing can overwrite a slot that already has Booked Slots populated
//
// CHECKBOX SAFETY:
// The isChecked() helper explicitly rejects truthy-but-not-actually-true
// values like the string "0", the string "false", and unwraps lookup arrays.
// Airtable's typing around checkboxes coming from lookups is loose enough that
// this defensive coercion is necessary in practice.
//
// TRIGGER:  When a record is updated in Available Bookings (typically the
//           trigger fires after Booked Slots is populated by script 02).
// INPUTS:   recordId (from trigger record, via input.config())
//
// ENVIRONMENT: Airtable Scripting Extension (sandboxed JavaScript).
// =============================================================================

/***** SETTINGS *****/
const TABLE_NAME  = "Available Bookings";
const START_FIELD = "Start";

const BOOKED_BY_FIELDS = ["Booked Slots"]; // identifies booking block (linked/multi)

const TYPE_FIELD    = "Type";         // single select: Booking, Setup, Teardown, Pending
const TYPE_BOOKING  = "Booking";
const TYPE_SETUP    = "Setup";
const TYPE_TEARDOWN = "Teardown";
const TYPE_PENDING  = "Pending";

const SETUP_TEARDOWN_CHECKBOX = "Setup/Teardown"; // checkbox (or lookup of checkbox)

const SETUP_SLOTS    = 2; // 2 x 30-min = 1 hour
const TEARDOWN_SLOTS = 2; // 2 x 30-min = 1 hour
/********************/

const { recordId } = input.config();
if (!recordId) throw new Error('Missing input "recordId" (Record → ID from trigger).');

const table = base.getTable(TABLE_NAME);
const fieldsToFetch = [START_FIELD, TYPE_FIELD, SETUP_TEARDOWN_CHECKBOX, ...BOOKED_BY_FIELDS];
const query = await table.selectRecordsAsync({ fields: fieldsToFetch });

const byId = new Map(query.records.map(r => [r.id, r]));
const me = byId.get(recordId);
if (!me) throw new Error("Trigger record not found.");

// ---------- helpers ----------
const ts = (r) => {
  const v = r.getCellValue(START_FIELD);
  return v ? new Date(v).getTime() : NaN;
};

// STRICT checkbox checker (prevents "0"/"false" from being treated as true)
function isChecked(v) {
  if (v === true || v === 1 || v === "1") return true;
  if (v === false || v === 0 || v === "0" || v === "false") return false;

  // If it's a lookup returning an array, treat checked only if any element is checked
  if (Array.isArray(v)) return v.some(isChecked);

  // Anything else (including strings like "Yes") should NOT be treated as checked
  return false;
}

function isNonEmpty(v) {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v.trim() !== "";
  return true;
}

const allBookedEmpty = (rec) => BOOKED_BY_FIELDS.every(f => !isNonEmpty(rec.getCellValue(f)));
const typeName = (rec) => rec.getCellValue(TYPE_FIELD)?.name ?? null;

const idsOfAll = (rec) => {
  const out = new Set();
  for (const f of BOOKED_BY_FIELDS) {
    const val = rec.getCellValue(f);
    if (Array.isArray(val)) for (const item of val) out.add(item.id ?? item);
  }
  return out;
};

const sharesAny = (A, B) => {
  for (const x of A) if (B.has(x)) return true;
  return false;
};

function queueTypeUpdate(updatesMap, rec, type) {
  updatesMap.set(rec.id, { id: rec.id, fields: { [TYPE_FIELD]: { name: type } } });
}

function maybePending(updatesMap, rec) {
  if (allBookedEmpty(rec) && !isNonEmpty(rec.getCellValue(TYPE_FIELD))) {
    queueTypeUpdate(updatesMap, rec, TYPE_PENDING);
  }
}

// ---------- sort ----------
const recs = query.records
  .map(r => ({ r, t: ts(r) }))
  .filter(x => !Number.isNaN(x.t))
  .sort((a, b) => a.t - b.t);

const idx = recs.findIndex(x => x.r.id === recordId);
if (idx === -1) throw new Error("Trigger record not found in sorted set (no usable Start).");

// ---------- find booking block ----------
const myIds = idsOfAll(me);
if (myIds.size === 0) {
  console.log("Trigger record has no Booked Slots linkage; nothing to group. Exiting.");
  return;
}

let left = idx;
while (left - 1 >= 0) {
  const prev = recs[left - 1].r;
  if (!sharesAny(myIds, idsOfAll(prev))) break;
  left--;
}
let right = idx;
while (right + 1 < recs.length) {
  const next = recs[right + 1].r;
  if (!sharesAny(myIds, idsOfAll(next))) break;
  right++;
}

// setupEnabled ONLY if checkbox is truly checked inside this booking block
const setupEnabled = recs
  .slice(left, right + 1)
  .some(x => isChecked(x.r.getCellValue(SETUP_TEARDOWN_CHECKBOX)));

const updatesMap = new Map();

// 1) Booking block
for (let i = left; i <= right; i++) {
  queueTypeUpdate(updatesMap, recs[i].r, TYPE_BOOKING);
}

// 2) Teardown: 2 slots after block (don't overwrite booked, and don't overwrite non-empty Type)
for (let k = 1; k <= TEARDOWN_SLOTS; k++) {
  const i = right + k;
  if (i >= recs.length) break;

  const target = recs[i].r;
  if (!allBookedEmpty(target)) continue;                 // don't steal booked slots
  if (isNonEmpty(target.getCellValue(TYPE_FIELD))) continue; // don't overwrite existing Type

  queueTypeUpdate(updatesMap, target, TYPE_TEARDOWN);
}

// 3) Pending after teardown (one slot)
{
  const p = right + TEARDOWN_SLOTS + 1;
  if (p < recs.length) maybePending(updatesMap, recs[p].r);
}

// 4) Setup ONLY if enabled
// Allow Setup to overwrite Pending (but not overwrite other non-pending types)
if (setupEnabled) {
  for (let k = 1; k <= SETUP_SLOTS; k++) {
    const i = left - k;
    if (i < 0) break;

    const target = recs[i].r;

    if (!allBookedEmpty(target)) continue; // don't steal booked slots
    const currentType = typeName(target);

    // allow overwrite if empty or Pending only
    if (currentType && currentType !== TYPE_PENDING) continue;

    queueTypeUpdate(updatesMap, target, TYPE_SETUP);
  }

  // Pending before setup (one slot)
  const p = left - SETUP_SLOTS - 1;
  if (p >= 0) maybePending(updatesMap, recs[p].r);
}

// ---------- write updates ----------
const updates = Array.from(updatesMap.values());
for (let i = 0; i < updates.length; i += 50) {
  await table.updateRecordsAsync(updates.slice(i, i + 50));
}

console.log(
  `Updated ${updates.length} record(s). Booking block [${left}..${right}], Teardown=${TEARDOWN_SLOTS}. ` +
  (setupEnabled ? `Setup=${SETUP_SLOTS} (overwrites Pending only).` : `Setup skipped (checkbox not checked).`)
);
