export const metadata = {
  title: "Términos de uso",
  description: "Términos de uso de la aplicación Kakebo Harvester."
};

export default function SpanishTermsPage() {
  return (
    <div className="legal-shell" lang="es">
      <aside className="legal-aside">
        <p className="eyebrow">Documento 02</p>
        <p>Versión: 21 de agosto de 2026</p>
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
        <h1>Términos de uso</h1>

        <div className="notice">
          Utiliza Kakebo Harvester de forma lícita y conecta únicamente cuentas
          para las que tengas autorización de acceso.
        </div>

        <h2>1. Titular</h2>
        <p>
          Kakebo Harvester es una aplicación personal de Eduardo Sanz, España.
          El canal de contacto es{" "}
          <a href="mailto:kakebo.harvester@gmail.com">
            kakebo.harvester@gmail.com
          </a>
          .
        </p>

        <h2>2. Servicio</h2>
        <p>
          La aplicación consulta cuentas autorizadas, saldos y movimientos a
          través de servicios PSD2/Open Banking, los almacena localmente y genera
          una exportación para su análisis en un Kakebo.
        </p>
        <p>
          El servicio es exclusivamente informativo y de solo lectura. No
          permite ordenar pagos, transferencias, retiradas, inversiones ni
          ninguna otra operación financiera.
        </p>

        <h2>3. Uso permitido</h2>
        <p>
          El código fuente de Kakebo Harvester se distribuye bajo la{" "}
          <a href="https://github.com/esanzruzafa/Kakebo-Harvester/blob/main/LICENSE">
            licencia MIT
          </a>
          , que regula los derechos de uso, copia, modificación y distribución
          del software.
        </p>
        <ul>
          <li>Uso lícito conforme a la licencia MIT.</li>
          <li>
            Autorización únicamente de cuentas sobre las que el usuario tenga
            derecho de acceso.
          </li>
          <li>
            Custodia responsable del equipo, claves locales y accesos bancarios.
          </li>
        </ul>
        <p>
          No está permitido utilizar la aplicación para acceder a datos de
          terceros sin autorización ni para infringir las condiciones del banco
          o de Enable Banking.
        </p>

        <h2>4. Autorización y revocación</h2>
        <p>
          El usuario completa la autenticación exclusivamente en el entorno
          oficial del banco o del proveedor Open Banking. Kakebo Harvester no
          solicita ni almacena contraseñas, PIN, códigos SMS u OTP. El
          consentimiento puede caducar o revocarse y, en ese caso, será necesario
          autorizar de nuevo la conexión.
        </p>

        <h2>5. Datos de terceros</h2>
        <p>
          La disponibilidad, el histórico y la exactitud de los datos dependen
          de cada entidad bancaria y de Enable Banking. Sus servicios están
          sujetos a sus propias condiciones, políticas y posibles periodos de
          indisponibilidad.
        </p>

        <h2>6. Ausencia de asesoramiento</h2>
        <p>
          Los saldos, categorías, presupuestos e informes generados no
          constituyen asesoramiento financiero, fiscal, contable o jurídico.
          Antes de tomar decisiones financieras debes contrastar la información
          con la entidad correspondiente y, si procede, con un profesional.
        </p>

        <h2>7. Disponibilidad y responsabilidad</h2>
        <p>
          La aplicación se ofrece tal cual y puede contener errores o verse
          afectada por cambios en APIs bancarias. No se garantiza la
          disponibilidad ininterrumpida ni que todos los productos o
          movimientos estén accesibles mediante PSD2.
        </p>
        <p>
          Nada en estos términos limita los derechos que la legislación
          aplicable reconozca al usuario ni excluye responsabilidades que
          legalmente no puedan excluirse.
        </p>

        <h2>8. Finalización</h2>
        <p>
          El usuario puede dejar de utilizar la aplicación, desconectar sus
          sesiones y revocar el consentimiento desde el banco o Enable Banking.
          Los datos locales pueden eliminarse desde el equipo bajo control del
          usuario.
        </p>

        <h2>9. Legislación y cambios</h2>
        <p>
          Estos términos se interpretan conforme a la legislación española. Las
          actualizaciones se publicarán en esta página indicando la fecha de la
          versión vigente.
        </p>
      </article>
    </div>
  );
}
