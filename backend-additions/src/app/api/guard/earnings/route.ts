import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectToDatabase } from '@/lib/db';
import { APGuard } from '@/lib/models/APGuard';
import { AgencyRoster } from '@/lib/models/AgencyRoster';
import { GuardAttendance } from '@/lib/models/GuardAttendance';
import { GuardPayslip } from '@/lib/models/GuardPayslip';
import { istDateKey, shiftWindow } from '@/lib/guardRoster';

export const dynamic = 'force-dynamic';

/**
 * Earnings and payslips (PRD 18.13, SUR-GAP-023).
 *
 * The one rule that governs the whole screen (18.13 §9):
 *
 *   > The in-month number is explicitly labelled **"Estimated"** until the payroll run is
 *   > finalised, because attendance corrections change it; showing an authoritative number that
 *   > later drops is the fastest way to destroy trust.
 *
 * So this returns two distinct things and never blurs them: an `estimate` the app computes from
 * attendance, clearly marked as such, and `payslips` that the agency's payroll run finalised.
 *
 * Strictly self-scoped — no supervisor sees another guard's pay in this app (18.13 §3).
 */

/** "₹16,500" / "16500" / "₹16,500 per month" → paise. Agencies store wage as free text. */
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
    if (!mongoose.Types.ObjectId.isValid(guardId)) {
      return NextResponse.json({ success: false, message: 'Invalid guardId' }, { status: 400 });
    }

    await connectToDatabase();
    const guard: any = await APGuard.findById(guardId).lean();
    if (!guard) return NextResponse.json({ success: false, message: 'Guard not found' }, { status: 404 });

    const period = searchParams.get('period') || periodKey();

    const [payslips, estimate] = await Promise.all([
      GuardPayslip.find({ guardId, status: { $ne: 'Draft' } })
        .sort({ period: -1 })
        .limit(12)
        .lean()
        .catch(() => []),
      estimateForPeriod(guardId, period, guard),
    ]);

    // A finalised payslip for the current period supersedes the estimate entirely.
    const finalised = payslips.find((p: any) => p.period === period);

    return NextResponse.json({
      success: true,
      period,
      monthlyWagePaise: parseWagePaise(guard.wage),
      /** Null once payroll has finalised the period — the app then shows the real number. */
      estimate: finalised ? null : estimate,
      payslips: payslips.map(shapePayslip),
      /** Six months of net pay for the little bar row on the earnings home. */
      history: payslips
        .filter((p: any) => p.status === 'Completed' || p.status === 'Pending')
        .slice(0, 6)
        .map((p: any) => ({ period: p.period, netPaise: p.netPaise }))
        .reverse(),
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'earnings failed' }, { status: 500 });
  }
}

function shapePayslip(p: any) {
  return {
    period: p.period,
    status: p.status,
    daysPresent: p.daysPresent,
    daysAbsent: p.daysAbsent,
    paidLeave: p.paidLeave,
    otHours: p.otHours,
    earnings: p.earnings ?? [],
    deductions: p.deductions ?? [],
    grossPaise: p.grossPaise,
    deductionsPaise: p.deductionsPaise,
    // Never show a negative net: an advance larger than the month's earnings is carried
    // forward instead (PRD 18.13 §16).
    netPaise: Math.max(0, p.netPaise ?? 0),
    carriedForwardPaise: p.carriedForwardPaise ?? 0,
    paidOn: p.paidOn,
    referenceNo: p.referenceNo ?? '',
  };
}

/**
 * The month-to-date estimate, computed from what the guard has actually been recorded doing.
 *
 * Deliberately conservative: only shifts the guard *checked into* count, and overtime is only
 * counted where the check-out is later than the rostered end. A number that creeps up as the
 * month goes on is trusted; one that drops is not.
 */
async function estimateForPeriod(guardId: string, period: string, guard: any) {
  const monthlyPaise = parseWagePaise(guard.wage);

  const rosters: any[] = await AgencyRoster.find({
    date: { $regex: `^${period}` },
    'assignedGuards.guardId': guardId,
  })
    .lean()
    .catch(() => []);

  const rosterIds = rosters.map((r) => String(r._id));
  const attendance: any[] = rosterIds.length
    ? await GuardAttendance.find({ guardId, rosterId: { $in: rosterIds } })
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
      // A shift that has not happened yet is neither present nor absent.
      if (w.endAt.getTime() < now) daysAbsent += 1;
      continue;
    }

    daysPresent += 1;
    // An event a supervisor has not yet accepted is counted, but flagged, so the guard can see
    // why the number might move (PRD 18.6 §10: excluded from automatic payroll credit until
    // resolved — the app says so rather than quietly omitting it).
    if (inEvt.confidence !== 'high' && !inEvt.reviewDecision) daysAwaitingReview += 1;

    if (outEvt) {
      const out = new Date(outEvt.estimatedTrueTime ?? outEvt.serverReceivedTime).getTime();
      const over = Math.round((out - w.endAt.getTime()) / 60_000);
      // Fifteen minutes of slack: a guard who hands over a few minutes late is not on overtime.
      if (over > 15) otMinutes += over;
    }
  }

  // Per-day rate from the monthly wage. Agencies differ on the divisor (26 vs 30); 26 is the
  // common convention for this workforce and is the figure the PRD's worked examples assume.
  const perDayPaise = monthlyPaise > 0 ? Math.round(monthlyPaise / 26) : 0;
  const perHourPaise = perDayPaise > 0 ? Math.round(perDayPaise / 8) : 0;
  const otHours = Math.round((otMinutes / 60) * 10) / 10;
  const otPaise = Math.round(perHourPaise * otHours);
  const basePaise = perDayPaise * daysPresent;

  return {
    /** Always true for this object. The app must render the word "Estimated" beside it. */
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
    /** Deductions are a payroll matter; the estimate never guesses at them. */
    deductionsKnown: false,
  };
}
