import { APGuard } from '@/lib/models/APGuard';
import { GuardAppProfile } from '@/lib/models/GuardAppProfile';
import { GuardChangeRequest } from '@/lib/models/GuardChangeRequest';

/**
 * Personal-detail change requests (PRD 18.11, SUR-GAP-026). See the model for the three paths.
 *
 * Why the payout path is the strictest: the most valuable thing a stolen phone can do is redirect
 * a month's wages. The OTP proves the SIM is present, the SMS alert tells the real guard if it is
 * not them, and the 24-hour cool-off gives them time to cancel before any money moves.
 */

export const FIELDS = ['name', 'dob', 'bank', 'upi', 'address', 'emergencyContact'] as const;
export type ChangeField = (typeof FIELDS)[number];
export type Category = 'identity' | 'payout' | 'contact';

export function categoryOf(field: ChangeField): Category {
  if (field === 'name' || field === 'dob') return 'identity';
  if (field === 'bank' || field === 'upi') return 'payout';
  return 'contact';
}

export function coolOffMs(): number {
  const h = Number(process.env.GUARD_PAYOUT_COOLOFF_HOURS ?? 24);
  return (Number.isFinite(h) && h >= 0 ? h : 24) * 3600_000;
}

/** Statuses during which another request for the same field would conflict. */
export const LIVE = ['pending', 'cooling_off', 'approved'];

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const VPA = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/;

function str(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

function mask(num: string): string {
  return num.length <= 4 ? num : `••••${num.slice(-4)}`;
}

function maskPhone(p: string): string {
  const d = p.replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `${d.slice(0, 2)}••••••${d.slice(-2)}` : '';
}

export type Normalised =
  | { ok: true; value: any; display: string }
  | { ok: false; code: string; message: string };

/** Validate and normalise a requested value. The display string is safe to return and to log. */
export function normalise(field: ChangeField, raw: any): Normalised {
  switch (field) {
    case 'name': {
      const name = str(raw, 80).replace(/\s+/g, ' ');
      if (name.length < 2) return { ok: false, code: 'bad_value', message: 'Enter the full name.' };
      if (/\d/.test(name)) return { ok: false, code: 'bad_value', message: 'A name cannot contain digits.' };
      return { ok: true, value: name, display: name };
    }
    case 'dob': {
      const dob = str(raw, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(`${dob}T00:00:00Z`))) {
        return { ok: false, code: 'bad_value', message: 'Date of birth must be YYYY-MM-DD.' };
      }
      const age = (Date.now() - Date.parse(`${dob}T00:00:00Z`)) / (365.25 * 24 * 3600_000);
      if (age < 18 || age > 75) {
        return { ok: false, code: 'bad_value', message: 'Date of birth is outside the allowed age range.' };
      }
      return { ok: true, value: dob, display: dob };
    }
    case 'bank': {
      const accountHolder = str(raw?.accountHolder, 80);
      const accountNumber = String(raw?.accountNumber ?? '').replace(/\s/g, '');
      const ifsc = String(raw?.ifsc ?? '').trim().toUpperCase();
      if (accountHolder.length < 2) return { ok: false, code: 'bad_value', message: 'Enter the account holder name.' };
      if (!/^\d{9,18}$/.test(accountNumber)) {
        return { ok: false, code: 'bad_value', message: 'Account number must be 9 to 18 digits.' };
      }
      if (!IFSC.test(ifsc)) return { ok: false, code: 'bad_value', message: 'IFSC code is not valid.' };
      return {
        ok: true,
        value: { accountHolder, accountNumber, ifsc },
        display: `${accountHolder} · ${mask(accountNumber)} · ${ifsc}`,
      };
    }
    case 'upi': {
      const vpa = String(raw?.vpa ?? raw ?? '').trim().toLowerCase();
      if (!VPA.test(vpa)) return { ok: false, code: 'bad_value', message: 'UPI ID is not valid.' };
      return { ok: true, value: { vpa }, display: vpa };
    }
    case 'address': {
      const address = str(raw, 300);
      if (address.length < 5) return { ok: false, code: 'bad_value', message: 'Enter the full address.' };
      return { ok: true, value: address, display: address };
    }
    case 'emergencyContact': {
      const name = str(raw?.name, 80);
      const phone = String(raw?.phone ?? '').replace(/\D/g, '').slice(-10);
      const relation = str(raw?.relation, 40);
      if (name.length < 2) return { ok: false, code: 'bad_value', message: 'Enter the contact name.' };
      if (!/^[6-9]\d{9}$/.test(phone)) return { ok: false, code: 'bad_value', message: 'Enter a valid 10-digit mobile number.' };
      return {
        ok: true,
        value: { name, phone: `+91${phone}`, relation },
        display: `${name}${relation ? ` (${relation})` : ''} · ${maskPhone(phone)}`,
      };
    }
  }
}

/** What the guard's details currently are, masked. */
export async function currentDetails(guardId: string) {
  const [guard, profile]: any[] = await Promise.all([
    APGuard.findById(guardId).select('name address phone').lean().catch(() => null),
    GuardAppProfile.findOne({ guardId }).select('dob emergencyContact payout').lean(),
  ]);
  const p = profile?.payout ?? {};
  const ec = profile?.emergencyContact ?? {};
  return {
    name: guard?.name ?? '',
    phone: guard?.phone ?? '',
    dob: profile?.dob ?? '',
    address: guard?.address ?? '',
    emergencyContact: ec.name ? `${ec.name}${ec.relation ? ` (${ec.relation})` : ''} · ${maskPhone(ec.phone ?? '')}` : '',
    payout:
      p.method === 'bank'
        ? `${p.accountHolder} · ••••${p.accountLast4} · ${p.ifsc}`
        : p.method === 'upi'
          ? p.vpa
          : '',
    payoutMethod: p.method ?? '',
  };
}

export function previousDisplayFor(field: ChangeField, cur: Awaited<ReturnType<typeof currentDetails>>): string {
  if (field === 'bank') return cur.payoutMethod === 'bank' ? cur.payout : '';
  if (field === 'upi') return cur.payoutMethod === 'upi' ? cur.payout : '';
  return (cur as any)[field] ?? '';
}

/** Write an approved or matured request to where the value actually lives. */
export async function applyChange(req: any): Promise<void> {
  const v = req.newValue;
  const guardId = req.guardId;
  switch (req.field as ChangeField) {
    case 'name':
      await APGuard.updateOne({ _id: guardId }, { $set: { name: v, initials: String(v).slice(0, 1).toUpperCase() } });
      break;
    case 'address':
      await APGuard.updateOne({ _id: guardId }, { $set: { address: v } });
      break;
    case 'dob':
      await GuardAppProfile.updateOne({ guardId }, { $set: { dob: v } }, { upsert: true });
      break;
    case 'emergencyContact':
      await GuardAppProfile.updateOne({ guardId }, { $set: { emergencyContact: v } }, { upsert: true });
      break;
    case 'bank':
      await GuardAppProfile.updateOne(
        { guardId },
        {
          $set: {
            payout: {
              method: 'bank',
              accountHolder: v.accountHolder,
              accountNumber: v.accountNumber,
              accountLast4: String(v.accountNumber).slice(-4),
              ifsc: v.ifsc,
              vpa: '',
              updatedAt: new Date(),
              changeRequestId: req.requestId,
            },
          },
        },
        { upsert: true }
      );
      break;
    case 'upi':
      await GuardAppProfile.updateOne(
        { guardId },
        {
          $set: {
            payout: {
              method: 'upi',
              accountHolder: '',
              accountNumber: '',
              accountLast4: '',
              ifsc: '',
              vpa: v.vpa,
              updatedAt: new Date(),
              changeRequestId: req.requestId,
            },
          },
        },
        { upsert: true }
      );
      break;
  }
}

export function notify(payload: Record<string, unknown>) {
  try {
    (globalThis as any).__io?.emit?.('new-notification', { ...payload, at: new Date().toISOString() });
  } catch {
    /* ignore */
  }
}

/**
 * Apply every payout change whose cool-off has ended. Lazy (run on read) plus callable from the
 * admin sweep, so it needs no scheduler. `asOf` exists for the admin sweep and tests.
 */
export async function applyDuePayoutChanges(opts: { guardId?: string; asOf?: Date } = {}): Promise<number> {
  const asOf = opts.asOf ?? new Date();
  const due: any[] = await GuardChangeRequest.find({
    status: 'cooling_off',
    effectiveAt: { $lte: asOf },
    ...(opts.guardId ? { guardId: opts.guardId } : {}),
  })
    .select('+newValue')
    .lean();

  let applied = 0;
  for (const r of due) {
    // Claim first, so two concurrent sweeps cannot both apply it.
    const claim = await GuardChangeRequest.updateOne(
      { requestId: r.requestId, status: 'cooling_off' },
      { $set: { status: 'applied', appliedAt: new Date() } }
    );
    if ((claim as any).modifiedCount !== 1) continue;
    await applyChange(r);
    applied++;
    notify({
      kind: 'PAYOUT_DETAILS_CHANGED',
      audience: ['payroll', 'agency'],
      guardId: r.guardId,
      agencyId: r.agencyId,
      requestId: r.requestId,
      field: r.field,
      display: r.display,
    });
  }
  return applied;
}

export function publicView(r: any) {
  return {
    requestId: r.requestId,
    field: r.field,
    category: r.category,
    display: r.display,
    previousDisplay: r.previousDisplay,
    reason: r.reason,
    status: r.status,
    effectiveAt: r.effectiveAt ?? null,
    appliedAt: r.appliedAt ?? null,
    decisionNote: r.decisionNote ?? '',
    createdAt: r.createdAt,
  };
}
