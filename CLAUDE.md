# Хаб — правила для работы в репозитории

- Отвечать и писать тексты интерфейса по-русски. Тексты — по разделу «Тексты» `design-system/README.md`: коротко, кнопка — глагол, «ёлочки», `HubUI.plural` для чисел, без восклицаний и эмодзи.
- Вид — только из дизайн-системы: компоненты `hub-*` из `design-system/components/bundle.css`, значения — токены (`var(--…)`). Своих цветов (`#hex`, `rgb()`), шрифтов и размеров в `ui/` и `apps/` не добавлять. `design-system/` не править: это внешний набор, обновляется целиком.
- Приложение видит только Hub API (`docs/hub-api.md`). Новую возможность для приложений добавлять в `runtime/hub-app.js` (сторона приложения) и `ui/js/host.js` (сторона хаба) вместе, и описывать в `docs/hub-api.md` и `docs/app-spec.template.md`; `APP_SPEC.md` не править руками — `node scripts/app-spec.mjs`.
- Ядро (`src-tauri/`) — только то, что нельзя сделать в интерфейсе: файлы, ключи, rclone, системные вещи. Данные — «ключ — файл» (`src-tauri/src/store.rs`).
- Порядок этапов — `docs/design-doc.md`, «План этапов». Состояние: `docs/stage-1.md`, `docs/stage-2.md`, `docs/stage-3.md`.
- Перед коммитом: `npm test` (Chromium, нужен `playwright`) и `cd src-tauri && HUB_RCLONE=… cargo test` (rclone — `node scripts/fetch-rclone.mjs`). Синхронизация между окнами Tauri — `tests/tauri-e2e.mjs` (нужны tauri-driver, WebKitWebDriver, Xvfb).
- Секреты в журнал синхронизации не попадают: ключи — только в `keys.json` (заперты), токен Drive и состояние — `sync/*.json`, зашифрованы ключом данных. Новые «только для этого устройства» ключи хаба — в `local_only` (`src-tauri/src/sync.rs`).
