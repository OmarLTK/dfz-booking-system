# DFZ Booking System

A production booking system for the **Design Fabrication Zone** (DFZ) makerspace at the Innovation Boost Zone, Toronto Metropolitan University. Built entirely inside Airtable's scripting extension, formula engine, and automation builder, with bidirectional integration to Google Calendar, Slack, and Gmail.

The system is in active production at TMU and was designed and built end-to-end by [Omar Ali-Yare](https://www.linkedin.com/in/omar-ali-yare/) during a Special Projects internship at IBZ (Sep 2025 – Apr 2026). Published with IBZ's permission.

---

## What it does

Anyone — internal staff or external requestor — can submit a booking request through a public form. The system:

1. **Generates** 30-minute time slots on a rolling 4-month horizon, respecting weekday/weekend operating hours.
2. **Filters available slots** for the requestor: past slots, blocked slots, slots adjacent to confirmed bookings (to preserve setup/teardown time), and slots from manually-created Google Calendar events are all hidden.
3. **Routes the request** through a 4-state workflow (`new request` → `hold` / `confirmed` / `rejected`) with Slack notifications and templated Gmail responses at each transition.
4. **Reserves the slot range** when a request is confirmed — marking each 30-minute slot in `[Start, End)` as `Booking`, plus configurable Setup and Teardown buffer slots before and after, plus Pending buffer slots between adjacent bookings to give the next requestor room for their own setup.
5. **Creates the Google Calendar event** automatically and sends the requestor a confirmation email.
6. **Releases the slots** on rejection, walking outward asymmetrically: `Setup`/`Pending` above the booking is cleared (it belonged to this rejected request), but `Teardown` above is preserved (it belongs to the *previous* booking).
7. **Cleans up orphaned records** — when a Google Calendar event is deleted (either by aging out or by the calendar owner cancelling it), the corresponding Booking Request record is automatically removed to stay within Airtable's record limit.

---

## Detailed Reconstruction

### 1. Sync inversion

Airtable's Google Calendar integration is **one-way** — Calendar can push events into an Airtable table, but Airtable cannot push events back out through that sync. The naive workaround is to write directly to the Google Calendar API from Airtable automations, but that breaks the source-of-truth model and creates conflict potential.

The solution: a **three-table architecture** where the `Sandbox Calendar` table is read-only (one-way sync target), the `SandBox Booking Request` table is the writable proxy (where form submissions land and where automations create records to mirror manual calendar events), and the `Available Bookings` table is the per-slot ledger that the public form queries against.

The trick that makes this work: an `External` field that gets set to `1` by a hidden form field on every form submission. When a record appears in `Sandbox Calendar` (because Google synced it in), an automation checks whether the linked Booking Request has `External = 1`:

- **`length = 1`** → form-originated. Already has a Booking Request record. Skip.
- **`length ≠ 1`** → manually created in Google Calendar. Create a backing Booking Request record so the slot-blocking logic can run on it.

`External` is, in effect, a **provenance flag** that survives the round trip through the linked-record relationship. Lookup-field cardinality as a provenance signal — not standard, but it works.

See [`docs/sync-inversion-pattern.md`](docs/sync-inversion-pattern.md) for the full data flow.

### 2. Dual-layer state machine

Two state machines run simultaneously at different granularities.

**Request-level (4 states)** — every Booking Request is in exactly one of:
- `new request` (default on form submission; triggers Slack/Gmail notifications)
- `hold` (staff need more info; no slot changes)
- `confirmed` (slots get marked Booked + Setup/Teardown/Pending; Calendar event created; confirmation email sent)
- `rejected` (slots get released; rejection email sent, optionally with a reason)

**Slot-level (6+ states)** — every 30-minute slot in `Available Bookings` is in exactly one of:
- `Booking` (within an active reservation's `[Start, End)` window)
- `Setup` (configurable N slots before a booking, only if the requestor checked the setup/teardown box)
- `Teardown` (configurable N slots after a booking, always applied)
- `Pending` (buffer slot between adjacent bookings — invisible to requestors, but convertible into Setup if the next requestor asks for one)
- *(empty)* (available)
- `Blocked` (orthogonal flag set by formula based on weekday + hour-of-day rules)

The Pending state is the load-bearing one. Without it, two adjacent bookings (`1:00 PM – 2:00 PM` and `2:30 PM – 3:00 PM`) collide: the first booking's teardown overlaps the second booking's setup. With it, the slot directly after a booking's teardown is held in Pending — invisible on the form, but available to be converted into Setup for the next booking. The next requestor sees `3:00 PM` as the earliest available time and gets a clean setup window.

See [`docs/pending-slot-algorithm.md`](docs/pending-slot-algorithm.md).

### 3. DST handling

The system was built before a daylight-saving-time transition. When DST hit, several timestamp computations started producing 1-hour-off results. The fix wasn't to patch the immediate symptoms — it was to rebuild the timezone layer in two places so the system survives every future DST transition without intervention, since I will not be the one maintaining it next year.

**In JavaScript (the time-slot generator):** uses `Intl.DateTimeFormat` with `timeZoneName: "shortOffset"` to look up Toronto's UTC offset for each specific calendar date the slot lives on, then computes the UTC instant from that. A slot generated for January (EST, UTC-5) and a slot generated for July (EDT, UTC-4) both correctly land at "10:00 AM Toronto local time" in the database. Naive `new Date(y, m-1, d, 10, 0)` would silently break twice a year.

**In Airtable formulas (the +30 minutes calculation):** Airtable's date arithmetic operates in UTC under the hood, so a naive `DATEADD({Start}, 30, "minutes")` on a value displayed in Toronto can land on a DST-transition wall and produce a 1-hour error. The formula fields round-trip through a string representation (`DATETIME_FORMAT` → `DATETIME_PARSE`) to strip timezone information, do the arithmetic in wall-clock time, and re-apply Toronto timezone.

See [`docs/dst-handling.md`](docs/dst-handling.md) for the full story and [`formulas/dst-safe-add-30min.md`](formulas/dst-safe-add-30min.md) for the specific formula pattern.

### 4. Race-condition handling between concurrent automations

Airtable automations run independently and there is no native synchronization between them. The booking-range-fill script needs the `Internal End` field, which is populated by a *different* automation that may not have finished writing yet when this one fires.

The script handles this with a **retry-with-backoff loop**: up to 10 attempts at 500ms intervals, calling `reloadAsync()` defensively (with optional chaining in case the API version doesn't expose it), exiting cleanly if the upstream automation never completes. Not distributed-consensus territory, but a real production concern in a no-code environment where you don't control execution ordering.

See [`scripts/02-booking-range-fill.js`](scripts/02-booking-range-fill.js) and [`docs/race-condition-handling.md`](docs/race-condition-handling.md).

### 5. Connected-component slot grouping

The Setup/Teardown/Pending script needs to identify the contiguous run of slots belonging to a single booking. It does this by loading all slots, sorting by `Start`, and walking outward from the trigger slot — testing whether adjacent slots share at least one ID in the `Booked Slots` linked field. That's a connected-component search across a time-sorted array using set intersection as the adjacency predicate.

Once the booking block is identified, state transitions are applied outward with priority rules:

- `Setup` can overwrite `Pending` (the next booking is claiming the buffer)
- `Setup` **cannot** overwrite any other non-empty type
- Nothing can overwrite a slot that already has `Booked Slots` populated

See [`scripts/03-setup-teardown-pending.js`](scripts/03-setup-teardown-pending.js) and [`docs/pending-slot-algorithm.md`](docs/pending-slot-algorithm.md).

---

## Architecture

```
                      ┌─────────────────────────┐
                      │   Public Booking Form   │
                      │  (Airtable-hosted form) │
                      └────────────┬────────────┘
                                   │ submits
                                   │ (External = 1)
                                   ▼
┌──────────────────┐    ┌──────────────────────────┐    ┌──────────────────┐
│ Sandbox Calendar │    │  SandBox Booking Request │    │ Available        │
│ (read-only sync  │───▶│  (writable proxy table;  │───▶│ Bookings         │
│  from Google     │    │   4-state machine;       │    │ (per-slot ledger;│
│  Calendar)       │◀───│   form-submission target)│◀───│  6+ state machine│
└──────────────────┘    └──────────────────────────┘    │  per slot)       │
        ▲                          │                    └──────────────────┘
        │                          │                              ▲
        │ (auto-created on         │ on `confirmed`:              │
        │  confirm)                │   - create calendar event    │
        │                          │   - send confirmation email  │
        │                          │   - mark slots               │
        │                          │ on `rejected`:               │
        │                          │   - clear slots              │
        │                          │   - send rejection email     │
        │                          │ on `new request`:            │
        │                          │   - Slack + Gmail alerts     │
        │                          ▼                              │
        │              ┌──────────────────────┐                   │
        │              │ Slack / Gmail        │                   │
        │              │ automations          │                   │
        │              └──────────────────────┘                   │
        │                                                         │
        └─────────────────────────────────────────────────────────┘
                            form queries this table
                            for available slots
```

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for a deeper walkthrough and [`diagrams/`](diagrams/) for renderable Mermaid sources of both state machines and the end-to-end booking sequence.

---

## Repository contents

```
.
├── README.md                              ← this file
├── ARCHITECTURE.md                        ← deeper walkthrough
├── scripts/
│   ├── 01-time-slot-generator.js          ← DST-aware bulk slot creation
│   ├── 02-booking-range-fill.js           ← Start→End slot walker, retry loop
│   ├── 03-setup-teardown-pending.js       ← connected-component state transitions
│   ├── 04-allday-clearout-flag.js         ← heuristic flagging on submission
│   ├── 05-rejection-cleanup.js            ← inverse of 03, asymmetric neighbor rules
│   └── 06-orphan-record-cleanup.js        ← Airtable record-limit management
├── formulas/
│   ├── future-flag.md                     ← is-this-slot-in-the-future check
│   ├── blocked-times.md                   ← weekday + hour-of-day exclusions
│   ├── booked-slots-display-min.md        ← formatted earliest booked slot
│   ├── booked-slots-display-max.md        ← formatted latest booked slot + 30 min
│   └── dst-safe-add-30min.md              ← string round-trip DST pattern
├── diagrams/
│   ├── three-table-architecture.mmd
│   ├── request-state-machine.mmd          ← 4 states
│   ├── slot-state-machine.mmd             ← 6+ states with overwrite rules
│   └── booking-flow-sequence.mmd          ← form submission → confirmed event
└── docs/
    ├── sync-inversion-pattern.md
    ├── pending-slot-algorithm.md
    ├── dst-handling.md
    └── race-condition-handling.md
```

All scripts target the **Airtable Scripting Extension**, which runs a sandboxed JavaScript environment with the `base.getTable(...)`, `selectRecordsAsync(...)`, `updateRecordsAsync(...)`, `input.config()` API surface. They are not standalone Node.js scripts and cannot be run outside Airtable without significant modification.

---

## Tech stack

**Airtable Scripting Extension** (JavaScript sandbox) · **Airtable Formula Language** · **Airtable Automations** · **Google Calendar API** (via Airtable sync) · **Slack** integration · **Gmail** integration

---

## License & permissions

Code is published with the permission of TMU's Innovation Boost Zone (IBZ), where this system was developed during a paid Special Projects internship. The code is released for portfolio and reference purposes; the live TMU deployment, its data, and its specific automation IDs are not included.

This is a single-author project. All scripts, formulas, schema design, and automation logic in this repository were designed and written by Omar Ali-Yare.

---

## Contact

📫 [Email](Omarltk03@gmail.com)
🔗 [LinkedIn](https://www.linkedin.com/in/omar-ali-yare/)
