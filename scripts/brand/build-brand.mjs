#!/usr/bin/env node
/**
 * ZHarness brand asset builder.
 *
 * Single source of truth for the logo (the "event-line Z" mark: ink tile,
 * phosphor-green cursor, harness corner brackets) and the pixel wordmark.
 * Regenerates:
 *   - docs/assets/            (README lockups, light + dark)
 *   - apps/desktop/icons/     (full Tauri icon set: png / ico / icns / ios / android / windows)
 *   - apps/desktop/app-icon.png
 *   - apps/web/public/ui/logo/ + ui/misc/ avatars
 *
 * Strategy: headless Edge renders four high-res masters (cool/warm tile +
 * foreground on black/white for exact alpha via difference matting); every
 * other size/variant is derived in pure Node (area-average resize + masks),
 * so the whole set rebuilds in seconds without image libraries.
 *
 * Usage: node scripts/brand/build-brand.mjs
 * Requires: Node >= 18, Microsoft Edge (headless, used only for the masters).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ASSETS = path.join(ROOT, "assets"); // tracked — README lockups live here (docs/ is gitignored)
const ICONS = path.join(ROOT, "apps/desktop/icons");
const WEB_LOGO = path.join(ROOT, "apps/web/public/ui/logo");
const WEB_MISC = path.join(ROOT, "apps/web/public/ui/misc");

// ---------------------------------------------------------------------------
// Brand palette + geometry (1024 design grid)
// ---------------------------------------------------------------------------

const BG_TOP = [0x15, 0x1f, 0x2b]; // cool tile (light surfaces)
const BG_TOP_WARM = [0x1b, 0x2c, 0x33]; // lifted tile (dark surfaces)
const BG_BOTTOM = [0x0a, 0x0e, 0x14];
const hex = (a) => "#" + a.map((v) => v.toString(16).padStart(2, "0")).join("");
const GREEN_HI = "#5BF7AC";
const GREEN_LO = "#12CE8C";
const INK_TEXT = "#121821"; // wordmark on light backgrounds
const PAPER_TEXT = "#F3F7FA"; // wordmark on dark backgrounds
const MUTE_LIGHT = "#3C9E7D"; // tagline on light backgrounds
const MUTE_DARK = "#67E0B4"; // tagline on dark backgrounds

// The Z: two log-line bars joined by the event diagonal. The cursor block
// trails the bottom bar — the harness is always mid-execution.
const Z_PATH = "M272 264 H752 V380 L444 648 H752 V764 H272 V648 L580 380 H272 Z";
const CURSOR = { x: 800, y: 648, w: 104, h: 116, rx: 10 };
const TILE_RX = 232; // design-unit corner radius of the app tile

function markDefs({ bgTop = BG_TOP } = {}) {
	return `<defs>
		<linearGradient id="zh-bg" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="${hex(bgTop)}"/>
			<stop offset="1" stop-color="${hex(BG_BOTTOM)}"/>
		</linearGradient>
		<linearGradient id="zh-green" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="${GREEN_HI}"/>
			<stop offset="1" stop-color="${GREEN_LO}"/>
		</linearGradient>
		<radialGradient id="zh-glow" cx="0.5" cy="0.44" r="0.62">
			<stop offset="0" stop-color="#1C4A38" stop-opacity="0.85"/>
			<stop offset="1" stop-color="#1C4A38" stop-opacity="0"/>
		</radialGradient>
		<filter id="zh-blur" x="-80%" y="-80%" width="260%" height="260%">
			<feGaussianBlur stdDeviation="26"/>
		</filter>
	</defs>`;
}

/** Corner brackets — the "harness": the frame that holds the agent. */
function brackets(opacity = 0.32) {
	const i = 150; // inset
	const a = 180; // arm length
	const p = (d) =>
		`<path d="${d}" fill="none" stroke="#27E398" stroke-opacity="${opacity}" stroke-width="20" stroke-linecap="square"/>`;
	return [
		p(`M${i} ${i + a} V${i} H${i + a}`),
		p(`M${1024 - i - a} ${i} H${1024 - i} V${i + a}`),
		p(`M${1024 - i} ${1024 - i - a} V${1024 - i} H${1024 - i - a}`),
		p(`M${i + a} ${1024 - i} H${i} V${1024 - i - a}`),
	].join("\n\t\t");
}

/** The Z + trailing cursor, shared by every variant. */
function zGroup({ scale = 1, cx = 512, cy = 514, skew = -6, glow = true } = {}) {
	const t = `translate(${cx} ${cy}) scale(${scale}) skewX(${skew}) translate(${-cx} ${-cy})`;
	const cursorGlow = glow
		? `<rect x="${CURSOR.x}" y="${CURSOR.y}" width="${CURSOR.w}" height="${CURSOR.h}" rx="${CURSOR.rx}" fill="url(#zh-green)" opacity="0.85" filter="url(#zh-blur)"/>`
		: "";
	return `<g transform="${t}">
		${cursorGlow}
		<path d="${Z_PATH}" fill="#F5F9FC"/>
		<rect x="${CURSOR.x}" y="${CURSOR.y}" width="${CURSOR.w}" height="${CURSOR.h}" rx="${CURSOR.rx}" fill="url(#zh-green)"/>
	</g>`;
}

/** Full-bleed rounded app tile. */
function tileSVG({ size = 1024, bgTop = BG_TOP, withBrackets = true } = {}) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
	${markDefs({ bgTop })}
	<rect width="1024" height="1024" rx="232" fill="url(#zh-bg)"/>
	<rect width="1024" height="1024" rx="232" fill="url(#zh-glow)"/>
	${withBrackets ? brackets() : ""}
	${zGroup({})}
</svg>`;
}

/** Android adaptive foreground: mark inside the safe zone, transparent bg. */
function foregroundSVG({ size = 432 } = {}) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
	${markDefs()}
	${zGroup({ scale: 0.62 })}
</svg>`;
}

// ---------------------------------------------------------------------------
// Pixel wordmark (5x7 hand-rolled glyphs — terminal aesthetic, no font dep)
// ---------------------------------------------------------------------------

const GLYPHS = {
	Z: ["11111", "00010", "00100", "01000", "10000", "10000", "11111"],
	H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
	A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
	R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
	N: ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
	E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
	S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
	D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
	I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
	V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
	C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
	O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
	G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
	T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
	U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
	"-": ["00000", "00000", "00000", "01110", "00000", "00000", "00000"],
};

function pixelText(text, { cell, x, y, color }) {
	const rects = [];
	let cursorX = x;
	for (const ch of text) {
		const g = GLYPHS[ch] ?? (ch === " " ? null : undefined);
		if (g === undefined) throw new Error(`glyph missing: ${ch}`);
		if (g) {
			for (let row = 0; row < 7; row++) {
				let col = 0;
				while (col < 5) {
					if (g[row][col] === "1") {
						let run = 1;
						while (col + run < 5 && g[row][col + run] === "1") run++;
						rects.push(
							`<rect x="${cursorX + col * cell}" y="${y + row * cell}" width="${run * cell}" height="${cell}" fill="${color}"/>`,
						);
						col += run;
					} else col++;
				}
			}
		}
		cursorX += 6 * cell; // 5 columns + 1 tracking space
	}
	return { svg: rects.join("\n\t\t"), width: cursorX - cell - x };
}

/** Horizontal lockup: mark + pixel "ZHARNESS" + pixel tagline. Transparent bg. */
function lockupSVG({ mode = "light" } = {}) {
	const ink = mode === "light" ? INK_TEXT : PAPER_TEXT;
	const mute = mode === "light" ? MUTE_LIGHT : MUTE_DARK;
	const mark = 340;
	const cell = 40;
	const wordY = 20;
	const word = pixelText("ZHARNESS", { cell, x: 0, y: wordY, color: ink });
	// first letter phosphor green — drawn on top of the ink wordmark
	const z = pixelText("Z", { cell, x: 0, y: wordY, color: GREEN_LO });
	const tagCell = 12;
	const tagY = wordY + 7 * cell + 40;
	const tag = pixelText("EVENT-DRIVEN CODING AGENT", { cell: tagCell, x: 0, y: tagY, color: mute });
	const textX = mark + 56;
	const W = Math.ceil(textX + Math.max(word.width, tag.width)) + 4;
	const H = tagY + 7 * tagCell + 20;
	const markY = Math.round((H - mark) / 2);
	const markScale = mark / 1024;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
	<g transform="translate(0 ${markY}) scale(${markScale})">${tileSVG({ withBrackets: false }).replace(/<\/?svg[^>]*>/g, "")}</g>
	<g transform="translate(${textX} 0)">
		${word.svg}
		${z.svg}
	</g>
	<g transform="translate(${textX + 2} 0)">${tag.svg}</g>
</svg>`;
}

// ---------------------------------------------------------------------------
// Minimal PNG codec (8-bit RGB/RGBA in, RGBA out) + area resize + masks
// ---------------------------------------------------------------------------

const CRC_TABLE = new Int32Array(256).map((_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c;
});
function crc32(buf) {
	let c = -1;
	for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
	const head = Buffer.alloc(4);
	head.write(type, 0, "ascii");
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head, data])), 0);
	return Buffer.concat([len, head, data, crc]);
}

/** Decode an 8-bit PNG (color type 2 or 6, no interlace) into RGBA. */
function decodePng(buf) {
	if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
	let pos = 8;
	let w = 0;
	let h = 0;
	let colorType = 0;
	const idat = [];
	while (pos < buf.length) {
		const len = buf.readUInt32BE(pos);
		const type = buf.toString("ascii", pos + 4, pos + 8);
		const data = buf.subarray(pos + 8, pos + 8 + len);
		if (type === "IHDR") {
			w = data.readUInt32BE(0);
			h = data.readUInt32BE(4);
			if (data[8] !== 8 || data[12] !== 0) throw new Error("unsupported PNG (depth/interlace)");
			colorType = data[9];
		} else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		pos += 12 + len;
	}
	const bpp = colorType === 6 ? 4 : 3;
	const raw = zlib.inflateSync(Buffer.concat(idat));
	const stride = w * bpp;
	const out = new Uint8ClampedArray(w * h * 4);
	const row = new Uint8Array(stride);
	const prev = new Uint8Array(stride);
	let p = 0;
	for (let y = 0; y < h; y++) {
		const filter = raw[p++];
		for (let i = 0; i < stride; i++) row[i] = raw[p + i];
		p += stride;
		const pa = (i) => row[i - bpp] ?? 0;
		const pb = (i) => prev[i];
		const pc = (i) => (prev[i - bpp] ?? 0);
		for (let i = 0; i < stride; i++) {
			switch (filter) {
				case 1: row[i] = (row[i] + pa(i)) & 0xff; break;
				case 2: row[i] = (row[i] + pb(i)) & 0xff; break;
				case 3: row[i] = (row[i] + ((pa(i) + pb(i)) >> 1)) & 0xff; break;
				case 4: {
					const a = pa(i), b = pb(i), c = pc(i);
					const pp = a + b - c;
					const da = Math.abs(pp - a), db = Math.abs(pp - b), dc = Math.abs(pp - c);
					row[i] = (row[i] + (da <= db && da <= dc ? a : db <= dc ? b : c)) & 0xff;
					break;
				}
			}
		}
		for (let x = 0; x < w; x++) {
			out[(y * w + x) * 4] = row[x * bpp];
			out[(y * w + x) * 4 + 1] = row[x * bpp + 1];
			out[(y * w + x) * 4 + 2] = row[x * bpp + 2];
			out[(y * w + x) * 4 + 3] = bpp === 4 ? row[x * bpp + 3] : 255;
		}
		prev.set(row);
	}
	return { width: w, height: h, data: out };
}

function encodePng({ width: w, height: h, data }) {
	const stride = w * 4;
	const raw = Buffer.alloc((stride + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (stride + 1)] = 0; // filter: none
		Buffer.from(data.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; // depth
	ihdr[9] = 6; // RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

/** Area-average downscale (or nearest-upscale, unused here). */
function resize(src, w, h) {
	const { width: sw, height: sh, data: sd } = src;
	if (w === sw && h === sh) return { width: w, height: h, data: new Uint8ClampedArray(sd) };
	const out = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++) {
		const y0 = Math.floor((y * sh) / h);
		const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / h));
		for (let x = 0; x < w; x++) {
			const x0 = Math.floor((x * sw) / w);
			const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / w));
			let r = 0, g = 0, b = 0, a = 0, n = 0;
			for (let yy = y0; yy < y1; yy++) {
				for (let xx = x0; xx < x1; xx++) {
					const i = (yy * sw + xx) * 4;
					// composite over the target's own background: premultiply so
					// transparent masters shrink without halo
					const al = sd[i + 3] / 255;
					r += sd[i] * al; g += sd[i + 1] * al; b += sd[i + 2] * al; a += sd[i + 3];
					n++;
				}
			}
			const o = (y * w + x) * 4;
			const aa = a / n / 255;
			if (aa > 0) {
				out[o] = r / n / aa;
				out[o + 1] = g / n / aa;
				out[o + 2] = b / n / aa;
			}
			out[o + 3] = a / n;
		}
	}
	return { width: w, height: h, data: out };
}

function maskAlpha(img, fn) {
	const { width: w, height: h, data } = img;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			data[i + 3] = Math.min(data[i + 3], Math.round(255 * fn(x + 0.5, y + 0.5, w, h)));
		}
	}
	return img;
}

/** Antialiased rounded-rect mask in [0,1], r in pixels, 1px soft edge. */
function roundedRectMask(r) {
	return (x, y, w, h) => {
		const cx = Math.abs(x - w / 2) - (w / 2 - r);
		const cy = Math.abs(y - h / 2) - (h / 2 - r);
		const qx = Math.max(cx, 0), qy = Math.max(cy, 0);
		const d = Math.hypot(qx, qy) + Math.min(Math.max(cx, cy), 0) - r;
		return Math.max(0, Math.min(1, 0.5 - d));
	};
}
const circleMask = (x, y, w, h) => {
	const d = Math.hypot(x - w / 2, y - h / 2) - w / 2;
	return Math.max(0, Math.min(1, 0.5 - d));
};

/**
 * Make the master fully opaque: pixels outside the tile's rounded corners
 * (rendered against a white backdrop) are refilled with the bg gradient, so
 * both rounded and square derivatives start from clean geometry.
 */
function fillOutsideRounded(img, r, top, bottom) {
	const { width: w, height: h, data } = img;
	const mask = roundedRectMask(r);
	for (let y = 0; y < h; y++) {
		const t = y / (h - 1);
		const c = [0, 1, 2].map((i) => Math.round(top[i] + (bottom[i] - top[i]) * t));
		for (let x = 0; x < w; x++) {
			if (mask(x + 0.5, y + 0.5, w, h) < 0.5) {
				const i = (y * w + x) * 4;
				data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
			}
		}
	}
	return img;
}

// ---------------------------------------------------------------------------
// Edge headless renderer (masters only)
// ---------------------------------------------------------------------------

const EDGE_CANDIDATES = [
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

/** Edge may keep a lingering child holding the profile dir for a moment. */
function rmDirSafe(dir) {
	for (let i = 0; i < 5; i++) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			return;
		} catch {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * (i + 1));
		}
	}
	// a leftover temp dir is harmless — give up quietly
}

function findEdge() {
	for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
	throw new Error("Microsoft Edge not found — install Edge or extend EDGE_CANDIDATES");
}

/** Rasterize `svg` to `out` at exactly w×h px. bg: "transparent"|"#RRGGBB". */
function renderPng(edge, svg, w, h, out, bg = "transparent") {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zh-brand-"));
	const svgFile = path.join(tmpDir, "in.svg");
	fs.writeFileSync(svgFile, svg);
	const bgArg = bg === "transparent" ? "00000000" : "ff" + bg.replace("#", "");
	return new Promise((resolve, reject) => {
		const p = spawn(
			edge,
			[
				"--headless",
				"--disable-gpu",
				"--hide-scrollbars",
				"--force-device-scale-factor=1",
				`--default-background-color=${bgArg}`,
				"--no-first-run",
				"--disable-extensions",
				`--user-data-dir=${tmpDir}`,
				`--window-size=${w},${h}`,
				`--screenshot=${out}`,
				pathToFileURL(svgFile).href,
			],
			{ stdio: "ignore" },
		);
		const timer = setTimeout(() => {
			p.kill();
			reject(new Error(`render timed out: ${out}`));
		}, 120000);
		p.on("close", () => {
			clearTimeout(timer);
			rmDirSafe(tmpDir);
			fs.existsSync(out) ? resolve() : reject(new Error(`render failed: ${out}`));
		});
		p.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
	});
}

// ---------------------------------------------------------------------------
// Container writers: ICO / ICNS (PNG-embedded, no deps)
// ---------------------------------------------------------------------------

function writeIco(entries, out) {
	const count = entries.length;
	const header = Buffer.alloc(6);
	header.writeUInt16LE(1, 2); // type: icon
	header.writeUInt16LE(count, 4);
	const dir = Buffer.alloc(16 * count);
	let offset = 6 + 16 * count;
	entries.forEach((e, i) => {
		const o = i * 16;
		dir.writeUInt8(e.size >= 256 ? 0 : e.size, o);
		dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
		dir.writeUInt16LE(1, o + 4); // planes
		dir.writeUInt16LE(32, o + 6); // bpp
		dir.writeUInt32LE(e.data.length, o + 8);
		dir.writeUInt32LE(offset, o + 12);
		offset += e.data.length;
	});
	fs.writeFileSync(out, Buffer.concat([header, dir, ...entries.map((e) => e.data)]));
}

function writeIcns(chunks, out) {
	const bodies = chunks.map((c) => {
		const head = Buffer.alloc(8);
		head.write(c.type, 0, "ascii");
		head.writeUInt32BE(c.data.length + 8, 4);
		return Buffer.concat([head, c.data]);
	});
	const header = Buffer.alloc(8);
	header.write("icns", 0, "ascii");
	header.writeUInt32BE(8 + bodies.reduce((n, c) => n + c.length, 0), 4);
	fs.writeFileSync(out, Buffer.concat([header, ...bodies]));
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const SS = 2048; // master resolution (supersampled; everything derives from it)

async function main() {
	fs.mkdirSync(ASSETS, { recursive: true });
	const edge = findEdge();

	// --- vector-only outputs (no rasterization needed) ---
	fs.writeFileSync(path.join(ICONS, "icon.svg"), tileSVG({}) + "\n");
	fs.writeFileSync(path.join(ASSETS, "logo-lockup.svg"), lockupSVG({ mode: "light" }) + "\n");
	fs.writeFileSync(path.join(ASSETS, "logo-lockup-dark.svg"), lockupSVG({ mode: "dark" }) + "\n");

	// --- masters: cool tile, warm tile, adaptive foreground (alpha via matte) ---
	console.log("rendering masters with headless Edge (4 shots)…");
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zh-master-"));
	const shot = (n, svg, w, h, bg) => renderPng(edge, svg, w, h, path.join(tmp, n), bg);
	await Promise.all([
		shot("tile-cool.png", tileSVG({ size: SS }), SS, SS, "#FFFFFF"),
		shot("tile-warm.png", tileSVG({ size: SS, bgTop: BG_TOP_WARM }), SS, SS, "#FFFFFF"),
		// foreground SVG must be requested at its window size, else it renders
		// small in the top-left corner of the master
		shot("fg-black.png", foregroundSVG({ size: 1024 }), 1024, 1024, "#000000"),
		shot("fg-white.png", foregroundSVG({ size: 1024 }), 1024, 1024, "#FFFFFF"),
	]);

	// reconstruct true-RGBA foreground from the black/white pair:
	//   black = F·A, white = F·A + 255·(1-A)  →  A = 1-(W-B)/255, F = black/A
	const fgb = decodePng(fs.readFileSync(path.join(tmp, "fg-black.png")));
	const fgw = decodePng(fs.readFileSync(path.join(tmp, "fg-white.png")));
	const fg = { width: fgb.width, height: fgb.height, data: new Uint8ClampedArray(fgb.data.length) };
	for (let i = 0; i < fgb.data.length; i += 4) {
		let a = 0;
		for (let c = 0; c < 3; c++) a = Math.max(a, fgw.data[i + c] - fgb.data[i + c]);
		a = 255 - a;
		const al = a / 255;
		fg.data[i + 3] = a;
		if (a > 0) {
			for (let c = 0; c < 3; c++) fg.data[i + c] = Math.round(fgb.data[i + c] / al);
		}
	}

	// opaque square sources (outside the rounded corners filled with gradient)
	const rrMaster = (TILE_RX * SS) / 1024;
	const squareCool = fillOutsideRounded(
		decodePng(fs.readFileSync(path.join(tmp, "tile-cool.png"))), rrMaster, BG_TOP, BG_BOTTOM);
	const squareWarm = fillOutsideRounded(
		decodePng(fs.readFileSync(path.join(tmp, "tile-warm.png"))), rrMaster, BG_TOP_WARM, BG_BOTTOM);

	/** Derive a finished image at `size` from an opaque square master. */
	const derive = (master, size, shape) => {
		const img = resize(master, size, size);
		if (shape === "rounded") maskAlpha(img, roundedRectMask((TILE_RX * size) / 1024));
		else if (shape === "circle") maskAlpha(img, circleMask);
		return encodePng(img);
	};

	const W = (p, buf) => (fs.writeFileSync(p, buf), p);

	// --- desktop icons (Tauri full set) ---
	W(path.join(ROOT, "apps/desktop/app-icon.png"), derive(squareCool, 1024, "rounded"));
	W(path.join(ICONS, "icon.png"), derive(squareCool, 512, "rounded"));
	W(path.join(ICONS, "128x128@2x.png"), derive(squareCool, 256, "rounded"));
	W(path.join(ICONS, "128x128.png"), derive(squareCool, 128, "rounded"));
	W(path.join(ICONS, "64x64.png"), derive(squareCool, 64, "rounded"));
	W(path.join(ICONS, "32x32.png"), derive(squareCool, 32, "rounded"));
	for (const s of [30, 44, 71, 89, 107, 142, 150, 284, 310]) {
		W(path.join(ICONS, `Square${s}x${s}Logo.png`), derive(squareCool, s, "square"));
	}
	W(path.join(ICONS, "StoreLogo.png"), derive(squareCool, 50, "square"));
	const iosSizes = {
		"AppIcon-20x20@2x-1.png": 40,
		"AppIcon-20x20@2x.png": 40,
		"AppIcon-20x20@3x.png": 60,
		"AppIcon-29x29@1x.png": 29,
		"AppIcon-29x29@2x-1.png": 58,
		"AppIcon-29x29@2x.png": 58,
		"AppIcon-29x29@3x.png": 87,
		"AppIcon-40x40@1x.png": 40,
		"AppIcon-40x40@2x-1.png": 80,
		"AppIcon-40x40@2x.png": 80,
		"AppIcon-40x40@3x.png": 120,
		"AppIcon-60x60@2x.png": 120,
		"AppIcon-60x60@3x.png": 180,
		"AppIcon-76x76@1x.png": 76,
		"AppIcon-76x76@2x.png": 152,
		"AppIcon-83.5x83.5@2x.png": 167,
		"AppIcon-512@2x.png": 1024,
	};
	for (const [file, s] of Object.entries(iosSizes)) {
		W(path.join(ICONS, "ios", file), derive(squareCool, s, "rounded"));
	}
	const androidSizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
	for (const [dpi, s] of Object.entries(androidSizes)) {
		W(path.join(ICONS, `android/mipmap-${dpi}/ic_launcher.png`), derive(squareCool, s, "rounded"));
		W(path.join(ICONS, `android/mipmap-${dpi}/ic_launcher_round.png`), derive(squareCool, s, "circle"));
	}
	const fgSizes = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
	for (const [dpi, s] of Object.entries(fgSizes)) {
		W(path.join(ICONS, `android/mipmap-${dpi}/ic_launcher_foreground.png`), encodePng(resize(fg, s, s)));
	}

	// --- web assets ---
	fs.writeFileSync(path.join(WEB_LOGO, "top.svg"), tileSVG({}) + "\n");
	W(path.join(WEB_LOGO, "top.png"), derive(squareCool, 256, "rounded"));
	W(path.join(WEB_LOGO, "logo.png"), derive(squareCool, 256, "rounded"));
	W(path.join(WEB_LOGO, "logo-dark.png"), derive(squareWarm, 256, "rounded"));
	W(path.join(WEB_MISC, "avatar-light.png"), derive(squareCool, 256, "rounded"));
	W(path.join(WEB_MISC, "avatar-dark.png"), derive(squareWarm, 256, "rounded"));

	// --- ICO / ICNS ---
	writeIco(
		[16, 24, 32, 48, 64, 128, 256].map((s) => ({
			size: s,
			data: derive(squareCool, s, "rounded"),
		})),
		path.join(ICONS, "icon.ico"),
	);
	writeIcns(
		[
			{ type: "icp4", data: derive(squareCool, 16, "rounded") },
			{ type: "icp5", data: derive(squareCool, 32, "rounded") },
			{ type: "icp6", data: derive(squareCool, 64, "rounded") },
			{ type: "ic07", data: derive(squareCool, 128, "rounded") },
			{ type: "ic08", data: derive(squareCool, 256, "rounded") },
			{ type: "ic09", data: derive(squareCool, 512, "rounded") },
			{ type: "ic10", data: derive(squareCool, 1024, "rounded") },
		],
		path.join(ICONS, "icon.icns"),
	);

	rmDirSafe(tmp);
	console.log("done.");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
