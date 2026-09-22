# Suraksha Guard — mobile app

Expo (SDK 57) + React Native + TypeScript app for security guards, following the SURAKSHA PRD §18.
Talks to the existing production backend (the Next.js app behind `guards.surakshaguards.in`).

## Stack
- Expo Router (file-based routing) · Zustand (state) · Socket.IO client (live location)
- expo-location (GPS + background) · expo-camera (selfie / QR) · expo-notifications
- expo-secure-store (session, device binding, PIN) · AsyncStorage (offline queue + cache)
- i18n: Hindi default + English, 21-language picker (`src/i18n`)

## Run in development

For browser development against the sibling `suraksha-app` on port 4545, the backend
must have the guard OTP routes installed. From the repository root, preview the
local login integration with `powershell -ExecutionPolicy Bypass -File backend-additions/apply-local-login.ps1`;
add `-Apply` to install it with backups. This installs the login/session routes,
version/i18n endpoints, and guard API CORS support while preserving portal routing.
Install the duty home bundle and its dependencies separately with
`powershell -ExecutionPolicy Bypass -File backend-additions/apply-local-duty.ps1 -Apply`.
This enables dispatched booking offers and roster data on the home screen; the remaining
duty APIs require the full backend deployment. Legacy AP phone formatting is matched
at login without changing or duplicating the guard record.

Development CORS permits `http://localhost:8081` and `http://127.0.0.1:8081`.
Additional browser origins can be listed in backend `GUARD_WEB_ORIGINS` (comma separated).
On web, login/PIN state uses tab-scoped session storage and survives refresh.
The browser device ID uses persistent local storage, migrating an existing tab's ID,
so closing a tab does not request approval for a new device on the next login;
native builds continue to use SecureStore. With no SMS provider configured on a
development backend, the OTP is returned for auto-fill rather than sent by SMS.

```
cd guard-app
npx expo start          # then scan the QR with Expo Go, or press a for an emulator
```

### Expo Go cannot run this app fully
`expo-notifications` throws on **import** in Expo Go on Android (push was removed from Expo Go in
SDK 53), and the wake-check alarms of PRD 18.8 depend on it. The app degrades rather than crashing
— `src/lib/notifications.ts` loads the module defensively and App health reports "Not available in
this build — wake checks will not ring" — so the duty screens are usable in Expo Go for UI work,
but **wake checks, shift reminders and background location only work in a real build**:
```
eas build --profile development --platform android   # dev build, for debugging
eas build --profile preview --platform android       # installable APK
```
Expo Go itself must match the SDK: Expo Go for SDK 57 is a separate build from the Play Store's
latest — see `https://api.expo.dev/v2/versions/latest` → `sdkVersions["57.0.0"].androidClientUrl`.

### Running it on a phone: one command

```
powershell -ExecutionPolicy Bypass -File scripts\start-test-rig.ps1
```

Three things have to be alive at once for the app to run on a handset, and if **any** of them is
down the app hangs on a loading screen or shows "Something went wrong" — because it cannot fetch
its JavaScript bundle:

1. the staging Next.js server on the VPS (port 4546, isolated `suraksha_guardtest` database)
2. an SSH tunnel bringing that port to your machine's localhost
3. the Metro bundler on port 8081

then `adb reverse` so the phone's own `localhost` reaches your machine. The script starts whatever
is down, leaves whatever is up, and is safe to re-run any time the app stops loading.

It needs Wireless debugging switched on (Developer options → Wireless debugging), or a USB cable
with USB debugging enabled. Wireless debugging re-advertises on a **new port** each time it is
toggled, so the script discovers it over mDNS rather than remembering the last one — the pairing
itself survives, only the port moves.

`-NoDevice` brings the servers up without touching the phone.

### Pointing a debug build at a staging backend by hand
`EXPO_PUBLIC_API_BASE_URL` overrides `app.json → extra.apiBaseUrl`:
```
EXPO_PUBLIC_API_BASE_URL=http://localhost:4546 npx expo start
adb reverse tcp:8081 tcp:8081 && adb reverse tcp:4546 tcp:4546
```
`adb reverse` is what makes `localhost` on the phone reach your machine, and it sidesteps the
Windows firewall blocking inbound LAN connections on a network Windows has classed as Public.

## Build an installable APK (cloud, no local Android SDK needed)
```
eas login               # one-time, free Expo account
eas init                # links the project, fills extra.eas.projectId in app.json
eas build --profile preview --platform android   # produces a downloadable .apk
```
`preview` and `development` profiles emit an APK; `production` emits an AAB for Play Store.

## Backend it talks to
Base URL is in `app.json → extra.apiBaseUrl` (`https://guards.surakshaguards.in`).
Guard endpoints already live on the server: `/api/guard/auth/check`, `/register`, `/me`,
`/toggle-online`, `/requests`, `/accept`, `/start-duty`, `/initiate-checkout`, `/complete-duty`,
`/location`, `/notifications`.
Full-PRD endpoints (attendance, patrol, wake-check, sos, incident, leave, today, sync) are in
`../backend-additions/` and must be deployed once — see `../backend-additions/DEPLOY.md`.

> Login OTP is currently the backend's dummy code **123456** (no SMS yet). The app already uses a
> send → verify flow, so switching to real SMS later is a config change.

## Project layout
```
app/                      Expo Router screens
  _layout.tsx             root: hydrate auth + i18n, gate routing
  index.tsx               routing gate (language / login / pin / app)
  language.tsx            language picker (endonyms + read-aloud)
  login.tsx               phone → OTP
  register.tsx            new-guard profile
  pin.tsx                 set / enter 4-digit PIN
  (app)/_layout.tsx       authed stack + persistent SOS + bundle polling + countdown tick
  (app)/home.tsx          Duty Home (status band, primary action, shift card, timeline, grid)
  (app)/roster.tsx        7-day roster
  (app)/checkin.tsx       GPS + auto-capture selfie check-in / check-out
  (app)/patrol.tsx        patrol rounds, checkpoint states, QR scanning
  (app)/wake.tsx          night anti-sleep wake check (server-scheduled)
  (app)/incident.tsx      incident report (photo + severity)
  (app)/leave.tsx         leave request
  (app)/earnings.tsx      earnings / payslip
  (app)/documents.tsx     documents & expiry
  (app)/profile.tsx       profile + logout + language
  (app)/help.tsx          support / call
  (app)/sos.tsx           SOS send + confirm
src/
  theme/                  design tokens (dark + gold)
  config.ts               API URL, duty tuning, ping cadence
  i18n/                   translation catalogue + store
  lib/                    api, duty state machine, media outbox, queue, notifications, device
  store/                  auth + duty (zustand)
  components/             ui kit + SosButton
```

## How the duty screens get their data
One `GET /api/guard/today` bundle drives everything: the roster row for the shift, its Site and
the site's guard-app overlay (coordinates, geofence radius, duty windows, briefing cards,
escalation contacts), the patrol checkpoints and rounds, and the night's wake-check schedule. It
is cached, so the Duty Home renders in full with no network; between bundles the app reruns the
same state machine locally (`src/lib/duty.ts`) so the countdown ticks offline.

**The server is authoritative.** Geofence verdicts, late calculations and trust scores are
computed server-side and the client's own opinion is recorded but never believed — so an agency
policy change is a config change, not an app release. See `../backend-additions/DEPLOY.md`, in
particular the note that a Site with no coordinates can never produce a geofence verdict.
