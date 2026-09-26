import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectToDatabase } from '@/lib/db';
import { normPhone } from '@/lib/guardOtp';

/**
 * Guard self-registration (PRD 18.1 §2).
 * Called after OTP verification when the phone is not yet in the system.
 * Creates an APGuard record with registrationStatus: 'PENDING_APPROVAL'.
 * OPS admin must approve before the guard can log in.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { phone, name, city, address, agencyId, registerTicket, lat, lng, docAadhaar, docPan, docPhoto } = body;

    if (!phone || !name) {
      return NextResponse.json({ success: false, message: 'Phone and name are required.' }, { status: 400 });
    }

    const key = normPhone(phone);
    if (key.length !== 13) {
      return NextResponse.json({ success: false, message: 'A valid 10-digit phone is required.' }, { status: 400 });
    }

    await connectToDatabase();
    const db = mongoose.connection;

    // Check if a guard record already exists for this phone
    const existing = await db.collection('apguards').findOne({
      phone: { $regex: String(phone).replace(/\D/g, '').slice(-10), $options: 'i' },
    });

    if (existing) {
      if (existing.registrationStatus === 'APPROVED') {
        return NextResponse.json({ success: false, message: 'This number is already registered. Please log in.' }, { status: 409 });
      }
      if (existing.registrationStatus === 'PENDING_APPROVAL') {
        return NextResponse.json({ success: false, message: 'Your registration is already pending approval. Please wait up to 48 hours.', code: 'PENDING_APPROVAL' }, { status: 409 });
      }
      if (existing.registrationStatus === 'DECLINED') {
        return NextResponse.json({ success: false, message: existing.registrationNote || 'Your previous registration was declined. Please contact support.', code: 'DECLINED' }, { status: 409 });
      }
    }

    const clean10 = key.replace(/\D/g, '').slice(-10);
    const nameStr = String(name).trim();

    const newGuard = {
      id: `GD-${clean10}`,
      name: nameStr,
      phone: key,
      empId: `SEN-${clean10.slice(-4)}`,
      city: city || '',
      state: '',
      address: address || '',
      lat: lat || 0,
      lng: lng || 0,
      type: 'Security Guard',
      branch: 'Pending Assignment',
      agencyId: agencyId || '',
      agencyName: 'Suraksha Default Agency',
      status: 'Active',
      registrationStatus: 'PENDING_APPROVAL',
      initials: nameStr.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase(),
      profilePhoto: docPhoto || '',
      docAadhaar: docAadhaar || '',
      docPan: docPan || '',
      docPhoto: docPhoto || '',
      selfieUrl: '',
      registrationNote: '',
      registeredAt: new Date(),
      isOnline: false,
      wage: '₹16,500',
      pvStatus: 'Pending',
      employmentType: 'Full-Time',
      trained: false,
      kycVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const res = await db.collection('apguards').insertOne(newGuard);
    const created = await db.collection('apguards').findOne({ _id: res.insertedId });

    return NextResponse.json({
      success: true,
      registrationStatus: 'PENDING_APPROVAL',
      message: 'Registration submitted successfully. Your profile is under review.',
      guardId: res.insertedId.toString(),
      guard: created,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}