"""Install only the guard access fix, preserving the backend's portal routing.
Run with Python 3 on the VPS; defaults to a read-only preview.
"""
import argparse
import datetime
from pathlib import Path
import shutil

parser = argparse.ArgumentParser()
parser.add_argument('--app', default='/home/suraksha/suraksha-new')
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
source = Path(__file__).resolve().parent / 'src'
app = Path(args.app).resolve()
files = ['app/api/guard/access/route.ts', 'lib/guardAccess.ts', 'lib/guardPhone.ts', 'lib/guardCors.ts', 'lib/guardSession.ts',
         'lib/guardOtp.ts', 'lib/guardSms.ts', 'lib/models/GuardAppProfile.ts']
files += [f'app/api/guard/auth/{route}/route.ts' for route in
          ['check', 'send-otp', 'verify-otp', 'register', 'refresh', 'logout']]
old = (app / 'src/proxy.ts').read_text(encoding='utf-8-sig')
reference = (source / 'proxy.ts').read_text(encoding='utf-8-sig')
marker = 'export async function proxy'
if marker not in old or '  // API calls' not in old:
    raise SystemExit('Unknown proxy layout. No files changed; review manually.')
prefix = reference[:reference.index(marker)]
body = old[old.index(marker):]
branch = "  if (pathname.startsWith('/api/guard/'))"
replacement = reference[reference.index(branch):reference.index('  // API calls')]
if branch in body:
    begin = body.index(branch)
    end = body.index('  // API calls', begin)
    body = body[:begin] + replacement + body[end:]
else:
    begin = body.index('  // API calls')
    body = body[:begin] + replacement + body[begin:]
print(f'Target: {app}')
for name in files:
    if not (source / name).is_file():
        raise SystemExit(f'Missing source: {name}')
    print(f'Install: src/{name}')
print('Patch: guard access gate only; retain portal routing')
if args.apply:
    backup = app.parent / ('guard-access-backup-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
    for name in files + ['proxy.ts']:
        destination = app / 'src' / name
        if destination.exists():
            saved = backup / name
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(destination, saved)
    for name in files:
        destination = app / 'src' / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / name, destination)
    (app / 'src/proxy.ts').write_text(prefix + body, encoding='utf-8')
    print(f'Installed. Backup: {backup}. Rebuild/restart the backend to activate.')
