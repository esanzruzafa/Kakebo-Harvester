import Link from "next/link";

export default function HomePage() {
  return (
    <div lang="en">
      <section className="hero">
        <p className="eyebrow">Legal information</p>
        <h1>Personal finances with clarity and local control.</h1>
        <p className="hero-copy">
          Kakebo Harvester is a personal application that retrieves account
          information through Open Banking and prepares it for private analysis.
          It cannot initiate payments or transfers.
        </p>
      </section>
      <section className="cards" aria-label="Legal documents">
        <article className="card">
          <span className="card-number">01</span>
          <h2>Privacy</h2>
          <p>
            What information is accessed, why it is used, where it is stored and
            how you can exercise your rights.
          </p>
          <Link className="card-link" href="/privacy">
            Read the privacy policy →
          </Link>
        </article>
        <article className="card">
          <span className="card-number">02</span>
          <h2>Terms</h2>
          <p>
            Conditions for a personal, non-commercial and informational
            service.
          </p>
          <Link className="card-link" href="/terms">
            Read the terms of use →
          </Link>
        </article>
      </section>
    </div>
  );
}
