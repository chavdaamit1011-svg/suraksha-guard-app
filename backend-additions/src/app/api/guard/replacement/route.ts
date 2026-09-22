import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectToDatabase } from '@/lib/db';
import { AgencyRoster } from '@/lib/models/AgencyRoster';
import { APGuard } from '@/lib/models/APGuard';
import { GuardReplacementOffer, GuardVacancy } from '@/lib/models/GuardReplacement';
import { addDays, shiftWindow } from '@/lib/guardRoster';

export const dynamic = 'force-dynamic';

/**
 * Replacement offers — the guard's side (PRD 18.12, SUR-GAP-022).
 *
 *   GET   ?guardId=        the guard's open offers, freshest first
 *   POST  { response }     accept or decline; accept is atomic, first one wins
 *
 * Everything about the accept path is shaped by one requirement (18.12 §18): two guards tapping
 * ACCEPT in the same second must yield exactly one confirmation and no double assignment. That is
 * a single conditional update on the vacancy — `{status: 'open'} → {status: 'filled'}` — which
 * Mongo guarantees only one writer can win. The roster write and the losing guards' offers are
 * updated after the winner is already decided, so nothing depends on ordering.
 */

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const guardId = searchParams.get('guardId');
    if (!guardId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });

    await connectToDatabase();
    await expireStale(guardId);

    const offers = await GuardReplacementOffer.find({
      guardId,
      status: { $in: ['pending', 'accepted', 'lost'] },
    })
      .sort({ expiresAt: 1 })
      .limit(20)
      .lean();

    return NextResponse.json({ success: true, offers });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'offers failed' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const b = await req.json();
    const { guardId, offerId, response } = b as {
      guardId?: string;
      offerId?: string;
      response?: 'accept' | 'decline';
    };
    if (!guardId || !offerId || !response) {
      return NextResponse.json(
        { success: false, message: 'guardId, offerId and response are required' },
        { status: 400 }
      );
    }
    if (!mongoose.Types.ObjectId.isValid(offerId)) {
      return NextResponse.json({ success: false, message: 'invalid offerId' }, { status: 400 });
    }

    await connectToDatabase();

    const offer: any = await GuardReplacementOffer.findOne({ _id: offerId, guardId }).lean();
    if (!offer) return NextResponse.json({ success: false, message: 'offer not found' }, { status: 404 });

    if (offer.status !== 'pending') {
      // Re-sending a decision (an offline queue flushing twice) returns the settled outcome
      // rather than an error, so the app can simply show what happened.
      return NextResponse.json({ success: true, outcome: offer.status, alreadyResponded: true });
    }

    if (new Date(offer.expiresAt).getTime() < Date.now()) {
      await GuardReplacementOffer.updateOne({ _id: offerId }, { $set: { status: 'expired' } });
      return NextResponse.json({ success: true, outcome: 'expired' });
    }

    if (response === 'decline') {
      await GuardReplacementOffer.updateOne(
        { _id: offerId, status: 'pending' },
        { $set: { status: 'declined', respondedAt: new Date() } }
      );
      return NextResponse.json({ success: true, outcome: 'declined' });
    }

    // --- Accept: refuse a shift that clashes with one the guard already has (BR-001) ---
    const clash = await hasConflictingAssignment(guardId, offer);
    if (clash) {
      return NextResponse.json({
        success: true,
        outcome: 'conflict',
        message: 'You are already on duty at that time.',
      });
    }

    // --- The atomic claim. Exactly one request can move the vacancy out of `open`. ---
    const won: any = await GuardVacancy.findOneAndUpdate(
      { _id: offer.vacancyId, status: 'open', expiresAt: { $gt: new Date() } },
      { $set: { status: 'filled', filledBy: guardId, filledAt: new Date() } },
      { new: true }
    ).lean();

    if (!won) {
      // Someone else claimed it, or it was cancelled/expired between render and tap.
      await GuardReplacementOffer.updateOne(
        { _id: offerId, status: 'pending' },
        { $set: { status: 'lost', respondedAt: new Date() } }
      );
      const vacancy: any = await GuardVacancy.findById(offer.vacancyId).lean();
      return NextResponse.json({
        success: true,
        outcome: vacancy?.status === 'cancelled' ? 'cancelled' : 'taken',
      });
    }

    await GuardReplacementOffer.updateOne(
      { _id: offerId },
      { $set: { status: 'accepted', respondedAt: new Date() } }
    );

    // Everyone else's card closes.
    await GuardReplacementOffer.updateMany(
      { vacancyId: offer.vacancyId, status: 'pending', _id: { $ne: offerId } },
      { $set: { status: 'cancelled' } }
    ).catch(() => {});

    await addGuardToRoster(guardId, won);

    return NextResponse.json({
      success: true,
      outcome: 'accepted',
      rosterId: won.rosterId,
      siteName: won.siteName,
      shiftDate: won.shiftDate,
      timing: won.timing,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'response failed' }, { status: 500 });
  }
}

/** Close anything whose window has passed, so the app never renders a dead card. */
async function expireStale(guardId: string) {
  const now = new Date();
  await GuardReplacementOffer.updateMany(
    { guardId, status: 'pending', expiresAt: { $lt: now } },
    { $set: { status: 'expired' } }
  ).catch(() => {});
  await GuardVacancy.updateMany(
    { status: 'open', expiresAt: { $lt: now } },
    { $set: { status: 'expired' } }
  ).catch(() => {});
}

/**
 * BR-001: a guard cannot hold two overlapping assignments. Checked against the shift's real
 * window rather than its calendar date, so a 20:00–08:00 night shift correctly clashes with an
 * 06:00 start the next morning.
 */
async function hasConflictingAssignment(guardId: string, offer: any): Promise<boolean> {
  const date: string = offer.shiftDate;
  if (!date) return false;

  const offered = shiftWindow(date, offer.timing || '');
  const rosters: any[] = await AgencyRoster.find({
    date: { $in: [addDays(date, -1), date, addDays(date, 1)] },
    'assignedGuards.guardId': guardId,
  })
    .lean()
    .catch(() => []);

  return rosters.some((r) => {
    if (String(r._id) === String(offer.rosterId)) return false; // the vacancy's own row
    const w = shiftWindow(r.date, r.timing);
    return w.startAt < offered.endAt && offered.startAt < w.endAt;
  });
}

/** Put the winner on the roster row as a reliever, so the agency portal sees the fill. */
async function addGuardToRoster(guardId: string, vacancy: any) {
  if (!vacancy.rosterId || !mongoose.Types.ObjectId.isValid(vacancy.rosterId)) return;
  const guard: any = await APGuard.findById(guardId).lean().catch(() => null);
  if (!guard) return;

  const entry = {
    guardId: new mongoose.Types.ObjectId(guardId),
    guardName: guard.name,
    guardPhone: guard.phone,
    guardEmpId: guard.empId ?? guard.id ?? '',
    status: 'Scheduled',
    isReliever: true,
    replacedGuardName: vacancy.replacingGuardName ?? '',
    replacedGuardId: vacancy.replacingGuardId ?? '',
    replacementType: 'temporary',
    replacementReason: vacancy.reason ?? '',
  };

  // $addToSet on guardId would not work (the sub-documents differ), so guard the write with a
  // filter that only matches when this guard is not already on the row.
  await AgencyRoster.updateOne(
    { _id: vacancy.rosterId, 'assignedGuards.guardId': { $ne: new mongoose.Types.ObjectId(guardId) } },
    { $push: { assignedGuards: entry } }
  ).catch(() => {});
}
