# Строка списка

Одна запись в списке: слева значок или чекбокс, в середине название и пояснение, справа число, тег, клавиша или стрелка.

```html
<ul class="hub-list hub-list--divided">
  <li><button class="hub-row" type="button">
    <span class="hub-row__lead"><i data-icon="brain"></i></span>
    <span class="hub-row__body"><span class="hub-row__title">Логика</span><span class="hub-row__meta">24 карточки · удержание 61%</span></span>
    <span class="hub-row__trail">12</span>
  </button></li>
</ul>
```

- Высота от 44 (`control-lg`) — удобно и пальцем. Длинное название и пояснение обрезаются в одну строку многоточием.
- Строка-действие — `<button>` или `<a>`; строка с чекбоксом — `<label>`. Просто данные — `<div>` без наведения.
- Состояния: наведение (`surface-sunken`), фокус (кольцо внутрь), выбрана (`aria-selected="true"` → `accent-soft`), `aria-disabled`.
- `hub-list--divided` — разделители `line-soft` между строками; без него — строки с отступами.
- В правой части — что-то одно. Цифры моноширинные.
