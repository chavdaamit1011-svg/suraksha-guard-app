import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectToDatabase } from '@/lib/db';
import { APGuard } from '@/lib/models/APGuard';
import { AgencyRoster } from '@/lib/models/AgencyRoster';
import { GuardAttendance } from '@/lib/models/GuardAttendance';
import { GuardPayslip } from '@/lib/models/GuardPayslip';
import { Booking } from '@/lib/models/BookingState';
import { istDateKey, shiftWindow } from '@/lib/guardRoster';

export const dynamic = 'force-dynamic';

function parseWagePaise(wage: string | undefined): number {
  if (!wage) return 0;
  const digits = String(wage).replace(/[^\d.]/g, '');
  const rupees = Number(digits);
  return Number.isFinite(rupees) ? Math.round(rupees * 100) : 0;
}

function periodKey(d: Date = new Date()): string {
  return istDateKey(d).slice(0, 7);
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const guardId = searchParams.get('guardId');
    if (!guardId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });

    await connectToDatabase();

    const guardQuery = mongoose.Types.ObjectId.isValid(guardId)
      ? { $or: [{ _id: new mongoose.Types.ObjectId(guardId) }, { id: guardId }, { guardId }, { phone: guardId }] }
      : { $or: [{ id: guardId }, { guardId }, { phone: guardId }] };

    const guard: any = await APGuard.findOne(guardQuery).lean();
    if (!guard) {
      return NextResponse.json({ success: false, message: 'Guard not found' }, { status: 404 });
    }

    const guardIds = new Set<string>();
    if (guard._id) guardIds.add(String(guard._id));
    if (guard.id) guardIds.add(String(guard.id));
    if (guard.guardId) guardIds.add(String(guard.guardId));
    if (guard.phone) guardIds.add(String(guard.phone));
    guardIds.add(guardId);
    const guardIdList = Array.from(guardIds);

    const period = searchParams.get('period') || periodKey();

    // 1. Fetch completed & closed bookings from Client Portal orders
    const completedBookings: any[] = await Booking.find({
      $or: [
        { 'assignedGuard.guardId': { $in: guardIdList } },
        { 'assignedGuard.phone': guard.phone || guardId },
        { 'assignedGuard.name': guard.name },
      ],
      bookingStatus: { $in: ['COMPLETED', 'CLOSED'] },
    })
      .sort({ 'dutyDetails.dutyCompletedAt': -1, createdAt: -1 })
      .lean()
      .catch(() => []);

    // 2. Fetch formal Agency Payslips if any
    const formalPayslips: any[] = await GuardPayslip.find({
      guardId: { $in: guardIdList },
      status: { $ne: 'Draft' },
    })
      .sort({ period: -1 })
      .limit(12)
      .lean()
      .catch(() => []);

    // 3. Compute orders total earnings
    let totalOrderPayoutPaise = 0;
    const orderPayslips = completedBookings.map((b) => {
      const payout =
        b.settlement?.guardPayout ??
        Math.round((b.amount || b.settlement?.subtotal || 1000) * 0.7);
      const payoutPaise = Math.round(payout * 100);
      totalOrderPayoutPaise += payoutPaise;

      const completedAt = b.dutyDetails?.dutyCompletedAt || b.dutyDetails?.dutyEndedAt || b.updatedAt || b.createdAt;
      const dateStr = completedAt ? new Date(completedAt).toISOString().split('T')[0] : istDateKey();

      return {
        period: b.bookingId,
        bookingId: b.bookingId,
        serviceName: b.serviceName || 'Security Duty',
        siteName: b.location?.address || 'Client Location',
        status: 'Completed',
        daysPresent: 1,
        daysAbsent: 0,
        paidLeave: 0,
        otHours: 0,
        grossPaise: (b.settlement?.subtotal || b.amount || payout) * 100,
        deductionsPaise: 0,
        netPaise: payoutPaise,
        carriedForwardPaise: 0,
        paidOn: completedAt,
        referenceNo: b.invoiceNumber || `INV-${b.bookingId}`,
        clientRating: b.rating?.score,
        clientReview: b.rating?.review,
        date: dateStr,
        earnings: [
          { label: `${b.serviceName || 'Duty Payout'} (${b.bookingId})`, amountPaise: payoutPaise },
        ],
        deductions: [],
      };
    });

    // 4. Calculate ratings from completed bookings
    const rated = completedBookings.filter((b) => b.rating && typeof b.rating.score === 'number' && b.rating.score >= 1 && b.rating.score <= 5);
    const averageRating = rated.length > 0
      ? Math.round((rated.reduce((acc, b) => acc + b.rating.score, 0) / rated.length) * 10) / 10
      : 5.0;

    // 5. Calculate attendance estimate for active roster shifts
    const estimate = await estimateForPeriod(guardIdList, period, guard);

    // Combine order payslips and formal payslips
    const allPayslips = [...orderPayslips, ...formalPayslips.map(shapePayslip)];

    // Combined headline earnings in paise
    const totalHeadlinePaise = totalOrderPayoutPaise + (estimate?.grossPaise || 0);

    // Group earnings by period for history
    const historyMap = new Map<string, number>();
    for (const p of allPayslips) {
      const key = p.date ? p.date.slice(0, 7) : (p.period.includes('-') && p.period.length === 7 ? p.period : periodKey());
      historyMap.set(key, (historyMap.get(key) || 0) + (p.netPaise || 0));
    }
    const history = Array.from(historyMap.entries())
      .map(([per, netPaise]) => ({ period: per, netPaise }))
      .slice(0, 6)
      .reverse();

    return NextResponse.json({
      success: true,
      period,
      monthlyWagePaise: parseWagePaise(guard.wage) || totalHeadlinePaise,
      totalEarnedPaise: totalHeadlinePaise,
      completedOrdersCount: completedBookings.length,
      averageRating,
      estimate: {
        ...estimate,
        grossPaise: totalHeadlinePaise,
        basePaise: totalHeadlinePaise,
      },
      payslips: allPayslips,
      history,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'earnings failed' }, { status: 500 });
  }
}

function shapePayslip(p: any) {
  return {
    period: p.period,
    bookingId: p.bookingId || p.period,
    serviceName: 'Agency Contract Shift',
    siteName: p.siteName || 'Rostered Site',
    date: p.paidOn ? new Date(p.paidOn).toISOString().split('T')[0] : p.period,
    status: p.status,
    daysPresent: p.daysPresent,
    daysAbsent: p.daysAbsent,
    paidLeave: p.paidLeave,
    otHours: p.otHours,
    earnings: p.earnings ?? [],
    deductions: p.deductions ?? [],
    grossPaise: p.grossPaise,
    deductionsPaise: p.deductionsPaise,
    netPaise: Math.max(0, p.netPaise ?? 0),
    carriedForwardPaise: p.carriedForwardPaise ?? 0,
    paidOn: p.paidOn,
    referenceNo: p.referenceNo ?? '',
  };
}

async function estimateForPeriod(guardIds: string[], period: string, guard: any) {
  const monthlyPaise = parseWagePaise(guard.wage);

  const rosters: any[] = await AgencyRoster.find({
    date: { $regex: `^${period}` },
    'assignedGuards.guardId': { $in: guardIds },
  })
    .lean()
    .catch(() => []);

  const rosterIds = rosters.map((r) => String(r._id));
  const attendance: any[] = rosterIds.length
    ? await GuardAttendance.find({ guardId: { $in: guardIds }, rosterId: { $in: rosterIds } })
        .sort({ serverReceivedTime: 1 })
        .lean()
        .catch(() => [])
    : [];

  let daysPresent = 0;
  let daysAbsent = 0;
  let otMinutes = 0;
  let daysAwaitingReview = 0;

  const now = Date.now();

  for (const r of rosters) {
    const rosterId = String(r._id);
    const w = shiftWindow(r.date, r.timing);
    const inEvt = attendance.find((a) => a.rosterId === rosterId && a.eventType === 'check_in');
    const outEvt = attendance.find((a) => a.rosterId === rosterId && a.eventType === 'check_out');

    if (!inEvt) {
      if (w.endAt.getTime() < now) daysAbsent += 1;
      continue;
    }

    daysPresent += 1;
    if (inEvt.confidence !== 'high' && !inEvt.reviewDecision) daysAwaitingReview += 1;

    if (outEvt) {
      const out = new Date(outEvt.estimatedTrueTime ?? outEvt.serverReceivedTime).getTime();
      const over = Math.round((out - w.endAt.getTime()) / 60_000);
      if (over > 15) otMinutes += over;
    }
  }

  const perDayPaise = monthlyPaise > 0 ? Math.round(monthlyPaise / 26) : 0;
  const perHourPaise = perDayPaise > 0 ? Math.round(perDayPaise / 8) : 0;
  const otHours = Math.round((otMinutes / 60) * 10) / 10;
  const otPaise = Math.round(perHourPaise * otHours);
  const basePaise = perDayPaise * daysPresent;

  return {
    isEstimate: true,
    period,
    daysPresent,
    daysAbsent,
    daysScheduled: rosters.length,
    daysAwaitingReview,
    otHours,
    perDayPaise,
    basePaise,
    otPaise,
    grossPaise: basePaise + otPaise,
    deductionsKnown: false,
  };
}
