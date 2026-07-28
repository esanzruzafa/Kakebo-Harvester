import type { AppConfig } from "../config.js";
import type { PsuHeaders } from "../enable-banking/client.js";
import { CsvExporter } from "../export/csv-exporter.js";
import {
  KakeboError,
  ReauthorizationRequiredError,
  SyncAlreadyRunningError,
  providerErrorCode
} from "../errors.js";
import type { SqliteDatabase } from "../storage/database.js";
import { DesktopRunRepository } from "../storage/repositories/desktop-run-repository.js";
import { createId } from "../utils/crypto.js";
import { assertIsoDate } from "../utils/dates.js";
import { safeMessage } from "../utils/text.js";
import type { SyncService, SyncSummary } from "./sync-service.js";
import type { SyncExecutionContext } from "./sync-service.js";

export type SyncStep = "accounts" | "balances" | "transactions" | "export";

export interface SyncRequest {
  steps: SyncStep[];
  dateFrom: string;
  dateTo: string;
  allowRateLimitOverride?: boolean;
}

export interface SyncRunResult {
  accounts?: number;
  balances?: number;
  transactions?: SyncSummary;
  export?: { path: string; rows: number };
}

export interface SyncProgressEvent {
  type:
    | "run-started"
    | "step-started"
    | "step-completed"
    | "reauthorization-required"
    | "run-completed"
    | "run-failed";
  step?: SyncStep;
  completedSteps: number;
  totalSteps: number;
  message: string;
}

export interface SyncRunOptions {
  onProgress?: (event: SyncProgressEvent) => void;
  onReauthorization?: (connectionIds: readonly string[]) => Promise<void>;
  psuHeaders?: PsuHeaders;
  allowRateLimitOverride?: boolean;
}

const orderedSteps: SyncStep[] = [
  "accounts",
  "balances",
  "transactions",
  "export"
];

export class SynchronizationLock {
  private readonly owner = createId();
  private acquired = false;

  public constructor(private readonly database: SqliteDatabase) {}

  public acquire(): void {
    const staleBefore = new Date(Date.now() - 6 * 60 * 60 * 1_000).toISOString();
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `DELETE FROM application_locks
           WHERE name = 'synchronization' AND acquired_at < ?`
        )
        .run(staleBefore);
      this.database
        .prepare(
          `INSERT INTO application_locks (name, owner, acquired_at)
           VALUES ('synchronization', ?, ?)`
        )
        .run(this.owner, new Date().toISOString());
    });
    try {
      transaction();
      this.acquired = true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        String(error.code).startsWith("SQLITE_CONSTRAINT")
      ) {
        throw new SyncAlreadyRunningError();
      }
      throw error;
    }
  }

  public release(): void {
    if (!this.acquired) return;
    this.database
      .prepare(
        `DELETE FROM application_locks
         WHERE name = 'synchronization' AND owner = ?`
      )
      .run(this.owner);
    this.acquired = false;
  }
}

export class SyncRunner {
  private readonly exporter: CsvExporter;

  public constructor(
    config: AppConfig,
    private readonly database: SqliteDatabase,
    private readonly sync: SyncService
  ) {
    this.exporter = new CsvExporter(config, database);
  }

  private async executeStep(
    step: SyncStep,
    request: SyncRequest,
    result: SyncRunResult,
    desktopRunId: string,
    context: SyncExecutionContext
  ): Promise<void> {
    if (step === "accounts") {
      result.accounts = await this.sync.syncAccounts(context);
    }
    if (step === "balances") {
      result.balances = await this.sync.syncBalances(desktopRunId, context);
    }
    if (step === "transactions") {
      result.transactions = await this.sync.syncTransactions(
        request.dateFrom,
        request.dateTo,
        context
      );
    }
    if (step === "export") result.export = await this.exporter.export({ highlightSource: "banking" });
  }

  public async run(
    request: SyncRequest,
    options: SyncRunOptions = {}
  ): Promise<SyncRunResult> {
    const dateFrom = assertIsoDate(request.dateFrom, "dateFrom");
    const dateTo = assertIsoDate(request.dateTo, "dateTo");
    if (dateFrom > dateTo) {
      throw new Error("The start date cannot be later than the end date.");
    }
    const selected = new Set(request.steps);
    const steps = orderedSteps.filter((step) => selected.has(step));
    if (steps.length === 0) throw new Error("Select at least one synchronization step.");

    const lock = new SynchronizationLock(this.database);
    const audit = new DesktopRunRepository(this.database);
    const result: SyncRunResult = {};
    const context: SyncExecutionContext = {
      ...(options.psuHeaders ? { psuHeaders: options.psuHeaders } : {}),
      ...(options.allowRateLimitOverride
        ? { allowRateLimitOverride: true }
        : {})
    };
    let completedSteps = 0;
    const progress = (
      type: SyncProgressEvent["type"],
      message: string,
      step?: SyncStep
    ): void => {
      options.onProgress?.({
        type,
        ...(step ? { step } : {}),
        completedSteps,
        totalSteps: steps.length,
        message
      });
    };

    lock.acquire();
    const desktopRunId = audit.begin({
      dateFrom,
      dateTo,
      steps
    });
    progress("run-started", "Synchronization started.");
    try {
      for (const step of steps) {
        progress("step-started", `Running ${step}.`, step);
        let reauthorizationAttempts = 0;
        for (;;) {
          try {
            await this.executeStep(
              step,
              request,
              result,
              desktopRunId,
              context
            );
            break;
          } catch (error) {
            if (
              error instanceof ReauthorizationRequiredError &&
              options.onReauthorization &&
              reauthorizationAttempts < 5
            ) {
              const connectionIds =
                error.connectionIds.length > 0
                  ? error.connectionIds
                  : this.sync.listConnectionsRequiringAuthorization();
              if (connectionIds.length === 0) throw error;
              progress(
                "reauthorization-required",
                "Bank authorization is required before synchronization can continue.",
                step
              );
              await options.onReauthorization(connectionIds);
              reauthorizationAttempts += 1;
              continue;
            }
            throw error;
          }
        }
        completedSteps += 1;
        progress("step-completed", `${step} completed.`, step);
      }
      audit.finish(desktopRunId, "SUCCESS");
      progress("run-completed", "Synchronization completed.");
      return result;
    } catch (error) {
      audit.finish(
        desktopRunId,
        "FAILED",
        safeMessage(error),
        providerErrorCode(error) ??
          (error instanceof KakeboError ? error.code : "SYNC_ERROR")
      );
      progress("run-failed", error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      lock.release();
    }
  }
}
