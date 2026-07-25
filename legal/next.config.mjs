import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const isGitHubPages = process.env.GITHUB_ACTIONS === "true";

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  output: isGitHubPages ? "export" : undefined,
  basePath: isGitHubPages ? "/Kakebo-Harvester" : undefined,
  trailingSlash: isGitHubPages,
  turbopack: {
    root: projectRoot
  }
};

export default nextConfig;
