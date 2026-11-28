/* hub-app.js — обвязка приложения внутри Хаба: window.hub (Hub API) и подмены браузерных хранилищ.

   Хаб подставляет этот файл в страницу каждого приложения до его собственных скриптов.
   Страница приложения открыта в песочнице (iframe без allow-same-origin), поэтому:
   - localStorage, sessionStorage, indexedDB и Notification браузера ей недоступны — здесь их подмены;
   - все данные приложения хаб отдаёт сразу при запуске (window.__HUB_BOOT__), чтение идёт из памяти,
     запись уходит в хаб сообщением и сохраняется в файлы на диске.
   Больше ничего приложение не видит: ни чужих данных, ни файлов, ни сети. */
(function () {
  "use strict";
  if (window.hub && window.hub.__ready) return;

  var boot = window.__HUB_BOOT__ || {};
  try { delete window.__HUB_BOOT__; } catch (e) { window.__HUB_BOOT__ = undefined; }
  var host = window.parent;
  var appId = boot.appId || "app";
  var visible = boot.visible !== false;

  /* ───────── связь с хабом ───────── */
  var seq = 0, waiting = {};
  function call(method, params, transfer) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      waiting[id] = { resolve: resolve, reject: reject };
      host.postMessage({ __hub: 1, id: id, method: method, params: params || {} }, "*", transfer || []);
    });
  }
  function send(method, params) { host.postMessage({ __hub: 1, method: method, params: params || {} }, "*"); }

  var listeners = {};
  function on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return function () { off(event, fn); }; }
  function off(event, fn) { var l = listeners[event]; if (l) listeners[event] = l.filter(function (f) { return f !== fn; }); }
  function emit(event, payload) {
    (listeners[event] || []).slice().forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error("[hub]", event, e); }
    });
  }

  window.addEventListener("message", function (e) {
    if (e.source !== host) return;
    var m = e.data;
    if (!m || m.__hub !== 1) return;
    if (m.reply) {
      var w = waiting[m.reply];
      if (!w) return;
      delete waiting[m.reply];
      if (m.error) w.reject(new Error(m.error)); else w.resolve(m.result);
      return;
    }
    if (m.event === "app.visibility") visible = !!m.payload;
    if (m.event === "theme") applyTheme(m.payload);
    else if (m.event === "inbox.items") receiveItems(m.payload || []);
    else if (m.event === "today.action") emit("today.action", m.payload || {});
    else if (m.event) emit(m.event, m.payload);
  });

  /* ───────── данные приложения ─────────
     Ключ — строка с «/» как разделителем, значение — любое JSON-значение или Blob.
     На диске каждый ключ — отдельный файл: <папка данных>/<приложение>/<ключ>.json (.bin для Blob). */
  var store = boot.data || {};      // ключ → JSON-значение (всё, что не Blob)
  var blobMeta = boot.blobs || {};  // ключ → { type, size }
  var has = Object.prototype.hasOwnProperty;
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function checkKey(key) {
    if (typeof key !== "string" || !key || key.length > 400) throw new TypeError("hub.data: ключ — непустая строка до 400 знаков");
    if (key.split("/").some(function (s) { return !s || s === "." || s === ".."; })) throw new TypeError("hub.data: в ключе пустая часть или «.»/«..»: " + key);
  }
  var data = {
    get: function (key) {
      checkKey(key);
      if (has.call(store, key)) return Promise.resolve(clone(store[key]));
      if (has.call(blobMeta, key)) return call("data.get", { key: key });
      return Promise.resolve(undefined);
    },
    set: function (key, value) {
      checkKey(key);
      if (value === undefined) return data.remove(key);
      if (typeof Blob !== "undefined" && value instanceof Blob) {
        delete store[key];
        blobMeta[key] = { type: value.type || "application/octet-stream", size: value.size };
        return call("data.set", { key: key, value: value });
      }
      var json = JSON.stringify(value);
      if (json === undefined) throw new TypeError("hub.data.set: значение не сохраняется в JSON");
      store[key] = JSON.parse(json);
      delete blobMeta[key];
      return call("data.set", { key: key, value: store[key] });
    },
    remove: function (key) {
      checkKey(key);
      delete store[key]; delete blobMeta[key];
      return call("data.remove", { key: key });
    },
    keys: function (prefix) {
      prefix = prefix || "";
      var out = Object.keys(store).concat(Object.keys(blobMeta)).filter(function (k) { return k.indexOf(prefix) === 0; });
      return Promise.resolve(out.sort());
    },
    /* синхронное чтение JSON-значений — для подмен ниже и для тех, кому удобнее так */
    peek: function (key) { return has.call(store, key) ? clone(store[key]) : undefined; }
  };
  // запись без ожидания ответа: порядок сохраняется, ошибку покажет хаб
  function quietSet(key, value) { data.set(key, value).catch(function (e) { console.error("[hub] не сохранилось", key, e); }); }
  function quietRemove(key) { data.remove(key).catch(function (e) { console.error("[hub] не удалилось", key, e); }); }

  /* ───────── корзина ───────── */
  var itemHandler = null, pendingItems = [];
  function receiveItems(list) {
    list.forEach(function (d) { pendingItems.push(d); });
    drainItems();
  }
  function drainItems() {
    if (!itemHandler) return;
    while (pendingItems.length) {
      (function (d) {
        Promise.resolve().then(function () { return itemHandler(d.item, { type: d.type, label: d.label }); })
          .then(function (res) { send("inbox.ack", { id: d.id, ok: res !== false }); },
                function (err) { console.error("[hub] элемент корзины не принят", err); send("inbox.ack", { id: d.id, ok: false, error: String(err && err.message || err) }); });
      })(pendingItems.shift());
    }
  }
  var inbox = {
    add: function (text, opts) { return call("inbox.add", { text: String(text || ""), tags: (opts && opts.tags) || [] }); },
    /* handler(item, {type, label}) — item: { id, text, created, device, tags }.
       Вернуть false или бросить ошибку — элемент вернётся в корзину. */
    onItem: function (handler) {
      itemHandler = handler;
      send("inbox.ready", {});
      drainItems();
    }
  };

  /* ───────── тема ───────── */
  var theme = boot.theme || { id: "forest", base: "dark", tokens: {} };
  function applyTheme(t) {
    if (t) theme = t;
    var html = document.documentElement;
    html.setAttribute("data-theme", theme.base || "dark");
    html.setAttribute("data-hub-embedded", "");
    var tokens = theme.tokens || {};
    for (var i = html.style.length - 1; i >= 0; i--) {
      var p = html.style[i];
      if (p.indexOf("--") === 0 && !has.call(tokens, p.slice(2))) html.style.removeProperty(p);
    }
    Object.keys(tokens).forEach(function (k) { html.style.setProperty("--" + k, tokens[k]); });
    if (t) emit("theme", clone(theme));
  }
  applyTheme();

  /* ───────── карточка на «Сегодня» ───────── */
  var lastCard = null;
  var today = {
    /* card: { main, note?, action?: { label, open? }, list?: [{ text, done }], done? } */
    set: function (card) {
      var json = JSON.stringify(card || null);
      if (json === lastCard) return Promise.resolve();
      lastCard = json;
      return call("today.set", { card: card || null });
    },
    clear: function () { return today.set(null); },
    onAction: function (fn) { return on("today.action", fn); }
  };

  /* ───────── hub ───────── */
  var hub = {
    __ready: true,
    appId: appId,
    platform: boot.platform || "pc",
    calendar: appId === "calendar" ? { permissions: function (request) { return call("calendar.permissions", { request: request || "" }); } } : undefined,
    get visible() { return visible; },
    version: 1,
    data: data,
    inbox: inbox,
    today: today,
    theme: {
      get: function () { return clone(theme); },
      onChange: function (fn) { return on("theme", fn); }
    },
    notify: function (text, opts) {
      opts = opts || {};
      return call("notify", { title: opts.title || "", text: String(text || ""), tone: opts.tone || "" });
    },
    on: on
  };
  try { Object.defineProperty(window, "hub", { value: hub, configurable: false, writable: false }); } catch (e) { window.hub = hub; }

  /* ───────── подмена localStorage ─────────
     Ключ k хранится как localstorage/<k> (k экранирован, чтобы «/» не делил его на папки).
     Если строка — точный JSON, на диск ложится разобранное значение (файл читается глазами),
     иначе — сама строка. Чтение всегда возвращает ровно ту строку, что записали. */
  var LS = "localstorage/";
  function lsKey(k) { return LS + encodeURIComponent(k); }
  function makeStorage(persist) {
    var mem = new Map();
    if (persist) {
      Object.keys(store).forEach(function (key) {
        if (key.indexOf(LS) !== 0) return;
        var v = store[key], k = decodeURIComponent(key.slice(LS.length));
        mem.set(k, typeof v === "string" ? v : JSON.stringify(v));
      });
    }
    function write(k, s) {
      if (!persist) return;
      var v = s;
      if (s.length && "{[0123456789-tfn".indexOf(s[0]) >= 0) {
        try { var p = JSON.parse(s); if (typeof p !== "string" && JSON.stringify(p) === s) v = p; } catch (e) { /* не JSON */ }
      }
      quietSet(lsKey(k), v);
    }
    var api = {
      getItem: function (k) { k = String(k); return mem.has(k) ? mem.get(k) : null; },
      setItem: function (k, v) { k = String(k); v = String(v); mem.set(k, v); write(k, v); },
      removeItem: function (k) { k = String(k); if (!mem.has(k)) return; mem.delete(k); if (persist) quietRemove(lsKey(k)); },
      clear: function () { var keys = Array.from(mem.keys()); mem.clear(); if (persist) keys.forEach(function (k) { quietRemove(lsKey(k)); }); },
      key: function (i) { var keys = Array.from(mem.keys()); return i >= 0 && i < keys.length ? keys[i] : null; }
    };
    Object.defineProperty(api, "length", { get: function () { return mem.size; }, configurable: true });
    // обращение как к свойствам: localStorage.foo
    return typeof Proxy === "function" ? new Proxy(api, {
      get: function (t, p) { if (p in t || typeof p !== "string") return t[p]; return t.getItem(p) === null ? undefined : t.getItem(p); },
      set: function (t, p, v) { if (p in t) return false; t.setItem(p, v); return true; },
      deleteProperty: function (t, p) { t.removeItem(p); return true; },
      has: function (t, p) { return p in t || mem.has(String(p)); },
      ownKeys: function () { return Array.from(mem.keys()); },
      getOwnPropertyDescriptor: function (t, p) { return mem.has(String(p)) ? { value: mem.get(String(p)), enumerable: true, configurable: true, writable: true } : undefined; }
    }) : api;
  }
  function define(name, value) {
    try { Object.defineProperty(window, name, { get: function () { return value; }, configurable: true }); }
    catch (e) { console.warn("[hub] не удалось подменить " + name, e); }
  }
  define("localStorage", makeStorage(true));
  define("sessionStorage", makeStorage(false));

  /* ───────── подмена Notification ───────── */
  function HubNotification(title, opts) {
    opts = opts || {};
    this.title = String(title || ""); this.body = opts.body || "";
    this.onclick = null; this.onclose = null; this.onshow = null; this.onerror = null;
    hub.notify(this.body || this.title, { title: this.body ? this.title : "" });
  }
  HubNotification.permission = "granted";
  HubNotification.requestPermission = function (cb) { if (typeof cb === "function") cb("granted"); return Promise.resolve("granted"); };
  HubNotification.prototype.close = function () {};
  HubNotification.prototype.addEventListener = function () {};
  HubNotification.prototype.removeEventListener = function () {};
  define("Notification", HubNotification);

  if (navigator.storage) {
    try {
      navigator.storage.persist = function () { return Promise.resolve(true); };
      navigator.storage.persisted = function () { return Promise.resolve(true); };
    } catch (e) { /* только для чтения — не страшно */ }
  }

  /* ───────── подмена indexedDB (подмножество) ─────────
     Хватает для обычного «база → хранилище → put/get/getAll/delete/clear/count».
     Запись: indexeddb/<база>/<хранилище>/<ключ>.json; поля-Blob верхнего уровня — отдельными файлами
     indexeddb/<база>/<хранилище>_blobs/<ключ>/<поле>.bin.
     Курсоров и индексов нет. getAll() отдаёт крупные Blob (больше 8 МБ) пустыми заглушками
     с полем __hubLazy, чтобы не тянуть в память все ролики сразу; get(ключ) отдаёт Blob целиком. */
  var LAZY_LIMIT = 8 * 1024 * 1024;
  var IDB = "indexeddb/";
  function encPart(s) { return encodeURIComponent(String(s)); }
  function idbMetaKey(db) { return IDB + encPart(db) + "/_meta"; }
  function idbRecPrefix(db, st) { return IDB + encPart(db) + "/" + encPart(st) + "/"; }
  function idbBlobPrefix(db, st) { return IDB + encPart(db) + "/" + encPart(st) + "_blobs/"; }
  function keyToken(k) { return (typeof k === "number" ? "n" : "s") + encPart(k); }
  function tokenToKey(t) { var raw = decodeURIComponent(t.slice(1)); return t[0] === "n" ? Number(raw) : raw; }
  function cmpKeys(a, b) {
    var ta = typeof a === "number" ? 0 : 1, tb = typeof b === "number" ? 0 : 1;
    if (ta !== tb) return ta - tb;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  function domError(name, msg) {
    try { return new DOMException(msg || name, name); } catch (e) { var er = new Error(msg || name); er.name = name; return er; }
  }

  function Target() { this._l = {}; }
  Target.prototype.addEventListener = function (t, f) { (this._l[t] = this._l[t] || []).push(f); };
  Target.prototype.removeEventListener = function (t, f) { var l = this._l[t]; if (l) this._l[t] = l.filter(function (x) { return x !== f; }); };
  Target.prototype._fire = function (type, extra) {
    var self = this, ev = { type: type, target: self, currentTarget: self, defaultPrevented: false,
      preventDefault: function () { this.defaultPrevented = true; }, stopPropagation: function () {} };
    if (extra) Object.keys(extra).forEach(function (k) { ev[k] = extra[k]; });
    if (typeof self["on" + type] === "function") { try { self["on" + type](ev); } catch (e) { console.error(e); } }
    (self._l[type] || []).slice().forEach(function (f) { try { f.call(self, ev); } catch (e) { console.error(e); } });
    return ev;
  };

  function Req(source, tx) { Target.call(this); this.result = undefined; this.error = null; this.readyState = "pending"; this.source = source || null; this.transaction = tx || null; this.onsuccess = null; this.onerror = null; }
  Req.prototype = Object.create(Target.prototype);

  // кэш записей: база → хранилище → Map(ключ → запись как на диске)
  var idbCache = {};
  function storeMap(dbName, stName) {
    var dbc = idbCache[dbName] = idbCache[dbName] || {};
    if (dbc[stName]) return dbc[stName];
    var map = new Map(), pre = idbRecPrefix(dbName, stName);
    Object.keys(store).forEach(function (key) {
      if (key.indexOf(pre) !== 0) return;
      var rest = key.slice(pre.length);
      if (rest.indexOf("/") >= 0) return;
      map.set(tokenToKey(rest), store[key]);
    });
    dbc[stName] = map;
    return map;
  }

  function DB(name, meta) {
    Target.call(this);
    this.name = name; this._meta = meta; this.version = meta.version; this._upgrading = null; this._closed = false;
    this.onversionchange = null; this.onclose = null; this.onerror = null; this.onabort = null;
  }
  DB.prototype = Object.create(Target.prototype);
  Object.defineProperty(DB.prototype, "objectStoreNames", { get: function () {
    var names = Object.keys(this._meta.stores).sort();
    names.contains = function (n) { return names.indexOf(n) >= 0; };
    names.item = function (i) { return names[i] || null; };
    return names;
  } });
  DB.prototype.createObjectStore = function (name, opts) {
    if (!this._upgrading) throw domError("InvalidStateError", "createObjectStore вне onupgradeneeded");
    if (this._meta.stores[name]) throw domError("ConstraintError", "хранилище уже есть: " + name);
    opts = opts || {};
    this._meta.stores[name] = { keyPath: opts.keyPath == null ? null : opts.keyPath, autoIncrement: !!opts.autoIncrement, next: 1 };
    return new ObjStore(this._upgrading, name);
  };
  DB.prototype.deleteObjectStore = function (name) {
    if (!this._upgrading) throw domError("InvalidStateError", "deleteObjectStore вне onupgradeneeded");
    var map = storeMap(this.name, name), self = this;
    map.forEach(function (rec, k) { dropRecord(self.name, name, k, rec); });
    delete this._meta.stores[name];
    if (idbCache[this.name]) delete idbCache[this.name][name];
  };
  DB.prototype.transaction = function (names, mode) {
    if (this._closed) throw domError("InvalidStateError", "база закрыта");
    names = typeof names === "string" ? [names] : Array.from(names);
    var self = this;
    names.forEach(function (n) { if (!self._meta.stores[n]) throw domError("NotFoundError", "нет хранилища " + n); });
    return new Tx(this, names, mode || "readonly");
  };
  DB.prototype.close = function () { this._closed = true; };

  function Tx(db, names, mode) {
    Target.call(this);
    this.db = db; this.mode = mode; this._names = names; this.error = null;
    this.oncomplete = null; this.onerror = null; this.onabort = null;
    this._pending = 0; this._chain = Promise.resolve(); this._done = false; this._aborted = false;
    var self = this;
    setTimeout(function () { self._maybeFinish(); }, 0);
  }
  Tx.prototype = Object.create(Target.prototype);
  Object.defineProperty(Tx.prototype, "objectStoreNames", { get: function () { return this._names.slice(); } });
  Tx.prototype.objectStore = function (name) {
    if (this._names.indexOf(name) < 0 && this.mode !== "versionchange") throw domError("NotFoundError", "хранилище не в транзакции: " + name);
    return new ObjStore(this, name);
  };
  Tx.prototype.abort = function () { this._aborted = true; this._finish("abort"); };
  Tx.prototype.commit = function () {};
  Tx.prototype._op = function (source, fn) {
    var self = this, req = new Req(source, self);
    if (self._done) throw domError("TransactionInactiveError", "транзакция уже завершена");
    self._pending++;
    self._chain = self._chain.then(function () {
      if (self._aborted) return;
      return Promise.resolve().then(fn).then(function (res) {
        req.result = res; req.readyState = "done"; req._fire("success");
      }, function (err) {
        req.error = err; req.readyState = "done";
        var ev = req._fire("error");
        if (!ev.defaultPrevented) { self.error = err; self._aborted = true; self._finish("error", err); }
      });
    }).then(function () { self._pending--; setTimeout(function () { self._maybeFinish(); }, 0); });
    return req;
  };
  Tx.prototype._maybeFinish = function () { if (!this._pending && !this._done) this._finish("complete"); };
  Tx.prototype._finish = function (kind, err) {
    if (this._done) return;
    this._done = true;
    if (kind === "complete") this._fire("complete");
    else { if (kind === "error") this._fire("error", { error: err }); this._fire("abort"); }
  };

  function ObjStore(tx, name) {
    this.transaction = tx; this.name = name;
    var meta = tx.db._meta.stores[name] || {};
    this.keyPath = meta.keyPath; this.autoIncrement = meta.autoIncrement;
    this.indexNames = []; this.indexNames.contains = function () { return false; };
  }
  ObjStore.prototype._map = function () { return storeMap(this.transaction.db.name, this.name); };
  ObjStore.prototype._write = function () {
    if (this.transaction.mode === "readonly") throw domError("ReadOnlyError", "транзакция только для чтения");
  };
  ObjStore.prototype._keyOf = function (value, key) {
    var meta = this.transaction.db._meta.stores[this.name];
    if (meta.keyPath != null) {
      var k = value == null ? undefined : value[meta.keyPath];
      if (k === undefined && meta.autoIncrement) { k = meta.next++; value[meta.keyPath] = k; }
      return k;
    }
    if (key === undefined && meta.autoIncrement) key = meta.next++;
    return key;
  };
  ObjStore.prototype.put = function (value, key) { return this._putOrAdd(value, key, false); };
  ObjStore.prototype.add = function (value, key) { return this._putOrAdd(value, key, true); };
  ObjStore.prototype._putOrAdd = function (value, key, noOverwrite) {
    this._write();
    var self = this, db = self.transaction.db, k = self._keyOf(value, key);
    if (typeof k !== "string" && typeof k !== "number") throw domError("DataError", "ключ записи — строка или число");
    var map = self._map();
    return self.transaction._op(self, function () {
      if (noOverwrite && map.has(k)) throw domError("ConstraintError", "запись с таким ключом уже есть");
      var old = map.get(k), rec = {}, jobs = [];
      Object.keys(value).forEach(function (f) {
        var v = value[f];
        if (typeof Blob !== "undefined" && v instanceof Blob) {
          rec[f] = { $hubBlob: true, type: v.type || "", size: v.size, name: typeof File !== "undefined" && v instanceof File ? v.name : undefined };
          jobs.push(data.set(idbBlobPrefix(db.name, self.name) + keyToken(k) + "/" + encPart(f), v));
        } else rec[f] = v;
      });
      rec = JSON.parse(JSON.stringify(rec));
      if (old) Object.keys(old).forEach(function (f) {
        if (old[f] && old[f].$hubBlob && !(rec[f] && rec[f].$hubBlob)) jobs.push(data.remove(idbBlobPrefix(db.name, self.name) + keyToken(k) + "/" + encPart(f)));
      });
      map.set(k, rec);
      jobs.push(data.set(idbRecPrefix(db.name, self.name) + keyToken(k), rec));
      if (db._meta.stores[self.name].autoIncrement) jobs.push(data.set(idbMetaKey(db.name), db._meta));
      return Promise.all(jobs).then(function () { return k; });
    });
  };
  function hydrate(dbName, stName, k, rec, full) {
    var out = clone(rec), jobs = [];
    Object.keys(out).forEach(function (f) {
      var v = out[f];
      if (!v || !v.$hubBlob) return;
      if (!full && v.size > LAZY_LIMIT) {
        var stub = new Blob([], { type: v.type });
        try { Object.defineProperty(stub, "__hubLazy", { value: true }); } catch (e) { /* ничего */ }
        out[f] = stub; return;
      }
      jobs.push(data.get(idbBlobPrefix(dbName, stName) + keyToken(k) + "/" + encPart(f)).then(function (b) {
        b = b || new Blob([], { type: v.type });
        if (v.name && typeof File === "function") { try { b = new File([b], v.name, { type: v.type }); } catch (e) { /* без имени */ } }
        out[f] = b;
      }));
    });
    return Promise.all(jobs).then(function () { return out; });
  }
  function dropRecord(dbName, stName, k, rec) {
    var jobs = [data.remove(idbRecPrefix(dbName, stName) + keyToken(k))];
    if (rec) Object.keys(rec).forEach(function (f) {
      if (rec[f] && rec[f].$hubBlob) jobs.push(data.remove(idbBlobPrefix(dbName, stName) + keyToken(k) + "/" + encPart(f)));
    });
    return Promise.all(jobs);
  }
  function inRange(k, q) {
    if (q === undefined || q === null) return true;
    if (typeof q !== "object") return cmpKeys(k, q) === 0;
    if (q.lower !== undefined) { var c = cmpKeys(k, q.lower); if (c < 0 || (c === 0 && q.lowerOpen)) return false; }
    if (q.upper !== undefined) { var d = cmpKeys(k, q.upper); if (d > 0 || (d === 0 && q.upperOpen)) return false; }
    return true;
  }
  ObjStore.prototype._keys = function (q, count) {
    var keys = Array.from(this._map().keys()).filter(function (k) { return inRange(k, q); }).sort(cmpKeys);
    return count ? keys.slice(0, count) : keys;
  };
  ObjStore.prototype.get = function (q) {
    var self = this, db = self.transaction.db;
    return self.transaction._op(self, function () {
      var k = self._keys(q, 1)[0];
      if (k === undefined) return undefined;
      return hydrate(db.name, self.name, k, self._map().get(k), true);
    });
  };
  ObjStore.prototype.getAll = function (q, count) {
    var self = this, db = self.transaction.db;
    return self.transaction._op(self, function () {
      var map = self._map();
      return Promise.all(self._keys(q, count).map(function (k) { return hydrate(db.name, self.name, k, map.get(k), false); }));
    });
  };
  ObjStore.prototype.getKey = function (q) { var self = this; return self.transaction._op(self, function () { return self._keys(q, 1)[0]; }); };
  ObjStore.prototype.getAllKeys = function (q, count) { var self = this; return self.transaction._op(self, function () { return self._keys(q, count); }); };
  ObjStore.prototype.count = function (q) { var self = this; return self.transaction._op(self, function () { return self._keys(q).length; }); };
  ObjStore.prototype.delete = function (q) {
    this._write();
    var self = this, db = self.transaction.db;
    return self.transaction._op(self, function () {
      var map = self._map();
      return Promise.all(self._keys(q).map(function (k) { var rec = map.get(k); map.delete(k); return dropRecord(db.name, self.name, k, rec); }))
        .then(function () { return undefined; });
    });
  };
  ObjStore.prototype.clear = function () {
    this._write();
    var self = this, db = self.transaction.db;
    return self.transaction._op(self, function () {
      var map = self._map(), jobs = [];
      map.forEach(function (rec, k) { jobs.push(dropRecord(db.name, self.name, k, rec)); });
      map.clear();
      return Promise.all(jobs).then(function () { return undefined; });
    });
  };
  ObjStore.prototype.openCursor = ObjStore.prototype.openKeyCursor = ObjStore.prototype.index = ObjStore.prototype.createIndex = function () {
    throw domError("NotSupportedError", "курсоры и индексы в хабе пока не поддержаны — используйте getAll()");
  };

  var hubIDB = {
    open: function (name, version) {
      name = String(name);
      var req = new Req(null, null);
      req.onupgradeneeded = null; req.onblocked = null;
      setTimeout(function () {
        var meta = data.peek(idbMetaKey(name)) || { version: 0, stores: {} };
        if (version === undefined) version = meta.version || 1;
        if (version < meta.version) { req.error = domError("VersionError", "версия базы меньше сохранённой"); req.readyState = "done"; req._fire("error"); return; }
        var db = new DB(name, meta);
        req.result = db;
        var after = Promise.resolve();
        if (version > meta.version) {
          var oldVersion = meta.version;
          meta.version = version; db.version = version;
          var tx = new Tx(db, Object.keys(meta.stores), "versionchange");
          db._upgrading = tx; req.transaction = tx;
          req._fire("upgradeneeded", { oldVersion: oldVersion, newVersion: version });
          db._upgrading = null; req.transaction = null;
          after = data.set(idbMetaKey(name), meta);
        }
        after.then(function () { req.readyState = "done"; req._fire("success"); },
                   function (e) { req.error = e; req.readyState = "done"; req._fire("error"); });
      }, 0);
      return req;
    },
    deleteDatabase: function (name) {
      var req = new Req(null, null);
      setTimeout(function () {
        var pre = IDB + encPart(name) + "/", jobs = [];
        Object.keys(store).concat(Object.keys(blobMeta)).forEach(function (k) { if (k.indexOf(pre) === 0) jobs.push(data.remove(k)); });
        delete idbCache[name];
        Promise.all(jobs).then(function () { req.readyState = "done"; req._fire("success"); });
      }, 0);
      return req;
    },
    databases: function () {
      var names = {};
      Object.keys(store).forEach(function (k) { if (k.indexOf(IDB) === 0 && /\/_meta$/.test(k)) names[decodeURIComponent(k.slice(IDB.length, -6))] = store[k].version; });
      return Promise.resolve(Object.keys(names).map(function (n) { return { name: n, version: names[n] }; }));
    },
    cmp: function (a, b) { return cmpKeys(a, b); }
  };
  define("indexedDB", hubIDB);
  if (typeof window.IDBKeyRange === "undefined" || !window.IDBKeyRange.only) {
    define("IDBKeyRange", {
      only: function (v) { return { lower: v, upper: v }; },
      lowerBound: function (v, open) { return { lower: v, lowerOpen: !!open }; },
      upperBound: function (v, open) { return { upper: v, upperOpen: !!open }; },
      bound: function (a, b, ao, bo) { return { lower: a, upper: b, lowerOpen: !!ao, upperOpen: !!bo }; }
    });
  }

  /* ───────── активность — для автозамка хаба ───────── */
  var lastPing = 0;
  function ping() { var t = Date.now(); if (t - lastPing > 20000) { lastPing = t; send("activity", {}); } }
  ["keydown", "pointerdown", "wheel", "touchstart"].forEach(function (ev) { document.addEventListener(ev, ping, { capture: true, passive: true }); });

  /* ───────── горячие клавиши хаба ─────────
     Пока фокус внутри приложения, клавиши хаба всё равно должны работать: передаём их хабу. */
  document.addEventListener("keydown", function (e) {
    var k = null;
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "Space") k = "capture";
    else if (e.ctrlKey && !e.altKey && e.code === "KeyK") k = "command";
    else if (e.ctrlKey && !e.altKey && e.code === "KeyL") k = "lock";
    else if (e.altKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) k = "app:" + e.code.slice(5);
    if (!k) return;
    e.preventDefault(); e.stopPropagation();
    send("hotkey", { key: k });
  }, true);
})();
