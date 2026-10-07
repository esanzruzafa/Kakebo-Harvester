import { expect, it, vi } from "vitest";
import { createPersistentKutxabankSession } from "../../src/desktop/kutxabank-session.js";

it("disables HTTP caching and clears old cached bank content before returning the session", async () => {
  const clearCache = vi.fn(() => Promise.resolve());
  const session = { clearCache };
  const fromPath = vi.fn(() => session);

  await expect(createPersistentKutxabankSession({ fromPath } as never, "C:/bank-profile"))
    .resolves.toBe(session);
  expect(fromPath).toHaveBeenCalledWith("C:/bank-profile", { cache: false });
  expect(clearCache).toHaveBeenCalledOnce();
});
