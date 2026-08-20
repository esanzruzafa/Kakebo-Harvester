/**
 * Returns the insertion index after removing the dragged row. Dropping on the
 * lower half of a row places the dragged item after that row.
 */
export function rowDropInsertionIndex(
  from: number,
  target: number,
  dropAfter: boolean
): number {
  const insertionBeforeRemoval = target + (dropAfter ? 1 : 0);
  return from < insertionBeforeRemoval
    ? insertionBeforeRemoval - 1
    : insertionBeforeRemoval;
}
