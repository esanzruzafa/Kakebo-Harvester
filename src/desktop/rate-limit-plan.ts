import type { ConnectionView } from "./contracts.js";

export interface RateLimitPlan {
  retryable: ConnectionView[];
  exhausted: ConnectionView[];
  hasEligibleConnection: boolean;
}

export interface OnlineRetryDecision {
  proceed: boolean;
  allowOverride: boolean;
}

export function onlineRetryDecision(
  plan: RateLimitPlan,
  accepted: boolean
): OnlineRetryDecision {
  if (accepted) return { proceed: true, allowOverride: true };
  return {
    proceed: plan.hasEligibleConnection,
    allowOverride: false
  };
}

export function rateLimitPlan(
  connections: ConnectionView[],
  now = Date.now()
): RateLimitPlan {
  const authorized = connections.filter(
    (connection) =>
      connection.status === "AUTHORIZED" && !connection.reauthorizationRequired
  );
  const limited = authorized.filter(
    (connection) =>
      connection.retryAfterAt !== null &&
      new Date(connection.retryAfterAt).getTime() > now
  );
  const limitedIds = new Set(limited.map((connection) => connection.id));
  return {
    retryable: limited.filter((connection) => !connection.onlineRetryUsed),
    exhausted: limited.filter((connection) => connection.onlineRetryUsed),
    hasEligibleConnection: connections.some(
      (connection) =>
        !["DENIED", "REVOKED"].includes(connection.status) &&
        !limitedIds.has(connection.id)
    )
  };
}
