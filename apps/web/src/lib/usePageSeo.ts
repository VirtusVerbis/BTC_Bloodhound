import { useEffect } from "react";
import {
  canonicalUrl,
  PAGE_SEO,
  SITE_NAME,
  type AppRoute,
} from "../content/siteSeo";

function upsertMeta(attr: "name" | "property", key: string, content: string) {
  let el = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function upsertCanonical(href: string) {
  let el = document.head.querySelector('link[rel="canonical"]');
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", "canonical");
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

export function usePageSeo(route: AppRoute) {
  useEffect(() => {
    const seo = PAGE_SEO[route];
    document.title = seo.title;
    upsertMeta("name", "description", seo.description);
    upsertMeta("property", "og:title", seo.title);
    upsertMeta("property", "og:description", seo.description);
    upsertMeta("property", "og:url", canonicalUrl(route));
    upsertMeta("property", "og:site_name", SITE_NAME);
    upsertMeta("name", "twitter:title", seo.title);
    upsertMeta("name", "twitter:description", seo.description);
    upsertCanonical(canonicalUrl(route));
  }, [route]);
}
