# Building the APK on this PC

The APK is built locally with Gradle, without EAS or Expo Go.

## Toolchain

Everything lives in `C:\Users\Vnc\android-build`:

| Path | What |
|---|---|
| `jdk17\` | Java 17 |
| `sdk\` | Android SDK 36, build-tools 36.0.0, NDK 27.1.12297006, CMake 3.22.1 |
| `node\` | Node 22 |
| `gradle-9.3.1-bin.zip` | Gradle, used offline by the wrapper |
| `keys\` | **Release signing key** (see below) |

The build runs from a copy at `C:\sgb`, because the project path is too long for the NDK on
Windows.

## Release signing key

- `C:\Users\Vnc\android-build\keys\suraksha-guard-release.jks` is the key.
- `keystore.properties` in the same folder holds its password.

**Back up both files** to a private place you control, such as an encrypted drive or a password
manager, and not in chat or email. Every future update must be signed with this same key:

- If the key is lost, installed phones cannot update and must uninstall first, which loses unsent
  duty records.
- If the key leaks, someone else can publish an "update".

On Google Play with Play App Signing, this key becomes the *upload* key, and Google holds the app
signing key.

APKs built before this key existed were signed with the debug key. To move a phone from one of
those builds to a release-signed build, uninstall the app first.

## Steps

1. Sync the sources into the build copy:
   ```powershell
   $s='C:\Users\Vnc\Desktop\Desktop\Surksha\guard-app'
   foreach($d in 'app','src','modules','assets'){ robocopy "$s\$d" "C:\sgb\$d" /E }
   Copy-Item "$s\app.json","$s\package.json","$s\package-lock.json" C:\sgb\ -Force
   ```
   If `package.json` changed, run `npm install` in `C:\sgb`, or copy the new packages from
   `node_modules`.
   - Do **not** use `robocopy /XD android`: that also skips `modules\guard-native\android`, and
     the APK silently loses the native module.
2. Re-apply the local settings, which `expo prebuild` would overwrite:
   ```powershell
   C:\sgb\apply-local.ps1            # production: 32- and 64-bit, release key
   C:\sgb\apply-local.ps1 -Staging   # test build that talks to http://localhost:4546
   C:\sgb\apply-local.ps1 -Only64    # faster build, arm64 only
   ```
3. Build:
   - Production: `C:\sgb\build.cmd`, which points at `https://guards.surakshaguards.in`.
   - Staging test: `C:\sgb\build-test.cmd`, which points at `http://localhost:4546`.

   Both force the JS bundle to rebuild (`--rerun`). Otherwise Gradle can reuse a bundle made for
   the other server. The log is `C:\sgb\build.log`.
4. **Check which server the bundle points at** before handing the APK out. A stale bundle once
   sent test logins to production.
   ```powershell
   Add-Type -A System.IO.Compression.FileSystem
   $z=[IO.Compression.ZipFile]::OpenRead('C:\sgb\android\app\build\outputs\apk\release\app-release.apk')
   $r=New-Object IO.StreamReader(($z.Entries|?{$_.FullName -eq 'assets/index.android.bundle'}).Open())
   $b=$r.ReadToEnd(); $r.Close(); $z.Dispose()
   "staging: $($b.Contains('localhost:4546'))"
   ```
   This must print `False` for a production APK.
5. Output: `C:\sgb\android\app\build\outputs\apk\release\app-release.apk`.

## Installing on a phone

Use `adb install -r <apk>` over wireless debugging, or copy the file to the phone.

- The staging test build also needs the SSH tunnel to the VPS and `adb reverse tcp:4546 tcp:4546`.
  See `scripts\start-test-rig.ps1`.
- Installing over a build signed with a different key fails with
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. Uninstall first.
