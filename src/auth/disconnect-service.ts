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
      `SELECT c.id, s.provider_session_id_ciphertext
       FROM bank_connections c
       LEFT JOIN provider_sessions s ON s.bank_connection_id = c.id
         AND s.status = 'AUTHORIZED'
       WHERE c.id = ?
         AND c.environment = ?
         AND c.provider = 'enable-banking'
       ORDER BY s.created_at DESC LIMIT 1`
    )
    .get(input.connectionId, input.config.appEnv) as
    | { id: string; provider_session_id_ciphertext: string | null }
    | undefined;
  if (!connection) {
    throw new Error("The bank connection does not exist or is unavailable.");
  }

  const remoteRevocationAttempted =
    connection.provider_session_id_ciphertext !== null;
  let remoteRevoked = false;
  if (connection.provider_session_id_ciphertext) {
    try {
      await input.client.deleteSession(
        decryptSecret(
          connection.provider_session_id_ciphertext,
          input.config.sessionEncryptionKey
        )
      );
      remoteRevoked = true;
    } catch {
      remoteRevoked = false;
    }
  }

  input.database.transaction(() => {
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
