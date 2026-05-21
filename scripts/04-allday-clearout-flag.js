// =============================================================================
// 04-allday-clearout-flag.js
//
// Heuristic flagging script run on every new form submission. Sets two
// checkbox fields on the Booking Request record:
//
//   - Clear Out: set if the event category is "Workshop" or "Competition"
//                (the user can also trigger this from the form directly via
//                "Does this event require space to be rearranged?")
//
//   - All Day:   set if the event duration is >= 7 hours. If All Day is set,
//                Clear Out is also forced on (any all-day event implicitly
//                requires the space to be reset).
//
// TRIGGER:  When a record is created in SandBox Booking Request.
// INPUTS:   recordId (from trigger record, via input.config())
//
// NOTES ON FIXES APPLIED FOR PUBLIC RELEASE:
//   1. The original code crashed if `Category` was null (referenced
//      `category.name` directly after a `category?.name` safe access). Fixed
//      by consistently using the already-computed `catName` variable.
//   2. The original code made two sequential updateRecordAsync calls when
//      both All Day and Clear Out needed to be set. Batched into one call.
//
// ENVIRONMENT: Airtable Scripting Extension (sandboxed JavaScript).
// =============================================================================

let { recordId } = input.config();

// Reference the table
let table = base.getTable("SandBox Booking Request");

// Fetch the full record using the ID
let newRecord = await table.selectRecordAsync(recordId);

if (!newRecord) {
  throw new Error("No record found with the given recordId."); // Stops script
}

// use getCellValue since a new record has been created
let eventName = newRecord.getCellValue("Name");
let participants = newRecord.getCellValue("Number of Participants");

// Sanity check (is info being collected?)
console.log("Event name:", eventName);
console.log("Participant count:", participants);

// If participants are low, clear out from participant count is not needed.
// Category and duration checks still run below.
if (participants <= 49) {
  console.log("Participant count too low to trigger clear out on its own. Checking category and duration.");
}

// Check duration
let duration = newRecord.getCellValue("Duration");
console.log("Duration is:", duration);

// Clear out from category (FIXED: use catName, not category.name)
let category = newRecord.getCellValue("Category");
let catName = category?.name ?? null;
console.log("Category is:", catName);

let allDay = false;
let setClearOutFromCategory = (catName === "Competition" || catName === "Workshop");

// All-day check
if (duration >= 7) {
  allDay = true;
}

// Apply updates in a single batched call rather than two sequential ones.
let fieldsToSet = {};
if (setClearOutFromCategory || allDay) {
  fieldsToSet["Clear Out"] = true;
}
if (allDay) {
  fieldsToSet["All Day"] = true;
}

if (Object.keys(fieldsToSet).length > 0) {
  await table.updateRecordAsync(newRecord.id, fieldsToSet);
  const labels = [];
  if (allDay) labels.push("All Day");
  if (setClearOutFromCategory || allDay) labels.push("Clear Out");
  console.log(`Event flagged: ${labels.join(" & ")}`);
} else {
  console.log("Event is not flagged as Clear Out or All Day.");
}
