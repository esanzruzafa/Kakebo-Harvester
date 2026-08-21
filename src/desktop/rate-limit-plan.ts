import type { ConnectionView } from "./contracts.js";

export interface RateLimitPlan {
  retryable: ConnectionView[];
  exhausted: ConnectionView[];
  hasEligibleConnection: boolean;
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
    hasEligibleConnection: authorized.some(
      (connection) => !limitedIds.has(connection.id)
    )
  };
}
