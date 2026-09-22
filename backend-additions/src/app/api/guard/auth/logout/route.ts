import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/db';
import { GuardAppProfile } from '@/lib/models/GuardAppProfile';
import { bearer, readRefreshable } from '@/lib/guardSession';

export const dynamic = 'force-dynamic';

/**
 * Sign the guard out everywhere: bumps sessionVersion so no existing token can be renewed.
 *   POST  Authorization: Bearer <token>
 * Always answers success — the app clears its own login either way.
 */
export async function POST(req: Request) {
  try {
    const session = await readRefreshable(bearer(req));
    if (session) {
      await connectToDatabase();
      await GuardAppProfile.updateOne({ guardId: session.g, sessionVersion: session.v }, { $inc: { sessionVersion: 1 } });
    }
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: true });
  }
}
