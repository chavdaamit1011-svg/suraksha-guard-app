import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/db';
import { Booking } from '@/lib/models/BookingState';
import { APGuard } from '@/lib/models/APGuard';
import mongoose from 'mongoose';

export async function POST(req: Request) {
  try {
    await connectToDatabase();
    const body = await req.json();
    const { bookingId, guardId, reason } = body;

    if (!bookingId || !guardId) {
      return NextResponse.json({ success: false, message: 'bookingId and guardId are required' }, { status: 400 });
    }

    // Flexible guard lookup by _id, id, empId, or phone
    let guard: any = null;
    if (mongoose.Types.ObjectId.isValid(guardId)) {
      guard = await APGuard.findById(guardId).lean().catch(() => null);
    }
    if (!guard) {
      guard = await APGuard.findOne({ $or: [{ empId: guardId }, { phone: guardId }] }).lean().catch(() => null);
    }

    const guardName = guard?.name || 'Guard';
    const guardPhone = guard?.phone || '';
    const resolvedGuardId = guard?._id?.toString() || String(guardId);

    // Find the booking
    const booking: any = await Booking.findOne({
      bookingId,
      bookingStatus: { $in: ['PENDING_ACCEPTANCE', 'SEARCHING', 'ASSIGNED'] },
      $or: [
        { pendingGuardId: { $in: [resolvedGuardId, String(guardId)] } },
        { dispatchedGuardIds: { $in: [resolvedGuardId, String(guardId)] } },
      ],
    });

    if (!booking) {
      return NextResponse.json({ success: false, message: 'Duty request not found or already processed.' }, { status: 404 });
    }

    const rejectionEntry = {
      guardId: resolvedGuardId,
      guardName,
      guardPhone,
      rejectedAt: new Date(),
      reason: reason || 'Declined by guard in app',
    };

    // Filter out this guard from dispatched IDs
    const currentDispatched: string[] = (booking.dispatchedGuardIds || []).map(String);
    const updatedDispatched = currentDispatched.filter(
      (id) => id !== resolvedGuardId && id !== String(guardId)
    );

    const isPendingSingle =
      booking.pendingGuardId === resolvedGuardId || booking.pendingGuardId === String(guardId);

    const updateDoc: any = {
      $push: { rejectedGuards: rejectionEntry },
      $set: {
        dispatchedGuardIds: updatedDispatched,
      },
    };

    if (isPendingSingle) {
      updateDoc.$set.pendingGuardId = '';
    }

    // If no more guards are in dispatched queue, reset bookingStatus back to SEARCHING so AP portal can deploy another guard
    if (updatedDispatched.length === 0) {
      updateDoc.$set.bookingStatus = 'SEARCHING';
    }

    const updatedBooking = await Booking.findOneAndUpdate(
      { bookingId },
      updateDoc,
      { new: true }
    );

    return NextResponse.json({
      success: true,
      message: 'Duty request declined successfully.',
      booking: updatedBooking,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}
