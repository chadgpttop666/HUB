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
const context = await browser.newContext({ viewport: { width: 1366, height: 860 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", e => { errors.push(e.message); if (process.env.HUB_TEST_DEBUG) console.log("    [ошибка]", e.stack); });
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
await page.evaluate(() => {
  localStorage.clear();
  // корзина этапа 1 — одним списком; хаб должен разложить её по ключам
  localStorage.setItem("hubdev:hub:inbox", JSON.stringify([{ id: "old1", text: "Мысль этапа 1", created: new Date().toISOString(), device: "pc", tags: [] }]));
});
await page.reload();
const PASSWORD = "лес на рассвете";

await test("первая настройка: имя, пароль дважды, ключ восстановления, Drive — позже", async () => {
  await page.waitForSelector("#screen-lock .shell-setup");
  await shot("00-setup-choice");
  await page.click('[data-choose="new"]');
  await page.fill("#su-name", "Тест");
  await page.keyboard.press("Enter");
  await page.fill("#su-p1", PASSWORD);
  await page.fill("#su-p2", "не тот");
  assert((await text("#su-hint")).includes("не совпадают"), "несовпадение видно сразу");
  assert(await page.locator('.shell-setup [type="submit"]').isDisabled(), "«Дальше» недоступна");
  await page.fill("#su-p2", PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".hub-key");
  eq((await page.locator(".hub-key span").count()), 8, "ключ — 8 групп");
  await shot("00-setup-key");
  assert(await page.locator('.shell-setup [type="submit"]').isDisabled(), "без отметки дальше нельзя");
  await page.check("#su-saved");
  await page.click('.shell-setup [type="submit"]');
  await page.waitForSelector('[data-step="skip"]');
  await page.click('[data-step="skip"]');
  await page.waitForSelector("#screen-today:not([hidden])");
  assert((await text("#today-hello")).includes("Тест"), "приветствие по имени");
});

await test("корзина этапа 1 перенесена по ключам", async () => {
  await waitFor(async () => (await text('[data-card="inbox"] .hub-card__main')).includes("1 неразобранная"), 4000, "старая мысль на месте");
  const keys = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("hubdev:hub:inbox")));
  eq(keys, ["hubdev:hub:inbox/old1"], "ключи корзины");
  await page.evaluate(() => { const s = window.__hubShell.state; s.take("old1"); });
});

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
  eq((await text("#titlebar-place")).trim(), "· Повторение", "заголовок окна");
  await appFrame().evaluate(() => { window.__keptOnSwitch = true; });
  await page.evaluate(() => window.__hubShell.openApp("calendar"));
  assert(await page.locator('iframe[data-app="repetition"]').isHidden(), "фрейм скрыт при переключении");
  await page.evaluate(() => window.__hubShell.go("today"));
  await page.keyboard.press("Alt+1");
  const repetition = await (await page.locator('iframe[data-app="repetition"]').elementHandle()).contentFrame();
  assert(await repetition.evaluate(() => window.__keptOnSwitch), "страница приложения сохранила состояние");
  assert(await page.locator(".hub-rail").isHidden(), "боковая панель по умолчанию спрятана");
  assert(await page.locator(".hub-shell__top").isHidden(), "строка ввода по умолчанию спрятана");
  await page.click('[data-panel="rail"]');
  await page.waitForSelector('.hub-rail__item[aria-current="page"][data-open="repetition"]');
  await page.click('[data-panel="rail"]');
  assert(await page.locator(".hub-rail").isHidden(), "панель снова спрятана");
  await page.waitForTimeout(400);
  await appFrame().locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("Control+Space");
  await waitFor(() => page.evaluate(() => document.activeElement && document.activeElement.matches("#capture-compact .hub-capture__input")), 3000, "фокус в строке ввода оболочки");
  assert(await page.locator(".hub-shell__top").isVisible(), "спрятанная строка ввода показалась на время ввода");
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

await test("перезапуск: экран входа, неверный пароль, вход", async () => {
  await page.reload();
  await page.waitForSelector(".hub-lock");
  assert(await page.locator(".hub-lock__form").isHidden(), "заставка без поля");
  await shot("09-lock");
  await page.keyboard.press("x");
  await page.waitForSelector(".hub-lock__form:not([hidden])");
  eq(await page.inputValue(".hub-lock__form input"), "x", "первый символ уже в поле");
  await page.keyboard.type("yz"); await page.keyboard.press("Enter");
  await page.waitForSelector(".hub-lock__msg[data-tone=danger]");
  assert((await text(".hub-lock__msg")).includes("английская раскладка"), "подсказка про раскладку");
  await shot("10-lock-wrong");
  await page.fill(".hub-lock__form input", PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForSelector("#screen-today:not([hidden])");
});

await test("данные приложения переживают перезагрузку хаба", async () => {
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
  await page.evaluate(() => window.__hubShell.go("settings"));
  await page.waitForSelector("#settings:not([hidden]) .hub-themes");
  await page.waitForTimeout(300);
  await shot("06-settings");
  await page.click('[data-theme-id="mist"]');
  await waitFor(() => page.evaluate(() => document.documentElement.dataset.theme === "light"), 2000, "тема хаба");
  await waitFor(async () => (await appFrame().evaluate(() => document.documentElement.dataset.theme)) === "light", 3000, "тема приложения");
  await page.keyboard.press("Alt+1");
  await page.waitForTimeout(300);
  await shot("07-app-mist");
  await page.evaluate(() => window.__hubShell.go("today"));
  await shot("08-today-mist");
  await page.evaluate(() => window.__hubShell.state.setSetting("theme", "forest"));
});

await test("Ctrl+L запирает: приложения закрыты, данные недоступны; вход ключом восстановления", async () => {
  await page.keyboard.press("Alt+1");
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+l");
  await page.waitForSelector(".hub-lock");
  eq(page.frames().length, 1, "песочниц приложений не осталось");
  eq(await page.evaluate(() => window.__hubShell.state.items.length), 0, "корзина выгружена из памяти");
  await page.keyboard.press("Enter");
  await page.fill(".hub-lock__form input", "неверно"); await page.keyboard.press("Enter");
  await page.click("[data-act=recover]");
  await page.fill("#rc-code", "7kq2 m9xd r4tw hc8p 3vnj 6ybf q2ms w9ea");
  await page.fill("#rc-p1", "новый пароль хаба"); await page.fill("#rc-p2", "новый пароль хаба");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#screen-today:not([hidden])");
  await page.keyboard.press("Control+l");
  await page.waitForSelector(".hub-lock");
  await page.keyboard.press("Enter");
  await page.fill(".hub-lock__form input", "новый пароль хаба"); await page.keyboard.press("Enter");
  await page.waitForSelector("#screen-today:not([hidden])");
});

await test("телефон 390×844: нижняя панель, «Приложения», приложение с «назад»", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__hubShell.go("today"));
  await page.waitForSelector("#navbar .hub-navbar__item[aria-current=page]");
  await page.waitForSelector(".hub-capture--phone", { state: "visible", timeout: 3000 });
  await page.evaluate(() => window.__hubShell.state.add("мысль с телефона"));
  await page.waitForTimeout(300);
  await shot("11-phone-today");
  await page.click('#navbar [data-go="apps"]');
  await page.waitForSelector("#screen-apps:not([hidden]) .shell-app-tile");
  await shot("12-phone-apps");
  await page.click(".shell-app-tile");
  await page.waitForSelector("#screen-shell:not([hidden])");
  assert(await page.locator("#navbar").isHidden(), "в приложении панель прячется");
  eq((await text("#appbar-title")).trim(), "Повторение", "заголовок приложения");
  await page.waitForTimeout(400);
  await shot("13-phone-app");
  await page.goBack();
  await page.waitForSelector("#screen-apps:not([hidden])");
  await page.click('#navbar [data-go="triage"]');
  await page.waitForSelector(".hub-triage__item");
  await shot("14-phone-triage");
  await page.click('[data-tri="snooze"]');
  await page.waitForTimeout(300);
  await shot("15-phone-snooze");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1366, height: 860 });
});

await test("календарь (написан по APP_SPEC.md): разбор даты, приём из корзины, карточка", async () => {
  await page.evaluate(() => window.__hubShell.openApp("calendar"));
  await page.waitForTimeout(500);
  const fr = page.frames().filter(f => f.url() === "about:srcdoc");
  let calFrame = null;
  for (const f of fr) if (await f.evaluate(() => !!window.__calendar).catch(() => false)) calFrame = f;
  assert(calFrame, "календарь открыт");
  const base = "2026-11-20T12:00:00";
  const parsed = await calFrame.evaluate(b => [
    "завтра в 16:00 консультация", "25 ноября доклад", "купить 5 яблок", "в пятницу встреча в 9", "12.01 экзамен #учёба", "сегодня в 18.30 ужин",
  ].map(t => window.__calendar.parseText(t, new Date(b))), base);
  eq(parsed, [
    { title: "Консультация", date: "2026-11-21", time: "16:00" },
    { title: "Доклад", date: "2026-11-25", time: "" },
    { title: "Купить 5 яблок", date: null, time: "" },
    { title: "Встреча", date: "2026-11-27", time: "09:00" },
    { title: "Экзамен", date: "2027-01-12", time: "" },
    { title: "Ужин", date: "2026-11-20", time: "18:30" },
  ], "разбор дат");
  // из корзины: «завтра в 16:00 консультация» → цифра календаря в разборе
  await page.evaluate(() => window.__hubShell.state.add("завтра в 16:00 консультация"));
  await page.evaluate(() => window.__hubShell.go("triage"));
  await page.waitForSelector(".hub-target");
  const targets = await page.locator(".hub-target__name").allInnerTexts();
  const n = targets.indexOf("Календарь") + 1;
  assert(n > 0, `плитка календаря есть: ${targets}`);
  while (!(await text(".hub-triage__text")).includes("консультация")) await page.keyboard.press("ArrowRight");
  await page.keyboard.press(String(n));
  await waitFor(() => calFrame.evaluate(() => [...document.querySelectorAll("#day-list .hub-row__title, #undated .hub-row__title")].some(e => e.textContent === "Консультация")), 9000, "событие в календаре");
  await waitFor(async () => /завтра — консультация в 16:00/.test((await page.evaluate(() => (window.__hubShell.state.cards.calendar || {}).note)) || ""), 4000, "карточка календаря");
  await page.evaluate(() => window.__hubShell.openApp("calendar"));
  await page.waitForTimeout(400);
  await shot("18-calendar");
});

await test("расписание: предпросмотр ответа ИИ, шкала времени, мобильная лента и отмена импорта", async () => {
  await page.evaluate(() => window.__hubShell.openApp("calendar"));
  const cal = page.frameLocator("iframe[data-app=calendar]");
  const date = await cal.locator("#day-picker button[aria-pressed=true]").getAttribute("data-date");
  await cal.getByRole("button", { name: "Импорт", exact: true }).click();
  await cal.locator("#import-context summary").click();
  await cal.locator("#import-context-list label").filter({ hasText: "Консультация" }).locator("input").check();
  await cal.getByRole("button", { name: "Скопировать промпт" }).click();
  assert((await cal.locator("#prompt-text").inputValue()).includes("Консультация"), "в запросе есть выбранное событие из Корзины");
  const timeZone = await cal.locator("#import-zone").innerText().then(s => s.split(" · ")[1]);
  const first = { title: "Новый семинар", date, time: "09:00", endTime: "12:00", category: "study", reminder: { kind: "normal", minutes: 30 } };
  const second = { title: "Сдать отчёт", date, time: "10:30", endTime: "11:00", reminder: { kind: "alarm", minutes: 5 } };
  const answer = { version: 1, timeZone, events: [first, second, first, { title: "Уточнить дату", time: "11:00" }] };
  await cal.locator("#import-text").fill(JSON.stringify(answer));
  await cal.getByRole("button", { name: "Предпросмотр" }).click();
  eq(await cal.locator("#import-results input:disabled").count(), 2, "дубль и событие без даты исключены");
  assert((await cal.locator("#import-results").innerText()).includes("Пересечение по времени"), "предпросмотр предупреждает о пересечении");
  await cal.getByRole("button", { name: "Добавить выбранное" }).click();
  await cal.getByText(/Сохранено: 2/).waitFor();
  await cal.getByRole("button", { name: "Закрыть", exact: true }).click();
  await cal.locator("#week-view:not([hidden])").waitFor();
  const firstBlock = cal.locator(".week-event").filter({ hasText: "Новый семинар" });
  const secondBlock = cal.locator(".week-event").filter({ hasText: "Сдать отчёт" });
  const [a, b] = await Promise.all([firstBlock.boundingBox(), secondBlock.boundingBox()]);
  eq(Math.round(a.height / b.height), 6, "длина карточки совпадает с длительностью события");
  assert(b.x > a.x && b.y > a.y, "пересекающиеся события стоят рядом в нужных часах");
  await shot("18a-calendar-week");

  await page.setViewportSize({ width: 390, height: 844 });
  try {
    await cal.locator("#day-view:not([hidden])").waitFor();
    assert((await cal.locator("#day-list").innerText()).includes("Будильник"), "в ленте отмечен будильник");
    await shot("18b-calendar-day");
    await cal.getByRole("button", { name: "Импорт", exact: true }).click();
    await cal.getByRole("button", { name: "Отменить последний импорт" }).click();
    await cal.getByText(/Отменено: 2/).waitFor();
    await cal.getByRole("button", { name: "Закрыть", exact: true }).click();
    assert(!(await cal.locator("#day-list").innerText()).includes("Новый семинар"), "добавленные события удалены");
    assert((await cal.locator("#day-list").innerText()).includes("Консультация"), "прежнее событие сохранено");
  } finally { await page.setViewportSize({ width: 1366, height: 860 }); }
});

await test("своя тема из фото: основа и вуаль считаются, тема применяется и удаляется", async () => {
  await page.evaluate(() => window.__hubShell.go("settings"));
  await page.click('[data-act="theme-new"]');
  await page.setInputFiles("#te-file", join(root, "design-system", "themes", "mist", "photo.jpg"));
  await page.waitForSelector("#te-remove-photo");
  const hint = await text("dialog .hub-hint");
  assert(/основа: светлая/.test(hint), `светлое фото — светлая основа: ${hint}`);
  await page.fill("#te-name", "Мой туман");
  await page.click('[data-accent="sea"]');
  await page.waitForTimeout(200);
  await shot("16-theme-editor");
  await page.click("#te-save");
  await waitFor(() => page.evaluate(() => window.__hubShell.state.themes.length === 1 && window.__hubShell.state.settings.theme === window.__hubShell.state.themes[0].id), 4000, "тема сохранена и выбрана");
  const r = await page.evaluate(() => ({ base: document.documentElement.dataset.theme, photo: document.documentElement.style.getPropertyValue("--hub-photo"), accent: document.documentElement.style.getPropertyValue("--accent") }));
  eq([r.base, r.photo.startsWith("url('blob:"), r.accent], ["light", true, "#1d5f8a"], "тема применена");
  eq(await appFrame().evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()), "#1d5f8a", "акцент дошёл до приложения");
  await page.waitForTimeout(300);
  await shot("17-custom-theme");
  // правка своей темы: приветствие с именем и шрифт; фото остаётся прежним
  await page.click("[data-theme-edit]");
  await page.waitForSelector("#te-save:not([disabled])");
  await page.fill("#te-greet", "Привет, {name}");
  await page.selectOption("#te-font", "manrope");
  await page.click("#te-save");
  await waitFor(() => page.evaluate(() => window.__hubShell.state.themes[0].greeting === "Привет, {name}"), 4000, "правка сохранена");
  eq(await page.evaluate(() => window.__hubShell.state.themes.length), 1, "правка не создаёт новую тему");
  eq(await page.evaluate(() => document.documentElement.style.getPropertyValue("--font-heading")), "var(--font-body)", "шрифт крупного текста");
  await page.evaluate(() => window.__hubShell.go("today"));
  eq(await text("#today-hello"), "Привет, Тест", "приветствие темы с именем");
  eq(await page.evaluate(() => localStorage.getItem("hub:greeting")), "Привет, {name}", "приветствие — и для экрана входа");
  await page.evaluate(() => window.__hubShell.go("settings"));
  await page.click("[data-theme-remove]");
  await waitFor(() => page.evaluate(() => window.__hubShell.state.themes.length === 0 && window.__hubShell.state.settings.theme === "forest"), 4000, "тема удалена");
});

await test("имя в настройках и порядок приложений: ↑↓ меняют Alt+1…9", async () => {
  await page.evaluate(() => window.__hubShell.go("settings"));
  await page.fill("#set-name", "Аня");
  await page.locator("#set-name").dispatchEvent("change");
  eq(await page.evaluate(() => window.__hubShell.state.settings.name), "Аня", "имя в общих настройках");
  eq(await page.evaluate(() => localStorage.getItem("hub:name")), "Аня", "копия для экрана входа");
  const before = await page.locator("#settings .hub-row__title").allInnerTexts();
  const cal = before.indexOf("Календарь");
  assert(cal > 0, `календарь не первый: ${before}`);
  for (let i = cal; i > 0; i--) await page.click('[data-app-move="calendar"][data-d="-1"]');
  eq((await page.locator("#settings .hub-row__title").allInnerTexts())[0], "Календарь", "календарь — первым");
  eq(await page.evaluate(() => [...document.querySelectorAll(".hub-rail__item[data-open]")].map(b => b.dataset.open)[0]), "calendar", "и в боковой панели");
  await page.keyboard.press("Alt+1");
  await waitFor(() => page.evaluate(() => document.querySelector("#appbar-title").textContent === "Календарь"), 4000, "Alt+1 — календарь");
  await page.evaluate(() => window.__hubShell.state.setSetting("appOrder", []));
  await page.evaluate(() => window.__hubShell.go("today"));
  assert((await text("#today-hello")).includes("Аня"), "приветствие с новым именем");
});

await test("Ctrl+K: приложение, раскладка, запись и «в корзину как мысль»", async () => {
  await page.evaluate(() => window.__hubShell.go("today"));
  await page.keyboard.press("Control+k");
  await page.waitForSelector("dialog.hub-command[open] #cmd-q");
  assert((await page.locator("#cmd-list .hub-menu__label").allInnerTexts()).some(t => /Команды/i.test(t)), "пустой запрос — команды");
  await page.keyboard.type("кален");
  eq(await text("#cmd-list .is-active"), "Календарь\nприложение", "первым — приложение");
  await page.keyboard.press("Enter");
  await waitFor(() => page.evaluate(() => document.documentElement.dataset.view === "app" && document.querySelector("#appbar-title").textContent === "Календарь" && !document.querySelector("dialog.hub-command")), 4000, "открыт календарь");
  await page.keyboard.press("Control+k");
  await page.waitForSelector("dialog.hub-command[open] #cmd-q");
  await page.keyboard.type("gjdnjhtybt");   // «повторение» в английской раскладке
  await page.waitForSelector('[data-cmd="alt"]');
  assert((await text('[data-cmd="alt"]')).includes("повторение"), "предложен исправленный запрос");
  await shot("19-command-layout");
  await page.keyboard.press("Enter");
  eq(await page.inputValue("#cmd-q"), "повторение", "запрос исправлен");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__hubShell.state.add("найти цитату Толстого о привычках #чтение"));
  await page.keyboard.press("Control+k");
  await page.waitForSelector("dialog.hub-command[open] #cmd-q");
  await page.keyboard.type("толст");
  assert((await page.locator("#cmd-list .hub-menu__label").allInnerTexts()).some(t => /Записи/i.test(t)), "нашлась запись из корзины");
  await shot("19-command-search");
  await page.keyboard.press("Enter");
  await waitFor(async () => (await page.evaluate(() => window.__hubShell && document.querySelector("#screen-triage:not([hidden]) .hub-triage__text")?.textContent || "")).includes("Толстого"), 4000, "открыта при разборе");
  await page.keyboard.press("Escape");
  const n0 = await page.evaluate(() => window.__hubShell.state.visibleItems().length);
  await page.keyboard.press("Control+k");
  await page.waitForSelector("dialog.hub-command[open] #cmd-q");
  await page.keyboard.type("купить батарейки");
  await page.keyboard.press("Control+Enter");
  await waitFor(() => page.evaluate(n => window.__hubShell.state.visibleItems().length === n + 1, n0), 3000, "мысль в корзине");
});

await test("мини-окно: мысль при запертом хабе попадает в корзину только после входа", async () => {
  const mini = await context.newPage();   // то же происхождение и localStorage, что у хаба
  await mini.setViewportSize({ width: 600, height: 132 });
  mini.on("pageerror", e => errors.push("мини: " + e.message));
  await mini.goto(URL0 + "mini.html");
  await mini.waitForSelector("#mini-input:focus");
  await mini.keyboard.type("позвонить в деканат #учёба");
  assert((await mini.locator("#mini-note").innerText()).includes("#учёба"), "метка видна в подсказке");
  await mini.screenshot({ path: join(out, "20-mini.png") });
  await mini.keyboard.press("Enter");
  await mini.waitForSelector("#mini-note.is-ok");
  assert((await mini.locator("#mini-note").innerText()).includes("после входа"), "заперто до входа");
  eq(await mini.inputValue("#mini-input"), "", "строка очищена");
  await mini.close();
  const has = () => page.evaluate(() => window.__hubShell.state.items.some(i => i.text.startsWith("позвонить в деканат")));
  assert(!(await has()), "до входа в корзине нет");
  await page.evaluate(() => { window.__hubShell.lockNow(); });   // вход ждёт пароля — не дожидаться
  await page.waitForSelector(".hub-lock");
  assert((await page.locator(".hub-lock").innerText()).includes("Аня"), "экран входа знает имя");
  await page.keyboard.press("x");
  await page.waitForSelector(".hub-lock__form:not([hidden])");
  await page.fill(".hub-lock__form input", "новый пароль хаба");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#screen-today:not([hidden])");
  assert(await has(), "после входа — в корзине");
  const item = await page.evaluate(() => window.__hubShell.state.items.find(i => i.text.startsWith("позвонить в деканат")));
  eq(item.tags, ["учёба"], "метка сохранилась");
});

await test("на «Сегодня» открывается вся карточка, а неизменившаяся карточка сохраняется", async () => {
  const card = page.locator('[data-card="repetition"]');
  assert(await card.evaluate(el => {
    window.__hubShell.state.changed("inbox");
    return el === document.querySelector('[data-card="repetition"]');
  }), "соседняя карточка не перерисовалась");
  await card.click({ position: { x: 60, y: 55 } });
  await page.waitForSelector('iframe[data-app="repetition"]:visible');
  await page.evaluate(() => window.__hubShell.go("today"));
  await page.locator('[data-card="inbox"]').click({ position: { x: 60, y: 55 } });
  await page.waitForSelector("#screen-triage:visible");
  await page.evaluate(() => window.__hubShell.go("today"));
});

await test("запросы для нейросети и APP_SPEC.md доступны из настроек", async () => {
  await page.evaluate(() => window.__hubShell.go("settings"));
  for (const [kind, name, expected] of [
    ["app", "Как создать приложение с нейросетью", "manifest.json"],
    ["theme", "Как создать тему с нейросетью", "theme.json"],
  ]) {
    await page.getByText(name, { exact: true }).click();
    await page.locator(`[data-act="ai-${kind}"]`).click();
    const prompt = page.getByRole("textbox", { name: "Текст запроса" });
    assert((await prompt.inputValue()).includes(expected), "в запросе есть формат пакета");
    await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  }
  const download = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Скачать APP_SPEC.md" }).click(),
  ]);
  eq(download[0].suggestedFilename(), "APP_SPEC.md", "спецификация скачивается из интерфейса");
});

await test("тему можно настроить и сохранить без фото", async () => {
  await page.click('[data-act="theme-new"]');
  await page.fill("#te-name", "Свой фон");
  await page.fill("#te-bg", "#222244");
  await page.fill("#te-color", "#d9bfff");
  await page.locator("#te-opacity").evaluate(el => {
    el.value = "75";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.click("#te-save");
  await waitFor(() => page.evaluate(() => window.__hubShell.state.themes[0]?.name === "Свой фон"), 4000, "тема сохранена");
  const values = await page.evaluate(() => ["bg", "accent", "surface"].map(k => document.documentElement.style.getPropertyValue("--" + k)));
  eq(values, ["#222244", "#d9bfff", "rgba(14,22,18,0.75)"], "настройки темы применены");
});

await test("системное перетаскивание направляет заметку в «Повторение», ZIP-пакет — в установщик", async () => {
  const native = await browser.newPage();
  try {
    await native.addInitScript(() => {
      const events = {}, invoked = [];
      window.__dropTest = { events, invoked };
      window.__TAURI__ = {
        event: { listen: async (name, cb) => { events[name] = cb; } },
        core: {
          convertFileSrc: () => location.origin + "/hubapp/",
          invoke: async (command, args) => {
            invoked.push(command);
            if (command === "hub_status") return { setupDone: true, unlocked: true, platform: "pc" };
            if (command === "sync_status") return { state: "off" };
            if (command === "data_dump") return { json: {}, blobs: {} };
            if (command === "apps_list") return [{ id: "repetition", source: "builtin", manifest: { name: "Повторение" } }];
            if (command === "dropped_package") return args.path.endsWith("theme.zip");
            if (command === "read_dropped_file") return new TextEncoder().encode("# Теория из файла\nКонспект");
            if (command === "package_inspect") return { kind: "theme", name: "Новая тема", errors: [], warnings: [] };
          },
        },
      };
    });
    await native.goto(URL0);
    await native.waitForSelector("#screen-today:visible");
    await native.locator('[data-card="repetition"]').click({ position: { x: 60, y: 55 } });
    await native.evaluate(() => {
      const frame = document.querySelector('iframe[data-app="repetition"]');
      const r = frame.getBoundingClientRect();
      const position = { x: (r.left + r.width / 2) * devicePixelRatio, y: (r.top + r.height / 2) * devicePixelRatio };
      window.__dropTest.position = position;
      const payload = { paths: ["C:/notes/theory.md"], position };
      window.__dropTest.events["tauri://drag-enter"]({ payload });
      window.__dropTest.events["tauri://drag-drop"]({ payload });
    });
    const text = await native.frameLocator('iframe[data-app="repetition"]').locator("#add-full").inputValue();
    assert(text.includes("Теория из файла"), "файл передан в «Готовые записи»");
    assert(!(await native.evaluate(() => window.__dropTest.invoked.includes("package_inspect"))), "заметка не открыла установщик");
    await native.evaluate(() => {
      const { events, position } = window.__dropTest;
      events["tauri://drag-drop"]({ payload: { paths: ["C:/Downloads/theme.zip"], position } });
    });
    await native.getByRole("heading", { name: "Новая тема", exact: true }).waitFor();
  } finally { await native.close(); }
});

await test("настройки открывают DevTools и проверяют обновления через ядро", async () => {
  const native = await browser.newPage();
  try {
    await native.addInitScript(() => {
      window.__updateCalls = [];
      window.__TAURI__ = {
        event: { listen: async () => {} },
        core: {
          invoke: async command => {
            window.__updateCalls.push(command);
            if (command === "hub_status") return { setupDone: true, unlocked: true, platform: "pc" };
            if (command === "hub_info") return { updatesSupported: true, version: "0.1.3" };
            if (command === "sync_status") return { state: "off" };
            if (command === "data_dump") return { json: {}, blobs: {} };
            if (command === "apps_list") return [];
            if (command === "update_check") return { version: "0.1.10", size: 12 * 1048576 };
            if (command === "update_install") {
              if (window.__updateCalls.filter(c => c === command).length === 1) throw "Проверка установщика не прошла";
              return "permission";
            }
          },
        },
      };
    });
    await native.goto(URL0);
    await native.waitForSelector("#screen-today:visible");
    await native.evaluate(() => window.__hubShell.go("settings"));
    await native.getByRole("button", { name: "Открыть DevTools" }).click();
    assert(await native.evaluate(() => window.__updateCalls.includes("open_devtools")), "открытие DevTools передано ядру");
    await native.getByRole("button", { name: "Проверить обновления" }).click();
    const install = native.getByRole("button", { name: "Установить 0.1.10" });
    await install.click();
    await native.getByText("Проверка установщика не прошла").waitFor();
    assert(await install.isEnabled(), "после ошибки обновление можно повторить");
    await install.click();
    await native.getByText("Разрешите Хабу устанавливать приложения", { exact: false }).waitFor();
  } finally { await native.close(); }
});

await test("окно 540×360 сохраняет кнопки Windows и обновляет Хаб одним нажатием", async () => {
  const native = await browser.newPage({ viewport: { width: 540, height: 360 } });
  try {
    await native.addInitScript(() => {
      window.__updates = [];
      window.__TAURI__ = {
        window: {},
        event: { listen: async () => {} },
        core: { invoke: async command => {
          if (command === "hub_status") return { setupDone: true, unlocked: false, platform: "pc" };
          if (command === "hub_info") return { version: "0.1.8", updatesSupported: true, updateMode: "windows" };
          if (command === "data_dump") return { json: { settings: { name: "Тест" } }, blobs: {} };
          if (command === "apps_list") return [];
          if (command === "sync_status") return { configured: false };
          if (command === "update_check" || command === "update_install") {
            window.__updates.push(command);
            return command === "update_check" ? { version: "0.1.9", size: 1048576 } : "started";
          }
        } },
      };
    });
    await native.goto(URL0);
    await native.locator(".hub-lock").waitFor();
    await native.keyboard.press("Enter");
    const password = native.getByLabel("Пароль", { exact: true });
    await password.waitFor();
    const bounds = await password.boundingBox();
    assert(bounds.y > 36 && bounds.y + bounds.height < 360, "поле пароля помещается в начальном окне");
    assert(await native.getByRole("button", { name: "Развернуть" }).isVisible(), "доступно разворачивание");
    await password.fill("пароль хаба");
    await password.press("Enter");
    await native.locator('#navbar [data-go="settings"]').click();
    await native.getByRole("button", { name: "Обновить Хаб" }).click();
    await native.getByText("Устанавливаем обновление. Хаб откроется снова.", { exact: true }).waitFor();
    eq(await native.evaluate(() => window.__updates), ["update_check", "update_install"], "одно нажатие проверяет версию и запускает обновление");
  } finally { await native.close(); }
});

await test("настройки Android видны при скрытых панелях ПК, показывают причину ошибки и открывают сохранённую пару после пароля", async () => {
  const native = await browser.newPage({
    viewport: { width: 390, height: 740 }, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36",
  });
  try {
    await native.addInitScript(() => {
      const events = {};
      const folder = { id: "notes", name: "Заметки", path: "/storage/emulated/0/Documents/Notes", started: true, mode: "two-way" };
      const status = { configured: true, kind: "drive", state: "error", message: "Доступ к Google Drive отозван", folders: [folder] };
      window.__syncTest = {
        checks: 0, copied: [], colors: [],
        status: update => events["hub://sync"]({ payload: { ...status, ...update } }),
      };
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async value => window.__syncTest.copied.push(value) } });
      window.__TAURI__ = {
        event: { listen: async (name, listener) => { events[name] = listener; } },
        core: {
          invoke: async (command, args) => {
            if (command === "hub_status") return { setupDone: true, unlocked: true, platform: "phone" };
            if (command === "hub_info") return { version: "0.1.8" };
            if (command === "set_system_bar_color") window.__syncTest.colors.push(args.color);
            if (command === "sync_status") return status;
            if (command === "data_dump") return { json: { settings: { name: "Тест" }, "sync-folders/notes": folder }, blobs: {} };
            if (command === "apps_list") return [];
            if (command === "sync_saved_drive_client") {
              window.__syncTest.checks++;
              if (args.password !== "пароль хаба") throw "Неверный пароль";
              return { clientId: "saved-google-client", clientSecret: "fake-client-secret" };
            }
          },
        },
      };
    });
    await native.goto(URL0);
    const tab = native.locator('#navbar [data-go="settings"]');
    await tab.click();
    await native.locator("#set-name").waitFor();
    eq(await native.getByRole("heading", { name: "Клавиши", exact: true }).count(), 0, "раздел клавиш скрыт на Android");
    const checkLayout = () => native.evaluate(() => {
      const rect = id => document.getElementById(id).getBoundingClientRect();
      const root = document.documentElement;
      return root.dataset.top === "off" && rect("appbar").top === 0 && rect("appbar").height < 100
        && rect("settings").height > 150 && rect("settings").bottom <= rect("navbar").top
        && rect("navbar").bottom === innerHeight;
    });
    assert(await checkLayout(), "настройки занимают область между шапкой и нижней панелью");
    await native.evaluate(() => window.__hubShell.state.setSetting("theme", "mist"));
    await native.waitForFunction(() => window.__syncTest.colors.at(-1) === "#ece8e0");
    await native.setViewportSize({ width: 740, height: 342 });
    assert(await checkLayout(), "в альбомной ориентации у Android остаётся мобильная раскладка");
    await native.setViewportSize({ width: 390, height: 740 });
    await native.locator("#appbar-sync").getByText("Ошибка синхр.").click();
    const state = native.locator("#sync-state");
    assert((await state.innerText()).includes("Доступ к Google Drive отозван"), "показана причина из ядра");
    await native.evaluate(() => window.__syncTest.status({
      state: "running", phase: "send", pending: 2, lastReceived: { at: Date.now(), count: 1 },
    }));
    assert((await state.innerText()).includes("Отправка местных изменений"), "виден текущий этап");
    eq(await native.locator("#sync-pending").innerText(), "2 изменения", "видна очередь");
    assert((await native.locator("#sync-received").innerText()).includes("1 изменение"), "видна последняя загрузка");
    await native.evaluate(() => window.__syncTest.status({
      state: "error", phase: "send", pending: 2, problem: { code: "timeout", message: "Drive не ответил вовремя" }, retryAt: Date.now() + 60000,
    }));
    assert((await state.innerText()).includes("Drive не ответил вовремя. Автоповтор после"), "видна причина и время повтора");
    await native.evaluate(() => window.__syncTest.status({ state: "idle", message: "" }));
    assert((await state.innerText()).includes("Ожидает первой синхронизации"), "без успешной попытки статус показывает ожидание");
    await native.evaluate(() => window.__syncTest.status({
      state: "idle", message: "", lastSync: Date.now(),
      folders: [{ id: "notes", name: "Заметки", path: "/storage/emulated/0/Documents/Notes", started: true, problem: { kind: "error", message: "Папка недоступна" } }],
    }));
    await native.locator("#appbar-sync").getByText("Папки").click();
    await native.getByText("Папка недоступна", { exact: true }).waitFor();
    await native.getByRole("button", { name: "Показать ключи Google Drive" }).click();
    const dlg = native.getByRole("dialog", { name: "Сохранённые ключи Google Drive" });
    const field = dlg.locator("#saved-client-secret");
    const password = dlg.getByLabel("Пароль Хаба");
    assert(await field.isHidden(), "секрет скрыт до ввода пароля");
    eq(await native.evaluate(() => window.__syncTest.checks), 0, "ключи не запрашиваются при открытии");
    await password.fill("неправильный пароль");
    await password.press("Enter");
    await dlg.getByText("Неверный пароль").waitFor();
    eq(await field.inputValue(), "", "после ошибки ключа нет в поле");
    await password.fill("пароль хаба");
    await password.press("Enter");
    await field.waitFor();
    eq(await field.inputValue(), "fake-client-secret", "используется сохранённый Client Secret");
    await dlg.getByRole("button", { name: "Скопировать Client ID" }).click();
    await dlg.getByRole("button", { name: "Скопировать Client Secret" }).click();
    eq(await native.evaluate(() => window.__syncTest.copied), ["saved-google-client", "fake-client-secret"], "оба значения копируются отдельно");
    await dlg.getByRole("button", { name: "Закрыть" }).click();
    await field.waitFor({ state: "detached" });
  } finally { await native.close(); }
});

await test("большая база Повторения: повторный вход сохраняет DOM, а режим пишет только метаданные", async () => {
  const native = await browser.newPage();
  try {
    await native.addInitScript(() => {
      window.__repeatWrites = [];
      const records = Array.from({ length: 1000 }, (_, i) => ({
        id: `rec-${i}`, title: `Теория ${i}`, updated: "2026-11-20",
        topics: [`Тестовая тема номер ${i % 25}`],
        questions: i < 200 ? [{ id: "q", q: "Вопрос", a: "Ответ" }] : [],
      }));
      const seed = { "localstorage/tb-records": records, "localstorage/tb-meta": { version: 2, inboxMarked: true } };
      window.__TAURI__ = {
        event: { listen: async () => {} },
        core: {
          convertFileSrc: () => location.origin + "/hubapp/",
          invoke: async (command, args) => {
            if (command === "hub_status") return { setupDone: true, unlocked: true, platform: "pc" };
            if (command === "sync_status") return { state: "off" };
            if (command === "data_dump") return { json: args.ns === "repetition" ? seed : {}, blobs: {} };
            if (command === "apps_list") return [{
              id: "repetition", source: "builtin", manifest: { name: "Повторение", card: true },
            }];
            if (command === "data_set" && args.ns === "repetition" && args.key.startsWith("localstorage/")) {
              window.__repeatWrites.push(args.key);
            }
          },
        },
      };
    });
    await native.goto(URL0);
    const card = native.locator('[data-card="repetition"]');
    await card.getByRole("button", { name: "Начать — Повторение" }).waitFor();
    const frame = await (await native.locator('iframe[data-app="repetition"]').elementHandle()).contentFrame();
    await frame.locator("#section-rep [data-mode=topics]").waitFor({ state: "attached" });
    await frame.evaluate(() => { window.__sameRepeatNode = document.querySelector("#section-rep").firstElementChild; });
    await card.getByRole("button", { name: "Начать — Повторение" }).click();
    await waitFor(() => frame.evaluate(() => hub.visible), 5000, "приложение показано");
    await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert(await frame.evaluate(() => window.__sameRepeatNode === document.querySelector("#section-rep").firstElementChild),
      "действие карточки не построило ту же вкладку второй раз");

    await frame.locator("[data-mode=questions]").click();
    await waitFor(() => native.evaluate(() => window.__repeatWrites.includes("localstorage/tb-meta")), 5000, "метаданные сохранены");
    eq(await native.evaluate(() => window.__repeatWrites), ["localstorage/tb-meta"], "смена режима пишет один ключ");
    eq(await frame.evaluate(() => JSON.parse(localStorage.getItem("tb-meta")).settings.mode), "questions", "режим записан в метаданные");

    await frame.locator("#tab-base").click();
    await frame.locator("#topic-more").waitFor({ state: "visible" });
    const heights = await frame.locator(".topic-window").evaluate(el => ({
      visible: el.clientHeight, full: el.firstElementChild.clientHeight,
    }));
    assert(heights.visible === 66 && heights.full > heights.visible, "список ограничен двумя строками");
    await frame.locator("#topic-more button").click();
    await frame.locator("#topic-find").fill("номер 24");
    eq(await frame.locator("#topic-chips button:visible").count(), 1, "поиск в полном списке сохранился");
    await frame.locator("#topic-chips button:visible").click();
    await frame.getByRole("button", { name: "Свернуть темы" }).click();
    await frame.locator("#topic-more").waitFor({ state: "hidden" });
  } finally { await native.close(); }
});

await test("без ошибок в консоли", async () => { eq(errors, [], "ошибки страницы"); });

await browser.close();
server.kill();
console.log(`\n${passed} прошло, ${failed} упало`);
process.exit(failed ? 1 : 0);
