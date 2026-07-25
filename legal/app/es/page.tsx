import Link from "next/link";

export const metadata = {
  title: "Información legal",
  description:
    "Información legal de Kakebo Harvester, aplicación personal de consulta financiera."
};

export default function SpanishHomePage() {
  return (
    <div lang="es">
      <section className="hero">
        <p className="eyebrow">Información legal</p>
        <h1>Finanzas personales con claridad y control local.</h1>
        <p className="hero-copy">
          Kakebo Harvester es una aplicación de uso personal que consulta
          información de cuentas mediante Open Banking y la prepara para su
          análisis privado. No permite pagos ni transferencias.
        </p>
      </section>
      <section className="cards" aria-label="Documentos legales">
        <article className="card">
          <span className="card-number">01</span>
          <h2>Privacidad</h2>
          <p>
            Qué información se consulta, para qué se utiliza, dónde se conserva
            y cómo puedes ejercer tus derechos.
          </p>
          <Link className="card-link" href="/es/privacy">
            Leer la política de privacidad →
          </Link>
        </article>
        <article className="card">
          <span className="card-number">02</span>
          <h2>Términos</h2>
          <p>
            Condiciones de un servicio personal, no comercial y exclusivamente
            informativo.
          </p>
          <Link className="card-link" href="/es/terms">
            Leer los términos de uso →
          </Link>
        </article>
      </section>
    </div>
  );
}
