import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Button, Muted, Screen } from '@/components/ui';
import { useAuth } from '@/store/auth';
import { colors, font, radius, space } from '@/theme';

/**
 * Shown after a guard submits a self-registration.
 * They must wait for an OPS admin to approve their profile (up to 48 hours).
 */
export default function PendingApproval() {
  const router = useRouter();
  const logout = useAuth((s) => s.logout);

  const handleLogout = async () => {
    await logout();
    router.replace('/login');
  };

  return (
    <Screen>
      <View style={styles.container}>
        <View style={styles.iconWrap}>
          <Ionicons name="time-outline" size={56} color={colors.primary} />
        </View>

        <Text style={styles.title}>Profile Under Review</Text>
        <Text style={styles.subtitle}>
          Your registration has been submitted successfully. Our team will verify your details within{' '}
          <Text style={{ color: colors.primary, fontWeight: '700' }}>48 hours</Text>.
        </Text>

        <View style={styles.stepsCard}>
          <Step num="1" label="Registration submitted" done />
          <Step num="2" label="OPS team reviews your documents" />
          <Step num="3" label="You receive approval & can log in" />
        </View>

        <Muted style={{ textAlign: 'center', marginTop: space.lg }}>
          You will be notified once your profile is approved. If you have queries, contact your agency or Suraksha support.
        </Muted>

        <View style={{ marginTop: space.xl }}><Button
          label="Back to Login"
          variant="ghost"
          onPress={handleLogout}
        /></View>
      </View>
    </Screen>
  );
}

function Step({ num, label, done }: { num: string; label: string; done?: boolean }) {
  return (
    <View style={styles.step}>
      <View style={[styles.stepNum, done && styles.stepDone]}>
        {done
          ? <Ionicons name="checkmark" size={14} color={colors.onPrimary ?? '#000'} />
          : <Text style={styles.stepNumText}>{num}</Text>}
      </View>
      <Text style={[styles.stepLabel, done && { color: colors.primary }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.lg },
  iconWrap: {
    width: 96, height: 96, borderRadius: 48,
    backgroundColor: 'rgba(245,198,35,0.1)',
    borderWidth: 1.5, borderColor: 'rgba(245,198,35,0.3)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: space.sm,
  },
  title: { color: colors.text, fontSize: font.h2, fontWeight: '800', textAlign: 'center' },
  subtitle: { color: colors.textMuted, fontSize: font.body, textAlign: 'center', lineHeight: 22 },
  stepsCard: {
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.lg, padding: space.lg, width: '100%', gap: space.md, marginTop: space.sm,
  },
  step: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  stepNum: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  stepDone: { backgroundColor: colors.primary, borderColor: colors.primary },
  stepNumText: { color: colors.textFaint, fontSize: font.tiny, fontWeight: '700' },
  stepLabel: { color: colors.textMuted, fontSize: font.label, flex: 1 },
});
