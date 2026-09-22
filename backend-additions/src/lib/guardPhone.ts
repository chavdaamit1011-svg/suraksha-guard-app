/** Match the same Indian phone across legacy AP formatting without changing its record. */
export function guardPhonePattern(phone: string): RegExp {
  const digits = String(phone || '').replace(/\D/g, '');
  const national = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  if (!/^[6-9]\d{9}$/.test(national)) throw new Error('A valid 10-digit phone is required.');
  const separator = '[\\s().-]*';
  return new RegExp(`^${separator}(?:\\+?91${separator})?${national.split('').join(separator)}${separator}$`);
}
