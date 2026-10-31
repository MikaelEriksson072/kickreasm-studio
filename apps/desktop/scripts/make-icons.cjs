/* Draws the Mimir Studio logo into the app icons with Electron's own Chromium: build/icon.png (512 x 512) and
 * build/icon.ico (16-256 px, PNG frames), which electron-builder takes. From 48 px up the icon is the picture
 * build/logo.jpg, a square of it set into the tile; below that the rune would blur, so those sizes are build/icon.svg,
 * the same logo drawn as a vector (as the title bar draws it, src/components/Logo.tsx).
 * Run from apps/desktop: npx electron scripts/make-icons.cjs */
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const build = join(__dirname, '..', 'build');
const vector = readFileSync(join(build, 'icon.svg'), 'utf8');
const SIZES = [256, 128, 64, 48, 32, 24, 16];
/** the smallest size drawn from the picture */
const PICTURE_FROM = 48;
/** build/logo.jpg (515 x 539 px), and the square of it around the rune and the inner rings that the icon shows */
const LOGO = { width: 515, height: 539 }, CROP = { x: 76, y: 92, side: 360 };

/** the picture in the tile of icon.svg (inset 0.75, corners 5, the same faint rim) */
function picture() {
  const jpg = `data:image/jpeg;base64,${readFileSync(join(build, 'logo.jpg')).toString('base64')}`;
  const k = 22.5 / CROP.side, tile = 'x="0.75" y="0.75" width="22.5" height="22.5" rx="5"';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><clipPath id="t"><rect ${tile}/></clipPath></defs>`
    + `<rect ${tile} fill="#000"/>`
    + `<image clip-path="url(#t)" href="${jpg}" x="${0.75 - CROP.x * k}" y="${0.75 - CROP.y * k}" width="${LOGO.width * k}" height="${LOGO.height * k}" preserveAspectRatio="none"/>`
    + `<rect ${tile} fill="none" stroke="#5fd8ff" stroke-opacity="0.2" stroke-width="0.25"/></svg>`;
}

/** An .ico of PNG frames (Windows Vista and later read them at every size). */
function ico(frames) {
  const head = Buffer.alloc(6 + 16 * frames.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(frames.length, 4);
  let at = head.length;
  frames.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3); head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(at, e + 12);
    at += png.length;
  });
  return Buffer.concat([head, ...frames.map(f => f.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 600, height: 600, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  const big = picture();
  /** the logo drawn at `size` pixels, as PNG */
  const draw = async size => {
    const svg = size >= PICTURE_FROM ? big : vector;
    win.setContentSize(size, size);
    const page = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden"><div style="width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div></body></html>`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
    await new Promise(r => setTimeout(r, 150));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    const s = img.getSize();
    return (s.width === size ? img : img.resize({ width: size, height: size, quality: 'best' })).toPNG();
  };
  writeFileSync(join(build, 'icon.png'), await draw(512));
  const frames = [];
  for (const size of SIZES) frames.push({ size, png: await draw(size) });
  writeFileSync(join(build, 'icon.ico'), ico(frames));
  if (process.env.PREVIEW) {
    // a sheet of every size, for a look at the logo
    const sheet = `<!doctype html><html><body style="margin:0;background:#121218;display:flex;gap:16px;align-items:flex-end;padding:16px">${SIZES.map(s => `<img width="${s}" height="${s}" src="data:image/png;base64,${frames.find(f => f.size === s).png.toString('base64')}">`).join('')}<div style="background:#f4f4f8;padding:12px;border-radius:10px;display:flex;gap:12px;align-items:flex-end">${[64, 32, 16].map(s => `<img width="${s}" height="${s}" src="data:image/png;base64,${frames.find(f => f.size === s).png.toString('base64')}">`).join('')}</div></body></html>`;
    win.setContentSize(820, 300);
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(sheet)}`);
    await new Promise(r => setTimeout(r, 200));
    writeFileSync(process.env.PREVIEW, (await win.webContents.capturePage()).toPNG());
  }
  app.quit();
});
