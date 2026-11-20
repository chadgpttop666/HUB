// Сквозные тесты оболочки в Chromium (без Tauri: ядро — заглушка из ui/js/core.js).
// Запуск: npm test   (нужен пакет playwright и Chromium: npx playwright install chromium)
// Снимки экранов — в tests/out/.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "tests", "out");
mkdirSync(out, { recursive: true });

const port = 5300 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, [join(root, "scripts", "dev-server.mjs")], { env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((res, rej) => {
  server.stdout.on("data", d => { if (String(d).includes("http://localhost")) res(); });
  server.on("exit", c => rej(new Error(`сервер упал: ${c}`)));
});
const URL0 = `http://localhost:${port}/`;

let failed = 0, passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${String(e && e.stack || e).split("\n").slice(0, 4).join("\n    ")}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "условие не выполнено"); }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || "не равно"}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 860 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
page.on("console", m => { if (m.type() === "error" && !/Content Security Policy|Failed to load resource|ERR_FAILED/.test(m.text())) errors.push(m.text()); });

const appFrame = () => page.frames().find(f => f !== page.mainFrame() && f.url() === "about:srcdoc");
const text = sel => page.locator(sel).first().innerText();
const shot = name => page.screenshot({ path: join(out, `${name}.png`) });
const waitFor = async (fn, ms = 6000, what = "условие") => {
  const t0 = Date.now();
  for (;;) { try { if (await fn()) return; } catch { /* ещё нет */ } if (Date.now() - t0 > ms) throw new Error(`не дождались: ${what}`); await page.waitForTimeout(100); }
};

console.log("Хаб — сквозные тесты");
await page.goto(URL0);
await page.evaluate(() => localStorage.clear());
await page.reload();

await test("«Сегодня» открывается, курсор в строке ввода", async () => {
  await page.waitForSelector("#screen-today:not([hidden])");
  await waitFor(() => page.evaluate(() => document.activeElement && document.activeElement.matches("#capture-main .hub-capture__input")), 3000, "фокус в строке ввода");
  eq((await text('[data-card="inbox"] .hub-card__main')).trim(), "Пусто", "карточка корзины");
});

await test("«Повторение» само присылает карточку на «Сегодня»", async () => {
  await waitFor(async () => (await text('[data-card="repetition"] .hub-card__main')).trim() === "База пуста", 8000, "карточка повторения");
});

await test("мысль в корзину: Enter, метка, Ctrl+Z отменяет", async () => {
  await page.keyboard.type("Проверка отмены");
  await page.keyboard.press("Enter");
  await waitFor(async () => (await text('[data-card="inbox"] .hub-card__main')).includes("1 неразобранная"));
  assert((await text("#capture-main .hub-capture__note")).includes("В корзине — 1 неразобранная"), "подсказка после добавления");
  await page.keyboard.press("Control+z");
  await waitFor(async () => (await text('[data-card="inbox"] .hub-card__main')).trim() === "Пусто", 3000, "отмена");
  for (const t of ["Категорический императив Канта #этика", "Позвонить в деканат", "Мысль, которую удалю"]) {
    await page.keyboard.type(t); await page.keyboard.press("Enter");
  }
  await waitFor(async () => (await text('[data-card="inbox"] .hub-card__main')).includes("3 неразобранные"));
  const tags = await page.evaluate(() => window.__hubShell.state.items[0].tags);
  eq(tags, ["этика"], "метка из #слова");
  await shot("01-today");
});

await test("разбор: удалить и отменить, отложить из меню, перенести цифрой", async () => {
  await page.click('[data-card-action="inbox"]');
  await page.waitForSelector("#screen-triage:not([hidden])");
  assert((await text(".hub-meter__head b")).includes("1 из 3"), "счётчик");
  await shot("02-triage");
  // третий элемент — удалить, отменить, удалить снова
  await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
  assert((await text(".hub-triage__text")).includes("удалю"), "листание стрелкой");
  await page.keyboard.press("Delete");
  await waitFor(async () => (await text(".hub-meter__head b")).includes("из 2"));
  await page.click(".hub-toast__action");
  await waitFor(async () => (await page.evaluate(() => window.__hubShell.state.items.length)) === 3, 3000, "отмена удаления");
  await page.evaluate(() => { const s = window.__hubShell; s.go("triage"); });
  // второй — отложить: S, меню, Enter
  await page.keyboard.press("ArrowRight");
  assert((await text(".hub-triage__text")).includes("деканат"), "второй элемент");
  await page.keyboard.press("s");
  await page.waitForSelector("#snooze-menu");
  await page.waitForTimeout(400);
  await shot("03-snooze-menu");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await waitFor(async () => (await page.evaluate(() => window.__hubShell.state.visibleItems().length)) === 2, 3000, "отложено");
  const snoozed = await page.evaluate(() => window.__hubShell.state.items.find(i => i.snoozeUntil));
  assert(snoozed && snoozed.text.includes("деканат"), "отложен нужный элемент");
  assert(new Date(snoozed.snoozeUntil).getHours() === 9, "завтра утром — 9:00");
  // первый — перенести в «Повторение» цифрой 1
  await page.evaluate(() => window.__hubShell.go("triage"));
  assert((await text(".hub-triage__text")).includes("Канта"), "первый элемент");
  await page.keyboard.press("1");
  await waitFor(async () => (await page.evaluate(() => window.__hubShell.state.deliveries.length)) === 1, 3000, "доставка создана");
  await page.locator(".hub-toast", { hasText: "Перенесено в «Повторение»" }).waitFor({ timeout: 2000 });
});

await test("приложение забирает элемент после окна «Отменить» и делает из него запись", async () => {
  await waitFor(async () => (await page.evaluate(() => window.__hubShell.state.deliveries.length)) === 0, 9000, "доставка забрана");
  const titles = await appFrame().evaluate(() => JSON.parse(localStorage.getItem("tb-records")).map(r => r.title));
  eq(titles, ["Категорический императив Канта"], "запись в базе повторения (метка вырезана)");
  await waitFor(async () => (await page.evaluate(() => (window.__hubShell.state.cards.repetition || {}).main)) === "Нет вопросов к повторению", 4000, "карточка обновилась");
});

await test("пустая корзина: итог разбора и Esc на «Сегодня»", async () => {
  await page.evaluate(() => window.__hubShell.go("triage"));
  await page.keyboard.press("Delete");
  await page.waitForSelector(".hub-empty");
  assert((await text(".hub-empty__text")).includes("Отложенные вернутся сами"), "про отложенные");
  await shot("04-triage-empty");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#screen-today:not([hidden])");
});

await test("отложенное возвращается в корзину, когда срок прошёл", async () => {
  await page.evaluate(() => { const s = window.__hubShell.state; s.items[0].snoozeUntil = new Date(Date.now() - 1000).toISOString(); s.changed("inbox"); });
  await waitFor(async () => (await text('[data-card="inbox"] .hub-card__main')).includes("1 неразобранная"));
});

await test("Alt+1 открывает «Повторение» в оболочке, Ctrl+Пробел из приложения — к строке ввода", async () => {
  await page.keyboard.press("Alt+1");
  await page.waitForSelector("#screen-shell:not([hidden])");
  await page.waitForSelector('.hub-rail__item[aria-current="page"][data-open="repetition"]');
  await page.waitForTimeout(400);
  await appFrame().locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("Control+Space");
  await waitFor(() => page.evaluate(() => document.activeElement && document.activeElement.matches("#capture-compact .hub-capture__input")), 3000, "фокус в строке ввода оболочки");
  await shot("05-app");
});

await test("песочница: нет доступа к хабу и сети, localStorage подменён", async () => {
  const r = await appFrame().evaluate(async () => {
    let parentAccess; try { parentAccess = typeof parent.document; } catch { parentAccess = "blocked"; }
    let net; try { await fetch("https://example.com/"); net = "open"; } catch { net = "blocked"; }
    return { parentAccess, net, origin: self.origin, shim: !(localStorage instanceof Storage), tauri: typeof window.__TAURI__ };
  });
  eq(r, { parentAccess: "blocked", net: "blocked", origin: "null", shim: true, tauri: "undefined" }, "изоляция");
});

await test("Hub API: JSON, Blob и indexedDB-подмена", async () => {
  const r = await appFrame().evaluate(async () => {
    await hub.data.set("t/json", { a: [1, "ё"] });
    const json = await hub.data.get("t/json");
    await hub.data.set("t/blob", new Blob(["байты"], { type: "text/plain" }));
    const blob = await (await hub.data.get("t/blob")).text();
    const keys = await hub.data.keys("t/");
    const idb = await new Promise(res => {
      const q = indexedDB.open("t", 1);
      q.onupgradeneeded = () => q.result.createObjectStore("s", { keyPath: "id" });
      q.onsuccess = () => {
        const tx = q.result.transaction("s", "readwrite");
        tx.objectStore("s").put({ id: 2, f: new Blob(["x"]) }); tx.objectStore("s").put({ id: "a", v: 1 });
        tx.oncomplete = () => { const g = q.result.transaction("s").objectStore("s").getAll(); g.onsuccess = () => res(g.result.map(x => x.id)); };
      };
    });
    await hub.data.remove("t/json"); await hub.data.remove("t/blob");
    return { json, blob, keys, idb, after: await hub.data.get("t/json") };
  });
  eq(r, { json: { a: [1, "ё"] }, blob: "байты", keys: ["t/blob", "t/json"], idb: [2, "a"] }, "Hub API");
});

await test("данные приложения переживают перезагрузку хаба", async () => {
  await page.reload();
  await page.waitForSelector("#screen-today:not([hidden])");
  await page.keyboard.press("Alt+1");
  await waitFor(async () => appFrame() && (await appFrame().evaluate(() => JSON.parse(localStorage.getItem("tb-records") || "[]").length)) === 1, 6000, "запись на месте");
});

await test("«Повторение»: экспорт (скачивание из песочницы) и импорт файла обратно", async () => {
  const fr = appFrame();
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 5000 }), fr.click("#btn-export")]);
  const file = join(out, dl.suggestedFilename());
  await dl.saveAs(file);
  assert(/^theory-backup-.*\.zip$/.test(dl.suggestedFilename()), `имя архива: ${dl.suggestedFilename()}`);
  await fr.evaluate(() => { db.records = []; saveDB(); render(); });
  await fr.setInputFiles("#file-import", file);
  await fr.locator("#modal-btns button", { hasText: "Заменить оба" }).click();
  await waitFor(async () => (await fr.evaluate(() => JSON.parse(localStorage.getItem("tb-records")).length)) === 1, 4000, "запись вернулась из архива");
});

await test("тема: «Туман» перекрашивает хаб и приложение", async () => {
  await page.click('#rail [data-go="settings"]');
  await page.waitForSelector("#settings:not([hidden]) .hub-themes");
  await page.waitForTimeout(300);
  await shot("06-settings");
  await page.click('[data-theme-id="mist"]');
  await waitFor(() => page.evaluate(() => document.documentElement.dataset.theme === "light"), 2000, "тема хаба");
  await waitFor(async () => (await appFrame().evaluate(() => document.documentElement.dataset.theme)) === "light", 3000, "тема приложения");
  await page.keyboard.press("Alt+1");
  await page.waitForTimeout(300);
  await shot("07-app-mist");
  await page.click('#rail [data-go="today"]');
  await shot("08-today-mist");
  await page.evaluate(() => window.__hubShell.state.setSetting("theme", "forest"));
});

await test("без ошибок в консоли", async () => { eq(errors, [], "ошибки страницы"); });

await browser.close();
server.kill();
console.log(`\n${passed} прошло, ${failed} упало`);
process.exit(failed ? 1 : 0);
