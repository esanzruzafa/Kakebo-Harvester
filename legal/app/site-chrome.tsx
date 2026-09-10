"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

function localizedPaths(pathname: string): {
  english: string;
  spanish: string;
} {
  const isSpanish = pathname === "/es" || pathname.startsWith("/es/");
  const english = isSpanish ? pathname.slice(3) || "/" : pathname;
  const spanish = isSpanish ? pathname : `/es${pathname === "/" ? "" : pathname}`;

  return { english, spanish };
}

export default function SiteChrome({
  children
}: Readonly<{ children: ReactNode }>) {
  const pathname = usePathname();
  const isSpanish = pathname === "/es" || pathname.startsWith("/es/");
  const prefix = isSpanish ? "/es" : "";
  const paths = localizedPaths(pathname);

  return (
    <>
      <header className="site-header">
        <nav
          className="nav"
          aria-label={isSpanish ? "Navegación principal" : "Main navigation"}
        >
          <Link className="brand" href={prefix || "/"}>
            Kakebo Harvester
          </Link>
          <div className="nav-links">
            <Link href={`${prefix}/app`}>
              {isSpanish ? "Aplicación" : "Application"}
            </Link>
            <Link href={`${prefix}/privacy`}>
              {isSpanish ? "Privacidad" : "Privacy"}
            </Link>
            <Link href={`${prefix}/terms`}>
              {isSpanish ? "Términos" : "Terms"}
            </Link>
            <span className="language-switch" aria-label="Language">
              <Link
                href={paths.english}
                hrefLang="en"
                aria-current={isSpanish ? undefined : "page"}
              >
                EN
              </Link>
              <span aria-hidden="true">/</span>
              <Link
                href={paths.spanish}
                hrefLang="es"
                aria-current={isSpanish ? "page" : undefined}
              >
                ES
              </Link>
            </span>
          </div>
        </nav>
      </header>
      <main>{children}</main>
      <footer className="site-footer">
        <div className="footer-inner">
          <span>© 2026 Eduardo Sanz</span>
          <span>
            {isSpanish
              ? "Aplicación personal · Solo lectura · España"
              : "Personal application · Read-only · Spain"}
          </span>
        </div>
      </footer>
    </>
  );
}
