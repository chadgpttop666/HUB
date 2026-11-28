// Сквозной тест настоящего окна Tauri (Linux, WebKitGTK) через tauri-driver: два устройства,
// «Google Drive» изображает папка (HUB_SYNC_LOCAL). Нужны: tauri-driver, WebKitWebDriver, rclone, дисплей (Xvfb).
// Запуск: HUB_RCLONE=/путь/к/rclone DISPLAY=:99 node tests/tauri-e2e.mjs
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "src-tauri", "target", "debug", "hub");
const W = `/tmp/hub-e2e-${process.pid}`;
rmSync(W, { recursive: true, force: true });
for (const d of ["drive", "pc", "phone", "vault-pc", "vault-phone"]) mkdirSync(join(W, d), { recursive: true });
for (let i = 1; i <= 4; i++) writeFileSync(join(W, "vault-pc", `заметка ${i}.md`), `# Заметка ${i}\n`);

let failed = 0, passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${String(e && e.stack || e).split("\n").slice(0, 3).join("\n    ")}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || "условие не выполнено"); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function device(name, port) {
  const env = { ...process.env, HOME: join(W, name), XDG_DATA_HOME: join(W, name, "share"), HUB_SYNC_LOCAL: join(W, "drive") };
  const drv = spawn("dbus-run-session", ["--", "tauri-driver", "--port", String(port), "--native-port", String(port + 1)], { env, stdio: "ignore", detached: true });   // своя группа процессов — чтобы остановить и драйвер, и хаб
  const base = `http://127.0.0.1:${port}`;
  let sid = null;
  async function wd(method, path, body) {
    const r = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (j.value && j.value.error) throw new Error(`${j.value.error}: ${j.value.message}`);
    return j.value;
  }
  return {
    name, drv,
    dataDir: join(W, name, "share", "local.hub.desktop"),
    async start() {
      // крестик в тестах закрывает хаб совсем, а не прячет в трей
      mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(join(this.dataDir, "prefs.json"), JSON.stringify({ closeToTray: false, trayHintShown: true }));
      for (let i = 0; i < 50; i++) { try { await fetch(`${base}/status`); break; } catch { await sleep(200); } }
      const s = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: app } } } });
      sid = s.sessionId;
      await sleep(2500);
    },
    js(fn, ...args) { return wd("POST", `/session/${sid}/execute/async`, { script: `const done = arguments[arguments.length - 1]; (${fn})(...Array.from(arguments).slice(0, -1)).then(v => done({ ok: v }), e => done({ err: String(e && e.message || e) }));`, args })
      .then(r => { if (r && r.err) throw new Error(r.err); return r && r.ok; }); },
    async until(fn, ms = 20000, what = "условие", ...args) {
      const t0 = Date.now();
      for (;;) { try { if (await this.js(fn, ...args)) return; } catch { /* ещё нет */ } if (Date.now() - t0 > ms) throw new Error(`${this.name}: не дождались — ${what}`); await sleep(400); }
    },
    async shot(file) { const b64 = await wd("GET", `/session/${sid}/screenshot`); writeFileSync(join(root, "tests", "out", file), Buffer.from(b64, "base64")); },
    async stop() { try { await wd("DELETE", `/session/${sid}`); } catch { /* ничего */ } try { process.kill(-drv.pid, "SIGTERM"); } catch { drv.kill(); } },
  };
}

// заполнить поле и отправить форму — как пользователь, через DOM
const fill = async (sel, v) => { const el = document.querySelector(sel); el.focus(); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); return true; };
const click = async sel => { document.querySelector(sel).click(); return true; };
const has = async sel => !!document.querySelector(sel);
const PW = "лес на рассвете у реки";

mkdirSync(join(root, "tests", "out"), { recursive: true });
console.log("Хаб в окне Tauri — два устройства");
const pc = device("pc", 4444), phone = device("phone", 4454);
try {
  await pc.start();

  await test("ПК: первая настройка и подключение «Drive»", async () => {
    await pc.until(has, 15000, "экран настройки", ".shell-setup");
    await pc.js(click, '[data-choose="new"]');
    await pc.js(fill, "#su-name", "ПК");
    await pc.js(click, '.shell-setup [type="submit"]');
    await pc.until(has, 5000, "шаг пароля", "#su-p1");
    await pc.js(fill, "#su-p1", PW); await pc.js(fill, "#su-p2", PW);
    await pc.js(click, '.shell-setup [type="submit"]');
    await pc.until(has, 20000, "ключ восстановления", ".hub-key");
    await pc.js(async () => { const c = document.querySelector("#su-saved"); c.checked = true; c.dispatchEvent(new Event("change")); return true; });
    await pc.js(click, '.shell-setup [type="submit"]');
    await pc.until(has, 5000, "шаг Drive", '[data-step="drive"]');
    const canConnect = async () => !document.querySelector('[data-step="drive"]').disabled;
    assert(!(await pc.js(canConnect)), "Drive ждёт обе части OAuth-клиента");
    await pc.js(fill, "#gc-id", "hub-tests.apps.googleusercontent.com");
    assert(!(await pc.js(canConnect)), "одного Client ID недостаточно");
    await pc.js(fill, "#gc-secret", "hub-tests");
    await pc.js(click, '[data-step="drive"]');
    await pc.until(has, 20000, "«Сегодня»", "#screen-today:not([hidden])");
    for (let i = 0; i < 50 && !existsSync(join(W, "drive", "keys.json")); i++) await sleep(300);
    assert(existsSync(join(W, "drive", "keys.json")), "keys.json на «Drive»");
  });

  await test("ПК: мысль в корзину уходит на «Drive» зашифрованной", async () => {
    const t0 = await pc.js(async () => { window.__hubShell.state.add("мысль с ПК для телефона"); return Date.now(); });
    await pc.until(async t0 => { const s = await window.__hubShell.core.syncStatus(); return s.lastSync > t0 + 500 && s.state === "idle"; }, 40000, "синхронизация после правки", t0)
      .catch(async e => { throw new Error(`${e.message}: ${JSON.stringify(await pc.js(async () => window.__hubShell.core.syncStatus()))}, t0=${t0}`); });
    const files = []; (function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } })(join(W, "drive"));
    assert(files.length >= 2, `на «Drive» ключи и журнал: ${files.length}`);
    assert(!files.some(f => /changes|inbox|repetition/.test(f.slice(join(W, "drive", "crypt").length))), "имена зашифрованы");
    assert(!files.some(f => readFileSync(f).includes(Buffer.from("мысль с ПК"))), "содержимое зашифровано");
    const local = []; (function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : local.push(p); } })(join(pc.dataDir, "data"));
    assert(local.length && !local.some(f => readFileSync(f).includes(Buffer.from("мысль с ПК"))), "и на диске ПК данные зашифрованы");
    await pc.shot("t1-pc-today.png");
  });

  await test("ПК: помеченная папка — пробный прогон и первая синхронизация", async () => {
    const id = await pc.js(async p => window.__hubShell.core.folderAdd(p, "Obsidian", "two-way", [".obsidian/workspace*.json"]), join(W, "vault-pc"));
    const pv = await pc.js(async id => window.__hubShell.core.folderPreview(id), id);
    assert(pv.upload.length === 5, `уйдёт 4 заметки и .hubsync: ${JSON.stringify(pv)}`);
    await pc.js(async id => window.__hubShell.core.folderSync(id, "start"), id);
    await pc.js(async () => { await window.__hubShell.core.syncNow(); return true; });
    await sleep(4000);
  });

  await phone.start();

  await test("Телефон: «Подключить к существующему» — ключи и данные с «Drive»", async () => {
    await phone.until(has, 15000, "экран настройки", ".shell-setup");
    await phone.js(click, '[data-choose="join"]');
    await phone.js(fill, "#gc-id", "hub-tests.apps.googleusercontent.com");
    await phone.js(fill, "#gc-secret", "hub-tests");
    await phone.js(click, '[data-step="google"]');
    await phone.until(async () => !document.querySelector('#screen-lock [type="submit"]').disabled, 8000, "вход в «Google»").catch(async e => {
      await phone.shot("t-fail-phone.png");
      throw new Error(`${e.message}: ${await phone.js(async () => document.querySelector("#su-jmsg") && document.querySelector("#su-jmsg").textContent)}`);
    });
    await phone.js(fill, "#su-jp", "не тот пароль");
    await phone.js(click, '#screen-lock [type="submit"]');
    await phone.until(async () => document.querySelector("#su-jmsg").textContent.includes("Неверный пароль"), 20000, "неверный пароль");
    await phone.js(fill, "#su-jp", PW);
    await phone.js(click, '#screen-lock [type="submit"]');
    await phone.until(has, 30000, "«Сегодня»", "#screen-today:not([hidden])");
    await phone.until(async () => window.__hubShell.state.items.some(i => i.text === "мысль с ПК для телефона"), 30000, "мысль с ПК пришла");
    await phone.shot("t2-phone-today.png");
  });

  await test("Телефон: папка с ПК — выбрать место, файлы приходят", async () => {
    await phone.until(async () => window.__hubShell.state.folders.length === 1, 10000, "описание папки пришло");
    const id = await phone.js(async () => window.__hubShell.state.folders[0].id);
    await phone.js(async (id, p) => window.__hubShell.core.folderPlace(id, p), id, join(W, "vault-phone"));
    const pv = await phone.js(async id => window.__hubShell.core.folderPreview(id), id);
    assert(pv.download.length === 5, `придёт 5: ${JSON.stringify(pv)}`);
    await phone.js(async id => window.__hubShell.core.folderSync(id, "start"), id);
    assert(readFileSync(join(W, "vault-phone", "заметка 3.md"), "utf8").includes("Заметка 3"), "заметка на месте");
    assert(existsSync(join(W, "vault-phone", ".hubsync")), "метка переехала");
  });

  await test("Обратно: мысль с телефона доходит до ПК, ПК перечитывает данные", async () => {
    const t1 = await phone.js(async () => { window.__hubShell.state.add("ответ с телефона"); return Date.now(); });
    await phone.until(async t1 => {
      const s = await window.__hubShell.core.syncStatus();
      return s.lastSent?.at > t1 && s.lastSent.count > 0 && s.pending === 0;
    }, 30000, "телефон отправил", t1);
    await pc.js(async () => { window.dispatchEvent(new Event("focus")); return true; });
    await pc.until(async t1 => {
      const status = await window.__hubShell.core.syncStatus();
      return status.lastReceived?.at > t1 && window.__hubShell.state.items.some(i => i.text === "ответ с телефона");
    }, 40000, "ПК получил автоматически", t1);
  });

  await test("ПК: замок и вход", async () => {
    await pc.js(async () => { window.__hubShell.lockNow(); return true; });
    await pc.until(has, 5000, "экран входа", ".hub-lock");
    await pc.shot("t3-pc-lock.png");
    // мини-окно при запертом хабе: мысль запечатана ключом устройства и ждёт входа
    const r = await pc.js(async () => window.__TAURI__.core.invoke("quick_capture", { text: "секрет из мини-окна #тайна" }));
    assert(r.status === "sealed", JSON.stringify(r));
    const pend = readdirSync(join(pc.dataDir, "pending"));
    assert(pend.length === 1 && pend[0].endsWith(".bin"), String(pend));
    assert(!readFileSync(join(pc.dataDir, "pending", pend[0])).toString("latin1").includes("секрет"), "на диске не читается");
    await pc.js(async () => { document.querySelector(".shell-lock").click(); return true; });
    await pc.until(has, 3000, "поле пароля", ".hub-lock__form:not([hidden]) input");
    await pc.js(fill, ".hub-lock__form input", PW);
    await pc.js(async () => { document.querySelector(".hub-lock__form").requestSubmit(); return true; });
    await pc.until(has, 20000, "«Сегодня» после входа", "#screen-today:not([hidden])");
    await pc.until(async () => window.__hubShell.state.items.some(i => i.text === "секрет из мини-окна #тайна" && i.tags[0] === "тайна"), 5000, "мысль из мини-окна в корзине");
    assert(readdirSync(join(pc.dataDir, "pending")).length === 0, "файл мысли удалён");
    const r2 = await pc.js(async () => window.__TAURI__.core.invoke("quick_capture", { text: "открытая мысль" }));
    assert(r2.status === "saved" && r2.count >= 2, JSON.stringify(r2));
    await pc.until(async () => window.__hubShell.state.items.some(i => i.text === "открытая мысль"), 5000, "оболочка увидела мысль из мини-окна");
  });
  await test("ПК: установка приложения из папки — проверка, установка, карточка", async () => {
    const dir = join(root, "templates", "app");
    const p = await pc.js(async d => window.__hubShell.core.inspectPackage(d), dir);
    assert(p.kind === "app" && p.id === "notes-template" && p.errors.length === 0 && p.warnings.length === 0, JSON.stringify(p));
    await pc.js(async d => window.__hubShell.core.installPackage(d), dir);
    await pc.until(async () => (await window.__hubShell.core.apps()).some(a => a.id === "notes-template" && a.source === "installed"), 5000, "в списке приложений");
    await pc.js(async () => { window.__hubShell.openApp("notes-template"); return true; });
    await pc.until(async () => !!window.__hubShell.state.cards["notes-template"] || document.querySelector('[data-card="notes-template"]'), 15000, "приложение запустилось и прислало карточку").catch(async e => {
      await pc.shot("t-fail-install.png");
      console.log("    состояние:", await pc.js(async () => JSON.stringify({ view: document.documentElement.dataset.view, cards: Object.keys(window.__hubShell.state.cards), frames: [...document.querySelectorAll("iframe")].map(f => f.title + ":" + f.hidden), title: document.querySelector("#appbar-title").textContent })));
      throw e;
    });
    await pc.shot("t4-pc-installed.png");
  });

  await test("Телефон: установленное на ПК приложение приезжает синхронизацией", async () => {
    await pc.js(async () => { await window.__hubShell.core.syncNow(); return true; });
    await sleep(6000);
    await phone.js(async () => { await window.__hubShell.core.syncNow(); return true; });
    await phone.until(async () => (await window.__hubShell.core.apps()).some(a => a.id === "notes-template"), 40000, "приложение на телефоне");
  });

  await test("ПК: удаление приложения", async () => {
    await pc.js(async () => window.__hubShell.core.uninstallApp("notes-template", true));
    await pc.until(async () => !(await window.__hubShell.core.apps()).some(a => a.id === "notes-template"), 5000, "приложение удалено");
  });
} finally {
  await pc.stop(); await phone.stop();
}
console.log(`\n${passed} прошло, ${failed} упало`);
process.exit(failed ? 1 : 0);
