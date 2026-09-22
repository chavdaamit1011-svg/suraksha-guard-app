import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/db';
import { Activity } from '@/lib/models/Activity';
import { isAdminRequest } from '@/lib/guardSign';

export const dynamic = 'force-dynamic';

/**
 * Guard app release KPIs (PRD SUR-GAP-036 "two-tap check-in as a measured KPI").
 *
 *   GET ?days=7   (x-guard-admin-key)
 *
 * Reads the `checkin_taps` events the app sends. The target is a median of 2 taps
 * (CHECK IN on home, CONFIRM on the check-in screen).
 */
function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

export async function GET(req: Request) {
  try {
    if (!isAdminRequest(req)) return NextResponse.json({ success: false, message: 'unauthorised' }, { status: 401 });
    const days = Math.min(90, Math.max(1, Number(new URL(req.url).searchParams.get('days') ?? 7) || 7));
    await connectToDatabase();

    const rows: any[] = await Activity.find({
      event: 'checkin_taps',
      createdAt: { $gte: new Date(Date.now() - days * 86400_000) },
    })
      .select('metadata')
      .lean();

    const summarise = (list: any[]) => {
      const taps = list.map((r) => Number(r.metadata?.taps)).filter(Number.isFinite).sort((a, b) => a - b);
      const secs = list.map((r) => Number(r.metadata?.seconds)).filter(Number.isFinite).sort((a, b) => a - b);
      return {
        count: list.length,
        medianTaps: quantile(taps, 0.5),
        p90Taps: quantile(taps, 0.9),
        atTargetPct: taps.length ? Math.round((taps.filter((t) => t <= 2).length / taps.length) * 100) : null,
        medianSeconds: quantile(secs, 0.5),
        p90Seconds: quantile(secs, 0.9),
        autoCapturePct: list.length
          ? Math.round((list.filter((r) => r.metadata?.autoCapture).length / list.length) * 100)
          : null,
      };
    };

    const plain = rows.filter((r) => !r.metadata?.reasonRequired);
    return NextResponse.json({
      success: true,
      days,
      target: { medianTaps: 2 },
      all: summarise(rows),
      // The exception path (outside the site, leaving early) adds a reason tap by design.
      withoutReason: summarise(plain),
      checkIn: summarise(rows.filter((r) => r.metadata?.kind === 'in')),
      checkOut: summarise(rows.filter((r) => r.metadata?.kind === 'out')),
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'kpi failed' }, { status: 500 });
  }
}
