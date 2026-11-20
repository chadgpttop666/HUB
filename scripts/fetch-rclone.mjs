// Скачать официальный rclone для сборки хаба и проверить контрольную сумму.
//   node scripts/fetch-rclone.mjs [target-triple]
// Кладёт src-tauri/binaries/rclone-<triple>[.exe] — так Tauri встраивает «sidecar» рядом с hub.exe.
// Версия зафиксирована: обновлять осознанно, после tools/rclone-check/check.sh.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RCLONE_VERSION = "v1.76.0";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORMS = {
  "x86_64-pc-windows-msvc": "windows-amd64",
  "aarch64-pc-windows-msvc": "windows-arm64",
  "x86_64-unknown-linux-gnu": "linux-amd64",
  "aarch64-unknown-linux-gnu": "linux-arm64",
  "x86_64-apple-darwin": "osx-amd64",
  "aarch64-apple-darwin": "osx-arm64",
};

function hostTriple() {
  try { return execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/host: (\S+)/)[1]; }
  catch { throw new Error("не знаю платформу: передайте target-triple аргументом"); }
}

export async function fetchRclone(triple = hostTriple()) {
  const plat = PLATFORMS[triple];
  if (!plat) throw new Error(`для ${triple} готового rclone нет`);
  const exe = triple.includes("windows") ? ".exe" : "";
  const out = join(root, "src-tauri", "binaries", `rclone-${triple}${exe}`);
  if (existsSync(out)) { console.log(`rclone уже есть: ${out}`); return out; }
  const base = `https://downloads.rclone.org/${RCLONE_VERSION}`;
  const zipName = `rclone-${RCLONE_VERSION}-${plat}.zip`;
  const sums = await (await fetch(`${base}/SHA256SUMS`)).text();
  const want = (sums.split("\n").find(l => l.trim().endsWith(zipName)) || "").split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(want)) throw new Error(`в SHA256SUMS нет ${zipName}`);
  const res = await fetch(`${base}/${zipName}`);
  if (!res.ok) throw new Error(`${zipName}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== want) throw new Error(`контрольная сумма не сходится: ${got} ≠ ${want}`);
  const tmp = mkdtempSync(join(tmpdir(), "rclone-"));
  const zip = join(tmp, zipName);
  writeFileSync(zip, buf);
  if (process.platform === "win32") execFileSync("tar", ["-xf", zip, "-C", tmp]);
  else execFileSync("unzip", ["-q", "-o", zip, "-d", tmp]);
  const dir = readdirSync(tmp).find(d => d.startsWith("rclone-") && !d.endsWith(".zip"));
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(join(tmp, dir, `rclone${exe}`), out);
  if (!exe) chmodSync(out, 0o755);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`rclone ${RCLONE_VERSION} (${plat}), sha256 сошёлся → ${out}`);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fetchRclone(process.argv[2]).catch(e => { console.error(e.message); process.exit(1); });
}
