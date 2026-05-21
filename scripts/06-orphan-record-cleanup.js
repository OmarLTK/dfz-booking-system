// =============================================================================
// 06-orphan-record-cleanup.js
//
// Deletes Booking Request records whose linked Google Calendar event no longer
// exists. The Event ID lookup field is populated when a calendar event is
// successfully created and goes empty when the calendar event is deleted —
// either because the calendar owner manually cancelled it, or because the
// event aged off the Google Calendar table via Airtable's sync rules.
//
// Keeps the Booking Request table size bounded so the base stays under
// Airtable's per-base record limit.
//
// TRIGGER:  Scheduled — runs on a schedule (e.g. nightly) on records that
//           match: Event ID (lookup) is empty. Whatever trigger you choose,
//           ensure it does NOT fire on records still in `new request` or
//           `hold` status — those have no Event ID yet but should not be
//           deleted. Gate via the Airtable automation's trigger condition.
// INPUTS:   recordId (from trigger record, via input.config())
//
// ENVIRONMENT: Airtable Scripting Extension (sandboxed JavaScript).
// =============================================================================

// Change this to the exact name of your table
const TABLE_NAME = "SandBox Booking Request";

// Get the recordId passed from the trigger step
const { recordId } = input.config();

let table = base.getTable(TABLE_NAME);

// Get the current record
let record = await table.selectRecordAsync(recordId);
if (!record) {
  // Record may already be gone; nothing to do
  console.log("Record has no Event ID and has already been deleted");
  return;
}

// Get the lookup field value
let eventIdLookup = record.getCellValue("Event ID (from Event ID)");

// For lookup fields, value is either null or an array.
// Treat null or an empty array as "empty".
let isEmpty =
  eventIdLookup == null ||
  (Array.isArray(eventIdLookup) && eventIdLookup.length === 0);

// If the lookup is empty, delete this record
if (isEmpty) {
  await table.deleteRecordAsync(recordId);
  console.log("Record has no Event ID and has been deleted");
}
