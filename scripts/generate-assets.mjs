import { mkdirSync, writeFileSync } from "node:fs"
import { deflateSync } from "node:zlib"

const NAVY = 0x000443
const WHITE = 0xffffff
const PAPER = 0xfbfaf8
const RULE = 0xbcbccb
const GRID = 0xe8e7ec

// Small monospaced lettering. Each glyph has seven 5-bit rows, left bit first.
const glyphs = Object.fromEntries(Object.entries({
  A: "0e11111f111111", C: "0e11101010110e", D: "1e11111111111e",
  E: "1f10101e10101f", G: "0e11101711110f", I: "0e04040404040e",
  K: "11121418141211", N: "11191915131311", R: "1e11111e141211",
  S: "0f10100e01011e", T: "1f040404040404",
  a: "00000e010f110f", b: "10101e1111111e", c: "00000f1010100f",
  d: "01010f1111110f", e: "00000e111f100e", f: "0609081c080808",
  g: "00000f110f010e", i: "04000c0404040e", k: "10101214181412",
  l: "0c04040404040e", n: "00001e11111111", o: "00000e1111110e",
  r: "00001619101010", s: "00000f100e011e", t: "08081c08080906",
  y: "000011110f011e", ".": "00000000000c0c", "·": "0000000c0c0000",
  " ": "00000000000000",
}).map(([character, rows]) => [character, Buffer.from(rows, "hex")]))

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  for (let bit = 0; bit < 8; bit++) byte = (byte >>> 1) ^ (byte & 1 ? 0xedb88320 : 0)
  return byte
})

function chunk(type, data = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(data.length + 12)
  bytes.writeUInt32BE(data.length, 0)
  bytes.write(type, 4, "ascii")
  data.copy(bytes, 8)
  let crc = 0xffffffff
  for (let i = 4; i < bytes.length - 4; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 255]
  }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4)
  return bytes
}

function canvas(width, height, background) {
  // RGB scanlines, each preceded by a zero (None) filter byte.
  const stride = 1 + width * 3
  const pixels = Buffer.alloc(stride * height)

  function rect(x, y, w, h, color) {
    const left = Math.max(x, 0)
    const right = Math.min(x + w, width)
    if (right <= left) return
    const rgb = Buffer.from([color >>> 16, (color >>> 8) & 255, color & 255])
    for (let row = Math.max(y, 0); row < Math.min(y + h, height); row++) {
      const start = row * stride + 1
      pixels.fill(rgb, start + left * 3, start + right * 3)
    }
  }

  function text(value, x, y, scale, color) {
    for (const character of value) {
      const glyph = glyphs[character]
      if (!glyph) throw new Error(`Missing bitmap glyph: ${character}`)
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row] & (16 >> col)) rect(x + col * scale, y + row * scale, scale, scale, color)
        }
      }
      x += 6 * scale
    }
  }

  function polygon(points, x, y, scale, color) {
    const top = Math.min(...points.map(([, py]) => py)) * scale
    const bottom = Math.max(...points.map(([, py]) => py)) * scale
    for (let row = top; row < bottom; row++) {
      const py = (row + 0.5) / scale
      const crossings = []
      for (let i = 0; i < points.length; i++) {
        const [ax, ay] = points[i]
        const [bx, by] = points[(i + 1) % points.length]
        if ((ay > py) !== (by > py)) {
          crossings.push((ax + (py - ay) * (bx - ax) / (by - ay)) * scale)
        }
      }
      crossings.sort((a, b) => a - b)
      for (let i = 0; i < crossings.length; i += 2) {
        const left = Math.ceil(crossings[i] - 0.5)
        const right = Math.ceil(crossings[i + 1] - 0.5)
        rect(x + left, y + row, right - left, 1, color)
      }
    }
  }

  function png() {
    const header = Buffer.alloc(13)
    header.writeUInt32BE(width, 0)
    header.writeUInt32BE(height, 4)
    header[8] = 8 // Bits per channel
    header[9] = 2 // Truecolor RGB
    return Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(pixels, { level: 9 })),
      chunk("IEND"),
    ])
  }

  rect(0, 0, width, height, background)
  return { rect, text, polygon, png }
}

// Shared artwork on a 16×16 grid: a square C and a single register tick.
const monogram = [[3, 3, 9, 2], [3, 5, 2, 6], [3, 11, 9, 2], [11, 7, 2, 2]]

function tile({ rect }, x, y, size) {
  const px = (unit) => Math.round(unit * size / 16)
  rect(x, y, size, size, NAVY)
  for (const [left, top, w, h] of monogram) {
    rect(x + px(left), y + px(top), px(left + w) - px(left), px(top + h) - px(top), WHITE)
  }
}

function icon(size) {
  const image = canvas(size, size, NAVY)
  tile(image, 0, 0, size)
  return image.png()
}

function ico(entries) {
  const directory = Buffer.alloc(6 + 16 * entries.length)
  directory.writeUInt16LE(1, 2) // ICO, not CUR
  directory.writeUInt16LE(entries.length, 4)
  let offset = directory.length
  for (const [index, { size, png }] of entries.entries()) {
    const start = 6 + 16 * index
    directory[start] = directory[start + 1] = size
    directory.writeUInt16LE(1, start + 4) // Color planes
    directory.writeUInt16LE(24, start + 6) // RGB bit depth
    directory.writeUInt32LE(png.length, start + 8)
    directory.writeUInt32LE(offset, start + 12)
    offset += png.length
  }
  return Buffer.concat([directory, ...entries.map(({ png }) => png)])
}

function svgIcon() {
  const mark = monogram.map(([x, y, width, height]) =>
    `    <rect x="${x}" y="${y}" width="${width}" height="${height}"/>`).join("\n")
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">
  <style>
    @media (prefers-color-scheme: dark) { .keyline { stroke: #fff; } }
  </style>
  <rect width="16" height="16" fill="#000443"/>
  <rect class="keyline" x=".5" y=".5" width="15" height="15" fill="none" stroke="#9c9db5"/>
  <g fill="#fff">
${mark}
  </g>
</svg>
`
}

// Display lettering on a 62×86 grid. Extra polygons cut out the B and R counters.
const title = {
  C: [[[14, 0], [62, 0], [62, 17], [22, 17], [17, 22], [17, 64], [22, 69], [62, 69], [62, 86], [14, 86], [0, 72], [0, 14]]],
  Y: [[[0, 0], [19, 0], [31, 30], [43, 0], [62, 0], [40, 51], [40, 86], [22, 86], [22, 51]]],
  B: [[[0, 0], [50, 0], [62, 12], [62, 34], [54, 42], [62, 50], [62, 74], [50, 86], [0, 86]],
    [[17, 16], [40, 16], [45, 21], [45, 30], [40, 35], [17, 35]],
    [[17, 51], [40, 51], [45, 56], [45, 65], [40, 70], [17, 70]]],
  E: [[[0, 0], [62, 0], [62, 17], [17, 17], [17, 34], [53, 34], [53, 51], [17, 51], [17, 69], [62, 69], [62, 86], [0, 86]]],
  R: [[[0, 0], [50, 0], [62, 12], [62, 41], [51, 52], [62, 86], [44, 86], [33, 54], [17, 54], [17, 86], [0, 86]],
    [[17, 17], [40, 17], [45, 22], [45, 32], [40, 37], [17, 37]]],
}

function ogCard() {
  const image = canvas(1200, 630, PAPER)
  const { rect, text, polygon } = image
  rect(0, 0, 1200, 12, NAVY)

  for (const x of [54, 1145]) rect(x, 54, 1, 523, RULE)
  for (const y of [54, 130, 458, 544, 576]) rect(54, y, 1092, 1, RULE)
  rect(804, 131, 1, 327, RULE)
  for (let x = 819; x < 1145; x += 26) rect(x, 131, 1, 327, GRID)
  for (let y = 138; y < 458; y += 26) rect(805, y, 340, 1, GRID)
  for (let x = 78; x <= 1122; x += 58) rect(x, 545, 1, 31, GRID)

  tile(image, 78, 68, 48)
  text("ASK GINA", 147, 81, 3, NAVY)
  const label = "INCIDENT REGISTER"
  text(label, 1122 - label.length * 12 + 2, 85, 2, NAVY)

  Array.from("CYBER").forEach((letter, index) => {
    const [outline, ...counters] = title[letter]
    const x = 78 + index * 142
    polygon(outline, x, 208, 2, NAVY)
    for (const counter of counters) polygon(counter, x, 208, 2, PAPER)
  })
  tile(image, 847, 166, 256)

  text("A daily record of cyber incidents · cyber.askgina.ai", 78, 491, 3, NAVY)
  return image.png()
}

const png32 = icon(32)
const site = new URL("../site/", import.meta.url)
mkdirSync(site, { recursive: true })
for (const [name, asset] of [
  ["og-default.png", ogCard()],
  ["apple-touch-icon.png", icon(180)],
  ["favicon-32.png", png32],
  ["favicon.ico", ico([{ size: 16, png: icon(16) }, { size: 32, png: png32 }, { size: 48, png: icon(48) }])],
  ["favicon.svg", svgIcon()],
]) {
  writeFileSync(new URL(name, site), asset)
}
