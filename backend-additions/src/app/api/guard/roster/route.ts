import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectToDatabase } from '@/lib/db';
import { APGuard } from '@/lib/models/APGuard';
import { AgencyRoster } from '@/lib/models/AgencyRoster';
import { GuardAttendance } from '@/lib/models/GuardAttendance';
import { Booking } from '@/lib/models/BookingState';
import { addDays, istDateKey, resolveSite, shiftWindow, type ResolvedSite } from '@/lib/guardRoster';

export const dynamic = 'force-dynamic';

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

    const guardIds = new Set<string>();
    if (guard) {
      if (guard._id) guardIds.add(String(guard._id));
      if (guard.id) guardIds.add(String(guard.id));
      if (guard.guardId) guardIds.add(String(guard.guardId));
      if (guard.phone) guardIds.add(String(guard.phone));
    }
    guardIds.add(guardId);
    const guardIdList = Array.from(guardIds);

    const today = istDateKey();
    const from = searchParams.get('from') || addDays(today, -30);
    const days = Math.min(Math.max(parseInt(searchParams.get('days') ?? '60', 10) || 60, 1), 90);
    const dateKeys = Array.from({ length: days }, (_, i) => addDays(from, i));

    // 1. Fetch agency rosters
    const rosters: any[] = await AgencyRoster.find({
      date: { $in: dateKeys },
      'assignedGuards.guardId': { $in: guardIdList },
    })
      .sort({ date: -1 })
      .lean()
      .catch(() => []);

    const rosterIds = rosters.map((r) => String(r._id));
    const attendance: any[] = rosterIds.length
      ? await GuardAttendance.find({ guardId: { $in: guardIdList }, rosterId: { $in: rosterIds } })
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
    const shifts: any[] = [];

    // Map agency rosters
    for (const r of rosters) {
      const rosterId = String(r._id);
      const mine = (r.assignedGuards ?? []).find((g: any) => guardIdList.includes(String(g.guardId)));
      const w = shiftWindow(r.date, r.timing);
      const resolved = await siteFor(r.agencyId ?? '', r.siteName);

      const inEvt = attendance.find((a) => a.rosterId === rosterId && a.eventType === 'check_in');
      const outEvt = attendance.find((a) => a.rosterId === rosterId && a.eventType === 'check_out');

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
        shiftType: r.shiftType ?? 'Contract Shift',
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
        payout: 600,
        checkedInAt: inEvt ? (inEvt.estimatedTrueTime ?? inEvt.serverReceivedTime) : null,
        checkedOutAt: outEvt ? (outEvt.estimatedTrueTime ?? outEvt.serverReceivedTime) : null,
        lateByMin: inEvt?.lateByMin ?? 0,
      });
    }

    // 2. Fetch all orders from Client Portal (Booking collection)
    const bookings: any[] = await Booking.find({
      $or: [
        { 'assignedGuard.guardId': { $in: guardIdList } },
        { 'assignedGuard.phone': guard?.phone || guardId },
        ...(guard?.name ? [{ 'assignedGuard.name': guard.name }] : []),
      ],
      bookingStatus: { $in: ['ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'ACTIVE', 'CHECKOUT_INITIATED', 'COMPLETED', 'CLOSED'] },
    })
      .sort({ createdAt: -1 })
      .lean()
      .catch(() => []);

    for (const b of bookings) {
      const isDone = b.bookingStatus === 'COMPLETED' || b.bookingStatus === 'CLOSED';
      const isActive = b.bookingStatus === 'ACTIVE' || b.bookingStatus === 'CHECKOUT_INITIATED';
      const status = isDone ? 'Completed' : isActive ? 'On duty' : 'Scheduled';

      const bookingDate = b.createdAt ? new Date(b.createdAt).toISOString().split('T')[0] : today;
      const started = b.dutyDetails?.dutyStartedAt ? new Date(b.dutyDetails.dutyStartedAt) : null;
      const ended = b.dutyDetails?.dutyCompletedAt || b.dutyDetails?.dutyEndedAt ? new Date(b.dutyDetails?.dutyCompletedAt || b.dutyDetails?.dutyEndedAt) : null;

      const payout =
        b.settlement?.guardPayout ??
        Math.round((b.amount || b.settlement?.subtotal || 1000) * 0.7);

      shifts.push({
        rosterId: b.bookingId,
        bookingId: b.bookingId,
        date: bookingDate,
        siteName: b.location?.address || b.serviceName || 'Client Order Duty',
        siteId: b.bookingId,
        address: b.location?.address || '',
        shiftType: b.serviceName || 'On-Demand Duty',
        timing: b.schedule?.type || 'Standard',
        start: started ? started.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '09:00',
        end: ended ? ended.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '18:00',
        startAt: started ? started.toISOString() : new Date(b.createdAt).toISOString(),
        endAt: ended ? ended.toISOString() : new Date(b.createdAt).toISOString(),
        crossesMidnight: false,
        durationMin: started && ended ? Math.round((ended.getTime() - started.getTime()) / 60000) : 480,
        status,
        rosterStatus: status,
        isReliever: false,
        payout,
        clientRating: b.rating?.score,
        clientReview: b.rating?.review,
        checkedInAt: started,
        checkedOutAt: ended,
        lateByMin: 0,
        customerName: b.customerName || '',
        customerPhone: b.customerPhone || '',
        serviceRequirements: b.serviceRequirements || {},
        eventType: b.serviceRequirements?.eventType || '',
        dressRequirement: b.serviceRequirements?.dressRequirement || '',
        specialInstructions: b.serviceRequirements?.specialInstructions || b.specialInstructions || '',
      });
    }

    // Sort: active duties first, then upcoming scheduled, then newest completed
    const priorityOrder: Record<string, number> = { 'On duty': 0, Scheduled: 1, Completed: 2, Absent: 3, Late: 0 };
    shifts.sort((a, b) => {
      const pDiff = (priorityOrder[a.status] ?? 2) - (priorityOrder[b.status] ?? 2);
      if (pDiff !== 0) return pDiff;
      return new Date(b.date || b.startAt).getTime() - new Date(a.date || a.startAt).getTime();
    });

    // Summary calculations
    const completedOrders = shifts.filter((s) => s.status === 'Completed');
    const totalEarned = completedOrders.reduce((sum, s) => sum + (s.payout || 0), 0);
    const rated = completedOrders.filter((s) => typeof s.clientRating === 'number' && s.clientRating >= 1 && s.clientRating <= 5);
    const averageRating = rated.length > 0
      ? Math.round((rated.reduce((sum, s) => sum + s.clientRating, 0) / rated.length) * 10) / 10
      : 5.0;

    return NextResponse.json({
      success: true,
      from,
      days,
      today,
      shifts,
      completedOrdersCount: completedOrders.length,
      totalEarned,
      averageRating,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'roster failed' }, { status: 500 });
  }
}
