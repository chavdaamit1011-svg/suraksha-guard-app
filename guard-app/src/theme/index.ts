/**
 * Suraksha Guard — design tokens.
 * Mirrors the web guard portal: near-black ground, gold primary, emerald "on duty",
 * amber "warning", red "danger/SOS". Colour is never the only signal (PRD 18.3):
 * every status pairs a colour with an icon + text at the call site.
 */

export const colors = {
  // Ground
  bg: '#0B0D0F',
  bgElevated: '#141619',
  card: '#1E1F22',
  cardTranslucent: 'rgba(30,31,34,0.6)',
  border: 'rgba(255,255,255,0.08)',
  borderStrong: 'rgba(255,255,255,0.16)',

  // Brand
  primary: '#F5C623', // Suraksha gold
  primaryDark: '#E0B41C',
  onPrimary: '#0B0D0F',

  // Status
  offDuty: '#6B7280',
  onDuty: '#10B981', // emerald
  onDutyDim: 'rgba(16,185,129,0.12)',
  warning: '#F59E0B', // amber
  warningDim: 'rgba(245,158,11,0.12)',
  danger: '#EF4444', // red / SOS
  dangerDim: 'rgba(239,68,68,0.12)',
  info: '#3B82F6',

  // Text
  text: '#FFFFFF',
  textMuted: '#94A3B8',
  textFaint: '#64748B',
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

/** Field-UX: large touch targets for low-literacy users on entry-level phones (PRD 18.17). */
export const touch = {
  // PRD 18.17.1 asks 88 dp; the owner found that too big on real phones (2026-09-18). 52 dp is still above the 48 dp minimum.
  primaryButtonHeight: 52,
  hugeButtonHeight: 64, // the single CHECK IN / CHECK OUT action
  tile: 68,
  minTap: 48,
} as const;

export const font = {
  h1: 28,
  h2: 22,
  h3: 18,
  body: 16,
  label: 13,
  tiny: 11,
} as const;

export type ThemeColors = typeof colors;
