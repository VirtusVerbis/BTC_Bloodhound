import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { createRequire } from "node:module";

const SITE_ORIGIN = "https://bitcoinbloodhound.com";
const ABOUT_TITLE = "About — Bitcoin Bloodhound";
const ABOUT_DESCRIPTION =
  "Learn about Bitcoin Bloodhound, the Coldcard hack on-chain tracker, data sources, monitoring, and project disclaimers.";
const ABOUT_CANONICAL = `${SITE_ORIGIN}/about`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const distDir = join(rootDir, "dist");
const tempFile = join(__dirname, ".prerender-about.cjs");

function replaceMeta(html, attr, key, content) {
  const pattern = new RegExp(`<meta ${attr}="${key}" content="[^"]*"\\s*/>`);
  const replacement = `<meta ${attr}="${key}" content="${content.replace(/"/g, "&quot;")}" />`;
  if (pattern.test(html)) {
    return html.replace(pattern, replacement);
  }
  return html.replace("</head>", `    ${replacement}\n  </head>`);
}

function replaceTitle(html, title) {
  return html.replace(/<title>.*?<\/title>/, `<title>${title}</title>`);
}

function replaceCanonical(html, href) {
  return html.replace(
    /<link rel="canonical" href="[^"]*"\s*\/>/,
    `<link rel="canonical" href="${href}" />`,
  );
}

function replaceJsonLd(html, payload) {
  return html.replace(
    /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
    `<script type="application/ld+json">\n      ${JSON.stringify(payload, null, 2).replace(/\n/g, "\n      ")}\n    </script>`,
  );
}

function replaceRoot(html, innerHtml) {
  return html.replace(/<div id="root">[\s\S]*?<\/div>/, `<div id="root">${innerHtml}</div>`);
}

buildSync({
  absWorkingDir: rootDir,
  entryPoints: [join(__dirname, "prerender-ssr-entry.tsx")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: tempFile,
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: {
    "import.meta.env.VITE_EXPLORER_BASE": JSON.stringify("https://mempool.space"),
  },
});

const require = createRequire(import.meta.url);
const { renderAboutHtml } = require(tempFile);
const aboutInnerHtml = renderAboutHtml();

let html = readFileSync(join(distDir, "index.html"), "utf8");
html = replaceTitle(html, ABOUT_TITLE);
html = replaceMeta(html, "name", "description", ABOUT_DESCRIPTION);
html = replaceMeta(html, "property", "og:title", ABOUT_TITLE);
html = replaceMeta(html, "property", "og:description", ABOUT_DESCRIPTION);
html = replaceMeta(html, "property", "og:url", ABOUT_CANONICAL);
html = replaceMeta(html, "name", "twitter:title", ABOUT_TITLE);
html = replaceMeta(html, "name", "twitter:description", ABOUT_DESCRIPTION);
html = replaceCanonical(html, ABOUT_CANONICAL);
html = replaceJsonLd(html, {
  "@context": "https://schema.org",
  "@type": "WebPage",
  name: ABOUT_TITLE,
  description: ABOUT_DESCRIPTION,
  url: ABOUT_CANONICAL,
  isPartOf: {
    "@type": "WebSite",
    name: "Bitcoin Bloodhound",
    url: SITE_ORIGIN,
  },
});
html = replaceRoot(html, aboutInnerHtml);

mkdirSync(join(distDir, "about"), { recursive: true });
writeFileSync(join(distDir, "about", "index.html"), html);

try {
  unlinkSync(tempFile);
} catch {
  /* ignore */
}

console.log("Prerendered dist/about/index.html");
