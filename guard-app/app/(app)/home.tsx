import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
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

function bandFor(state: DutyStateName, countdown: string, t: (k: string) => string): Band {
  switch (state) {
    case 'on_duty':
    case 'check_out':
      return { tone: 'on', icon: 'shield-checkmark', text: t('duty.onDuty') || 'On Duty' };
    case 'check_in':
      return { tone: 'warn', icon: 'log-in', text: t('duty.readyToCheckIn') || 'Ready to Check In' };
    case 'upcoming':
      return { tone: 'warn', icon: 'time', text: `${t('duty.startsIn') || 'Starts in'} ${countdown}` };
    case 'late':
      return { tone: 'danger', icon: 'alert-circle', text: t('duty.late') || 'Late for Duty' };
    case 'absent':
      return { tone: 'danger', icon: 'close-circle', text: t('duty.notCheckedIn') || 'Check-in Window Closed' };
    case 'complete':
      return { tone: 'off', icon: 'checkmark-done', text: t('duty.complete') || 'Shift Completed' };
    default:
      return { tone: 'off', icon: 'moon', text: t('duty.noDutyToday') || 'No Scheduled Duty Today' };
  }
}

function getTestDateOptions(): { label: string; date: string | null }[] {
  const options: { label: string; date: string | null }[] = [{ label: 'Today (Live)', date: null }];
  const base = new Date();
  for (let i = 1; i <= 6; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const iso = `${yyyy}-${mm}-${dd}`;
    const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
    options.push({
      label: `+${i}d (${dd} ${dayName})`,
      date: iso,
    });
  }
  return options;
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
    myContracts,
    online,
    offline,
    queued,
    mediaQueued,
    failed,
    hydrated,
    deviceBlocked,
    deviceStanding,
    selectedTestDate,
    setTestDate,
    leaveContract,
    applyDayLeave,
    setOnline,
    accept,
    reject,
    respondContract,
  } = useDuty();

  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedContractForModal, setSelectedContractForModal] = useState<ContractOffer | null>(null);
  const [leaveContractModalOpen, setLeaveContractModalOpen] = useState<ContractOffer | null>(null);
  const [dayLeaveModalOpen, setDayLeaveModalOpen] = useState<ContractOffer | null>(null);

  const unreadNotices = alerts.find((a: DutyAlert) => a.key === 'notices')?.count ?? 0;
  const watch = useRef<Location.LocationSubscription | null>(null);
  const testDateOptions = getTestDateOptions();

  useEffect(() => {
    const onDuty = duty.state === 'on_duty' || duty.state === 'check_out';
    const activeBooking = booking?.bookingStatus === 'ACTIVE';
    const shouldTrack = onDuty || activeBooking;

    (async () => {
      if (!shouldTrack) {
        if (hydrated) await stopDutyTracking();
      } else if (!watch.current) {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const started = await startDutyTracking(
          current?.endAt,
          current?.policy?.autoCloseAfterMin ?? 60,
          { title: t('duty.trackingTitle'), body: t('duty.trackingBody', { site: current?.siteName ?? '' }) }
        );
        if (started) return;
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

  const effectiveContract = activeContract || (myContracts && myContracts.length > 0 ? myContracts[0] : null);

  return (
    <>
      <Screen>
        {/* Header with Avatar Drawer trigger */}
        <View style={styles.header}>
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
            {offline || queued + mediaQueued > 0 ? (
              <Text style={styles.syncCount}>
                {offline ? t('duty.syncOffline') : `${t('duty.syncSending')} ${queued + mediaQueued}`}
              </Text>
            ) : null}
          </Pressable>
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

        {/* ------------------------------------------------------------- */}
        {/* 🧪 TESTING DATE SIMULATOR (Fast multi-day contract testing)    */}
        {/* ------------------------------------------------------------- */}
        <View style={styles.testDateBar}>
          <View style={styles.testDateHeader}>
            <Ionicons name="flask" size={13} color={colors.warning} />
            <Text style={styles.testDateTitle}>🧪 TEST DATE SIMULATOR</Text>
            {selectedTestDate ? (
              <Pressable onPress={() => setTestDate(null)} style={styles.resetDateChip}>
                <Text style={styles.resetDateText}>Reset</Text>
              </Pressable>
            ) : null}
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingTop: 4 }}>
            {testDateOptions.map((opt) => {
              const isSelected = selectedTestDate === opt.date || (!selectedTestDate && opt.date === null);
              return (
                <Pressable
                  key={opt.label}
                  onPress={() => setTestDate(opt.date)}
                  style={[
                    styles.testDateChip,
                    isSelected ? styles.testDateChipActive : null,
                  ]}
                >
                  <Text style={[styles.testDateChipText, isSelected ? styles.testDateChipTextActive : null]}>
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        {/* Status Band */}
        <StatusBand tone={band.tone} icon={<Ionicons name={band.icon} size={20} color="#fff" />} text={band.text} />

        <UpdateNotice />

        {/* Offline Banner */}
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

        {/* Alert strip */}
        {alerts
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

        {/* Contract Assignment Offers (New requests to Accept/Reject) */}
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

        {/* ------------------------------------------------------------- */}
        {/* SECTION 1: TODAY'S DUTY (Unified, Clean Lifecycle Card)        */}
        {/* ------------------------------------------------------------- */}
        <View style={styles.sectionHeader}>
          <View style={styles.sectionBadge}>
            <Ionicons name="calendar" size={16} color={colors.primary} />
            <Text style={styles.sectionTitle}>
              {selectedTestDate ? `DUTY FOR ${selectedTestDate}` : "TODAY'S DUTY"}
            </Text>
          </View>
        </View>

        <TodayDutyCard
          current={current}
          duty={duty}
          activeContract={effectiveContract}
          countdown={countdown}
          isOffer={isOffer}
          booking={booking}
          online={online}
          busy={busy}
          onAccept={async () => {
            setBusy(true);
            try {
              await accept();
            } finally {
              setBusy(false);
            }
          }}
          onReject={async (reason?: string) => {
            setBusy(true);
            try {
              await reject(reason || 'Guard unavailable / declined');
            } finally {
              setBusy(false);
            }
          }}
          onGoOnline={goOnline}
        />

        {/* ------------------------------------------------------------- */}
        {/* SECTION 2: MY CONTRACTS (Ongoing Contracts, Leave & Progress) */}
        {/* ------------------------------------------------------------- */}
        {effectiveContract ? (
          <>
            <View style={[styles.sectionHeader, { marginTop: space.md }]}>
              <View style={styles.sectionBadge}>
                <Ionicons name="briefcase" size={16} color={colors.primary} />
                <Text style={styles.sectionTitle}>MY CONTRACTS</Text>
              </View>
            </View>

            <MyContractsCard
              contract={effectiveContract}
              onViewDetails={() => setSelectedContractForModal(effectiveContract)}
              onLeaveContract={() => setLeaveContractModalOpen(effectiveContract)}
              onRequestDayLeave={() => setDayLeaveModalOpen(effectiveContract)}
            />
          </>
        ) : null}

        {/* Timeline strip for active duty */}
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

      {/* Contract Details & Attendance History Modal */}
      {selectedContractForModal ? (
        <ContractHistoryModal
          contract={selectedContractForModal}
          onClose={() => setSelectedContractForModal(null)}
          onRequestDayLeave={() => {
            const c = selectedContractForModal;
            setSelectedContractForModal(null);
            setDayLeaveModalOpen(c);
          }}
        />
      ) : null}

      {/* Leave Contract Modal (Guard relinquishes contract permanently) */}
      {leaveContractModalOpen ? (
        <LeaveContractModal
          contract={leaveContractModalOpen}
          onClose={() => setLeaveContractModalOpen(null)}
          onConfirm={async (reason) => {
            const cid = leaveContractModalOpen.contractId;
            setLeaveContractModalOpen(null);
            setBusy(true);
            try {
              await leaveContract(cid, reason);
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      {/* Request Day Leave Modal (Guard asks 1-day leave during contract) */}
      {dayLeaveModalOpen ? (
        <RequestDayLeaveModal
          contract={dayLeaveModalOpen}
          onClose={() => setDayLeaveModalOpen(null)}
          onConfirm={async (date, reason) => {
            setDayLeaveModalOpen(null);
            setBusy(true);
            try {
              await applyDayLeave(date, reason);
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      <SideMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
    </>
  );
}

/**
 * Today's Duty Card (Unified state machine)
 */
function TodayDutyCard({
  current,
  duty,
  activeContract,
  countdown,
  isOffer,
  booking,
  online,
  busy,
  onAccept,
  onReject,
  onGoOnline,
}: {
  current: CurrentAssignment | null;
  duty: any;
  activeContract: ContractOffer | null;
  countdown: string;
  isOffer: boolean;
  booking: any;
  online: boolean;
  busy: boolean;
  onAccept: () => Promise<void>;
  onReject: (reason?: string) => Promise<void>;
  onGoOnline: () => Promise<void>;
}) {
  const t = useT();
  const router = useRouter();

  if (isOffer) {
    return (
      <Card style={{ borderColor: colors.warning, backgroundColor: '#1A1810' }}>
        <View style={styles.rowBetween}>
          <H2>{t('duty.newRequest') || 'New Duty Request'}</H2>
          <Ionicons name="notifications" size={22} color={colors.warning} />
        </View>
        <Body style={{ fontWeight: '700', fontSize: 16, marginTop: 4 }}>
          {booking?.customerName ?? 'Client'} · {booking?.serviceType ?? 'Guarding'}
        </Body>
        <Muted style={{ marginTop: 2, marginBottom: 12 }}>
          {booking?.location?.address ?? booking?.location?.city ?? 'Location not specified'}
        </Muted>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
          <View style={{ flex: 1 }}>
            <Button
              label={t('common.decline') || 'Decline'}
              variant="danger"
              onPress={() => onReject('Guard unavailable / declined')}
              loading={busy}
            />
          </View>
          <View style={{ flex: 1.5 }}>
            <Button
              label={t('duty.accept') || 'Accept'}
              variant="success"
              onPress={onAccept}
              loading={busy}
            />
          </View>
        </View>
      </Card>
    );
  }

  // Active roster / contract shift today
  if (current) {
    const clientName = (current as any).client || activeContract?.client || current.siteName || 'Client Company';
    const siteName = current.siteName || activeContract?.site || 'Main Site';
    const contractCode = (current as any).contractCode || activeContract?.contractCode || `CNT-${current.rosterId.slice(-4).toUpperCase()}`;
    const dayNum = (current as any).currentDayNumber || activeContract?.currentDayNumber || 1;
    const totalDays = (current as any).totalDays || activeContract?.totalDays || 30;
    const shiftTiming = current.timing || `${current.start} – ${current.end}`;
    const isCompleted = duty.state === 'complete' || !!current.checkedOutAt;
    const isOnDuty = duty.state === 'on_duty' || duty.state === 'check_out' || (!!current.checkedInAt && !current.checkedOutAt);

    return (
      <Card style={isOnDuty ? { borderColor: colors.onDuty, borderWidth: 1.5 } : isCompleted ? { borderColor: 'rgba(34,197,94,0.3)' } : undefined}>
        {/* Top Tag */}
        <View style={styles.rowBetween}>
          <View style={styles.rowGap}>
            <Ionicons name="business" size={16} color={colors.primary} />
            <Text style={{ fontSize: 15, fontWeight: '900', color: colors.text }}>
              {clientName}
            </Text>
          </View>
          <View style={[styles.badgePill, { backgroundColor: isCompleted ? colors.onDutyDim : isOnDuty ? colors.onDutyDim : 'rgba(245,198,35,0.1)' }]}>
            <Text style={[styles.badgePillText, { color: isCompleted ? colors.onDuty : isOnDuty ? colors.onDuty : colors.primary }]}>
              {contractCode} · Day {dayNum} of {totalDays}
            </Text>
          </View>
        </View>

        {/* Site & Timing */}
        <Text style={{ fontSize: 13, color: colors.textMuted, marginTop: 4 }}>
          {siteName} {current.site.address ? `· ${current.site.address}` : ''}
        </Text>

        <View style={[styles.metaRow, { marginTop: 6, marginBottom: 12 }]}>
          <Meta icon="time" text={shiftTiming} tone={colors.text} />
          {current.shiftType ? <Meta icon="briefcase" text={current.shiftType} /> : null}
        </View>

        {/* ---------------- STATE 1: SHIFT COMPLETED FOR TODAY ---------------- */}
        {isCompleted ? (
          <View style={styles.shiftCompletedBox}>
            <View style={styles.rowGap}>
              <Ionicons name="checkmark-circle" size={24} color={colors.onDuty} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: '900', color: colors.onDuty }}>
                  ✓ Today's Duty Completed
                </Text>
                <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
                  {current.checkedInAt ? istTime(current.checkedInAt) : current.start} → {current.checkedOutAt ? istTime(current.checkedOutAt) : current.end}
                </Text>
              </View>
            </View>
            <View style={styles.divider} />
            <View style={styles.rowBetween}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: colors.text }}>
                Day {dayNum} / {totalDays} — Completed
              </Text>
              <Text style={{ fontSize: 11, color: colors.primary, fontWeight: '700' }}>
                Next Shift: Tomorrow
              </Text>
            </View>
          </View>
        ) : null}

        {/* ---------------- STATE 2: ON DUTY (CHECKED IN) ---------------- */}
        {isOnDuty && !isCompleted ? (
          <View style={{ gap: space.sm }}>
            <View style={styles.checkedInInfoBox}>
              <View style={styles.rowGap}>
                <Ionicons name="radio-button-on" size={16} color={colors.onDuty} />
                <Text style={{ fontSize: 13, fontWeight: '800', color: colors.onDuty }}>
                  Checked In at {current.checkedInAt ? istTime(current.checkedInAt) : current.start}
                </Text>
              </View>
              <Text style={{ fontSize: 12, color: colors.textMuted }}>
                Duty ends at {current.end}
              </Text>
            </View>

            <Button
              label={t('duty.checkOut') || 'Check Out'}
              size="huge"
              variant="danger"
              icon={<Ionicons name="log-out" size={24} color="#fff" />}
              onPress={() => router.push('/checkin?mode=out')}
            />
          </View>
        ) : null}

        {/* ---------------- STATE 3: READY TO CHECK IN / UPCOMING ---------------- */}
        {!isOnDuty && !isCompleted ? (
          <View style={{ gap: space.sm }}>
            {duty.state === 'upcoming' ? (
              <View style={styles.upcomingInfoBox}>
                <Ionicons name="time" size={16} color={colors.warning} />
                <Text style={{ fontSize: 12, fontWeight: '700', color: colors.warning }}>
                  Shift starts in {countdown}
                </Text>
              </View>
            ) : null}

            {duty.state === 'late' || duty.state === 'absent' ? (
              <View style={styles.lateInfoBox}>
                <Ionicons name="alert-circle" size={16} color={colors.danger} />
                <Text style={{ fontSize: 12, fontWeight: '700', color: colors.danger, flex: 1 }}>
                  Check-in window closed. Contact supervisor for override.
                </Text>
              </View>
            ) : null}

            <Button
              label={t('duty.checkIn') || 'Check In'}
              size="huge"
              variant="success"
              icon={<Ionicons name="log-in" size={26} color="#fff" />}
              onPress={() => router.push('/checkin?mode=in')}
            />
          </View>
        ) : null}
      </Card>
    );
  }

  // If on-demand B2C booking
  if (booking && booking.bookingStatus !== 'PENDING_ACCEPTANCE' && booking.bookingStatus !== 'COMPLETED') {
    return <BookingCard booking={booking} />;
  }

  // Fallback: No scheduled duty today -> Marketplace Online/Offline toggle
  return (
    <Card style={{ alignItems: 'center', paddingVertical: space.xl, gap: space.md }}>
      <Ionicons name="moon-outline" size={36} color={colors.textFaint} />
      <View style={{ alignItems: 'center', gap: 2 }}>
        <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text }}>
          No Scheduled Duty Today
        </Text>
        <Muted style={{ textAlign: 'center' }}>
          Go online to receive on-demand security requests in your area.
        </Muted>
      </View>
      <Button
        label={online ? t('duty.goOffline') || 'Go Offline' : t('duty.goOnline') || 'Go Online'}
        size="huge"
        variant={online ? 'ghost' : 'primary'}
        icon={<Ionicons name={online ? 'pause' : 'flash'} size={24} color={online ? colors.text : colors.onPrimary} />}
        onPress={onGoOnline}
        loading={busy}
      />
    </Card>
  );
}

/**
 * My Contracts Section Card
 */
function MyContractsCard({
  contract,
  onViewDetails,
  onLeaveContract,
  onRequestDayLeave,
}: {
  contract: ContractOffer;
  onViewDetails: () => void;
  onLeaveContract: () => void;
  onRequestDayLeave: () => void;
}) {
  const totalDays = contract.totalDays || 30;
  const completedDays = contract.completedDaysCount || Math.max(1, (contract.currentDayNumber || 1) - 1);
  const pct = Math.min(100, Math.round((completedDays / totalDays) * 100));

  return (
    <Card style={{ backgroundColor: '#13161A', borderColor: colors.border }}>
      <View style={styles.rowBetween}>
        <View style={styles.rowGap}>
          <Ionicons name="shield-checkmark" size={16} color={colors.primary} />
          <Text style={{ fontSize: 15, fontWeight: '900', color: colors.text }}>
            {contract.client}
          </Text>
        </View>
        <Text style={{ fontSize: 11, fontWeight: '800', color: colors.primary }}>
          {contract.contractCode || 'ACTIVE'}
        </Text>
      </View>

      <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 4 }}>
        {contract.startDate} to {contract.endDate} · Shift: {contract.shiftTiming}
      </Text>

      {/* Progress Bar */}
      <View style={{ marginTop: 12, gap: 6 }}>
        <View style={styles.rowBetween}>
          <Text style={{ fontSize: 12, fontWeight: '800', color: colors.textMuted }}>
            Progress
          </Text>
          <Text style={{ fontSize: 12, fontWeight: '900', color: colors.primary }}>
            {completedDays}/{totalDays} Days ({pct}%)
          </Text>
        </View>

        <View style={styles.progressBarBackground}>
          <View style={[styles.progressBarFill, { width: `${pct}%` }]} />
        </View>
      </View>

      {/* Quick Action Buttons */}
      <View style={{ flexDirection: 'row', gap: space.sm, marginTop: 12 }}>
        <Pressable onPress={onViewDetails} style={[styles.actionBtn, { flex: 1.4, backgroundColor: 'rgba(245,198,35,0.08)', borderColor: 'rgba(245,198,35,0.2)' }]}>
          <Ionicons name="calendar-outline" size={15} color={colors.primary} />
          <Text style={[styles.actionBtnText, { color: colors.primary }]}>View History</Text>
        </Pressable>

        <Pressable onPress={onRequestDayLeave} style={[styles.actionBtn, { flex: 1, backgroundColor: 'rgba(59,130,246,0.08)', borderColor: 'rgba(59,130,246,0.2)' }]}>
          <Ionicons name="time-outline" size={15} color={colors.info} />
          <Text style={[styles.actionBtnText, { color: colors.info }]}>1-Day Leave</Text>
        </Pressable>

        <Pressable onPress={onLeaveContract} style={[styles.actionBtn, { flex: 0.9, backgroundColor: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.2)' }]}>
          <Ionicons name="exit-outline" size={15} color={colors.danger} />
          <Text style={[styles.actionBtnText, { color: colors.danger }]}>Quit</Text>
        </Pressable>
      </View>
    </Card>
  );
}

/**
 * Modal showing complete day-by-day attendance sheet
 */
function ContractHistoryModal({
  contract,
  onClose,
  onRequestDayLeave,
}: {
  contract: ContractOffer;
  onClose: () => void;
  onRequestDayLeave: () => void;
}) {
  const totalDays = contract.totalDays || 30;
  const currentDay = contract.currentDayNumber || 1;
  const breakdown = contract.dailyBreakdown || [];

  return (
    <Modal visible animationType="slide" transparent>
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.modalTitle}>{contract.client}</Text>
              <Text style={{ fontSize: 12, color: colors.textMuted }}>
                {contract.contractCode || 'Contract'} · {contract.startDate} to {contract.endDate}
              </Text>
            </View>
            <Pressable onPress={onClose} style={styles.modalCloseButton}>
              <Ionicons name="close" size={22} color={colors.text} />
            </Pressable>
          </View>

          <ScrollView style={{ maxHeight: 380 }} showsVerticalScrollIndicator={false}>
            <Text style={styles.modalSectionHeader}>Daily Attendance Schedule</Text>

            {breakdown.length > 0 ? (
              breakdown.map((item, idx) => {
                const dayIndex = idx + 1;
                const isDone = item.status === 'Completed';
                const isToday = dayIndex === currentDay || item.status === 'On Duty' || item.status === 'Scheduled';

                return (
                  <View key={item.date} style={styles.historyRow}>
                    <View style={styles.rowGap}>
                      <Ionicons
                        name={isDone ? 'checkmark-circle' : isToday ? 'radio-button-on' : 'ellipse-outline'}
                        size={18}
                        color={isDone ? colors.onDuty : isToday ? colors.primary : colors.textFaint}
                      />
                      <View>
                        <Text style={{ fontSize: 13, fontWeight: isToday ? '800' : '600', color: isToday ? colors.text : colors.textMuted }}>
                          Day {dayIndex} · {item.date}
                        </Text>
                        {item.checkInTime ? (
                          <Text style={{ fontSize: 10, color: colors.textFaint }}>
                            {istTime(item.checkInTime)} {item.checkOutTime ? `→ ${istTime(item.checkOutTime)}` : ''}
                          </Text>
                        ) : null}
                      </View>
                    </View>

                    <Text
                      style={{
                        fontSize: 11,
                        fontWeight: '700',
                        color: isDone ? colors.onDuty : isToday ? colors.primary : colors.textFaint,
                      }}
                    >
                      {item.status}
                    </Text>
                  </View>
                );
              })
            ) : (
              Array.from({ length: totalDays }).map((_, idx) => {
                const dayIndex = idx + 1;
                const isDone = dayIndex < currentDay;
                const isToday = dayIndex === currentDay;

                return (
                  <View key={idx} style={styles.historyRow}>
                    <View style={styles.rowGap}>
                      <Ionicons
                        name={isDone ? 'checkmark-circle' : isToday ? 'radio-button-on' : 'ellipse-outline'}
                        size={18}
                        color={isDone ? colors.onDuty : isToday ? colors.primary : colors.textFaint}
                      />
                      <Text style={{ fontSize: 13, fontWeight: isToday ? '800' : '600', color: isToday ? colors.text : colors.textMuted }}>
                        Day {dayIndex} of {totalDays}
                      </Text>
                    </View>
                    <Text
                      style={{
                        fontSize: 11,
                        fontWeight: '700',
                        color: isDone ? colors.onDuty : isToday ? colors.primary : colors.textFaint,
                      }}
                    >
                      {isDone ? '✓ Completed' : isToday ? '● Today' : 'Upcoming'}
                    </Text>
                  </View>
                );
              })
            )}
          </ScrollView>

          <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
            <View style={{ flex: 1 }}>
              <Button label="Request Day Leave" variant="primary" size="small" onPress={onRequestDayLeave} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="Close" variant="ghost" size="small" onPress={onClose} />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/**
 * Modal to Leave / Relinquish Contract permanently
 */
function LeaveContractModal({
  contract,
  onClose,
  onConfirm,
}: {
  contract: ContractOffer;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('Personal reasons / unable to continue');
  const [loading, setLoading] = useState(false);

  const REASONS = [
    'Personal reasons / unable to continue',
    'Shift timing / location conflict',
    'Health / medical issues',
    'Better opportunity / relocation',
  ];

  return (
    <Modal visible animationType="fade" transparent>
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <View style={styles.modalHeader}>
            <View style={styles.rowGap}>
              <Ionicons name="warning" size={22} color={colors.danger} />
              <Text style={[styles.modalTitle, { color: colors.danger }]}>Leave Contract</Text>
            </View>
            <Pressable onPress={onClose} style={styles.modalCloseButton}>
              <Ionicons name="close" size={22} color={colors.text} />
            </Pressable>
          </View>

          <Text style={{ fontSize: 13, color: colors.textMuted, marginBottom: 12 }}>
            Are you sure you want to quit contract <Text style={{ fontWeight: '800', color: colors.text }}>{contract.client}</Text>? Your agency will be notified immediately to reassign a replacement guard.
          </Text>

          <Text style={styles.modalSectionHeader}>Select Reason:</Text>
          <View style={{ gap: 6, marginBottom: 16 }}>
            {REASONS.map((r) => {
              const active = reason === r;
              return (
                <Pressable
                  key={r}
                  onPress={() => setReason(r)}
                  style={[
                    styles.reasonOption,
                    active ? styles.reasonOptionActive : null,
                  ]}
                >
                  <Ionicons
                    name={active ? 'radio-button-on' : 'radio-button-off'}
                    size={16}
                    color={active ? colors.primary : colors.textFaint}
                  />
                  <Text style={[styles.reasonOptionText, active ? { color: colors.text, fontWeight: '700' } : null]}>
                    {r}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <View style={{ flex: 1 }}>
              <Button label="Cancel" variant="ghost" size="small" onPress={onClose} />
            </View>
            <View style={{ flex: 1.3 }}>
              <Button
                label="Confirm & Leave"
                variant="danger"
                size="small"
                loading={loading}
                onPress={async () => {
                  setLoading(true);
                  try {
                    await onConfirm(reason);
                  } finally {
                    setLoading(false);
                  }
                }}
              />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/**
 * Modal to Request 1-Day Leave during contract
 */
function RequestDayLeaveModal({
  contract,
  onClose,
  onConfirm,
}: {
  contract: ContractOffer;
  onClose: () => void;
  onConfirm: (date: string, reason: string) => Promise<void>;
}) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const defaultDate = tomorrow.toISOString().slice(0, 10);

  const [date, setDate] = useState(defaultDate);
  const [reason, setReason] = useState('Medical appointment');
  const [loading, setLoading] = useState(false);

  return (
    <Modal visible animationType="fade" transparent>
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <View style={styles.modalHeader}>
            <View style={styles.rowGap}>
              <Ionicons name="calendar" size={20} color={colors.primary} />
              <Text style={styles.modalTitle}>Request Shift Leave</Text>
            </View>
            <Pressable onPress={onClose} style={styles.modalCloseButton}>
              <Ionicons name="close" size={22} color={colors.text} />
            </Pressable>
          </View>

          <Text style={{ fontSize: 13, color: colors.textMuted, marginBottom: 12 }}>
            Apply for leave on a specific day of this contract. Agency portal will arrange a reliever guard.
          </Text>

          <Text style={styles.inputLabel}>Leave Date (YYYY-MM-DD):</Text>
          <TextInput
            value={date}
            onChangeText={setDate}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.textFaint}
            style={styles.textInput}
          />

          <Text style={[styles.inputLabel, { marginTop: 12 }]}>Reason for Leave:</Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="Reason for taking leave"
            placeholderTextColor={colors.textFaint}
            style={styles.textInput}
          />

          <View style={{ flexDirection: 'row', gap: space.sm, marginTop: 16 }}>
            <View style={{ flex: 1 }}>
              <Button label="Cancel" variant="ghost" size="small" onPress={onClose} />
            </View>
            <View style={{ flex: 1.3 }}>
              <Button
                label="Submit Request"
                variant="primary"
                size="small"
                loading={loading}
                onPress={async () => {
                  setLoading(true);
                  try {
                    await onConfirm(date, reason);
                  } finally {
                    setLoading(false);
                  }
                }}
              />
            </View>
          </View>
        </View>
      </View>
    </Modal>
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
    <Card style={{ borderColor: colors.primary, borderWidth: 1.5, backgroundColor: 'rgba(245,198,35,0.04)' }}>
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

function Timeline({ items }: { items: TimelineItem[] }) {
  const router = useRouter();
  const t = useT();
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
    const CHIP = 104;
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
  testDateBar: {
    backgroundColor: 'rgba(245,198,35,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(245,198,35,0.2)',
    borderRadius: radius.md,
    padding: space.sm,
    gap: 4,
  },
  testDateHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  testDateTitle: { fontSize: 10, fontWeight: '900', color: colors.warning, letterSpacing: 0.5 },
  resetDateChip: { backgroundColor: colors.warningDim, paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.pill },
  resetDateText: { fontSize: 10, fontWeight: '800', color: colors.warning },
  testDateChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  testDateChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  testDateChipText: { fontSize: 11, fontWeight: '700', color: colors.textMuted },
  testDateChipTextActive: { color: '#0B0D0F', fontWeight: '900' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  link: { color: colors.primary, fontSize: font.tiny, fontWeight: '700' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginTop: space.sm },
  sectionBadge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sectionTitle: { color: colors.primary, fontSize: 12, fontWeight: '900', letterSpacing: 1 },
  badgePill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill },
  badgePillText: { fontSize: 11, fontWeight: '800' },
  shiftCompletedBox: {
    backgroundColor: 'rgba(34,197,94,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.25)',
    borderRadius: radius.md,
    padding: space.md,
    gap: space.xs,
  },
  checkedInInfoBox: {
    backgroundColor: 'rgba(34,197,94,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.3)',
    borderRadius: radius.md,
    padding: space.md,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  upcomingInfoBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: colors.warningDim,
    padding: space.sm,
    borderRadius: radius.sm,
  },
  lateInfoBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: colors.dangerDim,
    padding: space.sm,
    borderRadius: radius.sm,
  },
  divider: { height: 1, backgroundColor: 'rgba(255,255,255,0.08)', marginVertical: 4 },
  progressBarBackground: {
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.1)',
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: 4,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  actionBtnText: { fontSize: 11, fontWeight: '800' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#16191E',
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: space.lg,
    maxHeight: '85%',
    borderColor: colors.border,
    borderWidth: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: space.md,
    paddingBottom: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalTitle: { fontSize: 18, fontWeight: '900', color: colors.text },
  modalCloseButton: { padding: space.xs },
  modalSectionHeader: { fontSize: 13, fontWeight: '800', color: colors.primary, marginBottom: space.sm, textTransform: 'uppercase' },
  historyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  reasonOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: colors.border,
  },
  reasonOptionActive: {
    backgroundColor: 'rgba(245,198,35,0.08)',
    borderColor: colors.primary,
  },
  reasonOptionText: { fontSize: 12, color: colors.textMuted },
  inputLabel: { fontSize: 12, fontWeight: '700', color: colors.textMuted, marginBottom: 4 },
  textInput: {
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text,
    padding: space.md,
    fontSize: 13,
  },
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
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: space.sm, marginTop: space.sm },
  tile: {
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
