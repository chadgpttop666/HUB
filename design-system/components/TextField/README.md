# Поля ввода

Всё, куда пишут: строка `hub-input`, многострочное `hub-textarea`, поиск `hub-search`, число `hub-number` и поле-линия `hub-input--line` для экрана входа.

```html
<label class="hub-field">
  <span class="hub-label">Время</span>
  <input class="hub-input" aria-invalid="true" aria-describedby="t-err">
  <span class="hub-hint hub-hint--error" id="t-err"><i data-icon="circle-alert"></i>Время в формате ЧЧ:ММ</span>
</label>
```

- Подпись над полем (`hub-label`), подсказка под ним (`hub-hint`). Плейсхолдер — пример, а не подпись: он `text-faint` и исчезает при вводе.
- Состояния: наведение (рамка `text-muted`), фокус (рамка и внутреннее кольцо `focus`), ошибка — `aria-invalid="true"` + `hub-hint--error` со значком и словами, что исправить; `disabled`.
- **Поиск**: `<label class="hub-search">` со значком `search`, `input type="search"` и справа — `kbd` с горячей клавишей или кнопка `hub-search__clear`, когда есть текст.
- **Число**: `hub-number` — кнопки `data-step="-1"` / `data-step="1"` вокруг `input type="number"` с `min`, `max`, `step`; на пределе кнопка отключается сама (hub-ui.js).
- **Поле-линия** `hub-input--line` — только поверх фото (пароль); `hub-input--secret` разрежает точки.
- Размеры: `--sm` (32) в таблицах и карточках, обычный (36), `--lg` (44) на телефоне.

Ошибку показывают после ухода из поля или при отправке, не на каждую букву. Текст ошибки — что сделать, а не «Неверный ввод».
