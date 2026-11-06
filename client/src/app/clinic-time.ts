// Asia/Kolkata has a fixed +05:30 offset. Existing scheduling strings are wall time.
export const CLINIC_DATE_PIPE_OPTIONS = { timezone: '+0530' };
const IST_OFFSET_MS = 330 * 60 * 1000;
export function clinicDate(instant = new Date(), offsetDays = 0): string {
  return new Date(instant.getTime() + IST_OFFSET_MS + offsetDays * 86400000)
    .toISOString()
    .slice(0, 10);
}
export function clinicTimestamp(value: string): string {
  // Only timezone-less scheduling values get an offset; preserve explicit instants.
  return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)
    ? value.replace(' ', 'T') + '+05:30'
    : value;
}
export function clinicMillis(value: string): number {
  return Date.parse(clinicTimestamp(value));
}
export function isFutureClinicTime(value: string, now = Date.now()): boolean {
  return clinicMillis(value) > now;
}
// API response boundary: never mutate input, database values or outgoing requests.
// Only these schema-defined audit fields are UTC; never infer from every *_at key.
const UTC_AUDIT_FIELDS = new Set([
  'created_at',
  'read_at',
  'checked_in_at',
  'completed_at',
  'recorded_at',
]);
export function utcAuditTimestamp(value: string): string {
  return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value;
}
export function normalizeClinicResponse<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => normalizeClinicResponse(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        (key === 'start_time' || key === 'end_time') && typeof item === 'string'
          ? clinicTimestamp(item)
          : UTC_AUDIT_FIELDS.has(key) && typeof item === 'string'
            ? utcAuditTimestamp(item)
            : normalizeClinicResponse(item),
      ]),
    ) as T;
  }
  return value;
}
