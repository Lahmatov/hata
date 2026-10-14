export type Slot = 'morning' | 'day' | 'evening';

/**
 * Which digest a run at this Lisbon hour belongs to. With slot start hours (e.g. 7,13,19) a slot lasts until
 * the next one starts: GitHub runs scheduled jobs hours late or skips them, so a run at 14:55 still does the
 * 13h digest (once: the caller skips a slot already done today). null: before the first slot.
 */
export function slotFor(hour: number, starts?: number[]): Slot | null {
  const names: Slot[] = ['morning', 'day', 'evening'];
  if (!starts?.length) return hour < 11 ? 'morning' : hour < 17 ? 'day' : 'evening';
  const i = [...starts].sort((a, b) => a - b).filter((h) => h <= hour).length - 1;
  return i < 0 ? null : names[Math.min(i, names.length - 1)];
}
