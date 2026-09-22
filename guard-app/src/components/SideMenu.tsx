import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Dimensions, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useT } from '@/i18n';
import { useAuth } from '@/store/auth';
import { colors, font, radius, space, touch } from '@/theme';

/**
 * Side menu: everything that has no place on Duty Home. Opened from the avatar on Duty Home.
 * Slides in from the left over a dimmed backdrop; tapping the backdrop or Back closes it.
 */

type Item = { route: string; icon: keyof typeof Ionicons.glyphMap; key: string };

// Every screen has exactly one way in. Not here, because they have their own place on Duty
// Home: Patrol, Incident, Leave, Payslip, Documents, Help (the PRD 18.3 quick grid); Notices (the
// bell); App health (the sync chip).
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

  useEffect(() => {
    if (open) setVisible(true);
    Animated.timing(slide, { toValue: open ? 1 : 0, duration: 220, useNativeDriver: true }).start(() => {
      if (!open) setVisible(false);
    });
  }, [open, slide]);

  const go = (route: string) => {
    onClose();
    router.push(route as any);
  };

  const logout = () => {
    onClose();
    Alert.alert(t('profile.logoutTitle'), t('profile.logoutBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('profile.logout'),
        style: 'destructive',
        onPress: async () => {
          await useAuth.getState().logout();
          router.replace('/login');
        },
      },
    ]);
  };

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
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{(guard?.name ?? 'G').slice(0, 1).toUpperCase()}</Text>
          </View>
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

          <Pressable onPress={logout} style={({ pressed }) => [styles.logout, pressed && { backgroundColor: colors.bgElevated }]}>
            <Ionicons name="log-out-outline" size={22} color={colors.text} />
            <Text style={styles.logoutText}>{t('profile.logout')}</Text>
          </Pressable>
        </ScrollView>
      </Animated.View>
    </Modal>
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
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.primary, fontWeight: '900', fontSize: font.h2 },
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
    borderColor: colors.borderStrong,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  logoutText: { color: colors.text, fontSize: font.body + 1, fontWeight: '900' },
});
