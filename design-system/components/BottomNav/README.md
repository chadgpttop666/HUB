# Нижняя панель (телефон)

Разделы хаба на телефоне: «Сегодня», «Корзина», «Приложения», «Настройки».

```html
<nav class="hub-navbar" aria-label="Разделы">
  <button class="hub-navbar__item" aria-current="page"><span class="hub-navbar__icon"><i data-icon="house"></i></span>Сегодня</button>
  <button class="hub-navbar__item"><span class="hub-navbar__icon"><i data-icon="inbox"></i><span class="hub-navbar__badge">5</span></span>Корзина</button>
</nav>
```

- Высота 80, плотное стекло `surface-strong`, край `line-soft`. Значок 22 в капсуле 64×32 и подпись `font-size-xs` под ним.
- Текущий раздел — `aria-current="page"`: подпись `text`, капсула `accent-soft`. Остальные — `text-muted`.
- Число непрочитанного — `hub-navbar__badge` (`accent` / `on-accent`), только у «Корзины»; ноль — значка нет.
- 3–5 разделов, подписи — одним словом. В открытом приложении панель прячется.
