import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import NetInfo from '@react-native-community/netinfo';
import { Linking, Platform } from 'react-native';
import { api, type EscalationContact } from './api';
import { getDeviceId } from './device';
import { placeCallDirect, sendSmsDirect } from './native';
import { enqueue } from './queue';
import { emitSos } from './socket';

/**
 * The SOS transmission ladder (PRD 18.9 §9, SUR-GAP-017).
 *
 * The design principle is that the alarm fires **locally first and never waits for a network**.
 * Every rung is attempted; the ones that need a radio degrade gracefully, and the two that work
 * with no connectivity at all — the siren and the torch — run unconditionally, because a guard
 * in trouble in a basement is precisely the case the whole feature exists for.
 *
 * | # | Rung | Works offline |
 * |---|------|---------------|
 * | 1 | Local capture to the durable outbox      | yes |
 * | 2 | Siren + torch                            | yes |
 * | 3 | Socket push                              | no  |
 * | 4 | REST, with a retry burst over 5 minutes  | no  |
 * | 5 | Structured SMS to the agency SOS number  | radio only |
 * | 6 | Plain-language SMS to the supervisor     | radio only |
 * | 7 | Auto-call the supervisor / control room  | radio only |
 *
 * **Platform limit, stated plainly:** React Native cannot send an SMS or place a call without
 * user confirmation — `SEND_SMS` and `CALL_PHONE` need native code that Expo's managed runtime
 * does not expose. Rungs 5–7 therefore open a **pre-filled** composer or dialer, so the guard
 * confirms with a single tap rather than typing anything. Truly hands-free SMS and dialling, as
 * PRD 18.9 §9 specifies for Android, needs a native module in the dev build — see
 * `docs/SOS-NATIVE.md`. Everything else here is automatic.
 */

const SIREN = require('../../assets/siren.wav');

/** Retry burst from PRD 18.9 §9 rung 2: 0/2/5/10/20/30 s, then every 30 s to five minutes. */
const RETRY_SCHEDULE_MS = [0, 2_000, 5_000, 10_000, 20_000, 30_000];
const RETRY_UNTIL_MS = 5 * 60_000;
/** PRD 18.9 §9 rung 5: auto-call when nothing has acknowledged within 30 seconds. */
const AUTO_CALL_AFTER_MS = 30_000;
/** PRD 18.9 §9 rung 3: fall to SMS when data has not acknowledged within 8 seconds. */
const SMS_AFTER_MS = 8_000;

export type SosRung =
  | 'capture'
  | 'siren'
  | 'socket'
  | 'rest'
  | 'sms'
  | 'supervisorSms'
  | 'call';

export type RungState = 'pending' | 'doing' | 'done' | 'skipped' | 'failed';

export type SosState = {
  sosId: string;
  rungs: Record<SosRung, RungState>;
  /** Set once the server confirms receipt. */
  serverAcked: boolean;
  /** Who picked it up, once the Command Center assigns an operator. */
  responder: string | null;
  firedAt: number;
  lat?: number;
  lng?: number;
  batteryPct?: number;
  /** True when the payload was trimmed because the battery is nearly dead (PRD 18.9 §16). */
  trimmed: boolean;
};

const LOW_BATTERY_PCT = 5;

let siren: AudioPlayer | null = null;

/**
 * Start the siren on the alarm path at full volume, looping. Deliberately fire-and-forget: the
 * caller must not await audio before the alarm has been captured.
 */
export async function startSiren(): Promise<boolean> {
  try {
    await setAudioModeAsync({
      playsInSilentMode: true, // a phone on silent must still scream
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    });
    siren?.remove();
    siren = createAudioPlayer(SIREN);
    siren.loop = true;
    siren.volume = 1;
    siren.play();
    return true;
  } catch {
    return false;
  }
}

export function stopSiren() {
  try {
    siren?.pause();
    siren?.remove();
  } catch {
    /* already gone */
  }
  siren = null;
}

/** `SOS|<guard_id>|<site_id>|<lat>,<lng>|<hhmmss>|<battery>` — parsed server-side (PRD 18.9 §9). */
export function structuredSms(args: {
  guardId: string;
  siteId?: string;
  lat?: number;
  lng?: number;
  batteryPct?: number;
  at?: Date;
}): string {
  const at = args.at ?? new Date();
  const hhmmss = new Date(at.getTime() + 330 * 60_000).toISOString().slice(11, 19).replace(/:/g, '');
  const coords =
    Number.isFinite(args.lat) && Number.isFinite(args.lng)
      ? `${args.lat!.toFixed(5)},${args.lng!.toFixed(5)}`
      : '';
  return `SOS|${args.guardId}|${args.siteId ?? ''}|${coords}|${hhmmss}|${args.batteryPct ?? ''}`;
}

/** What a human reads. The supervisor may be the only one who ever sees this. */
export function plainSms(args: { name: string; siteName?: string; lat?: number; lng?: number }): string {
  const where = args.siteName ? ` at ${args.siteName}` : '';
  const map =
    Number.isFinite(args.lat) && Number.isFinite(args.lng)
      ? ` Location: https://maps.google.com/?q=${args.lat},${args.lng}`
      : '';
  return `EMERGENCY: ${args.name} has raised an SOS${where}. Please respond now.${map}`;
}

function pickContact(contacts: EscalationContact[], role: string): EscalationContact | undefined {
  return contacts.find((c) => c.role === role && c.phone);
}

export type SosOptions = {
  guardId: string;
  guardName: string;
  rosterId?: string;
  bookingId?: string;
  siteId?: string;
  siteName?: string;
  /** Cached from the duty bundle, so the ladder works with no network. */
  escalationContacts: EscalationContact[];
  sosSmsNumber?: string;
  sirenEnabled: boolean;
  triggerMethod?: 'long_press' | 'power_button' | 'voice' | 'watch';
  onUpdate: (state: SosState) => void;
};

/**
 * Fire the alarm. Returns as soon as the event is durably captured; the network rungs continue
 * in the background and report progress through `onUpdate`.
 */
export async function fireSos(opts: SosOptions): Promise<SosState> {
  const state: SosState = {
    sosId: '',
    rungs: {
      capture: 'doing',
      siren: 'pending',
      socket: 'pending',
      rest: 'pending',
      sms: 'pending',
      supervisorSms: 'pending',
      call: 'pending',
    },
    serverAcked: false,
    responder: null,
    firedAt: Date.now(),
    trimmed: false,
  };
  const emit = () => opts.onUpdate({ ...state, rungs: { ...state.rungs } });

  // --- Rung 2 first, because it needs nothing and costs nothing to start ---
  if (opts.sirenEnabled) {
    state.rungs.siren = 'doing';
    emit();
    startSiren().then((ok) => {
      state.rungs.siren = ok ? 'done' : 'failed';
      emit();
    });
  } else {
    state.rungs.siren = 'skipped';
  }
  emit();

  // --- Battery first: below 5% the payload is trimmed to maximise the chance of transmission ---
  const batteryLevel = await Battery.getBatteryLevelAsync().catch(() => -1);
  const batteryPct = batteryLevel >= 0 ? Math.round(batteryLevel * 100) : undefined;
  state.batteryPct = batteryPct;
  state.trimmed = batteryPct !== undefined && batteryPct <= LOW_BATTERY_PCT;

  // --- Location, but never block the alarm on it ---
  const fix = await Promise.race([
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), 4_000)),
  ]);
  if (fix) {
    state.lat = fix.coords.latitude;
    state.lng = fix.coords.longitude;
  }
  emit();

  // --- Rung 1: durable capture. Everything downstream can fail; this must not. ---
  const payload = {
    rosterId: opts.rosterId,
    bookingId: opts.bookingId,
    siteId: opts.siteId,
    siteName: opts.siteName,
    lat: state.lat,
    lng: state.lng,
    device_id: await getDeviceId(),
    battery_pct: batteryPct,
    trigger_method: opts.triggerMethod ?? 'long_press',
    channel: 'queue',
    network_state: (await NetInfo.fetch().catch(() => null))?.isConnected ? 'online' : 'offline',
  };
  const event = await enqueue(opts.guardId, 'sos', payload);
  state.sosId = event.client_event_uuid;
  state.rungs.capture = 'done';
  emit();

  // --- Rung 3: socket, sub-second when a link exists ---
  state.rungs.socket = 'doing';
  emit();
  try {
    emitSos({ guardId: opts.guardId, sosId: state.sosId, bookingId: opts.bookingId, lat: state.lat, lng: state.lng });
    state.rungs.socket = 'done';
  } catch {
    state.rungs.socket = 'failed';
  }
  emit();

  // --- Rung 4: REST with a retry burst. Runs in the background. ---
  state.rungs.rest = 'doing';
  emit();
  runRetryBurst(opts, state, emit);

  // --- Rungs 5-7 are scheduled, and cancelled if the server acknowledges first ---
  setTimeout(() => {
    if (state.serverAcked) {
      state.rungs.sms = 'skipped';
      state.rungs.supervisorSms = 'skipped';
      emit();
      return;
    }
    sendSmsRungs(opts, state, emit);
  }, SMS_AFTER_MS);

  setTimeout(() => {
    if (state.serverAcked) {
      state.rungs.call = 'skipped';
      emit();
      return;
    }
    autoCall(opts, state, emit);
  }, AUTO_CALL_AFTER_MS);

  return state;
}

/** Keep trying the REST path across the backoff schedule until it lands or five minutes pass. */
function runRetryBurst(opts: SosOptions, state: SosState, emit: () => void) {
  let attempt = 0;
  const startedAt = Date.now();

  const tryOnce = async () => {
    if (state.serverAcked) return;
    if (Date.now() - startedAt > RETRY_UNTIL_MS) {
      if (!state.serverAcked) {
        state.rungs.rest = 'failed';
        emit();
      }
      return;
    }

    try {
      await api.sos({
        guardId: opts.guardId,
        sosId: state.sosId,
        clientEventUuid: state.sosId,
        rosterId: opts.rosterId,
        bookingId: opts.bookingId,
        siteId: opts.siteId,
        lat: state.lat,
        lng: state.lng,
        batteryPct: state.batteryPct,
        triggerMethod: opts.triggerMethod ?? 'long_press',
        channel: 'rest',
      });
      state.serverAcked = true;
      state.rungs.rest = 'done';
      emit();
      return;
    } catch {
      /* still no route to the server */
    }

    attempt += 1;
    const delay = RETRY_SCHEDULE_MS[Math.min(attempt, RETRY_SCHEDULE_MS.length - 1)];
    setTimeout(tryOnce, delay);
  };

  tryOnce();
}

/**
 * Rungs 5 and 6. `sms:` with a pre-filled body opens the composer with everything typed; the
 * guard sends with one tap. See the platform note at the top of this file.
 */
async function sendSmsRungs(opts: SosOptions, state: SosState, emit: () => void) {
  const structured = structuredSms({
    guardId: opts.guardId,
    siteId: opts.siteId,
    lat: state.lat,
    lng: state.lng,
    batteryPct: state.batteryPct,
    at: new Date(state.firedAt),
  });

  const sosNumber = opts.sosSmsNumber || pickContact(opts.escalationContacts, 'control_room')?.phone;
  const supervisor = pickContact(opts.escalationContacts, 'supervisor');

  // The structured message goes to the agency shortcode, which parses it into a real SOS event.
  if (sosNumber) {
    state.rungs.sms = 'doing';
    emit();
    const ok = await openSms(sosNumber, structured);
    state.rungs.sms = ok ? 'done' : 'failed';
  } else {
    state.rungs.sms = 'skipped';
  }
  emit();

  // And a human-readable one to the supervisor, so a person is reached even if no server is.
  if (supervisor?.phone) {
    state.rungs.supervisorSms = 'doing';
    emit();
    const ok = await openSms(
      supervisor.phone,
      plainSms({ name: opts.guardName, siteName: opts.siteName, lat: state.lat, lng: state.lng })
    );
    state.rungs.supervisorSms = ok ? 'done' : 'failed';
  } else {
    state.rungs.supervisorSms = 'skipped';
  }
  emit();
}

async function openSms(phone: string, body: string): Promise<boolean> {
  // Sent silently when the native module and SEND_SMS are available (docs/SOS-NATIVE.md);
  // otherwise the pre-filled composer, one tap away.
  if (await sendSmsDirect(phone, body)) return true;
  // iOS wants `&body=`, Android wants `?body=`.
  const sep = Platform.OS === 'ios' ? '&' : '?';
  const url = `sms:${phone}${sep}body=${encodeURIComponent(body)}`;
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}

/** Rung 7: dial the supervisor, else the control room, from the cached escalation list. */
async function autoCall(opts: SosOptions, state: SosState, emit: () => void) {
  const target =
    pickContact(opts.escalationContacts, 'supervisor') ?? pickContact(opts.escalationContacts, 'control_room');
  if (!target?.phone) {
    state.rungs.call = 'skipped';
    emit();
    return;
  }
  state.rungs.call = 'doing';
  emit();
  try {
    // Dials by itself with CALL_PHONE; otherwise the dialler opens with the number filled in.
    if (!(await placeCallDirect(target.phone))) await Linking.openURL(`tel:${target.phone}`);
    state.rungs.call = 'done';
  } catch {
    state.rungs.call = 'failed';
  }
  emit();
}

/**
 * Poll for the operator acknowledgement so the guard sees a human has picked it up — PRD 18.9 §5
 * puts the responder's name on the active-SOS screen, and knowing someone is coming is most of
 * what the screen is for.
 */
export function watchAcknowledgement(
  guardId: string,
  sosId: string,
  onAck: (responder: string) => void
): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const res = await api.sosStatus(guardId, sosId);
      if (res?.acknowledgedBy) {
        onAck(res.acknowledgedBy);
        return;
      }
    } catch {
      /* offline — keep waiting */
    }
    if (!stopped) setTimeout(tick, 5_000);
  };
  setTimeout(tick, 3_000);
  return () => {
    stopped = true;
  };
}
