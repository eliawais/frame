import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repo = new URL("../", import.meta.url);
const paths = [
  ["index.html", "beta/app.html", "text/html; charset=utf-8"],
  ["app.js", "app.js", "text/javascript; charset=utf-8"],
  ["room-screen.js", "room-screen.js", "text/javascript; charset=utf-8"],
  ["sw.js", "sw.js", "text/javascript; charset=utf-8"],
  ["style.css", "style.css", "text/css; charset=utf-8"],
  ["player.html", "player.html", "text/html; charset=utf-8"],
  ["icon.svg", "icon.svg", "image/svg+xml"],
  ["icon-maskable.svg", "icon-maskable.svg", "image/svg+xml"],
  ["manifest.webmanifest", "manifest.webmanifest", "application/manifest+json"],
];
const entries = await Promise.all(paths.map(async ([route, file, type]) => [
  "/" + route, [type, await readFile(new URL(file, repo), "utf8")],
]));
const backend = await readFile(new URL("beta/worker.mjs", repo), "utf8");
const output = new URL("dist/", repo);
await mkdir(output, { recursive: true });
await writeFile(new URL("_worker.js", output),
  backend + "\nexport default handler(new Map(" + JSON.stringify(entries) + "));\n");
console.log("Built " + fileURLToPath(new URL("_worker.js", output)));
