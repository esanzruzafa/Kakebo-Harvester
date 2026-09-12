import { z } from "zod";

export const accountRemovalRequestSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    mode: z.enum(["keep-history", "delete-history"])
  })
  .strict();

export type AccountRemovalRequest = z.infer<typeof accountRemovalRequestSchema>;

export function parseAccountRemovalRequest(input: unknown): AccountRemovalRequest {
  return accountRemovalRequestSchema.parse(input);
}

export function assertTrustedDesktopRequest(input: {
  expectedSenderId: number | undefined;
  expectedUrl: string | undefined;
  senderId: number;
  senderUrl: string | undefined;
  closing: boolean;
}): void {
  if (
    input.expectedSenderId === undefined ||
    input.expectedUrl === undefined ||
    input.senderId !== input.expectedSenderId ||
    input.senderUrl !== input.expectedUrl
  ) {
    throw new Error("Rejected IPC request from an untrusted renderer.");
  }
  if (input.closing) throw new Error("The application is closing.");
}

export async function executeAccountRemovalRequest<Result>(input: {
  request: unknown;
  hasActiveOperation: () => boolean;
  remove: (request: AccountRemovalRequest) => Promise<Result>;
}): Promise<Result> {
  const request = parseAccountRemovalRequest(input.request);
  if (input.hasActiveOperation()) {
    throw new Error("Wait for the current account operation to finish before removing an account.");
  }
  return await input.remove(request);
}

export async function runAccountRemovalWithSnapshot<Snapshot, Result>(input: {
  previousSnapshot: Snapshot;
  nextSnapshot: Snapshot;
  saveSnapshot: (snapshot: Snapshot) => Promise<void>;
  remove: () => Promise<Result>;
}): Promise<Result> {
  try {
    await input.saveSnapshot(input.nextSnapshot);
  } catch (error) {
    throw new Error("Could not save the local account snapshot.", { cause: error });
  }
  try {
    return await input.remove();
  } catch (error) {
    try {
      await input.saveSnapshot(input.previousSnapshot);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "The local account operation failed and the account snapshot could not be restored.",
        { cause: rollbackError }
      );
    }
    throw error;
  }
}

export async function commitAccountRemovalWithSnapshot<Snapshot, Result>(input: {
  previousSnapshot: Snapshot;
  nextSnapshot: Snapshot;
  saveSnapshot: (snapshot: Snapshot) => Promise<void>;
  begin: () => Promise<{
    finalize: () => Promise<Result>;
    rollback: () => void;
  }>;
}): Promise<Result> {
  const pending = await input.begin();
  try {
    await input.saveSnapshot(input.nextSnapshot);
  } catch (error) {
    try {
      pending.rollback();
      await input.saveSnapshot(input.previousSnapshot);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "The local account operation could not restore a consistent account snapshot.",
        { cause: rollbackError }
      );
    }
    throw new Error("Could not save the local account snapshot.", { cause: error });
  }
  return await pending.finalize();
}

export function registerAccountRemovalHandler<Event, Result, Bootstrap>(input: {
  register: (
    channel: "accounts:remove",
    handler: (event: Event, request: unknown) => Promise<{
      removal: Result;
      bootstrap: Bootstrap | null;
      warnings: Array<{ step: "bootstrap-refresh"; message: string }>;
    }>
  ) => void;
  assertTrustedSender: (event: Event) => void;
  hasActiveOperation: () => boolean;
  trackOperation: <Value>(operation: Promise<Value>) => Promise<Value>;
  withSynchronizationLock: <Value>(operation: () => Promise<Value>) => Promise<Value>;
  remove: (request: AccountRemovalRequest) => Promise<Result>;
  refresh: (removal: Result) => Promise<Bootstrap>;
}): void {
  input.register("accounts:remove", async (event, request) => {
    input.assertTrustedSender(event);
    const removal = await executeAccountRemovalRequest({
      request,
      hasActiveOperation: input.hasActiveOperation,
      remove: async (parsedRequest) =>
        await input.trackOperation(
          input.withSynchronizationLock(async () => await input.remove(parsedRequest))
        )
    });
    try {
      return { removal, bootstrap: await input.refresh(removal), warnings: [] };
    } catch {
      return {
        removal,
        bootstrap: null,
        warnings: [{
          step: "bootstrap-refresh",
          message: "The account was removed. Refresh the app to reload local data."
        }]
      };
    }
  });
}
