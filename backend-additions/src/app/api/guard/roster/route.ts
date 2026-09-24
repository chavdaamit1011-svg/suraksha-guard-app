import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectToDatabase } from '@/lib/db';
import { AgencyRoster } from '@/lib/models/AgencyRoster';
import { APGuard } from '@/lib/models/APGuard';
import { GuardAttendance } from '@/lib/models/GuardAttendance';
import { addDays, istDateKey, resolveSite, shiftWindow, type ResolvedSite } from '@/lib/guardRoster';

export const dynamic = 'force-dynamic';

/**
 * The guard's own roster (PRD 18.4 GAP-S-014) — a 7-day vertical list of day / site / shift
 * window / status, not a calendar grid, because a calendar is unreadable on a 720×1280 screen
 * held at a gate.
 *
 * `days` defaults to 7 forward from today; `from` lets the guard page backwards to see what they
 * actually worked. Yesterday is always included so a running night shift stays visible.
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const guardId = searchParams.get('guardId');
    if (!guardId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });

    await connectToDatabase();

    const guardOid = mongoose.Types.ObjectId.isValid(guardId) ? new mongoose.Types.ObjectId(guardId) : null;
    const guard = await APGuard.findOne({
      $or: [
        ...(guardOid ? [{ _id: guardOid }] : []),
        { id: guardId },
        { guardId: guardId },
        { phone: guardId },
      ]
    }).lean();

    const guardIdentifiers = [
      guardId,
      guard?._id?.toString(),
      guard?.id,
      guard?.guardId,
      guard?.phone,
    ].filter(Boolean);

    const today = istDateKey();
    const from = searchParams.get('from') || addDays(today, -1);
    const days = Math.min(Math.max(parseInt(searchParams.get('days') ?? '8', 10) || 8, 1), 31);
    const dateKeys = Array.from({ length: days }, (_, i) => addDays(from, i));

    const rosters: any[] = await AgencyRoster.find({
      date: { $in: dateKeys },
      'assignedGuards.guardId': { $in: guardIdentifiers },
    })
      .sort({ date: 1 })
      .lean()
      .catch(() => []);

    const rosterIds = rosters.map((r) => String(r._id));
    const attendance: any[] = rosterIds.length
      ? await GuardAttendance.find({ guardId, rosterId: { $in: rosterIds } })
          .sort({ serverReceivedTime: 1 })
          .lean()
          .catch(() => [])
      : [];

    const siteCache = new Map<string, ResolvedSite>();
    const siteFor = async (agencyId: string, siteName: string) => {
      const key = `${agencyId}::${siteName}`;
      if (!siteCache.has(key)) siteCache.set(key, await resolveSite(agencyId, siteName));
      return siteCache.get(key)!;
    };

    const now = Date.now();
    const shifts = [];
    for (const r of rosters) {
      const rosterId = String(r._id);
      const mine = (r.assignedGuards ?? []).find((g: any) => String(g.guardId) === guardId);
      const w = shiftWindow(r.date, r.timing);
      const resolved = await siteFor(r.agencyId ?? '', r.siteName);

      const inEvt = attendance.find((a) => a.rosterId === rosterId && a.eventType === 'check_in');
      const outEvt = attendance.find((a) => a.rosterId === rosterId && a.eventType === 'check_out');

      // The status chip the row shows. Past shifts with no check-in read Absent; future ones
      // simply read Scheduled — never "Absent" for a shift that has not happened yet.
      let status: string;
      if (outEvt) status = 'Completed';
      else if (inEvt) status = inEvt.lateByMin > 0 ? 'Late' : 'On duty';
      else if (w.endAt.getTime() < now) status = 'Absent';
      else status = 'Scheduled';

      shifts.push({
        rosterId,
        date: r.date,
        siteName: resolved.siteName || r.siteName,
        siteId: resolved.siteId,
        address: resolved.address,
        shiftType: r.shiftType ?? '',
        timing: r.timing ?? '',
        start: w.start,
        end: w.end,
        startAt: w.startAt.toISOString(),
        endAt: w.endAt.toISOString(),
        crossesMidnight: w.crossesMidnight,
        durationMin: w.durationMin,
        status,
        rosterStatus: mine?.status ?? 'Scheduled',
        isReliever: !!mine?.isReliever,
        replacedGuardName: mine?.replacedGuardName ?? '',
        checkedInAt: inEvt ? (inEvt.estimatedTrueTime ?? inEvt.serverReceivedTime) : null,
        checkedOutAt: outEvt ? (outEvt.estimatedTrueTime ?? outEvt.serverReceivedTime) : null,
        lateByMin: inEvt?.lateByMin ?? 0,
      });
    }

    return NextResponse.json({ success: true, from, days, today, shifts });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'roster failed' }, { status: 500 });
  }
}
