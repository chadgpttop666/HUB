# Теги

Короткая метка у записи (`#учёба`, «с телефона») или переключаемый фильтр.

```html
<span class="hub-tag">#учёба</span>
<span class="hub-tag hub-tag--warning"><i data-icon="triangle-alert"></i>просела</span>
<button class="hub-tag" type="button" aria-pressed="true">Все</button>
```

- Нейтральный — подложка `surface-sunken`, текст `text`.
- Состояние (`--accent`, `--success`, `--warning`, `--danger`) — мягкая подложка, рамка и значок цвета состояния; **текст всегда `text`**, значок обязателен: цвет не единственный признак.
- Фильтр — `<button class="hub-tag" aria-pressed>`; выбранный — `accent-soft` и рамка `accent`.
- Удаляемая метка — кнопка `hub-tag__remove` с `aria-label`.
- Одно-два слова, строчными. Тег — не кнопка действия.
