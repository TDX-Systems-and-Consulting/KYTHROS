const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

// ════════════════════════════════════════════════════════════════════
// Google Calendar OAuth — server-side, per-person
// ════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS: PlannerXD already has a working Google Calendar
// connection today, but it's entirely client-side (GAPI/GIS + a token
// stored in that browser's localStorage). That means "connect Google
// Calendar" only ever shows YOU your own calendar, in YOUR OWN
// browser. There is no way for one PlannerXD view to show Travis's
// calendar AND Jason's calendar together, and no way for a separate
// system (JOBSMETRIX) to check "does this new job schedule conflict
// with something already on Jason's calendar" — a browser-local token
// isn't reachable from anywhere except that one browser tab.
//
// This adds a SEPARATE, server-side OAuth flow (refresh token stored
// in Firestore, never sent to the client) so:
//   1. A user's calendar can be read by PlannerXD's OWN backend, not
//      just by whichever browser they happened to connect from — the
//      first real requirement for a shared, multi-person calendar view.
//   2. JOBSMETRIX (a separate app, separate Firebase project) can
//      eventually ask "does this time conflict with something on this
//      person's calendar" via getUserCalendarEvents below, without
//      needing its own copy of anyone's Google credentials.
//
// This does NOT replace the existing client-side connection — that
// keeps working exactly as it does today. This is additive: a second,
// independent connection specifically for server-reachable access.
//
// SETUP (one-time, in Google Cloud Console, for the "plannerxd" project):
// 1. console.cloud.google.com -> select the "plannerxd" project
//    (Firebase projects ARE Cloud projects under the hood -- this
//    already exists, no new project to create).
// 2. APIs & Services > Library > enable "Google Calendar API" if not
//    already enabled (it likely already is, given the existing
//    client-side GAPI calendar usage).
// 3. APIs & Services > OAuth consent screen:
//    - User Type: "Internal" if this project is associated with a
//      Google Workspace domain both Travis and Jason are on (skips
//      Google's verification review). Otherwise "External" with each
//      person added as a test user.
//    - Scope needed: https://www.googleapis.com/auth/calendar
//      (full read/write -- read is needed for the shared view +
//      conflict check, not just the write-only scope JOBSMETRIX uses
//      for its one-way push).
// 4. APIs & Services > Credentials > Create Credentials > OAuth
//    client ID:
//    - Application type: Web application
//    - Authorized redirect URI: the deployed URL of
//      gcalOAuthCallback below, e.g.
//      https://us-central1-plannerxd.cloudfunctions.net/gcalOAuthCallback
//      (get the exact URL after first deploy, then add it here and
//      redeploy -- chicken-and-egg, that's normal, same as JOBSMETRIX's
//      setup went).
// 5. Set the client ID/secret as Firebase config (run from inside
//    this functions/ directory, needs Firebase CLI signed in):
//      firebase functions:config:set google.client_id="xxx.apps.googleusercontent.com" \
//        google.client_secret="xxx" \
//        google.redirect_uri="https://us-central1-plannerxd.cloudfunctions.net/gcalOAuthCallback" \
//        --project plannerxd
// 6. Deploy: firebase deploy --only functions --project plannerxd
// 7. Each person (Travis, Jason) visits a "Connect Calendar (Shared)"
//    action in PlannerXD and signs into their Google account.
//
// Until connected, nothing breaks -- this whole flow is additive to
// what already works today.

const { google } = require('googleapis');

function getGoogleOAuthConfig() {
  const client_id = process.env.GOOGLE_CLIENT_ID || (functions.config().google || {}).client_id;
  const client_secret = process.env.GOOGLE_CLIENT_SECRET || (functions.config().google || {}).client_secret;
  const redirect_uri = process.env.GOOGLE_REDIRECT_URI || (functions.config().google || {}).redirect_uri;
  if (!client_id || !client_secret || !redirect_uri) return null;
  return { client_id, client_secret, redirect_uri };
}

function newOAuth2Client() {
  const cfg = getGoogleOAuthConfig();
  if (!cfg) return null;
  return new google.auth.OAuth2(cfg.client_id, cfg.client_secret, cfg.redirect_uri);
}

// gcalOAuthStart
// ──────────────
// Client sends their Firebase ID token as ?token=... (verified here
// before redirecting to Google, so a stranger can't kick off an OAuth
// flow that gets tied to someone else's account). Redirects to
// Google's consent screen with state=base64(uid) so the callback
// knows whose tokens these are without trusting anything else the
// client sends. Simpler than JOBSMETRIX's version -- no companyId,
// since PlannerXD's data model is per-user (users/{uid}), not
// multi-tenant.
exports.gcalOAuthStart = functions.https.onRequest(async (req, res) => {
  const oauth2Client = newOAuth2Client();
  if (!oauth2Client) {
    res.status(500).send('Google Calendar OAuth is not configured yet (functions.config().google missing). See the setup comment at the top of index.js.');
    return;
  }
  const idToken = req.query.token;
  if (!idToken) { res.status(400).send('Missing token'); return; }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    res.status(401).send('Invalid or expired session - please reload PlannerXD and try again.');
    return;
  }

  const state = Buffer.from(JSON.stringify({ uid: decoded.uid })).toString('base64');
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',      // needed to get a refresh_token
    prompt: 'consent',           // forces refresh_token on every connect, not just the first
    scope: ['https://www.googleapis.com/auth/calendar'],
    state
  });
  res.redirect(authUrl);
});

// gcalOAuthCallback
// ──────────────────
// Google redirects here after the user approves. Exchanges the code
// for tokens, stores the refresh_token in a locked-down subcollection
// under the user's own doc (never client-readable — see
// firestore.rules), and flips a plain boolean flag on the user's
// profile so the UI can show "Connected."
exports.gcalOAuthCallback = functions.https.onRequest(async (req, res) => {
  console.log('gcalOAuthCallback invoked, error:', req.query.error || 'none', 'code:', !!req.query.code);
  try {
    const oauth2Client = newOAuth2Client();
    if (!oauth2Client) {
      res.status(500).send('Google Calendar OAuth is not configured yet.');
      return;
    }
    const { code, state, error } = req.query;
    if (error) { res.status(400).send('Google denied access: ' + error); return; }
    if (!code || !state) { res.status(400).send('Missing code/state from Google.'); return; }

    let parsed;
    try { parsed = JSON.parse(Buffer.from(state, 'base64').toString('utf8')); }
    catch (e) { res.status(400).send('Invalid state.'); return; }
    const { uid } = parsed;

    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
      res.status(400).send('Google did not return a refresh token. Please disconnect (if previously connected) and reconnect — Google only issues a refresh token on first consent per app.');
      return;
    }
    const db = admin.firestore();
    await db.collection('users').doc(uid).collection('googleCalendarTokens').doc('main').set({
      refreshToken: tokens.refresh_token,
      connectedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await db.collection('users').doc(uid).set(
      { googleCalendarSharedConnected: true },
      { merge: true }
    );
    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>✅ Google Calendar connected</h2><p>You can close this tab and go back to PlannerXD.</p></body></html>');
  } catch (e) {
    console.error('gcalOAuthCallback top-level error:', e.message, e.stack);
    res.status(500).send('Error connecting Google Calendar: ' + e.message);
  }
});

// gcalSharedDisconnect (callable)
// ───────────────────────────────
// Lets a user disconnect their own shared-calendar connection —
// deletes the stored token and clears the status flag. Does not
// revoke the Google-side grant (Google still shows PlannerXD under
// their connected apps until they remove it there too) but stops all
// future server-side reads immediately. Named distinctly from any
// existing "disconnect" tied to the CLIENT-side connection, since
// these are two independent connections.
exports.gcalSharedDisconnect = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  const uid = context.auth.uid;
  const db = admin.firestore();
  await db.collection('users').doc(uid).collection('googleCalendarTokens').doc('main').delete();
  await db.collection('users').doc(uid).set(
    { googleCalendarSharedConnected: false },
    { merge: true }
  );
  return { disconnected: true };
});

// Loads a ready-to-use Calendar API client for a given user, or null
// if they haven't connected (not an error — just means "nothing to
// read for them yet").
async function getCalendarClientForUser(uid) {
  const db = admin.firestore();
  const tokenDoc = await db.collection('users').doc(uid).collection('googleCalendarTokens').doc('main').get();
  if (!tokenDoc.exists) return null;
  const oauth2Client = newOAuth2Client();
  if (!oauth2Client) return null;
  oauth2Client.setCredentials({ refresh_token: tokenDoc.data().refreshToken });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

// getUserCalendarEvents (callable)
// ─────────────────────────────────
// The first real payoff of the OAuth plumbing above: fetches a
// specific person's real Google Calendar events for a date range.
// This is the building block BOTH remaining pieces depend on:
//   - PlannerXD's shared calendar view (Travis purple, Jason blue) —
//     call this for each connected person and merge the results.
//   - The JOBSMETRIX conflict check — before saving a new schedule,
//     call this for the assigned person and check for overlaps.
//
// Callable rather than a plain HTTP endpoint so it's automatically
// authenticated (context.auth) and doesn't need its own token
// verification step. targetUid defaults to the caller's own uid (the
// normal case — "show me my events"); a caller may only request
// someone ELSE's events if that target has explicitly allowed it via
// sharedCalendarViewers on their own user doc (see firestore.rules) —
// enforced here, not just assumed client-side, since this is exactly
// the kind of check that matters (Jason's personal/family calendar
// showing to someone he didn't approve).
exports.getUserCalendarEvents = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  const requesterUid = context.auth.uid;
  const targetUid = data.targetUid || requesterUid;
  const timeMin = data.timeMin; // ISO string
  const timeMax = data.timeMax; // ISO string
  if (!timeMin || !timeMax) {
    throw new functions.https.HttpsError('invalid-argument', 'timeMin and timeMax are required (ISO date strings).');
  }

  if (targetUid !== requesterUid) {
    const db = admin.firestore();
    const targetDoc = await db.collection('users').doc(targetUid).get();
    const viewers = targetDoc.exists ? (targetDoc.data().sharedCalendarViewers || []) : [];
    if (!viewers.includes(requesterUid)) {
      throw new functions.https.HttpsError('permission-denied', 'This person has not shared their calendar with you.');
    }
  }

  const cal = await getCalendarClientForUser(targetUid);
  if (!cal) return { connected: false, events: [] };

  const resp = await cal.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250
  });

  const events = (resp.data.items || []).map(ev => ({
    id: ev.id,
    title: ev.summary || '(no title)',
    start: ev.start?.dateTime || ev.start?.date,
    end: ev.end?.dateTime || ev.end?.date,
    allDay: !ev.start?.dateTime,
    location: ev.location || ''
  }));

  return { connected: true, events };
});

// shareCalendarWith / unshareCalendarWith (callable)
// ────────────────────────────────────────────────────
// Grants (or revokes) another PlannerXD user permission to read the
// caller's calendar via getUserCalendarEvents above. Looked up by
// email server-side (Admin SDK) rather than trusting a UID from the
// client — the client never gets to just supply an arbitrary UID and
// have it accepted as "this person."
exports.shareCalendarWith = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  const email = (data.email || '').trim().toLowerCase();
  if (!email) throw new functions.https.HttpsError('invalid-argument', 'Missing email.');

  let targetUser;
  try {
    targetUser = await admin.auth().getUserByEmail(email);
  } catch (e) {
    throw new functions.https.HttpsError('not-found', 'No PlannerXD account found for ' + email + '. They need to have signed into PlannerXD at least once first.');
  }
  if (targetUser.uid === context.auth.uid) {
    throw new functions.https.HttpsError('invalid-argument', "You can't share your calendar with yourself.");
  }

  const db = admin.firestore();
  const myEmail = (context.auth.token.email || '').toLowerCase();
  const batch = db.batch();

  const myRef = db.collection('users').doc(context.auth.uid);
  batch.set(myRef, {
    sharedCalendarViewers: admin.firestore.FieldValue.arrayUnion(targetUser.uid),
    // Separate map (not part of the array) purely so the UI can show
    // "shared with jason@..." without a reverse UID->email lookup —
    // keeping it out of the array itself means arrayUnion/arrayRemove
    // on sharedCalendarViewers stays simple exact-match-on-a-string,
    // not fragile exact-match-on-an-object.
    sharedCalendarViewerEmails: { [targetUser.uid]: email }
  }, { merge: true });

  // Reverse pointer on the VIEWER's own doc — without this, there's no
  // way for the person who was just granted access to discover "whose
  // calendars can I see" without an expensive/awkward cross-user query.
  // Each person only ever reads their own doc to know who's shared
  // with them, matching the security-conscious owned-data pattern used
  // everywhere else here.
  const targetRef = db.collection('users').doc(targetUser.uid);
  batch.set(targetRef, {
    sharedWithMe: admin.firestore.FieldValue.arrayUnion(context.auth.uid),
    sharedWithMeEmails: { [context.auth.uid]: myEmail }
  }, { merge: true });

  await batch.commit();
  return { shared: true, targetUid: targetUser.uid, targetEmail: email };
});

exports.unshareCalendarWith = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  const targetUid = data.targetUid;
  if (!targetUid) throw new functions.https.HttpsError('invalid-argument', 'Missing targetUid.');

  const db = admin.firestore();
  const batch = db.batch();
  batch.set(db.collection('users').doc(context.auth.uid), {
    sharedCalendarViewers: admin.firestore.FieldValue.arrayRemove(targetUid)
  }, { merge: true });
  // Remove the matching reverse pointer too, or the target would keep
  // seeing this person's calendar as available after being unshared.
  batch.set(db.collection('users').doc(targetUid), {
    sharedWithMe: admin.firestore.FieldValue.arrayRemove(context.auth.uid)
  }, { merge: true });
  await batch.commit();
  return { unshared: true };
});
