const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

// ════════════════════════════════════════════════════════════════════
// Google Calendar OAuth — multiple named connections under ONE account
// ════════════════════════════════════════════════════════════════════
//
// REVISED DESIGN, replacing an earlier cross-account "share your
// calendar with another PlannerXD user" model. That model assumed the
// other person (Jason) would have their own PlannerXD account, connect
// their own calendar, and share it themselves — but Jason does not use
// PlannerXD and never will. That assumption made the whole sharing
// flow undoable for him specifically.
//
// The fix: Google's OAuth consent screen only ever requires signing
// into GOOGLE, not into PlannerXD. So instead of "share with another
// PlannerXD account," this is "connect AS MANY Google calendars as you
// want to YOUR OWN single PlannerXD account, each with a label." Travis
// clicks "Add Calendar," picks a label ("Jason"), and hands the device
// to Jason for the ~15 seconds it takes him to log into HIS OWN Google
// account and click Allow. Jason never creates a PlannerXD account,
// never logs into PlannerXD, ever — his only interaction, one time, is
// with Google's own login screen.
//
// Data model: users/{uid}/googleCalendarConnections/{connectionId} —
// each doc holds a real refresh token (as sensitive as a password,
// locked out from client reads entirely — see firestore.rules) plus a
// plain-text label for display ("My Calendar", "Jason"). A user can
// have as many of these as they want.
//
// SETUP is unchanged from before (still needs a real Google Cloud
// OAuth client + firebase functions:config:set — already completed
// for the plannerxd project as of this rewrite).

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
// Client sends their Firebase ID token as ?token=... (verified here,
// so a stranger can't kick off a flow tied to someone else's account)
// plus an optional ?label=... (e.g. "Jason") describing whose calendar
// this connection actually is. Both get encoded into state, so the
// callback knows exactly whose PlannerXD account this belongs to AND
// what to label it as, without trusting anything else the client sends
// after the redirect to Google and back.
exports.gcalOAuthStart = functions.https.onRequest(async (req, res) => {
  const oauth2Client = newOAuth2Client();
  if (!oauth2Client) {
    res.status(500).send('Google Calendar OAuth is not configured yet (functions.config().google missing).');
    return;
  }
  const idToken = req.query.token;
  if (!idToken) { res.status(400).send('Missing token'); return; }
  const label = (req.query.label || 'My Calendar').toString().slice(0, 60);

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    res.status(401).send('Invalid or expired session - please reload PlannerXD and try again.');
    return;
  }

  const state = Buffer.from(JSON.stringify({ uid: decoded.uid, label })).toString('base64');
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',      // needed to get a refresh_token
    prompt: 'consent select_account', // forces the account picker every time -- critical here, since this is how a second person (Jason) gets to choose HIS OWN Google account instead of whatever was last signed in
    scope: [
      'https://www.googleapis.com/auth/calendar',
      // Needed for the userinfo.get() call below to succeed — without
      // this, that lookup silently fails and googleEmail never gets
      // stored, which is exactly what happened for every connection
      // made before this fix.
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    state
  });
  res.redirect(authUrl);
});

// gcalOAuthCallback
// ──────────────────
// Exchanges the code for tokens, then creates a NEW connection document
// (auto-generated id, not a fixed slot) under the ORIGINAL PlannerXD
// user's own account — regardless of which Google account was actually
// used to authorize. This is exactly what lets Travis end up with two
// connections under his own uid: one labeled "My Calendar" (his own
// Google account) and one labeled "Jason" (Jason's Google account,
// authorized on Travis's device, saved under Travis's PlannerXD login).
exports.gcalOAuthCallback = functions.https.onRequest(async (req, res) => {
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
    const { uid, label } = parsed;

    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
      res.status(400).send("Google did not return a refresh token. If this Google account was connected here before, remove it from your Google Account's connected-apps list first, then try again — Google only issues a refresh token on first consent per app per account.");
      return;
    }

    // Look up whose Google account this actually is, purely for a
    // clearer default label / confirmation on the success page — not
    // used for anything security-relevant, that's all handled by the
    // uid embedded in state above.
    let googleEmail = '';
    try {
      oauth2Client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
      const info = await oauth2.userinfo.get();
      googleEmail = info.data.email || '';
    } catch (e) { /* non-fatal, just cosmetic */ }

    const db = admin.firestore();
    const connRef = db.collection('users').doc(uid).collection('googleCalendarConnections').doc();
    await connRef.set({
      refreshToken: tokens.refresh_token,
      label: label || googleEmail || 'Calendar',
      googleEmail,
      connectedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const esc = s => String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
    const safeEmail = esc(googleEmail);
    const safeLabel = esc(label || 'Calendar');
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>✅ ${safeLabel} connected</h2><p>${googleEmail ? safeEmail + ' is now linked.' : ''} You can close this tab and go back to PlannerXD.</p></body></html>`);
  } catch (e) {
    console.error('gcalOAuthCallback top-level error:', e.message, e.stack);
    res.status(500).send('Error connecting Google Calendar: ' + e.message);
  }
});

// listMyCalendarConnections (callable)
// ──────────────────────────────────────
// Returns the caller's own connections — id + label + email only,
// NEVER the refresh token itself — so the client can render "My
// Calendar / Jason" as a manageable list.
exports.listMyCalendarConnections = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  const db = admin.firestore();
  const snap = await db.collection('users').doc(context.auth.uid).collection('googleCalendarConnections').get();
  return {
    connections: snap.docs.map(d => ({
      id: d.id,
      label: d.data().label || 'Calendar',
      googleEmail: d.data().googleEmail || ''
    }))
  };
});

// disconnectCalendarConnection (callable)
// ──────────────────────────────────────
// Removes exactly one connection by id — always the caller's own,
// since it's scoped under their own uid. No permission check needed
// beyond "must be signed in": the Firestore path itself (this user's
// own subcollection) is the only place this can ever look.
exports.disconnectCalendarConnection = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  const connectionId = data.connectionId;
  if (!connectionId) throw new functions.https.HttpsError('invalid-argument', 'Missing connectionId.');
  const db = admin.firestore();
  await db.collection('users').doc(context.auth.uid).collection('googleCalendarConnections').doc(connectionId).delete();
  return { disconnected: true };
});

async function getCalendarClientForConnection(uid, connectionId) {
  const db = admin.firestore();
  const doc = await db.collection('users').doc(uid).collection('googleCalendarConnections').doc(connectionId).get();
  if (!doc.exists) return null;
  const oauth2Client = newOAuth2Client();
  if (!oauth2Client) return null;
  oauth2Client.setCredentials({ refresh_token: doc.data().refreshToken });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

// getCalendarEventsForConnection (callable)
// ────────────────────────────────────────
// Fetches real events for ONE of the caller's own connections (by id).
// Always scoped to the caller's own uid — there is no cross-account
// "view someone else's connection" concept anymore, since every
// connection this system knows about already lives under whichever
// PlannerXD account added it.
exports.getCalendarEventsForConnection = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  const connectionId = data.connectionId;
  const timeMin = data.timeMin;
  const timeMax = data.timeMax;
  if (!connectionId) throw new functions.https.HttpsError('invalid-argument', 'Missing connectionId.');
  if (!timeMin || !timeMax) {
    throw new functions.https.HttpsError('invalid-argument', 'timeMin and timeMax are required (ISO date strings).');
  }

  const cal = await getCalendarClientForConnection(context.auth.uid, connectionId);
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

// pushEventToConnection (callable)
// ────────────────────────────────────────
// Creates a real event on ONE of the caller's own connections' primary
// calendar (by id) — e.g. pushing an appointment onto Jason's actual
// Google Calendar using the refresh token captured when he connected.
// This works because gcalOAuthStart requests the full 'calendar' scope
// (not readonly), so every existing connection already has write
// permission — no re-consent needed from the connected person.
exports.pushEventToConnection = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  const connectionId = data.connectionId;
  const event = data.event;
  if (!connectionId || !event || !event.title || !event.date) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing connectionId or event (title, date required).');
  }

  const cal = await getCalendarClientForConnection(context.auth.uid, connectionId);
  if (!cal) throw new functions.https.HttpsError('not-found', 'Calendar connection not found.');

  const tz = event.timeZone || 'America/Chicago';
  const resource = event.startTime
    ? {
        summary: event.title,
        description: event.notes || '',
        location: event.location || '',
        start: { dateTime: `${event.date}T${event.startTime}:00`, timeZone: tz },
        end: { dateTime: `${event.date}T${event.endTime || event.startTime}:00`, timeZone: tz }
      }
    : {
        summary: event.title,
        description: event.notes || '',
        location: event.location || '',
        start: { date: event.date },
        end: { date: event.date }
      };

  const resp = await cal.events.insert({ calendarId: 'primary', resource });
  return { success: true, eventId: resp.data.id };
});

// updateEventOnConnection (callable)
// ────────────────────────────────────────
// Updates an event that was previously pushed to a connection's
// calendar (by the Google event id returned from pushEventToConnection).
// Called when a PlannerXD event that's already been pushed gets edited,
// so the connection's calendar reflects the change instead of getting
// a duplicate.
exports.updateEventOnConnection = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  const connectionId = data.connectionId;
  const googleEventId = data.googleEventId;
  const event = data.event;
  if (!connectionId || !googleEventId || !event || !event.title || !event.date) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing connectionId, googleEventId, or event.');
  }

  const cal = await getCalendarClientForConnection(context.auth.uid, connectionId);
  if (!cal) throw new functions.https.HttpsError('not-found', 'Calendar connection not found.');

  const tz = event.timeZone || 'America/Chicago';
  const resource = event.startTime
    ? {
        summary: event.title,
        description: event.notes || '',
        location: event.location || '',
        start: { dateTime: `${event.date}T${event.startTime}:00`, timeZone: tz },
        end: { dateTime: `${event.date}T${event.endTime || event.startTime}:00`, timeZone: tz }
      }
    : {
        summary: event.title,
        description: event.notes || '',
        location: event.location || '',
        start: { date: event.date },
        end: { date: event.date }
      };

  try {
    await cal.events.update({ calendarId: 'primary', eventId: googleEventId, resource });
    return { success: true, eventId: googleEventId };
  } catch (e) {
    // The event may have been deleted or moved on the Google side since
    // we last touched it — fall back to creating a fresh one rather than
    // silently failing, so the edit still lands somewhere.
    if (e.code === 404 || e.code === 410) {
      const resp = await cal.events.insert({ calendarId: 'primary', resource });
      return { success: true, eventId: resp.data.id, recreated: true };
    }
    throw e;
  }
});

// deleteEventOnConnection (callable)
// ────────────────────────────────────────
// Deletes an event previously pushed to a connection's calendar.
exports.deleteEventOnConnection = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  const connectionId = data.connectionId;
  const googleEventId = data.googleEventId;
  if (!connectionId || !googleEventId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing connectionId or googleEventId.');
  }

  const cal = await getCalendarClientForConnection(context.auth.uid, connectionId);
  if (!cal) throw new functions.https.HttpsError('not-found', 'Calendar connection not found.');

  try {
    await cal.events.delete({ calendarId: 'primary', eventId: googleEventId });
  } catch (e) {
    // Already gone on the Google side — treat as success either way.
    if (e.code !== 404 && e.code !== 410) throw e;
  }
  return { success: true };
});
