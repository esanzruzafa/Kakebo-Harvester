import type { FastifyInstance } from "fastify";
import type { AuthorizationService } from "./authorization-service.js";
import { safeMessage } from "../utils/text.js";

interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

function page(title: string, message: string): string {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem">
<h1>${title}</h1><p>${message}</p><p>Ya puedes cerrar esta ventana.</p></body></html>`;
}

export function registerCallback(
  server: FastifyInstance,
  authorizationService: AuthorizationService
): void {
  server.get<{ Querystring: CallbackQuery }>("/callback", async (request, reply) => {
    try {
      await authorizationService.complete({
        ...(request.query.state ? { state: request.query.state } : {}),
        ...(request.query.code ? { code: request.query.code } : {}),
        ...(request.query.error ? { error: request.query.error } : {}),
        ...(request.query.error_description
          ? { errorDescription: request.query.error_description }
          : {})
      });
      return await reply
        .type("text/html; charset=utf-8")
        .send(page("Conexión completada", "La cuenta ha quedado autorizada correctamente."));
    } catch (error) {
      request.log.warn({ error: safeMessage(error) }, "Bank authorization callback failed");
      return await reply
        .status(400)
        .type("text/html; charset=utf-8")
        .send(
          page(
            "No se pudo completar la conexión",
            "La autorización no es válida, ha caducado o fue cancelada. Vuelve a iniciar el proceso."
          )
        );
    }
  });
}
