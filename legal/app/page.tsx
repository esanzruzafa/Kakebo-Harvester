import Link from "next/link";

export default function HomePage() {
  return (
    <div lang="en">
      <section className="hero">
        <p className="eyebrow">Kakebo Harvester</p>
        <h1>Personal finances with clarity and local control.</h1>
        <p className="hero-copy">
          Kakebo Harvester is a personal application that retrieves account
          information through Open Banking and prepares it for private analysis.
          Explore the application, download releases, or review its legal
          information. It cannot initiate payments or transfers.
        </p>
      </section>
      <section className="cards cards-three" aria-label="Project information">
        <article className="card">
          <span className="card-number">01</span>
          <h2>Application</h2>
          <p>
            Features, download, setup guide, daily use and frequently asked
            questions.
          </p>
          <Link className="card-link" href="/app">
            Explore Kakebo Harvester →
          </Link>
        </article>
        <article className="card">
          <span className="card-number">02</span>
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
          <span className="card-number">03</span>
          <h2>Terms</h2>
          <p>
            Conditions for lawful, secure and informational use.
          </p>
          <Link className="card-link" href="/terms">
            Read the terms of use →
          </Link>
        </article>
      </section>
    </div>
  );
}
