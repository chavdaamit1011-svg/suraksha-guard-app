import { readFile } from 'fs/promises';
import path from 'path';
import { GuardMedia } from '@/lib/models/GuardMedia';

/** Where uploaded guard media lives — outside `public/`, so it is only ever served with a check. */
export function mediaRoot(): string {
  return path.join(process.cwd(), 'storage', 'guard-media');
}

/** Read a guard's own media bytes, or null when missing, purged, or not theirs. */
export async function readOwnMedia(mediaId: string, guardId: string): Promise<Buffer | null> {
  const doc: any = await GuardMedia.findOne({ mediaId, guardId }).lean();
  if (!doc || doc.purgedAt) return null;
  const abs = path.join(mediaRoot(), doc.relPath);
  if (!abs.startsWith(mediaRoot())) return null;
  return readFile(abs).catch(() => null);
}
