import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/db';
import { APGuard } from '@/lib/models/APGuard';
import { Agency } from '@/lib/models/Agency';
import { v4 as uuidv4 } from 'uuid';
import { GuardNotification } from '@/lib/models/GuardNotification';
import { GuardAppProfile } from '@/lib/models/GuardAppProfile';
import { normPhone } from '@/lib/guardOtp';
import { issueSession, readRegisterTicket, sessionRequired } from '@/lib/guardSession';

/**
 * Guard self-registration (replaces the original route of the same path).
 *
 * The original created an account for any phone number it was given, with no proof that the
 * caller had received that number's OTP. It now requires the `registerTicket` that
 * `/api/guard/auth/verify-otp` issues for an unregistered phone (strictly once
 * GUARD_REQUIRE_SESSION=1; before that a ticket, if sent, must still match), and answers with a
 * session token like a login does. Everything else behaves as before.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { name, city, address, lat, lng, agencyId, profilePhoto, type, branch, employmentType, wage, pvStatus, deviceId, deviceModel, registerTicket } = body;
    const phone = body.phone ? normPhone(body.phone) : '';

    if (!phone || !name || !city || !agencyId) {
      return NextResponse.json({ success: false, message: 'Missing required fields' }, { status: 400 });
    }

    const ticket = registerTicket ? await readRegisterTicket(String(registerTicket)) : null;
    if ((registerTicket || sessionRequired()) && (!ticket || ticket.p !== phone)) {
      return NextResponse.json(
        { success: false, code: 'otp_required', message: 'Verify your phone number with the OTP first.' },
        { status: 401 }
      );
    }

    await connectToDatabase();

    // Check if already exists
    const existingGuard = await APGuard.findOne({ phone });
    if (existingGuard) {
      return NextResponse.json({ success: false, message: 'Phone number already registered' }, { status: 409 });
    }

    // Lookup Agency Name
    const agency = await Agency.findOne({ id: agencyId });
    const agencyName = agency ? agency.name : 'Unknown Agency';

    // Create new guard
    const newGuard = await APGuard.create({
      id: uuidv4().substring(0, 8),
      guardId: uuidv4(),
      name,
      phone,
      city,
      address,
      lat: lat || 0,
      lng: lng || 0,
      agencyId,
      agencyName,
      profilePhoto: profilePhoto || '',
      type: type || 'Gate Guard',
      branch: branch || '',
      employmentType: employmentType || 'Full-Time',
      wage: wage || '₹16,500',
      pvStatus: pvStatus || 'Pending',
      registrationStatus: 'APPROVED',
      status: 'Active',
    });
    const gid = newGuard._id.toString();
    await GuardNotification.create({ guardId: gid, sourceKey: `welcome-${gid}`, title: 'Welcome to Guard App', body: 'Your Guard Portal is ready. Turn on duty when you are available for assignments.', kind: 'welcome' });

    // The registering phone becomes the guard's bound device.
    if (deviceId) {
      await GuardAppProfile.updateOne(
        { guardId: gid },
        { $setOnInsert: { guardId: gid, boundDeviceId: String(deviceId), deviceModel: String(deviceModel ?? '') } },
        { upsert: true }
      ).catch(() => {});
    }

    const session = await issueSession(gid, String(deviceId ?? ''), 0);
    return NextResponse.json({
      success: true,
      guard: newGuard,
      sessionToken: session?.token ?? null,
      sessionExpiresAt: session?.expiresAt ?? null,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}
