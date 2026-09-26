import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Button, Muted, Screen } from '@/components/ui';
import { api, e164 } from '@/lib/api';
import { secure, store, KEYS } from '@/lib/storage';
import { useAuth } from '@/store/auth';
import { colors, font, radius, space } from '@/theme';

/**
 * Shown after a guard submits a self-registration or tries logging in while under review.
 * Polls the backend in real-time so as soon as an OPS admin approves the guard,
 * the status changes to 'Approved Successfully', saves the session, and prompts for PIN setup.
 */
export default function PendingApproval() {
  const router = useRouter();
  const params = useLocalSearchParams<{ phone?: string; guardId?: string }>();
  const setGuard = useAuth((s) => s.setGuard);
  const hasPin = useAuth((s) => s.hasPin);
  const logout = useAuth((s) => s.logout);
  const existingGuard = useAuth((s) => s.guard);

  const [storedPhone, setStoredPhone] = useState<string>('');
  const [storedGuardId, setStoredGuardId] = useState<string>('');
  const [checking, setChecking] = useState(false);
  const [isApproved, setIsApproved] = useState(false);
  const [approvedGuard, setApprovedGuard] = useState<any | null>(null);
  const isNavigating = useRef(false);

  useEffect(() => {
    // Load phone and guardId from params, secure storage, or local storage
    async function loadIdentifiers() {
      const pPhone = params.phone || '';
      const pGid = params.guardId || '';
      const sPhone = (await secure.get('sg.pendingPhone')) || (await store.getJSON<string>('sg.pendingPhone', '')) || '';
      const sGid = (await secure.get('sg.pendingGuardId')) || (await store.getJSON<string>('sg.pendingGuardId', '')) || '';

      const finalPhone = pPhone || sPhone || existingGuard?.phone || '';
      const finalGid = pGid || sGid || existingGuard?._id || existingGuard?.id || '';

      setStoredPhone(finalPhone);
      setStoredGuardId(finalGid);
    }
    loadIdentifiers();
  }, [params.phone, params.guardId, existingGuard]);

  const checkStatus = async () => {
    if (isNavigating.current) return;
    setChecking(true);
    try {
      const queryPhone = storedPhone || params.phone || existingGuard?.phone || '';
      const queryGid = storedGuardId || params.guardId || existingGuard?._id || existingGuard?.id || '';

      const res = await api.checkStatus(queryPhone ? e164(queryPhone) : undefined, queryGid || undefined);

      if (res.success && (res.isApproved || res.registrationStatus === 'APPROVED')) {
        if (res.guard && !isNavigating.current) {
          isNavigating.current = true;
          setIsApproved(true);
          setApprovedGuard(res.guard);

          // Save guard session
          await setGuard(res.guard, {
            token: res.sessionToken ?? null,
            expiresAt: res.sessionExpiresAt ?? null,
          });

          // Clean up pending registration storage
          await secure.del('sg.pendingPhone').catch(() => {});
          await secure.del('sg.pendingGuardId').catch(() => {});
          await store.del('sg.pendingPhone').catch(() => {});
          await store.del('sg.pendingGuardId').catch(() => {});

          // Wait a moment so guard sees "Approved Successfully!", then route to PIN setup or home
          setTimeout(() => {
            router.replace(hasPin ? '/home' : '/pin?mode=set');
          }, 1500);
        }
      } else if (res.registrationStatus === 'DECLINED') {
        if (!isNavigating.current) {
          isNavigating.current = true;
          router.replace(`/declined?msg=${encodeURIComponent(res.message || '')}`);
        }
      }
    } catch (e) {
      // ignore network errors during interval polling
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    // Initial check
    checkStatus();

    // Auto-poll backend every 2.5 seconds
    const interval = setInterval(checkStatus, 2500);
    return () => clearInterval(interval);
  }, [storedPhone, storedGuardId]);

  const handleLogout = async () => {
    await logout();
    router.replace('/login');
  };

  return (
    <Screen>
      <View style={styles.container}>
        {/* Status Icon */}
        <View style={[styles.iconWrap, isApproved && styles.iconWrapApproved]}>
          {isApproved ? (
            <Ionicons name="checkmark-circle" size={60} color="#10B981" />
          ) : (
            <Ionicons name="time-outline" size={56} color={colors.primary} />
          )}
        </View>

        {/* Header Title */}
        <Text style={[styles.title, isApproved && styles.titleApproved]}>
          {isApproved ? 'Approved Successfully!' : 'Profile Under Review'}
        </Text>

        {/* Subtitle */}
        <Text style={styles.subtitle}>
          {isApproved
            ? `Welcome ${approvedGuard?.name || 'Officer'}! Your registration has been approved. Redirecting to PIN setup…`
            : 'Your registration has been submitted. Our team is verifying your details.'}
        </Text>

        {/* Status Progress Steps */}
        <View style={[styles.stepsCard, isApproved && styles.stepsCardApproved]}>
          <Step num="1" label="Registration submitted" done />
          <Step
            num="2"
            label="OPS team reviews your documents"
            done={isApproved}
            active={!isApproved}
          />
          <Step
            num="3"
            label={isApproved ? 'Approved — Setting up PIN…' : 'Instant approval & PIN setup'}
            done={isApproved}
            active={isApproved}
          />
        </View>

        {/* Real-time Status Badge */}
        {!isApproved ? (
          <View style={styles.statusBadge}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.statusBadgeText}>
              Auto-detecting OPS approval in real-time…
            </Text>
          </View>
        ) : (
          <View style={styles.approvedBadge}>
            <Ionicons name="shield-checkmark" size={18} color="#10B981" />
            <Text style={styles.approvedBadgeText}>
              Account Active · Loading Security PIN Screen…
            </Text>
          </View>
        )}

        {/* Action Buttons */}
        <View style={{ width: '100%', gap: space.sm, marginTop: space.md }}>
          {!isApproved ? (
            <>
              <Button
                label={checking ? 'Checking Status…' : 'Check Status Now'}
                variant="primary"
                onPress={checkStatus}
                disabled={checking}
              />
              <Button
                label="Back to Login"
                variant="ghost"
                onPress={handleLogout}
              />
            </>
          ) : (
            <Button
              label="Proceed to PIN Setup"
              onPress={() => router.replace(hasPin ? '/home' : '/pin?mode=set')}
            />
          )}
        </View>
      </View>
    </Screen>
  );
}

function Step({
  num,
  label,
  done,
  active,
}: {
  num: string;
  label: string;
  done?: boolean;
  active?: boolean;
}) {
  return (
    <View style={styles.step}>
      <View
        style={[
          styles.stepNum,
          done && styles.stepDone,
          active && !done && styles.stepActive,
        ]}
      >
        {done ? (
          <Ionicons name="checkmark" size={14} color="#000" />
        ) : (
          <Text
            style={[
              styles.stepNumText,
              active && { color: colors.primary, fontWeight: '800' },
            ]}
          >
            {num}
          </Text>
        )}
      </View>
      <Text
        style={[
          styles.stepLabel,
          done && { color: '#10B981', fontWeight: '700' },
          active && !done && { color: colors.text, fontWeight: '600' },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    paddingVertical: space.xl,
  },
  iconWrap: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: 'rgba(245,198,35,0.1)',
    borderWidth: 1.5,
    borderColor: 'rgba(245,198,35,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  iconWrapApproved: {
    backgroundColor: 'rgba(16,185,129,0.15)',
    borderColor: 'rgba(16,185,129,0.5)',
  },
  title: {
    color: colors.text,
    fontSize: font.h2,
    fontWeight: '800',
    textAlign: 'center',
  },
  titleApproved: {
    color: '#10B981',
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: font.body,
    textAlign: 'center',
    lineHeight: 22,
    paddingHorizontal: space.sm,
  },
  stepsCard: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: space.lg,
    width: '100%',
    gap: space.md,
    marginTop: space.xs,
  },
  stepsCardApproved: {
    backgroundColor: 'rgba(16,185,129,0.06)',
    borderColor: 'rgba(16,185,129,0.3)',
  },
  step: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  stepNum: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDone: {
    backgroundColor: '#10B981',
    borderColor: '#10B981',
  },
  stepActive: {
    backgroundColor: 'rgba(245,198,35,0.15)',
    borderColor: colors.primary,
  },
  stepNumText: {
    color: colors.textFaint,
    fontSize: font.tiny,
    fontWeight: '700',
  },
  stepLabel: {
    color: colors.textMuted,
    fontSize: font.label,
    flex: 1,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderWidth: 1,
    borderColor: 'rgba(245,198,35,0.25)',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    marginTop: space.xs,
  },
  statusBadgeText: {
    color: colors.primary,
    fontSize: font.tiny,
    fontWeight: '600',
  },
  approvedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: 'rgba(16,185,129,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.4)',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    marginTop: space.xs,
  },
  approvedBadgeText: {
    color: '#10B981',
    fontSize: font.tiny,
    fontWeight: '700',
  },
});
