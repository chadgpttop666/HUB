// Хаб в обычном браузере, без Tauri: npm run dev → http://localhost:5173
// Данные — в localStorage страницы (заглушка ядра в ui/js/core.js), Blob — в памяти до перезагрузки.
// /hubapp/… изображает протокол hubapp:// ядра: /hubapp/_hub/* → dist/hub/*, /hubapp/<id>/* → dist/apps/<id>/*.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { build } from "./build-ui.mjs";

const dist = build();
const port = Number(process.env.PORT || 5173);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8" };

function resolvePath(urlPath) {
  let p = decodeURIComponent(urlPath.split("?")[0]);
  if (p.startsWith("/hubapp/_hub/")) p = "/hub/" + p.slice("/hubapp/_hub/".length);
  else if (p.startsWith("/hubapp/")) p = "/apps/" + p.slice("/hubapp/".length);
  if (p.endsWith("/")) p += "index.html";
  const full = normalize(join(dist, p));
  if (full !== dist && !full.startsWith(dist + sep)) return null;
  return full;
}

createServer(async (req, res) => {
  const file = resolvePath(req.url);
  try {
    if (!file || !(await stat(file)).isFile()) throw new Error("нет");
    res.writeHead(200, { "Content-Type": TYPES[extname(file).toLowerCase()] || "application/octet-stream",
      "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end("не найдено");
  }
}).listen(port, () => console.log(`Хаб (браузер): http://localhost:${port}`));
