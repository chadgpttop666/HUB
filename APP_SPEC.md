# APP_SPEC — как написать приложение для Хаба

Этот файл прикладывается к запросу «сделай мне приложение для…». Он описывает всё, что нужно: формат, функции хаба, оформление, запреты и готовый шаблон, который заведомо работает. Пиши приложение строго по нему.

> Файл собран автоматически (`node scripts/app-spec.mjs`) из дизайн-системы и шаблона `templates/app`. Не правь его руками — правь `docs/app-spec.template.md`.

## Что такое приложение

Папка (или zip-архив этой папки):

```
notes/
  manifest.json   имя, версия, значок, что принимает из корзины, права
  index.html      само приложение: разметка, стили раскладки, скрипт — можно одним файлом
  …               другие файлы, если нужны (app.js, style.css, картинки) — подключать относительными путями
```

Пользователь перетаскивает папку или zip в окно хаба → видит, что приложение просит → «Установить». Приложение появляется в меню, в разборе корзины (если что-то принимает) и на телефоне.

Хаб открывает `index.html` в песочнице и **сам** подставляет в неё стили и шрифты темы, классы компонентов `hub-*`, помощник `window.HubUI` и `window.hub` (Hub API). Подключать их не нужно и нельзя.

## manifest.json

```json
{
  "id": "notes-template",
  "name": "Заметки",
  "version": "1.0.0",
  "description": "Шаблон приложения для хаба: список с отметками, приём из корзины, карточка на «Сегодня»",
  "icon": "list-checks",
  "entry": "index.html",
  "card": true,
  "accepts": [{ "type": "text", "label": "Заметка в список" }],
  "permissions": { "network": [] }
}
```

| поле | обязательно | что значит |
| --- | --- | --- |
| `id` | да | строчные латинские буквы, цифры, `-` `_` `.`; до 64 знаков; не `hub`. По нему хаб хранит данные приложения — менять между версиями нельзя |
| `name` | да | название в меню, на карточке, в разборе корзины |
| `version` | желательно | строка вида `1.0.0`; при обновлении хаб показывает «было → станет» |
| `description` | нет | одна строка: что делает |
| `icon` | нет | имя значка из списка ниже (`list-checks`, `calendar`…) |
| `entry` | нет | страница приложения, по умолчанию `index.html` |
| `card` | нет | `true` — у приложения есть карточка на «Сегодня»; хаб запускает его в фоне при старте |
| `accepts` | нет | что приложение принимает из корзины: `[{ "type": "text", "label": "Заметка в список" }]`. Каждый элемент — плитка «Куда перенести» с надписью `label` |
| `permissions.network` | нет | адреса `https://…`, куда приложению можно ходить (`fetch`). Без этого интернета нет вовсе |

## Hub API (`window.hub`)

Готов сразу, ждать загрузки не нужно.

### Данные: `hub.data`

Ключ — строка до 400 знаков, `/` делит её на папки; лучше строчными латинскими буквами. Значение — любое JSON-значение или `Blob`/`File`.

```js
await hub.data.set("notes/abc", { text: "Купить хлеб", done: false });
const note = await hub.data.get("notes/abc");     // undefined, если нет
await hub.data.remove("notes/abc");
const keys = await hub.data.keys("notes/");        // ["notes/abc", …]
await hub.data.set("photos/1", file);              // Blob или File
const blob = await hub.data.get("photos/1");
const settings = hub.data.peek("settings");        // синхронно, только JSON
```

- Все JSON-данные приходят вместе со страницей: `get` и `peek` читают из памяти мгновенно.
- Данные шифруются и синхронизируются между ПК и телефоном сами.
- **Храни записи отдельными ключами** (`notes/<id>`, `events/<id>`), а не одним большим списком: правки с двух устройств тогда сливаются. Одним ключом — останется только более поздняя правка.
- `localStorage`, `sessionStorage` и `indexedDB` тоже работают (хаб их подменяет), но для нового приложения используй `hub.data`.

### Корзина: `hub.inbox`

```js
await hub.inbox.add("Купить книгу #чтение");       // положить мысль в корзину (#слово — метка)

hub.inbox.onItem(async (item, { type, label }) => {
  // item: { id, text, created (ISO-время), device, tags: ["чтение"] }
  await hub.data.set(`notes/${myId()}`, { text: item.text });
  // вернуть false или бросить ошибку — элемент вернётся в корзину
});
```

`onItem` вызывай сразу при запуске: элементы, перенесённые при разборе корзины, ждут, пока приложение их примет (даже если оно было закрыто).

### Карточка на «Сегодня»: `hub.today`

Приложение отдаёт **данные**, хаб рисует карточку сам.

```js
hub.today.set({
  main: "3 заметки",                          // главная строка, с числом
  note: "последняя: купить хлеб",             // одна строка пояснения
  action: { label: "Открыть", open: "list" }, // кнопка (глагол); open вернётся в onAction
});
hub.today.set({ main: "Всё сделано", note: "завтра — 2 дела", done: true });       // тихая карточка без кнопки
hub.today.set({ main: "Осталось 2 из 4", list: [{ text: "хлеб", done: true }, { text: "молоко", done: false }] });
hub.today.onAction(a => showSection(a.open));
```

Вызывай после каждого изменения данных — одинаковая карточка повторно не отправляется.

### Тема и уведомления

```js
hub.theme.get();                               // { id, name, base: "dark" | "light" | "solid", tokens }
hub.theme.onChange(t => redrawChart());        // переменные CSS хаб меняет сам; это — для canvas и графиков
await hub.notify("Таймер закончился", { title: "Учебный блок" });
```

### Помощник вида: `window.HubUI`

```js
HubUI.toast("Удалено", { icon: "trash-2", action: "Отменить", onAction: undo });   // уведомление внизу
HubUI.plural(5, ["заметка", "заметки", "заметок"]);    // «5 заметок»
HubUI.icon("calendar");                                 // строка <svg> значка
HubUI.icons(element);                                   // превратить <i data-icon="…"> в значки внутри элемента
HubUI.greeting();                                       // «Добрый вечер»
```

`<i data-icon="…">` в исходной разметке превращаются в значки сами; в разметке, добавленной скриптом, вызови `HubUI.icons(контейнер)`.

## Оформление

Десять приложений должны выглядеть как одно. Поэтому:

1. Цвет, шрифт, размер шрифта, толщина, скругление, размытие и длительность — **только** `var(--…)` из токенов ниже или готовые классы. Никаких `#hex`, `rgb()`, названий цветов и своих шрифтов. Хаб проверяет это при установке и предупреждает.
2. Только компоненты `hub-*` (ниже). Нужного нет — собери из имеющихся, не рисуй своё.
3. Фон страницы не задавай: под приложением уже фото темы и стекло.
4. Значки — только `<i data-icon="…">` или `HubUI.icon()` из списка ниже; никаких эмодзи.
5. Состояния — атрибутами: `disabled`, `aria-invalid="true"`, `aria-selected`, `aria-pressed`, `aria-busy`, `aria-current`.
6. Всё делается с клавиатуры, фокус виден. Не занимай клавиши хаба: `Ctrl+Пробел`, `Ctrl+K`, `Alt+1…9`, `Ctrl+L`.
7. Одна основная кнопка (`hub-btn--primary`) на экран. Опасное действие — `hub-btn--danger`. Удаление одного элемента — сразу и с «Отменить» в уведомлении, без диалога.
8. Тексты: русский, коротко; кнопка — глагол («Добавить», «Удалить»); числа — `HubUI.plural`; «ёлочки», тире с пробелами; без восклицательных знаков и эмодзи.
9. Своё у приложения — только раскладка (сетка, колонки, отступы через `var(--space-…)`) и тексты.

**На телефоне** то же приложение открывается во весь экран (390 px): при ширине до 600 px раскладка — в одну колонку, всё нажимаемое — от 48 px (`hub-btn--lg`, `hub-input--lg`), главные действия — внизу, ничего не прячется до наведения мыши. Верхнюю строку со стрелкой «назад» рисует хаб.

### Токены темы

Цвета (у каждой темы свои значения — тёмная, светлая, без фото):

| токен | для чего |
| --- | --- |
| `--surface` | Стекло: карточки, строка ввода, панели. Всегда вместе с размытием blur-glass и линией line-soft. |
| `--surface-hover` | Стекло под курсором и у элемента с фокусом внутри (строка ввода в фокусе). |
| `--surface-strong` | Плотное стекло: диалог, меню, всплывающее уведомление, мини-окно ввода поверх других программ. |
| `--surface-sunken` | Утопленная подложка внутри стекла: поле ввода, шапка таблицы, дорожка прогресса, строка под курсором. |
| `--text` | Основной текст на surface, surface-strong и на вуали scrim-*. Не ниже 4.5:1 во всех темах. |
| `--text-muted` | Вторичный текст: дата, пояснения, подписи карточек, подсказки. На surface, surface-strong и вуали — не ниже 4.5:1. |
| `--text-faint` | Только плейсхолдеры и недоступные элементы. Не для смыслового текста: на стекле около 3:1. |
| `--line` | Границы элементов управления и подчёркивания (поле пароля, обычная кнопка, чекбокс). Не ниже 3:1 к фону. |
| `--line-soft` | Край стекла и разделители строк. Декоративная: элементы ею не выделяются. |
| `--accent` | Рассветный акцент: фокус, курсор, отмеченный чекбокс, основная кнопка, «добавлено». На surface — не ниже 4.5:1 как текст. |
| `--accent-hover` | Основная кнопка под курсором. |
| `--on-accent` | Текст и значок на заливке accent (основная кнопка, отмеченный чекбокс). |
| `--accent-soft` | Подложка выбранного: строка списка, выбранный тег, получатель при разборе корзины. |
| `--focus` | Кольцо фокуса с клавиатуры: сплошное 2px с отступом 2px. Не ниже 3:1 на любой поверхности. |
| `--selection` | Выделение текста мышью. |
| `--danger` | Ошибка и опасное действие: неверный пароль, «Удалить». Всегда со значком или словом. На surface и вуали — 4.5:1. |
| `--danger-soft` | Подложка ошибки и опасной кнопки под курсором. |
| `--success` | Успех: синхронизировано, установлено. Холодный бирюзовый, чтобы не путать с danger по оттенку. Всегда со значком. |
| `--success-soft` | Подложка успеха в уведомлении и теге. |
| `--warning` | Предупреждение: Caps Lock, нет сети, конфликт синхронизации. Всегда со значком. |
| `--warning-soft` | Подложка предупреждения. |
| `--shadow-float` | Только у того, что парит над всем: диалог, меню, уведомление, мини-окно. Карточки без тени. |

Размеры и движение:

| токен | для чего |
| --- | --- |
| `--space-1` | Зазор значка и текста в теге, между строками подписи. |
| `--space-2` | Зазор значка и текста в кнопке, между тегами. |
| `--space-3` | Внутренний отступ поля по бокам; между строками плана. |
| `--space-4` | Отступ кнопки по бокам; зазор между карточками; отступ карточки сверху. |
| `--space-5` | Отступ карточки по бокам; поля экрана на телефоне. |
| `--space-6` | Отступ диалога и пустого состояния. |
| `--space-8` | Между крупными блоками экрана. |
| `--space-10` | От подсказки на экране входа до нижнего края. |
| `--space-12` | От шапки до строки ввода на «Сегодня». |
| `--space-16` | Ширина боковой панели приложений. |
| `--control-sm` | Высота маленькой кнопки и поля (в карточках, таблицах). |
| `--control-md` | Высота кнопки и поля по умолчанию. |
| `--control-lg` | Высота крупного поля и кнопок на телефоне; минимальная зона касания. |
| `--radius-xs` | Чекбокс, клавиша kbd. |
| `--radius-sm` | Поле ввода, выпадающий список, меню, строка списка. |
| `--radius-md` | Кнопка внутри строки ввода, плитка получателя, подсказка графика. |
| `--radius` | Скругление по умолчанию (имя из диздока): стекло, карточки, строка ввода. |
| `--radius-xl` | Диалог, мини-окно ввода, нижний лист на телефоне. |
| `--radius-pill` | Обычные кнопки, теги, уведомление, кнопка «Заблокировать». |
| `--font-size-xs` | = t-caption. |
| `--font-size-sm` | = t-label, t-small. |
| `--font-size-base` | Размер по умолчанию (имя из диздока) = t-body. |
| `--font-size-md` | = t-date. |
| `--font-size-lg` | = t-body-l. |
| `--font-size-xl` | = t-heading. |
| `--font-size-2xl` | = t-title, t-capture. |
| `--font-size-3xl` | = t-display. |
| `--font-size-4xl` | = t-greeting. |
| `--font-size-5xl` | = t-timer. |
| `--font-size-clock` | = t-clock. |
| `--weight-thin` | Часы и таймер (только Jost). |
| `--weight-light` | Приветствие, строка ввода, заголовки экранов (Jost). |
| `--weight-regular` | Основной текст; главная строка карточки. |
| `--weight-medium` | Кнопки, вкладки, теги, подписи. |
| `--blur-glass` | Размытие под стеклом (backdrop-filter) карточек и строки ввода. |
| `--duration-fast` | Наведение, нажатие, смена цвета рамки. |
| `--duration-base` | Появление меню, уведомления, переключатель, вкладки. |
| `--duration-slow` | Появление поля пароля, перенос элемента корзины. |
| `--duration-scene` | Смена сцены: заставка → пароль → «Сегодня», размытие фото. |
| `--duration-breathe` | «Дыхание» подсказки на заставке. Отключается при «уменьшить движение». |
| `--ease-out` | Появление и всё по умолчанию: быстро начинается, мягко садится. |
| `--ease-in-out` | Переходы между двумя состояниями (переключатель, вкладки). |
| `--ease-in` | Уход элемента: закрытие, улёт в корзину. |

Шрифты: `--font-heading` (Jost — заголовки, крупные числа), `--font-body` (Manrope — всё остальное). Жирного (600+), курсива и ПРОПИСНЫХ нет. Готовые стили текста: `t-display`, `t-title`, `t-heading` (Jost) и `t-body-l`, `t-body`, `t-label`, `t-small`, `t-caption` (Manrope).

### Компоненты

```html
<!-- заголовок экрана и пояснение -->
<h1 class="hub-page-title">Календарь</h1>
<p class="hub-muted">3 события сегодня</p>
<h2 class="hub-section-title">Ближайшие</h2>

<!-- кнопки: обычная, основная (одна на экран), тихая, опасная, маленькая, крупная (телефон), только значок -->
<button class="hub-btn" type="button"><i data-icon="plus"></i>Добавить</button>
<button class="hub-btn hub-btn--primary" type="button">Сохранить <kbd class="hub-kbd">Enter</kbd></button>
<button class="hub-btn hub-btn--quiet" type="button">Пропустить</button>
<button class="hub-btn hub-btn--danger" type="button"><i data-icon="trash-2"></i>Удалить</button>
<button class="hub-btn hub-btn--sm" type="button">Открыть</button>
<button class="hub-btn hub-btn--quiet hub-btn--icon" type="button" aria-label="Ещё"><i data-icon="ellipsis"></i></button>
<div class="hub-btn-row">…кнопки в ряд…</div>

<!-- поля -->
<label class="hub-field"><span class="hub-label">Название</span><input class="hub-input" placeholder="…"></label>
<textarea class="hub-textarea"></textarea>
<label class="hub-select"><select><option>Месяц</option><option>Неделя</option></select></label>
<label class="hub-check"><input type="checkbox"><span>Сделано</span></label>
<label class="hub-switch"><input type="checkbox" role="switch"><span>Напоминать</span></label>
<p class="hub-hint">подсказка</p> <p class="hub-hint hub-hint--error"><i data-icon="circle-alert"></i>Ошибка словами</p>

<!-- стекло (карточка-панель) и список строк -->
<section class="hub-glass" style="padding:var(--space-4)">
  <ul class="hub-list hub-list--divided">
    <li><div class="hub-row">
      <span class="hub-row__lead"><i data-icon="calendar"></i></span>
      <span class="hub-row__body"><span class="hub-row__title">Консультация</span><span class="hub-row__meta">пятница, 16:00</span></span>
      <span class="hub-row__trail">2 ч</span>
    </div></li>
  </ul>
</section>

<!-- вкладки (HubUI оживляет сам: стрелки, Home, End) -->
<div role="tablist" class="hub-tabs" data-hub-tabs>
  <button class="hub-tab" role="tab" aria-selected="true" aria-controls="p1">Месяц</button>
  <button class="hub-tab" role="tab" aria-selected="false" aria-controls="p2" tabindex="-1">Список</button>
</div>
<section id="p1" role="tabpanel">…</section><section id="p2" role="tabpanel" hidden>…</section>

<!-- теги, клавиша, прогресс -->
<span class="hub-tag">учёба</span> <span class="hub-tag hub-tag--accent">сегодня</span> <span class="hub-tag hub-tag--warning"><i data-icon="triangle-alert"></i>просрочено</span>
<kbd class="hub-kbd">Ctrl</kbd>
<progress class="hub-progress" max="10" value="3"></progress>

<!-- пусто -->
<div class="hub-empty"><i data-icon="calendar" class="hub-empty__icon"></i><h2 class="hub-empty__title">Событий нет</h2>
  <p class="hub-empty__text">Добавьте первое или перенесите из корзины.</p>
  <div class="hub-empty__action"><button class="hub-btn hub-btn--primary">Добавить</button></div></div>

<!-- загрузка -->
<span class="hub-spinner" aria-label="Загрузка"></span> <div class="hub-skeleton hub-skeleton--text"></div>

<!-- диалог для одного решения (родной <dialog>, открывать dialog.showModal()) -->
<dialog class="hub-dialog"><form method="dialog">
  <h2 class="hub-dialog__title">Удалить все события?</h2><p class="hub-dialog__body">Их нельзя будет вернуть.</p>
  <div class="hub-dialog__actions"><button class="hub-btn hub-btn--quiet" value="cancel">Отмена</button><button class="hub-btn hub-btn--danger" value="ok">Удалить</button></div>
</form></dialog>
```

### Значки

`<i data-icon="имя">`, размеры 16 (`hub-icon--sm`), 20 (обычный), 24 (`hub-icon--lg`). Только эти имена:

`alarm-clock`, `archive`, `arrow-big-up`, `arrow-down`, `arrow-left`, `arrow-right`, `arrow-up`, `battery-medium`, `bell`, `book-open`, `book-open-text`, `brain`, `calendar`, `calendar-days`, `chart-column`, `check`, `check-check`, `chevron-down`, `chevron-left`, `chevron-right`, `chevron-up`, `circle-alert`, `circle-check`, `circle-x`, `clock`, `cloud`, `cloud-check`, `cloud-off`, `cloud-upload`, `command`, `copy`, `corner-down-left`, `database`, `download`, `dumbbell`, `ellipsis`, `ellipsis-vertical`, `external-link`, `eye`, `eye-off`, `file-archive`, `file-text`, `fingerprint`, `folder`, `folder-plus`, `folder-sync`, `forward`, `git-compare-arrows`, `globe`, `hard-drive`, `hourglass`, `house`, `image`, `image-plus`, `inbox`, `info`, `key-round`, `keyboard`, `languages`, `layers`, `layout-grid`, `leaf`, `lightbulb`, `list-checks`, `list-todo`, `lock`, `lock-open`, `minus`, `monitor`, `monitor-smartphone`, `moon`, `notebook-pen`, `package`, `palette`, `panel-left`, `pause`, `pencil`, `play`, `plus`, `printer`, `refresh-cw`, `repeat`, `rotate-ccw`, `search`, `send-horizontal`, `settings`, `share-2`, `shield-check`, `signal`, `sliders-horizontal`, `smartphone`, `sun`, `sunrise`, `tag`, `timer`, `trash-2`, `trees`, `triangle-alert`, `type`, `undo-2`, `upload`, `wifi`, `x`

## Нельзя

- Подключать скрипты, стили и шрифты из интернета (`<script src="https://…">`, Google Fonts, CDN). Хаб их заблокирует. Всё нужное — файлами в папке приложения.
- Ходить в сеть без `permissions.network` в манифесте (заблокировано).
- Хранить данные мимо Hub API: в cookie, на «сервере», в файлах.
- Обращаться к `window.parent`, `top`, другим окнам — песочница этого не даст.
- Вставлять пользовательский текст через `innerHTML` без экранирования — используй `textContent`.

## Шаблон — заведомо работает

`manifest.json` — выше. `index.html`:

```html
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Заметки</title>
<style>
  /* Своё у приложения — только раскладка. Цвета, шрифты, размеры, скругления — токены хаба. */
  .layout { max-width: 720px; margin: 0 auto; display: grid; gap: var(--space-6); }
  .head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
  .add { display: flex; gap: var(--space-2); }
  .add .hub-input { flex: 1; }
  @media (max-width: 600px) { .add { flex-direction: column; } }
</style>
</head>
<body>
<div class="layout">
  <header class="head">
    <div>
      <h1 class="hub-page-title">Заметки</h1>
      <p class="hub-muted" id="summary" style="margin:var(--space-1) 0 0"></p>
    </div>
  </header>

  <form class="add" id="add">
    <input class="hub-input hub-input--lg" id="text" placeholder="Что записать" aria-label="Текст заметки" autocomplete="off">
    <button class="hub-btn hub-btn--primary hub-btn--lg" type="submit"><i data-icon="plus"></i>Добавить</button>
  </form>

  <section class="hub-glass" style="padding:var(--space-2) var(--space-3)">
    <ul class="hub-list hub-list--divided" id="list"></ul>
    <div class="hub-empty" id="empty" hidden>
      <i data-icon="list-checks" class="hub-empty__icon"></i>
      <h2 class="hub-empty__title">Пока пусто</h2>
      <p class="hub-empty__text">Напишите заметку выше или перенесите мысль из корзины.</p>
    </div>
  </section>
</div>

<script>
"use strict";
// Данные: каждая заметка — свой ключ «notes/<id>». Так правки с ПК и телефона сливаются, а не затирают друг друга.
const notes = new Map();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const $ = id => document.getElementById(id);

async function load() {
  for (const key of await hub.data.keys("notes/")) notes.set(key.slice(6), await hub.data.get(key));
  render();
}
function save(note) { notes.set(note.id, note); return hub.data.set(`notes/${note.id}`, note); }
function remove(id) { notes.delete(id); return hub.data.remove(`notes/${id}`); }

function render() {
  const list = [...notes.values()].sort((a, b) => a.done - b.done || b.created - a.created);
  const left = list.filter(n => !n.done).length;
  $("summary").textContent = list.length ? `${HubUI.plural(left, ["заметка", "заметки", "заметок"])} в работе` : "";
  $("empty").hidden = list.length > 0;
  $("list").innerHTML = "";
  for (const n of list) {
    const li = document.createElement("li");
    li.innerHTML = `<div class="hub-row">
      <label class="hub-check${n.done ? " hub-check--done" : ""}" style="flex:1"><input type="checkbox"${n.done ? " checked" : ""}><span></span></label>
      <span class="hub-row__trail"><button class="hub-btn hub-btn--quiet hub-btn--icon hub-btn--sm" type="button" aria-label="Удалить"><i data-icon="trash-2"></i></button></span>
    </div>`;
    li.querySelector("span").textContent = n.text;   // текст — через textContent, не innerHTML
    li.querySelector("input").addEventListener("change", e => { save(Object.assign({}, n, { done: e.target.checked })); render(); });
    li.querySelector("button").addEventListener("click", () => {
      remove(n.id); render();
      HubUI.toast("Удалено", { icon: "trash-2", action: "Отменить", onAction: () => { save(n); render(); } });
    });
    $("list").appendChild(li);
  }
  HubUI.icons($("list"));
  // карточка на «Сегодня»: только данные, хаб рисует её сам
  hub.today.set(left
    ? { main: HubUI.plural(left, ["заметка", "заметки", "заметок"]), note: list.find(n => !n.done).text, action: { label: "Открыть" } }
    : { main: "Всё сделано", note: list.length ? `${HubUI.plural(list.length, ["заметка", "заметки", "заметок"])} отмечено` : "заметок нет", done: true });
}

$("add").addEventListener("submit", e => {
  e.preventDefault();
  const text = $("text").value.trim();
  if (!text) return;
  save({ id: uid(), text, done: false, created: Date.now() });
  $("text").value = "";
  render();
});

// элемент из корзины → заметка. Вернуть false или бросить ошибку — элемент вернётся в корзину.
hub.inbox.onItem(async item => {
  await save({ id: uid(), text: item.text, done: false, created: Date.now() });
  render();
  HubUI.toast("Из корзины: заметка добавлена", { icon: "inbox" });
});

load();
</script>
</body>
</html>
```

## Перед тем как отдать

- В файлах нет ни одного `#hex`, `rgb()`, названия цвета, своего шрифта или размера шрифта в обход токенов.
- Нет `<script>`, `<link>` и `@import` на внешние адреса.
- Пустое состояние, загрузка и ошибка нарисованы компонентами выше.
- Всё проходится `Tab` и `Enter`, фокус виден.
- Выглядит правильно в тёмной и светлой теме и на ширине 390 px.
- Записи хранятся отдельными ключами; `hub.inbox.onItem` и `hub.today.set` вызываются, если в манифесте есть `accepts` и `card`.
