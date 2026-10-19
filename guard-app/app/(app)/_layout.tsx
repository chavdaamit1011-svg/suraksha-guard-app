import NetInfo from '@react-native-community/netinfo';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState, Platform, View } from 'react-native';
import { SosButton } from '@/components/SosButton';
import { api } from '@/lib/api';
import { API_BASE_URL } from '@/config';
import { getLaunchNotificationData, onNotificationReceived, onNotificationResponse } from '@/lib/notifications';
import { getSocket, onNotification } from '@/lib/socket';
import { flush } from '@/lib/queue';
import { quickFix } from '@/lib/location';
import { guardId, useAuth } from '@/store/auth';
import { useDuty } from '@/store/duty';
import { colors } from '@/theme';

const BUNDLE_POLL_MS = 3_500; // Fast real-time live polling for instant orders, contracts, queries and notifications
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
      if (!data) return;
      if (data?.type !== 'wake_check' && data?.event !== 'wake_check') return;
      if (data.guardId && currentGuardId && String(data.guardId) !== String(currentGuardId)) return;
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

    const unsubResponse = onNotificationResponse(open);
    const unsubReceived = onNotificationReceived(open);

    let socketOff: (() => void) | null = null;
    try {
      const s = getSocket();
      const onWake = (payload: any) => open(payload);
      s.on('wake_check', onWake);
      socketOff = () => s.off('wake_check', onWake);
    } catch {}

    const unsubNotif = onNotification((payload: any) => {
      if (payload?.type === 'wake_check' || payload?.kind === 'WAKE_CHECK') open(payload);
    });

    let lastHandledWakeId = '';
    const unsubDuty = useDuty.subscribe((state) => {
      const p = state.bundle?.wakePrompt;
      if (p?.wakeId && p.wakeId !== lastHandledWakeId) {
        lastHandledWakeId = p.wakeId;
        open({
          type: 'wake_check',
          wakeId: p.wakeId,
          selfieRequired: p.selfieRequired ?? true,
          ackWindowSec: p.ackWindowSec || 120,
        });
      }
    });

    return () => {
      unsubResponse();
      unsubReceived();
      socketOff?.();
      unsubNotif();
      unsubDuty();
    };
  }, [router, currentGuardId]);

  // Bundle polling + the one-second countdown tick, both paused when backgrounded.
  useEffect(() => {
    const start = () => {
      useDuty.getState().hydrateBundle(); // instant render from cache, then revalidate
      refresh();
      refreshQueued();
      // Auto go online and record real-time check-in on app open
      quickFix().then((pos) => {
        if (pos) {
          useDuty.getState().pushLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.heading ?? undefined);
          useDuty.getState().setOnline(true, { lat: pos.coords.latitude, lng: pos.coords.longitude }).catch(() => {});
        } else {
          useDuty.getState().setOnline(true).catch(() => {});
        }
      }).catch(() => {
        useDuty.getState().setOnline(true).catch(() => {});
      });
      poll.current ??= setInterval(refresh, BUNDLE_POLL_MS);
      ticker.current ??= setInterval(tick, TICK_MS);
    };
    const stop = () => {
      if (poll.current) clearInterval(poll.current);
      if (ticker.current) clearInterval(ticker.current);
      poll.current = null;
      ticker.current = null;
      // In background/inactive tab: Keep polling at a relaxed heartbeat so the tab stays online!
      // Do NOT check out while the tab/app is still open.
      poll.current = setInterval(refresh, BUNDLE_POLL_MS * 2);
    };

    start();
    useAuth.getState().touch();

    // On Web: Only check out when the browser tab/window is actually closed or destroyed
    let removeUnload: (() => void) | null = null;
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const handleTabClose = () => {
        const id = guardId(useAuth.getState().guard);
        if (id) {
          const payload = JSON.stringify({ guardId: id, isOnline: false });
          try {
            if (navigator.sendBeacon) {
              navigator.sendBeacon(`${API_BASE_URL}/api/guard/toggle-online`, payload);
            } else {
              fetch(`${API_BASE_URL}/api/guard/toggle-online`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload,
                keepalive: true,
              });
            }
          } catch (_) {}
        }
      };
      window.addEventListener('beforeunload', handleTabClose);
      window.addEventListener('pagehide', handleTabClose);
      removeUnload = () => {
        window.removeEventListener('beforeunload', handleTabClose);
        window.removeEventListener('pagehide', handleTabClose);
      };
    }

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
      if (poll.current) clearInterval(poll.current);
      if (ticker.current) clearInterval(ticker.current);
      if (removeUnload) removeUnload();
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
