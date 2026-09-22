import mongoose from 'mongoose';
import { AgencyRoster } from '@/lib/models/AgencyRoster';
import { APGuard } from '@/lib/models/APGuard';
import { GuardMedia } from '@/lib/models/GuardMedia';
import { Incident } from '@/lib/models/Incident';

/**
 * Guard incident reports (PRD 18.10, SUR-GAP-019), shared by the online route and the offline
 * sync so both write the same record.
 *
 * They go into the platform's existing `Incident` collection, which is what the agency portal and
 * Ops read. Two things about that collection shape this code:
 *
 *  - The portal only lists incidents whose `agencyOwnerId` matches the agency ("older unscoped
 *    records intentionally do not appear"). A guard report written without it is invisible to the
 *    agency, so it is set from the guard's record.
 *  - The schema is strict and has no fields for priority, location, media or the injury/police
 *    answers. Those are written with `strict: false` so they are kept (the Command Center and the
 *    guard's own history read them) without changing a model this project does not own.
 */

export const SEVERITY: Record<string, { label: string; priority: string; sosClass: boolean }> = {
  low: { label: 'Low', priority: 'P3', sosClass: false },
  serious: { label: 'High', priority: 'P1', sosClass: false },
  emergency: { label: 'Critical', priority: 'P0', sosClass: true },
  // Older clients.
  medium: { label: 'Medium', priority: 'P2', sosClass: false },
  high: { label: 'High', priority: 'P1', sosClass: false },
  critical: { label: 'Critical', priority: 'P0', sosClass: true },
};

export const TYPES: Record<string, string> = {
  theft: 'Theft',
  trespass: 'Trespass',
  assault: 'Fight / Assault',
  fire: 'Fire',
  medical: 'Medical',
  damage: 'Property damage',
  vehicle: 'Vehicle',
  suspicious: 'Suspicious activity',
  other: 'Other',
};

export type IncidentInput = {
  guardId: string;
  key: string;
  type?: string;
  severity?: string;
  description?: string;
  mediaIds?: string[];
  thumbnailMediaId?: string;
  bookingId?: string;
  rosterId?: string;
  siteId?: string;
  siteName?: string;
  lat?: number;
  lng?: number;
  occurredAt?: string;
  injuries?: boolean;
  policeInformed?: boolean;
  witnesses?: string;
};

export type IncidentResult = {
  duplicate: boolean;
  incidentId: string;
  priority: string;
  severity: string;
  escalated: boolean;
};

export async function recordIncident(b: IncidentInput): Promise<IncidentResult> {
  const key = b.key;
  const sev = SEVERITY[String(b.severity ?? 'serious').toLowerCase()] ?? SEVERITY.serious;
  const category = TYPES[String(b.type ?? 'other')] ?? 'Guard report';
  const description = String(b.description ?? '').trim();
  const incidentId = `GINC-${key.slice(0, 8)}`;

  const guard: any = mongoose.Types.ObjectId.isValid(b.guardId)
    ? await APGuard.findById(b.guardId).select('name phone agencyId').lean().catch(() => null)
    : null;

  // Site name: what the app knew, else the roster row's.
  let siteName = String(b.siteName ?? '').trim();
  if (!siteName && b.rosterId && mongoose.Types.ObjectId.isValid(b.rosterId)) {
    const roster: any = await AgencyRoster.findById(b.rosterId).select('siteName').lean().catch(() => null);
    siteName = roster?.siteName ?? '';
  }

  // Media uploaded before this record arrived (normal on a good connection) is picked up here;
  // media arriving later is appended by the media route.
  const early: any[] = await GuardMedia.find({ clientEventUuid: key, guardId: b.guardId })
    .select('mediaId')
    .lean()
    .catch(() => []);
  const mediaIds = [...new Set([...(b.mediaIds ?? []), ...early.map((m) => m.mediaId)])];

  const title = description
    ? `${category}: ${description.slice(0, 48)}`
    : `${category}: voice report from ${guard?.name ?? 'a guard'}`;

  const res = await Incident.updateOne(
    { bookingIncidentKey: key },
    {
      $setOnInsert: {
        incidentId,
        bookingIncidentKey: key,
        agencyOwnerId: String(guard?.agencyId ?? ''),
        title,
        category,
        site: siteName || 'Agency level',
        severity: sev.label,
        status: 'Open',
        reportedBy: b.guardId,
        description: description || '(voice / photo report — see attachments)',
        bookingId: b.bookingId ?? '',
        reports: [
          {
            reporterRole: 'Guard',
            reporterName: guard?.name ?? b.guardId,
            description: description || '(voice / photo report)',
          },
        ],
        // Not in the portal's schema — kept with strict:false.
        priority: sev.priority,
        reporterPhone: guard?.phone ?? '',
        rosterId: b.rosterId ?? '',
        siteId: b.siteId ?? '',
        siteName,
        lat: b.lat,
        lng: b.lng,
        occurredAt: b.occurredAt ? new Date(b.occurredAt) : new Date(),
        serverReceivedTime: new Date(),
        thumbnailMediaId: b.thumbnailMediaId ?? '',
        injuriesFlag: !!b.injuries,
        policeInformedFlag: !!b.policeInformed,
        witnessesText: String(b.witnesses ?? ''),
        source: 'guard_app',
      },
    },
    { upsert: true, strict: false }
  );
  const duplicate = (res as any).upsertedCount === 0;

  if (mediaIds.length) {
    await Incident.updateOne({ bookingIncidentKey: key }, { $addToSet: { mediaIds: { $each: mediaIds } } }, { strict: false }).catch(
      () => {}
    );
    await GuardMedia.updateMany({ mediaId: { $in: mediaIds }, clientEventUuid: '' }, { $set: { clientEventUuid: key } }).catch(
      () => {}
    );
  }

  // An Emergency cannot wait for someone to refresh a list.
  if (!duplicate) {
    try {
      (globalThis as any).__io?.emit?.('new-notification', {
        kind: sev.sosClass ? 'INCIDENT_EMERGENCY' : 'INCIDENT',
        incidentKey: key,
        incidentId,
        priority: sev.priority,
        category,
        agencyId: String(guard?.agencyId ?? ''),
        guardId: b.guardId,
        guardName: guard?.name,
        siteName,
        lat: b.lat,
        lng: b.lng,
        thumbnailMediaId: b.thumbnailMediaId ?? '',
        injuries: !!b.injuries,
        at: new Date().toISOString(),
      });
    } catch {
      /* the socket server may not be attached in this process */
    }
  }

  return { duplicate, incidentId, priority: sev.priority, severity: sev.label, escalated: sev.sosClass };
}

/** Called by the media route when an upload names an incident's key. */
export async function attachMediaToIncident(key: string, mediaId: string) {
  await Incident.updateOne({ bookingIncidentKey: key }, { $addToSet: { mediaIds: mediaId } }, { strict: false }).catch(() => {});
}
