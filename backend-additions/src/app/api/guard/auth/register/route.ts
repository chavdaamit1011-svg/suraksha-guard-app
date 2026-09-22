import { NextResponse } from 'next/server';

// AP/Ops provisions guard accounts. App registration must not resurrect a deleted guard.
export async function POST() {
  return NextResponse.json({ success: false, code: 'registration_disabled',
    message: 'Ask your agency or Operations to add your guard account, then sign in with OTP.',
  }, { status: 403 });
}