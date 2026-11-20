// Доработка сгенерированного проекта Android (src-tauri/gen/android) после `tauri android init`:
// - «Доступ ко всем файлам» (MANAGE_EXTERNAL_STORAGE) — чтобы синхронизировать папку Obsidian по обычному пути;
//   разрешение пользователь включает сам: Настройки Android → Приложения → Хаб;
// - библиотеки распаковываются на диск (useLegacyPackaging) — иначе librclone.so нельзя запустить.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const app = join("src-tauri", "gen", "android", "app");
const manifestPath = join(app, "src", "main", "AndroidManifest.xml");
let m = readFileSync(manifestPath, "utf8");
for (const perm of ["android.permission.MANAGE_EXTERNAL_STORAGE", "android.permission.POST_NOTIFICATIONS", "android.permission.INTERNET"]) {
  if (!m.includes(perm)) m = m.replace(/<application/, `<uses-permission android:name="${perm}" />\n    <application`);
}
writeFileSync(manifestPath, m);

const gradlePath = join(app, "build.gradle.kts");
let g = readFileSync(gradlePath, "utf8");
if (!g.includes("useLegacyPackaging")) {
  g = g.replace(/android\s*\{/, `android {\n    packaging {\n        jniLibs {\n            useLegacyPackaging = true\n        }\n    }`);
  writeFileSync(gradlePath, g);
}
const so = join(app, "src", "main", "jniLibs", "arm64-v8a", "librclone.so");
console.log(`манифест и gradle доработаны; librclone.so ${existsSync(so) ? "на месте" : "ОТСУТСТВУЕТ"}`);
if (!existsSync(so)) process.exit(1);
