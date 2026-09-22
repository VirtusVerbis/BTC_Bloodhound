import { purposeText } from "./aboutContent";

export const SITE_ORIGIN = "https://bitcoinbloodhound.com";
export const SITE_NAME = "Bitcoin Bloodhound";
export const DEFAULT_TITLE = "Bitcoin Bloodhound — Coldcard Hack Tracker";
export const SITE_DESCRIPTION = purposeText;
export const HOME_INTRO =
  "Bitcoin Bloodhound is a Coldcard hack tracker and on-chain visualization tool for the 2026 Coldcard entropy exploit — mapping consolidation addresses, victim inputs, and downstream Bitcoin flows.";
export const OG_IMAGE_PATH = "/bloodhound_logo_1024x1024.png";

export type AppRoute = "/" | "/about" | "/queue";

export interface PageSeo {
  path: AppRoute;
  title: string;
  description: string;
}

export const PAGE_SEO: Record<AppRoute, PageSeo> = {
  "/": {
    path: "/",
    title: DEFAULT_TITLE,
    description: SITE_DESCRIPTION,
  },
  "/about": {
    path: "/about",
    title: "About — Bitcoin Bloodhound",
    description:
      "Learn about Bitcoin Bloodhound, the Coldcard hack on-chain tracker, data sources, monitoring, and project disclaimers.",
  },
  "/queue": {
    path: "/queue",
    title: "Indexer Queue — Bitcoin Bloodhound",
    description: "View background indexer jobs for the Bitcoin Bloodhound Coldcard hack tracker.",
  },
};

export function canonicalUrl(path: AppRoute): string {
  return path === "/" ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${path}`;
}

export function ogImageUrl(): string {
  return `${SITE_ORIGIN}${OG_IMAGE_PATH}`;
}

export function jsonLdWebApplication() {
  return {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: SITE_ORIGIN,
    applicationCategory: "FinanceApplication",
    operatingSystem: "Web",
  };
}

export function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

/** Map a URL pathname to an app route, or null when the path is not recognized. */
export function pathnameToRoute(pathname: string): AppRoute | null {
  const path = normalizePathname(pathname);
  if (path === "/about") return "/about";
  if (path === "/queue") return "/queue";
  if (path === "/") return "/";
  return null;
}
