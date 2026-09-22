import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectToDatabase } from '@/lib/db';
import { AgencyRoster } from '@/lib/models/AgencyRoster';
import { APGuard } from '@/lib/models/APGuard';
import { GuardReplacementOffer, GuardVacancy } from '@/lib/models/GuardReplacement';
import { haversineM, resolveSite, shiftWindow, addDays } from '@/lib/guardRoster';

export const dynamic = 'force-dynamic';

/**
 * Replacement dispatch — the agency's side (PRD 18.12 §9).
 *
 * Opens a vacancy on a roster row and offers it in **waves**: nearest and best-matched first,
 * each wave open for a configured number of minutes, widening if nobody takes it. This is the
 * engine's entry point; the guard-facing accept/decline lives in `../route.ts`.
 *
 * Admin-key gated, because it writes agency-wide operational state rather than a guard's own data.
 *
 *   POST  { rosterId, replacingGuardId?, reason?, incentivePaise?, waveMinutes?, waveSize?, wave? }
 *   GET   ?rosterId=  |  ?agencyId=      inspect vacancies and who has been offered what
 */

function authorised(req: Request): boolean {
  const expected = process.env.GUARD_ADMIN_KEY;
  if (!expected) return false;
  const given = req.headers.get('x-guard-admin-key') ?? '';
  return given.length === expected.length && given === expected;
}

const DEFAULT_WAVE_MINUTES = 10;
const DEFAULT_WAVE_SIZE = 5;
/** Wave 1 stays close; each later wave reaches further out. */
const WAVE_RADIUS_KM = [8, 20, 50, 200];

export async function POST(req: Request) {
  try {
    if (!authorised(req)) return NextResponse.json({ success: false, message: 'unauthorised' }, { status: 401 });

    const b = await req.json();
    const rosterId: string = String(b.rosterId ?? '');
    if (!rosterId || !mongoose.Types.ObjectId.isValid(rosterId)) {
      return NextResponse.json({ success: false, message: 'valid rosterId required' }, { status: 400 });
    }

    await connectToDatabase();

    const roster: any = await AgencyRoster.findById(rosterId).lean();
    if (!roster) return NextResponse.json({ success: false, message: 'roster row not found' }, { status: 404 });

    const wave = Math.max(1, Number(b.wave ?? 1));
    const waveMinutes = Number(b.waveMinutes ?? DEFAULT_WAVE_MINUTES);
    const waveSize = Number(b.waveSize ?? DEFAULT_WAVE_SIZE);
    const expiresAt = new Date(Date.now() + waveMinutes * 60_000);

    const resolved = await resolveSite(roster.agencyId ?? '', roster.siteName);
    const window = shiftWindow(roster.date, roster.timing);

    const replacing = (roster.assignedGuards ?? []).find(
      (g: any) => String(g.guardId) === String(b.replacingGuardId ?? '')
    );

    // One open vacancy per roster row: re-dispatching a later wave reuses it rather than
    // creating a competing one.
    let vacancy: any = await GuardVacancy.findOne({ rosterId, status: 'open' }).lean();
    if (!vacancy) {
      vacancy = (
        await GuardVacancy.create({
          agencyId: roster.agencyId ?? '',
          rosterId,
          shiftDate: roster.date,
          siteId: resolved.siteId,
          siteName: resolved.siteName || roster.siteName,
          timing: roster.timing,
          shiftType: roster.shiftType ?? '',
          replacingGuardId: String(b.replacingGuardId ?? ''),
          replacingGuardName: replacing?.guardName ?? '',
          reason: String(b.reason ?? 'leave'),
          incentivePaise: Number(b.incentivePaise ?? 0),
          status: 'open',
          wave,
          expiresAt,
        })
      ).toObject();
    } else {
      await GuardVacancy.updateOne({ _id: vacancy._id }, { $set: { wave, expiresAt } });
    }

    const candidates = await pickCandidates({
      agencyId: roster.agencyId ?? '',
      excludeGuardIds: [
        ...(roster.assignedGuards ?? []).map((g: any) => String(g.guardId)),
        String(b.replacingGuardId ?? ''),
      ],
      vacancyId: String(vacancy._id),
      siteLat: resolved.lat,
      siteLng: resolved.lng,
      radiusKm: WAVE_RADIUS_KM[Math.min(wave - 1, WAVE_RADIUS_KM.length - 1)],
      limit: waveSize,
      shiftDate: roster.date,
      window,
    });

    const docs = candidates.map((c) => ({
      vacancyId: String(vacancy._id),
      guardId: c.guardId,
      siteName: vacancy.siteName,
      siteId: vacancy.siteId,
      shiftDate: vacancy.shiftDate,
      timing: vacancy.timing,
      shiftType: vacancy.shiftType,
      incentivePaise: vacancy.incentivePaise,
      distanceKm: c.distanceKm,
      wave,
      expiresAt,
      status: 'pending',
      notifiedAt: new Date(),
    }));

    // ordered:false so one duplicate (a guard already offered in an earlier wave) does not stop
    // the rest of the wave going out.
    if (docs.length) await GuardReplacementOffer.insertMany(docs, { ordered: false }).catch(() => {});

    try {
      (globalThis as any).__io?.emit?.('new-notification', {
        kind: 'REPLACEMENT_OFFER',
        vacancyId: String(vacancy._id),
        siteName: vacancy.siteName,
        shiftDate: vacancy.shiftDate,
        timing: vacancy.timing,
        guardIds: docs.map((d) => d.guardId),
        expiresAt,
      });
    } catch {
      /* socket server not attached in this process */
    }

    return NextResponse.json({
      success: true,
      vacancyId: String(vacancy._id),
      wave,
      expiresAt,
      offered: docs.length,
      guardIds: docs.map((d) => d.guardId),
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'dispatch failed' }, { status: 500 });
  }
}

/**
 * Rank candidates: available first, then nearest. "Available" means not already rostered onto an
 * overlapping shift — offering a guard a shift they cannot take wastes a wave.
 */
async function pickCandidates(args: {
  agencyId: string;
  excludeGuardIds: string[];
  vacancyId: string;
  siteLat: number | null;
  siteLng: number | null;
  radiusKm: number;
  limit: number;
  shiftDate: string;
  window: ReturnType<typeof shiftWindow>;
}) {
  const exclude = new Set(args.excludeGuardIds.filter(Boolean));

  // Guards already offered this vacancy in an earlier wave are not offered it twice.
  const already: any[] = await GuardReplacementOffer.find({ vacancyId: args.vacancyId })
    .select('guardId')
    .lean()
    .catch(() => []);
  already.forEach((o) => exclude.add(String(o.guardId)));

  const pool: any[] = await APGuard.find({
    ...(args.agencyId ? { agencyId: args.agencyId } : {}),
    status: { $ne: 'Archived' },
  })
    .select('_id name lat lng city')
    .limit(500)
    .lean()
    .catch(() => []);

  // Everyone rostered anywhere near this shift is unavailable.
  const nearbyRosters: any[] = await AgencyRoster.find({
    date: { $in: [addDays(args.shiftDate, -1), args.shiftDate, addDays(args.shiftDate, 1)] },
  })
    .lean()
    .catch(() => []);

  const busy = new Set<string>();
  for (const r of nearbyRosters) {
    const w = shiftWindow(r.date, r.timing);
    const overlaps = w.startAt < args.window.endAt && args.window.startAt < w.endAt;
    if (!overlaps) continue;
    for (const g of r.assignedGuards ?? []) busy.add(String(g.guardId));
  }

  const geoKnown = args.siteLat !== null && args.siteLng !== null;

  return pool
    .filter((g) => !exclude.has(String(g._id)) && !busy.has(String(g._id)))
    .map((g) => {
      const hasFix = Number.isFinite(g.lat) && Number.isFinite(g.lng) && (g.lat !== 0 || g.lng !== 0);
      const distanceKm =
        geoKnown && hasFix
          ? Math.round((haversineM(g.lat, g.lng, args.siteLat as number, args.siteLng as number) / 1000) * 10) / 10
          : null;
      return { guardId: String(g._id), name: g.name, distanceKm };
    })
    // A guard with no known position is still offered — better a slightly worse match than an
    // unfilled post — but ranked behind everyone we can actually measure.
    .filter((c) => c.distanceKm === null || c.distanceKm <= args.radiusKm)
    .sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9))
    .slice(0, args.limit);
}

export async function GET(req: Request) {
  try {
    if (!authorised(req)) return NextResponse.json({ success: false, message: 'unauthorised' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const rosterId = searchParams.get('rosterId');
    const agencyId = searchParams.get('agencyId');

    await connectToDatabase();
    const filter = rosterId ? { rosterId } : agencyId ? { agencyId } : {};
    const vacancies: any[] = await GuardVacancy.find(filter).sort({ createdAt: -1 }).limit(50).lean();
    const offers: any[] = await GuardReplacementOffer.find({
      vacancyId: { $in: vacancies.map((v) => String(v._id)) },
    })
      .lean()
      .catch(() => []);

    return NextResponse.json({
      success: true,
      vacancies: vacancies.map((v) => ({
        ...v,
        offers: offers.filter((o) => o.vacancyId === String(v._id)),
      })),
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'read failed' }, { status: 500 });
  }
}

/** Cancel an open vacancy (the original guard turned up after all). */
export async function DELETE(req: Request) {
  try {
    if (!authorised(req)) return NextResponse.json({ success: false, message: 'unauthorised' }, { status: 401 });
    const { searchParams } = new URL(req.url);
    const vacancyId = searchParams.get('vacancyId');
    if (!vacancyId) return NextResponse.json({ success: false, message: 'vacancyId required' }, { status: 400 });

    await connectToDatabase();
    await GuardVacancy.updateOne({ _id: vacancyId, status: 'open' }, { $set: { status: 'cancelled' } });
    await GuardReplacementOffer.updateMany(
      { vacancyId, status: 'pending' },
      { $set: { status: 'cancelled' } }
    );
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'cancel failed' }, { status: 500 });
  }
}
