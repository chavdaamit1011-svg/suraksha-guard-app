# Guard-app backend additions — deploy notes

These files add the full-PRD guard endpoints to the **existing** production Next.js app at
`/home/suraksha/suraksha-new` on the VPS (69.62.82.222, ssh port 2222, user `ke`). They are
mostly new files under `src/app/api/guard/*` and `src/lib/*`.

**Two existing files are replaced** (`deploy.sh` backs both up first):

| File | Why |
|---|---|
| `src/proxy.ts` | The Next 16 middleware. The copy here is production's file (byte-identical at the time of writing) with one addition: requests to `/api/guard/*` go through `guardApiGate`, which checks the guard session token. Every other path behaves exactly as before. **If production's `proxy.ts` has changed since, merge the `guardApiGate` block by hand instead of copying.** |
| `src/app/api/guard/auth/register/route.ts` | Now needs the registration ticket from OTP verification (when sessions are enforced), binds the device and returns a session. |

The ops/agency/client portals and the marketing site are otherwise untouched.

A new npm dependency, `@anthropic-ai/sdk@0.126.0`, is needed by the guard assistant route;
`deploy.sh` installs it when it is missing.

## What gets added

### Models
- `src/lib/models/GuardAttendance.ts` — attendance events, append-only, idempotent, roster-linked
- `src/lib/models/GuardFieldEvent.ts` — patrol scans, wake-checks, SOS, leave, site visits
- `src/lib/models/GuardAppProfile.ts` — device binding, face enrolment, documents, notice acks,
  supervisor grants
- `src/lib/models/GuardSiteConfig.ts` — the guard-app overlay on a Site (coordinates, duty
  windows, wake-check policy, briefing cards, escalation contacts)
- `src/lib/models/GuardMedia.ts` — uploaded selfies / incident photos / voice notes
- `src/lib/models/GuardWakeSchedule.ts` — the night's planned wake prompts per shift
- `src/lib/models/GuardReplacement.ts` — replacement vacancies and per-guard offers
- `src/lib/models/GuardPayslip.ts` — finalised payslips (integer paise)
- `src/lib/models/GuardTrainingRecord.ts` — training progress, attempts, certificates
- `src/lib/models/GuardChangeRequest.ts` — personal-detail change requests (name/DOB, bank/UPI,
  address, emergency contact). `GuardAppProfile` also gains `dob`, `emergencyContact` and
  `payout` (the full account number is `select: false`)

### Shared logic
- `src/lib/guardRoster.ts` — roster → site join, IST shift windows, geofence, duty state machine
- `src/lib/guardAttendanceIngest.ts` — one ingest path shared by the online and offline routes
- `src/lib/guardFieldIngest.ts` — the same for patrol scans and wake acknowledgements
- `src/lib/guardTrust.ts` — anti-spoof scoring (mock location, clock skew, reused media, root,
  emulator, impossible travel, sequence gaps)
- `src/lib/guardDevice.ts` — one-device-per-guard standing, checked on every bundle fetch
- `src/lib/guardFace.ts` — face verification with pluggable providers and three-band outcome
- `src/lib/guardSupervisor.ts` — supervisor scope, permissions and team state
- `src/lib/guardTrainingCatalogue.ts` — the baseline training content and its answer key
- `src/lib/guardSms.ts` — OTP send/verify helper
- `src/lib/guardOtp.ts` — consumes a login-style OTP for sensitive actions (5 wrong tries burn it)
- `src/lib/guardLeave.ts` — leave rules (past dates, overlap, worked days) and day-based balances
- `src/lib/guardChangeRequest.ts` — change-request validation, masking, apply, payout cool-off
- `src/lib/guardSign.ts` — short-lived signed links (payslip PDF, ticket attachments), admin-key check
- `src/lib/guardMediaStore.ts` — media storage root and owner-checked reads
- `src/lib/guardDocuments.ts` — document rules: expiry status, Aadhaar masking, optional OCR
- `src/lib/guardPdf.ts` — dependency-free single-page PDF writer for payslips
- `src/lib/guardVoice.ts` — IVR call on a second wake-check miss (Exotel or Twilio)
- `src/lib/guardSession.ts` — signed guard session tokens, registration tickets, and the
  `/api/guard/*` gate used by `proxy.ts`
- `src/lib/guardFaceVerify.ts`, `src/lib/guardIncident.ts` — face check and incident recording,
  shared by the online routes and the offline sync

### Routes
- `GET  /api/guard/today` — the duty bundle (roster, site, geofence, briefing, patrol + wake
  schedules, timeline, alerts, live offers) in one round trip, with an ETag
- `GET  /api/guard/roster` — the guard's own 7-day roster
- `POST/GET /api/guard/attendance` — check-in / check-out, server-authoritative geofence
- `POST/GET/PATCH /api/guard/patrol` — checkpoint scans, round completion computed server-side;
  PATCH attaches the guard's observation (All OK / note / photo / voice / issue) to a scan, and
  an issue is pushed to the supervisor as `PATROL_ISSUE`
- `POST/GET /api/guard/wake-check` — acknowledgement, 60 s re-prompt after a first miss,
  escalation on a second (`WAKE_CHECK_MISSED`), plus the server-side missed sweep
- `POST/GET/PATCH /api/guard/sos` — SOS ingest, acknowledgement polling, PIN-gated cancel
- `POST /api/guard/sos/inbound` — SMS-gateway webhook; a texted SOS becomes a real one
- `POST/GET /api/guard/incident` — low / serious / emergency severity (emergency is P0 and
  emitted as `INCIDENT_EMERGENCY`), injuries and police-informed flags, the guard's own reports
- `POST/GET/PATCH /api/guard/leave` — validated requests (422 with a code), day-based balance per
  type, withdraw while pending
- `POST/GET/PATCH /api/guard/change-request` — personal-detail changes. Name/DOB wait for the
  agency (`PATCH` with the admin key: approve / reject / cancel); bank/UPI need an OTP and take
  effect after a cool-off the guard can cancel, with an SMS alert and payroll notifications
  (`PAYOUT_CHANGE_REQUESTED`, `PAYOUT_DETAILS_CHANGED`); address and emergency contact apply at
  once. `GET` with the admin key lists the queue; `?sweep=1` applies matured payout changes
  (they are also applied lazily whenever the guard opens the screen)
- `POST /api/guard/sync` — bulk offline flush, per-event results, sequence-gap detection; now also
  takes `patrol_observation`, and returns `retry: true` for an observation whose scan has not
  arrived yet (the app keeps it queued)
- `POST/GET /api/guard/media` — media upload + ownership-checked read-back, face verification.
  **Behaviour change:** a read without `guardId` used to skip the ownership check entirely; it now
  needs the owning `guardId`, a signed link, or the admin key
- `POST/GET /api/guard/support` — guard tickets (voice note and/or text), written into the existing
  `SupportTicket` collection so they appear in the Ops and agency queues. Ticket ids start `GRD-`;
  voice notes are linked in the ticket text as signed URLs valid for 30 days
- `POST/GET /api/guard/earnings/pdf` — payslip PDF behind a 10-minute signed link; finalised
  payslips only
- `GET/POST /api/guard/documents` — now stores the uploaded scan (the old version stored a device
  file path the server could never open), computes Expiring / Expired on read, and keeps Aadhaar
  masked to the last four digits; `POST /api/guard/documents/ocr` — optional pre-fill
- `POST /api/guard/auth/send-otp` — appends the app's SMS Retriever hash so the OTP is read
  automatically
- `POST/GET /api/guard/site-config` — admin-key-gated site configuration
- `GET/POST /api/guard/replacement` — the guard's offers; accept is atomic, first one wins
- `POST/GET/DELETE /api/guard/replacement/dispatch` — open a vacancy and offer it in waves
- `GET /api/guard/supervisor/team` — team state + review queue
- `POST /api/guard/supervisor/verify` — approve or reject a flagged event
- `POST/GET /api/guard/supervisor/proxy` — proxy attendance, always flagged
- `POST/GET /api/guard/supervisor/site-visit` — the supervisor's own geo-stamped presence
- `POST/GET /api/guard/supervisor/grant` — grant or revoke supervisor authority
- `GET/POST /api/guard/device` — device standing, approve / reject / unbind
- `GET /api/guard/earnings` — month-to-date estimate and finalised payslips
- `GET/POST /api/guard/training` — catalogue with progress; quiz graded server-side
- `POST /api/guard/auth/verify-otp` — now returns `sessionToken` for a known guard, or a
  30-minute `registerTicket` for a new phone number
- `POST /api/guard/auth/refresh` — renews a session (refused after logout, device unbind or a
  device change); `POST /api/guard/auth/logout` — ends every session of that guard
- `POST /api/guard/assistant` — the guard's question answered from their own duty, leave and pay
  data (rule answers in Hindi/English), otherwise by Claude when `ANTHROPIC_API_KEY` is set.
  Read-only; 30 questions an hour per guard
- `GET /api/guard/kpi` — admin key; two-tap check-in KPI from the app's `checkin_taps` events
  (median and p90 taps, share at target, seconds, auto-capture rate)
- plus `/auth/send-otp`, `/agency/link`, `/documents`, `/face/enroll`,
  `/notices`, `/team`, `/version`, `/i18n`

## Environment variables to add

```
GUARD_ADMIN_KEY=<long random string>        # gates every admin-side route (site-config,
                                            # replacement dispatch, supervisor grants, device
                                            # approval). Unset means those routes refuse ALL
                                            # writes rather than defaulting to open.
GUARD_PATROL_SECRET=<long random string>    # HMAC key for SGP: checkpoint tokens
GUARD_SMS_WEBHOOK_KEY=<long random string>  # shared secret for the inbound-SOS webhook
GUARD_CERT_SECRET=<long random string>      # signs training certificates

# Face verification — optional. With none of these set, every check-in selfie is recorded but
# scored `unavailable` and routed to supervisor verification, which is the PRD's own fallback.
# Setting any one group switches it on without a code change.
AWS_REKOGNITION_REGION= / AWS_ACCESS_KEY_ID= / AWS_SECRET_ACCESS_KEY=
FACEPP_API_KEY= / FACEPP_API_SECRET=
AZURE_FACE_ENDPOINT= / AZURE_FACE_KEY=

GUARD_FACE_T_HIGH=82   # ≥ this auto-accepts
GUARD_FACE_T_LOW=62    # between the two accepts with a review flag

# Personal-detail changes
GUARD_PAYOUT_COOLOFF_HOURS=24   # bank/UPI change waits this long before it applies

# Signed links (payslip PDF, voice notes in tickets). Falls back to GUARD_ADMIN_KEY; with neither
# set (or shorter than 16 characters) PDF download is switched off rather than left open.
GUARD_LINK_SECRET=<long random string>
GUARD_PUBLIC_ORIGIN=https://guards.surakshaguards.in   # origin used in links placed in tickets

# Help screen numbers. Unset hides the row; nothing is compiled into the app.
GUARD_HELPLINE=+91XXXXXXXXXX
GUARD_COMMAND_CENTER_PHONE=+91XXXXXXXXXX

# OTP auto-read. Optional: the app reports its own hash. Set only to pin one build's hash.
GUARD_SMS_APP_HASH=

# NEVER set this in production. On a production server (`next start`) the OTP is no longer echoed
# back when SMS fails, and the demo code 123456 no longer works — earlier builds did both, which
# let anyone sign in as any guard whenever no SMS gateway was configured. Make sure one of the
# SMS gateways above is configured before deploying, or guards cannot sign in at all.
# GUARD_OTP_DEV_ECHO=1

# Guard sessions. Tokens are signed with this (falls back to GUARD_LINK_SECRET, then
# GUARD_ADMIN_KEY; at least 16 characters). Changing it signs every guard out.
GUARD_SESSION_SECRET=<long random string>
# Leave UNSET for the first deploy (rollout mode): requests with a valid token are bound to that
# guard, requests without one still work, so guards on older app builds are not locked out.
# Set to 1 once everyone runs a build that signs in with a token (see "Session rollout" below).
# GUARD_REQUIRE_SESSION=1

# Guard assistant. Optional: without it the assistant answers only the built-in duty / leave /
# pay / SOS questions and says it cannot help with anything else.
ANTHROPIC_API_KEY=

# IVR call on a second wake-check miss. Optional; configure one. Without either the attempt is
# recorded as `not_configured` and the supervisor escalation still happens.
EXOTEL_SID= / EXOTEL_API_KEY= / EXOTEL_API_TOKEN= / EXOTEL_CALLER_ID= / EXOTEL_WAKE_FLOW_ID=
#   (EXOTEL_SUBDOMAIN defaults to api.exotel.com; the flow should play the wake message)
#   or the existing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM, which then also place calls

# Document OCR pre-fill. Optional; unset means no pre-fill.
GOOGLE_VISION_API_KEY=

# App version tiers (all optional; unset means every build is "ok")
GUARD_LATEST_VERSION=1.0.0      # newer than the app → a quiet "update available" banner
GUARD_MIN_VERSION=1.0.0         # older than this → degraded mode (duty still works)
GUARD_BLOCK_BELOW_VERSION=      # older than this → blocked screen (112 call stays available)
GUARD_STORE_URL=https://play.google.com/store/apps/details?id=in.surakshaguards.guard
GUARD_DEGRADED_DISABLES=offers,training,profile_edit,leave   # what degraded mode switches off
```

Degraded mode never switches off attendance, SOS or incidents, whatever this list says: the app
only knows how to gate the four features above.

`GUARD_PATROL_SECRET`, `GUARD_SMS_WEBHOOK_KEY` and `GUARD_CERT_SECRET` fall back to `JWT_SECRET`
where unset, so the system works before they are configured — but set them, because sharing one
secret across four purposes means rotating any one of them breaks the other three.

## Deploy

The source lives on the VPS in `/home/suraksha/suraksha-guard` (git repo). Deploy from there:

```
cd /home/suraksha/suraksha-guard/backend-additions
bash deploy-on-server.sh --check   # lists new files and the existing files that would be replaced
bash deploy-on-server.sh           # backup -> copy -> npm run build -> pm2 restart
```

It backs up the two replaced files to `/home/suraksha/guard-deploy-backup-<time>/`, builds **as
the suraksha user**, restarts pm2 and pings two endpoints. Because this rebuilds the live app, do
it during a quiet window, after a Hostinger snapshot.

`deploy.sh` does the same from the owner's PC over SSH (it uploads `src/` first):

```
bash deploy.sh
```

### Manual equivalent
```
scp -P 2222 -i <key> -r src ke@69.62.82.222:/home/ke/guard-backend-additions
ssh -p 2222 -i <key> ke@69.62.82.222 'mkdir -p ~/guard-backup && sudo cp -a /home/suraksha/suraksha-new/src/proxy.ts ~/guard-backup/ && sudo cp -a /home/suraksha/suraksha-new/src/app/api/guard/auth/register/route.ts ~/guard-backup/register-route.ts'
ssh -p 2222 -i <key> ke@69.62.82.222 'sudo cp -r /home/ke/guard-backend-additions/src/* /home/suraksha/suraksha-new/src/ && sudo chown -R suraksha:suraksha /home/suraksha/suraksha-new/src'
ssh -p 2222 -i <key> ke@69.62.82.222 'sudo -u suraksha bash -lc "cd /home/suraksha/suraksha-new && npm install --save @anthropic-ai/sdk@0.126.0 && npm run build && pm2 restart suraksha --update-env"'
```

### Before you deploy — checklist
1. **An SMS gateway is configured.** After this deploy the OTP is no longer echoed back, so with
   no gateway nobody can sign in (see `GUARD_OTP_DEV_ECHO` above).
2. `GUARD_SESSION_SECRET` is set; `GUARD_REQUIRE_SESSION` is **not** set yet.
3. Production's `src/proxy.ts` is still the version this copy was made from (compare before
   overwriting; merge by hand if it changed).

### Session rollout
1. Deploy with `GUARD_REQUIRE_SESSION` unset. Old app builds keep working; new builds get a token
   at sign-in and are held to it.
2. Ship the new APK. Guards on it sign in once more (their old install had no token).
3. When the old builds are gone, set `GUARD_REQUIRE_SESSION=1` and `pm2 restart suraksha
   --update-env`. From then on every `/api/guard/*` call needs a token, except sign-in, version,
   language packs, the SMS webhook and signed links. An SOS is **never** refused for a missing or
   expired token — it is accepted and flagged.
4. To raise `GUARD_MIN_VERSION` at the same time pushes old builds into degraded mode with an
   update prompt.

Known gap: the live-location socket server is separate and does not check guard tokens yet.

## Rollback
The two replaced files are in `/home/ke/guard-deploy-backup-<time>/` (`deploy.sh` prints the
path). Copy them back, delete the added route folders and the `Guard*` models/libs, rebuild and
`pm2 restart suraksha`. Unsetting `GUARD_REQUIRE_SESSION` alone is enough to undo enforced
sessions without a rebuild (restart with `--update-env`).

---

## After deploying: the app does nothing until sites have coordinates

This is the part that is easy to miss. The Guard App is roster-driven: every duty screen derives
from an `AgencyRoster` row joined to a `Site`. At the time of writing the production database has
**no roster rows, no patrol checkpoints and no patrol rounds** — only 18 guards, 2 sites and the
on-demand bookings. Until an agency creates rosters in the portal, guards will see "No duty today".

And even with a roster, the `Site` schema carries **no latitude/longitude**, so the geofence cannot
be evaluated: every check-in lands as `geofence_result = unknown` and is routed to supervisor
verification. `GuardSiteConfig` is what supplies the coordinates. Populate one per site:

```bash
curl -X POST https://guards.surakshaguards.in/api/guard/site-config \
  -H 'Content-Type: application/json' \
  -H "x-guard-admin-key: $GUARD_ADMIN_KEY" \
  -d '{
    "siteId": "<Site _id>",
    "lat": 30.7333,
    "lng": 76.7794,
    "geofenceRadiusM": 120,
    "reportingPoint": "Main Gate",
    "wakeCheckEnabled": true,
    "patrolRoundIntervalMin": 60,
    "equipmentRequired": ["Torch", "Whistle", "Register"],
    "escalationContacts": [
      { "name": "Ramesh Yadav", "phone": "+919876543210", "role": "supervisor" }
    ]
  }'
```

`GET /api/guard/site-config` (same header) lists what is configured and, under `missingCoords`,
every Site that still has none — that list is the onboarding to-do.

---

## Tests

`test/` holds the suite used to verify this work. It runs against an **isolated staging server and
test database**, never production.

```bash
# on the VPS, as the suraksha user, with the additions overlaid in a staging dir
node test/seed-test.mjs             # seeds suraksha_guardtest with rosters, sites, checkpoints
node test/test-endpoints.mjs        # 107 — duty bundle, attendance, patrol, wake, sync
node test/test-sos-replacement.mjs  #  55 — SOS ladder, inbound SMS, replacement offers
node test/test-supervisor.mjs       #  58 — team view, verification, proxy, site visits
node test/test-identity.mjs         #  52 — face enrolment and banding, device binding
node test/test-earnings.mjs         #  30 — estimate vs finalised payslip, overtime, paise
node test/test-training.mjs         #  50 — lessons, server-side grading, certificates, expiry
node test/test-round4.mjs           #  72 — leave rules, change requests, patrol observations,
                                    #        wake re-prompt, incident severity, version tiers
node test/test-round5.mjs           #  46 — media access, support tickets, payslip PDF, documents,
                                    #        IVR on a second miss
node test/test-round6.mjs           #  24 — bugs found testing the APK on a phone: selfie/record
                                    #        race, incident agency scoping and strict-schema loss,
                                    #        voice-only incidents, expired-document alerts
node test/test-round7.mjs           #  22 — guard sessions in rollout mode: tokens, refresh,
                                    #        logout, device change, registration tickets
GUARD_REQUIRE_SESSION=1 (server) + ENFORCED=1 node test/test-round7.mjs
                                    #  29 — the same with sessions enforced: 401s, SOS still
                                    #        accepted, public paths still open
node test/test-round8.mjs           #  18 — assistant rule answers (incl. Roman Hindi), KPI, on-device face
                                    #        check verdict becoming a review flag
node test/probe-data.mjs            # read-only inventory of what production actually contains
```

**534 assertions** in rollout mode (plus 29 with sessions enforced), all green. The enforced run
needs the staging server restarted with `GUARD_REQUIRE_SESSION=1`; the other suites expect it
unset. The assistant's Claude path is not covered: the staging copy has no `ANTHROPIC_API_KEY`.

After copying changed files into a running `next dev` staging server, restart it: Turbopack
sometimes loses routes after a bulk file copy and answers existing API routes with an HTML 404,
which looks like a code failure but is not.

### Behaviour changes worth knowing before deploy
- **Guard incidents now appear in the agency portal.** They were written without `agencyOwnerId`,
  which the portal filters on, so agencies never saw them. They now also carry the site name in
  `site` and keep priority, location, injury/police answers and media (stored with
  `strict: false`, since the `Incident` schema has no fields for them).
- **Login OTP** is single-use with a five-attempt limit, shared with the in-app OTP checks.
- The guard app's analytics events now reach `/api/analytics/track` (they were refused with a
  400 before). They arrive with `platform: 'suraksha'`, `pageUrl: guard-app://<event>` and
  `metadata.app = 'guard_app'`.

Note: if Twilio or Exotel credentials are in the environment you test against, `test-round5` will
place a real call to the seeded guard's number. The staging copy used here has none. Re-run `seed-test.mjs` before each suite: several suites leave
data behind (an accepted replacement offer puts a free guard on the site roster, SOS rows
accumulate), so running them back to back without a re-seed produces false failures. The app side adds `guard-app/test/test-crypto.mjs` (30), which
round-trips the encrypted-store primitives against Node's own base64 and checks that a tampered
ciphertext fails authentication rather than decoding to something plausible.

Between them the suites cover: the duty bundle and its ETag; shift-window and 12-hour timing
parsing; the duty state machine, including a guard who is mid-shift but missed the check-in
window; server-authoritative geofencing with the client lying in both directions; idempotency and
roster write-back; mock-location, clock-skew, reused-media, root, emulator and impossible-travel
detection; media upload with magic-byte validation and ownership-checked read-back; face
verification banding and the never-block rule; one-device-per-guard enforcement including the
third-phone case; patrol verification, round completion and rollover; wake-check scheduling,
acknowledgement, late acknowledgement and patrol suppression; the offline sync batch with
priority ordering and sequence-gap detection; monotonic-clock reconstruction; the SOS channel
convergence and PIN-gated cancel; replacement offers under a genuine two-guard race; supervisor
scope, verification append-not-overwrite, and proxy attendance always being flagged; the earnings
estimate never being presented as settled pay; and training quizzes being graded server-side with
the answer key never leaving the server.

### Running them yourself

The suites assume a **staging** server on `127.0.0.1:4546` pointed at the `suraksha_guardtest`
database — never production. `test/seed-test.mjs` wipes and re-seeds that database on each run,
so do not point it anywhere else.

---

## Note on the OTP
The production app running today returns the login OTP to the caller as `devCode` when no SMS
gateway is configured, and accepts `123456`. **That lets anyone sign in as any guard.** This
deploy closes it: on a production server both only work with `GUARD_OTP_DEV_ECHO=1`, which must
never be set there. Configure an SMS gateway (credentials in `.env`, sending in
`src/lib/guardSms.ts`) before or together with this deploy.
