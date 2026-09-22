// Read-only probe of the production data the new roster logic depends on.
// Verifies the riskiest assumption: that AgencyRoster.timing parses, and that roster rows
// actually join to Sites by name.
import mongoose from 'mongoose';
import fs from 'fs';

const envText = fs.readFileSync('/home/suraksha/suraksha-new/.env', 'utf8');
const uri = (envText.match(/^MONGODB_URI\s*=\s*(.+)$/m) || envText.match(/^MONGO_URI\s*=\s*(.+)$/m) || [])[1]
  ?.trim()
  .replace(/^["']|["']$/g, '');
if (!uri) {
  console.log('NO MONGODB_URI FOUND. env keys:', [...envText.matchAll(/^([A-Z_]+)=/gm)].map((m) => m[1]).join(','));
  process.exit(1);
}

// --- the parser under test, copied verbatim from guardRoster.ts ---
function parseTiming(timing) {
  const fallback = { start: '09:00', end: '18:00' };
  if (!timing) return fallback;
  const matches = [...timing.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/gi)];
  if (matches.length < 2) return fallback;
  const toHHMM = (m) => {
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2] ?? '0', 10) || 0;
    const mer = (m[3] ?? '').toLowerCase();
    if (mer === 'pm' && h < 12) h += 12;
    if (mer === 'am' && h === 12) h = 0;
    if (h > 23) h = 23;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  };
  return { start: toHHMM(matches[0]), end: toHHMM(matches[1]) };
}

await mongoose.connect(uri);
const db = mongoose.connection.db;

const roster = db.collection('agencyrosters');
const sites = db.collection('sites');

const total = await roster.countDocuments();
console.log(`\n=== AgencyRoster: ${total} rows ===`);

const timings = await roster.distinct('timing');
console.log(`\n=== distinct timing strings (${timings.length}) → parsed ===`);
for (const tm of timings.slice(0, 40)) {
  const p = parseTiming(tm);
  const overnight = p.end <= p.start;
  const suspicious = p.start === '09:00' && p.end === '18:00' && !/9/.test(String(tm));
  console.log(`  ${JSON.stringify(tm).padEnd(28)} -> ${p.start}-${p.end}${overnight ? '  [overnight]' : ''}${suspicious ? '   <-- FELL BACK' : ''}`);
}

const shiftTypes = await roster.distinct('shiftType');
console.log(`\n=== distinct shiftType (${shiftTypes.length}) ===`);
console.log('  ' + shiftTypes.slice(0, 20).map((s) => JSON.stringify(s)).join(', '));

console.log('\n=== roster -> site join by name ===');
const rosterSiteNames = await roster.distinct('siteName');
const siteDocs = await sites.find({}).project({ name: 1, agencyId: 1, geofenceRadius: 1, postOrders: 1 }).toArray();
const siteNames = new Set(siteDocs.map((s) => String(s.name).toLowerCase()));
let matched = 0;
const unmatched = [];
for (const n of rosterSiteNames) {
  if (siteNames.has(String(n).toLowerCase())) matched++;
  else unmatched.push(n);
}
console.log(`  roster site names: ${rosterSiteNames.length}`);
console.log(`  Site collection:   ${siteDocs.length}`);
console.log(`  matched by name:   ${matched}`);
if (unmatched.length) console.log(`  UNMATCHED (${unmatched.length}): ${unmatched.slice(0, 12).map((u) => JSON.stringify(u)).join(', ')}`);

console.log('\n=== sites with post orders / custom geofence ===');
console.log(`  with postOrders text: ${siteDocs.filter((s) => (s.postOrders ?? '').trim()).length}`);
console.log(`  geofenceRadius values: ${[...new Set(siteDocs.map((s) => s.geofenceRadius))].join(', ')}`);

console.log('\n=== guards with roster rows (sample) ===');
const withGuards = await roster
  .find({ 'assignedGuards.0': { $exists: true } })
  .sort({ date: -1 })
  .limit(5)
  .toArray();
for (const r of withGuards) {
  const p = parseTiming(r.timing);
  console.log(
    `  ${r.date}  ${String(r.siteName).slice(0, 24).padEnd(24)}  ${String(r.timing).padEnd(16)} -> ${p.start}-${p.end}  guards=${r.assignedGuards.length}  ids=${r.assignedGuards.map((g) => String(g.guardId).slice(-6)).join(',')}`
  );
}

console.log('\n=== date format check ===');
const dates = await roster.distinct('date');
const bad = dates.filter((d) => !/^\d{4}-\d{2}-\d{2}$/.test(String(d)));
console.log(`  distinct dates: ${dates.length}; non YYYY-MM-DD: ${bad.length}${bad.length ? ' -> ' + bad.slice(0, 5).join(',') : ''}`);
console.log(`  newest: ${dates.sort().slice(-3).join(', ')}`);

console.log('\n=== patrol checkpoints / rounds ===');
console.log(`  patrolcheckpoints: ${await db.collection('patrolcheckpoints').countDocuments()}`);
console.log(`  patrolrounds:      ${await db.collection('patrolrounds').countDocuments()}`);

console.log('\n=== guard-app collections (new) ===');
for (const c of ['guardsiteconfigs', 'guardmedias', 'guardwakeschedules', 'guardattendances', 'guardfieldevents']) {
  console.log(`  ${c.padEnd(22)} ${await db.collection(c).countDocuments()}`);
}

await mongoose.disconnect();
console.log('\nDONE');
