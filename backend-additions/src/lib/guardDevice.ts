import { GuardAppProfile } from '@/lib/models/GuardAppProfile';

/**
 * Device binding standing (PRD 18.1 §9, 18.6, SUR-GAP-006).
 *
 * One active device per guard account. The binding exists because a guard account on two phones
 * is the cheapest attendance fraud there is: one person carries both handsets and marks two
 * people present. A second device therefore does not simply take over — it raises an approval
 * task, and duty data is withheld from it until an Operations Manager approves.
 *
 * Kept in `lib` rather than beside the route because `/guard/today` calls it on every bundle
 * fetch: revoking a device then takes effect on its next poll, not at its next login.
 */

export type DeviceStanding =
  /** This device holds the binding. */
  | 'ok'
  /** A second device, waiting on an Operations Manager. Duty data is withheld. */
  | 'change_pending'
  /** A third device while a change is already pending. Duty data is withheld. */
  | 'blocked'
  /** No binding yet, or the caller sent no device id — nothing to enforce. */
  | 'unbound';

export type DeviceCheck = {
  standing: DeviceStanding;
  boundDeviceId: string;
  pendingDeviceId: string;
  /** Whether duty data may be served to this device. */
  allowed: boolean;
};

export async function deviceStanding(guardId: string, deviceId: string | null): Promise<DeviceCheck> {
  const profile: any = await GuardAppProfile.findOne({ guardId }).lean().catch(() => null);
  const boundDeviceId: string = profile?.boundDeviceId ?? '';
  const pendingDeviceId: string = profile?.pendingDeviceId ?? '';

  const shape = (standing: DeviceStanding): DeviceCheck => ({
    standing,
    boundDeviceId,
    pendingDeviceId,
    allowed: standing === 'ok' || standing === 'unbound',
  });

  // An older app build sends no device id. We cannot enforce a binding we were not told about,
  // and refusing everyone mid-rollout would be worse than the risk — so this degrades to open.
  if (!deviceId) return shape('unbound');
  if (!boundDeviceId) return shape('unbound');
  if (boundDeviceId === deviceId) return shape('ok');
  if (pendingDeviceId === deviceId) return shape('change_pending');
  return shape('blocked');
}
