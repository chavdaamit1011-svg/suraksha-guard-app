import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useT } from '@/i18n';
import { resolveMediaUrl } from '@/lib/media';
import { useAuth } from '@/store/auth';
import { colors, font, radius, space } from '@/theme';

/**
 * Side menu: everything that has no place on Duty Home. Opened from the avatar on Duty Home.
 * Slides in from the left over a dimmed backdrop; tapping the backdrop or Back closes it.
 */

type Item = { route: string; icon: keyof typeof Ionicons.glyphMap; key: string };

const ACCOUNT: Item[] = [
  { route: '/profile', icon: 'person-outline', key: 'profile.title' },
  { route: '/roster', icon: 'calendar-outline', key: 'duty.roster' },
  { route: '/details', icon: 'create-outline', key: 'details.title' },
];

const MORE: Item[] = [
  { route: '/training', icon: 'school-outline', key: 'profile.training' },
  { route: '/team', icon: 'people-outline', key: 'profile.team' },
  { route: '/assistant', icon: 'chatbubbles-outline', key: 'profile.assistant' },
  { route: '/language', icon: 'language-outline', key: 'profile.language' },
];

const WIDTH = Math.min(340, Math.round(Dimensions.get('window').width * 0.84));

export function SideMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const guard = useAuth((s) => s.guard);
  const slide = useRef(new Animated.Value(0)).current;
  const [visible, setVisible] = useState(open);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const popupScale = useRef(new Animated.Value(0.9)).current;
  const popupOpacity = useRef(new Animated.Value(0)).current;
  const useNative = Platform.OS !== 'web';

  useEffect(() => {
    if (open) setVisible(true);
    Animated.timing(slide, { toValue: open ? 1 : 0, duration: 220, useNativeDriver: useNative }).start(() => {
      if (!open) setVisible(false);
    });
  }, [open, slide, useNative]);

  useEffect(() => {
    if (showLogoutConfirm) {
      popupScale.setValue(0.9);
      popupOpacity.setValue(0);
      Animated.parallel([
        Animated.spring(popupScale, { toValue: 1, friction: 8, tension: 50, useNativeDriver: useNative }),
        Animated.timing(popupOpacity, { toValue: 1, duration: 180, useNativeDriver: useNative }),
      ]).start();
    }
  }, [showLogoutConfirm, popupScale, popupOpacity, useNative]);

  const go = (route: string) => {
    onClose();
    router.push(route as any);
  };

  const handleLogoutPress = () => {
    setShowLogoutConfirm(true);
  };

  const handleCancelLogout = () => {
    Animated.parallel([
      Animated.timing(popupScale, { toValue: 0.9, duration: 150, useNativeDriver: true }),
      Animated.timing(popupOpacity, { toValue: 0, duration: 150, useNativeDriver: true }),
    ]).start(() => {
      setShowLogoutConfirm(false);
    });
  };

  const handleConfirmLogout = async () => {
    setLoggingOut(true);
    try {
      setShowLogoutConfirm(false);
      onClose();
      await useAuth.getState().logout();
      router.replace('/login');
    } finally {
      setLoggingOut(false);
    }
  };

  const resolvedPhoto = resolveMediaUrl(guard?.profilePhoto || guard?.selfieUrl || guard?.docPhoto);
  const [imageError, setImageError] = useState(false);

  // Reset image error if guard changes
  useEffect(() => {
    setImageError(false);
  }, [guard?._id, guard?.profilePhoto, guard?.selfieUrl]);

  const row = (item: Item) => (
    <Pressable
      key={item.route}
      onPress={() => go(item.route)}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.bgElevated }]}
    >
      <View style={styles.iconBox}>
        <Ionicons name={item.icon} size={20} color={colors.primary} />
      </View>
      <Text style={styles.rowLabel}>{t(item.key)}</Text>
      <Ionicons name="chevron-forward" size={20} color={colors.textFaint} />
    </Pressable>
  );

  return (
    <>
      <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
        <Animated.View style={[styles.backdrop, { opacity: slide.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }) }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel={t('common.cancel')} />
        </Animated.View>

        <Animated.View
          style={[
            styles.panel,
            { width: WIDTH, paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.lg },
            { transform: [{ translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [-WIDTH, 0] }) }] },
          ]}
        >
          <View style={styles.head}>
            <Pressable onPress={() => go('/profile')} style={styles.avatar} accessibilityLabel="Open Profile">
              {resolvedPhoto && !imageError ? (
                <Image
                  source={{ uri: resolvedPhoto }}
                  style={styles.avatarImg}
                  resizeMode="cover"
                  onError={() => setImageError(true)}
                />
              ) : (
                <View style={styles.initialsBox}>
                  <Text style={styles.avatarText}>{(guard?.name ?? 'G').slice(0, 1).toUpperCase()}</Text>
                </View>
              )}
            </Pressable>
            <View style={{ flex: 1 }}>
              <Text style={styles.name} numberOfLines={1}>
                {guard?.name ?? 'Guard'}
              </Text>
              <Text style={styles.phone} numberOfLines={1}>
                {guard?.phone ?? ''}
              </Text>
            </View>
          </View>
          <View style={styles.divider} />

          <ScrollView contentContainerStyle={{ paddingBottom: space.lg }} showsVerticalScrollIndicator={false}>
            <Text style={styles.section}>{t('menu.account')}</Text>
            {ACCOUNT.map(row)}
            <Text style={styles.section}>{t('menu.more')}</Text>
            {MORE.map(row)}

            <Pressable onPress={handleLogoutPress} style={({ pressed }) => [styles.logout, pressed && { backgroundColor: 'rgba(239, 68, 68, 0.12)' }]}>
              <Ionicons name="log-out-outline" size={22} color={colors.danger || '#ef4444'} />
              <Text style={[styles.logoutText, { color: colors.danger || '#ef4444' }]}>{t('profile.logout')}</Text>
            </Pressable>
          </ScrollView>
        </Animated.View>
      </Modal>

      {/* Modern Glassmorphic Logout Confirmation Modal */}
      <Modal
        visible={showLogoutConfirm}
        transparent
        animationType="none"
        onRequestClose={handleCancelLogout}
        statusBarTranslucent
      >
        <View style={styles.modalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={handleCancelLogout} />
          <Animated.View
            style={[
              styles.glassCard,
              {
                opacity: popupOpacity,
                transform: [{ scale: popupScale }],
              },
            ]}
          >
            {/* Top Glow & Badge */}
            <View style={styles.logoutIconBadge}>
              <Ionicons name="log-out" size={26} color="#ef4444" />
            </View>

            {/* Title & Body */}
            <Text style={styles.modalTitle}>{t('profile.logoutTitle') || 'Log out?'}</Text>
            <Text style={styles.modalBody}>
              {t('profile.logoutBody') || 'You will need an OTP to sign in again. You do not need to log out at the end of a shift.'}
            </Text>

            {/* Action Buttons */}
            <View style={styles.buttonRow}>
              <Pressable
                onPress={handleCancelLogout}
                disabled={loggingOut}
                style={({ pressed }) => [
                  styles.cancelBtn,
                  pressed && { backgroundColor: 'rgba(255, 255, 255, 0.14)' },
                ]}
              >
                <Text style={styles.cancelBtnText}>{t('common.cancel') || 'Cancel'}</Text>
              </Pressable>

              <Pressable
                onPress={handleConfirmLogout}
                disabled={loggingOut}
                style={({ pressed }) => [
                  styles.confirmBtn,
                  pressed && { backgroundColor: '#dc2626', opacity: 0.9 },
                ]}
              >
                <Ionicons name="log-out-outline" size={18} color="#FFFFFF" />
                <Text style={styles.confirmBtnText}>{loggingOut ? 'Logging out...' : (t('profile.logout') || 'Log out')}</Text>
              </Pressable>
            </View>
          </Animated.View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)' },
  panel: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: colors.bgElevated,
    borderTopRightRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
    paddingHorizontal: space.lg,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.lg, paddingVertical: space.md },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#1C2028',
    borderWidth: 2,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 4,
  },
  avatarImg: { width: 60, height: 60, borderRadius: 30 },
  initialsBox: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(245, 198, 35, 0.15)',
  },
  avatarText: { color: colors.primary, fontWeight: '900', fontSize: 24 },
  name: { color: colors.text, fontSize: font.h3, fontWeight: '900' },
  phone: { color: colors.textMuted, fontSize: font.label, marginTop: 2 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: space.md },
  section: {
    color: colors.textFaint,
    fontSize: font.label,
    fontWeight: '800',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginTop: space.md,
    marginBottom: space.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    minHeight: 56,
    paddingHorizontal: space.xs,
    borderRadius: radius.md,
  },
  iconBox: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: 'rgba(245,198,35,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowLabel: { flex: 1, color: colors.text, fontSize: font.body, fontWeight: '700' },
  logout: {
    marginTop: space.xl,
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
    backgroundColor: 'rgba(239, 68, 68, 0.06)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  logoutText: { fontSize: font.body + 1, fontWeight: '900' },

  // Custom Glassmorphic Popup Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.78)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: space.lg,
  },
  glassCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: 'rgba(20, 23, 28, 0.96)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderWidth: 1.5,
    borderRadius: 24,
    padding: space.xl,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.55,
    shadowRadius: 24,
    elevation: 20,
  },
  logoutIconBadge: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: 'rgba(239, 68, 68, 0.14)',
    borderColor: 'rgba(239, 68, 68, 0.35)',
    borderWidth: 1.5,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: space.md,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#FFFFFF',
    marginBottom: space.xs,
    textAlign: 'center',
    letterSpacing: -0.2,
  },
  modalBody: {
    fontSize: 13,
    lineHeight: 20,
    color: 'rgba(255, 255, 255, 0.65)',
    textAlign: 'center',
    marginBottom: space.xl,
    paddingHorizontal: space.xs,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: space.sm,
    width: '100%',
  },
  cancelBtn: {
    flex: 1,
    height: 46,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.15)',
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cancelBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#E2E8F0',
  },
  confirmBtn: {
    flex: 1.2,
    height: 46,
    borderRadius: 12,
    backgroundColor: '#ef4444',
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#ef4444',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 4,
  },
  confirmBtnText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#FFFFFF',
  },
});
