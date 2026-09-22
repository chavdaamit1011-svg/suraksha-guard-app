import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Version gate (PRD SUR-GAP-040): "a forced-update mechanism with a minimum supported version,
 * and a **read-only degraded mode rather than a hard lockout**."
 *
 * Three tiers, because they mean different things:
 *
 *   below `latest`        → a nudge. Everything works.
 *   below `minSupported`  → degraded. The app keeps working for duty — attendance, SOS,
 *                           incidents still go through, because blocking a guard from marking
 *                           duty is worse than an old client (PRD 18.17.1 rule 12) — but the
 *                           features an old client could get wrong are switched off, and a
 *                           persistent banner asks for the update.
 *   below `blockBelow`    → hard block, reserved for a build with a known security or data
 *                           corruption defect. Even then SOS stays reachable.
 *
 * All three are env-driven so a bad release can be fenced off without shipping anything.
 */
export async function GET() {
  const latest = process.env.GUARD_LATEST_VERSION || '1.0.0';
  const minSupported = process.env.GUARD_MIN_VERSION || '1.0.0';
  // Unset by default: a hard block should be a deliberate decision, never the fallback.
  const blockBelow = process.env.GUARD_BLOCK_BELOW_VERSION || '';

  return NextResponse.json({
    success: true,
    latest,
    minSupported,
    blockBelow,
    storeUrl:
      process.env.GUARD_STORE_URL || 'https://play.google.com/store/apps/details?id=in.surakshaguards.guard',
    message: 'A newer version of Suraksha Guard is available.',
    /**
     * The support numbers on the Help screen. Served here (the first call the app makes) rather
     * than compiled in, so a number can change without a release. Empty means "not configured"
     * and the app hides the row instead of dialling a placeholder.
     */
    helpline: process.env.GUARD_HELPLINE || '',
    commandCenter: process.env.GUARD_COMMAND_CENTER_PHONE || '',
    /**
     * What degraded mode switches off. Server-owned so the list can change without a release —
     * which is the whole point, since it is aimed at clients that are already out of date.
     */
    degradedDisables: (process.env.GUARD_DEGRADED_DISABLES || 'offers,training,profile_edit,leave')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  });
}
