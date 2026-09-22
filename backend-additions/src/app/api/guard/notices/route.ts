import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/db';
import { GuardNotification } from '@/lib/models/GuardNotification';
import { GuardAppProfile } from '@/lib/models/GuardAppProfile';

/** Notices with acknowledgement (PRD 18.14 / SUR-GAP-025). Acks kept on the guard profile. */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const guardId = searchParams.get('guardId');
  if (!guardId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });
  await connectToDatabase();
  const [notices, profile] = await Promise.all([
    GuardNotification.find({ guardId }).sort({ createdAt: -1 }).limit(40).lean().catch(() => []),
    GuardAppProfile.findOne({ guardId }).lean(),
  ]);
  const acked = new Set((profile as any)?.ackedNotices ?? []);
  return NextResponse.json({
    success: true,
    notices: (notices as any[]).map((n) => ({ ...n, acknowledged: acked.has(String(n._id)) })),
  });
}

export async function POST(req: Request) {
  try {
    const { guardId, noticeId } = await req.json();
    if (!guardId || !noticeId) return NextResponse.json({ success: false, message: 'guardId and noticeId required' }, { status: 400 });
    await connectToDatabase();
    await GuardAppProfile.updateOne({ guardId }, { $addToSet: { ackedNotices: String(noticeId) } }, { upsert: true });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}
