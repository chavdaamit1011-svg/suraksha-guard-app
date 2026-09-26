import { NextResponse } from 'next/server';
import { activeGuardById, guardRemoved } from '@/lib/guardAccess';

export const dynamic = 'force-dynamic';

/** Small access heartbeat; does not wait for duty uploads or roster queries. */
export async function GET(req: Request) {
  const guardId = new URL(req.url).searchParams.get('guardId');
  if (!guardId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });
  try {
    const guard = await activeGuardById(guardId);
    return NextResponse.json(guard ? { success: true, active: true } : guardRemoved, {
      status: guard ? 200 : 401,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    // A database/network outage is not evidence that the account was removed.
    return NextResponse.json({ success: false, message: 'Access check unavailable' }, { status: 503 });
  }
}
