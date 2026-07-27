import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Aplicación",
  description:
    "Descarga, manual de uso, funciones y preguntas frecuentes de Kakebo Harvester para Windows."
};

const releaseUrl =
  "https://github.com/esanzruzafa/Kakebo-Harvester/releases/latest";
const repositoryUrl = "https://github.com/esanzruzafa/Kakebo-Harvester";

export default function SpanishApplicationPage() {
  return (
    <div lang="es" className="product-shell">
      <section className="product-hero">
        <p className="eyebrow">Aplicación Windows de código abierto</p>
        <h1>Tus datos bancarios, preparados localmente.</h1>
        <p className="hero-copy">
          Kakebo Harvester consulta datos de Open Banking en modo de solo
          lectura, los conserva en tu ordenador y genera un XLSX o CSV
          configurable para tu análisis privado.
        </p>
        <div className="hero-actions">
          <a className="download-link" href={releaseUrl}>
            Descargar la última versión
          </a>
          <a className="secondary-link" href={repositoryUrl}>
            Ver el código en GitHub
          </a>
        </div>
        <p className="release-note">
          Windows x64 · Portable · No requiere instalar Node.js · Las versiones
          incluyen una suma SHA-256
        </p>
      </section>

      <section className="product-section">
        <p className="eyebrow">Qué hace</p>
        <h2>Un flujo local y sencillo</h2>
        <div className="feature-grid">
          <article>
            <strong>01</strong>
            <h3>Sincronizar</h3>
            <p>
              Elige un intervalo y consulta cuentas, saldos y movimientos. Si
              caduca el consentimiento, se renueva en el navegador del sistema.
            </p>
          </article>
          <article>
            <strong>02</strong>
            <h3>Organizar</h3>
            <p>
              Añade alias y mantén reglas ordenadas con listas dependientes de
              categorías y subcategorías. Unifica extractos XLSX solapados de
              tarjetas que Open Banking no exponga.
            </p>
          </article>
          <article>
            <strong>03</strong>
            <h3>Exportar</h3>
            <p>
              Elige XLSX o CSV, campos, orden, nombres de columnas y separadores
              regionales sin modificar código. Las filas nuevas del XLSX
              reciben un resaltado suave temporal.
            </p>
          </article>
          <article>
            <strong>04</strong>
            <h3>Auditar</h3>
            <p>
              Expande ejecuciones agrupadas, compara sus saldos por cuenta y
              consulta el saldo total de cada ejecución.
            </p>
          </article>
        </div>
      </section>

      <section className="product-section guide-section">
        <p className="eyebrow">Primeros pasos</p>
        <h2>Preparar la carpeta portable</h2>
        <ol className="guide-steps">
          <li>Descarga el último ejecutable portable desde GitHub Releases.</li>
          <li>
            Colócalo en una carpeta privada junto a tu
            <code>.env.production</code> completo.
          </li>
          <li>
            Guarda el PEM de producción en <code>private/</code>. La
            configuración estará en <code>config/</code> y los datos en
            <code>data/production/</code>.
          </li>
          <li>
            Inicia el ejecutable y permite que prepare HTTPS local para tu
            usuario de Windows.
          </li>
          <li>
            Ejecuta Doctor, completa la autorización bancaria y prueba una
            sincronización manual corta.
          </li>
        </ol>
        <div className="notice">
          El ejecutable nunca contiene tus credenciales, PEM, clave de cifrado,
          base de datos ni resultados. Conserva la carpeta privada completa al
          cambiar de ordenador.
        </div>
      </section>

      <section className="product-section">
        <p className="eyebrow">Preguntas frecuentes</p>
        <h2>FAQ</h2>
        <div className="faq-list">
          <details>
            <summary>¿Puede Kakebo Harvester mover dinero?</summary>
            <p>
              No. Utiliza acceso de solo lectura a información de cuentas y no
              implementa pagos ni transferencias.
            </p>
          </details>
          <details>
            <summary>¿Dónde se guardan mis datos?</summary>
            <p>
              En tu ordenador, en la base de datos SQLite y la carpeta opcional
              de datos raw configuradas en <code>.env.production</code>.
            </p>
          </details>
          <details>
            <summary>¿Qué pasa si cambio el perfil de exportación?</summary>
            <p>
              En la siguiente exportación, cualquier resultado con otro perfil
              se mueve a la carpeta de archivo antes de escribir el nuevo.
            </p>
          </details>
          <details>
            <summary>¿Puede ejecutarse automáticamente?</summary>
            <p>
              Sí. El ejecutable dispone del modo no interactivo
              <code>--scheduled-sync</code> para el Programador de tareas. Un
              consentimiento caducado devuelve un código específico y nunca
              abre el navegador en este modo.
            </p>
          </details>
          <details>
            <summary>¿Puedo importar manualmente movimientos de tarjetas?</summary>
            <p>
              Sí. Selecciona uno o varios extractos XLSX solapados y asigna un
              perfil reutilizable a cada tarjeta física. Kakebo Harvester
              deduplica, categoriza e incluye las filas nuevas en la
              exportación configurada.
            </p>
          </details>
          <details>
            <summary>¿Cómo lo traslado a otro ordenador?</summary>
            <p>
              Cierra la aplicación, copia la carpeta privada completa e iníciala
              con el nuevo usuario de Windows. Kakebo Harvester detectará que la
              CA local copiada no es de confianza y ofrecerá preparar HTTPS. No
              hace falta modificar código.
            </p>
          </details>
          <details>
            <summary>¿Por qué puede faltar mi banco o alguna cuenta?</summary>
            <p>
              La cobertura y los tipos de cuenta dependen del banco y su
              interfaz PSD2. Inversiones, préstamos, seguros y algunas tarjetas
              pueden no estar disponibles.
            </p>
          </details>
        </div>
      </section>
    </div>
  );
}
