import { describe, expect, it } from "vitest";
import { rowDropInsertionIndex } from "../../src/desktop/row-drop.js";

describe("rowDropInsertionIndex", () => {
  it("places a dragged row after a target when dropped on its lower half", () => {
    expect(rowDropInsertionIndex(0, 1, true)).toBe(1);
    expect(rowDropInsertionIndex(3, 1, true)).toBe(2);
  });

  it("places a dragged row before a target when dropped on its upper half", () => {
    expect(rowDropInsertionIndex(0, 2, false)).toBe(1);
    expect(rowDropInsertionIndex(3, 1, false)).toBe(1);
  });
});
