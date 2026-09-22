/**
 * Training: catalogue, lesson progress, server-side quiz grading, certificates, expiry.
 * Runs against the staging server and test DB.
 */
import mongoose from 'mongoose';

const BASE = 'http://127.0.0.1:4546';
const GUARD_A = '6a92b25401423c3f1254b11b';
const GUARD_B = '6a92b25401423c3f1254b11c';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''}`);
  }
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

await mongoose.connect('mongodb://127.0.0.1:27017/suraksha_guardtest');
const db = mongoose.connection.db;
await db.collection('guardtrainingrecords').deleteMany({});

console.log('\n================ 1. THE CATALOGUE ================');
const anon = await api('/api/guard/training');
check('catalogue served without a guardId', anon.json.success === true, anon.status);
check('modules returned', (anon.json.modules?.length ?? 0) >= 4, anon.json.modules?.length);
check('version returned so devices know to re-download', typeof anon.json.version === 'number', anon.json.version);

const induction = anon.json.modules.find((m) => m.id === 'induction');
check('lesson bodies come down in full (offline use)', induction?.lessons?.[0]?.body?.en?.length > 50, induction?.lessons?.[0]?.body?.en?.length);
check('content is localised', !!induction?.lessons?.[0]?.body?.hi, Object.keys(induction?.lessons?.[0]?.body ?? {}));
check('quiz questions come down', (induction?.quiz?.length ?? 0) >= 3, induction?.quiz?.length);
check('every quiz option carries an icon (picture-based)', induction.quiz.every((q) => q.options.every((o) => !!o.icon)));

console.log('\n--- the answer key never leaves the server ---');
const leaked = JSON.stringify(anon.json).includes('correctOptionId');
check('no correctOptionId anywhere in the response', !leaked);

console.log('\n================ 2. PROGRESS ================');
const withGuard = await api(`/api/guard/training?guardId=${GUARD_A}`);
check('progress attached per module', !!withGuard.json.modules[0].progress, withGuard.json.modules[0]);
check('starts Pending', withGuard.json.modules[0].progress.status === 'Pending', withGuard.json.modules[0].progress.status);
check('mandatory outstanding counted', withGuard.json.mandatoryOutstanding >= 1, withGuard.json.mandatoryOutstanding);

const lesson1 = await api('/api/guard/training', {
  method: 'POST',
  body: { guardId: GUARD_A, moduleId: 'induction', lessonId: 'induction-1', action: 'lesson_done' },
});
check('lesson marked done', lesson1.json.success === true, lesson1.json);
check('one of three complete', lesson1.json.lessonsCompleted?.length === 1, lesson1.json.lessonsCompleted);
check('not all lessons yet', lesson1.json.allLessonsDone === false);

const again = await api('/api/guard/training', {
  method: 'POST',
  body: { guardId: GUARD_A, moduleId: 'induction', lessonId: 'induction-1', action: 'lesson_done' },
});
check('re-opening a lesson does not double-count', again.json.lessonsCompleted?.length === 1, again.json.lessonsCompleted);

const badLesson = await api('/api/guard/training', {
  method: 'POST',
  body: { guardId: GUARD_A, moduleId: 'induction', lessonId: 'made-up', action: 'lesson_done' },
});
check('an unknown lesson is refused', badLesson.status === 400, badLesson.status);

for (const id of ['induction-2', 'induction-3']) {
  await api('/api/guard/training', {
    method: 'POST',
    body: { guardId: GUARD_A, moduleId: 'induction', lessonId: id, action: 'lesson_done' },
  });
}
const afterLessons = await api(`/api/guard/training?guardId=${GUARD_A}`);
const indProgress = afterLessons.json.modules.find((m) => m.id === 'induction').progress;
check('status moves to In Progress', indProgress.status === 'In Progress', indProgress.status);
check('all three lessons recorded', indProgress.lessonsCompleted.length === 3, indProgress.lessonsCompleted);
check('still not passed — the quiz decides that', indProgress.passed === false);

console.log('\n================ 3. QUIZ GRADING ================');
const allWrong = await api('/api/guard/training', {
  method: 'POST',
  body: {
    guardId: GUARD_A,
    moduleId: 'induction',
    action: 'quiz_attempt',
    answers: { 'ind-q1': 'b', 'ind-q2': 'c', 'ind-q3': 'b' },
    studySeconds: 240,
  },
});
check('a wrong sheet scores zero', allWrong.json.scorePct === 0, allWrong.json.scorePct);
check('and does not pass', allWrong.json.passed === false);
check('the pass mark is reported back', allWrong.json.passMarkPct === 70, allWrong.json.passMarkPct);
check('wrong questions identified for review', allWrong.json.wrongQuestionIds?.length === 3, allWrong.json.wrongQuestionIds);
check('no certificate on a fail', allWrong.json.certificateId === '', allWrong.json.certificateId);

const partial = await api('/api/guard/training', {
  method: 'POST',
  body: {
    guardId: GUARD_A,
    moduleId: 'induction',
    action: 'quiz_attempt',
    answers: { 'ind-q1': 'a', 'ind-q2': 'a', 'ind-q3': 'c' },
    studySeconds: 100,
  },
});
check('two of three scores 67%', partial.json.scorePct === 67, partial.json.scorePct);
check('67% is below the 70% pass mark', partial.json.passed === false, partial.json.passed);

const allRight = await api('/api/guard/training', {
  method: 'POST',
  body: {
    guardId: GUARD_A,
    moduleId: 'induction',
    action: 'quiz_attempt',
    answers: { 'ind-q1': 'a', 'ind-q2': 'a', 'ind-q3': 'a' },
    studySeconds: 150,
  },
});
check('all correct scores 100%', allRight.json.scorePct === 100, allRight.json.scorePct);
check('and passes', allRight.json.passed === true);
check('a certificate is issued', /^CERT-INDUCTION-/.test(allRight.json.certificateId ?? ''), allRight.json.certificateId);
check('an expiry is set from the module validity', !!allRight.json.expiresOn, allRight.json.expiresOn);
check('attempt count reported', allRight.json.attemptsSoFar === 3, allRight.json.attemptsSoFar);

console.log('\n--- the attempt history is kept, not overwritten ---');
const rec = await db.collection('guardtrainingrecords').findOne({ guardId: GUARD_A, moduleId: 'induction' });
check('three attempts recorded', rec?.attempts?.length === 3, rec?.attempts?.length);
check('the failures are still there', rec.attempts.filter((a) => !a.passed).length === 2, rec.attempts.map((a) => a.scorePct));
check('best score kept', rec?.bestScorePct === 100, rec?.bestScorePct);
check('study time recorded per attempt', rec.attempts[0].studySeconds === 240, rec.attempts[0].studySeconds);
check('status Completed', rec?.status === 'Completed', rec?.status);
check('certificate signature stored', (rec?.certificateSig ?? '').length === 32, rec?.certificateSig?.length);

console.log('\n--- passing again does not re-issue the certificate ---');
const rePass = await api('/api/guard/training', {
  method: 'POST',
  body: {
    guardId: GUARD_A,
    moduleId: 'induction',
    action: 'quiz_attempt',
    answers: { 'ind-q1': 'a', 'ind-q2': 'a', 'ind-q3': 'a' },
    studySeconds: 20,
  },
});
check('the same certificate id comes back', rePass.json.certificateId === allRight.json.certificateId, {
  first: allRight.json.certificateId,
  again: rePass.json.certificateId,
});

console.log('\n================ 4. MANDATORY COUNT DROPS ================');
const afterPass = await api(`/api/guard/training?guardId=${GUARD_A}`);
const before = withGuard.json.mandatoryOutstanding;
check('outstanding mandatory count went down', afterPass.json.mandatoryOutstanding === before - 1, {
  before,
  after: afterPass.json.mandatoryOutstanding,
});

console.log('\n================ 5. EXPIRY ================');
await db.collection('guardtrainingrecords').updateOne(
  { guardId: GUARD_A, moduleId: 'induction' },
  { $set: { expiresOn: new Date(Date.now() - 24 * 3600_000) } }
);
const expired = await api(`/api/guard/training?guardId=${GUARD_A}`);
const expInd = expired.json.modules.find((m) => m.id === 'induction').progress;
check('a lapsed completion reverts to Pending', expInd.status === 'Pending', expInd.status);
check('and is no longer passed', expInd.passed === false, expInd.passed);
check('and is flagged as expired', expInd.expired === true, expInd.expired);
check('the certificate is withdrawn while expired', expInd.certificateId === '', expInd.certificateId);
check('it counts as outstanding again', expired.json.mandatoryOutstanding === before, expired.json.mandatoryOutstanding);

console.log('\n================ 6. SCOPING AND BAD INPUT ================');
const otherGuard = await api(`/api/guard/training?guardId=${GUARD_B}`);
const otherInd = otherGuard.json.modules.find((m) => m.id === 'induction').progress;
check("another guard's progress is their own", otherInd.status === 'Pending' && otherInd.attempts === 0, otherInd);

const badModule = await api('/api/guard/training', {
  method: 'POST',
  body: { guardId: GUARD_A, moduleId: 'nope', action: 'quiz_attempt', answers: {} },
});
check('unknown module refused', badModule.status === 404, badModule.status);

const badAction = await api('/api/guard/training', {
  method: 'POST',
  body: { guardId: GUARD_A, moduleId: 'induction', action: 'delete_everything' },
});
check('unknown action refused', badAction.status === 400, badAction.status);

const badGuard = await api('/api/guard/training?guardId=not-an-id');
check('invalid guardId gives 400, not a 500', badGuard.status === 400, badGuard.status);

console.log('\n--- an empty answer sheet is a zero, not a crash ---');
const empty = await api('/api/guard/training', {
  method: 'POST',
  body: { guardId: GUARD_B, moduleId: 'fire', action: 'quiz_attempt', answers: {} },
});
check('empty sheet scores zero', empty.json.scorePct === 0, empty.json.scorePct);
check('and does not pass', empty.json.passed === false);

await mongoose.disconnect();
console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
if (fail) console.log('FAILED: ' + failures.join(' | '));
process.exit(fail ? 1 : 0);
