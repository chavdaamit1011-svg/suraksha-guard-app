# Native module: SOS without a tap, OTP auto-read, NFC, wake alarms, face check

`modules/guard-native` is a local Expo module (Android only). Expo autolinking picks it up from
`modules/`, so it is part of every EAS / `expo run:android` / local Gradle build with no extra
step. **It is not in Expo Go**: there `requireOptionalNativeModule('GuardNative')` returns null, and
every wrapper in `src/lib/native.ts` reports "not available" so the app falls back to the old
behaviour.

> Status: compiled in the local release build (Gradle 9.3.1, compileSdk 36, 32- and 64-bit ARM)
> and tried on an OPPO phone (Android 15) on 2026-09-18:
> - The face check rejected a frame with no face, retook twice and then kept it; the server
>   recorded `device_face_no_face`.
> - The wake alarm fired at its minute with the screen locked, on the alarm stream, over the lock
>   screen. A miss armed the 60 s re-prompt, which also fired and was answered.

## What it does

| Feature | PRD | Native call | Fallback when unavailable |
|---|---|---|---|
| SOS structured SMS to the agency number (rung 5) | 18.9 §9 | `sendSmsDirect` (needs `SEND_SMS`) | pre-filled composer, one tap |
| SOS plain SMS to the supervisor (rung 6) | 18.9 §9 | `sendSmsDirect` | pre-filled composer, one tap |
| Auto-call supervisor / control room (rung 7) | 18.9 §9 | `placeCall` (needs `CALL_PHONE`) | dialler with the number filled in |
| OTP auto-read | 18.1, SUR-GAP-001 | SMS Retriever (`startSmsListener`, `getAppHash`) | Android autofill (`autoComplete="sms-otp"`), then typing |
| NFC checkpoint tags | 18.7, SUR-GAP-014 | reader mode (`startNfcScan`, `onNfcTag`) | QR scan / manual code |
| Wake-check alarm | 18.8, SUR-GAP-015 | `scheduleAlarm`, `cancelAlarm`, `dismissAlarm`, `scheduledAlarms`, `alarmsExact`, `showOverLockScreen` | an ordinary local notification |
| Selfie face check | 18.1 §5, 18.5 | `detectFaces` (ML Kit, bundled model) | photo accepted as is; the server's face match still runs |

The siren, torch, socket and REST rungs were already automatic and are unchanged.

## Wake alarms

A notification can be silenced by Do Not Disturb, delayed by battery saving, or missed under a
pillow. The native path behaves like the phone's own alarm clock instead:

- `AlarmManager.setAlarmClock` — exact, allowed in Doze, shown in the status bar as an alarm.
- The sound plays on the **alarm** stream (`FLAG_INSISTENT`, repeats until answered), so the
  ringer being on silent does not mute it.
- A full-screen intent opens the wake screen over the lock screen and turns the screen on
  (`USE_FULL_SCREEN_INTENT`; `showOverLockScreen` on the wake screen).
- `GuardBootReceiver` re-arms every pending alarm after a reboot or an app update.
- Each alarm stops by itself after the prompt's answer window (`timeoutMs`).

Ids are `<wakeId>#<attempt>`; the 60-second re-prompt after a first miss is attempt 2.
**App health** shows "Exact alarms" and opens the system setting when Android has switched them
off.

## Face check

`detectFaces(uri)` runs Google ML Kit face detection on the captured JPEG, fully on the phone
(the model ships inside the APK; no Play-services download, works offline). `checkFace` in
`src/lib/native.ts` turns the result into one verdict:

| Verdict | Rule |
|---|---|
| `no_face` | no face found |
| `many_faces` | more than one face |
| `too_small` | face covers under 4 % of the photo |
| `eyes_closed` | both eyes under 30 % open probability |
| `turned` | head turned or tilted over 30° |
| `ok` / `unchecked` | passes / no detector available |

- **Enrolment** refuses a bad photo and says what to fix: every later check-in is compared with it.
- **Check-in** retakes automatically up to twice with the same hint, then keeps the photo anyway.
  Duty is never blocked (18.17.1 rule 12). The verdict goes to the server as `face_check`, and a
  failed one becomes the review flag `device_face_<verdict>`.

## Permissions

`SEND_SMS`, `CALL_PHONE` and `NFC` are declared in `app.json`, and the alarm permissions
(`USE_EXACT_ALARM`, `SCHEDULE_EXACT_ALARM`, `USE_FULL_SCREEN_INTENT`, `RECEIVE_BOOT_COMPLETED`) in
the module's manifest. SMS and call are **runtime** permissions: the guard grants them from **App
health → SOS message & call**. That row shows "Automatic" once both are granted and "Needs one
tap" otherwise. A refusal is fine because the ladder falls back.

SMS Retriever needs **no** SMS permission. The OTP message only has to end with the app's
11-character hash. The app sends its own hash with `send-otp`, and the server appends it.
`GUARD_SMS_APP_HASH` overrides it if you prefer to pin it. Note:

- The hash depends on the **signing key**. A debug build, the local release key and a Play-signed
  build each have a different hash, which is why the app reports its own.
- MSG91 sends through a DLT template, so the template itself must end with a variable for the hash.
  Fast2SMS and Twilio send the text as written.

## NFC tags

A tag works either way:

- **NDEF text record** containing the same `SGP:<site>:<checkpoint>:<hmac>` token as the QR code.
  This is recommended, because it carries the same HMAC protection.
- **Blank tag**: its hardware id (hex, e.g. `04A224B2C35E80`) is used as the code. Set the
  checkpoint's `scanCode` to that id in the portal.

Scans arrive with `method: 'nfc'` and go through the same server checks as QR (site, distance, HMAC).

## Google Play

Play restricts several of these permissions to apps whose core function needs them, and each needs
a declaration with the first release that includes it:

- `SEND_SMS`, `CALL_PHONE`: **Permissions Declaration Form**. A personal-safety / emergency app
  qualifies, but review takes longer. To skip them for now, remove the two entries from
  `app.json`; SOS keeps working, with one tap on rungs 5–7.
- `USE_EXACT_ALARM`: allowed for alarm-clock-like core features; declare the wake check as such.
- `USE_FULL_SCREEN_INTENT`: Play only grants it by default to alarm and calling apps; declare it
  in the Play Console's app content section.
- Foreground service type `location` (on-duty tracking, `src/lib/dutyTracking.ts`): a short video
  of the "On duty — location active" notification and the use case is required.

iOS allows none of this. PRD 18.14 already makes Android the required platform for night-shift
guards.

## Server side

`POST /api/guard/sos/inbound` turns a structured SMS forwarded by the gateway into a real SOS
(PRD 18.9 §10) and dedupes it against the same alarm arriving over data. Set
`GUARD_SMS_WEBHOOK_KEY` and point the gateway at that route.
