// Builds the favicon and PWA icons from the owner's app icon (public/brand/app-icon-1024.png: white rounded tile with the
// circuit chilli; style guide v1.0 "App icon · Light"). Re-run after the designer delivers a new icon.
// Run: node scripts/make-icons.mjs  (needs devDependency sharp). Writes public/icon-*.png, apple-touch-icon.png,
// icon.svg, brand/chilli-mark.svg (both embed the 192px PNG, there is no vector logo yet) and src/app/favicon.ico.
import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";

const SRC = readFileSync("public/brand/app-icon-1024.png");
const icon = (size) => sharp(SRC).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
// Full-bleed white square with the icon at `scale` of the canvas (maskable safe zone = inner 80%).
const onWhite = async (size, scale) => sharp({ create: { width: size, height: size, channels: 3, background: "#ffffff" } })
  .composite([{ input: await icon(Math.round(size * scale)), gravity: "centre" }]).png().toBuffer();

const write = (file, buf) => writeFileSync(file, buf);
write("public/icon-192.png", await icon(192));
write("public/icon-512.png", await icon(512));
write("public/icon-maskable-512.png", await onWhite(512, 0.86));
write("public/apple-touch-icon.png", await onWhite(180, 1));   // opaque; iOS rounds the corners itself
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><image width="192" height="192" href="data:image/png;base64,${(await icon(192)).toString("base64")}"/></svg>\n`;
write("public/icon.svg", svg);
write("public/brand/chilli-mark.svg", svg);
// favicon.ico: 48 + 32 + 16 px PNGs in an ICO container (PNG-in-ICO is supported by all current browsers).
const sizes = [48, 32, 16];
const pngs = await Promise.all(sizes.map(icon));
const head = Buffer.alloc(6 + 16 * sizes.length); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let off = head.length;
sizes.forEach((s, i) => { const o = 6 + 16 * i; head.writeUInt8(s, o); head.writeUInt8(s, o + 1); head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6); head.writeUInt32LE(pngs[i].length, o + 8); head.writeUInt32LE(off, o + 12); off += pngs[i].length; });
write("src/app/favicon.ico", Buffer.concat([head, ...pngs]));
console.log("icons written", readFileSync("public/icon-512.png").length, "bytes (512)");
