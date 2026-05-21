# The pending-slot algorithm

## The problem

Two back-to-back bookings need a buffer between them, or they collide. Concretely:

- User A books `1:00 PM – 2:00 PM`. They want Teardown from `2:00 PM – 3:00 PM`.
- User B books `2:30 PM – 3:30 PM`. They want Setup from `1:30 PM – 2:30 PM`.

User A's teardown (`2:00 – 3:00 PM`) overlaps User B's setup (`1:30 – 2:30 PM`). Both users think the space is theirs for those overlapping slots.

A naive solution — "don't let User B book any slot within an hour of User A's end" — works for that specific case but breaks down when the buffer needs to be variable, or when only one of the two users actually needs setup/teardown.

## The solution: a fourth slot state

Every 30-minute slot in `Available Bookings` is in one of these states (`Type` field):

| State      | Visible to requestors? | Meaning                                                          |
|------------|------------------------|------------------------------------------------------------------|
| *(empty)*  | Yes                    | Available for booking.                                           |
| `Booking`  | No                     | Reserved for a confirmed booking, within `[Start, End)`.         |
| `Setup`    | No                     | Buffer before a booking (only if requestor checked the box).     |
| `Teardown` | No                     | Buffer after a booking (always applied).                         |
| `Pending`  | No                     | Reserved buffer between adjacent bookings — *convertible*.       |

(Plus `Blocked` as an orthogonal flag for slots that should never be bookable. See [`../formulas/blocked-times.md`](../formulas/blocked-times.md).)

The `Pending` state is the key innovation. It's invisible to requestors (so they don't accidentally try to book it), but it's *convertible* — a future Setup operation can claim a Pending slot and convert it to Setup, but cannot claim a slot that's already Setup, Teardown, or Booking.

## Worked example

Initial state: a User A booking confirmed for `1:00 PM – 2:00 PM` with setup/teardown checkbox on.

[`scripts/03-setup-teardown-pending.js`](../scripts/03-setup-teardown-pending.js) walks outward from the booking block and applies state transitions:

```
12:00  12:30  1:00  1:30  2:00  2:30  3:00  3:30  4:00
  P      S     B     B     T     T     P     -     -
```

- `B` = `Booking` (the booked range).
- `T` = `Teardown` (`TEARDOWN_SLOTS = 2`, so 2 slots after).
- `P` (after teardown) = `Pending` (1 slot, the post-teardown buffer).
- `S` = `Setup` (`SETUP_SLOTS = 2`, so 2 slots before).
- `P` (before setup) = `Pending` (1 slot, the pre-setup buffer).

The form's available-slots view shows: `12:00 PM`, `4:00 PM`, etc. Everything from `12:30 PM` through `3:00 PM` is invisible. The `12:00 PM` and `3:00 PM` Pending slots are invisible too, but unlike Setup/Teardown/Booking, they can be reclaimed.

Now User B wants `3:30 PM – 4:30 PM` with setup. The script runs again:

```
12:00  12:30  1:00  1:30  2:00  2:30  3:00  3:30  4:00  4:30  5:00  5:30  6:00
  P      S     B     B     T     T     S     B     B     T     T     P     -
```

The `3:00 PM` Pending slot was converted to Setup for User B. The `2:30 PM` Teardown slot is preserved (User A's teardown). User B's `3:30 PM` booking has a clean `3:00 PM` setup window, and User A's `2:30 PM` teardown is untouched. The two adjacent bookings coexist without collision.

If User B *hadn't* asked for setup, the `3:00 PM` Pending slot would have stayed Pending, and the form would still show `3:30 PM` as the earliest available start time. Either way, no collision.

## The asymmetry rules

The script's priority hierarchy:

1. **Nothing** overwrites a slot that has `Booked Slots` populated. Once a slot is claimed for an actual booking, it's claimed.
2. **Teardown** is applied to empty slots only. If a slot is already Setup or Booking or Pending, Teardown skips it.
3. **Setup** is applied to empty slots OR slots that are currently `Pending`. Setup can claim a Pending slot — that's the whole point of the Pending state. Setup cannot claim Setup, Teardown, or Booking slots.
4. **Pending** is applied to empty slots only. Never overwrites anything.

On the rejection side, [`scripts/05-rejection-cleanup.js`](../scripts/05-rejection-cleanup.js) walks outward asymmetrically:

- **Above the cancelled booking:** clear if `Setup` or `Pending`. Do NOT clear `Teardown` — that belongs to the previous booking.
- **Below the cancelled booking:** clear if `Teardown` or `Pending`. Do NOT clear `Setup` — that belongs to the next booking.

The asymmetry is what keeps the system consistent. A rejected booking releases its own buffers and only its own buffers.

## Why connected-component search?

[`scripts/03-setup-teardown-pending.js`](../scripts/03-setup-teardown-pending.js) identifies the "booking block" — the contiguous run of slots belonging to one confirmed booking — by walking outward from the trigger slot and testing whether adjacent slots share at least one ID in their `Booked Slots` linked field with the trigger.

This is necessary because a single booking can span multiple 30-minute slots (e.g., a 2-hour booking = 4 slots, all of which link back to the same Booking Request). The script needs to find *all* of them before it can decide where Teardown/Setup/Pending go.

A simpler "find slots within [Start, End)" approach would also work in principle, but the connected-component approach handles edge cases better: it correctly groups even if `End` is missing from the trigger slot (the linked-field intersection still works), and it gracefully handles slots that exist in the table but somehow weren't linked (those won't be part of the block).
