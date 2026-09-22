# Guard login and APK verification

GitHub source updates do not update a running Next.js server or an installed APK.
The access fix requires both a backend deployment and an updated app for automatic logout.
An offline phone signs out on its next successful server contact, not instantly without a network.

## VPS checks (read only)

```bash
cd /home/suraksha/suraksha-guard
git remote -v
git log -1 --oneline
find /home/suraksha /var/www -type f -name '*.apk' -printf '%TY-%Tm-%Td %TH:%TM %p\n' 2>/dev/null
curl -i https://guards.surakshaguards.in/api/guard/version
sudo -u suraksha bash -lc 'pm2 status'
```

An APK file timestamp alone does not prove which code or API URL is bundled.
The source repository is https://github.com/chavdaamit1011-svg/suraksha-guard-app.
Do not print `.env` values into chat/logs.

## Deploy the access fix

Use the actual repository and backend paths if different. Pull as the repository owner.

```bash
cd /home/suraksha/suraksha-guard
git pull --ff-only
python3 backend-additions/deploy-access-on-server.py
sudo -u suraksha python3 backend-additions/deploy-access-on-server.py --apply
sudo -u suraksha bash -lc 'cd /home/suraksha/suraksha-new && npm run build && pm2 restart suraksha --update-env'
```

The installer backs up replaced files and retains the backend's portal routing.
It installs only the login/access fix, not the remaining guard duty APIs.
The backend must use the same MongoDB database as AP/Ops and have its SMS gateway configured.
Keep the existing `GUARD_SESSION_SECRET` stable. New installations should configure a strong,
private session secret and `GUARD_REQUIRE_SESSION=1` once all clients support sessions.

## Expected behavior

- A guard added in AP or Ops signs in with the portal phone number and a valid OTP; no profile re-entry.
- Phone numbers with or without `+91` and spaces match the same record.
- Deleted/inactive guard or deleted/inactive agency: OTP login and protected APIs return 401 with
  `code: guard_removed` and `action: LOGOUT`; the updated app clears the session and returns to login.
- Self-registration is disabled so a removed guard cannot recreate their own access.
- Adding the number again through AP/Ops creates a valid new account.
- Ops records are checked on every request even after an AP-compatible projection is created.

## APK

From `guard-app`, `npx eas-cli@latest build --platform android --profile preview` produces an APK.
The preview profile pins both API/socket URLs to https://guards.surakshaguards.in and increments
the Android build version. Reuse the existing signing credentials. Download the finished artifact
from the build page printed by EAS. A build made before this fix does not contain the new logout handling.
Install over the previous app only if its signing certificate matches; do not delete unsynced data
to work around a signing mismatch.
