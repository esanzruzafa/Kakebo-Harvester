import Link from "next/link";

export const metadata = {
  title: "Aplicación e información",
  description:
    "Aplicación, descarga, guía, preguntas frecuentes e información legal de Kakebo Harvester."
};

export default function SpanishHomePage() {
  return (
    <div lang="es">
      <section className="hero">
        <p className="eyebrow">Kakebo Harvester</p>
        <h1>Finanzas personales con claridad y control local.</h1>
        <p className="hero-copy">
          Kakebo Harvester es una aplicación de uso personal que consulta
          información de cuentas mediante Open Banking y la prepara para su
          análisis privado. Conoce la aplicación, descarga versiones o consulta
          su información legal. No permite pagos ni transferencias.
        </p>
      </section>
      <section className="cards cards-three" aria-label="Información del proyecto">
        <article className="card">
          <span className="card-number">01</span>
          <h2>Aplicación</h2>
          <p>
            Funciones, descarga, guía de configuración, uso diario y preguntas
            frecuentes.
          </p>
          <Link className="card-link" href="/es/app">
            Conocer Kakebo Harvester →
          </Link>
        </article>
        <article className="card">
          <span className="card-number">02</span>
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
          <span className="card-number">03</span>
          <h2>Términos</h2>
          <p>
            Condiciones para un uso lícito, seguro y exclusivamente informativo.
          </p>
          <Link className="card-link" href="/es/terms">
            Leer los términos de uso →
          </Link>
        </article>
      </section>
    </div>
  );
}
