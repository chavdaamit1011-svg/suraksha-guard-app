import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/db';
import { APGuard } from '@/lib/models/APGuard';

/**
 * Supervisor "My team" (PRD 18.16 / SUR-GAP-034). Returns the guards sharing the requester's
 * agency (and branch, when set), with live online/location so a field supervisor can see coverage
 * and perform proxy attendance / verification. Read-scoped to the supervisor's own tenant.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const supervisorId = searchParams.get('guardId');
  if (!supervisorId) return NextResponse.json({ success: false, message: 'guardId required' }, { status: 400 });
  await connectToDatabase();

  const me = await APGuard.findById(supervisorId).lean();
  if (!me) return NextResponse.json({ success: false, message: 'Not found' }, { status: 404 });

  const filter: any = { _id: { $ne: (me as any)._id } };
  if ((me as any).agencyId) filter.agencyId = (me as any).agencyId;
  if ((me as any).branch) filter.branch = (me as any).branch;

  const team = await APGuard.find(filter)
    .select('name phone type branch city isOnline lat lng status pvStatus')
    .limit(100)
    .lean();

  return NextResponse.json({
    success: true,
    team,
    online: team.filter((g: any) => g.isOnline).length,
    total: team.length,
  });
}
