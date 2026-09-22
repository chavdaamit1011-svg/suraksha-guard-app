import { Schema, model, models } from 'mongoose';

/**
 * Guard App media registry (PRD 18.5 §7 `selfie_media_id`, 18.10 §7, 18.15.3).
 *
 * Until now the app queued a local `file://` URI and the sync route stored that string — so no
 * image ever reached the server and every attendance selfie / incident photo / voice note was
 * evidence that did not exist. This collection is the server-side record of an uploaded file:
 * the app uploads the bytes, gets a `mediaId`, and puts the id (never the local path) on the
 * field event.
 *
 * Files are written OUTSIDE `public/` (see /api/guard/media) because selfies and incident media
 * are personal data with role-scoped access (PRD 18.5 §14, §39) — they are served back through
 * an ownership-checked route, not by the static file server.
 */
const GuardMediaSchema = new Schema(
  {
    mediaId: { type: String, required: true, unique: true, index: true },
    guardId: { type: String, required: true, index: true },

    /** selfie | wake_selfie | incident_photo | incident_video | voice | document | sos_photo */
    kind: { type: String, required: true, index: true },

    mime: { type: String, default: '' },
    ext: { type: String, default: '' },
    bytes: { type: Number, default: 0 },
    /** Path relative to the media root — never an absolute path, never client-supplied. */
    relPath: { type: String, default: '' },

    /** SHA-256 of the stored bytes. Drives reused-media detection (PRD 18.6 signal set). */
    sha256: { type: String, default: '', index: true },

    /** The field event this media belongs to, so metadata and evidence reconcile after sync. */
    clientEventUuid: { type: String, default: '', index: true },
    bookingId: { type: String, default: '' },
    rosterId: { type: String, default: '' },

    /** Device-clock capture time; `createdAt` is the server receipt time. */
    deviceTime: { type: Date },

    /** Set when the file has been removed by retention policy but the record is kept (§39). */
    purgedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

GuardMediaSchema.index({ guardId: 1, createdAt: -1 });

export const GuardMedia = models.GuardMedia || model('GuardMedia', GuardMediaSchema);
