# Field-UX release checklist (SUR-GAP-035)

PRD 18.17.1 sets 15 rules for every guard screen. Before each release, someone who did not build
the release walks through the app on a low-end phone, in Hindi, and ticks each line.

**How:** use the release APK, not a dev build. Sign in as a test guard with a roster for today. Do
one round outdoors in daylight and one in a dark room. Wear gloves for rule 14.

The status column is the state of the code at the time of writing (September 2026). Re-check it
each release.

| # | Rule | Check | Status |
|---|---|---|---|
| 1 | Large touch targets | Nothing tappable is under 48 dp: back arrows, the avatar, timeline chips and the sync chip. Primary buttons are full width. | **Changed by the owner (2026-09-18):** 88/96 dp looked too big on real phones. Primary buttons are now 52 dp and CHECK IN/OUT is 64 dp, both still above the 48 dp minimum. Sizes are in `src/theme` (`touch`). |
| 2 | ≤ 2 taps from Duty Home | Check-in takes 2 taps (CHECK IN, CONFIRM). Patrol, incident and SOS take 1. Check-out takes 2 when allowed. | Met. The wake check opens from its alarm by design. The KPI is `GET /api/guard/kpi` (median should be 2). |
| 3 | Voice everywhere | Read-aloud on the briefing, earnings, training and language screens. Check-in speaks "look at the camera". Voice notes on help, leave, patrol and incident. | **Partly met.** No speech-to-text dictation in text boxes. No pre-recorded audio (text-to-speech is used, Hindi and English only). |
| 4 | Scan over type | Checkpoints use QR or NFC. Documents use the camera with OCR pre-fill. | Met. OCR needs `GOOGLE_VISION_API_KEY` on the server. The manual code field is a last resort and needs a tag photo. |
| 5 | Camera over forms | Incident, patrol issue and help all accept a photo or voice note; text is optional. | Met. |
| 6 | GPS over addresses | Check-in, wake, incident and team all capture location automatically. Registration pre-fills city and address from GPS. | Met. A new address on My details is still typed. |
| 7 | Simple language | Instructions are ≤ 12 words with no jargon. | Met for English and Hindi, the only two bundled packs. **The other listed languages show English until their packs are written and reviewed by a native speaker** (they can be delivered over the air through `/api/guard/i18n`). |
| 8 | Minimal typing | Typing is only for phone, OTP, name, PIN and optional notes. | **Partly met.** My details (bank, IFSC, UPI) and document number/expiry need typing by nature. |
| 9 | Colour + icon + text | Status band, check-in rows and alerts each show a word as well as a colour. The sync chip shows a word when offline or sending. | Met, with one exception by the owner's choice (2026-09-18): when everything is sent, the sync chip shows only the green cloud, with no word. |
| 10 | Physical feedback | Check-in, patrol, incident, wake, leave, help and documents each play the success chime plus a haptic. | Met (`src/lib/feedback.ts`). |
| 11 | Errors say what to do | Turn on flight mode and try each action. Enter bad data in leave and details. | Met for the flows checked. Check any new strings. |
| 12 | Nothing blocks duty | Check in with no GPS, a camera refusal, a bad selfie or an expired document; each still records. | **Partly met, by decision:** <br>• A phone not approved for the account gets no CHECK IN (fraud control). SOS and Help stay available. <br>• Outside the geofence, one reason chip is required (PRD 18.17.2). |
| 13 | Sunlight and darkness | Check-in and wake screens go to full brightness and restore it afterwards. The palette is high-contrast. | **Partly met.** The app is always dark. There is no light/sunlight theme, and so no switch at 19:00. |
| 14 | Gloves and wet hands | No long-press except SOS (2 s hold). No swipe-only action. | Met. The timeline scrolls sideways, but every item is also reachable from its tile. |
| 15 | Offline is calm | In flight mode, Duty Home shows an amber "Offline… saved" line; nothing turns red. | Met. Red is kept for records the server *rejected*, which do need action. |

## Also check each release

- [ ] Hindi and English: no raw keys (`duty.something`) on any screen. App health shows the
      missing-key count.
- [ ] Logout, then log in again: the PIN screen shows on cold start when off shift and is skipped
      on shift.
- [ ] The on-duty notification appears at check-in and disappears at check-out.
- [ ] The wake alarm rings with the phone on silent and the screen locked.
- [ ] Battery/data gate: `docs/BATTERY-DATA-BUDGET.md`.

| Release | Phone | Checked by | Date | Open items |
|---|---|---|---|---|
| | | | | |
