# Статус синхронизации

Одна строка в шапке, по которой видно, всё ли уехало на Drive; громким становится только конфликт.

```html
<span class="hub-sync" data-state="ok"><i data-icon="cloud-check"></i><span>синхронизировано</span></span>
<button class="hub-sync" data-state="conflict"><i data-icon="triangle-alert"></i><span>конфликт в 1 файле</span></button>
```

| `data-state` | значок | текст | цвет значка |
| --- | --- | --- | --- |
| `ok` | `cloud-check` | синхронизировано | `success` |
| `busy` | `refresh-cw`, вращается | синхронизация… | `text-muted` |
| `offline` | `cloud-off` | нет сети · всё сохранено здесь | `text-muted` — это не ошибка: хаб работает без сети |
| `conflict` | `triangle-alert` | конфликт в N файлах | `warning`, текст подчёркнут, это кнопка → экран конфликта |

- Текст `text-muted` `font-size-sm`; в узком окне и на телефоне — `hub-sync--icon`: значок с подсказкой, слова остаются для чтения с экрана.
- `busy` показывать, только если синхронизация идёт дольше секунды, иначе значок мигает без пользы.
