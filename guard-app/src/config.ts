import Constants from 'expo-constants';

type Extra = {
  apiBaseUrl?: string;
  socketUrl?: string;
};

const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

/**
 * Base URL of the Suraksha backend (the Next.js app behind guards.surakshaguards.in).
 *
 * `EXPO_PUBLIC_API_BASE_URL` overrides it, which is how you point a debug build at a staging
 * server without editing app.json — set it in `.env` or inline when starting the bundler:
 *   EXPO_PUBLIC_API_BASE_URL=http://192.168.1.5:4546 npx expo start
 * Production builds set nothing and fall through to app.json.
 */
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL || extra.apiBaseUrl || 'https://guards.surakshaguards.in';

/** Socket.io origin (same custom server as the API, wss upgraded by nginx). */
export const SOCKET_URL = process.env.EXPO_PUBLIC_SOCKET_URL || extra.socketUrl || API_BASE_URL;

/**
 * Attendance / duty tuning. These mirror PRD 18 defaults but are agency-configurable
 * server-side; the app treats them as fallbacks until a config bundle overrides them.
 */
export const DUTY = {
  checkInWindowBeforeMin: 60,
  checkInWindowAfterMin: 240,
  lateGraceMin: 15,
  autoAbsentAfterMin: 60,
  geofenceAcceptM: 100,
  locationAccuracyAcceptM: 100,
} as const;

/** Location ping cadence by state (seconds), weighted per PRD 34.3.1 / V-5. */
export const PING_INTERVAL_SEC = {
  stationaryInGeofence: 120,
  batterySaver: 300,
  moving: 60,
  patrol: 30,
} as const;

export const OTP_DEMO_CODE = '123456'; // backend currently uses a dummy OTP (see backend memory)
