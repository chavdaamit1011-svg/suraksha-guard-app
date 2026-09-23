import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/db';
import AgencyContract from '@/lib/models/AgencyContract';
import { AgencyRoster } from '@/lib/models/AgencyRoster';
import { syncContractToRosterAndPatrol } from '@/lib/contractSync';

export async function POST(req: Request) {
  try {
    await connectToDatabase();
    const body = await req.json();
    const { contractId, guardId, action, reason } = body;

    if (!contractId || !guardId || !action) {
      return NextResponse.json({ success: false, message: 'contractId, guardId, and action are required' }, { status: 400 });
    }

    const contract = await AgencyContract.findById(contractId);
    if (!contract) {
      return NextResponse.json({ success: false, message: 'Contract not found' }, { status: 404 });
    }

    const guardEntry = (contract.assignedGuards || []).find((g: any) => String(g.guardId) === String(guardId));
    if (!guardEntry) {
      return NextResponse.json({ success: false, message: 'Guard not assigned to this contract' }, { status: 404 });
    }

    if (action === 'accept') {
      guardEntry.status = 'Accepted';
      await contract.save();

      // Sync confirmed roster across the contract dates
      await syncContractToRosterAndPatrol(contract, String(contract.agencyOwnerId), contract.client);

      return NextResponse.json({
        success: true,
        message: 'Contract accepted successfully. Daily duty roster activated.',
        status: 'Accepted'
      });
    } else if (action === 'reject') {
      guardEntry.status = 'Rejected';
      guardEntry.rejectedAt = new Date();
      if (reason) guardEntry.rejectionReason = String(reason);
      await contract.save();

      // Remove this guard from the scheduled AgencyRoster entries for this contract so agency can reassign
      await AgencyRoster.updateMany(
        { contractId: String(contract._id) },
        { $pull: { assignedGuards: { guardId: String(guardId) } } }
      );

      return NextResponse.json({
        success: true,
        message: 'Contract assignment declined. Agency portal has been updated.',
        status: 'Rejected'
      });
    } else {
      return NextResponse.json({ success: false, message: 'Invalid action. Must be accept or reject.' }, { status: 400 });
    }
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error?.message || 'Server error' }, { status: 500 });
  }
}
