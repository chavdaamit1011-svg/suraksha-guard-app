/** Registration runs before a guard session exists; only self-contained images are accepted. */
export function registrationDocuments(body: Record<string, unknown>) {
  const aadhaar = String(body.aadhaarNumber ?? '').replace(/\s/g, '');
  if (!/^[2-9]\d{11}$/.test(aadhaar)) throw new Error('Enter a valid 12-digit Aadhaar number.');
  function image(value: unknown, required: boolean, label: string): string {
    if (!value && !required) return '';
    if (typeof value !== 'string' || value.length > 1_400_025 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
      throw new Error(`${label}: please capture or select a JPEG photo again.`);
    }
    const bytes = Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw new Error(`${label}: invalid image.`);
    }
    return value;
  }
  const selfie = image(body.selfieUrl || body.docPhoto, false, 'Selfie');
  return {
    // Match the existing document screen's masked-number storage policy.
    aadhaarNumber: `XXXX XXXX ${aadhaar.slice(-4)}`,
    docAadhaar: image(body.docAadhaar, true, 'Aadhaar card'),
    docPan: image(body.docPan, false, 'PAN card'),
    docPhoto: selfie,
    selfieUrl: selfie,
  };
}
