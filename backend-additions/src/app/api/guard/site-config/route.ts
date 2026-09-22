import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/db';
import Site from '@/lib/models/Site';
import { GuardSiteConfig } from '@/lib/models/GuardSiteConfig';

export const dynamic = 'force-dynamic';

/**
 * Guard-app site configuration (PRD 18.4 / 18.5 / 18.8) — the overlay that gives a Site its
 * reporting-point coordinates, duty windows, wake-check policy and briefing cards.
 *
 * This exists because without coordinates the geofence can never be evaluated: every check-in
 * lands as `geofence_result = unknown` and goes to supervisor verification. Populating a site's
 * lat/lng is the single highest-value piece of configuration in the whole guard stack.
 *
 * Access is gated by `x-guard-admin-key` against GUARD_ADMIN_KEY, because unlike every other
 * route here this one writes agency-wide operational policy rather than a guard's own data. If
 * GUARD_ADMIN_KEY is unset the route refuses writes outright rather than defaulting to open.
 */

function authorised(req: Request): boolean {
  const expected = process.env.GUARD_ADMIN_KEY;
  if (!expected) return false;
  const given = req.headers.get('x-guard-admin-key') ?? '';
  // Constant-length compare is overkill here, but the cost is nil.
  return given.length === expected.length && given === expected;
}

const WRITABLE = new Set([
  'siteId',
  'siteName',
  'agencyId',
  'lat',
  'lng',
  'geofenceRadiusM',
  'reportingPoint',
  'checkInWindowBeforeMin',
  'checkInWindowAfterMin',
  'lateGraceMin',
  'autoAbsentAfterMin',
  'checkOutEarlyAllowedMin',
  'autoCloseAfterMin',
  'wakeCheckEnabled',
  'wakeWindowStart',
  'wakeWindowEnd',
  'wakeIntervalMinMin',
  'wakeIntervalMaxMin',
  'wakeAckWindowSec',
  'wakeSelfieRequired',
  'patrolRoundIntervalMin',
  'patrolStrictOrder',
  'patrolScanRadiusM',
  'briefingCards',
  'uniformRequired',
  'equipmentRequired',
  'escalationContacts',
  'sirenEnabled',
  'sosSmsNumber',
]);

/** List configs, or fetch one by siteId / siteName. Also reports sites still missing coordinates. */
export async function GET(req: Request) {
  try {
    if (!authorised(req)) return NextResponse.json({ success: false, message: 'unauthorised' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const siteId = searchParams.get('siteId');
    const siteName = searchParams.get('siteName');
    const agencyId = searchParams.get('agencyId');

    await connectToDatabase();

    if (siteId || siteName) {
      const config = await GuardSiteConfig.findOne(
        siteId ? { siteId } : { siteName, ...(agencyId ? { agencyId } : {}) }
      ).lean();
      return NextResponse.json({ success: true, config: config ?? null });
    }

    const configs: any[] = await GuardSiteConfig.find(agencyId ? { agencyId } : {})
      .sort({ siteName: 1 })
      .lean();

    // Which sites have no usable coordinates yet — the actionable gap for whoever is onboarding.
    const sites: any[] = await Site.find(agencyId ? { agencyId } : {})
      .select('_id name agencyId geofenceRadius')
      .lean()
      .catch(() => []);
    const configured = new Set(
      configs
        .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng))
        .flatMap((c) => [String(c.siteId ?? ''), String(c.siteName ?? '').toLowerCase()])
    );
    const missingCoords = sites
      .filter((s) => !configured.has(String(s._id)) && !configured.has(String(s.name).toLowerCase()))
      .map((s) => ({ siteId: String(s._id), siteName: s.name, agencyId: s.agencyId }));

    return NextResponse.json({ success: true, configs, missingCoords });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'read failed' }, { status: 500 });
  }
}

/** Create or update one site's guard-app config. Upserts on siteId, else on agencyId+siteName. */
export async function POST(req: Request) {
  try {
    if (!authorised(req)) return NextResponse.json({ success: false, message: 'unauthorised' }, { status: 401 });

    const body = await req.json();
    const siteId: string = String(body.siteId ?? '');
    const siteName: string = String(body.siteName ?? '');
    if (!siteId && !siteName) {
      return NextResponse.json({ success: false, message: 'siteId or siteName required' }, { status: 400 });
    }

    await connectToDatabase();

    // Fill in the name/agency from the Site record when only an id was given, so lookups by
    // either key resolve later (the roster links by name, the portal by id).
    let agencyId: string = String(body.agencyId ?? '');
    let resolvedName = siteName;
    if (siteId) {
      const site: any = await Site.findById(siteId).lean().catch(() => null);
      if (site) {
        resolvedName = resolvedName || site.name;
        agencyId = agencyId || site.agencyId;
      }
    }

    const update: Record<string, any> = {};
    for (const [k, v] of Object.entries(body)) {
      if (WRITABLE.has(k) && v !== undefined) update[k] = v;
    }
    update.siteName = resolvedName;
    if (agencyId) update.agencyId = agencyId;
    if (siteId) update.siteId = siteId;

    if (update.lat !== undefined && !Number.isFinite(Number(update.lat))) {
      return NextResponse.json({ success: false, message: 'lat must be a number' }, { status: 400 });
    }
    if (update.lng !== undefined && !Number.isFinite(Number(update.lng))) {
      return NextResponse.json({ success: false, message: 'lng must be a number' }, { status: 400 });
    }
    if (update.lat !== undefined) update.lat = Number(update.lat);
    if (update.lng !== undefined) update.lng = Number(update.lng);

    // Bump the briefing version whenever the post orders change: guards on this site must
    // re-acknowledge at next check-in (PRD 18.4 §9).
    if (update.briefingCards) update.$inc = undefined;

    const filter = siteId ? { siteId } : { siteName: resolvedName, agencyId };
    const existing: any = await GuardSiteConfig.findOne(filter).lean();
    if (existing && update.briefingCards) {
      update.briefingVersion = (existing.briefingVersion ?? 1) + 1;
    }
    delete update.$inc;

    const config = await GuardSiteConfig.findOneAndUpdate(
      filter,
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    return NextResponse.json({ success: true, config });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'write failed' }, { status: 500 });
  }
}
