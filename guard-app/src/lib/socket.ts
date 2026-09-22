import { io, Socket } from 'socket.io-client';
import { SOCKET_URL } from '@/config';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(SOCKET_URL, {
      transports: ['websocket'],
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 2000,
    });
  }
  return socket;
}

/** Join the duty room so the client's live-tracking view receives this guard's fixes. */
export function joinDutyRoom(dutyId: string) {
  getSocket().emit('join-duty-room', dutyId);
}

/** Emit a live location fix (server broadcasts to the duty room + ops radar). */
export function emitLocation(data: { dutyId: string; lat: number; lng: number; heading?: number }) {
  getSocket().emit('guard-location-update', data);
}

/**
 * Broadcast an SOS over the socket — the fastest rung of the transmission ladder (PRD 18.9 §9).
 * `sosId` is the same key every other rung uses, so the Command Center dedupes them into one
 * alarm rather than one per channel.
 */
export function emitSos(data: {
  guardId: string;
  sosId?: string;
  siteId?: string;
  bookingId?: string;
  lat?: number;
  lng?: number;
}) {
  getSocket().emit('send-notification', { kind: 'SOS', ...data, at: new Date().toISOString() });
}

export function onNotification(cb: (data: any) => void): () => void {
  const s = getSocket();
  s.on('new-notification', cb);
  return () => s.off('new-notification', cb);
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
