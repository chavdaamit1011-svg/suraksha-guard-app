import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/db';
import { GuardAttendance } from '@/lib/models/GuardAttendance';
import { GuardFieldEvent } from '@/lib/models/GuardFieldEvent';
import { istDateKey, shiftWindow } from '@/lib/guardRoster';
import { resolveSupervisorScope, scopedRosters, teamMemberState } from '@/lib/guardSupervisor';

export const dynamic = 'force-dynamic';

/**
 * The supervisor's "My team" tab (PRD 18.16, SUR-GAP-034).
 *
 * Two things in one round trip, because they are the two questions a field supervisor actually
 * has: **who is where right now**, and **what needs my approval**.
 *
 * The review queue is the part that matters operationally. Attendance and patrol events that
 * scored badly — out of the geofence, a location that could not be trusted, a tag keyed in by
 * hand — are recorded rather than rejected (PRD 18.5 §8), which only works if someone then looks
 * at them. This is where they surface, two taps from approve or reject.
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const guardId = searchParams.get('guardId');
    if (!guardId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });

    await connectToDatabase();
    const scope = await resolveSupervisorScope(guardId);
    if (!scope.isSupervisor) {
      // Not an error: a plain guard simply has no team tab.
      return NextResponse.json({ success: true, isSupervisor: false, team: [], reviewQueue: [] });
    }

    const dateKey = searchParams.get('date') || istDateKey();
    const rosters = await scopedRosters(scope, dateKey);
    const now = new Date();

    const rosterIds = rosters.map((r) => String(r._id));
    const attendance: any[] = rosterIds.length
      ? await GuardAttendance.find({ rosterId: { $in: rosterIds } })
          .sort({ serverReceivedTime: 1 })
          .lean()
          .catch(() => [])
      : [];

    const team: any[] = [];
    for (const roster of rosters) {
      const w = shiftWindow(roster.date, roster.timing);
      // Yesterday's rows are only included for shifts still running past midnight.
      if (roster.date !== dateKey && w.endAt < now) continue;

      for (const g of roster.assignedGuards ?? []) {
        const subjectId = String(g.guardId);
        const rosterId = String(roster._id);
        const inEvt = attendance.find(
          (a) => a.rosterId === rosterId && a.guardId === subjectId && a.eventType === 'check_in'
        );
        const outEvt = attendance.find(
          (a) => a.rosterId === rosterId && a.guardId === subjectId && a.eventType === 'check_out'
        );

        const checkedInAt = inEvt ? new Date(inEvt.estimatedTrueTime ?? inEvt.serverReceivedTime) : null;
        const checkedOutAt = outEvt ? new Date(outEvt.estimatedTrueTime ?? outEvt.serverReceivedTime) : null;

        team.push({
          guardId: subjectId,
          name: g.guardName ?? '',
          phone: g.guardPhone ?? '',
          rosterId,
          siteName: roster.siteName,
          shiftDate: roster.date,
          timing: roster.timing,
          start: w.start,
          end: w.end,
          startAt: w.startAt.toISOString(),
          endAt: w.endAt.toISOString(),
          state: teamMemberState({
            roster,
            checkedInAt,
            checkedOutAt,
            lateByMin: inEvt?.lateByMin ?? 0,
            now,
          }),
          checkedInAt: checkedInAt?.toISOString() ?? null,
          checkedOutAt: checkedOutAt?.toISOString() ?? null,
          lateByMin: inEvt?.lateByMin ?? 0,
          isReliever: !!g.isReliever,
          /** Set when this attendance was marked by a supervisor, not the guard (always flagged). */
          proxyBy: inEvt?.meta?.proxyBy ?? null,
          trustScore: inEvt?.eventTrustScore ?? null,
          needsReview: inEvt ? inEvt.confidence !== 'high' : false,
        });
      }
    }

    // Newest first: a supervisor works the top of this list.
    team.sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt));

    const reviewQueue = await buildReviewQueue(rosterIds);

    return NextResponse.json({
      success: true,
      isSupervisor: true,
      canVerify: scope.canVerify,
      canProxy: scope.canProxy,
      canBroadcast: scope.canBroadcast,
      date: dateKey,
      siteNames: scope.siteNames,
      team,
      reviewQueue,
      counts: {
        total: team.length,
        onDuty: team.filter((t) => t.state === 'On duty' || t.state === 'Late').length,
        absent: team.filter((t) => t.state === 'Absent').length,
        notCheckedIn: team.filter((t) => t.state === 'Not checked in').length,
        pendingReview: reviewQueue.length,
      },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'team failed' }, { status: 500 });
  }
}

/**
 * Everything flagged and not yet decided, across attendance and patrol. PRD 18.6 §16 is the
 * constraint that shapes this: a supervisor must be able to resolve each item in about two taps,
 * "otherwise supervisors will start disabling the controls".
 */
async function buildReviewQueue(rosterIds: string[]) {
  if (rosterIds.length === 0) return [];

  const [attendance, field] = await Promise.all([
    GuardAttendance.find({
      rosterId: { $in: rosterIds },
      confidence: { $in: ['low', 'review'] },
      reviewDecision: { $in: [null, ''] },
    })
      .sort({ serverReceivedTime: -1 })
      .limit(50)
      .lean()
      .catch(() => []),
    GuardFieldEvent.find({
      rosterId: { $in: rosterIds },
      kind: 'patrol_scan',
      status: { $in: ['unverified', 'manual'] },
      reviewDecision: { $in: [null, ''] },
    })
      .sort({ serverReceivedTime: -1 })
      .limit(50)
      .lean()
      .catch(() => []),
  ]);

  const items = [
    ...attendance.map((a: any) => ({
      itemId: a.clientEventUuid,
      kind: 'attendance' as const,
      eventType: a.eventType,
      guardId: a.guardId,
      rosterId: a.rosterId,
      siteName: a.siteName,
      at: a.estimatedTrueTime ?? a.serverReceivedTime,
      flags: a.reviewFlags ?? [],
      trustScore: a.eventTrustScore,
      distanceM: a.distanceM,
      geofenceResult: a.geofenceResult,
      outsideReason: a.outsideReason ?? '',
      mediaId: a.selfieMediaId ?? '',
    })),
    ...field.map((f: any) => ({
      itemId: f.clientEventUuid,
      kind: 'patrol' as const,
      eventType: 'patrol_scan',
      guardId: f.guardId,
      rosterId: f.rosterId,
      siteName: f.siteName,
      at: f.serverReceivedTime,
      flags: f.reviewFlags ?? [],
      trustScore: f.eventTrustScore,
      distanceM: f.distanceM,
      checkpointCode: f.checkpointCode,
      scanMethod: f.scanMethod,
      mediaId: (f.mediaIds ?? [])[0] ?? '',
    })),
  ];

  return items.sort((a, b) => Date.parse(String(b.at)) - Date.parse(String(a.at))).slice(0, 50);
}
