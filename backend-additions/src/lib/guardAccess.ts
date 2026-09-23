import mongoose from 'mongoose';
import { connectToDatabase } from '@/lib/db';
import { guardPhonePattern } from '@/lib/guardPhone';

const inactive = (record: any) => !record || record.isActive === false ||
  ['inactive', 'deleted', 'suspended', 'terminated', 'rejected', 'disabled'].includes(String(record.status ?? '').toLowerCase());
const objectId = (id: string) => mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;

/** Resolve stable agency identifiers, never reusable company/display names. */
async function agencyExists(id: string): Promise<boolean> {
  if (!id) return false;
  const aid = id.toLowerCase().trim();
  if (['hq-ops', 'ops', 'suraksha', 'suraksha-ops', 'suraksha direct agency', 'suraksha default agency'].includes(aid)) return true;
  const db = mongoose.connection;
  const oid = objectId(id);
  if (oid) {
    const owner = await db.collection('users').findOne({ _id: oid });
    if (owner) return !inactive(owner) && (owner.portalType === 'agency' || owner.role === 'agency') && !owner.agencyOwnerId;
    const application = await db.collection('agencyapplications').findOne({ _id: oid });
    if (application) {
      if (application.approvalStatus === 'REJECTED') return false;
      const account = await db.collection('users').findOne({ email: application.email, portalType: 'agency', agencyOwnerId: null });
      return !!account && !inactive(account);
    }
  }
  const legacy = await db.collection('agencies').findOne(oid ? { $or: [{ id }, { _id: oid }] } : { id });
  return !!legacy && !inactive(legacy);
}

async function allowed(guard: any): Promise<boolean> {
  if (inactive(guard) || guard.registrationStatus === 'REJECTED') return false;
  if (guard.authSource === 'ops') {
    const sourceId = objectId(String(guard.opsRecordId ?? ''));
    if (!sourceId) return false;
    const source = await mongoose.connection.collection('ops_records').findOne({ _id: sourceId, module: 'guards' });
    const data = source ? { ...source.data, ...source.payload } : null;
    if (inactive(source) || inactive(data)) return false;
    if (!guardPhonePattern(String(data.phone)).test(String(guard.phone))) return false;
    return data.agencyId ? agencyExists(String(data.agencyId)) : true;
  }
  return agencyExists(String(guard.agencyId ?? ''));
}

export async function activeGuardById(id: string): Promise<any | null> {
  const oid = objectId(id);
  if (!oid) return null;
  await connectToDatabase();
  const guard = await mongoose.connection.collection('apguards').findOne({ _id: oid });
  return guard && await allowed(guard) ? guard : null;
}

/** Ops remains authoritative; an AP-compatible projection serves existing duty APIs. */
export async function activeGuardByPhone(phone: string): Promise<any | null> {
  const pattern = guardPhonePattern(phone);
  await connectToDatabase();
  const db = mongoose.connection;
  const candidates = await db.collection('apguards').find({ phone: pattern }).toArray();
  const active = [];
  for (const guard of candidates) if (await allowed(guard)) active.push(guard);
  if (active.length > 1) throw new Error('Multiple guard records use this number. Contact your agency.');
  if (active.length === 1) return active[0];
  const records = await db.collection('ops_records').find({ module: 'guards', $or: [
    { 'payload.phone': pattern }, { 'data.phone': pattern },
  ] }).toArray();
  const eligible = [];
  for (const source of records) {
    const data = { ...source.data, ...source.payload };
    if (source.guardAppProvisioned && !await db.collection('apguards').findOne({ _id: source._id })) continue;
    if (!inactive(source) && !inactive(data) && pattern.test(String(data.phone)) &&
      (!data.agencyId || await agencyExists(String(data.agencyId)))) eligible.push({ source, data });
  }
  if (eligible.length > 1) throw new Error('Multiple guard records use this number. Contact Operations.');
  if (!eligible.length) return null;
  const { source, data } = eligible[0];
  const guard = {
    name: data.name || data.guardName, phone: data.phone, id: data.serviceId || String(source._id),
    empId: data.serviceId || '', city: data.city || '', branch: data.branch || '',
    type: data.guardType || data.type || 'Gate Guard', agencyId: data.agencyId || '',
    agencyName: data.agency || 'SURAKSHA Security Ops', status: 'Active', registrationStatus: 'APPROVED',
    authSource: 'ops', opsRecordId: String(source._id),
  };
  await db.collection('apguards').updateOne({ _id: source._id }, {
    $set: { ...guard, updatedAt: new Date() }, $setOnInsert: { isOnline: false, createdAt: new Date() },
  }, { upsert: true });
  await db.collection('ops_records').updateOne({ _id: source._id, module: 'guards' }, { $set: { guardAppProvisioned: true } });
  return db.collection('apguards').findOne({ _id: source._id });
}

export const guardRemoved = {
  success: false, exists: false, action: 'LOGOUT', code: 'guard_removed',
  message: 'Your guard account or agency is not active. Contact your agency or Operations.',
};
