// Доработка сгенерированного проекта Android (src-tauri/gen/android) после `tauri android init`:
// - «Доступ ко всем файлам» (MANAGE_EXTERNAL_STORAGE) — чтобы синхронизировать папку Obsidian по обычному пути;
//   разрешение пользователь включает сам: Настройки Android → Приложения → Хаб;
// - библиотеки распаковываются на диск (useLegacyPackaging) — иначе librclone.so нельзя запустить;
// - системные полосы, вырезы экрана и клавиатура учитываются в MainActivity.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const app = join("src-tauri", "gen", "android", "app");
const manifestPath = join(app, "src", "main", "AndroidManifest.xml");
let m = readFileSync(manifestPath, "utf8");
for (const perm of ["android.permission.MANAGE_EXTERNAL_STORAGE", "android.permission.POST_NOTIFICATIONS", "android.permission.INTERNET", "android.permission.REQUEST_INSTALL_PACKAGES"]) {
  if (!m.includes(perm)) m = m.replace(/<application/, `<uses-permission android:name="${perm}" />\n    <application`);
}
if (!m.includes("UpdateFileProvider")) {
  m = m.replace("</application>", `    <provider android:name="local.hub.mobile.UpdateFileProvider"
      android:authorities="\${applicationId}.update-files"
      android:exported="false" android:grantUriPermissions="true">
      <meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/hub_update_paths" />
    </provider>
  </application>`);
}
writeFileSync(manifestPath, m);
const sources = join(app, "src", "main");
const kotlin = join(sources, "java", "local", "hub", "mobile");
const xml = join(sources, "res", "xml");
mkdirSync(kotlin, { recursive: true });
mkdirSync(xml, { recursive: true });
for (const name of ["MainActivity.kt", "SystemBars.kt", "UpdateInstaller.kt"]) {
  copyFileSync(join("src-tauri", "android", name), join(kotlin, name));
}
writeFileSync(join(xml, "hub_update_paths.xml"), '<paths><cache-path name="hub_updates" path="hub-updates/" /></paths>\n');

const gradlePath = join(app, "build.gradle.kts");
let g = readFileSync(gradlePath, "utf8");
if (!g.includes("useLegacyPackaging")) {
  g = g.replace(/android\s*\{/, `android {\n    packaging {\n        jniLibs {\n            useLegacyPackaging = true\n        }\n    }`);
  writeFileSync(gradlePath, g);
}
const so = join(app, "src", "main", "jniLibs", "arm64-v8a", "librclone.so");
console.log(`манифест и gradle доработаны; librclone.so ${existsSync(so) ? "на месте" : "ОТСУТСТВУЕТ"}`);
if (!existsSync(so)) process.exit(1);
