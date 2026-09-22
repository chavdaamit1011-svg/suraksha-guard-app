import { NextResponse } from 'next/server';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { connectToDatabase } from '@/lib/db';
import { APGuard } from '@/lib/models/APGuard';
import { GuardChangeRequest } from '@/lib/models/GuardChangeRequest';
import { consumeOtp } from '@/lib/guardOtp';
import { sendSms } from '@/lib/guardSms';
import {
  FIELDS,
  LIVE,
  applyChange,
  applyDuePayoutChanges,
  categoryOf,
  coolOffMs,
  currentDetails,
  normalise,
  notify,
  previousDisplayFor,
  publicView,
  type ChangeField,
} from '@/lib/guardChangeRequest';

export const dynamic = 'force-dynamic';

/**
 * Personal-detail change requests (PRD 18.11, SUR-GAP-026).
 *
 * Guard:
 *   GET    ?guardId=                                  current (masked) details + requests
 *   POST   { guardId, field, value, reason?, mediaIds?, otp? }
 *   PATCH  { guardId, requestId, action: 'cancel' }   while pending or cooling off
 *
 * Agency (x-guard-admin-key):
 *   GET    ?status=&agencyId=&sweep=1&asOf=           queue; sweep applies matured payout changes
 *   PATCH  { requestId, action: 'approve'|'reject'|'cancel', note?, decidedBy? }
 */

function isAdmin(req: Request): boolean {
  const expected = process.env.GUARD_ADMIN_KEY;
  if (!expected) return false;
  const given = req.headers.get('x-guard-admin-key') ?? '';
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function fail(status: number, code: string, message: string) {
  return NextResponse.json({ success: false, code, message }, { status });
}

export async function POST(req: Request) {
  try {
    const b = await req.json();
    const guardId = String(b.guardId ?? '');
    const field = String(b.field ?? '') as ChangeField;
    if (!mongoose.Types.ObjectId.isValid(guardId)) return fail(400, 'bad_guard', 'valid guardId required');
    if (!FIELDS.includes(field)) return fail(400, 'bad_field', 'This detail cannot be changed from the app.');

    const norm = normalise(field, b.value);
    if (!norm.ok) return fail(422, norm.code, norm.message);

    const category = categoryOf(field);
    const reason = String(b.reason ?? '').trim().slice(0, 500);
    const mediaIds: string[] = Array.isArray(b.mediaIds) ? b.mediaIds.map(String).slice(0, 5) : [];

    // Identity changes are judged by the agency against a document, so there must be something
    // to judge: a proof photo or at least a reason.
    if (category === 'identity' && !reason && mediaIds.length === 0) {
      return fail(422, 'proof_required', 'Add a photo of a document or a reason for the change.');
    }

    await connectToDatabase();
    const guard: any = await APGuard.findById(guardId).select('phone agencyId name').lean();
    if (!guard) return fail(404, 'no_guard', 'guard not found');

    const live = await GuardChangeRequest.findOne({ guardId, field, status: { $in: LIVE } }).lean();
    if (live) {
      return fail(409, 'already_pending', 'A change to this detail is already in progress. Cancel it first.');
    }

    // OTP after the cheap checks, so a malformed request does not burn the guard's code.
    if (category === 'payout') {
      if (!b.otp) return fail(422, 'otp_required', 'Verify with the OTP sent to your phone.');
      const otp = consumeOtp(guard.phone, String(b.otp));
      if (!otp.ok) return fail(422, otp.code, otp.message);
    }

    const cur = await currentDetails(guardId);
    const requestId = crypto.randomUUID();
    const now = new Date();
    const effectiveAt = category === 'payout' ? new Date(now.getTime() + coolOffMs()) : undefined;
    const status = category === 'identity' ? 'pending' : category === 'payout' ? 'cooling_off' : 'applied';

    const doc = {
      requestId,
      guardId,
      agencyId: guard.agencyId ?? '',
      field,
      category,
      newValue: norm.value,
      display: norm.display,
      previousDisplay: previousDisplayFor(field, cur),
      reason,
      mediaIds,
      status,
      ...(category === 'payout' ? { otpVerifiedAt: now, effectiveAt, payrollNotifiedAt: now } : {}),
      ...(category === 'contact' ? { appliedAt: now } : {}),
    };
    await GuardChangeRequest.create(doc);

    if (category === 'contact') {
      await applyChange(doc);
    }

    if (category === 'payout') {
      notify({
        kind: 'PAYOUT_CHANGE_REQUESTED',
        audience: ['payroll', 'agency'],
        guardId,
        agencyId: guard.agencyId ?? '',
        requestId,
        field,
        display: norm.display,
        effectiveAt: effectiveAt!.toISOString(),
      });
      // Tell the phone number on file, so a guard whose handset is in someone else's hands
      // learns about it before the money moves.
      const when = effectiveAt!.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
      const sms = await sendSms(
        guard.phone,
        `Suraksha: a request to change your ${field === 'bank' ? 'bank account' : 'UPI ID'} was made. It takes effect ${when}. Not you? Cancel it in the app or call your agency now.`
      ).catch(() => ({ delivered: false }));
      if (sms.delivered) {
        await GuardChangeRequest.updateOne({ requestId }, { $set: { guardAlertedAt: new Date() } });
      }
    }

    if (category === 'identity') {
      notify({ kind: 'PROFILE_CHANGE_REQUESTED', audience: ['agency'], guardId, agencyId: guard.agencyId ?? '', requestId, field });
    }

    const saved = await GuardChangeRequest.findOne({ requestId }).lean();
    return NextResponse.json({ success: true, request: publicView(saved) });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'change request failed' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    await connectToDatabase();

    if (isAdmin(req)) {
      let swept = 0;
      if (searchParams.get('sweep') === '1') {
        const asOf = searchParams.get('asOf');
        swept = await applyDuePayoutChanges({ asOf: asOf ? new Date(asOf) : undefined });
      }
      const q: Record<string, unknown> = {};
      if (searchParams.get('status')) q.status = searchParams.get('status');
      if (searchParams.get('agencyId')) q.agencyId = searchParams.get('agencyId');
      if (searchParams.get('guardId')) q.guardId = searchParams.get('guardId');
      const rows = await GuardChangeRequest.find(q).sort({ createdAt: -1 }).limit(200).lean();
      return NextResponse.json({
        success: true,
        swept,
        requests: rows.map((r: any) => ({ ...publicView(r), guardId: r.guardId, agencyId: r.agencyId, mediaIds: r.mediaIds })),
      });
    }

    const guardId = searchParams.get('guardId') ?? '';
    if (!mongoose.Types.ObjectId.isValid(guardId)) return fail(400, 'bad_guard', 'valid guardId required');

    await applyDuePayoutChanges({ guardId });
    const [details, rows] = await Promise.all([
      currentDetails(guardId),
      GuardChangeRequest.find({ guardId }).sort({ createdAt: -1 }).limit(30).lean(),
    ]);

    return NextResponse.json({
      success: true,
      details,
      requests: rows.map(publicView),
      rules: {
        locked: ['name', 'dob'],
        otpRequired: ['bank', 'upi'],
        coolOffHours: coolOffMs() / 3600_000,
      },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'read failed' }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const b = await req.json();
    const requestId = String(b.requestId ?? '');
    const action = String(b.action ?? '');
    if (!requestId) return fail(400, 'bad_request', 'requestId required');
    await connectToDatabase();

    if (isAdmin(req)) {
      if (action === 'cancel') {
        const r = await GuardChangeRequest.updateOne(
          { requestId, status: { $in: ['pending', 'cooling_off'] } },
          { $set: { status: 'cancelled', cancelledBy: String(b.decidedBy ?? 'agency'), decisionNote: String(b.note ?? '') } }
        );
        if ((r as any).matchedCount === 0) return fail(409, 'not_open', 'This request is no longer open.');
        return NextResponse.json({ success: true, status: 'cancelled' });
      }
      if (action !== 'approve' && action !== 'reject') return fail(400, 'bad_action', 'unknown action');

      const decided = await GuardChangeRequest.findOneAndUpdate(
        { requestId, status: 'pending', category: 'identity' },
        {
          $set: {
            status: action === 'approve' ? 'applied' : 'rejected',
            decidedBy: String(b.decidedBy ?? 'agency'),
            decidedAt: new Date(),
            decisionNote: String(b.note ?? ''),
            ...(action === 'approve' ? { appliedAt: new Date() } : {}),
          },
        },
        { new: true }
      )
        .select('+newValue')
        .lean();
      if (!decided) return fail(409, 'not_open', 'Only a pending identity change can be decided.');

      if (action === 'approve') await applyChange(decided);
      notify({
        kind: action === 'approve' ? 'PROFILE_CHANGE_APPROVED' : 'PROFILE_CHANGE_REJECTED',
        audience: ['guard'],
        guardId: (decided as any).guardId,
        requestId,
      });
      return NextResponse.json({ success: true, request: publicView(decided) });
    }

    // Guard: may only cancel their own open request.
    const guardId = String(b.guardId ?? '');
    if (!guardId || action !== 'cancel') return fail(400, 'bad_action', 'guardId and action "cancel" required');
    const r: any = await GuardChangeRequest.findOneAndUpdate(
      { requestId, guardId, status: { $in: ['pending', 'cooling_off'] } },
      { $set: { status: 'cancelled', cancelledBy: 'guard' } },
      { new: true }
    ).lean();
    if (!r) return fail(409, 'not_open', 'This request can no longer be cancelled.');

    if (r.category === 'payout') {
      notify({ kind: 'PAYOUT_CHANGE_CANCELLED', audience: ['payroll', 'agency'], guardId, agencyId: r.agencyId, requestId });
    }
    return NextResponse.json({ success: true, request: publicView(r) });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'update failed' }, { status: 500 });
  }
}
