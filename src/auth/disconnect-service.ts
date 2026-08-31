import type { AppConfig } from "../config.js";
import type { EnableBankingClient } from "../enable-banking/client.js";
import type { SqliteDatabase } from "../storage/database.js";
import { decryptSecret } from "../utils/crypto.js";

export interface DisconnectResult {
  remoteRevocationAttempted: boolean;
  remoteRevoked: boolean;
}

export async function disconnectBankConnection(input: {
  config: AppConfig;
  database: SqliteDatabase;
  client: EnableBankingClient;
  connectionId: string;
}): Promise<DisconnectResult> {
  const connection = input.database
    .prepare(
      `SELECT c.id
       FROM bank_connections c
       WHERE c.id = ?
         AND c.environment = ?
         AND c.provider = 'enable-banking'`
    )
    .get(input.connectionId, input.config.appEnv) as { id: string } | undefined;
  if (!connection) {
    throw new Error("The bank connection does not exist or is unavailable.");
  }

  const sessions = input.database
    .prepare(
      `SELECT provider_session_id_ciphertext
       FROM provider_sessions
       WHERE bank_connection_id = ?
         AND status IN ('AUTHORIZED', 'REVOCATION_REQUIRED')
       ORDER BY created_at DESC`
    )
    .all(connection.id) as Array<{ provider_session_id_ciphertext: string }>;
  const remoteRevocationAttempted = sessions.length > 0;
  let remoteRevoked = remoteRevocationAttempted;
  for (const session of sessions) {
    try {
      await input.client.deleteSession(
        decryptSecret(
          session.provider_session_id_ciphertext,
          input.config.sessionEncryptionKey
        )
      );
    } catch {
      remoteRevoked = false;
    }
  }

  input.database.transaction(() => {
    input.database
      .prepare("DELETE FROM pending_authorizations WHERE bank_connection_id = ?")
      .run(connection.id);
    input.database
      .prepare("DELETE FROM provider_sessions WHERE bank_connection_id = ?")
      .run(connection.id);
    input.database
      .prepare("UPDATE accounts SET active = 0 WHERE bank_connection_id = ?")
      .run(connection.id);
    input.database
      .prepare(
        `UPDATE bank_connections SET
           status = 'REVOKED', reauthorization_required = 1,
           retry_after_at = NULL, error_code = NULL, error_message_safe = NULL,
           online_retry_used = 0
         WHERE id = ?`
      )
      .run(connection.id);
  })();

  return { remoteRevocationAttempted, remoteRevoked };
}
