# Sync inversion pattern

## The constraint

Airtable's native Google Calendar integration is **one-way**: a Google Calendar can be synced *into* an Airtable table, but Airtable cannot push changes *out* through that same integration. Records in the synced table are read-only from Airtable's perspective.

For a booking system, this is a serious problem. We need both directions:

- **Calendar → Airtable** so manually created Google Calendar events block out slots in the booking system (otherwise an internal staff member's calendar event would not prevent an external requestor from double-booking the space).
- **Airtable → Calendar** so confirmed form submissions create real Google Calendar events that staff can see in their normal calendar workflow.

The obvious workaround — bypass the sync and write directly to the Google Calendar API from Airtable automations — works but breaks the source-of-truth model. Now you have two write paths into Google Calendar (manual edits in Calendar, and automation pushes from Airtable), with no automatic reconciliation between them.

## The solution: three tables and a provenance flag

The system uses three tables that, together, simulate bidirectional sync while keeping Airtable as a write-only-via-API consumer of the Calendar:

```
┌──────────────────┐     read-only      ┌────────────────────┐
│ Sandbox Calendar │ ◀──────sync─────── │  Google Calendar   │
│ (Airtable table) │                    │  (external system) │
└──────────────────┘                    └────────────────────┘
        │                                         ▲
        │ trigger on insert                       │
        │ (auto-flag external)                    │ Airtable automation
        ▼                                         │ creates events here
┌──────────────────────────┐                      │ on confirmed bookings
│ SandBox Booking Request  │ ─────────────────────┘
│ (writable proxy table)   │
└──────────────────────────┘
        │
        │ Booked Slots linked field
        ▼
┌──────────────────┐
│ Available        │
│ Bookings         │
└──────────────────┘
```

**`Sandbox Calendar`** is the read-only sync target. Every event in the Google Calendar appears here. We never write to it from Airtable.

**`SandBox Booking Request`** is the writable proxy. Two ways records appear here:
1. A user submits the booking form. The form writes directly to this table.
2. An automation detects a new manually-created event in `Sandbox Calendar` and creates a mirror record here.

**`Available Bookings`** is the per-slot ledger. The form-facing "what's available?" view reads from this table. Slot blocking happens here via the `Booked Slots` linked field — when a Booking Request links to a set of slots, those slots become unavailable in the form's view.

## The provenance problem

When a record appears in `Sandbox Calendar`, the automation that creates a mirror in `SandBox Booking Request` needs to know: did this calendar event originate from a form submission (in which case there's *already* a Booking Request record for it, and we should not create a duplicate), or was it created manually in Google Calendar (in which case we need a new Booking Request to drive the slot-blocking logic)?

Google Calendar doesn't carry a "created by Airtable" flag. The sync just brings the event in.

## The trick: `External` as a provenance flag

The form has a hidden field called `External` that gets set to `1` on every form submission. (It's `0` or empty otherwise.) `External` is a Number field, not a checkbox — see the resolution rules below.

When a form-originated Booking Request becomes `confirmed`, the corresponding Google Calendar event is created via Airtable automation. That event is linked back to the original Booking Request record (via Event ID), which carries `External = 1`.

So now, when the calendar event syncs back into `Sandbox Calendar`, we can look up the linked Booking Request and check its `External` value:

| Source                       | `External` lookup from `Sandbox Calendar`   | Action                            |
|------------------------------|---------------------------------------------|-----------------------------------|
| Form submission              | `[1]` (length = 1)                          | Skip — request already exists.    |
| Manual Google Calendar event | `[]` (length = 0) or null                   | Create a Booking Request mirror.  |

The automation's condition is literally:

> If `External (from SandBox Booking Request)` **length ≠ 1**, then create a record in `SandBox Booking Request`.

`length` here is the array length of the lookup field — `1` if there's a back-link to a form-originated Booking Request, `0` if the calendar event was created manually and no Booking Request exists yet.

## Why this works

`External` is a **provenance flag that survives the round trip** through the linked-record relationship. The form sets it, the Booking Request stores it, the Calendar event's link-back reflects it, the `Sandbox Calendar` lookup retrieves it, and the automation reads it to decide whether to mirror.

The clever part isn't the field itself — it's using **lookup-field cardinality** (the *length* of the lookup array) as the provenance signal, rather than reading the field's value. A record either has a back-link or it doesn't; that binary fact tells you everything you need.

## Edge cases handled

- **Manual edit of a form-originated event in Google Calendar.** The event already has a Booking Request mirror (`External = 1`), so the lookup still returns `[1]` and no duplicate is created. Slot-blocking continues to work.
- **Manual deletion of a form-originated event in Google Calendar.** The Booking Request's `Event ID (from Event ID)` lookup goes empty, and [`scripts/06-orphan-record-cleanup.js`](../scripts/06-orphan-record-cleanup.js) deletes the orphan Booking Request to keep the table bounded.
- **Manual creation of an event in Google Calendar.** No back-link exists, lookup returns `[]`, automation creates a mirror Booking Request with `External` set to `0` (or unset). The mirror exists for slot-blocking purposes; staff don't need to touch it.
