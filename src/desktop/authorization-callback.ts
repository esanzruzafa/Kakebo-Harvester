import type {
  AuthorizationCompletionInput,
  AuthorizationCompletionResult,
  AuthorizationService
} from "../auth/authorization-service.js";
import type { SqliteDatabase } from "../storage/database.js";
import { SynchronizationLock } from "../sync/sync-runner.js";

type DesktopAuthorizationService = Pick<
  AuthorizationService,
  "complete" | "pendingConnectionId"
>;

export async function completeDesktopAuthorization(input: {
  database: SqliteDatabase;
  authorization: DesktopAuthorizationService;
  completeActiveConnection: (
    connectionId: string,
    completion: () => Promise<AuthorizationCompletionResult>
  ) => Promise<AuthorizationCompletionResult> | undefined;
  callback: AuthorizationCompletionInput;
}): Promise<AuthorizationCompletionResult> {
  const connectionId = input.authorization.pendingConnectionId(
    input.callback.state
  );
  if (connectionId) {
    const activeCompletion = input.completeActiveConnection(connectionId, () =>
      input.authorization.complete(input.callback)
    );
    if (activeCompletion) return await activeCompletion;
  }

  const lock = new SynchronizationLock(input.database);
  lock.acquire();
  try {
    return await input.authorization.complete(input.callback);
  } finally {
    lock.release();
  }
}
