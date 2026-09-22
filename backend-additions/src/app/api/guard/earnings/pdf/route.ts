import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectToDatabase } from '@/lib/db';
import { APGuard } from '@/lib/models/APGuard';
import { GuardPayslip } from '@/lib/models/GuardPayslip';
import { buildPdf, rupeesText, type PdfLine } from '@/lib/guardPdf';
import { publicOrigin, signLink, verifyLink } from '@/lib/guardSign';

export const dynamic = 'force-dynamic';

/**
 * Payslip PDF (PRD 18.13, SUR-GAP-023).
 *
 *   POST { guardId, period }          → { url } signed for 10 minutes
 *   GET  ?g=&p=&e=&s=                 → the PDF
 *
 * The PDF is opened by the phone's own viewer, which cannot send the app's request body, so the
 * app first asks for a short-lived signed link. Only finalised payslips (not Draft) are served:
 * an estimate must never exist as a document someone could mistake for a payslip.
 */

const TTL_SEC = 600;

export async function POST(req: Request) {
  try {
    const b = await req.json();
    const guardId = String(b.guardId ?? '');
    const period = String(b.period ?? '');
    if (!mongoose.Types.ObjectId.isValid(guardId) || !/^\d{4}-\d{2}$/.test(period)) {
      return NextResponse.json({ success: false, message: 'guardId and period (YYYY-MM) required' }, { status: 400 });
    }
    await connectToDatabase();
    const slip = await GuardPayslip.exists({ guardId, period, status: { $ne: 'Draft' } });
    if (!slip) return NextResponse.json({ success: false, message: 'No finalised payslip for this month.' }, { status: 404 });

    const sig = signLink('payslip', `${guardId}:${period}`, TTL_SEC);
    if (!sig) {
      return NextResponse.json({ success: false, code: 'links_disabled', message: 'PDF download is not configured.' }, { status: 503 });
    }
    const url = `${publicOrigin(req)}/api/guard/earnings/pdf?g=${guardId}&p=${period}&e=${sig.e}&s=${sig.s}`;
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
    const [slip, guard]: any[] = await Promise.all([
      GuardPayslip.findOne({ guardId, period, status: { $ne: 'Draft' } }).lean(),
      APGuard.findById(guardId).select('name empId id agencyName phone').lean(),
    ]);
    if (!slip) return NextResponse.json({ success: false, message: 'not found' }, { status: 404 });

    const [y, m] = period.split('-').map(Number);
    const monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

    const lines: PdfLine[] = [];
    const rules: { y: number }[] = [];
    let y0 = 60;
    const L = 40;
    const R = 555;

    lines.push({ text: guard?.agencyName || 'Suraksha', x: L, y: y0, size: 16, bold: true });
    lines.push({ text: `Payslip - ${monthLabel}`, x: R, y: y0, size: 12, bold: true, align: 'right' });
    y0 += 28;
    lines.push({ text: `Name: ${guard?.name ?? ''}`, x: L, y: y0 });
    lines.push({ text: `Employee ID: ${guard?.empId || guard?.id || ''}`, x: R, y: y0, align: 'right' });
    y0 += 16;
    lines.push({
      text: `Days present: ${slip.daysPresent}   Absent: ${slip.daysAbsent}   Paid leave: ${slip.paidLeave}   OT hours: ${slip.otHours}`,
      x: L,
      y: y0,
    });
    y0 += 14;
    rules.push({ y: y0 });
    y0 += 22;

    const section = (title: string, rows: { label: string; code: string; amountPaise: number }[], totalLabel: string, total: number) => {
      lines.push({ text: title, x: L, y: y0, size: 11, bold: true });
      y0 += 18;
      for (const r of rows) {
        lines.push({ text: r.label || r.code, x: L + 10, y: y0 });
        lines.push({ text: rupeesText(r.amountPaise), x: R, y: y0, align: 'right' });
        y0 += 15;
      }
      rules.push({ y: y0 - 4 });
      y0 += 10;
      lines.push({ text: totalLabel, x: L + 10, y: y0, bold: true });
      lines.push({ text: rupeesText(total), x: R, y: y0, bold: true, align: 'right' });
      y0 += 26;
    };

    section('Earnings', slip.earnings ?? [], 'Gross earnings', slip.grossPaise);
    if ((slip.deductions ?? []).length) section('Deductions', slip.deductions, 'Total deductions', slip.deductionsPaise);

    rules.push({ y: y0 - 8 });
    y0 += 8;
    lines.push({ text: 'Net pay', x: L, y: y0, size: 14, bold: true });
    lines.push({ text: rupeesText(slip.netPaise), x: R, y: y0, size: 14, bold: true, align: 'right' });
    y0 += 24;

    if (slip.carriedForwardPaise > 0) {
      lines.push({ text: `Carried forward to next month: ${rupeesText(slip.carriedForwardPaise)}`, x: L, y: y0 });
      y0 += 16;
    }
    const paid = slip.status === 'Completed' || slip.status === 'Archived';
    lines.push({
      text: paid
        ? `Paid on ${slip.paidOn ? new Date(slip.paidOn).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) : '-'}   Reference (UTR): ${slip.referenceNo || '-'}`
        : 'Status: finalised, payment pending',
      x: L,
      y: y0,
    });
    y0 += 30;
    lines.push({
      text: `Generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} from the Suraksha Guard app. Questions: raise a ticket from Help in the app.`,
      x: L,
      y: y0,
      size: 8,
    });

    const pdf = buildPdf(lines, rules);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="payslip-${period}.pdf"`,
        'Content-Length': String(pdf.length),
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message ?? 'pdf failed' }, { status: 500 });
  }
}
