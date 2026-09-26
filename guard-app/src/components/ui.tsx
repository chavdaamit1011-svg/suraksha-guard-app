import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, font, radius, space, touch } from '@/theme';

export function Screen({ children, scroll = true, style }: { children: React.ReactNode; scroll?: boolean; style?: ViewStyle }) {
  const Body = scroll ? ScrollView : View;
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Body
        style={{ flex: 1 }}
        contentContainerStyle={scroll ? [styles.scrollContent, style] : undefined}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </Body>
    </SafeAreaView>
  );
}

export function H1({ children }: { children: React.ReactNode }) {
  return <Text style={styles.h1}>{children}</Text>;
}
export function H2({ children }: { children: React.ReactNode }) {
  return <Text style={styles.h2}>{children}</Text>;
}
export function Muted({ children, style }: { children: React.ReactNode; style?: any }) {
  return <Text style={[styles.muted, style]}>{children}</Text>;
}
export function Body({ children, style }: { children: React.ReactNode; style?: any }) {
  return <Text style={[styles.body, style]}>{children}</Text>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'primary',
  loading,
  disabled,
  icon,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost' | 'danger' | 'success';
  size?: 'primary' | 'huge' | 'small';
  loading?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
}) {
  const bg =
    variant === 'primary' ? colors.primary : variant === 'danger' ? colors.danger : variant === 'success' ? colors.onDuty : 'transparent';
  const fg = variant === 'primary' ? colors.onPrimary : colors.text;
  const height = size === 'huge' ? touch.hugeButtonHeight : size === 'small' ? touch.minTap : touch.primaryButtonHeight;
  const isDisabled = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: bg, height, opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1 },
        variant === 'ghost' && styles.btnGhost,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={styles.btnRow}>
          {icon}
          <Text style={[styles.btnText, { color: fg, fontSize: size === 'huge' ? font.h3 : font.body }]}>{label}</Text>
        </View>
      )}
    </Pressable>
  );
}

export function Field({ label, style, ...props }: { label?: string } & TextInputProps) {
  return (
    <View style={{ gap: space.xs }}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      <TextInput placeholderTextColor={colors.textFaint} style={[styles.input, style]} {...props} />
    </View>
  );
}

/** A full-width status band: colour + icon + text (never colour alone — PRD 18.3). */
export function StatusBand({
  tone,
  icon,
  text,
  onPress,
}: {
  tone: 'off' | 'on' | 'warn' | 'danger';
  icon?: React.ReactNode;
  text: string;
  onPress?: () => void;
}) {
  const map = {
    off: [colors.offDuty, '#4B5563'],
    on: [colors.onDuty, '#059669'],
    warn: [colors.warning, '#D97706'],
    danger: [colors.danger, '#DC2626'],
  } as const;
  const [a, b] = map[tone];
  const content = (
    <LinearGradient colors={[a, b]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.band}>
      {icon}
      <Text style={styles.bandText}>{text}</Text>
    </LinearGradient>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [pressed && { opacity: 0.85 }]}
        accessibilityRole="button"
      >
        {content}
      </Pressable>
    );
  }
  return content;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  // The persistent SOS button floats over every screen (PRD 18.3 §5). Reserve its footprint at
  // the end of the scroll so it can never sit on top of a tappable control — a quick-grid tile
  // hidden under SOS is a tile the guard simply cannot reach.
  scrollContent: { padding: space.lg, paddingBottom: space.lg + 108, gap: space.lg },
  h1: { color: colors.text, fontSize: font.h1, fontWeight: '900', letterSpacing: -0.5 },
  h2: { color: colors.text, fontSize: font.h2, fontWeight: '800' },
  body: { color: colors.text, fontSize: font.body },
  muted: { color: colors.textMuted, fontSize: font.label },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    gap: space.sm,
  },
  btn: { borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg },
  btnGhost: { borderWidth: 1, borderColor: colors.border },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  btnText: { fontWeight: '800', letterSpacing: 0.2 },
  fieldLabel: { color: colors.textFaint, fontSize: font.tiny, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  input: {
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: font.body,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: touch.minTap,
  },
  band: { minHeight: 48, borderRadius: radius.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingHorizontal: space.lg },
  bandText: { color: '#fff', fontSize: font.body + 1, fontWeight: '800' },
});
