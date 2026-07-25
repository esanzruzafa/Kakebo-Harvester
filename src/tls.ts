import tls from "node:tls";
import { ConfigurationError } from "./errors.js";

interface SystemCaTls {
  getCACertificates?: (type?: "default" | "system" | "bundled" | "extra") => string[];
  setDefaultCACertificates?: (certificates: string[]) => void;
}

export function configureTlsTrust(useSystemCa: boolean): void {
  if (!useSystemCa) return;

  const systemCaTls = tls as SystemCaTls;
  if (
    typeof systemCaTls.getCACertificates !== "function" ||
    typeof systemCaTls.setDefaultCACertificates !== "function"
  ) {
    throw new ConfigurationError(
      "Esta versión de Node no permite cargar el almacén de certificados del sistema en ejecución. Usa Node 22.19 o superior, o configura NODE_EXTRA_CA_CERTS antes de arrancar."
    );
  }

  const certificates = [
    ...systemCaTls.getCACertificates("default"),
    ...systemCaTls.getCACertificates("system")
  ];
  systemCaTls.setDefaultCACertificates(certificates);
}
