import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { APGuard } from '@/lib/models/APGuard';
import { Booking } from '@/lib/models/BookingState'; 
import { calculateBookingSettlement } from '@/lib/bookingSettlement';

export const dynamic = 'force-dynamic';

type CompletedGuardBooking = {
  bookingId: string;
  createdAt: Date;
  updatedAt: Date;
  customerName?: string;
  serviceType?: string;
  bookingStatus?: string;
  durationHours?: number;
  location?: { address?: string; city?: string };
  schedule?: { date?: string; startTime?: string; endTime?: string };
  assignedGuard?: { assignedAt?: Date };
  dutyDetails?: {
    dutyStartedAt?: Date;
    dutyEndedAt?: Date;
    dutyCompletedAt?: Date;
  };
  priceQuote?: Record<string, unknown>;
  paymentDetails?: Record<string, unknown>;
  settlement?: { guardPayout?: number; settledAt?: Date };
  rating?: { score?: number; review?: string; ratedAt?: Date };
};

type RatedGuardBooking = CompletedGuardBooking & {
  rating: { score: number; review?: string; ratedAt?: Date };
};

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const guardId = searchParams.get('guardId');

    if (!guardId) {
      return NextResponse.json({ success: false, error: 'Guard ID is required' }, { status: 400 });
    }

    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGODB_URI as string);
    }

    const guardOid = mongoose.Types.ObjectId.isValid(guardId) ? new mongoose.Types.ObjectId(guardId) : null;
    const guard = await APGuard.findOne({
      $or: [
        ...(guardOid ? [{ _id: guardOid }] : []),
        { id: guardId },
        { guardId: guardId },
        { phone: guardId },
      ]
    }).lean();

    if (!guard) {
      return NextResponse.json({ success: false, error: 'Guard not found' }, { status: 404 });
    }

    const guardIdentifiers = [
      guardId,
      guard?._id?.toString(),
      guard?.id,
      guard?.guardId,
      guard?.phone,
    ].filter(Boolean);

    // Fetch completed bookings for this guard
    const completedBookings = await Booking.find({
      $or: [
        { 'assignedGuard.guardId': { $in: guardIdentifiers } },
        ...(guard?.phone ? [{ 'assignedGuard.phone': guard.phone }] : []),
      ],
      bookingStatus: { $in: ['COMPLETED', 'CLOSED'] }
    }).sort({ updatedAt: -1 }).lean() as unknown as CompletedGuardBooking[];

    // Calculate earnings (Assume guard earns 70% of total)
    let totalEarnings = 0;
    const processedBookings = completedBookings.map((b) => {
      const guardEarned = Number(b.settlement?.guardPayout ?? calculateBookingSettlement(b).guardPayout);
      totalEarnings += guardEarned;

      return {
        bookingId: b.bookingId,
        customerName: b.customerName?.trim() || 'Verified customer',
        serviceType: b.serviceType || 'Security',
        status: b.bookingStatus || 'COMPLETED',
        scheduledDate: b.schedule?.date || null,
        scheduledStartTime: b.schedule?.startTime || null,
        scheduledEndTime: b.schedule?.endTime || null,
        assignedAt: b.assignedGuard?.assignedAt || null,
        startedAt: b.dutyDetails?.dutyStartedAt || null,
        completedAt: b.dutyDetails?.dutyCompletedAt || b.dutyDetails?.dutyEndedAt || b.updatedAt,
        recordedAt: b.settlement?.settledAt || b.updatedAt,
        location: [b.location?.address, b.location?.city].filter(Boolean).join(', ') || 'Client location',
        duration: Number(b.durationHours || 0),
        earned: guardEarned,
        rating: b.rating?.score ? {
          score: Number(b.rating.score),
          review: b.rating.review?.trim() || '',
          ratedAt: b.rating.ratedAt || b.updatedAt,
        } : null,
      };
    });

    // Reviews are derived only from real, completed bookings rated by that
    // booking's customer. Unrated bookings are deliberately not represented by
    // placeholder stars or testimonial copy.
    const ratedBookings = completedBookings.filter((booking): booking is RatedGuardBooking => {
      const score = Number(booking.rating?.score);
      return Number.isFinite(score) && score >= 1 && score <= 5;
    });
    const totalRating = ratedBookings.reduce(
      (sum, booking) => sum + Number(booking.rating?.score),
      0,
    );
    const reviewItems = ratedBookings.map((booking) => ({
      bookingId: booking.bookingId,
      customerName: booking.customerName?.trim() || 'Verified customer',
      serviceType: booking.serviceType,
      city: booking.location?.city || '',
      score: Number(booking.rating.score),
      review: booking.rating.review?.trim() || '',
      ratedAt: booking.rating.ratedAt || booking.updatedAt,
    }));

    const averageRating = ratedBookings.length
      ? Number((totalRating / ratedBookings.length).toFixed(1))
      : null;

    const guardProfileData = {
      ...guard,
      rating: averageRating,
      totalReviews: ratedBookings.length,
    };

    return NextResponse.json({
      success: true,
      profile: guardProfileData,
      guard: guardProfileData,
      earnings: {
        totalEarnings,
        history: processedBookings
      },
      reviews: {
        averageRating,
        totalReviews: ratedBookings.length,
        items: reviewItems,
      }
    });
  } catch (error: unknown) {
    console.error('Error fetching guard me API:', error);
    const message = error instanceof Error ? error.message : 'Unable to load guard profile';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
