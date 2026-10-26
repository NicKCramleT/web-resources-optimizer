const UNITS = ['B', 'KB', 'MB', 'GB'];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${UNITS[unit]}`;
}

/** Porcentaje ahorrado (negativo si el resultado es más grande). */
export function savingsPercent(before: number, after: number): number {
  if (before === 0) return 0;
  return Math.round(((before - after) / before) * 1000) / 10;
}
