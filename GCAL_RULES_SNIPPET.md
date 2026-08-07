# Add this to PlannerXD's REAL Firestore rules — manually

This is deliberately **not** a `firestore.rules` file. I couldn't find one
anywhere in this repo, which means your live PlannerXD security rules are
managed somewhere I don't have visibility into — most likely edited
directly in the Firebase Console (Firestore Database → Rules tab). I'm not
willing to write and deploy a full rules file blind, since guessing wrong
about even one existing collection could accidentally lock you out of
something that works today.

**What to do:** open Firebase Console → your `plannerxd` project →
Firestore Database → Rules, and add this block inside your existing
`match /users/{uid} { ... }` section (or wherever your current rules
structure it) — do not replace your whole rules file with just this.

```
match /users/{uid} {
  // ... your existing rules for the user doc itself stay as they are ...

  // Locked down completely — holds a REAL Google refresh token, which is
  // as sensitive as a password. Only Cloud Functions (Admin SDK) ever
  // touch this; it bypasses rules entirely. The client only ever sees the
  // plain boolean googleCalendarSharedConnected flag on the user doc
  // itself, which is NOT sensitive.
  match /googleCalendarTokens/{tokenId} {
    allow read, write: if false;
  }
}
```

If you paste your current live rules here (or tell me where they're
managed), I can double check I haven't missed anything specific to your
existing setup before you add this.
