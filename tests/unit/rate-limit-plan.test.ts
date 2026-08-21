import { describe, expect, it } from "vitest";
import type { ConnectionView } from "../../src/desktop/contracts.js";
import {
  onlineRetryDecision,
  rateLimitPlan
} from "../../src/desktop/rate-limit-plan.js";

function connection(
  id: string,
  input: Partial<ConnectionView> = {}
): ConnectionView {
  return {
    id,
    bank: id,
    alias: id,
    status: "AUTHORIZED",
    validUntil: null,
    lastSyncAt: null,
    reauthorizationRequired: false,
    retryAfterAt: null,
    errorCode: null,
    errorMessage: null,
    onlineRetryUsed: false,
    ...input
  };
}

describe("desktop rate-limit planning", () => {
  it("continues eligible banks when the online override is declined", () => {
    expect(
      onlineRetryDecision(
        { retryable: [], exhausted: [], hasEligibleConnection: true },
        false
      )
    ).toEqual({ proceed: true, allowOverride: false });
    expect(
      onlineRetryDecision(
        { retryable: [], exhausted: [], hasEligibleConnection: false },
        false
      )
    ).toEqual({ proceed: false, allowOverride: false });
  });

  it("keeps ready banks eligible when another bank exhausted its online retry", () => {
    const plan = rateLimitPlan(
      [
        connection("limited", {
          retryAfterAt: "2026-08-22T12:00:00.000Z",
          onlineRetryUsed: true
        }),
        connection("ready")
      ],
      Date.parse("2026-08-22T10:00:00.000Z")
    );

    expect(plan.retryable).toEqual([]);
    expect(plan.exhausted.map((item) => item.id)).toEqual(["limited"]);
    expect(plan.hasEligibleConnection).toBe(true);
  });

  it("offers an online attempt only for limited banks that have not used it", () => {
    const plan = rateLimitPlan(
      [
        connection("retryable", {
          retryAfterAt: "2026-08-22T12:00:00.000Z"
        }),
        connection("exhausted", {
          retryAfterAt: "2026-08-22T13:00:00.000Z",
          onlineRetryUsed: true
        })
      ],
      Date.parse("2026-08-22T10:00:00.000Z")
    );

    expect(plan.retryable.map((item) => item.id)).toEqual(["retryable"]);
    expect(plan.exhausted.map((item) => item.id)).toEqual(["exhausted"]);
    expect(plan.hasEligibleConnection).toBe(false);
  });
});
