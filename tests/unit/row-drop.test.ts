import { describe, expect, it } from "vitest";
import {
  adjacentMovableIndex,
  rowDropInsertionIndex
} from "../../src/desktop/row-drop.js";

describe("rowDropInsertionIndex", () => {
  it("places a dragged row after a target when dropped on its lower half", () => {
    expect(rowDropInsertionIndex(0, 1, true)).toBe(1);
    expect(rowDropInsertionIndex(3, 1, true)).toBe(2);
    expect(rowDropInsertionIndex(2, 0, true)).toBe(1);
  });

  it("places a dragged row before a target when dropped on its upper half", () => {
    expect(rowDropInsertionIndex(0, 2, false)).toBe(1);
    expect(rowDropInsertionIndex(3, 1, false)).toBe(1);
  });

  it("finds the next enabled row for keyboard reordering", () => {
    const movable = [0, 2, 4];

    expect(adjacentMovableIndex(2, -1, movable)).toBe(0);
    expect(adjacentMovableIndex(2, 1, movable)).toBe(4);
    expect(adjacentMovableIndex(0, -1, movable)).toBeUndefined();
    expect(adjacentMovableIndex(4, 1, movable)).toBeUndefined();
  });
});
