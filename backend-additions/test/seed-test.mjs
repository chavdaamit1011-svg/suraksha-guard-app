/**
 * Seed an isolated test database (suraksha_guardtest) with the roster data the production DB
 * does not have, so the new guard endpoints can be exercised end to end.
 * Production `suraksha` is never touched.
 */
import mongoose from 'mongoose';

const URI = 'mongodb://127.0.0.1:27017/suraksha_guardtest';
await mongoose.connect(URI);
const db = mongoose.connection.db;

// Wipe so the seed is repeatable.
for (const c of await db.listCollections().toArray()) await db.collection(c.name).deleteMany({});

const oid = (hex) => new mongoose.Types.ObjectId(hex);

const AGENCY_ID = '6a9288474698fca31e3ff146';
const GUARD_A = oid('6a92b25401423c3f1254b11b'); // day shift, live now
const GUARD_B = oid('6a92b25401423c3f1254b11c'); // night shift, wake checks
const SITE_ID = oid('6aa5407a01ea69c1870a1fcd');

// --- IST helpers, mirroring guardRoster.ts ---
const MS_MIN = 60_000;
const IST = 330;
const istKey = (d = new Date()) => new Date(d.getTime() + IST * MS_MIN).toISOString().slice(0, 10);
const istHHMM = (d) => new Date(d.getTime() + IST * MS_MIN).toISOString().slice(11, 16);
const addDays = (key, n) => {
  const d = new Date(`${key}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const now = new Date();
const today = istKey(now);
const tomorrow = addDays(today, 1);

// Guard A's shift is deliberately live *right now*: started an hour ago, ends in seven.
// The roster row belongs to the IST day the shift STARTED on, which is not necessarily today —
// run this at 00:45 and the shift began yesterday. Getting that wrong is exactly the bug the
// "shift, not calendar day" rule exists to prevent.
const liveStartAt = new Date(now.getTime() - 60 * MS_MIN);
const liveDate = istKey(liveStartAt);
const liveStart = istHHMM(liveStartAt);
const liveEnd = istHHMM(new Date(now.getTime() + 7 * 60 * MS_MIN));

// Guard B works a 20:00–08:00 night shift that is live right now, so the wake-check window
// (23:00–05:30) overlaps the current time and the schedule actually generates.
const nightDate = istKey(new Date(now.getTime() - 5 * 60 * MS_MIN));

const SITE_LAT = 30.7333; // Chandigarh
const SITE_LNG = 76.7794;

await db.collection('apguards').insertMany([
  {
    _id: GUARD_A,
    id: 'G-TEST-A',
    name: 'Ravi Kumar Singh',
    phone: '+919876500001',
    city: 'Chandigarh',
    agencyId: AGENCY_ID,
    agencyName: 'Srn',
    branch: 'Srn - HQ',
    status: 'Active',
    type: 'Gate Guard',
    pvStatus: 'PV Done',
    kycVerified: true,
    registrationStatus: 'APPROVED',
    isOnline: false,
    // Agencies store wage as free text; the earnings estimate has to parse whatever it finds.
    wage: '₹16,500',
    initials: 'RS',
  },
  {
    _id: GUARD_B,
    id: 'G-TEST-B',
    name: 'Suresh Patil',
    phone: '+919876500002',
    city: 'Chandigarh',
    agencyId: AGENCY_ID,
    agencyName: 'Srn',
    branch: 'Srn - HQ',
    status: 'Active',
    type: 'Patrol Guard',
    pvStatus: 'Pending',
    kycVerified: false,
    registrationStatus: 'APPROVED',
    isOnline: false,
    wage: '18000',
    initials: 'SP',
  },
]);

/**
 * Free guards, rostered nowhere, at increasing distances from the site. Replacement dispatch
 * needs candidates who are actually available — without these the engine correctly finds nobody,
 * which is right but untestable.
 */
const FREE_GUARDS = [
  { name: 'Karan Verma', phone: '+919876500011', lat: 30.7355, lng: 76.7801, km: '~0.3' },
  { name: 'Sohan Lal', phone: '+919876500012', lat: 30.7500, lng: 76.8000, km: '~3' },
  { name: 'Vikram Singh', phone: '+919876500013', lat: 30.8500, lng: 76.9000, km: '~18' },
  { name: 'Rohit Sharma', phone: '+919876500014', lat: 0, lng: 0, km: 'unknown' }, // no fix
];

await db.collection('apguards').insertMany(
  FREE_GUARDS.map((g, i) => ({
    _id: new mongoose.Types.ObjectId(),
    id: `G-FREE-${i + 1}`,
    name: g.name,
    phone: g.phone,
    city: 'Chandigarh',
    agencyId: AGENCY_ID,
    agencyName: 'Srn',
    branch: 'Srn - HQ',
    status: 'Active',
    type: 'Gate Guard',
    pvStatus: 'PV Done',
    kycVerified: true,
    registrationStatus: 'APPROVED',
    isOnline: false,
    lat: g.lat,
    lng: g.lng,
    initials: g.name.slice(0, 1),
  }))
);

await db.collection('sites').insertOne({
  _id: SITE_ID,
  agencyId: AGENCY_ID,
  name: 'Tower 9',
  category: 'Gated Community',
  client: 'DLF Cyber City',
  clientId: '',
  guardsRequired: 2,
  geofenceRadius: 120,
  address: 'DLF Tower 9 Society, Chandigarh',
  postOrders:
    'Check every visitor ID at the gate.\nDo not leave the gate unattended.\nLog all vehicles in the register.\nCall the supervisor for any dispute.',
  status: 'Active',
  allocated: 2,
  createdAt: new Date(),
  updatedAt: new Date(),
});

// The overlay that makes the geofence evaluable at all.
await db.collection('guardsiteconfigs').insertOne({
  siteId: String(SITE_ID),
  siteName: 'Tower 9',
  agencyId: AGENCY_ID,
  lat: SITE_LAT,
  lng: SITE_LNG,
  geofenceRadiusM: 120,
  reportingPoint: 'Main Gate, Tower 9',
  checkInWindowBeforeMin: 60,
  checkInWindowAfterMin: 240,
  lateGraceMin: 15,
  autoAbsentAfterMin: 60,
  checkOutEarlyAllowedMin: 30,
  autoCloseAfterMin: 120,
  wakeCheckEnabled: true,
  wakeWindowStart: '23:00',
  wakeWindowEnd: '05:30',
  wakeIntervalMinMin: 45,
  wakeIntervalMaxMin: 90,
  wakeAckWindowSec: 120,
  wakeSelfieRequired: false,
  patrolRoundIntervalMin: 60,
  patrolStrictOrder: false,
  patrolScanRadiusM: 50,
  briefingCards: [],
  uniformRequired: 'Navy uniform, cap, ID card',
  equipmentRequired: ['Torch', 'Whistle', 'Register', 'Baton'],
  escalationContacts: [
    { name: 'Ramesh Yadav', phone: '+919876543210', role: 'supervisor' },
    { name: 'Control Room', phone: '+911722700000', role: 'control_room' },
  ],
  sirenEnabled: true,
  briefingVersion: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const checkpoints = ['Main Gate', 'Back Gate', 'Basement Parking', 'Rooftop'].map((name, i) => ({
  _id: new mongoose.Types.ObjectId(),
  agencyOwnerId: AGENCY_ID,
  siteId: String(SITE_ID),
  siteName: 'Tower 9',
  name,
  scanCode: `SG-TW9-CP${i + 1}`,
  scanType: 'QR',
  order: i + 1,
  createdAt: new Date(),
  updatedAt: new Date(),
}));
await db.collection('patrolcheckpoints').insertMany(checkpoints);

// One authored round starting now, plus one an hour out.
await db.collection('patrolrounds').insertMany([
  {
    agencyOwnerId: AGENCY_ID,
    siteId: String(SITE_ID),
    siteName: 'Tower 9',
    guardId: String(GUARD_A),
    guardName: 'Ravi Kumar Singh',
    scheduledDate: liveDate,
    scheduledTime: new Date(now.getTime() - 5 * MS_MIN).toISOString(),
    status: 'Scheduled',
    checkpointIds: checkpoints.map((c) => String(c._id)),
    scans: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    agencyOwnerId: AGENCY_ID,
    siteId: String(SITE_ID),
    siteName: 'Tower 9',
    guardId: String(GUARD_A),
    guardName: 'Ravi Kumar Singh',
    scheduledDate: liveDate,
    scheduledTime: new Date(now.getTime() + 55 * MS_MIN).toISOString(),
    status: 'Scheduled',
    checkpointIds: checkpoints.map((c) => String(c._id)),
    scans: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
]);

await db.collection('agencyrosters').insertMany([
  {
    agencyId: AGENCY_ID,
    agencyName: 'Srn',
    clientName: 'DLF Cyber City',
    siteName: 'Tower 9',
    shiftType: 'Day Shift (8h)',
    timing: `${liveStart} - ${liveEnd}`,
    date: liveDate,
    guardsNeeded: 1,
    assignedGuards: [
      { guardId: GUARD_A, guardName: 'Ravi Kumar Singh', guardPhone: '+919876500001', guardEmpId: 'G-TEST-A', status: 'Scheduled', isReliever: false, replacementType: 'none' },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    agencyId: AGENCY_ID,
    agencyName: 'Srn',
    clientName: 'DLF Cyber City',
    siteName: 'Tower 9',
    shiftType: 'Night Shift (12h)',
    timing: '20:00 - 08:00',
    date: nightDate,
    guardsNeeded: 1,
    assignedGuards: [
      { guardId: GUARD_B, guardName: 'Suresh Patil', guardPhone: '+919876500002', guardEmpId: 'G-TEST-B', status: 'Scheduled', isReliever: true, replacedGuardName: 'Sohan Lal', replacementType: 'temporary' },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    agencyId: AGENCY_ID,
    agencyName: 'Srn',
    clientName: 'DLF Cyber City',
    siteName: 'Tower 9',
    shiftType: 'Day Shift (12h)',
    timing: '08:00 AM - 08:00 PM', // exercises the 12-hour / meridiem parser branch
    date: tomorrow,
    guardsNeeded: 1,
    assignedGuards: [
      { guardId: GUARD_A, guardName: 'Ravi Kumar Singh', guardPhone: '+919876500001', guardEmpId: 'G-TEST-A', status: 'Scheduled', isReliever: false, replacementType: 'none' },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
]);

console.log(JSON.stringify(
  {
    db: 'suraksha_guardtest',
    nowIst: istHHMM(now),
    today,
    tomorrow,
    liveShift: `${liveDate} ${liveStart} - ${liveEnd}`,
    nightShift: `${nightDate} 20:00 - 08:00`,
    guardA: String(GUARD_A),
    guardB: String(GUARD_B),
    freeGuards: FREE_GUARDS.map((g) => `${g.name} (${g.km})`),
    siteId: String(SITE_ID),
    site: { lat: SITE_LAT, lng: SITE_LNG, radiusM: 120 },
    checkpointCodes: checkpoints.map((c) => c.scanCode),
    checkpointIds: checkpoints.map((c) => String(c._id)),
  },
  null,
  2
));

await mongoose.disconnect();
