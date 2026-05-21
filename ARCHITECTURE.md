# Architecture

This document walks through the schema, the relationships between tables, and the automation graph that drives the system. For the *why* behind specific design decisions (sync inversion, pending slots, DST handling), see the docs under [`docs/`](docs/).

---

## Three tables

### 1. `Sandbox Calendar`

**Purpose:** Read-only sync target for the DFZ's Google Calendar. Cannot be edited from Airtable.

**Fields (relevant subset):**

| Field         | Type            | Notes                                                                                            |
|---------------|-----------------|--------------------------------------------------------------------------------------------------|
| Title         | Text (synced)   | Event title from Google Calendar.                                                                |
| Start         | DateTime (synced) | Event start time.                                                                              |
| End           | DateTime (synced) | Event end time.                                                                                |
| Event ID      | Text (synced)   | Google Calendar event ID. Stable identifier used for linkbacks.                                  |
| SandBox Booking Request | Link (lookup back) | Linked record back to the Booking Request, populated by automation for form-originated bookings. |
| External (from SandBox Booking Request) | Lookup | Returns `[1]` for form-originated events, `[]` for manually-created events. The provenance flag. |

**Views:**
- `Grid` — default tabular view.
- `Calendar` — grouped by date, rendered as a calendar grid.

### 2. `SandBox Booking Request`

**Purpose:** Writable proxy table. Every booking request — form submission, manual mirror, or legacy — lives here. The 4-state request workflow runs on this table.

**Fields (relevant subset):**

| Field                  | Type                  | Notes                                                                                  |
|------------------------|-----------------------|----------------------------------------------------------------------------------------|
| Title                  | Text                  | Event title.                                                                           |
| Booking Status         | Single Select         | One of: `new request`, `hold`, `confirmed`, `rejected`. Default `new request`.         |
| External               | Number                | `1` if form-originated (hidden form field sets this), empty otherwise.                 |
| Creator                | Email                 | Requestor's email address.                                                             |
| Name                   | Text                  | Requestor's name.                                                                      |
| Category               | Single Select         | Event category (e.g. Workshop, Competition, Meeting).                                  |
| Number of Participants | Number                | Headcount. Cap is enforced in the form.                                                |
| Description            | Long Text             | Free-text event description.                                                           |
| Duration               | Number (rollup)       | Computed duration in hours from `maxBookedSlots - minBookedSlots`.                     |
| Booked Slots           | Link → Available Bookings | The set of 30-minute slots claimed by this booking.                                |
| Internal End           | Formula               | End of the booking, derived from `maxBookedSlots + 30 min`. Used by script 02.         |
| Event ID               | Link → Sandbox Calendar | Linked back to the calendar event created on confirmation.                            |
| Event ID (from Event ID) | Lookup              | Pulls the actual Event ID text from the Calendar table. Used by script 06.             |
| Clear Out              | Checkbox              | Set by user in form or by script 04.                                                   |
| All Day                | Checkbox              | Set by script 04 if duration ≥ 7 hours.                                                |
| Notes (Included in Rejection Email) | Long Text | Free-text rejection reason, included in the rejection email if populated.       |

**Views:**
- `External Requests` — filtered to `External = 1`, grouped by Booking Status.
- `Internal Requests` — filtered to `External ≠ 1`, sorted by date.
- `Clear Out Request` — filtered to Booking Status = `new request` AND Clear Out = checked.
- `Grid View` — default.
- `Form` — the public form.
- `Timeline of Requests` — visual timeline view.
- `New Requests ordered by Date Start` — staff triage view.
- `Playground` — for testing.

### 3. `Available Bookings`

**Purpose:** Per-slot ledger. Each record is a single 30-minute time slot. The form queries this table to determine what's available.

**Fields (relevant subset):**

| Field           | Type                  | Notes                                                                                |
|-----------------|-----------------------|--------------------------------------------------------------------------------------|
| Start           | DateTime              | Slot start (UTC, displayed in Toronto local). Generated by script 01.                |
| Duration        | Text                  | Always `"30 Minutes"`. Stored for human readability.                                 |
| Type            | Single Select         | Slot state: `Booking`, `Setup`, `Teardown`, `Pending`, or empty (available).         |
| Booked Slots    | Link → SandBox Booking Request | Reverse link from the request's Booked Slots field.                          |
| Future?         | Formula               | Boolean. `1` if slot is at least 1 hour in the future. Filters past slots from form. |
| Blocked Times   | Formula               | Boolean. `1` if slot is in a manually-blocked window (weekend or off-hours).         |
| Internal End    | Lookup                | Pulls the Internal End from the linked Booking Request. Used by script 02.           |

**Views:**
- `All Time Slots` — every generated slot, sorted by date/time.
- `All Bookings` — combines slots flagged as Booking, Setup, or Teardown.
- `All Available Bookings` — filtered to `Future? = 1` AND `Blocked Times = 0` AND `Type` empty. This is what the form's slot picker queries.

---

## Automation graph

Every automation in the base, what it triggers on, and which script (if any) it runs.

| Automation                              | Trigger                                              | Action                                                                                  |
|-----------------------------------------|------------------------------------------------------|-----------------------------------------------------------------------------------------|
| **CreateDelete Booking Slots**          | Scheduled, monthly (1st of month)                    | Runs [`01-time-slot-generator.js`](scripts/01-time-slot-generator.js). Also deletes slots older than current month to stay under record limit. |
| **Flag All Day / Clear Out Event**      | Record created in `SandBox Booking Request`          | Runs [`04-allday-clearout-flag.js`](scripts/04-allday-clearout-flag.js).                |
| **Send Booking Request Email**          | Form submitted on `SandBox Booking Request`          | Sends Gmail notification to staff; updates External field; sends Slack message.         |
| **Create Calendar For Approved Events** | Record matches: Booking Status = `confirmed` AND External = 1 | Sends confirmation email to user via Gmail; creates Google Calendar event.           |
| **Rejection Email**                     | Record matches: Booking Status = `rejected`          | Sends rejection email via Gmail (optionally includes Notes content as the reason).      |
| **Move sync bookings to block external overlap** | Record created in `SandBox Booking Request` | (Slot-overlap-blocking automation; specifics depend on base configuration.)             |
| **Fill all sync booking slots**         | Record updated in `SandBox Booking Request`          | Runs [`02-booking-range-fill.js`](scripts/02-booking-range-fill.js).                    |
| **(Setup/Teardown/Pending)**            | Record updated in `Available Bookings` (Booked Slots populated) | Runs [`03-setup-teardown-pending.js`](scripts/03-setup-teardown-pending.js).      |
| **Delete Events**                       | Record updated in `SandBox Booking Request` where Event ID lookup goes empty | Runs [`06-orphan-record-cleanup.js`](scripts/06-orphan-record-cleanup.js). |
| **Operation: keep DFZ from looking like a natural disaster** | Record matches: Booking Status = `rejected` | Runs [`05-rejection-cleanup.js`](scripts/05-rejection-cleanup.js).            |
| **Image Collection**                    | Record updated, image attached                       | Image management automation (out of scope for this repo).                               |
| **Card Access Automations Test**        | (Card-access related)                                | Out of scope.                                                                           |
| **Notify of Card Access Expiry Date**   | Scheduled                                            | Out of scope.                                                                           |
| **Unanswered SandBox Bookings**         | Scheduled                                            | Finds Booking Requests that have been in `new request` status for too long and pings staff. |

---

## End-to-end booking flow (happy path)

1. **User submits form.** Form writes a new record to `SandBox Booking Request` with `External = 1` and `Booking Status = "new request"`.
2. **Send Booking Request Email** automation fires. Slack message goes to the DFZ channel; Gmail goes to staff.
3. **Flag All Day / Clear Out Event** automation fires in parallel. Runs script 04 to set `Clear Out` and `All Day` based on category, duration, and participant count.
4. **Staff reviews the request** in the `External Requests` view, grouped by Booking Status.
5. **Staff approves.** Set Booking Status to `confirmed`.
6. **Create Calendar For Approved Events** automation fires. Sends confirmation email to user and creates the Google Calendar event.
7. **Fill all sync booking slots** automation fires. Runs script 02, which:
   - Waits for `Internal End` to be populated (race condition handled with retry loop).
   - Walks every slot in `[Start, End)` and marks Type = `Booking`.
8. **Setup/Teardown/Pending** automation fires for each slot updated in step 7. Runs script 03, which:
   - Identifies the full booking block via connected-component search.
   - Applies Setup before, Teardown after, Pending buffers.
9. **Google Calendar one-way sync** brings the new event into `Sandbox Calendar`.
10. **Move sync bookings to block external overlap** automation fires. Checks the External lookup length:
    - `length = 1` → form-originated, already mirrored, skip.
    - `length ≠ 1` → manually created, create a mirror Booking Request to drive slot-blocking.

---

## End-to-end rejection flow

1. **Staff sets Booking Status = `rejected`.** Optionally fills in `Notes (Included in Rejection Email)` first.
2. **Rejection Email** automation fires. Sends rejection email with the Notes content included if present.
3. **Operation: keep DFZ from looking like a natural disaster** automation fires. Runs script 05, which:
   - Resolves the rejected request's linked slots.
   - Walks each slot's neighbors asymmetrically: clears Setup/Pending above, Teardown/Pending below.
   - Leaves the previous booking's Teardown and the next booking's Setup intact.

---

## Constants and tuning parameters

Per-script tuning lives in each script's `SETTINGS` block at the top. The key tunables:

| Parameter         | File                            | Default | Purpose                                                                 |
|-------------------|---------------------------------|---------|-------------------------------------------------------------------------|
| `DAYS_TO_CREATE`  | 01-time-slot-generator.js       | 121     | Slot generation horizon (~4 months).                                    |
| `WEEKDAY_OPEN_H`  | 01-time-slot-generator.js       | 6       | Slot generation window open hour (weekday).                             |
| `WEEKDAY_CLOSE_H` | 01-time-slot-generator.js       | 23      | Slot generation window close hour (weekday).                            |
| `WEEKEND_OPEN_H`  | 01-time-slot-generator.js       | 8       | Slot generation window open hour (weekend).                             |
| `WEEKEND_CLOSE_H` | 01-time-slot-generator.js       | 21      | Slot generation window close hour (weekend).                            |
| `SETUP_SLOTS`     | 03-setup-teardown-pending.js    | 2       | Number of 30-min slots reserved for Setup before a booking.             |
| `TEARDOWN_SLOTS`  | 03-setup-teardown-pending.js    | 2       | Number of 30-min slots reserved for Teardown after a booking.           |
| `NEIGHBOR_SLOTS`  | 05-rejection-cleanup.js         | 3       | Max slots to walk in each direction during cleanup (covers Setup/Teardown + Pending buffer). |
| Retry count       | 02-booking-range-fill.js        | 10      | Internal End retry budget (10 × 500ms = 5 seconds max wait).            |

---

## See also

- [`README.md`](README.md) — top-level repo overview.
- [`docs/sync-inversion-pattern.md`](docs/sync-inversion-pattern.md) — why three tables.
- [`docs/pending-slot-algorithm.md`](docs/pending-slot-algorithm.md) — why pending exists, how it works.
- [`docs/dst-handling.md`](docs/dst-handling.md) — the DST war story.
- [`docs/race-condition-handling.md`](docs/race-condition-handling.md) — the retry loop in script 02.
- [`diagrams/`](diagrams/) — renderable Mermaid sources of the three-table architecture, both state machines, and the end-to-end sequence.
