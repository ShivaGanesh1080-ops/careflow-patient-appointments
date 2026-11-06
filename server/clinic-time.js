// Scheduling strings are clinic wall time, not UTC. Do not rewrite stored records.
const IST_OFFSET_MS = 330 * 60 * 1000;
function localNow(instant = new Date()) {
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19);
}
function localDate(instant = new Date()) {
  return localNow(instant).slice(0, 10);
}
function shiftDate(date, days) {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}
function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const instant = new Date(date + 'T00:00:00Z');
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === date;
}
module.exports = { localDate, localNow, shiftDate, validDate };
