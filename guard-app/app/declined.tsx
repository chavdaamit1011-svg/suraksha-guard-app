import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Button, Muted, Screen } from '@/components/ui';
import { useAuth } from '@/store/auth';
import { colors, font, radius, space } from '@/theme';

/**
 * Shown when an OPS admin has declined the guard's registration.
 * Displays the reason (if any) and directs the guard to contact support.
 */
export default function Declined() {
  const router = useRouter();
  const logout = useAuth((s) => s.logout);
  const { msg } = useLocalSearchParams<{ msg?: string }>();

  const declineReason = msg && msg !== 'undefined' && msg !== ''
    ? decodeURIComponent(msg)
    : 'Your profile has been declined. Please contact support for more information.';

  const handleLogout = async () => {
    await logout();
    router.replace('/login');
  };

  return (
    <Screen>
      <View style={styles.container}>
        <View style={styles.iconWrap}>
          <Ionicons name="close-circle-outline" size={56} color={colors.danger} />
        </View>

        <Text style={styles.title}>Profile Declined</Text>

        <View style={styles.reasonCard}>
          <Text style={styles.reasonLabel}>Reason</Text>
          <Text style={styles.reasonText}>{declineReason}</Text>
        </View>

        <Muted style={{ textAlign: 'center', marginTop: space.md }}>
          Please review the reason above and contact your agency or Suraksha support to re-apply.
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

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.lg },
  iconWrap: {
    width: 96, height: 96, borderRadius: 48,
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderWidth: 1.5, borderColor: 'rgba(239,68,68,0.3)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: space.sm,
  },
  title: { color: colors.text, fontSize: font.h2, fontWeight: '800', textAlign: 'center' },
  reasonCard: {
    backgroundColor: colors.dangerDim,
    borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)',
    borderRadius: radius.lg, padding: space.lg, width: '100%', gap: space.xs,
  },
  reasonLabel: { color: colors.danger, fontSize: font.tiny, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  reasonText: { color: colors.text, fontSize: font.body, lineHeight: 22 },
});
