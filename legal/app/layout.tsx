import type { Metadata } from "next";
import "./globals.css";
import SiteChrome from "./site-chrome";

export const metadata: Metadata = {
  title: {
    default: "Kakebo Harvester",
    template: "%s · Kakebo Harvester"
  },
  description:
    "Kakebo Harvester application information, downloads, user guide, FAQ, privacy policy and terms."
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <SiteChrome>{children}</SiteChrome>
      </body>
    </html>
  );
}
