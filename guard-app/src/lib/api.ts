import { API_BASE_URL } from '@/config';
import { authHeader, ensureFreshSession, handleUnauthorized } from '@/lib/session';

export class ApiError extends Error {
  status: number;
  /** Machine-readable refusal code from the server, when it sends one. */
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Json = Record<string, any>;

async function request<T = Json>(
  path: string,
  opts: { method?: string; body?: Json; query?: Record<string, string | number | undefined>; timeoutMs?: number } = {}
): Promise<T> {
  const { method = 'GET', body, query, timeoutMs = 20000 } = opts;
  const url = new URL(path.startsWith('http') ? path : `${API_BASE_URL}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  // Every guard call carries the session (renewed first when it is about to lapse).
  const isAuthCall = path.startsWith('/api/guard/auth/');
  if (!isAuthCall) await ensureFreshSession();

  const send = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(isAuthCall ? {} : authHeader()) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let data: any = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = {};
      }
      return { res, data };
    } finally {
      clearTimeout(timer);
    }
  };

  let { res, data } = await send();
  if (!isAuthCall && data?.action === 'LOGOUT') {
    await handleUnauthorized('guard_removed');
    throw new ApiError(data?.message || 'Please sign in again.', 401, 'guard_removed');
  }
  if (res.status === 401 && !isAuthCall && (await handleUnauthorized(data?.code))) {
    ({ res, data } = await send());
  }
  if (!res.ok || data?.success === false) {
    throw new ApiError(data?.message || data?.error || `Request failed (${res.status})`, res.status, data?.code);
  }
  return data as T;
}

/** Normalise a 10-digit or +91 phone to the +91XXXXXXXXXX shape the backend stores. */
export function e164(phone: string): string {
  const digits = phone.replace(/\D/g, '').slice(-10);
  return `+91${digits}`;
}

// ---------------------------------------------------------------------------
// Duty bundle (PRD 18.3 §10). The shape the Duty Home renders from, online or
// from cache. Everything here is server-decided: the app displays the verdict,
// it does not compute its own, so agency policy changes without an app release.
// ---------------------------------------------------------------------------

export type DutyStateName =
  | 'no_duty'
  | 'upcoming'
  | 'check_in'
  | 'late'
  | 'absent'
  | 'on_duty'
  | 'check_out'
  | 'complete';

export type EscalationContact = { name: string; phone: string; role: string };

export type AssignmentSite = {
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  geofenceRadiusM: number;
  /** false when the site has no coordinates — the geofence cannot be evaluated at all. */
  geoKnown: boolean;
  reportingPoint: string;
  uniformRequired: string;
  equipmentRequired: string[];
  escalationContacts: EscalationContact[];
  sirenEnabled: boolean;
};

export type Checkpoint = {
  checkpointId: string;
  name: string;
  scanCode: string;
  scanType: string;
  order: number;
};

export type PatrolRound = {
  roundId: string;
  scheduledDate: string;
  scheduledTime: string;
  status: string;
  checkpointIds: string[];
  scans: { checkpointId: string; scannedAt: string }[];
  /** true when the server had no authored round and returned the site's cadence as advisory. */
  generated: boolean;
};

export type WakeCheck = {
  wakeId: string;
  dueAt: string;
  ackWindowSec: number;
  selfieRequired: boolean;
  status: 'pending' | 'reprompted' | 'acknowledged' | 'acknowledged_late' | 'missed' | 'suppressed' | 'cancelled';
  acknowledgedAt: string | null;
};

export type Assignment = {
  rosterId: string;
  date: string;
  siteName: string;
  siteId: string;
  shiftType: string;
  timing: string;
  start: string;
  end: string;
  startAt: string;
  endAt: string;
  crossesMidnight: boolean;
  durationMin: number;
  rosterStatus: string;
  isReliever: boolean;
  replacedGuardName: string;
  site: AssignmentSite;
  briefing: { version: number; cards: { text: string; imageUrl: string; order: number }[] };
  policy: {
    checkInWindowBeforeMin: number;
    checkInWindowAfterMin: number;
    lateGraceMin: number;
    autoAbsentAfterMin: number;
    checkOutEarlyAllowedMin: number;
    autoCloseAfterMin: number;
  };
  wakeCheckEnabled: boolean;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  duty: {
    state: DutyStateName;
    countdownSec: number | null;
    canCheckIn: boolean;
    canCheckOut: boolean;
    lateByMin: number;
    earlyOutReasonRequired: boolean;
  };
};

export type CurrentAssignment = Assignment & {
  checkpoints: Checkpoint[];
  patrolRounds: PatrolRound[];
  wakeChecks: WakeCheck[];
};

export type TimelineItem = { key: string; label: string; done: boolean; at: string | null; route: string };
/** `label` is the server's English fallback; the app translates by `key` (`alerts.<key>`). */
export type DutyAlert = {
  key: string;
  severity: 'info' | 'warn' | 'danger';
  label: string;
  route: string;
  count?: number;
  site?: string;
};

export type DutyBundle = {
  serverTime: string;
  todayKey: string;
  guard: Record<string, any>;
  assignments: Assignment[];
  current: CurrentAssignment | null;
  timeline: TimelineItem[];
  alerts: DutyAlert[];
  /** The on-demand B2C booking path, still served alongside the roster. */
  booking: Record<string, any> | null;
  /** Live replacement offers, so a missed push does not mean a missed shift. */
  offers: ReplacementOffer[];
  /** Pending contract assignments from agency portal awaiting guard acceptance */
  contractOffers?: ContractOffer[];
  /** Active accepted contract for this guard */
  activeContract?: ContractOffer | null;
  recentAttendance: any[];
  notifications: any[];
};

export type ContractOffer = {
  contractId: string;
  title: string;
  client: string;
  site: string;
  startDate: string;
  endDate: string;
  shiftTiming: string;
  shiftHours: number;
  ratePerGuard?: number;
};

/** A replacement offer as the card renders it (PRD 18.12 GAP-S-055). */
export type ReplacementOffer = {
  offerId: string;
  vacancyId: string;
  siteName: string;
  siteId: string;
  shiftDate: string;
  timing: string;
  shiftType: string;
  /** Extra pay in integer paise (money is always paise — canon §4). */
  incentivePaise: number;
  distanceKm: number | null;
  expiresAt: string;
  status: 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled' | 'lost';
};

// ---------------------------------------------------------------------------
// Leave — PRD 18.12 / SUR-GAP-021
// ---------------------------------------------------------------------------

export type LeaveType = 'casual' | 'sick' | 'emergency' | 'unpaid';

export type LeaveRequest = {
  clientEventUuid: string;
  type: LeaveType;
  from: string;
  to: string;
  days: number | null;
  halfDay: boolean;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'completed';
  retrospective: boolean;
  decisionNote: string;
  createdAt: string;
};

/** `entitled`/`left` are null for unpaid leave, which has no balance. */
export type LeaveBalance = { type: LeaveType; entitled: number | null; used: number; left: number | null };

export type DocKind = 'aadhaar' | 'pan' | 'bank' | 'psara' | 'police';

export type GuardDocument = {
  kind: DocKind;
  status: 'Pending' | 'Verified' | 'Expiring' | 'Expired' | 'Rejected';
  number: string;
  expiresOn: string | null;
  uploadedAt: string;
  hasImage: boolean;
  awaitingUpload: boolean;
  reviewNote: string;
};

export type TicketCategory = 'pay' | 'attendance' | 'leave' | 'uniform' | 'app' | 'safety' | 'other';

export type SupportTicket = {
  ticketId: string;
  subject: string;
  status: string;
  createdAt: string;
  replies: { message: string; at: string }[];
  resolution: string;
};

export type ChangeField ='name' | 'dob' | 'bank' | 'upi' | 'address' | 'emergencyContact';

/** Masked on the server: an account number never comes back in full. */
export type PersonalDetails = {
  name: string;
  phone: string;
  dob: string;
  address: string;
  emergencyContact: string;
  payout: string;
  payoutMethod: '' | 'bank' | 'upi';
};

export type ChangeRequest = {
  requestId: string;
  field: ChangeField;
  category: 'identity' | 'payout' | 'contact';
  display: string;
  previousDisplay: string;
  reason: string;
  status: 'pending' | 'cooling_off' | 'approved' | 'applied' | 'rejected' | 'cancelled';
  effectiveAt: string | null;
  appliedAt: string | null;
  decisionNote: string;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Training — PRD 18.14 / SUR-GAP-024
// ---------------------------------------------------------------------------

/** Content carried per language, falling back to English (PRD 18.2 §9(c)). */
export type Localised = { en: string; [lang: string]: string | undefined };

export type TrainingLesson = {
  id: string;
  title: Localised;
  body: Localised;
  seconds: number;
  icon: string;
};

export type TrainingQuizOption = { id: string; label: Localised; icon: string };

/** No `correctOptionId`: the answer key stays on the server. */
export type TrainingQuestion = { id: string; prompt: Localised; options: TrainingQuizOption[] };

export type TrainingProgress = {
  status: 'Pending' | 'In Progress' | 'Completed';
  lessonsCompleted: string[];
  totalLessons: number;
  bestScorePct: number;
  passed: boolean;
  attempts: number;
  completedAt: string | null;
  expiresOn: string | null;
  expired: boolean;
  certificateId: string;
};

export type TrainingModule = {
  id: string;
  title: Localised;
  summary: Localised;
  minutes: number;
  mandatory: boolean;
  gatesPostTypes: string[];
  validityMonths: number | null;
  passMarkPct: number;
  icon: string;
  lessons: TrainingLesson[];
  quiz: TrainingQuestion[];
  progress?: TrainingProgress;
};

// ---------------------------------------------------------------------------
// Earnings & payslips — PRD 18.13. Money is integer paise throughout (canon §4).
// ---------------------------------------------------------------------------

export type PayLine = { code: string; label: string; amountPaise: number };

export type Payslip = {
  period: string;
  status: 'Pending' | 'Completed' | 'Archived';
  daysPresent: number;
  daysAbsent: number;
  paidLeave: number;
  otHours: number;
  earnings: PayLine[];
  deductions: PayLine[];
  grossPaise: number;
  deductionsPaise: number;
  netPaise: number;
  carriedForwardPaise: number;
  paidOn: string | null;
  referenceNo: string;
};

/** The running month, computed from attendance. Never to be shown as settled pay. */
export type EarningsEstimate = {
  isEstimate: true;
  period: string;
  daysPresent: number;
  daysAbsent: number;
  daysScheduled: number;
  /** Shifts a supervisor has not yet accepted — the reason the number may still move. */
  daysAwaitingReview: number;
  otHours: number;
  perDayPaise: number;
  basePaise: number;
  otPaise: number;
  grossPaise: number;
  deductionsKnown: false;
};

export type EarningsResponse = {
  success: boolean;
  period: string;
  monthlyWagePaise: number;
  /** Null once payroll has finalised the period. */
  estimate: EarningsEstimate | null;
  payslips: Payslip[];
  history: { period: string; netPaise: number }[];
};

// ---------------------------------------------------------------------------
// Supervisor (field) — PRD 18.16
// ---------------------------------------------------------------------------

export type TeamState = 'Scheduled' | 'On duty' | 'Late' | 'Absent' | 'Not checked in' | 'Checked out';

export type TeamMember = {
  guardId: string;
  name: string;
  phone: string;
  rosterId: string;
  siteName: string;
  shiftDate: string;
  timing: string;
  start: string;
  end: string;
  startAt: string;
  endAt: string;
  state: TeamState;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  lateByMin: number;
  isReliever: boolean;
  /** Set when a supervisor marked this attendance, not the guard. */
  proxyBy: string | null;
  trustScore: number | null;
  needsReview: boolean;
};

export type ReviewItem = {
  itemId: string;
  kind: 'attendance' | 'patrol';
  eventType: string;
  guardId: string;
  rosterId: string;
  siteName: string;
  at: string;
  flags: string[];
  trustScore: number | null;
  distanceM: number | null;
  geofenceResult?: string;
  outsideReason?: string;
  checkpointCode?: string;
  scanMethod?: string;
  mediaId: string;
};

export type SupervisorTeam = {
  success: boolean;
  isSupervisor: boolean;
  canVerify?: boolean;
  canProxy?: boolean;
  canBroadcast?: boolean;
  date?: string;
  siteNames?: string[];
  team: TeamMember[];
  reviewQueue: ReviewItem[];
  counts?: {
    total: number;
    onDuty: number;
    absent: number;
    notCheckedIn: number;
    pendingReview: number;
  };
};

/** What the server decided when the guard responded. `taken` means another guard won the race. */
export type OfferOutcome =
  | 'accepted'
  | 'declined'
  | 'taken'
  | 'expired'
  | 'cancelled'
  | 'conflict'
  | 'pending';

export type RosterShift = {
  rosterId: string;
  date: string;
  siteName: string;
  siteId: string;
  address: string;
  shiftType: string;
  timing: string;
  start: string;
  end: string;
  startAt: string;
  endAt: string;
  crossesMidnight: boolean;
  durationMin: number;
  status: 'Scheduled' | 'On duty' | 'Late' | 'Completed' | 'Absent';
  rosterStatus: string;
  isReliever: boolean;
  replacedGuardName: string;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  lateByMin: number;
  payout?: number;
  clientRating?: number;
  clientReview?: string;
  customerName?: string;
  customerPhone?: string;
  serviceRequirements?: Record<string, any>;
  eventType?: string;
  dressRequirement?: string;
  specialInstructions?: string;
};

export const api = {
  raw: request,

  // ---- Auth / identity (existing backend) ----
  authCheck: (phone: string) =>
    request<{ success: boolean; exists: boolean; guard?: any }>('/api/guard/auth/check', {
      method: 'POST',
      body: { phone: e164(phone) },
    }),

  // ---- Phone OTP (SMS-ready; dev returns devCode when no gateway configured) ----
  /** `appHash` lets the server end the SMS with this build's SMS Retriever hash (auto-read). */
  sendOtp: (phone: string, appHash?: string) =>
    request<{ success: boolean; delivered: boolean; provider: string; expiresAt: number; resendAvailableAt: number; devCode?: string }>(
      '/api/guard/auth/send-otp',
      { method: 'POST', body: { phone: e164(phone), ...(appHash ? { appHash } : {}) } }
    ),

  verifyOtp: (phone: string, otp: string, device?: { deviceId: string; deviceModel: string }) =>
    request<{
      success: boolean;
      verified: boolean;
      exists: boolean;
      guard?: any;
      deviceStatus?: 'bound' | 'ok' | 'change_pending';
      sessionToken?: string | null;
      sessionExpiresAt?: number | null;
      registerTicket?: string | null;
    }>(
      '/api/guard/auth/verify-otp',
      { method: 'POST', body: { phone: e164(phone), otp, ...device } }
    ),

  // ---- Agency link (uses existing approved-agency directory) ----
  agenciesApproved: () =>
    request<{ success: boolean; agencies: { id: string; name: string; city?: string }[] }>('/api/agencies/approved'),

  agencyLink: (guardId: string, agencyId: string, agencyName: string) =>
    request('/api/guard/agency/link', { method: 'POST', body: { guardId, agencyId, agencyName } }),

  // ---- Documents & face enrolment ----
  getDocuments: (guardId: string) =>
    request<{ success: boolean; documents: GuardDocument[] }>('/api/guard/documents', { query: { guardId } }),

  /** Record a document; the scan follows through the media queue under the same uuid. */
  uploadDocument: (payload: {
    guardId: string;
    kind: DocKind;
    clientEventUuid: string;
    mediaId?: string;
    number?: string;
    expiresOn?: string;
    blurSuspected?: boolean;
  }) => request<{ success: boolean; status: string; number: string }>('/api/guard/documents', { method: 'POST', body: payload }),

  /** Optional OCR pre-fill. `available: false` means the server has no OCR configured. */
  documentOcr: (guardId: string, kind: DocKind, mediaId: string) =>
    request<{ success: boolean; available: boolean; suggestion: { number?: string; expiresOn?: string } }>(
      '/api/guard/documents/ocr',
      { method: 'POST', body: { guardId, kind, mediaId }, timeoutMs: 25000 }
    ),

  // ---- Support (PRD 18.14 / SUR-GAP-027) ----
  createTicket: (payload: {
    guardId: string;
    clientEventUuid: string;
    category: TicketCategory;
    message?: string;
    mediaIds?: string[];
    period?: string;
  }) => request<{ success: boolean; ticketId?: string; duplicate?: boolean }>('/api/guard/support', { method: 'POST', body: payload }),

  myTickets: (guardId: string) =>
    request<{ success: boolean; tickets: SupportTicket[] }>('/api/guard/support', { query: { guardId } }),

  /** A 10-minute signed link the phone's PDF viewer can open. */
  payslipPdfLink: (guardId: string, period: string) =>
    request<{ success: boolean; url: string }>('/api/guard/earnings/pdf', { method: 'POST', body: { guardId, period } }),

  /**
   * Register an already-uploaded selfie as the guard's face enrolment. The image goes through
   * /api/guard/media first: an enrolment that lives only as a device path can never be compared
   * against anything (SUR-GAP-003).
   */
  faceEnroll: (guardId: string, mediaId: string, reason?: string) =>
    request<{ success: boolean; faceTemplateRef: string; comparable: boolean; verificationAvailable: boolean }>(
      '/api/guard/face/enroll',
      { method: 'POST', body: { guardId, mediaId, reason } }
    ),

  faceEnrolmentStatus: (guardId: string) =>
    request<{
      success: boolean;
      enrolled: boolean;
      comparable: boolean;
      verificationAvailable: boolean;
      reEnrolmentSuggested: boolean;
    }>('/api/guard/face/enroll', { query: { guardId } }),

  register: (payload: Json) =>
    request<{ success: boolean; guard: any; sessionToken?: string | null; sessionExpiresAt?: number | null }>(
      '/api/guard/auth/register',
      { method: 'POST', body: payload }
    ),

  me: (guardId: string) =>
    request<{ success: boolean; guard: any; earnings?: any; bookings?: any[] }>('/api/guard/me', {
      query: { guardId },
    }),

  // ---- On-demand duty (existing backend) ----
  toggleOnline: (guardId: string, isOnline: boolean, coords?: { lat: number; lng: number }) =>
    request('/api/guard/toggle-online', { method: 'POST', body: { guardId, isOnline, ...coords } }),

  requests: (guardId: string) =>
    request<{ success: boolean; booking: any | null; action?: string }>('/api/guard/requests', {
      query: { guardId },
    }),

  acceptBooking: (bookingId: string, guardId: string) =>
    request('/api/guard/accept', { method: 'POST', body: { bookingId, guardId } }),

  startDuty: (bookingId: string, guardId: string, otp: string) =>
    request('/api/guard/start-duty', { method: 'POST', body: { bookingId, guardId, otp } }),

  initiateCheckout: (bookingId: string, guardId: string) =>
    request('/api/guard/initiate-checkout', { method: 'POST', body: { bookingId, guardId } }),

  completeDuty: (bookingId: string, guardId: string, otp: string) =>
    request('/api/guard/complete-duty', { method: 'POST', body: { bookingId, guardId, otp } }),

  postLocation: (bookingId: string, guardId: string, lat: number, lng: number) =>
    request('/api/guard/location', { method: 'POST', body: { bookingId, guardId, lat, lng } }),

  notifications: (guardId: string) =>
    request<{ success: boolean; notifications: any[] }>('/api/guard/notifications', { query: { guardId } }),

  respondContract: (contractId: string, guardId: string, action: 'accept' | 'reject', reason?: string) =>
    request<{ success: boolean; message: string; status: string }>('/api/guard/contract/respond', {
      method: 'POST',
      body: { contractId, guardId, action, reason },
    }),

  // ---- Full-PRD guard endpoints (added on backend under /api/guard/*) ----

  /**
   * The one-round-trip duty bundle: roster, site, geofence, briefing, patrol + wake schedules.
   * `deviceId` lets the server enforce one-device-per-guard — an unapproved second phone gets a
   * bundle with no duty data and a "waiting for approval" alert (SUR-GAP-006).
   */
  today: (guardId: string, deviceId?: string) =>
    request<{ success: boolean; bundle: DutyBundle; deviceBlocked?: boolean; deviceStanding?: string }>(
      '/api/guard/today',
      { query: { guardId, deviceId } }
    ),

  /** This phone's standing against the guard's device binding. */
  deviceStatus: (guardId: string, deviceId: string) =>
    request<{ success: boolean; standing: 'ok' | 'change_pending' | 'blocked' | 'unbound'; allowed: boolean }>(
      '/api/guard/device',
      { query: { guardId, deviceId } }
    ),

  /** 7-day roster (PRD 18.4 GAP-S-014). `from` defaults to yesterday. */
  roster: (guardId: string, opts: { from?: string; days?: number } = {}) =>
    request<{ success: boolean; today: string; shifts: RosterShift[] }>('/api/guard/roster', {
      query: { guardId, from: opts.from, days: opts.days },
    }),

  attendance: (payload: Json) =>
    request<{
      success: boolean;
      duplicate?: boolean;
      rosterId?: string;
      geofenceResult?: 'inside' | 'outside' | 'unknown';
      distanceM?: number | null;
      lateByMin?: number;
    }>('/api/guard/attendance', { method: 'POST', body: payload }),

  /** The guard's own attendance history (GAP-S-024). */
  attendanceHistory: (guardId: string, limit = 60) =>
    request<{ success: boolean; events: any[] }>('/api/guard/attendance', { query: { guardId, limit } }),

  patrolScan: (payload: Json) =>
    request<{
      success: boolean;
      verified?: boolean;
      checkpointId?: string;
      checkpointName?: string;
      roundId?: string;
      roundStatus?: string;
      distanceM?: number | null;
      flags?: string[];
    }>('/api/guard/patrol', { method: 'POST', body: payload }),

  /** What the guard saw at a checkpoint, attached to the scan (PRD 18.7 §6). */
  patrolObservation: (payload: {
    guardId: string;
    scanUuid: string;
    observationType: 'all_ok' | 'issue' | 'note';
    note?: string;
    mediaIds?: string[];
  }) => request('/api/guard/patrol', { method: 'PATCH', body: payload }),

  patrolHistory: (guardId: string, limit = 50) =>
    request<{ success: boolean; scans: any[] }>('/api/guard/patrol', { query: { guardId, limit } }),

  wakeCheckAck: (payload: Json) =>
    request<{ success: boolean; status?: string; wakeId?: string }>('/api/guard/wake-check', {
      method: 'POST',
      body: payload,
    }),

  /** Wake-check compliance history; also triggers the server's missed-prompt sweep. */
  wakeHistory: (guardId: string) =>
    request<{ success: boolean; schedule: any[] }>('/api/guard/wake-check', { query: { guardId } }),

  sos: (payload: Json) =>
    request<{ success: boolean; sosId: string; duplicate: boolean }>('/api/guard/sos', {
      method: 'POST',
      body: payload,
      // The alarm path gets a short timeout: waiting 20s on a dead link delays the SMS rung.
      timeoutMs: 6000,
    }),

  /** Has an operator picked the alarm up yet? Drives the responder name on the SOS screen. */
  sosStatus: (guardId: string, sosId: string) =>
    request<{ success: boolean; found: boolean; status?: string; acknowledgedBy?: string | null; channels?: string[] }>(
      '/api/guard/sos',
      { query: { guardId, sosId }, timeoutMs: 8000 }
    ),

  sosHistory: (guardId: string) =>
    request<{ success: boolean; history: any[] }>('/api/guard/sos', { query: { guardId } }),

  /** Cancel with the guard's PIN already verified client-side (SUR-GAP-018). Never deletes. */
  sosCancel: (guardId: string, sosId: string, reason?: string) =>
    request('/api/guard/sos', { method: 'PATCH', body: { guardId, sosId, reason } }),

  incident: (payload: Json) =>
    request<{
      success: boolean;
      duplicate?: boolean;
      incidentKey?: string;
      incidentId?: string;
      priority?: string;
      severity?: string;
      /** True for an Emergency, which the server fans out to the Command Center at once. */
      escalated?: boolean;
    }>('/api/guard/incident', { method: 'POST', body: payload }),

  /** The guard's own reports (PRD 18.10 GAP-S-049). */
  myIncidents: (guardId: string) =>
    request<{ success: boolean; incidents: any[] }>('/api/guard/incident', { query: { guardId } }),

  /** Request leave. A 422 carries a plain-language message explaining why (PRD 18.12 §8). */
  leave: (payload: Json) =>
    request<{ success: boolean; clientEventUuid?: string; status?: string; days?: number; retrospective?: boolean }>(
      '/api/guard/leave',
      { method: 'POST', body: payload }
    ),

  /** Withdraw a request that has not been decided yet. */
  withdrawLeave: (guardId: string, clientEventUuid: string) =>
    request('/api/guard/leave', { method: 'PATCH', body: { guardId, clientEventUuid } }),

  // ---- Personal detail changes (PRD 18.11 / SUR-GAP-026) ----
  myDetails: (guardId: string) =>
    request<{
      success: boolean;
      details: PersonalDetails;
      requests: ChangeRequest[];
      rules: { locked: ChangeField[]; otpRequired: ChangeField[]; coolOffHours: number };
    }>('/api/guard/change-request', { query: { guardId } }),

  requestChange: (payload: { guardId: string; field: ChangeField; value: unknown; reason?: string; mediaIds?: string[]; otp?: string }) =>
    request<{ success: boolean; request: ChangeRequest }>('/api/guard/change-request', { method: 'POST', body: payload }),

  cancelChange: (guardId: string, requestId: string) =>
    request<{ success: boolean; request: ChangeRequest }>('/api/guard/change-request', {
      method: 'PATCH',
      body: { guardId, requestId, action: 'cancel' },
    }),

  /**
   * Earnings and payslips (PRD 18.13). Returns an `estimate` for the running month and finalised
   * `payslips` — kept separate so the app can never present an estimate as settled pay.
   */
  earnings: (guardId: string, period?: string) =>
    request<EarningsResponse>('/api/guard/earnings', { query: { guardId, period } }),

  // ---- Replacement offers (PRD 18.12 / SUR-GAP-022) ----
  offers: (guardId: string) =>
    request<{ success: boolean; offers: any[] }>('/api/guard/replacement', { query: { guardId } }),

  /**
   * Accept or decline. The server arbitrates: only one guard can win a vacancy, so `accepted` is
   * the only outcome the app may present as confirmed — never assume it locally (PRD 18.12 §16).
   */
  respondToOffer: (guardId: string, offerId: string, response: 'accept' | 'decline') =>
    request<{
      success: boolean;
      outcome: OfferOutcome;
      alreadyResponded?: boolean;
      message?: string;
      siteName?: string;
      shiftDate?: string;
      timing?: string;
    }>('/api/guard/replacement', {
      method: 'POST',
      body: { guardId, offerId, response },
      timeoutMs: 12000,
    }),

  /** Requests plus the balance per type, in days. */
  getLeaves: (guardId: string) =>
    request<{ success: boolean; leaves: LeaveRequest[]; balance: LeaveBalance[] }>('/api/guard/leave', {
      query: { guardId },
    }),

  /**
   * Bulk offline flush: the queued events in one idempotent batch, with per-event results so a
   * single poison event cannot sink the rest (PRD 18.15.3). `device` carries the uptime reading
   * at flush time, which is what lets the server reconstruct when each event really happened.
   */
  sync: (guardId: string, events: Json[], device?: { process_id: string; monotonic_now_ms: number }) =>
    request<{
      success: boolean;
      accepted: string[];
      results: { uuid: string; ok: boolean; retry?: boolean; type?: string; error?: string; detail?: any }[];
      sequenceGaps: { from: number; to: number }[];
    }>('/api/guard/sync', {
      method: 'POST',
      body: { guardId, events, device },
      timeoutMs: 40000,
    }),

  /** Analytics event (SUR-GAP-036 two-tap KPI + general funnel). Best-effort, never blocks. */
  /**
   * The platform's analytics route requires `pageUrl` and reads extra data from `metadata`;
   * without them every guard-app event was refused with a 400 and silently lost.
   */
  track: (event: string, props?: Json) =>
    request('/api/analytics/track', {
      method: 'POST',
      // `platform` is an enum there ('suraksha' | 'trinetra'); the app name goes in metadata.
      body: { event, pageUrl: `guard-app://${event}`, platform: 'suraksha', metadata: { app: 'guard_app', ...(props ?? {}) }, ts: Date.now() },
    }).catch(() => undefined),

  // ---- Supervisor (field): the extra "My team" tab (PRD 18.16 / SUR-GAP-034) ----

  /** Team state + the review queue in one call. `isSupervisor: false` simply hides the tab. */
  supervisorTeam: (guardId: string, date?: string) =>
    request<SupervisorTeam>('/api/guard/supervisor/team', { query: { guardId, date } }),

  /** Approve or reject a flagged attendance / patrol event. Appends, never rewrites. */
  supervisorVerify: (payload: {
    supervisorId: string;
    itemId: string;
    kind: 'attendance' | 'patrol';
    decision: 'approved' | 'rejected';
    reason?: string;
  }) =>
    request<{ success: boolean; decision?: string; alreadyDecided?: boolean }>('/api/guard/supervisor/verify', {
      method: 'POST',
      body: payload,
    }),

  /** Mark a guard present when their phone is dead. Always flagged, never silent. */
  supervisorProxy: (payload: Json) =>
    request<{ success: boolean; clientEventUuid: string; geofenceResult: string; distanceM: number | null }>(
      '/api/guard/supervisor/proxy',
      { method: 'POST', body: payload }
    ),

  /** The supervisor's own geo-stamped presence at a site. */
  supervisorSiteVisit: (payload: Json) =>
    request<{ success: boolean; clientEventUuid: string; geofenceResult: string; distanceM: number | null }>(
      '/api/guard/supervisor/site-visit',
      { method: 'POST', body: payload }
    ),

  // ---- P1/P2: training, notices, team, versioning, OTA i18n, assistant ----
  /**
   * Training catalogue with this guard's progress folded in (PRD 18.14). Lesson bodies and quiz
   * questions come down in full so a module can be completed offline; the answer key does not.
   */
  training: (guardId?: string) =>
    request<{ success: boolean; version: number; modules: TrainingModule[]; mandatoryOutstanding?: number }>(
      '/api/guard/training',
      { query: { guardId } }
    ),

  /** Mark one lesson finished. Idempotent — re-opening a lesson does not double-count it. */
  trainingLessonDone: (guardId: string, moduleId: string, lessonId: string) =>
    request<{ success: boolean; lessonsCompleted: string[]; totalLessons: number; allLessonsDone: boolean }>(
      '/api/guard/training',
      { method: 'POST', body: { guardId, moduleId, lessonId, action: 'lesson_done' } }
    ),

  /** Submit a quiz. Graded server-side — the device never holds the correct answers. */
  trainingQuizAttempt: (guardId: string, moduleId: string, answers: Record<string, string>, studySeconds: number) =>
    request<{
      success: boolean;
      scorePct: number;
      passed: boolean;
      passMarkPct: number;
      wrongQuestionIds: string[];
      attemptsSoFar: number;
      certificateId: string;
      expiresOn: string | null;
    }>('/api/guard/training', {
      method: 'POST',
      body: { guardId, moduleId, answers, studySeconds, action: 'quiz_attempt' },
    }),

  notices: (guardId: string) =>
    request<{ success: boolean; notices: any[] }>('/api/guard/notices', { query: { guardId } }),

  ackNotice: (guardId: string, noticeId: string) =>
    request('/api/guard/notices', { method: 'POST', body: { guardId, noticeId } }),

  team: (guardId: string) =>
    request<{ success: boolean; team: any[]; online: number; total: number }>('/api/guard/team', { query: { guardId } }),

  version: () =>
    request<{
      success: boolean;
      minSupported: string;
      latest: string;
      blockBelow?: string;
      storeUrl: string;
      message: string;
      degradedDisables?: string[];
      helpline?: string;
      commandCenter?: string;
    }>('/api/guard/version'),

  i18nCatalogue: () =>
    request<{ success: boolean; version: number; packs: Record<string, any> }>('/api/guard/i18n'),

  /** Guard-facing assistant — routes to the existing chatbot (read-only/recommendation only). */
  assistant: (message: string, guardId: string, lang: string, history: { role: 'user' | 'assistant'; text: string }[] = []) =>
    request<{ success: boolean; reply?: string; message?: string; answer?: string; source?: string }>('/api/guard/assistant', {
      method: 'POST',
      body: { message, guardId, lang, history },
      timeoutMs: 45000,
    }),
};
