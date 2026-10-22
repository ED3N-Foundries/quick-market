/** Pack PNG bytes into an ICO. Each image is stored as PNG, which browsers accept. */
export function pngsToIco(images: { size: number; png: Uint8Array }[]) {
  if (images.length < 1 || images.length > 65535) {
    throw new Error("ICO image count is out of range")
  }
  const header = 6
  const entry = 16
  const table = header + images.length * entry
  const bytes = images.reduce((sum, image) => sum + image.png.byteLength, table)
  const out = new Uint8Array(bytes)
  const view = new DataView(out.buffer)
  view.setUint16(0, 0, true)
  view.setUint16(2, 1, true)
  view.setUint16(4, images.length, true)
  let offset = table
  for (const [index, image] of images.entries()) {
    if (!image) throw new Error("ICO image is missing")
    const at = header + index * entry
    const dim = image.size >= 256 ? 0 : image.size
    out[at] = dim
    out[at + 1] = dim
    view.setUint16(at + 4, 1, true)
    view.setUint16(at + 6, 32, true)
    view.setUint32(at + 8, image.png.byteLength, true)
    view.setUint32(at + 12, offset, true)
    out.set(image.png, offset)
    offset += image.png.byteLength
  }
  return out
}
