import type { FastifyInstance } from "fastify";
import type {
  AuthorizationCompletionResult,
  AuthorizationService
} from "./authorization-service.js";
import { safeMessage } from "../utils/text.js";

interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

function page(
  language: "en" | "es",
  title: string,
  message: string,
  closeMessage: string
): string {
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><title>${title}</title></head>
<body style="margin:0;color:#17251f;background:#f4f0e7;font-family:Arial,Helvetica,sans-serif">
<main style="max-width:42rem;margin:10vh auto;padding:3rem;border:1px solid #d9d2c3;background:#fffdf8;box-shadow:0 24px 70px rgba(32,45,38,.11)">
<p style="color:#b8792a;font-size:.78rem;font-weight:700;letter-spacing:.16em;text-transform:uppercase">Kakebo Harvester</p>
<h1 style="font-family:Georgia,'Times New Roman',serif;font-size:2.4rem">${title}</h1>
<p style="color:#53635b;line-height:1.65">${message}</p>
<p style="color:#53635b;line-height:1.65">${closeMessage}</p>
</main></body></html>`;
}

export interface CallbackControllerEvents {
  onAuthorizationResult?: (result: AuthorizationCompletionResult) => void;
  getLanguage?: () => "en" | "es";
  translate?: (key: string, fallback: string) => string;
}

export function registerCallback(
  server: FastifyInstance,
  authorizationService: AuthorizationService,
  events: CallbackControllerEvents = {}
): void {
  server.get<{ Querystring: CallbackQuery }>("/callback", async (request, reply) => {
    const language =
      events.getLanguage?.() ??
      (request.headers["accept-language"]?.toLowerCase().startsWith("es")
        ? "es"
        : "en");
    const translate = (key: string, english: string, spanish: string): string =>
      events.translate?.(key, language === "es" ? spanish : english) ??
      (language === "es" ? spanish : english);
    const closeMessage = translate(
      "callback.page.close",
      "You can close this window now.",
      "Ya puedes cerrar esta ventana."
    );
    try {
      const result = await authorizationService.complete({
        ...(request.query.state ? { state: request.query.state } : {}),
        ...(request.query.code ? { code: request.query.code } : {}),
        ...(request.query.error ? { error: request.query.error } : {}),
        ...(request.query.error_description
          ? { errorDescription: request.query.error_description }
          : {})
      });
      events.onAuthorizationResult?.(result);
      if (result.status === "authorized") {
        return await reply
          .type("text/html; charset=utf-8")
          .send(
            page(
              language,
              translate(
                "callback.page.successTitle",
                "Connection completed",
                "Conexión completada"
              ),
              translate(
                "callback.page.successMessage",
                "The account was authorized successfully.",
                "La cuenta ha quedado autorizada correctamente."
              ),
              closeMessage
            )
          );
      }
      return await reply
        .status(400)
        .type("text/html; charset=utf-8")
        .send(
          page(
            language,
            translate(
              "callback.page.errorTitle",
              "The connection could not be completed",
              "No se pudo completar la conexión"
            ),
            translate(
              "callback.page.deniedMessage",
              "Authorization was cancelled or the bank could not complete it. Return to the application and try again.",
              "La autorización fue cancelada o el banco no pudo completarla. Vuelve a la aplicación para intentarlo de nuevo."
            ),
            closeMessage
          )
        );
    } catch (error) {
      request.log.warn({ error: safeMessage(error) }, "Bank authorization callback failed");
      return await reply
        .status(400)
        .type("text/html; charset=utf-8")
        .send(
          page(
            language,
            translate(
              "callback.page.errorTitle",
              "The connection could not be completed",
              "No se pudo completar la conexión"
            ),
            translate(
              "callback.page.invalidMessage",
              "Authorization is invalid, expired, or was cancelled. Start the process again.",
              "La autorización no es válida, ha caducado o fue cancelada. Vuelve a iniciar el proceso."
            ),
            closeMessage
          )
        );
    }
  });
}
