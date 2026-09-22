import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectToDatabase } from '@/lib/db';
import { APGuard } from '@/lib/models/APGuard';
import { GuardMedia } from '@/lib/models/GuardMedia';
import { SupportTicket } from '@/lib/models/SupportTicket';
import { publicOrigin, signLink } from '@/lib/guardSign';

export const dynamic = 'force-dynamic';

/**
 * Guard support tickets (PRD 18.14, SUR-GAP-027).
 *
 * Written into the platform's existing `SupportTicket` collection, so a guard's ticket appears in
 * the same Ops and agency queues as every other ticket — no new inbox for anyone to forget.
 *
 *   POST  { guardId, clientEventUuid, category, message?, mediaIds?, period? }
 *   GET   ?guardId=     the guard's own tickets, with replies
 *
 * A voice note is the normal case (PRD: "voice-note ticket creation"), so `message` is optional;
 * the ticket text then carries signed links an ops user can open to play it.
 */

const CATEGORIES: Record<string, { label: string; priority: string }> = {
  pay: { label: 'Guard App — Pay / payslip', priority: 'High' },
  attendance: { label: 'Guard App — Attendance', priority: 'Medium' },
  leave: { label: 'Guard App — Leave', priority: 'Medium' },
  uniform: { label: 'Guard App — Uniform / equipment', priority: 'Low' },
  app: { label: 'Guard App — App problem', priority: 'Medium' },
  safety: { label: 'Guard App — Safety / harassment', priority: 'Urgent' },
  other: { label: 'Guard App — Other', priority: 'Medium' },
};

const LINK_TTL_SEC = 30 * 24 * 3600;

function ticketIdFor(uuid: string): string {
  return `GRD-${uuid.replace(/-/g, '').slice(0, 10).toUpperCase()}`;
}

export async function POST(req: Request) {
  try {
    const b = await req.json();
    const guardId = String(b.guardId ?? '');
    const uuid = String(b.clientEventUuid ?? '');
    if (!mongoose.Types.ObjectId.isValid(guardId) || uuid.length < 8) {
      return NextResponse.json({ success: false, message: 'guardId and clientEventUuid required' }, { status: 400 });
    }
    const cat = CATEGORIES[String(b.category)] ? String(b.category) : 'other';
    const text = String(b.message ?? '').trim().slice(0, 3000);

    await connectToDatabase();
    const guard: any = await APGuard.findById(guardId).select('name phone agencyId agencyName').lean();
    if (!guard) return NextResponse.json({ success: false, message: 'guard not found' }, { status: 404 });

    // Only the guard's own uploads can be attached.
    const requested: string[] = Array.isArray(b.mediaIds) ? b.mediaIds.map(String).slice(0, 5) : [];
    const media: any[] = requested.length
      ? await GuardMedia.find({ mediaId: { $in: requested }, guardId }).select('mediaId kind').lean()
      : [];
    if (!text && media.length === 0) {
      return NextResponse.json({ success: false, code: 'empty', message: 'Record a voice note or write a message.' }, { status: 422 });
    }

    const ticketId = ticketIdFor(uuid);
    const existing: any = await SupportTicket.findOne({ ticketId }).lean();
    if (existing) return NextResponse.json({ success: true, duplicate: true, ticketId });

    const origin = publicOrigin(req);
    const links = media
      .map((m) => {
        const sig = signLink('media', m.mediaId, LINK_TTL_SEC);
        return sig ? `${m.kind}: ${origin}/api/guard/media?mediaId=${m.mediaId}&e=${sig.e}&s=${sig.s}` : `${m.kind}: ${m.mediaId}`;
      })
      .join('\n');

    const period = /^\d{4}-\d{2}$/.test(String(b.period ?? '')) ? String(b.period) : '';
    const message = [
      text || '(voice note — see attachment)',
      period ? `Payslip period: ${period}` : '',
      links ? `\nAttachments (links valid 30 days):\n${links}` : '',
      `\nGuard ID: ${guardId}`,
    ]
      .filter(Boolean)
      .join('\n');

    const agencyId = String(guard.agencyId ?? '');
    await SupportTicket.create({
      ticketId,
      agencyOwnerId: mongoose.Types.ObjectId.isValid(agencyId) ? agencyId : null,
      agencyId,
      agencyName: guard.agencyName ?? '',
      customerId: guardId,
      fullName: guard.name ?? 'Guard',
      // The schema requires an email and guards do not have one; `.invalid` can never deliver.
      email: `guard-${guardId}@no-email.invalid`,
      phone: guard.phone ?? '',
      subject: `${CATEGORIES[cat].label}${period ? ` (${period})` : ''}`,
      message,
      category: CATEGORIES[cat].label,
      priority: CATEGORIES[cat].priority,
      status: 'Open',
      delegatedToAgency: !!agencyId,
    });

    try {
      (globalThis as any).__io?.emit?.('new-notification', {
        kind: 'GUARD_SUPPORT_TICKET',
        audience: ['agency', 'ops'],
        guardId,
        agencyId,
        ticketId,
        category: cat,
        priority: CATEGORIES[cat].priority,
        at: new Date().toISOString(),
      });
    } catch {
      /* ignore */
    }

    return NextResponse.json({ success: true, ticketId, status: 'Open' });
  } catch (error: any) {
    if (error?.code === 11000) return NextResponse.json({ success: true, duplicate: true });
    return NextResponse.json({ success: false, message: error?.message ?? 'ticket failed' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const guardId = new URL(req.url).searchParams.get('guardId') ?? '';
    if (!mongoose.Types.ObjectId.isValid(guardId)) {
      return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });
    }
    await connectToDatabase();
    const rows: any[] = await SupportTicket.find({ customerId: guardId, ticketId: /^GRD-/ })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    return NextResponse.json({
      success: true,
      tickets: rows.map((r) => ({
        ticketId: r.ticketId,
        subject: r.subject,
        status: r.status,
        createdAt: r.createdAt,
        // Only what staff wrote back; the guard's own message text holds internal links.
        replies: (r.replies ?? [])
          .filter((x: any) => x.senderRole !== 'client')
          .map((x: any) => ({ message: x.message, at: x.createdAt })),
        // `resolutionNotes` is internal; only the response written for the requester is shown.
        resolution: r.adminResponse || '',
      })),
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'read failed' }, { status: 500 });
  }
}
