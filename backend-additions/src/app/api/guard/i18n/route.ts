import { NextResponse } from 'next/server';

/**
 * Over-the-air translation catalogue (PRD 18.2 / SUR-GAP-038). The app calls this on launch,
 * compares `version`, and merges any newer string packs into its bundled catalogue — so a
 * wording fix or a new language ships without an app release. Served as reference data.
 */
const CATALOGUE = {
  version: 1,
  // Only overrides/additions need to live here; the app keeps hi + en bundled as the base.
  packs: {} as Record<string, Record<string, any>>,
};

export async function GET() {
  return NextResponse.json({ success: true, ...CATALOGUE });
}
