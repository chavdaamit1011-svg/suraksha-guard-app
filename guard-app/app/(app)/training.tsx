import { goBack } from '@/lib/navigation';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import * as Speech from 'expo-speech';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Body, Button, Card, H2, Muted, Screen } from '@/components/ui';
import { useI18n, useT } from '@/i18n';
import {
  api,
  type Localised,
  type TrainingLesson,
  type TrainingModule,
  type TrainingQuestion,
} from '@/lib/api';
import { KEYS, store } from '@/lib/storage';
import { guardId, useAuth } from '@/store/auth';
import { useVersion } from '@/store/version';
import { FeatureOffNotice } from '@/components/UpdateNotice';
import { colors, font, radius, space, touch } from '@/theme';

const CACHE_KEY = 'sg.trainingCatalogue';

/** Guard language → English (PRD 18.2 §9(c)). Never a blank string. */
function pick(v: Localised | undefined, lang: string): string {
  if (!v) return '';
  return v[lang] ?? v.en ?? '';
}

type View_ = 'list' | 'lesson' | 'quiz' | 'result' | 'certificate';

/**
 * Training (PRD 18.14, SUR-GAP-024).
 *
 * Built for someone who reads slowly: every lesson is read aloud in the guard's language, and the
 * quiz options carry an icon each so a question can be answered from the picture and the spoken
 * prompt alone.
 *
 * The whole catalogue is cached on first load, so a guard on a night shift with no signal can
 * still work through a module (18.15.2 allows training offline when pre-downloaded). The quiz is
 * the one part that needs the network: it is graded server-side, because a completion that gates
 * deployment to an armed post cannot be self-certified on the device.
 */
export default function Training() {
  const t = useT();
  const router = useRouter();
  const lang = useI18n((s) => s.lang);
  const guard = useAuth((s) => s.guard);
  const quizOff = useVersion((s) => s.isDisabled('training'));

  const [modules, setModules] = useState<TrainingModule[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View_>('list');
  const [active, setActive] = useState<TrainingModule | null>(null);
  const [lessonIdx, setLessonIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ scorePct: number; passed: boolean; passMark: number; wrong: string[]; certificateId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  const studyStart = useRef(Date.now());

  const load = useCallback(async () => {
    const id = guardId(guard);
    try {
      const res = await api.training(id || undefined);
      setModules(res.modules ?? []);
      await store.setJSON(CACHE_KEY, res.modules ?? []);
    } catch {
      const cached = await store.getJSON<TrainingModule[]>(CACHE_KEY, []);
      setModules(cached);
    } finally {
      setLoading(false);
    }
  }, [guard]);

  useEffect(() => {
    store.getJSON<TrainingModule[]>(CACHE_KEY, []).then((c) => {
      if (c.length) {
        setModules(c);
        setLoading(false);
      }
    });
    load();
  }, [load]);

  useEffect(() => () => void Speech.stop(), []);

  const speak = (text: string) => {
    try {
      Speech.stop();
      setSpeaking(true);
      Speech.speak(text, {
        language: lang === 'en' ? 'en-IN' : 'hi-IN',
        onDone: () => setSpeaking(false),
        onStopped: () => setSpeaking(false),
        onError: () => setSpeaking(false),
      });
    } catch {
      setSpeaking(false);
    }
  };

  const stopSpeaking = () => {
    Speech.stop();
    setSpeaking(false);
  };

  const openModule = (m: TrainingModule) => {
    setActive(m);
    setLessonIdx(0);
    setAnswers({});
    setResult(null);
    studyStart.current = Date.now();
    setView('lesson');
  };

  const nextLesson = async () => {
    if (!active) return;
    stopSpeaking();
    const lesson = active.lessons[lessonIdx];
    const id = guardId(guard);
    // Recorded as we go, so a guard interrupted mid-module keeps their progress.
    if (id && lesson) api.trainingLessonDone(id, active.id, lesson.id).catch(() => {});

    if (lessonIdx + 1 < active.lessons.length) {
      setLessonIdx((i) => i + 1);
    } else {
      setView('quiz');
    }
  };

  const submitQuiz = async () => {
    if (!active) return;
    const id = guardId(guard);
    if (!id) return;
    stopSpeaking();
    setBusy(true);
    try {
      const studySeconds = Math.round((Date.now() - studyStart.current) / 1000);
      const res = await api.trainingQuizAttempt(id, active.id, answers, studySeconds);
      setResult({
        scorePct: res.scorePct,
        passed: res.passed,
        passMark: res.passMarkPct,
        wrong: res.wrongQuestionIds ?? [],
        certificateId: res.certificateId ?? '',
      });
      Haptics.notificationAsync(
        res.passed ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning
      ).catch(() => {});
      setView('result');
      load();
    } catch {
      // The quiz is the one thing that genuinely needs a network. Say so rather than pretending.
      setResult(null);
      setView('quiz');
    } finally {
      setBusy(false);
    }
  };

  // ---------------------------------------------------------------- lesson
  if (view === 'lesson' && active) {
    const lesson: TrainingLesson = active.lessons[lessonIdx];
    const body = pick(lesson.body, lang);
    return (
      <Screen>
        <Header
          title={pick(active.title, lang)}
          onBack={() => {
            stopSpeaking();
            setView('list');
          }}
          onSpeak={speaking ? stopSpeaking : () => speak(`${pick(lesson.title, lang)}. ${body}`)}
          speaking={speaking}
        />

        <View style={styles.progressDots}>
          {active.lessons.map((_, i) => (
            <View key={i} style={[styles.dot, i <= lessonIdx && { backgroundColor: colors.primary }]} />
          ))}
        </View>

        <Card style={styles.lessonCard}>
          <View style={styles.lessonIcon}>
            <Ionicons name={lesson.icon as any} size={36} color={colors.primary} />
          </View>
          <H2>{pick(lesson.title, lang)}</H2>
          <Body style={styles.lessonBody}>{body}</Body>
        </Card>

        <Button
          label={speaking ? t('training.stopReading') : t('training.readAloud')}
          variant="ghost"
          icon={<Ionicons name={speaking ? 'stop' : 'volume-medium'} size={20} color={colors.text} />}
          onPress={speaking ? stopSpeaking : () => speak(`${pick(lesson.title, lang)}. ${body}`)}
        />

        <Button
          label={lessonIdx + 1 < active.lessons.length ? t('training.next') : t('training.startQuiz')}
          size="huge"
          onPress={nextLesson}
          icon={<Ionicons name="arrow-forward" size={24} color={colors.onPrimary} />}
        />
        <Muted style={{ textAlign: 'center' }}>
          {lessonIdx + 1} / {active.lessons.length}
        </Muted>
      </Screen>
    );
  }

  // ------------------------------------------------------------------ quiz
  if (view === 'quiz' && active) {
    const allAnswered = active.quiz.every((q) => answers[q.id]);
    return (
      <Screen>
        <Header
          title={t('training.quiz')}
          onBack={() => {
            stopSpeaking();
            setView('lesson');
          }}
        />
        <Muted>{t('training.quizNote', { mark: active.passMarkPct })}</Muted>

        {active.quiz.map((q: TrainingQuestion, qi) => (
          <View key={q.id} style={{ gap: space.sm }}>
            <View style={styles.qHead}>
              <Text style={styles.qNum}>{qi + 1}</Text>
              <Body style={{ flex: 1, fontWeight: '800' }}>{pick(q.prompt, lang)}</Body>
              <Pressable onPress={() => speak(pick(q.prompt, lang))} hitSlop={10}>
                <Ionicons name="volume-medium" size={22} color={colors.primary} />
              </Pressable>
            </View>

            <View style={styles.options}>
              {q.options.map((o) => {
                const chosen = answers[q.id] === o.id;
                return (
                  <Pressable
                    key={o.id}
                    onPress={() => {
                      setAnswers((a) => ({ ...a, [q.id]: o.id }));
                      Haptics.selectionAsync().catch(() => {});
                    }}
                    style={[styles.option, chosen && styles.optionChosen]}
                  >
                    <Ionicons name={o.icon as any} size={30} color={chosen ? colors.onPrimary : colors.primary} />
                    <Text style={[styles.optionText, chosen && { color: colors.onPrimary }]}>
                      {pick(o.label, lang)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}

        {/* Lessons stay readable in degraded mode; only a graded attempt needs a current client. */}
        {quizOff ? (
          <FeatureOffNotice />
        ) : (
          <>
            <Button
              label={t('training.submitQuiz')}
              size="huge"
              variant="success"
              onPress={submitQuiz}
              loading={busy}
              disabled={!allAnswered || busy}
            />
            {!allAnswered ? <Muted style={{ textAlign: 'center' }}>{t('training.answerAll')}</Muted> : null}
          </>
        )}
      </Screen>
    );
  }

  // ---------------------------------------------------------------- result
  if (view === 'result' && active && result) {
    return (
      <Screen>
        <Header title={pick(active.title, lang)} onBack={() => setView('list')} />

        <Card style={{ ...styles.resultCard, ...(result.passed ? styles.passCard : styles.failCard) }}>
          <Ionicons
            name={result.passed ? 'ribbon' : 'refresh-circle'}
            size={64}
            color={result.passed ? colors.onDuty : colors.warning}
          />
          <Text style={[styles.score, { color: result.passed ? colors.onDuty : colors.warning }]}>
            {result.scorePct}%
          </Text>
          <H2>{result.passed ? t('training.passed') : t('training.notYet')}</H2>
          <Muted style={{ textAlign: 'center' }}>
            {result.passed
              ? t('training.passedNote')
              : t('training.failedNote', { mark: result.passMark })}
          </Muted>
        </Card>

        {!result.passed && result.wrong.length > 0 ? (
          <View style={{ gap: space.sm }}>
            <Muted>{t('training.reviewThese')}</Muted>
            {active.quiz
              .filter((q) => result.wrong.includes(q.id))
              .map((q) => (
                <Card key={q.id} style={styles.rowGap}>
                  <Ionicons name="help-circle" size={20} color={colors.warning} />
                  <Body style={{ flex: 1 }}>{pick(q.prompt, lang)}</Body>
                </Card>
              ))}
          </View>
        ) : null}

        {result.passed && result.certificateId ? (
          <Button
            label={t('training.viewCertificate')}
            variant="success"
            icon={<Ionicons name="ribbon" size={20} color="#fff" />}
            onPress={() => setView('certificate')}
          />
        ) : null}

        <Button
          label={result.passed ? t('training.backToList') : t('training.tryAgain')}
          size="huge"
          onPress={() => {
            if (result.passed) {
              setView('list');
            } else {
              setAnswers({});
              setLessonIdx(0);
              studyStart.current = Date.now();
              setView('lesson');
            }
          }}
        />
      </Screen>
    );
  }

  // ----------------------------------------------------------- certificate
  if (view === 'certificate' && active && result) {
    return (
      <Screen>
        <Header title={t('training.certificate')} onBack={() => setView('result')} />
        <Card style={styles.certCard}>
          <Ionicons name="ribbon" size={56} color={colors.primary} />
          <Muted>{t('training.certifies')}</Muted>
          <H2>{guard?.name ?? ''}</H2>
          <Muted>{t('training.hasCompleted')}</Muted>
          <Text style={styles.certModule}>{pick(active.title, lang)}</Text>
          <Text style={styles.certScore}>
            {t('training.score')} {result.scorePct}%
          </Text>
          <View style={styles.certDivider} />
          <Muted>{t('training.certificateNo')}</Muted>
          <Text style={styles.certId}>{result.certificateId}</Text>
          <Muted style={{ textAlign: 'center' }}>{t('training.certificateNote')}</Muted>
        </Card>
        <Button label={t('training.backToList')} size="huge" onPress={() => setView('list')} />
      </Screen>
    );
  }

  // ------------------------------------------------------------------ list
  const outstanding = modules.filter((m) => m.mandatory && !m.progress?.passed).length;

  return (
    <Screen>
      <Header title={t('training.title')} onBack={() => goBack()} />

      {outstanding > 0 ? (
        <View style={styles.noticeBox}>
          <Ionicons name="alert-circle" size={20} color={colors.warning} />
          <Body style={{ flex: 1, color: colors.warning }}>
            {outstanding} {t('training.mandatoryOutstanding')}
          </Body>
        </View>
      ) : null}

      {loading && modules.length === 0 ? (
        <Card style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          <Muted>{t('common.loading')}</Muted>
        </Card>
      ) : modules.length === 0 ? (
        <Card style={styles.center}>
          <Ionicons name="school-outline" size={36} color={colors.textFaint} />
          <Muted style={{ textAlign: 'center' }}>{t('training.empty')}</Muted>
        </Card>
      ) : (
        modules.map((m) => {
          const p = m.progress;
          const doneCount = p?.lessonsCompleted.length ?? 0;
          const pct = p?.passed ? 100 : Math.round((doneCount / Math.max(1, m.lessons.length)) * 90);
          return (
            <Pressable key={m.id} onPress={() => openModule(m)}>
              <Card style={styles.moduleCard}>
                <ProgressRing pct={pct} passed={!!p?.passed} icon={m.icon} />
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={styles.rowGap}>
                    <Text style={styles.moduleTitle}>{pick(m.title, lang)}</Text>
                    {m.mandatory ? (
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>{t('training.mandatory')}</Text>
                      </View>
                    ) : null}
                  </View>
                  <Muted>{pick(m.summary, lang)}</Muted>
                  <Muted>
                    {m.minutes} {t('training.minutes')} · {m.lessons.length} {t('training.lessons')}
                  </Muted>
                  {p?.expired ? (
                    <Muted style={{ color: colors.warning }}>{t('training.expired')}</Muted>
                  ) : p?.passed ? (
                    <Muted style={{ color: colors.onDuty }}>
                      {t('training.completed')} · {p.bestScorePct}%
                    </Muted>
                  ) : doneCount > 0 ? (
                    <Muted style={{ color: colors.warning }}>
                      {doneCount}/{m.lessons.length} {t('training.lessonsDone')}
                    </Muted>
                  ) : null}
                </View>
                <Ionicons name="chevron-forward" size={20} color={colors.textFaint} />
              </Card>
            </Pressable>
          );
        })
      )}
    </Screen>
  );
}

/** The progress ring from PRD 18.14 GAP-S-062. */
function ProgressRing({ pct, passed, icon }: { pct: number; passed: boolean; icon: string }) {
  const size = 56;
  const stroke = 4;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const dash = (Math.min(100, Math.max(0, pct)) / 100) * circumference;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.border} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={passed ? colors.onDuty : colors.primary}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${dash} ${circumference}`}
          strokeLinecap="round"
          // Start the arc at twelve o'clock rather than three.
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <Ionicons name={(passed ? 'checkmark' : icon) as any} size={24} color={passed ? colors.onDuty : colors.primary} />
    </View>
  );
}

function Header({
  title,
  onBack,
  onSpeak,
  speaking,
}: {
  title: string;
  onBack: () => void;
  onSpeak?: () => void;
  speaking?: boolean;
}) {
  return (
    <View style={styles.head}>
      <Pressable onPress={onBack} hitSlop={12}>
        <Ionicons name="arrow-back" size={24} color={colors.text} />
      </Pressable>
      <H2>{title}</H2>
      {onSpeak ? (
        <Pressable onPress={onSpeak} hitSlop={12}>
          <Ionicons name={speaking ? 'stop-circle' : 'volume-medium'} size={26} color={colors.primary} />
        </Pressable>
      ) : (
        <View style={{ width: 24 }} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  center: { alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingVertical: space.xl },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  noticeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.warningDim,
    borderRadius: radius.md,
    padding: space.md,
  },
  moduleCard: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  moduleTitle: { color: colors.text, fontSize: font.body, fontWeight: '800' },
  badge: { backgroundColor: colors.warningDim, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: 2 },
  badgeText: { color: colors.warning, fontSize: font.tiny, fontWeight: '900', textTransform: 'uppercase' },
  progressDots: { flexDirection: 'row', gap: space.xs, justifyContent: 'center' },
  dot: { width: 28, height: 4, borderRadius: 2, backgroundColor: colors.border },
  lessonCard: { alignItems: 'center', gap: space.md, paddingVertical: space.xl },
  lessonIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(245,198,35,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  lessonBody: { lineHeight: 26, fontSize: font.body },
  qHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  qNum: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.primary,
    color: colors.onPrimary,
    fontWeight: '900',
    textAlign: 'center',
    lineHeight: 26,
  },
  options: { flexDirection: 'row', gap: space.sm },
  option: {
    flex: 1,
    minHeight: 104,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: space.sm,
    backgroundColor: colors.card,
  },
  optionChosen: { backgroundColor: colors.primary, borderColor: colors.primary },
  optionText: { color: colors.text, fontSize: font.tiny, fontWeight: '700', textAlign: 'center' },
  resultCard: { alignItems: 'center', gap: space.sm, paddingVertical: space.xl, borderWidth: 2 },
  passCard: { borderColor: colors.onDuty, backgroundColor: colors.onDutyDim },
  failCard: { borderColor: colors.warning, backgroundColor: colors.warningDim },
  score: { fontSize: 48, fontWeight: '900' },
  certCard: { alignItems: 'center', gap: space.sm, paddingVertical: space.xl, borderColor: colors.primary, borderWidth: 2 },
  certModule: { color: colors.text, fontSize: font.h2, fontWeight: '900', textAlign: 'center' },
  certScore: { color: colors.onDuty, fontSize: font.h3, fontWeight: '800' },
  certDivider: { height: 1, alignSelf: 'stretch', backgroundColor: colors.border, marginVertical: space.sm },
  certId: { color: colors.primary, fontSize: font.body, fontWeight: '900', letterSpacing: 1 },
});
