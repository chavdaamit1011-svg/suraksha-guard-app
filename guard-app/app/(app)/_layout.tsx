import NetInfo from '@react-native-community/netinfo';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState, View } from 'react-native';
import { SosButton } from '@/components/SosButton';
import { api } from '@/lib/api';
import { getLaunchNotificationData, onNotificationResponse } from '@/lib/notifications';
import { flush } from '@/lib/queue';
import { guardId, useAuth } from '@/store/auth';
import { useDuty } from '@/store/duty';
import { colors } from '@/theme';

const BUNDLE_POLL_MS = 30_000; // the duty bundle changes on roster edits, not every second
const TICK_MS = 1_000; // the countdown does

export default function AppLayout() {
  const router = useRouter();
  const refresh = useDuty((s) => s.refresh);
  const tick = useDuty((s) => s.tick);
  const refreshQueued = useDuty((s) => s.refreshQueued);

  // Signed out from outside the app (logout on another phone, phone unlinked by the agency).
  const guard = useAuth((s) => s.guard);
  const currentGuardId = guardId(guard);
  useEffect(() => {
    if (!guard) router.replace('/login');
  }, [guard, router]);

  // Access revocation must not wait behind duty uploads or roster computation.
  useEffect(() => {
    if (!currentGuardId) return;
    let busy = false;
    let disposed = false;
    const check = async () => {
      if (disposed || busy || guardId(useAuth.getState().guard) !== currentGuardId) return;
      busy = true;
      try {
        await api.access(currentGuardId);
      } catch {
        // The API client signs out on guard_removed. Network errors retain offline access.
      } finally {
        busy = false;
      }
    };
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      void check();
      timer ??= setInterval(check, 10000);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    if (AppState.currentState !== 'background') start();
    const state = AppState.addEventListener('change', (value) => {
      if (value === 'active') start();
      else stop();
    });
    const network = NetInfo.addEventListener((value) => {
      if (value.isConnected && value.isInternetReachable !== false && AppState.currentState !== 'background') void check();
    });
    return () => { disposed = true; stop(); state.remove(); network(); };
  }, [currentGuardId]);

  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * A wake-check notification deep-links straight into the full-screen prompt, carrying the
   * server's `wakeId` so the acknowledgement lands against the prompt that actually fired
   * (PRD 18.8). Cold-start is handled too: tapping the notification from a killed app delivers
   * the response through getLastNotificationResponseAsync, not the listener.
   */
  useEffect(() => {
    const open = (data: any) => {
      if (data?.type !== 'wake_check') return;
      const q = new URLSearchParams({ prompt: '1' });
      if (data.wakeId) q.set('wakeId', String(data.wakeId));
      if (data.ackWindowSec) q.set('ackWindowSec', String(data.ackWindowSec));
      if (data.selfieRequired) q.set('selfie', '1');
      if (data.attempt) q.set('attempt', String(data.attempt));
      router.push(`/wake?${q.toString()}` as any);
    };

    getLaunchNotificationData().then((data) => {
      if (data) open(data);
    });

    return onNotificationResponse(open);
  }, [router]);

  // Bundle polling + the one-second countdown tick, both paused when backgrounded.
  useEffect(() => {
    const start = () => {
      useDuty.getState().hydrateBundle(); // instant render from cache, then revalidate
      refresh();
      refreshQueued();
      poll.current ??= setInterval(refresh, BUNDLE_POLL_MS);
      ticker.current ??= setInterval(tick, TICK_MS);
    };
    const stop = () => {
      if (poll.current) clearInterval(poll.current);
      if (ticker.current) clearInterval(ticker.current);
      poll.current = null;
      ticker.current = null;
    };

    start();
    useAuth.getState().touch();
    const sub = AppState.addEventListener('change', async (s) => {
      if (s === 'active') {
        const locked = await useAuth.getState().lockIfIdle();
        const { hasPin, needsPin } = useAuth.getState();
        if (hasPin && (needsPin || locked)) {
          router.replace('/pin?mode=enter');
          return;
        }
        useAuth.getState().touch();
        start();
      } else {
        stop();
      }
    });
    return () => {
      stop();
      sub.remove();
    };
  }, [refresh, tick, refreshQueued, router]);

  /**
   * Flush the moment connectivity returns, rather than waiting for the next poll — a guard who
   * walks out of a basement should see the pending-sync badge clear within seconds
   * (PRD 18.15.3: "immediate retry on connectivity-regained").
   */
  useEffect(() => {
    let wasOffline = false;
    const unsub = NetInfo.addEventListener((state) => {
      const isOnline = !!state.isConnected && state.isInternetReachable !== false;
      if (isOnline && wasOffline) {
        const id = guardId(useAuth.getState().guard);
        if (id) flush(id).then(() => useDuty.getState().refreshQueued()).catch(() => {});
        refresh();
      }
      wasOffline = !isOnline;
    });
    return () => unsub();
  }, [refresh]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
      <SosButton />
    </View>
  );
}
