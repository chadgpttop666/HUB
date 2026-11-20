# Таблица

Данные, которые сравнивают по столбцам: темы повторения, история блоков, список файлов синхронизации.

```html
<table class="hub-table">
  <caption>Темы повторения</caption>
  <thead><tr><th aria-sort="ascending"><button>Тема</button></th><th class="is-num"><button>Удержание</button></th></tr></thead>
  <tbody><tr><td>Логика</td><td class="is-num">61%</td></tr></tbody>
</table>
```

- Шапка `font-size-xs` `text-muted`, строки `font-size-base`, разделители `line-soft`, без вертикальных линий и зебры.
- Числа — `is-num`: вправо, моноширинные цифры. Второстепенное — `is-muted`.
- Сортировка — кнопка в `th` и `aria-sort`; стрелка рисуется сама.
- Строка под курсором — `surface-sunken`; выбранная — `aria-selected="true"`.
- Таблица лежит на стекле (`hub-glass`) или внутри области приложения, не прямо на фото. На телефоне — список строк вместо таблицы.
