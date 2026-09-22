/**
 * SMS sender for guard OTP (PRD 18.1). Provider-agnostic adapter: picks whichever gateway is
 * configured via env. If none is set, it logs the message and returns delivered:false so callers
 * can fall back (dev returns the code in the response). Add ONE of these to the app .env to go live:
 *   MSG91_AUTHKEY (+ MSG91_SENDER, MSG91_DLT_TEMPLATE_ID)
 *   FAST2SMS_API_KEY
 *   TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM
 */
type SmsResult = { delivered: boolean; provider: string; error?: string };

export async function sendSms(phoneE164: string, message: string): Promise<SmsResult> {
  const to10 = phoneE164.replace(/\D/g, '').slice(-10);
  try {
    if (process.env.MSG91_AUTHKEY) {
      const url = new URL('https://api.msg91.com/api/v5/otp');
      // MSG91 OTP flow; message contains the code. Uses a DLT-approved template.
      const res = await fetch('https://api.msg91.com/api/v5/flow/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authkey: process.env.MSG91_AUTHKEY },
        body: JSON.stringify({
          template_id: process.env.MSG91_DLT_TEMPLATE_ID,
          sender: process.env.MSG91_SENDER || 'SRAKSH',
          mobiles: `91${to10}`,
          OTP: message.match(/\d{4,6}/)?.[0] ?? message,
        }),
      });
      return { delivered: res.ok, provider: 'msg91', error: res.ok ? undefined : `http ${res.status}` };
    }
    if (process.env.FAST2SMS_API_KEY) {
      const res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
        method: 'POST',
        headers: { authorization: process.env.FAST2SMS_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ route: 'q', message, language: 'english', numbers: to10 }),
      });
      return { delivered: res.ok, provider: 'fast2sms', error: res.ok ? undefined : `http ${res.status}` };
    }
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM) {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const body = new URLSearchParams({ To: `+91${to10}`, From: process.env.TWILIO_FROM, Body: message });
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      return { delivered: res.ok, provider: 'twilio', error: res.ok ? undefined : `http ${res.status}` };
    }
  } catch (e: any) {
    return { delivered: false, provider: 'error', error: e?.message };
  }
  console.log(`[guardSms] no provider configured. Would send to ${to10}: ${message}`);
  return { delivered: false, provider: 'none' };
}
