import { brand } from "./config.ts"

function attr(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
}

/** Head tags for the share card, the tab icon, and the home-screen icon. */
export function brandHead() {
  const origin = brand.origin.replace(/\/$/, "")
  const image = `${origin}/og.png`
  const lines = [
    `<meta name="description" content="${attr(brand.tagline)}" />`,
    `<link rel="icon" href="/favicon.ico" sizes="any" />`,
    `<link rel="icon" type="image/png" href="/favicon-32.png" sizes="32x32" />`,
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${attr(brand.name)}" />`,
    `<meta property="og:title" content="${attr(brand.name)}" />`,
    `<meta property="og:description" content="${attr(brand.tagline)}" />`,
    `<meta property="og:url" content="${origin}/" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:width" content="${brand.og.width}" />`,
    `<meta property="og:image:height" content="${brand.og.height}" />`,
    `<meta property="og:image:alt" content="${attr(brand.tagline)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${attr(brand.name)}" />`,
    `<meta name="twitter:description" content="${attr(brand.tagline)}" />`,
    `<meta name="twitter:image" content="${image}" />`,
    `<meta name="twitter:image:alt" content="${attr(brand.tagline)}" />`,
  ]
  return lines.map((line) => `    ${line}`).join("\n")
}
