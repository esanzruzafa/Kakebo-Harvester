import { describe, expect, it, vi } from "vitest";
import {
  assertTrustedDesktopRequest,
  executeAccountRemovalRequest,
  parseAccountRemovalRequest
} from "../../src/desktop/account-removal-request.js";

describe("account removal desktop request", () => {
  it.each([
    { id: "", mode: "keep-history" },
    { id: "   ", mode: "delete-history" },
    { id: "account-1", mode: "delete-all" },
    { id: "account-1", mode: "keep-history", extra: true }
  ])("rejects malformed request %# before an account operation begins", (request) => {
    expect(() => parseAccountRemovalRequest(request)).toThrow();
  });

  it("rejects a request that is not from the current desktop window", () => {
    expect(() =>
      assertTrustedDesktopRequest({
        expectedSenderId: 4,
        expectedUrl: "file:///kakebo/index.html",
        senderId: 9,
        senderUrl: "file:///kakebo/index.html",
        closing: false
      })
    ).toThrow("Rejected IPC request from an untrusted renderer.");
  });

  it("blocks removal while a tracked account operation is active", async () => {
    const remove = vi.fn();

    await expect(
      executeAccountRemovalRequest({
        request: { id: "account-1", mode: "keep-history" },
        hasActiveOperation: () => true,
        remove
      })
    ).rejects.toThrow("Wait for the current account operation to finish");

    expect(remove).not.toHaveBeenCalled();
  });

  it("passes a validated request to the local operation only", async () => {
    const remove = vi.fn().mockResolvedValue({ status: "hidden" });

    await expect(
      executeAccountRemovalRequest({
        request: { id: " account-1 ", mode: "keep-history" },
        hasActiveOperation: () => false,
        remove
      })
    ).resolves.toEqual({ status: "hidden" });

    expect(remove).toHaveBeenCalledWith({
      id: "account-1",
      mode: "keep-history"
    });
  });
});
