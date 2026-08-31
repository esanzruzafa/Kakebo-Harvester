import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerCallback } from "../../src/auth/callback-controller.js";

describe("authorization callback page", () => {
  it("escapes translated content and applies a restrictive content policy", async () => {
    const server = Fastify({ logger: false });
    registerCallback(
      server,
      {
        complete: () =>
          Promise.resolve({
            connectionId: "connection",
            bankName: "Demo",
            status: "authorized"
          })
      },
      {
        translate: () => '<script>alert("unsafe")</script>'
      }
    );

    try {
      const response = await server.inject({
        method: "GET",
        url: `/callback?state=${"a".repeat(43)}&code=code`
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("<script>");
      expect(response.body).toContain("&lt;script&gt;");
      expect(response.body).toContain("default-src 'none'; style-src 'unsafe-inline'");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-security-policy"]).toContain(
        "frame-ancestors 'none'"
      );
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    } finally {
      await server.close();
    }
  });

  it("keeps an authorized callback successful when a UI observer fails", async () => {
    const server = Fastify({ logger: false });
    registerCallback(
      server,
      {
        complete: () =>
          Promise.resolve({
            connectionId: "connection",
            bankName: "Demo",
            status: "authorized"
          })
      },
      {
        onAuthorizationResult: () => {
          throw new Error("Renderer closed during notification.");
        }
      }
    );

    try {
      const response = await server.inject({
        method: "GET",
        url: `/callback?state=${"a".repeat(43)}&code=code`
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Connection completed");
    } finally {
      await server.close();
    }
  });
});
