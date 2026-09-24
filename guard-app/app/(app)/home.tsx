import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Body, Button, Card, H2, Muted, Screen, StatusBand } from '@/components/ui';
import { SideMenu } from '@/components/SideMenu';
import { UpdateNotice } from '@/components/UpdateNotice';
import { PING_INTERVAL_SEC } from '@/config';
import { useT } from '@/i18n';
import type { CurrentAssignment, DutyAlert, DutyStateName, TimelineItem, ContractOffer } from '@/lib/api';
import { startDutyTracking, stopDutyTracking } from '@/lib/dutyTracking';
import { quickFix } from '@/lib/location';
import { formatCountdown, istTime } from '@/lib/duty';
import { useAuth } from '@/store/auth';
import { useDuty } from '@/store/duty';
import { colors, font, radius, space, touch } from '@/theme';

type Tile = { key: string; icon: keyof typeof Ionicons.glyphMap; route: string };
const TILES: Tile[] = [
  { key: 'patrol', icon: 'walk', route: '/patrol' },
  { key: 'incident', icon: 'alert-circle', route: '/incident' },
  { key: 'leave', icon: 'calendar', route: '/leave' },
  { key: 'payslip', icon: 'wallet', route: '/earnings' },
  { key: 'documents', icon: 'document-text', route: '/documents' },
  { key: 'help', icon: 'help-buoy', route: '/help' },
];

type Band = { tone: 'off' | 'on' | 'warn' | 'danger'; icon: keyof typeof Ionicons.glyphMap; text: string };

/**
 * The status band answers "am I on duty?" without reading (PRD 18.3 §5): colour *and* icon *and*
 * text, never colour alone.
 */
function bandFor(state: DutyStateName, countdown: string, t: (k: string) => string): Band {
  switch (state) {
    case 'on_duty':
    case 'check_out':
      return { tone: 'on', icon: 'shield-checkmark', text: t('duty.onDuty') };
    case 'check_in':
      return { tone: 'warn', icon: 'log-in', text: t('duty.readyToCheckIn') };
    case 'upcoming':
      return { tone: 'warn', icon: 'time', text: `${t('duty.startsIn')} ${countdown}` };
    case 'late':
      return { tone: 'danger', icon: 'alert-circle', text: t('duty.late') };
    case 'absent':
      return { tone: 'danger', icon: 'close-circle', text: t('duty.notCheckedIn') };
    case 'complete':
      return { tone: 'off', icon: 'checkmark-done', text: t('duty.complete') };
    default:
      return { tone: 'off', icon: 'moon', text: t('duty.noDutyToday') };
  }
}

export default function DutyHome() {
  const t = useT();
  const router = useRouter();
  const guard = useAuth((s) => s.guard);
  const {
    current,
    duty,
    timeline,
    alerts,
    booking,
    contractOffers,
    activeContract,
    online,
    offline,
    queued,
    mediaQueued,
    failed,
    hydrated,
    deviceBlocked,
    deviceStanding,
    setOnline,
    accept,
    reject,
    respondContract,
  } = useDuty();
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const unreadNotices = alerts.find((a: DutyAlert) => a.key === 'notices')?.count ?? 0;
  const watch = useRef<Location.LocationSubscription | null>(null);

  /**
   * Location streams only while a duty is actually running — PRD 18.15.7 and §39 make this a
   * privacy requirement, not an optimisation: "the app must never track a guard outside their
   * shift window". The interval widens when stationary to hold the 6%-per-shift battery budget.
   */
  useEffect(() => {
    const onDuty = duty.state === 'on_duty' || duty.state === 'check_out';
    const activeBooking = booking?.bookingStatus === 'ACTIVE';
    const shouldTrack = onDuty || activeBooking;

    (async () => {
      if (!shouldTrack) {
        // Before the cached bundle loads the state is a placeholder, not "off duty".
        if (hydrated) await stopDutyTracking();
      } else if (!watch.current) {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        // Preferred: the foreground service, which keeps reporting with the screen off.
        const started = await startDutyTracking(
          current?.endAt,
          current?.policy?.autoCloseAfterMin ?? 60,
          { title: t('duty.trackingTitle'), body: t('duty.trackingBody', { site: current?.siteName ?? '' }) }
        );
        if (started) return;
        // Fallback: updates only while the app is open.
        watch.current = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: PING_INTERVAL_SEC.stationaryInGeofence * 1000,
            distanceInterval: 25,
          },
          (pos) =>
            useDuty
              .getState()
              .pushLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.heading ?? undefined)
        );
      }
      if (!shouldTrack && watch.current) {
        watch.current.remove();
        watch.current = null;
      }
    })();

    return () => {
      watch.current?.remove();
      watch.current = null;
    };
  }, [duty.state, booking?.bookingStatus, current?.rosterId, hydrated]);

  const countdown = formatCountdown(duty.countdownSec);
  const band = bandFor(duty.state, countdown, t);
  const isOffer = booking?.bookingStatus === 'PENDING_ACCEPTANCE';

  /** Server alerts arrive in English; show them in the guard's language when we know the key. */
  const alertText = (a: DutyAlert) => {
    const k = `alerts.${a.key}`;
    const s = t(k, { count: a.count ?? '', site: a.site ?? '' });
    return s === k ? a.label : s;
  };

  const goOnline = async () => {
    setBusy(true);
    try {
      let coords: { lat: number; lng: number } | undefined;
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        const pos = await quickFix({ accuracy: Location.Accuracy.Balanced, timeoutMs: 6_000 });
        if (pos) coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      }
      await setOnline(!online, coords);
    } finally {
      setBusy(false);
    }
  };

  /**
   * An unapproved phone gets no duty data (SUR-GAP-006). The SOS button stays — it lives in the
   * layout above every screen — because withholding a life-safety control to enforce a fraud
   * check would be the wrong trade.
   */
  if (deviceBlocked) {
    return (
      <Screen>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Muted>{guard?.city ?? ''}</Muted>
            <H2>{guard?.name ?? 'Guard'}</H2>
          </View>
        </View>

        <View style={styles.blockedCard}>
          <Ionicons name="phone-portrait" size={48} color={colors.warning} />
          <H2>{t('device.newPhone')}</H2>
          <Muted style={{ textAlign: 'center' }}>
            {deviceStanding === 'change_pending' ? t('device.waitingApproval') : t('device.notApproved')}
          </Muted>
          <Muted style={{ textAlign: 'center' }}>{t('device.sosStillWorks')}</Muted>
        </View>

        <Button
          label={t('help.callSupervisor')}
          variant="primary"
          size="huge"
          icon={<Ionicons name="call" size={24} color={colors.onPrimary} />}
          onPress={() => router.push('/help')}
        />
      </Screen>
    );
  }

  return (
    <>
    <Screen>
      <View style={styles.header}>
        {/* The avatar is the menu button (no separate ☰), top left like WhatsApp. */}
        <Pressable onPress={() => setMenuOpen(true)} style={styles.avatar} accessibilityLabel={t('menu.open')}>
          <Text style={styles.avatarText}>{(guard?.name ?? 'G').slice(0, 1).toUpperCase()}</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <Muted>{guard?.city ?? ''}</Muted>
          <Text style={styles.headerName} numberOfLines={1}>
            {guard?.name ?? 'Guard'}
          </Text>
        </View>
        <Pressable onPress={() => router.push('/apphealth')} hitSlop={8} style={styles.syncChip}>
          <Ionicons
            name={offline ? 'cloud-offline' : queued + mediaQueued > 0 ? 'cloud-upload' : 'cloud-done'}
            size={18}
            color={offline ? colors.warning : queued + mediaQueued > 0 ? colors.warning : colors.onDuty}
          />
          {/* All sent: just the green cloud. Words only when something needs the guard's eye. */}
          {offline || queued + mediaQueued > 0 ? (
            <Text style={styles.syncCount}>
              {offline ? t('duty.syncOffline') : `${t('duty.syncSending')} ${queued + mediaQueued}`}
            </Text>
          ) : null}
        </Pressable>
        {/* Notices live here only: the bell, with the unread count from the duty bundle. */}
        <Pressable
          onPress={() => router.push('/notices')}
          style={styles.bell}
          accessibilityLabel={t('notices.title')}
        >
          <Ionicons name={unreadNotices > 0 ? 'notifications' : 'notifications-outline'} size={26} color={colors.text} />
          {unreadNotices > 0 ? (
            <View style={styles.bellBadge}>
              <Text style={styles.bellBadgeText}>{unreadNotices > 9 ? '9+' : unreadNotices}</Text>
            </View>
          ) : null}
        </Pressable>
      </View>

      <StatusBand tone={band.tone} icon={<Ionicons name={band.icon} size={20} color="#fff" />} text={band.text} />

      <UpdateNotice />

      {/* Offline is a normal state: calm amber, never red (PRD 18.17.1 rule 15) */}
      {offline ? (
        <View style={[styles.notice, { backgroundColor: colors.warningDim }]}>
          <Ionicons name="cloud-offline" size={14} color={colors.warning} />
          <Text style={[styles.noticeText, { color: colors.warning }]}>{t('offlineBanner')}</Text>
        </View>
      ) : null}

      {failed > 0 ? (
        <Pressable onPress={() => router.push('/apphealth')}>
          <View style={[styles.notice, { backgroundColor: colors.dangerDim }]}>
            <Ionicons name="warning" size={14} color={colors.danger} />
            <Text style={[styles.noticeText, { color: colors.danger }]}>
              {failed} {t('duty.recordsNotSaved')}
            </Text>
          </View>
        </Pressable>
      ) : null}

      {/* Alert strip — zero to three one-tap resolutions (PRD 18.3 §5) */}
      {alerts
        // The status band and the CHECK IN button already say this; a third copy is noise.
        // Unread notices are the bell's badge in the header, not a strip of their own.
        .filter((a: DutyAlert) => a.key !== 'not_checked_in' && a.key !== 'notices')
        .map((a: DutyAlert) => (
        <Pressable key={a.key} onPress={() => router.push(a.route as any)}>
          <View
            style={[
              styles.notice,
              { backgroundColor: a.severity === 'danger' ? colors.dangerDim : a.severity === 'warn' ? colors.warningDim : 'rgba(59,130,246,0.12)' },
            ]}
          >
            <Ionicons
              name={a.severity === 'danger' ? 'alert-circle' : a.severity === 'warn' ? 'warning' : 'information-circle'}
              size={14}
              color={a.severity === 'danger' ? colors.danger : a.severity === 'warn' ? colors.warning : colors.info}
            />
            <Text
              style={[
                styles.noticeText,
                { color: a.severity === 'danger' ? colors.danger : a.severity === 'warn' ? colors.warning : colors.info },
              ]}
            >
              {alertText(a)}
            </Text>
            <Ionicons name="chevron-forward" size={14} color={colors.textFaint} />
          </View>
        </Pressable>
      ))}

      {/* Contract Assignment Offers from Agency Portal */}
      {contractOffers && contractOffers.length > 0
        ? contractOffers.map((offer) => (
            <ContractOfferCard
              key={offer.contractId}
              offer={offer}
              busy={busy}
              onAccept={async () => {
                setBusy(true);
                try {
                  await respondContract(offer.contractId, 'accept');
                } finally {
                  setBusy(false);
                }
              }}
              onReject={async () => {
                setBusy(true);
                try {
                  await respondContract(offer.contractId, 'reject');
                } finally {
                  setBusy(false);
                }
              }}
            />
          ))
        : null}

      {/* Active Contract Deployment Badge */}
      {activeContract ? (
        <Card style={{ backgroundColor: 'rgba(59,130,246,0.06)', borderColor: 'rgba(59,130,246,0.2)' }}>
          <View style={styles.rowBetween}>
            <View style={styles.rowGap}>
              <Ionicons name="shield-checkmark" size={16} color={colors.primary} />
              <Text style={{ fontSize: 12, fontWeight: '800', color: colors.primary }}>
                Active Contract Deployment
              </Text>
            </View>
            <Text style={{ fontSize: 10, color: colors.textMuted }}>
              {activeContract.startDate} → {activeContract.endDate}
            </Text>
          </View>
          <Text style={{ fontSize: 14, fontWeight: '800', color: colors.text, marginTop: 4 }}>
            {activeContract.client} · {activeContract.site}
          </Text>
          <Text style={{ fontSize: 11, color: colors.textMuted }}>
            Shift: {activeContract.shiftTiming}
          </Text>
        </Card>
      ) : null}

      {/* Primary action — one 96dp button, ~25% of the viewport (PRD 18.3 §5) */}
      <PrimaryAction
        isOffer={isOffer}
        busy={busy}
        countdown={countdown}
        onAccept={async () => {
          setBusy(true);
          try {
            await accept();
          } finally {
            setBusy(false);
          }
        }}
        onReject={async () => {
          setBusy(true);
          try {
            await reject();
          } finally {
            setBusy(false);
          }
        }}
        onGoOnline={goOnline}
      />

      {/* Shift card or on-demand booking card */}
      {current ? (
        <ShiftCard assignment={current} />
      ) : booking && booking.bookingStatus !== 'PENDING_ACCEPTANCE' && booking.bookingStatus !== 'COMPLETED' ? (
        <BookingCard booking={booking} />
      ) : null}

      {/* Timeline strip */}
      {timeline.length > 0 ? <Timeline items={timeline} /> : null}

      {/* Quick grid */}
      <View style={styles.grid}>
        {TILES.map((tile) => (
          <Pressable key={tile.key} onPress={() => router.push(tile.route as any)} style={styles.tile}>
            <Ionicons name={tile.icon} size={28} color={colors.primary} />
            <Text style={styles.tileLabel} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
              {t(`grid.${tile.key}`)}
            </Text>
          </Pressable>
        ))}
      </View>
    </Screen>
    <SideMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
    </>
  );
}

function PrimaryAction({
  isOffer,
  busy,
  countdown,
  onAccept,
  onReject,
  onGoOnline,
}: {
  isOffer: boolean;
  busy: boolean;
  countdown: string;
  onAccept: () => void;
  onReject?: () => void;
  onGoOnline: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const { duty, current, booking, online } = useDuty();

  if (isOffer) {
    const reqs = booking?.serviceRequirements || {};
    const instructions = reqs.specialInstructions || booking?.specialInstructions;
    return (
      <Card style={{ borderColor: colors.warning }}>
        <View style={styles.rowBetween}>
          <H2>{t('duty.newRequest')}</H2>
          <Ionicons name="notifications" size={22} color={colors.warning} />
        </View>
        <Body style={{ fontWeight: '800', marginTop: 4 }}>
          {booking?.customerName ?? 'Client'} · {booking?.serviceType ?? 'Guarding'}
        </Body>
        <Muted>{booking?.location?.address ?? booking?.location?.city ?? ''}</Muted>

        {(reqs.eventType || reqs.dressRequirement || reqs.purpose || booking?.personnelCount) ? (
          <View style={{ backgroundColor: 'rgba(245, 198, 35, 0.08)', borderRadius: 10, padding: 10, marginVertical: 6, borderWidth: 1, borderColor: 'rgba(245, 198, 35, 0.25)' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <Ionicons name="shirt-outline" size={15} color={colors.warning} />
              <Text style={{ fontSize: 11, fontWeight: '800', color: colors.warning, textTransform: 'uppercase' }}>
                Event Requirements & Uniform
              </Text>
            </View>
            {reqs.eventType ? (
              <Text style={{ fontSize: 12, color: colors.text, fontWeight: '600', marginBottom: 2 }}>
                • Event Type: <Text style={{ color: colors.warning, fontWeight: '800' }}>{reqs.eventType}</Text>
              </Text>
            ) : null}
            {reqs.dressRequirement ? (
              <Text style={{ fontSize: 12, color: colors.text, fontWeight: '600', marginBottom: 2 }}>
                • Dress Preference: <Text style={{ color: colors.primary, fontWeight: '800' }}>{reqs.dressRequirement}</Text>
              </Text>
            ) : null}
            {reqs.purpose ? (
              <Text style={{ fontSize: 12, color: colors.text, fontWeight: '600', marginBottom: 2 }}>
                • Purpose: {reqs.purpose}
              </Text>
            ) : null}
            {reqs.vehicleRequired ? (
              <Text style={{ fontSize: 12, color: colors.text, fontWeight: '600' }}>
                • Vehicle Required: Yes
              </Text>
            ) : null}
          </View>
        ) : null}

        {instructions ? (
          <View style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)', borderRadius: 10, padding: 10, marginVertical: 4, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.15)' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <Ionicons name="document-text-outline" size={14} color={colors.warning} />
              <Text style={{ fontSize: 10, fontWeight: '800', color: colors.warning, textTransform: 'uppercase' }}>
                Special Instructions
              </Text>
            </View>
            <Text style={{ fontSize: 12, color: colors.text, fontStyle: 'italic', lineHeight: 18 }}>
              "{instructions}"
            </Text>
          </View>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
          <View style={{ flex: 1 }}>
            <Button label="Decline" variant="danger" onPress={onReject || (() => {})} loading={busy} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label={t('duty.accept')} variant="success" onPress={onAccept} loading={busy} />
          </View>
        </View>
      </Card>
    );
  }

  if (duty.canCheckIn) {
    return (
      <Button
        label={t('duty.checkIn')}
        size="huge"
        variant="success"
        icon={<Ionicons name="log-in" size={26} color="#fff" />}
        onPress={() => router.push('/checkin?mode=in')}
      />
    );
  }

  if (duty.canCheckOut) {
    return (
      <Button
        label={t('duty.checkOut')}
        size="huge"
        icon={<Ionicons name="log-out" size={26} color={colors.onPrimary} />}
        onPress={() => router.push('/checkin?mode=out')}
      />
    );
  }

  // Upcoming shift: show what is next rather than a dead button (PRD 18.3 §5 "NEXT: 20:00 Gate 2").
  if (duty.state === 'upcoming' && current) {
    return (
      <Pressable onPress={() => router.push('/briefing')} style={styles.nextCard}>
        <Muted>{t('duty.next')}</Muted>
        <Text style={styles.nextTime}>
          {current.start} · {current.siteName}
        </Text>
        <View style={styles.rowGap}>
          <Ionicons name="time" size={16} color={colors.warning} />
          <Text style={styles.nextCountdown}>{countdown}</Text>
        </View>
      </Pressable>
    );
  }

  if (duty.state === 'complete') {
    return (
      <View style={styles.doneCard}>
        <Ionicons name="checkmark-circle" size={40} color={colors.onDuty} />
        <Text style={styles.doneText}>{t('duty.complete')}</Text>
      </View>
    );
  }

  // Rostered today but the check-in window has closed: the marketplace toggle below would be
  // the wrong answer (seen on a phone). Only the supervisor can mark this guard present now.
  if (current && (duty.state === 'late' || duty.state === 'absent')) {
    const supervisor = current.site.escalationContacts.find((c) => c.role === 'supervisor');
    return (
      <Card style={{ borderColor: colors.danger }}>
        <Body style={{ fontWeight: '800' }}>{t('duty.checkInClosed')}</Body>
        <Button
          label={t('help.callSupervisor')}
          variant="danger"
          icon={<Ionicons name="call" size={20} color="#fff" />}
          onPress={() =>
            router.push((supervisor?.phone ? `/help?call=${encodeURIComponent(supervisor.phone)}` : '/help') as any)
          }
        />
      </Card>
    );
  }

  // No roster today — fall back to the on-demand marketplace toggle.
  return (
    <Button
      label={online ? t('duty.goOffline') : t('duty.goOnline')}
      size="huge"
      variant={online ? 'ghost' : 'primary'}
      icon={<Ionicons name={online ? 'pause' : 'flash'} size={24} color={online ? colors.text : colors.onPrimary} />}
      onPress={onGoOnline}
      loading={busy}
    />
  );
}

function ShiftCard({ assignment }: { assignment: CurrentAssignment }) {
  const t = useT();
  const router = useRouter();
  const supervisor = assignment.site.escalationContacts.find((c) => c.role === 'supervisor');

  return (
    <Pressable onPress={() => router.push('/briefing')}>
      <Card>
        <View style={styles.rowBetween}>
          <Muted>{t('duty.site')}</Muted>
          <View style={styles.rowGap}>
            <Text style={styles.link}>{t('duty.briefing')}</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.primary} />
          </View>
        </View>

        <Body style={{ fontWeight: '800' }}>{assignment.siteName}</Body>
        {assignment.site.address ? <Muted>{assignment.site.address}</Muted> : null}

        <View style={styles.metaRow}>
          <Meta icon="time" text={`${assignment.start}–${assignment.end}`} />
          <Meta icon="briefcase" text={assignment.shiftType || '—'} />
        </View>

        {assignment.checkedInAt ? (
          <Meta icon="log-in" text={`${t('duty.checkedInAt')} ${istTime(assignment.checkedInAt)}`} tone={colors.onDuty} />
        ) : null}

        {!assignment.site.geoKnown ? (
          <Meta icon="help-circle" text={t('duty.siteNotMapped')} tone={colors.warning} />
        ) : null}

        {assignment.isReliever ? (
          <Meta
            icon="swap-horizontal"
            text={`${t('duty.reliever')}${assignment.replacedGuardName ? ` · ${assignment.replacedGuardName}` : ''}`}
            tone={colors.info}
          />
        ) : null}

        {supervisor?.phone ? (
          <Pressable onPress={() => router.push(`/help?call=${encodeURIComponent(supervisor.phone)}` as any)}>
            <Meta icon="call" text={`${supervisor.name || t('duty.supervisor')} · ${supervisor.phone}`} tone={colors.primary} />
          </Pressable>
        ) : null}
      </Card>
    </Pressable>
  );
}

function BookingCard({ booking }: { booking: any }) {
  const t = useT();
  const address = booking?.location?.address || booking?.location?.city || 'Assigned Location';
  const isActive = booking.bookingStatus === 'ACTIVE';
  const isPendingCheckin = ['ASSIGNED', 'EN_ROUTE', 'ARRIVED'].includes(booking.bookingStatus);
  const isCheckout = booking.bookingStatus === 'CHECKOUT_INITIATED';

  return (
    <Card style={isActive ? { borderColor: colors.onDuty } : undefined}>
      <View style={styles.rowBetween}>
        <Muted>{booking.bookingId}</Muted>
        <View style={styles.rowGap}>
          <Text style={[styles.link, { color: isActive ? colors.onDuty : colors.primary }]}>
            {isActive ? t('duty.onDuty') : isCheckout ? t('duty.checkOut') : t('duty.readyToCheckIn')}
          </Text>
        </View>
      </View>

      <Body style={{ fontWeight: '800' }}>{booking.customerName || 'Client Booking'}</Body>
      <Muted>{address}</Muted>

      <View style={styles.metaRow}>
        <Meta icon="briefcase" text={booking.serviceType || 'Security Service'} />
        {booking.schedule?.startTime ? (
          <Meta icon="time" text={`${booking.schedule.startTime}${booking.schedule.endTime ? `–${booking.schedule.endTime}` : ''}`} />
        ) : null}
      </View>

      {isPendingCheckin ? (
        <Meta icon="key" text={t('duty.arrivalOtp')} tone={colors.warning} />
      ) : null}

      {isCheckout ? (
        <Meta icon="key" text={t('duty.checkoutOtp')} tone={colors.warning} />
      ) : null}

      {booking.dutyDetails?.dutyStartedAt ? (
        <Meta icon="log-in" text={`${t('duty.checkedInAt')} ${istTime(booking.dutyDetails.dutyStartedAt)}`} tone={colors.onDuty} />
      ) : null}
    </Card>
  );
}

function ContractOfferCard({
  offer,
  busy,
  onAccept,
  onReject,
}: {
  offer: ContractOffer;
  busy: boolean;
  onAccept: () => Promise<void>;
  onReject: () => Promise<void>;
}) {
  return (
    <Card style={{ borderColor: colors.primary, borderWidth: 1.5, backgroundColor: 'rgba(59,130,246,0.04)' }}>
      <View style={styles.rowBetween}>
        <View style={styles.rowGap}>
          <Ionicons name="document-text" size={16} color={colors.primary} />
          <Text style={{ fontSize: 12, fontWeight: '800', color: colors.primary, textTransform: 'uppercase' }}>
            New Contract Assignment
          </Text>
        </View>
        <Text style={{ fontSize: 10, fontWeight: '700', color: colors.warning, backgroundColor: colors.warningDim, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
          Action Required
        </Text>
      </View>

      <Body style={{ fontWeight: '800', marginTop: 4 }}>{offer.client} · {offer.site}</Body>

      <View style={styles.metaRow}>
        <Meta icon="calendar" text={`${offer.startDate} to ${offer.endDate}`} />
        <Meta icon="time" text={`Shift: ${offer.shiftTiming}`} />
        {offer.shiftHours ? <Meta icon="hourglass-outline" text={`${offer.shiftHours} hrs/day`} /> : null}
      </View>

      <Muted style={{ fontSize: 11, marginTop: 2 }}>
        Accepting this deploys you to this contract for daily scheduled shifts.
      </Muted>

      <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
        <View style={{ flex: 1 }}>
          <Button
            label="Reject"
            variant="ghost"
            size="small"
            disabled={busy}
            onPress={onReject}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            label="Accept Contract"
            variant="primary"
            size="small"
            disabled={busy}
            onPress={onAccept}
          />
        </View>
      </View>
    </Card>
  );
}

function Meta({ icon, text, tone }: { icon: keyof typeof Ionicons.glyphMap; text: string; tone?: string }) {
  return (
    <View style={styles.rowGap}>
      <Ionicons name={icon} size={14} color={tone ?? colors.textMuted} />
      <Text style={[styles.metaText, tone ? { color: tone } : null]}>{text}</Text>
    </View>
  );
}

/**
 * The duty timeline strip (PRD 18.3 §5): Check-in ✓ · Patrol 1 ✓ · Patrol 2 ○ · Wake ○ · Check-out ○.
 *
 * It scrolls **horizontally** and stays one row tall. A 12-hour shift with hourly rounds produces
 * fourteen-odd chips, and wrapping those over four rows pushes the quick grid off the screen —
 * the opposite of "no scrolling required to reach the primary action".
 *
 * It also auto-scrolls to the first thing still outstanding, so the chip the guard actually needs
 * is the one in view rather than a row of already-completed rounds.
 */
function Timeline({ items }: { items: TimelineItem[] }) {
  const router = useRouter();
  const t = useT();
  /** Server labels are English; translate by kind (`check_in`, `patrol:<id>`, `wake:<id>`, `check_out`). */
  const chipLabel = (item: TimelineItem) => {
    const kind = item.key.split(':')[0];
    const n = item.label.match(/(\d+)\s*$/)?.[1] ?? '';
    const k = `timeline.${kind}`;
    const s = t(k, { n });
    return s === k ? item.label : s;
  };
  const scroller = useRef<ScrollView>(null);
  const firstPending = items.findIndex((i) => !i.done);

  useEffect(() => {
    if (firstPending <= 0) return;
    const CHIP = 104; // approximate chip width + gap; exact placement is not important here
    const timer = setTimeout(
      () => scroller.current?.scrollTo({ x: Math.max(0, (firstPending - 1) * CHIP), animated: false }),
      0
    );
    return () => clearTimeout(timer);
  }, [firstPending]);

  return (
    <ScrollView
      ref={scroller}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.timeline}
    >
      {items.map((item, i) => (
        <View key={item.key} style={styles.chipWrap}>
          <Pressable onPress={() => router.push(item.route as any)} hitSlop={8} style={styles.chip}>
            <Ionicons
              name={item.done ? 'checkmark-circle' : 'ellipse-outline'}
              size={18}
              color={item.done ? colors.onDuty : colors.textFaint}
            />
            <Text style={[styles.chipText, { color: item.done ? colors.text : colors.textFaint }]} numberOfLines={1}>
              {chipLabel(item)}
            </Text>
          </Pressable>
          {i < items.length - 1 ? <View style={styles.chipLink} /> : null}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.sm },
  avatar: {
    width: touch.minTap,
    height: touch.minTap,
    borderRadius: touch.minTap / 2,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.primary, fontWeight: '900', fontSize: font.h3 },
  headerName: { color: colors.text, fontSize: font.h3 + 1, fontWeight: '900' },
  bell: {
    width: touch.minTap,
    height: touch.minTap,
    borderRadius: touch.minTap / 2,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bellBadge: {
    position: 'absolute',
    top: 2,
    right: 2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bellBadgeText: { color: '#fff', fontSize: 11, fontWeight: '900' },
  syncChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: touch.minTap,
    paddingHorizontal: space.sm,
  },
  syncCount: { color: colors.textMuted, fontSize: font.tiny, fontWeight: '900' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  link: { color: colors.primary, fontSize: font.tiny, fontWeight: '700' },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderRadius: radius.sm,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    minHeight: touch.minTap,
  },
  noticeText: { flex: 1, fontSize: font.label, fontWeight: '700' },
  metaRow: { flexDirection: 'row', gap: space.lg, flexWrap: 'wrap' },
  metaText: { color: colors.textMuted, fontSize: font.label, fontWeight: '600' },
  nextCard: {
    minHeight: touch.hugeButtonHeight,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.warning,
    padding: space.lg,
    gap: space.xs,
    justifyContent: 'center',
  },
  nextTime: { color: colors.text, fontSize: font.h2, fontWeight: '900' },
  nextCountdown: { color: colors.warning, fontSize: font.h3, fontWeight: '900', letterSpacing: 1 },
  doneCard: {
    minHeight: touch.hugeButtonHeight,
    backgroundColor: colors.onDutyDim,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.onDuty,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    flexDirection: 'row',
  },
  doneText: { color: colors.onDuty, fontSize: font.h3, fontWeight: '900' },
  blockedCard: {
    backgroundColor: colors.warningDim,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.warning,
    alignItems: 'center',
    gap: space.md,
    padding: space.xl,
  },
  timeline: { flexDirection: 'row', alignItems: 'center', paddingVertical: space.xs },
  chipWrap: { flexDirection: 'row', alignItems: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: touch.minTap, paddingHorizontal: space.xs },
  chipLink: { width: 14, height: 1, backgroundColor: colors.border },
  chipText: { fontSize: font.tiny, fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: space.sm },
  tile: {
    // PRD 18.3 quick grid: six tiles, three across, two rows. Height comes from padding, not a
    // fixed aspect ratio, so a larger system font grows the tile instead of pushing the label
    // onto the border (seen on a phone).
    width: '31.8%',
    minHeight: 92,
    paddingVertical: space.lg,
    paddingHorizontal: space.xs,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  tileLabel: { color: colors.text, fontSize: font.body - 1, fontWeight: '800', textAlign: 'center' },
});
