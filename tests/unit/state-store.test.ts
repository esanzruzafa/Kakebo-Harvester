import { describe, expect, it } from "vitest";
import { createDatabase } from "../../src/storage/database.js";
import { StateStore } from "../../src/auth/state-store.js";
import { createId } from "../../src/utils/crypto.js";
import { InvalidStateError } from "../../src/errors.js";

describe("authorization state", () => {
  it("can only be consumed once", () => {
    const database = createDatabase(":memory:");
    const connectionId = createId();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES (?, 'enable-banking', 'sandbox', 'Demo', 'ES', 'personal',
                   'Demo personal', 'PENDING_AUTHORIZATION', ?)`
      )
      .run(connectionId, new Date().toISOString());
    const store = new StateStore(database);
    store.save("secret-state", {
      bankConnectionId: connectionId,
      bankName: "Demo",
      redirectUrl: "http://localhost:8000/callback",
      environment: "sandbox"
    });

    expect(store.consume("secret-state").bankConnectionId).toBe(connectionId);
    expect(() => store.consume("secret-state")).toThrow(InvalidStateError);
    database.close();
  });
});
