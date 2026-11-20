// Собирает dist/ — то, что Tauri кладёт внутрь хаба:
//   dist/           оболочка (ui/)
//   dist/hub/       дизайн-система для оболочки и приложений: tokens.css, hub.css, hub-ui.js, шрифты, темы,
//                   плюс обвязка приложений hub-app.js и app.css (runtime/)
//   dist/apps/      встроенные приложения (apps/<id>/) и их список apps/index.json
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ds = join(root, "design-system");

export function build({ quiet = false } = {}) {
  const dist = join(root, "dist");
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  cpSync(join(root, "ui"), dist, { recursive: true });

  const hub = join(dist, "hub");
  mkdirSync(hub, { recursive: true });
  cpSync(join(ds, "tokens.css"), join(hub, "tokens.css"));
  cpSync(join(ds, "components", "bundle.css"), join(hub, "hub.css"));
  cpSync(join(ds, "components", "bundle.js"), join(hub, "hub-ui.js"));
  for (const d of ["fonts", "themes", "licenses"]) cpSync(join(ds, d), join(hub, d), { recursive: true });
  cpSync(join(root, "runtime"), hub, { recursive: true });

  const apps = [];
  const appsOut = join(dist, "apps");
  mkdirSync(appsOut, { recursive: true });
  // порядок в меню и для Alt+1…9: сначала основные, остальные — по алфавиту
  const FIRST = ["repetition", "calendar"];
  const order = id => (FIRST.includes(id) ? FIRST.indexOf(id) : FIRST.length);
  for (const id of readdirSync(join(root, "apps")).sort((a, b) => order(a) - order(b) || a.localeCompare(b))) {
    const dir = join(root, "apps", id);
    if (!existsSync(join(dir, "manifest.json"))) continue;
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    if (m.id && m.id !== id) throw new Error(`apps/${id}: id в манифесте (${m.id}) не совпадает с папкой`);
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) || id === "hub") throw new Error(`apps/${id}: имя папки — строчные латинские буквы, цифры, - _ . (и не «hub»)`);
    cpSync(dir, join(appsOut, id), { recursive: true });
    apps.push(id);
  }
  writeFileSync(join(appsOut, "index.json"), JSON.stringify(apps) + "\n");
  if (!quiet) console.log(`dist/ собран: оболочка, hub/, приложения: ${apps.join(", ") || "нет"}`);
  return dist;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) build();
