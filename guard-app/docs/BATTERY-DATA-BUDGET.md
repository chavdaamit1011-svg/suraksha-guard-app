# Battery and data budget: release gate (SUR-GAP-032)

PRD 18.15.7 makes two numbers release gates:

| Budget | Limit | Measured as |
|---|---|---|
| Battery | ≤ 6 % per 12-hour shift, 4000 mAh reference phone | whole-phone battery drop during a real shift, scaled to 12 h |
| Data | ≤ 40 MB per month, excluding media | the app's own network bytes, scaled to 26 shifts |

A release that fails either one does not ship.

## What the app does to stay inside it

- Location only while a duty is running, through one foreground service with a visible
  "On duty — location active" notification (`src/lib/dutyTracking.ts`).
  - Balanced accuracy, one fix every 120 s or 25 m of movement.
  - High accuracy only for check-in, checkpoint scans and SOS.
- Below 15 % battery the interval widens to 300 s. Android only lets the app change the interval
  while it is on screen, so the switch happens the next time the guard opens the app.
- The service stops at check-out, at logout, and on its own at shift end plus the agency's
  auto-close window. A guard who never reopens the app is not tracked past the shift.
- Duty data is one cached bundle with an ETag, so an unchanged bundle costs a few hundred bytes.
- Photos are compressed to 640 px before upload; the queue retries with back-off.

## How to measure

Needs: the reference phone (or the phone being signed off), the release APK, wireless debugging
(`adb pair` / `adb connect`), and `adb` on the PATH.

1. Charge to about 90 %, then **unplug**. Android does not count usage while charging, so use
   wireless debugging rather than a cable.
2. Close other apps. Leave Wi-Fi/mobile data as the guard would have them.
3. Sign in and check in to a real or test shift.
4. Start:
   ```
   powershell -ExecutionPolicy Bypass -File scripts\measure-budget.ps1 -Start
   ```
   (add `-Device <serial>` when more than one phone is connected)
5. Work the shift normally: patrol rounds, a wake check, an incident with a photo. Keep the screen
   off in between, as a guard would. The phone may disconnect from the PC; reconnect at the end.
6. At the end (at least 2 h; the full 12 h before a release):
   ```
   powershell -ExecutionPolicy Bypass -File scripts\measure-budget.ps1 -Stop -MediaMB <n>
   ```
   `-MediaMB` is the photo/voice upload size for the run, which is excluded from the data budget.
   Leave it at 0 for a stricter result.

The script prints PASS/FAIL for both budgets, exits 1 on a failure, and writes
`.budget-run-result.json` next to the project for the release record. It only reads statistics
and never sends taps or key presses to the phone.

## Reading a failure

| Symptom | Look at |
|---|---|
| Battery fails, app's own mAh share is small | Something else on the phone. Repeat on a clean phone before blaming the app. |
| Battery fails, app share is large | Is the service still running after check-out (notification still showing)? Is the interval right (`PING_INTERVAL_SEC` in `src/config.ts`)? |
| Data fails | Bundle ETag not matching (every refresh downloading the full bundle), or media counted as data (pass `-MediaMB`). |

## Release record

| Date | Build | Phone | Hours | Battery / 12 h | Data / month | Result |
|---|---|---|---|---|---|---|
| | | | | | | |
