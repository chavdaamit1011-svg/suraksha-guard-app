/**
 * A deliberately tiny single-page PDF writer for payslips (PRD 18.13: "PDF download").
 *
 * The platform has no PDF dependency, and a payslip is a few lines of text, so this writes the
 * format directly rather than adding one. It uses the standard Helvetica fonts, which every PDF
 * viewer carries, so nothing is embedded. Those fonts are WinAnsi-only: text is reduced to
 * printable ASCII (the rupee sign is written "Rs."), which is why the PDF is in English while the
 * app screen stays in the guard's language.
 */

export type PdfLine = {
  text: string;
  x: number;
  y: number; // from the top of the page, in points
  size?: number;
  bold?: boolean;
  align?: 'left' | 'right';
};

const PAGE_W = 595; // A4
const PAGE_H = 842;

function ascii(s: string): string {
  return s
    .replace(/₹/g, 'Rs.')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/** Helvetica advance widths are ~0.5–0.56 em for digits and most letters; close enough to right-align numbers. */
function approxWidth(text: string, size: number): number {
  return text.length * size * 0.53;
}

export function buildPdf(lines: PdfLine[], rules: { y: number }[] = []): Buffer {
  const ops: string[] = [];
  for (const r of rules) {
    const y = PAGE_H - r.y;
    ops.push(`0.8 G 40 ${y} m ${PAGE_W - 40} ${y} l S`);
  }
  for (const l of lines) {
    const size = l.size ?? 10;
    const text = ascii(l.text);
    const x = l.align === 'right' ? l.x - approxWidth(l.text, size) : l.x;
    ops.push(`BT /${l.bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(1)} ${(PAGE_H - l.y).toFixed(1)} Td (${text}) Tj ET`);
  }
  const content = ops.join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Integer paise → "Rs. 16,500.00" without floating-point arithmetic. */
export function rupeesText(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(Math.round(paise));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}Rs. ${whole.toLocaleString('en-IN')}.${frac}`;
}
