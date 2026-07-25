export const metadata = {
  title: "Política de privacidad",
  description: "Política de privacidad de la aplicación Kakebo Harvester."
};

export default function SpanishPrivacyPage() {
  return (
    <div className="legal-shell" lang="es">
      <aside className="legal-aside">
        <p className="eyebrow">Documento 01</p>
        <p>Versión: 25 de julio de 2026</p>
        <p>Ámbito: España</p>
        <p>
          Contacto:{" "}
          <a href="mailto:kakebo.harvester@gmail.com">
            kakebo.harvester@gmail.com
          </a>
        </p>
      </aside>
      <article className="legal-document">
        <p className="eyebrow">Kakebo Harvester</p>
        <h1>Política de privacidad</h1>

        <div className="notice">
          Kakebo Harvester es una aplicación personal, no comercial y de solo
          lectura. No inicia pagos, transferencias ni operaciones financieras.
        </div>

        <h2>1. Responsable</h2>
        <p>
          El responsable de Kakebo Harvester es Eduardo Sanz, con residencia en
          España. Para cualquier consulta sobre privacidad puedes escribir a{" "}
          <a href="mailto:kakebo.harvester@gmail.com">
            kakebo.harvester@gmail.com
          </a>
          .
        </p>

        <h2>2. Información tratada</h2>
        <p>
          Cuando autorizas una conexión bancaria, la aplicación puede consultar
          los datos que la entidad exponga mediante PSD2/Open Banking:
        </p>
        <ul>
          <li>Información descriptiva y moneda de las cuentas autorizadas.</li>
          <li>Saldos y fechas de referencia.</li>
          <li>
            Movimientos, importes, fechas, conceptos y contrapartes cuando estén
            disponibles.
          </li>
          <li>
            Identificadores técnicos necesarios para mantener la sesión y evitar
            duplicados.
          </li>
        </ul>
        <p>
          Los números de cuenta se enmascaran en el modelo interno y no se
          incluyen completos en la exportación para análisis.
        </p>

        <h2>3. Finalidad y base</h2>
        <p>
          La información se utiliza únicamente para importar y organizar las
          finanzas personales del usuario, generar un archivo compatible con
          Kakebo y mantener las sincronizaciones autorizadas. El acceso se basa
          en el consentimiento concedido durante el flujo de autorización
          bancaria y, cuando corresponda, en la prestación solicitada por el
          propio usuario.
        </p>

        <h2>4. Procedencia y proveedores</h2>
        <p>
          Los datos proceden de las entidades bancarias expresamente autorizadas
          y se obtienen a través de Enable Banking, proveedor de conectividad
          AISP/Open Banking. El banco y Enable Banking aplican sus propias
          condiciones y políticas a los tratamientos que realizan.
        </p>

        <h2>5. Almacenamiento y seguridad</h2>
        <p>
          Kakebo Harvester se ejecuta localmente. La base de datos, los
          movimientos y las exportaciones se conservan en el equipo del usuario.
          Los identificadores de sesión se cifran localmente, los identificadores
          de cuenta se enmascaran y los archivos con datos financieros se
          excluyen del repositorio de código.
        </p>
        <p>
          La aplicación no vende datos, no incorpora publicidad y no envía
          telemetría financiera a terceros.
        </p>

        <h2>6. Conservación</h2>
        <p>
          Las sesiones se mantienen mientras el consentimiento siga vigente o
          hasta su revocación. Los movimientos históricos pueden conservarse
          localmente para mantener el registro Kakebo hasta que el usuario decida
          eliminarlos. Las respuestas técnicas de diagnóstico opcionales pueden
          desactivarse y eliminarse desde el equipo.
        </p>

        <h2>7. Derechos y retirada del consentimiento</h2>
        <p>
          Puedes solicitar información, rectificación, supresión, limitación,
          oposición o portabilidad escribiendo al correo indicado. También
          puedes retirar el consentimiento desde tu banco o desde la gestión de
          consentimientos de Enable Banking. La retirada no afecta a tratamientos
          realizados previamente de forma legítima.
        </p>
        <p>
          Si consideras que el tratamiento incumple la normativa, puedes acudir
          a la{" "}
          <a href="https://www.aepd.es/" rel="noreferrer">
            Agencia Española de Protección de Datos
          </a>
          .
        </p>

        <h2>8. Cambios</h2>
        <p>
          Esta política podrá actualizarse si cambia el funcionamiento de la
          aplicación o la normativa aplicable. La fecha de la versión vigente
          aparecerá al inicio del documento.
        </p>
      </article>
    </div>
  );
}
