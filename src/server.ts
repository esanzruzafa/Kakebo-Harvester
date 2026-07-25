import Fastify, { LogController } from "fastify";
import type { AppConfig } from "./config.js";
import type { AuthorizationService } from "./auth/authorization-service.js";
import { registerCallback } from "./auth/callback-controller.js";

export async function startServer(
  config: AppConfig,
  authorizationService: AuthorizationService
): Promise<void> {
  const server = Fastify({
    logger: { level: config.logLevel },
    logController: new LogController({ disableRequestLogging: true })
  });
  registerCallback(server, authorizationService);
  server.get("/health", () => ({ status: "ok", environment: config.appEnv }));
  await server.listen({ port: config.appPort, host: "127.0.0.1" });
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      void server.close().finally(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
