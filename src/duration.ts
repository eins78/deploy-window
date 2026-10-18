// Duration syntax shared by commands and configuration (DWA-GEN-007, DWA-CMD-005).
// Digits are ASCII only: Unicode digits such as fullwidth ３ never match.
const DURATION = /^(?:([0-9]{1,2})h)?(?:([0-9]{1,3})m)?$/;

/** Returns the duration in minutes, or undefined when the text is not a duration. */
export function parseDuration(text: string): number | undefined {
  const lower = text.toLowerCase();
  if (lower === '') return undefined;
  const m = DURATION.exec(lower);
  if (!m) return undefined;
  const hours = m[1] === undefined ? 0 : Number(m[1]);
  const minutes = m[2] === undefined ? 0 : Number(m[2]);
  return hours * 60 + minutes;
}

export function isDuration(text: string): boolean {
  return parseDuration(text) !== undefined;
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${String(m)}m`;
  if (m === 0) return `${String(h)}h`;
  return `${String(h)}h${String(m)}m`;
}
