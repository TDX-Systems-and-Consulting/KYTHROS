# Add this to PlannerXD's REAL Firestore rules — manually

**Update:** the collection name changed from `googleCalendarTokens` to
`googleCalendarConnections` when the design moved from "share with another
PlannerXD account" to "connect multiple named calendars to one account"
(Jason doesn't use PlannerXD and never will, so the original cross-account
model didn't work for him). If you already published a rule protecting
`googleCalendarTokens`, that's now protecting an unused collection —
harmless, but replace it with this instead so the collection actually in
use is the one explicitly locked down.

This is deliberately **not** a `firestore.rules` file, for the same reason
as before — I don't have visibility into your real live rules, so I'm not
willing to guess and deploy a full file blind.

**What to do:** open Firebase Console → your `plannerxd` project →
Firestore Database → Rules, and inside your existing
`match /users/{uid} { ... }` block, replace the old `googleCalendarTokens`
match (if you added it) with this:

```
match /users/{uid} {
  // ... your existing rules for the user doc itself stay as they are ...

  // Holds real Google refresh tokens (one per connected calendar) — as
  // sensitive as a password. Only Cloud Functions (Admin SDK) ever touch
  // this; it bypasses rules entirely. The client only ever sees id/label/
  // email via the listMyCalendarConnections callable, never the token.
  match /googleCalendarConnections/{connectionId} {
    allow read, write: if false;
  }
}
```

If you paste your current live rules here (or tell me where they're
managed), I can double check I haven't missed anything specific to your
existing setup before you add this.
