/** Browser access to guard APIs. Native clients do not send an Origin header. */
export function guardCorsHeaders(origin: string | null): Record<string, string> | null {
  if (!origin) return null;
  const allowed = new Set([
    'https://guards.surakshaguards.in',
    ...(process.env.GUARD_WEB_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  ]);
  if (process.env.NODE_ENV !== 'production') {
    allowed.add('http://localhost:8081');
    allowed.add('http://127.0.0.1:8081');
  }
  if (!allowed.has(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600',
  };
}
