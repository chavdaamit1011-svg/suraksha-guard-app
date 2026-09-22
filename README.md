# Suraksha Guard — source

Everything for the Suraksha Guard app lives in this folder. On the VPS it is
`/home/suraksha/suraksha-guard`; the owner's working copy is on their PC.

| Folder | What |
|---|---|
| `guard-app/` | The Android guard app (Expo SDK 57 / React Native). Build: `guard-app/docs/BUILD-APK.md` |
| `backend-additions/` | Guard APIs, models and libs for the main Next.js app, with tests. **Not deployed yet.** Deploy: `backend-additions/DEPLOY.md` |
| `docs/SURAKSHA_Master_PRD.md` | Product spec. Section 18 covers the guard app |

## How it fits with the rest

- The **main app** (website, Agency portal, Ops, Client portal, Trinetra) is a separate
  Next.js app at `/home/suraksha/suraksha-new`, from `github.com/chavdaamit1011-svg/suraksha`.
  - It runs under pm2 as `suraksha` on port 4545, behind nginx, for every *.surakshaguards.in domain.
  - Its MongoDB database is `suraksha`, on the same host.
- The guard app talks to `https://guards.surakshaguards.in/api/guard/*`, which is served by that
  main app.
- `backend-additions/src` is copied into `suraksha-new/src` to deploy. Two existing files are
  replaced, and `deploy-on-server.sh` backs both up first.
  - To preview what would change, run on the VPS: `bash backend-additions/deploy-on-server.sh --check`.

## Not in this folder, on purpose

- **The app signing key.** The owner keeps it. Every update must be signed with the same key, so
  never create a new one.
- **Secrets** (`.env` of the main app, SSH keys). Get these from the owner separately.
- **`node_modules` and Android build output.** Run `npm install` in `guard-app/`, then follow
  BUILD-APK.md.
