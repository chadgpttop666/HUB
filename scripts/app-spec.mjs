// Собирает APP_SPEC.md (корень репозитория) из docs/app-spec.template.md, токенов и значков дизайн-системы
// и шаблона templates/app — чтобы файл правил для нейросети не расходился с тем, что хаб умеет.
//   node scripts/app-spec.mjs          — записать
//   node scripts/app-spec.mjs --check  — проверить, что записанный файл свежий (для CI)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = p => readFileSync(join(root, p), "utf8");
const tokensCss = read("design-system/tokens.css");

function tokenRows(block, names) {
  const rows = [];
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*--([a-z0-9-]+):[^;]+;\s*\/\*\s*(.*?)\s*\*\/\s*$/);
    if (m && names(m[1])) rows.push(`| \`--${m[1]}\` | ${m[2]} |`);
  }
  return ["| токен | для чего |", "| --- | --- |", ...rows].join("\n");
}
const darkBlock = tokensCss.slice(tokensCss.indexOf(':root, [data-theme="dark"]'), tokensCss.indexOf('[data-theme="light"]'));
const colors = tokenRows(darkBlock, n => !n.startsWith("scrim") && n !== "bg");
const rootBlock = tokensCss.slice(tokensCss.indexOf("\n:root {"));
const sizes = tokenRows(rootBlock, n => /^(space|control|radius|font-size|weight|duration|ease|blur-glass)/.test(n));

const bundle = read("design-system/components/bundle.js");
const icons = Object.keys(JSON.parse(bundle.match(/var ICONS = (\{.*?\});\n/s)[1])).sort();

const out = read("docs/app-spec.template.md")
  .replace("{{TOKENS}}", colors)
  .replace("{{SIZES}}", sizes)
  .replace("{{ICONS}}", icons.map(i => `\`${i}\``).join(", "))
  .replace("{{TEMPLATE_MANIFEST}}", read("templates/app/manifest.json").trim())
  .replace("{{TEMPLATE_HTML}}", read("templates/app/index.html").trim());

const target = join(root, "APP_SPEC.md");
if (process.argv.includes("--check")) {
  if (!existsSync(target) || readFileSync(target, "utf8") !== out) { console.error("APP_SPEC.md устарел: node scripts/app-spec.mjs"); process.exit(1); }
  console.log("APP_SPEC.md свежий");
} else {
  writeFileSync(target, out);
  console.log(`APP_SPEC.md: ${icons.length} значков, ${colors.split("\n").length - 2} цветов, ${sizes.split("\n").length - 2} размеров`);
}
