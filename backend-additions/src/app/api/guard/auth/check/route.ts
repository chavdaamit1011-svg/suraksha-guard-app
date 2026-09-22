import { NextResponse } from 'next/server';
import { activeGuardByPhone, guardRemoved } from '@/lib/guardAccess';

export async function POST(req: Request) {
  try {
    const { phone } = await req.json();
    if (!phone) return NextResponse.json({ success: false, message: 'Phone number is required.' }, { status: 400 });
    const guard = await activeGuardByPhone(phone);
    return guard ? NextResponse.json({ success: true, exists: true }) : NextResponse.json(guardRemoved, { status: 401 });
  } catch {
    return NextResponse.json({ success: false, message: 'Unable to check guard account.' }, { status: 400 });
  }
}
