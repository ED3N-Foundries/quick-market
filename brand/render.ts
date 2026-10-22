import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { chromium, type Page } from "playwright"
import sharp from "sharp"
import { brand } from "./config"
import { pngsToIco } from "./ico"
import { inkNudge } from "./ink"

const publicDir = join(import.meta.dir, "../web/public")

const genericFamilies = new Set([
  "serif",
  "sans-serif",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "system-ui",
  "monospace",
  "cursive",
  "fantasy",
])

type Shot = {
  label: string
  width: number
  height: number
  text: string
  safeWidth: number
  minWhite: number
  /** Small icons need hinting. Large cards stay on geometric precision. */
  rendering: "geometricPrecision" | "optimizeLegibility"
  /** Defaults to the regular weight. The 16px icon uses 700. */
  weight?: number
}

function cssFamily(name: string) {
  if (/["\\<>]/.test(name)) throw new Error(`font name is not safe for css: ${name}`)
  return genericFamilies.has(name) ? name : `"${name}"`
}

function documentHtml(fontSrc: string) {
  const stack = [cssFamily(brand.font.family), ...brand.font.fallback.map(cssFamily)].join(", ")
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @font-face {
    font-family: ${cssFamily(brand.font.family)};
    font-style: ${brand.font.style};
    font-weight: ${brand.font.weight};
    src: ${fontSrc};
    font-display: block;
  }
  @font-face {
    font-family: ${cssFamily(brand.font.family)};
    font-style: ${brand.font.style};
    font-weight: 700;
    src: ${localSources(brand.font.boldLocal)};
    font-display: block;
  }
  html, body {
    margin: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: ${brand.backdrop};
    color: ${brand.text};
  }
  body {
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: ${stack};
    font-weight: ${brand.font.weight};
    font-style: ${brand.font.style};
    letter-spacing: ${brand.font.letterSpacing};
    font-synthesis: none;
    text-rendering: geometricPrecision;
    -webkit-font-smoothing: antialiased;
  }
  p {
    margin: 0;
    white-space: nowrap;
    line-height: 1.15;
  }
</style>
</head>
<body><p id="line"></p></body>
</html>`
}

async function fit(page: Page, shot: Shot) {
  const stack = [cssFamily(brand.font.family), ...brand.font.fallback.map(cssFamily)].join(", ")
  const weight = shot.weight ?? brand.font.weight
  return page.evaluate(
    async ({ family, weight, text, safeWidth, letterSpacing, stack, rendering }) => {
      const line = document.getElementById("line")
      if (!(line instanceof HTMLElement)) throw new Error("missing line")
      document.body.style.textRendering = rendering
      line.textContent = text
      line.style.letterSpacing = letterSpacing
      line.style.fontWeight = String(weight)
      await document.fonts.load(`${weight} 72px "${family}"`)
      await document.fonts.ready
      const widthOf = (familyList: string) => {
        line.style.fontFamily = familyList
        line.style.fontSize = "72px"
        return line.getBoundingClientRect().width
      }
      const branded = widthOf(`"${family}", "Courier New", monospace`)
      const courier = widthOf(`"Courier New", monospace`)
      if (Math.abs(branded - courier) < 1) {
        throw new Error(`${family} is not the font that drew the line`)
      }
      if (weight >= 700) {
        line.style.fontWeight = "400"
        const roman = widthOf(`"${family}", "Courier New", monospace`)
        line.style.fontWeight = String(weight)
        const heavy = widthOf(`"${family}", "Courier New", monospace`)
        if (Math.abs(heavy - roman) < 1) throw new Error(`${family} bold did not load`)
      }
      line.style.fontFamily = stack
      line.style.fontWeight = String(weight)
      const maxWidth = window.innerWidth * safeWidth
      const maxHeight = window.innerHeight * 0.78
      let lo = 4
      let hi = Math.max(4, Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.92))
      let best = lo
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        line.style.fontSize = `${mid}px`
        if (line.scrollWidth <= maxWidth && line.scrollHeight <= maxHeight) {
          best = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      line.style.fontSize = `${best}px`
      if (line.scrollWidth > maxWidth + 1 || line.scrollHeight > maxHeight + 1) {
        throw new Error(`"${text}" does not fit`)
      }
      return { fontSize: best, width: line.scrollWidth, height: line.scrollHeight }
    },
    {
      family: brand.font.family,
      weight,
      text: shot.text,
      safeWidth: shot.safeWidth,
      letterSpacing: brand.font.letterSpacing,
      stack,
      rendering: shot.rendering,
    },
  )
}

async function assertArt(png: Buffer, label: string, minWhite: number) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const channels = info.channels
  if (data[0] !== 18 || data[1] !== 53 || data[2] !== 36) {
    throw new Error(`${label} corner is ${data[0]},${data[1]},${data[2]}, expected 18,53,36`)
  }
  for (let i = 0; i < data.length; i += channels) {
    const pixel = data[i]
    const green = data[i + 1]
    const blue = data[i + 2]
    if (pixel !== undefined && green !== undefined && blue !== undefined && pixel >= minWhite && green >= minWhite && blue >= minWhite) {
      return
    }
  }
  throw new Error(`${label} has no white text`)
}

function channel(hex: string, offset: number) {
  return Number.parseInt(hex.slice(offset, offset + 2), 16)
}

/** Gray antialiasing at 16px is snapped so the two letters stay solid. */
async function snapIcon(png: Buffer, cut: number) {
  const sized = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const backdrop = [channel(brand.backdrop, 1), channel(brand.backdrop, 3), channel(brand.backdrop, 5)]
  const ink = [channel(brand.text, 1), channel(brand.text, 3), channel(brand.text, 5)]
  const out = new Uint8Array(sized.data)
  const channels = sized.info.channels
  for (let i = 0; i < out.length; i += channels) {
    const on = (out[i] ?? 0) >= cut && (out[i + 1] ?? 0) >= cut && (out[i + 2] ?? 0) >= cut
    const color = on ? ink : backdrop
    out[i] = color[0] ?? 0
    out[i + 1] = color[1] ?? 0
    out[i + 2] = color[2] ?? 0
    if (channels > 3) out[i + 3] = 255
  }
  return sharp(out, { raw: { width: sized.info.width, height: sized.info.height, channels } }).png().toBuffer()
}

/** Slide the letters so the side margins match and the weight sits on the midline. */
async function centerInk(png: Buffer, label: string) {
  const sized = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = sized.info
  const backdrop = [channel(brand.backdrop, 1), channel(brand.backdrop, 3), channel(brand.backdrop, 5)]
  let minX = width
  let maxX = -1
  let count = 0
  let massY = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels
      const red = sized.data[i] ?? 0
      const green = sized.data[i + 1] ?? 0
      const blue = sized.data[i + 2] ?? 0
      const lift = (red - 18) ** 2 + (green - 53) ** 2 + (blue - 36) ** 2
      if (lift <= 800) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      count += 1
      massY += y
    }
  }
  if (maxX < 0 || count === 0) throw new Error(`${label} has no ink to center`)
  const { dx, dy } = inkNudge(width, height, minX, maxX, massY / count)
  if (dx === 0 && dy === 0) return png
  const out = new Uint8Array(width * height * channels)
  for (let i = 0; i < out.length; i += channels) {
    out[i] = backdrop[0] ?? 0
    out[i + 1] = backdrop[1] ?? 0
    out[i + 2] = backdrop[2] ?? 0
    if (channels > 3) out[i + 3] = 255
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const fromX = x - dx
      const fromY = y - dy
      if (fromX < 0 || fromY < 0 || fromX >= width || fromY >= height) continue
      const to = (y * width + x) * channels
      const from = (fromY * width + fromX) * channels
      out.set(sized.data.subarray(from, from + channels), to)
    }
  }
  console.log(`${label}  nudged ${dx}px, ${dy}px`)
  return sharp(out, { raw: { width, height, channels } }).png().toBuffer()
}

async function shoot(page: Page, shot: Shot) {
  await page.setViewportSize({ width: shot.width, height: shot.height })
  const fitted = await fit(page, shot)
  const png = await page.screenshot({ type: "png" })
  const meta = await sharp(png).metadata()
  if (meta.width !== shot.width || meta.height !== shot.height) {
    throw new Error(`${shot.label} screenshot is ${meta.width}x${meta.height}`)
  }
  await assertArt(png, shot.label, shot.minWhite)
  console.log(`${shot.label}  ${shot.width}x${shot.height}  type ${fitted.fontSize}px`)
  return png
}

function onlyAsset() {
  const only = process.argv[2]
  if (only === undefined) return null
  if (only !== "favicon" && only !== "avatar" && only !== "og" && only !== "banner") {
    throw new Error(`unknown brand asset ${only}`)
  }
  return only
}

async function renderAll(fontSrc: string) {
  const only = onlyAsset()
  const browser = await chromium.launch({ args: ["--force-color-profile=srgb"] })
  try {
    const page = await browser.newPage({
      viewport: { width: 180, height: 180 },
      deviceScaleFactor: 1,
    })
    await page.setContent(documentHtml(fontSrc), { waitUntil: "domcontentloaded" })
    await mkdir(publicDir, { recursive: true })
    if (only === null || only === "favicon") {
      const icon180 = await centerInk(
        await shoot(page, {
          label: "apple-touch-icon",
          width: 180,
          height: 180,
          text: brand.favicon.text,
          safeWidth: brand.favicon.safeWidth,
          minWhite: 200,
          rendering: "optimizeLegibility",
        }),
        "apple-touch-icon",
      )
      const icon32 = await centerInk(
        await shoot(page, {
          label: "favicon-32",
          width: 32,
          height: 32,
          text: brand.favicon.text,
          safeWidth: 0.84,
          minWhite: 200,
          rendering: "optimizeLegibility",
        }),
        "favicon-32",
      )
      // Regular stems disappear at 16px. This one cut uses the bold of the same family.
      const icon16 = await centerInk(
        await snapIcon(
          await shoot(page, {
            label: "favicon-16",
            width: 16,
            height: 16,
            text: brand.favicon.text,
            safeWidth: 0.88,
            minWhite: 160,
            rendering: "optimizeLegibility",
            weight: 700,
          }),
          120,
        ),
        "favicon-16",
      )
      await assertArt(icon16, "favicon-16", 200)
      await assertArt(icon32, "favicon-32", 200)
      await assertArt(icon180, "apple-touch-icon", 200)
      const ico = pngsToIco([
        { size: 16, png: icon16 },
        { size: 32, png: icon32 },
      ])
      await writeFile(join(publicDir, "favicon.ico"), ico)
      await writeFile(join(publicDir, "favicon-32.png"), icon32)
      await writeFile(join(publicDir, "apple-touch-icon.png"), icon180)
    }
    if (only === null || only === "avatar") {
      const avatar = await shoot(page, {
        label: "avatar",
        width: brand.avatar.size,
        height: brand.avatar.size,
        text: brand.avatar.text,
        safeWidth: brand.avatar.safeWidth,
        minWhite: 200,
        rendering: "geometricPrecision",
      })
      await writeFile(join(publicDir, "avatar.png"), avatar)
    }
    if (only === null || only === "og") {
      const og = await shoot(page, {
        label: "og",
        width: brand.og.width,
        height: brand.og.height,
        text: brand.tagline,
        safeWidth: brand.og.safeWidth,
        minWhite: 200,
        rendering: "geometricPrecision",
      })
      await writeFile(join(publicDir, "og.png"), og)
    }
    if (only === null || only === "banner") {
      const banner = await shoot(page, {
        label: "banner",
        width: brand.banner.width,
        height: brand.banner.height,
        text: brand.tagline,
        safeWidth: brand.banner.safeWidth,
        minWhite: 200,
        rendering: "geometricPrecision",
      })
      await writeFile(join(publicDir, "banner.png"), banner)
    }
    console.log(`wrote ${publicDir}`)
  } finally {
    await browser.close()
  }
}

function localSources(names: readonly string[]) {
  return names.map((name) => `local(${cssFamily(name)})`).join(", ")
}

function localSrc() {
  return localSources(brand.font.local)
}

const local = localSrc()
try {
  await renderAll(local)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes("is not the font")) throw error
  const bytes = await readFile(brand.font.file)
  const embedded = `url("data:font/collection;base64,${bytes.toString("base64")}") format("collection"), ${local}`
  console.log(`system font lookup missed ${brand.font.family}; reading ${brand.font.file}`)
  await renderAll(embedded)
}
