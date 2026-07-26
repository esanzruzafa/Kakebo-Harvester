import { readFileSync } from "node:fs";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import type { AuthorizationService } from "./auth/authorization-service.js";
import {
  registerCallback,
  type CallbackControllerEvents
} from "./auth/callback-controller.js";

export function createCallbackServer(
  config: AppConfig,
  authorizationService: AuthorizationService,
  events: CallbackControllerEvents = {}
): FastifyInstance {
  const https =
    config.appEnv === "production" && config.tlsPfxPath && config.tlsPfxPassphrasePath
      ? {
          pfx: readFileSync(config.tlsPfxPath),
          passphrase: readFileSync(config.tlsPfxPassphrasePath, "utf8").trim()
        }
      : undefined;
  const server = Fastify({
    logger: { level: config.logLevel },
    logController: new LogController({ disableRequestLogging: true }),
    ...(https ? { https } : {})
  });
  registerCallback(server, authorizationService, events);
  server.get("/health", () => ({ status: "ok", environment: config.appEnv }));
  return server;
}

export async function startCallbackServer(
  config: AppConfig,
  authorizationService: AuthorizationService,
  events: CallbackControllerEvents = {}
): Promise<FastifyInstance> {
  const server = createCallbackServer(config, authorizationService, events);
  await server.listen({ port: config.appPort, host: "127.0.0.1" });
  return server;
}

export async function startServer(
  config: AppConfig,
  authorizationService: AuthorizationService
): Promise<void> {
  const server = await startCallbackServer(config, authorizationService);
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      void server.close().finally(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
