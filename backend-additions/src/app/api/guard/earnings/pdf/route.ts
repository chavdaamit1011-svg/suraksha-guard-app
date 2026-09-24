import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectToDatabase } from '@/lib/db';
import { APGuard } from '@/lib/models/APGuard';
import { GuardPayslip } from '@/lib/models/GuardPayslip';
import { Booking } from '@/lib/models/BookingState';
import { buildPdf, rupeesText, type PdfLine } from '@/lib/guardPdf';
import { publicOrigin, signLink, verifyLink } from '@/lib/guardSign';

export const dynamic = 'force-dynamic';

const TTL_SEC = 600;

export async function POST(req: Request) {
  try {
    const b = await req.json();
    const guardId = String(b.guardId ?? '');
    const period = String(b.period ?? '');
    if (!guardId || !period) {
      return NextResponse.json({ success: false, message: 'guardId and period required' }, { status: 400 });
    }
    await connectToDatabase();

    const sig = signLink('payslip', `${guardId}:${period}`, TTL_SEC);
    if (!sig) {
      return NextResponse.json({ success: false, code: 'links_disabled', message: 'PDF download is not configured.' }, { status: 503 });
    }
    const url = `${publicOrigin(req)}/api/guard/earnings/pdf?g=${encodeURIComponent(guardId)}&p=${encodeURIComponent(period)}&e=${sig.e}&s=${sig.s}`;
    return NextResponse.json({ success: true, url, expiresInSec: TTL_SEC });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'link failed' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const q = new URL(req.url).searchParams;
    const guardId = q.get('g') ?? '';
    const period = q.get('p') ?? '';
    if (!verifyLink('payslip', `${guardId}:${period}`, q.get('e'), q.get('s'))) {
      return NextResponse.json({ success: false, message: 'This link has expired. Open it again from the app.' }, { status: 403 });
    }

    await connectToDatabase();

    const guardQuery = mongoose.Types.ObjectId.isValid(guardId)
      ? { $or: [{ _id: new mongoose.Types.ObjectId(guardId) }, { id: guardId }, { guardId }, { phone: guardId }] }
      : { $or: [{ id: guardId }, { guardId }, { phone: guardId }] };

    const guard: any = await APGuard.findOne(guardQuery).select('name empId id agencyName phone').lean();

    const lines: PdfLine[] = [];
    const rules: { y: number }[] = [];
    let y0 = 60;
    const L = 40;
    const R = 555;

    // Check if period is a Booking ID
    if (period.startsWith('BK-') || period.includes('BK-')) {
      const booking: any = await Booking.findOne({ bookingId: period }).lean();
      if (!booking) return NextResponse.json({ success: false, message: 'Duty order not found' }, { status: 404 });

      const payout =
        booking.settlement?.guardPayout ??
        Math.round((booking.amount || booking.settlement?.subtotal || 1000) * 0.7);
      const grossPaise = (booking.settlement?.subtotal || booking.amount || payout) * 100;
      const netPaise = payout * 100;
      const refNo = booking.invoiceNumber || `INV-${booking.bookingId}`;
      const completedAt = booking.dutyDetails?.dutyCompletedAt || booking.updatedAt || new Date();
      const dateLabel = new Date(completedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

      lines.push({ text: guard?.agencyName || 'Suraksha Security Services', x: L, y: y0, size: 16, bold: true });
      lines.push({ text: `Duty Payslip - ${booking.bookingId}`, x: R, y: y0, size: 12, bold: true, align: 'right' });
      y0 += 28;
      lines.push({ text: `Guard: ${guard?.name || booking.assignedGuard?.name || 'Security Guard'}`, x: L, y: y0 });
      lines.push({ text: `ID / Phone: ${guard?.empId || guard?.phone || booking.assignedGuard?.phone || ''}`, x: R, y: y0, align: 'right' });
      y0 += 16;
      lines.push({
        text: `Service: ${booking.serviceName || 'Security Guard'}   Date: ${dateLabel}   Status: Completed`,
        x: L,
        y: y0,
        size: 9,
      });
      y0 += 18;
      rules.push({ y: y0 });
      y0 += 16;

      lines.push({ text: 'EARNINGS & PAYOUT BREAKDOWN', x: L, y: y0, bold: true, size: 10 });
      y0 += 16;
      lines.push({ text: `${booking.serviceName || 'Duty Payout'} (${booking.bookingId})`, x: L, y: y0 });
      lines.push({ text: rupeesText(netPaise), x: R, y: y0, align: 'right' });
      y0 += 22;

      rules.push({ y: y0 });
      y0 += 16;
      lines.push({ text: 'NET PAYABLE', x: L, y: y0, bold: true, size: 12 });
      lines.push({ text: rupeesText(netPaise), x: R, y: y0, bold: true, size: 12, align: 'right' });
      y0 += 22;

      lines.push({ text: `Reference / Invoice: ${refNo}`, x: L, y: y0, size: 9 });
      lines.push({ text: `Location: ${booking.location?.address || 'On-site'}`, x: R, y: y0, size: 9, align: 'right' });
      y0 += 14;
      lines.push({ text: 'Verified and approved on Suraksha Guard Network.', x: L, y: y0, size: 8 });

      const pdf = buildPdf(lines, rules);
      return new Response(pdf as any, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="payslip-${period}.pdf"`,
          'Cache-Control': 'private, no-transform',
        },
      });
    }

    // Otherwise formal month payslip
    const slip: any = await GuardPayslip.findOne({
      $or: [{ guardId }, { guardId: guard?._id?.toString() }, { guardId: guard?.id }],
      period,
      status: { $ne: 'Draft' },
    }).lean();

    if (!slip) {
      return NextResponse.json({ success: false, message: 'No payslip found for this period' }, { status: 404 });
    }

    const [y, m] = period.split('-').map(Number);
    const monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

    lines.push({ text: guard?.agencyName || 'Suraksha Security Services', x: L, y: y0, size: 16, bold: true });
    lines.push({ text: `Payslip - ${monthLabel}`, x: R, y: y0, size: 12, bold: true, align: 'right' });
    y0 += 28;
    lines.push({ text: `Name: ${guard?.name ?? ''}`, x: L, y: y0 });
    lines.push({ text: `Employee ID: ${guard?.empId || guard?.id || ''}`, x: R, y: y0, align: 'right' });
    y0 += 16;
    lines.push({
      text: `Days present: ${slip.daysPresent}   Absent: ${slip.daysAbsent}   Paid leave: ${slip.paidLeave}   OT hours: ${slip.otHours}`,
      x: L,
      y: y0,
      size: 9,
    });
    y0 += 18;
    rules.push({ y: y0 });
    y0 += 16;

    lines.push({ text: 'EARNINGS', x: L, y: y0, bold: true, size: 10 });
    y0 += 16;
    for (const e of slip.earnings ?? []) {
      lines.push({ text: e.label, x: L, y: y0 });
      lines.push({ text: rupeesText(e.amountPaise), x: R, y: y0, align: 'right' });
      y0 += 14;
    }
    y0 += 6;
    lines.push({ text: 'Gross pay', x: L, y: y0, bold: true });
    lines.push({ text: rupeesText(slip.grossPaise), x: R, y: y0, bold: true, align: 'right' });
    y0 += 18;

    rules.push({ y: y0 });
    y0 += 16;
    lines.push({ text: 'DEDUCTIONS', x: L, y: y0, bold: true, size: 10 });
    y0 += 16;
    for (const d of slip.deductions ?? []) {
      lines.push({ text: d.label, x: L, y: y0 });
      lines.push({ text: rupeesText(d.amountPaise), x: R, y: y0, align: 'right' });
      y0 += 14;
    }
    y0 += 6;
    lines.push({ text: 'Total deductions', x: L, y: y0, bold: true });
    lines.push({ text: rupeesText(slip.deductionsPaise), x: R, y: y0, bold: true, align: 'right' });
    y0 += 18;

    rules.push({ y: y0 });
    y0 += 16;
    lines.push({ text: 'NET PAY', x: L, y: y0, bold: true, size: 12 });
    lines.push({ text: rupeesText(slip.netPaise), x: R, y: y0, bold: true, size: 12, align: 'right' });
    y0 += 22;

    if (slip.referenceNo) {
      lines.push({ text: `Reference: ${slip.referenceNo}`, x: L, y: y0, size: 9 });
    }
    if (slip.paidOn) {
      lines.push({ text: `Paid on: ${new Date(slip.paidOn).toLocaleDateString('en-IN')}`, x: R, y: y0, size: 9, align: 'right' });
    }

    const pdf = buildPdf(lines, rules);
    return new Response(pdf as any, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="payslip-${period}.pdf"`,
        'Cache-Control': 'private, no-transform',
      },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'pdf failed' }, { status: 500 });
  }
}
