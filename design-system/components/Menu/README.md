# Меню

Список действий или вариантов, который открывается от кнопки или поля и закрывается после выбора.

```html
<ul class="hub-menu" role="menu">
  <li class="hub-menu__label">Элемент корзины</li>
  <li class="hub-menu__item" role="menuitem"><i data-icon="alarm-clock"></i>Отложить<kbd class="hub-kbd">S</kbd></li>
  <li class="hub-menu__sep" role="separator"></li>
</ul>
```

- Плотное стекло `surface-strong`, `radius-md`, тень `shadow-float`, слой `z-menu`.
- Пункт: значок 16 `text-muted`, текст, справа — клавиша `hub-kbd` или пояснение `hub-menu__meta`.
- Подсвеченный пункт (мышь или стрелки) — `accent-soft`: класс `is-active` или `aria-selected="true"`.
- Опасный пункт — последним, после разделителя, текст и значок `danger`.
- Управление: ↑/↓, Enter, Esc, первая буква. До 8 пунктов; больше — поиск.
