// One-off generator for PrintTrays's app icons, run manually (not part of
// the build). Same rounded-square mark as the website's Nav brand square
// (website/app/globals.css .brand .mark: 8px-radius-at-28px rounded square),
// scaled up, with a bold white "P" monogram — green per the client's request,
// not the site's current blue. (If the site should match, website/app/
// globals.css's --accent / .brand .mark gradient needs updating too — not
// done here, since only the app icon was asked for.)
//
// Produces icon.ico (multi-size, PNG-compressed frames — supported since
// Vista) and icon.png (512x512, for Linux) in ../assets, next to this
// script. Re-run with `node generate-icons.js` after changing the design;
// the .ico/.png are committed output, not generated at build time.
const fs = require("fs");
const path = require("path");
const { createCanvas } = require("@napi-rs/canvas");

const RADIUS_RATIO = 8 / 28; // matches the website's 8px radius on a 28px mark

function drawMark(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  const r = size * RADIUS_RATIO;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, r);
  const grad = ctx.createLinearGradient(0, 0, size, size); // 135deg: top-left to bottom-right
  grad.addColorStop(0, "#34d399");
  grad.addColorStop(1, "#059669");
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.round(size * 0.62)}px Arial, sans-serif`;
  // Small manual nudge: cap-height optical centring sits a touch above the
  // true geometric centre for a single uppercase letter.
  ctx.fillText("P", size / 2, size * 0.56);

  return canvas.toBuffer("image/png");
}

function buildIco(pngsBySize) {
  const sizes = Object.keys(pngsBySize).map(Number).sort((a, b) => a - b);
  const count = sizes.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  const images = [];
  let offset = 6 + 16 * count;
  sizes.forEach((size, i) => {
    const png = pngsBySize[size];
    const entry = dir.subarray(i * 16, i * 16 + 16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height (0 = 256)
    entry.writeUInt8(0, 2); // color count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8); // size of image data
    entry.writeUInt32LE(offset, 12); // offset of image data
    offset += png.length;
    images.push(png);
  });

  return Buffer.concat([header, dir, ...images]);
}

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const pngsBySize = {};
for (const s of icoSizes) pngsBySize[s] = drawMark(s);

const outDir = path.join(__dirname, "..", "assets");
fs.writeFileSync(path.join(outDir, "icon.ico"), buildIco(pngsBySize));
fs.writeFileSync(path.join(outDir, "icon.png"), drawMark(512));

console.log("Wrote icon.ico (" + icoSizes.join(",") + "px frames) and icon.png (512px) to", outDir);
