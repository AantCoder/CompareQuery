// CompareQuery GUI: интерфейс (экраны и компоненты - GUI.md). Данные - через api() из CompareQueryGUI.py.
"use strict";

// строка внизу левой панели (под «Справка»); ссылка открывается в браузере
const ABOUT_TEXT = "v1.1 · © 2026 Ant · MIT License ·";
const ABOUT_LINK = {text: "GitHub", url: "https://github.com/AantCoder/CompareQuery"};

// ================================================================ связь с Python
// Режим --dev отмечает сам сервер отладки (window.CQ_DEV в index.html), а не догадка по времени: окно pywebview
// отдает gui/ своим HTTP-сервером, и POST туда возвращал страницу ошибки («Unexpected token '<'»).
function api(name, ...args) {
  if (!window.CQ_DEV) return window.pywebview.api[name](...args);
  return fetch("/api/" + name, {method: "POST", body: JSON.stringify(args)}).then(async r => {
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  });
}

const S = {
  st: null,          // состояние папки (api.state)
  seq: 0,            // последнее полученное событие
  procs: {},         // id -> {info, events: []}
  view: {k: "empty"},
  history: [],       // [{view, title}]
  pair: [],          // выбранные Ctrl+кликом отчеты
  sort: {},          // id таблицы -> {col, dir}
  live: {},          // состояние живых экранов (стопка, строка консоли)
  runNotes: {},      // id идущего запуска -> заметка (имя отчета известно только в конце запуска)
  cancelled: {},     // id наблюдений, отмененных «Отменить наблюдение»: по окончании папка - в корзину
  queue: null,       // {name, p}: скрипт, который запустится после текущего запуска («В очередь»)
};
const runBusy = () => Object.values(S.procs).some(p => p.info.kind === "run" && p.info.running);

// ================================================================ мелочи
const h = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
// \u0447\u0438\u0441\u043b\u0430 - \u043f\u043e \u044f\u0437\u044b\u043a\u0443 \u0438\u043d\u0442\u0435\u0440\u0444\u0435\u0439\u0441\u0430: 1 234 567 (ru) \u0438\u043b\u0438 1,234,567 (en)
// \u0444\u043e\u0440\u043c\u0430\u0442\u0442\u0435\u0440 - \u043e\u0434\u0438\u043d \u043d\u0430 \u044f\u0437\u044b\u043a: toLocaleString \u0441\u043e\u0437\u0434\u0430\u0435\u0442 \u0435\u0433\u043e \u043d\u0430 \u043a\u0430\u0436\u0434\u044b\u0439 \u0432\u044b\u0437\u043e\u0432 (\u0436\u0443\u0440\u043d\u0430\u043b \u043d\u0430 3600 \u0441\u0442\u0440\u043e\u043a \u0441\u043e\u0431\u0438\u0440\u0430\u043b\u0441\u044f \u0432 \u0440\u0430\u0437\u044b \u0434\u043e\u043b\u044c\u0448\u0435)
let nfFmt = null, nfLang = "";
const nf = v => {
  if (v === null || v === undefined || v === "" || isNaN(+v)) return v ?? "";
  if (nfLang !== LANG) { nfLang = LANG; nfFmt = new Intl.NumberFormat(LANG === "ru" ? "ru-RU" : "en-US", {maximumFractionDigits: 3}); }
  return nfFmt.format(+v).replace(/\u00a0|\u202f/g, " ");
};
const $ = sel => document.querySelector(sel);
function pad(n, w = 2) { return String(n).padStart(w, "0"); }
function clock(ms, frac) {           // =мм:сс / чч:мм:сс / дд.чч:мм:сс (§5.1); frac - с миллисекундами
  ms = Math.max(0, Math.floor(ms));
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600);
  let t = s < 3600 ? `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
        : s < 86400 ? `${pad(hh)}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}`
        : `${d}.${pad(hh)}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}`;
  return frac ? t + "." + pad(ms % 1000, 3) : t;
}
const dur = ms => ms >= 1000 ? "=" + clock(ms) : "";
// день и месяц: 12.11 (ru) или Nov 12 (en)
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayMonth = (d, m) => LANG === "ru" ? `${pad(d)}.${pad(m)}` : `${MONTHS_EN[m - 1]} ${+d}`;
const tsText = (ts, sec) => ts ? `${dayMonth(ts.slice(6, 8), +ts.slice(4, 6))} ${ts.slice(9, 11)}:${ts.slice(11, 13)}` + (sec ? ":" + ts.slice(13, 15) : "") : "";
const evMs = ev => Date.parse(ev.time);
// Время суток показывается по часам сервера. Поле time событий и время старта процесса - часы этого
// компьютера (по ним считается бегущее время); событие clock дает часы сервера на тот же момент.
function srvOffset(p) {
  if (!p) return 0;
  if (p.off === undefined) {
    const c = p.events.find(e => e.event === "clock");
    if (!c) return 0;
    p.off = Date.parse(c.server_time) - evMs(c);
  }
  return p.off;
}
const srvDate = (p, ms) => new Date(ms + srvOffset(p));
const hms = (d, frac) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` + (frac ? "." + pad(d.getMilliseconds(), 3) : "");
const dmhm = d => `${dayMonth(d.getDate(), d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const procWhen = p => dmhm(srvDate(p, Date.parse(p.info.started)));
// Быстрые подсказки: вместо системных (появляются через ~1 с) - своя через QTIP_MS после наведения.
// title элемента на время наведения переносится в data-qtip, чтобы системная не появлялась поверх.
const QTIP_MS = 120;
let qtipTimer = 0, qtipEl = null;
function qtipHide() {
  clearTimeout(qtipTimer);
  const tip = $("#qtip");
  if (tip) tip.remove();
  if (qtipEl && qtipEl.dataset.qtip !== undefined) { qtipEl.setAttribute("title", qtipEl.dataset.qtip); delete qtipEl.dataset.qtip; }
  qtipEl = null;
}
document.addEventListener("mouseover", e => {
  const el = e.target.closest && e.target.closest("[title]:not(svg *), [data-qtip]");
  if (el === qtipEl) return;
  qtipHide();
  if (!el || !(el.getAttribute("title") || el.dataset.qtip)) return;
  qtipEl = el;
  if (el.hasAttribute("title")) { el.dataset.qtip = el.getAttribute("title"); el.removeAttribute("title"); }
  qtipTimer = setTimeout(() => {
    if (qtipEl !== el || !el.isConnected) return;
    const tip = document.createElement("div"), r = el.getBoundingClientRect();
    tip.id = "qtip";
    tip.className = "qtip";
    tip.textContent = el.dataset.qtip;
    document.body.appendChild(tip);
    const w = tip.offsetWidth, hgt = tip.offsetHeight;
    tip.style.left = Math.max(6, Math.min(innerWidth - w - 6, r.left + r.width / 2 - w / 2)) + "px";
    tip.style.top = (r.bottom + 6 + hgt > innerHeight ? r.top - hgt - 6 : r.bottom + 6) + "px";
  }, QTIP_MS);
});
document.addEventListener("mousedown", qtipHide, true);
// заполненный фильтр-список (select.flt: первый вариант - «все») - зеленая рамка (.set); текстовый - по CSS
document.addEventListener("change", e => { if (e.target.matches && e.target.matches("select.flt")) fltMark(e.target); });
const fltMark = sel => sel.classList.toggle("set", sel.selectedIndex > 0);
const fltMarks = root => root.querySelectorAll("select.flt").forEach(fltMark);
// крестик текстового фильтра: очистить и применить (обработчик input фильтра)
const FLX = `<span class="flx" onmousedown="event.preventDefault()" onclick="fltClear(this)">×</span>`;
function fltClear(x) {
  const i = x.parentNode.querySelector("input");
  i.value = "";
  i.dispatchEvent(new Event("input", {bubbles: true}));
  i.focus();
}
document.addEventListener("scroll", qtipHide, true);
// Контекстное меню: items - [ключ, значок (html), подпись (html), класс] или "-" (разделитель);
// pick(ключ) - действие выбранного пункта.
function ctxMenu(e, items, pick) {
  e.preventDefault();
  qtipHide();
  ctxClose();
  const m = document.createElement("div");
  m.id = "ctxm";
  m.className = "ctxm";
  m.innerHTML = items.map(x => x === "-" ? "<hr>" : `<a data-k="${h(x[0])}" class="${x[3] || ""}">${x[1]}<span>${x[2]}</span></a>`).join("");
  m.addEventListener("click", ev => {
    const a = ev.target.closest("a");
    if (!a) return;
    ctxClose();
    pick(a.dataset.k);
  });
  document.body.appendChild(m);
  m.style.left = Math.min(e.clientX, innerWidth - m.offsetWidth - 6) + "px";
  m.style.top = Math.min(e.clientY, innerHeight - m.offsetHeight - 6) + "px";
}
// Правая кнопка по строке таблицы: те же действия, что кнопки в начале строки (td.acts2), с подписями
// из их подсказок (кнопки .ctxonly есть только в меню); при выделенном тексте первым - «Скопировать».
document.addEventListener("contextmenu", e => {
  const tr = e.target.closest && e.target.closest("tr");
  const btns = tr ? [...tr.querySelectorAll("td.acts2 .ib:not(.off)")] : [];     // кнопок-столбцов может быть несколько
  if (!btns.length) return;
  const sel = String(window.getSelection() || "");
  const items = (sel ? [["copy", I.copy(14), t("Скопировать")], "-"] : [])
    .concat(btns.map((b, i) => [String(i), b.innerHTML, h(b.getAttribute("title") || b.dataset.qtip || ""), b.classList.contains("danger") ? "danger" : ""]));
  ctxMenu(e, items, k => k === "copy" ? navigator.clipboard.writeText(sel).then(() => toast(t("Скопировано")), fail) : btns[+k].click());
});
function ctxClose() { const m = $("#ctxm"); if (m) m.remove(); }
document.addEventListener("mousedown", e => { if (!(e.target.closest && e.target.closest("#ctxm"))) ctxClose(); }, true);
document.addEventListener("scroll", ctxClose, true);
window.addEventListener("keydown", e => { if (e.key === "Escape") ctxClose(); });
function toast(msg, err) {
  const el = document.createElement("div");
  el.className = "toastm" + (err ? " err" : "");
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), err ? 8000 : 3500);
}
function fail(e) { toast(String(e && e.message || e), true); }

const I = {
  bolt: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z"/></svg>`,
  code: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4.5l-3 15"/></svg>`,
  warn: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M12 2.8 1.8 20.6h20.4z" fill="#FCC419" stroke="#E8590C" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 9.2v5.4" stroke="#1B2230" stroke-width="2.3" stroke-linecap="round"/><circle cx="12" cy="17.4" r="1.35" fill="#1B2230"/></svg>`,
  folder: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/></svg>`,
  db: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>`,
  pen: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`,
  plus: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  eye: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`,
  down: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>`,
  right: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>`,
  back: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>`,
  play: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12-7.5z"/></svg>`,
  stop: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>`,
  spark: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="#3B5BDB"><path d="M12 1.5l2.3 7.2 7.2 2.3-7.2 2.3L12 20.5l-2.3-7.2L2.5 11l7.2-2.3z"/><path d="M19.5 15.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z"/></svg>`,     // «новый»
  star: (s, fill) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="${fill ? "#E8A21A" : "none"}" stroke="#B45309" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>`,
  trash: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>`,
  copy: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>`,
  open: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`,
  note: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h14v11l-5 5H5z"/><path d="M14 20v-5h5M9 9h6M9 12.5h4"/></svg>`,
  search: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="#6E788B" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>`,
  refresh: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>`,
  sliders: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>`,
  help: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01"/></svg>`,
  globe: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>`,
  plan: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="4" width="7" height="5" rx="1"/><rect x="14" y="4" width="7" height="5" rx="1"/><rect x="8.5" y="15" width="7" height="5" rx="1"/><path d="M6.5 9v3h11V9M12 12v3"/></svg>`,
  cancel: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none"/></svg>`,
  input: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5M3 12h11M10 8l4 4-4 4"/></svg>`,
  kill: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>`,
  pulse: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.5-6 4 12 2.5-6H21"/></svg>`,
  flame: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2.5 1.5-4 2.5-5 .3 1.6 1 2.6 2 3 .5-2.5-.5-5.5.5-8z"/></svg>`,
  cols: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M9.5 4v16M14.5 4v16"/></svg>`,
  filter: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 5h16l-6.5 7.5V19l-3-1.5v-5z"/></svg>`,
  diff: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="7.5" height="16" rx="1.5"/><rect x="13.5" y="4" width="7.5" height="16" rx="1.5"/><path d="M6 9h2M6 13h2M16.5 9h2M16.5 13h2"/></svg>`,
  up: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V5.5M5 12l7-7 7 7"/></svg>`,
  dn: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v14.5M5 12l7 7 7-7"/></svg>`,
  save: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 4h11l3 3v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/></svg>`,
};

// категории ожиданий (§5.3)
function waitCat(name) {
  const n = (name || "").toUpperCase();
  if (n.startsWith("LCK_M_") || n.startsWith("LOCK:")) return "lock";
  if (n === "CPU") return "cpu";
  if (n.startsWith("IO:")) return "disk";
  if (n.startsWith("CLIENT:")) return "net";
  if (n.startsWith("LWLOCK:BUFFER")) return "page";     // страницы буферного кэша
  if (n.startsWith("LWLOCK:WAL") || n === "IPC:BUFFERIO") return "disk";    // запись WAL, чтение страницы другим процессом
  if (/^IPC:(EXECUTEGATHER|BGWORKER|PARALLEL|MESSAGEQUEUE|HASH)/.test(n)) return "par";
  if (/^(PAGEIOLATCH|WRITELOG|IO_COMPLETION|ASYNC_IO_COMPLETION|LOGBUFFER)/.test(n)) return "disk";
  if (/^(RESOURCE_SEMAPHORE|CMEMTHREAD|MEMORY_ALLOCATION_EXT)/.test(n)) return "mem";
  if (/^(SOS_SCHEDULER_YIELD|THREADPOOL)/.test(n)) return "cpu";
  if (/^(CXPACKET|CXCONSUMER|CXSYNC_)/.test(n)) return "par";
  if (/^(PAGELATCH|LATCH_)/.test(n)) return "page";
  if (n === "ASYNC_NETWORK_IO") return "net";
  return "oth";
}
const waitHtml = name => `<span class="w w-${waitCat(name)}">${h(name)}</span>`;

// ================================================================ навигация (§5.12)
function titleOf(v) {
  switch (v.k) {
    case "script": return v.name;
    case "run": { const p = S.procs[v.pid]; return p && p.info.script ? p.info.script + ".sql" : t("Идет запуск"); }
    case "result": return t("Итог запуска {when}", {when: tsText((v.report.match(/_(\d{8}_\d{6})/) || [])[1])});
    case "table": return t("Таблица {n}", {n: v.n});
    case "compare": return t("Сравнение");
    case "newsession": return t("Новое наблюдение");
    case "session": return t("Идет наблюдение");
    case "current": return t("Текущие запросы");
    case "load": return t("Нагрузка сервера");
    case "dbinfo": return t("База данных");
    case "sessiondone": return t("Итог наблюдения · сессия {n}", {n: (v.folder.match(/^Session_\d{8}_\d{6}_(\d+)/) || [])[1]});
    default: return "";
  }
}
function go(v, replace) {
  if (T.newTab) { T.newTab = false; tabNew(); replace = true; }    // средняя кнопка в панели - в новой вкладке
  if (!replace && S.view.k !== "empty") S.history.push({view: S.view});
  if (S.history.length > 50) S.history.shift();
  S.view = v;
  S.live = {};
  $("#main").scrollTop = 0;     // новый экран - сверху (итог запуска открывался прокрученным, как экран запуска)
  renderSide();
  renderMain();
}
function back() {
  const prev = S.history.pop();
  if (prev) { S.view = prev.view; S.live = {}; $("#main").scrollTop = 0; renderSide(); renderMain(); }
}
function backLine() {
  const prev = S.history[S.history.length - 1];
  return `<span class="ctxl">${h(S.st ? S.st.folder : "")}</span>`;     // «Назад» - в строке вкладок
}

// ================================================================ вкладки (GUI.md §5.24)
// Вкладка - свой экран: view, history, live и свой узел #main. Неактивная вкладка вынута из документа
// целиком: анимации стоят, обновления ее не находят (ищут по S.view и $("#...")), запросы с нее не идут.
// Экран, который не дорисовался, пока вкладка была неактивна, при возврате рисуется заново (stale).
const T = {list: [], cur: null, seq: 0, newTab: false};
function tabNew(view, history) {             // новая вкладка после текущей, сразу активная
  const tab = {id: ++T.seq, view: view || {k: "empty"}, history: history || [], live: {}, node: null};
  T.list.splice(T.list.indexOf(T.cur) + 1, 0, tab);
  tabActivate(tab);
  return tab;
}
function tabActivate(tab) {
  if (tab === T.cur) return;
  const c = T.cur;
  if (c) c.find = !!F.box;
  findClose(); ctxClose(); qtipHide();
  const old = $("#main");
  if (c) {
    Object.assign(c, {view: S.view, history: S.history, live: S.live, node: old});
    // прокрутка вынутого узла теряется - запоминается у всех прокрученных элементов
    c.scroll = [old, ...old.querySelectorAll("*")].filter(e => e.scrollTop || e.scrollLeft).map(e => [e, e.scrollTop, e.scrollLeft]);
  }
  T.cur = tab;
  S.view = tab.view; S.history = tab.history; S.live = tab.live;
  if (tab.node) {
    old.replaceWith(tab.node);
    for (const [e, y, x] of tab.scroll || []) { e.scrollTop = y; e.scrollLeft = x; }
    if (tab.stale) { tab.stale = false; S.live = tab.live = {}; renderMain(); }
  } else {
    const n = document.createElement("main");
    n.className = "main"; n.id = "main";
    old.replaceWith(n);
    renderMain();
  }
  renderSide();
  if (tab.find) findOpen(false);
}
function tabClose(id) {
  const tab = T.list.find(x => x.id === id);
  if (!tab || T.list.length < 2) return;
  const i = T.list.indexOf(tab);
  if (tab === T.cur) tabActivate(T.list[i + 1] || T.list[i - 1]);
  T.list.splice(T.list.indexOf(tab), 1);
  renderTabs();
}
function tabIcon(v) {
  const p = v.pid && S.procs[v.pid];
  if (p && p.info.running) return `<span class="pulse"></span>`;
  if (S.st && v.report && S.st.reference === v.report) return I.star(13, true);
  return ({script: I.note, run: I.play, result: I.play, table: I.cols, compare: I.diff, newsession: I.eye, session: I.eye,
           sessiondone: I.eye, current: I.pulse, load: I.flame, dbinfo: I.db}[v.k] || I.plus)(13);
}
function renderTabs() {
  const bar = $("#tabs");
  if (!bar || !T.cur) return;
  T.cur.view = S.view;
  const show = T.list.length > 1 || S.view.k !== "empty";
  bar.style.display = show ? "" : "none";
  if (!show) return;
  const prev = S.history[S.history.length - 1];
  const html = `<span class="tback${prev ? "" : " off"}" ${prev ? `title="${h(titleOf(prev.view))}" onclick="back()"` : ""}>${I.back(13)}${t("Назад")}</span>` +
    T.list.map(x => `<span class="tab${x === T.cur ? " on" : ""}" data-tab="${x.id}" onclick="tabActivate(T.list.find(y => y.id === ${x.id}))" title="${h(titleOf(x.view) || t("Новая вкладка"))}">` +
      `<span class="tic">${tabIcon(x.view)}</span><span class="tnm">${h(titleOf(x.view) || t("Новая вкладка"))}</span>` +
      (T.list.length > 1 ? `<span class="tx" onclick="event.stopPropagation();tabClose(${x.id})">×</span>` : "") + `</span>`).join("") +
    `<span class="tadd" title="${t("Новая вкладка")}" onclick="tabNew()">${I.plus(13)}</span>`;
  if (bar.innerHTML !== html) bar.innerHTML = html;        // панель перерисовывается каждую секунду - без нужды не трогать
}
// контекстное меню вкладки: «Создать дубликат» (не для выбора сессии), «Закрыть» (не последняя)
document.addEventListener("contextmenu", e => {
  const el = e.target.closest && e.target.closest(".tab");
  if (!el) return;
  e.preventDefault();
  ctxClose();
  const tab = T.list.find(x => x.id === +el.dataset.tab), v = tab === T.cur ? S.view : tab.view;
  const items = [];
  if (v.k !== "newsession" && v.k !== "empty") items.push(["dup", I.copy(14), t("Создать дубликат")]);
  if (T.list.length > 1) items.push(["close", I.kill(14), t("Закрыть")]);
  if (!items.length) return;
  ctxMenu(e, items, k => {
    if (k === "close") tabClose(tab.id);
    else { tabActivate(tab); tabNew(Object.assign({}, S.view), S.history.slice()); }
  });
});
// Правая кнопка по пункту левой панели (data-ctx - вид пункта, data-id - его имя): действия пункта
document.addEventListener("contextmenu", e => {
  const el = e.target.closest && e.target.closest("#side [data-ctx]");
  if (!el) return;
  const k = el.dataset.ctx, id = el.dataset.id, st = S.st, items = [], act = {};
  const add = (key, icon, text, fn, cls) => { items.push([key, icon, text, cls]); act[key] = fn; };
  const tab = v => add("tab", I.open(14), t("Открыть в новой вкладке"), () => { T.newTab = true; go(v); });
  const folder = path => add("folder", I.folder(14), t("Показать в папке"), () => api("show_in_folder", st.folder + "\\" + path));
  const del = fn => { items.push("-"); add("del", I.trash(14), t("Удалить…"), fn, "danger"); };
  if (k === "script") {
    add("run", I.play(14), t("Запустить"), () => needConn() || startRun(id));
    if (runBusy()) add("queue", I.play(14), t("Запустить после текущего"), () => needConn() || queueRun(id));
    tab({k: "script", name: id});
    items.push("-");
    add("ign", I.filter(14), t("Игнорируемые колонки"), () => ignoreDialog(id));
    add("copy", I.copy(14), t("Сделать копию…"), () => copyScriptDialog(id));
    folder(id);
    del(() => deleteScript(id));
  } else if (k === "run") {
    tab({k: "result", report: id});
    if (st.reference && st.reference !== id) add("cmp", I.diff(14), t("Сравнить с опорным"), () => startCompare(st.reference, id));
    if (st.reference !== id && !el.dataset.aborted) add("ref", I.star(14), t("Пометить опорным"), () => setReference(id));
    add("script", I.note(14), t("Открыть скрипт"), () => go({k: "script", name: reportStem(id) + ".sql"}));
    folder(id);
    del(() => deleteRun(id));
  } else if (k === "sess") {
    tab({k: "sessiondone", folder: id});
    const ref = st.session_reference;
    if (ref && ref !== id) add("cmp", I.diff(14), t("Сравнить с опорным"), () => startSessionCompare(ref, id));
    if (ref === id) add("ref", I.star(14), t("Снять пометку"), () => setSessionReference(null));
    else add("ref", I.star(14), t("Пометить опорным"), () => setSessionReference(id));
    folder("Sessions_profile\\" + id + "\\registry.txt");
    del(() => deleteSession(id));
  } else if (k === "proc") {
    const p = S.procs[id];
    if (!p) return;
    tab({k: p.info.kind === "session" ? "session" : "run", pid: +id});
    add("stop", I.stop(14), p.info.kind === "session" ? t("Не наблюдать и сохранить") : t("Остановить"), () => api("stop", +id).catch(fail), "danger");
    if (p.info.kind === "session") add("cancel", I.trash(14), t("Отменить наблюдение"), () => cancelSession(+id), "danger");
  }
  ctxMenu(e, items, key => act[key]());
});
// средняя кнопка по пункту левой панели - открыть в новой вкладке (Ctrl+клик там уже занят выбором пары)
document.addEventListener("auxclick", e => {
  const el = e.button === 1 && e.target.closest && e.target.closest("#side [onclick]");
  if (!el) return;
  e.preventDefault();
  T.newTab = true;
  el.click();
  T.newTab = false;
});
document.addEventListener("mousedown", e => { if (e.button === 1 && e.target.closest && e.target.closest("#side")) e.preventDefault(); });
window.addEventListener("keydown", e => {
  if (e.altKey && e.key === "ArrowLeft") { back(); e.preventDefault(); }
  if (e.key === "Escape") { if ($("#modal").innerHTML) closeModal(); else if (S.pair.length) { S.pair = []; renderSide(); } else if (F.box) findClose(); }
  // e.code - физическая клавиша: сочетания работают в любой раскладке
  if (e.ctrlKey && e.code === "KeyS" && S.view.k === "script") { e.preventDefault(); saveScript(true).catch(fail); }
  if (e.ctrlKey && e.code === "KeyF" && S.view.k === "table") { e.preventDefault(); const i = $("#t-flt"); if (i) i.focus(); }
  else if (e.ctrlKey && e.code === "KeyF") { e.preventDefault(); findOpen(); }
  if (e.key === "F3") { e.preventDefault(); const had = F.box; if (!had) findOpen(); if (had || F.q) findGo(e.shiftKey ? -1 : 1); }
});

// ================================================================ поиск по странице (Ctrl+F, F3)
// Только по уже показанному: строки таблиц #main (текст ячеек и их подсказки - там полный текст
// оператора). Перерисовка экрана (идущий запуск, наблюдение) - поиск повторяется сам.
// Текст поиска F.q - общий для всех вкладок; показано ли окошко - у каждой вкладки свое (tab.find).
// Поиск - скрытое регулярное выражение (findRe): пробельные символы подряд (пробел, табуляция, переводы
// строк) - любое их число, регистр не важен. Текст, скопированный из сокращенного начала оператора
// (переводы строк там - пробелы), находится и в полном тексте, и в редакторе SQL.
const F = {box: null, hits: [], i: -1, obs: null, timer: 0, q: "", anchor: null};
const findRe = (q, g = "") => { q = q.trim(); return q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "i" + g) : null; };
function findOpen(focus = true) {
  if (!F.box) {
    F.box = document.createElement("div");
    F.box.className = "findbox";
    F.box.innerHTML = `<input placeholder="${t("Поиск на странице")}"><span class="fcnt"></span>` +
      `<span class="ib" title="${t("Предыдущее совпадение")} (Shift+F3)" onclick="findGo(-1)">‹</span><span class="ib" title="${t("Следующее совпадение")} (F3)" onclick="findGo(1)">›</span>` +
      `<span class="ib" title="${t("Закрыть")} (Esc)" onclick="findClose()">×</span>`;
    document.body.appendChild(F.box);
    const inp = F.box.querySelector("input");
    inp.addEventListener("input", () => { F.q = inp.value; F.i = -1; findRun(); findGo(1, true); });
    inp.addEventListener("keydown", e => {
      if (e.key === "Enter") findGo(e.shiftKey ? -1 : 1);
      if (e.key === "Escape") { findClose(); e.stopPropagation(); }
    });
    F.obs = new MutationObserver(() => { clearTimeout(F.timer); F.timer = setTimeout(findRun, 200); });
    F.obs.observe($("#main"), {childList: true, subtree: true});
  }
  const inp = F.box.querySelector("input");
  if (inp.value !== F.q) inp.value = F.q;
  if (focus) { inp.focus(); inp.select(); }
  findRun();
}
function findClose() {
  if (!F.box) return;
  F.obs.disconnect();
  F.box.remove();
  F.box = null;
  F.i = -1;
  findMark([]);
}
function findMark(hits) {
  document.querySelectorAll("#main .fhit").forEach(x => x.classList.remove("fhit", "fcur"));
  hits.forEach(x => x.classList.add("fhit"));
}
function findRun() {
  if (!F.box) return;
  const q = findRe(F.q);
  const rows = q ? [...document.querySelectorAll("#main tbody tr, #main .trow")] : [];
  // строка, по оператору которой кликнули (F.anchor), становится текущим совпадением
  const cur = F.anchor && F.anchor.isConnected ? F.anchor : F.hits[F.i], ta = $("#code");
  F.anchor = null;
  if (ta) {                                         // редактор SQL: совпадения - позиции в тексте
    F.hits = q ? [...ta.value.matchAll(findRe(F.q, "g"))].filter(m => m[0]).map(m => [m.index, m[0].length]) : [];      // [начало, длина]
  } else F.hits = rows.filter(r => q.test(r.textContent + " " + [...r.querySelectorAll("[title]")].map(x => x.title).join(" ")));
  findMark(ta ? [] : F.hits);
  const at = F.hits.indexOf(cur);
  F.i = at >= 0 ? at : Math.min(F.i, F.hits.length - 1);      // после перерисовки - та же позиция
  if (F.hits[F.i] && !ta) F.hits[F.i].classList.add("fcur");
  F.box.querySelector(".fcnt").textContent = q ? (F.hits.length ? `${F.i + 1} ${t("из")} ${F.hits.length}` : t("нет")) : "";
  if (q && $("#main [data-more]")) {               // часть строк не показана - ищется только по показанным
    F.box.querySelector(".fcnt").textContent += " · " + t("не все строки");
    F.box.querySelector(".fcnt").title = t("Показаны не все строки таблиц: «показать еще» под таблицей");
  }
}
function findGo(d, typing) {
  if (!F.hits.length) return findRun();
  F.i = (F.i + d + F.hits.length) % F.hits.length;
  const ta = $("#code");
  if (ta) {             // выделение в редакторе видно только с фокусом: фокус уходит в текст, F3 ищет дальше
    const [k, len] = F.hits[F.i], lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    if (!typing) ta.focus();      // при вводе в поле поиска фокус остается в поле
    ta.setSelectionRange(k, k + len);
    ta.scrollTop = Math.max(0, (ta.value.slice(0, k).split("\n").length - 6) * lh);
    ta.dispatchEvent(new Event("keyup"));         // номер строки в статусе
    findRun();
    return;
  }
  const r = F.hits[F.i], sec = r.closest(".tw.tcl");
  if (sec) sec.classList.remove("tcl");            // свернутая таблица раскрывается на экране (не сохраняется)
  findRun();
  r.scrollIntoView({block: "center"});
}
// Клик по оператору в таблице (ячейка с data-op), пока окошка поиска нет: в поиск уходит начало текста
// оператора (первые FIND_HEAD символов подсказки ячейки; нет текста - «объект:строка»), окошко открывается
// без фокуса, строка клика - текущее совпадение (прокрутка не меняется). При выделении мышью - ничего.
const FIND_HEAD = 30;
document.addEventListener("click", e => {
  const td = e.target.closest && e.target.closest("#main td[data-op]");
  if (!td || F.box || !td.dataset.op || String(window.getSelection() || "")) return;
  const head = (td.title || td.dataset.qtip || "").replace(/\s+/g, " ").trim();
  F.q = head ? head.slice(0, FIND_HEAD).trim() : td.dataset.op;
  F.anchor = td.closest("tr");
  findOpen(false);
});
window.addEventListener("mouseup", e => { if (e.button === 3) back(); });

// ================================================================ данные
async function refresh() {
  let st;
  try { st = await api("state"); } catch (e) { fail(e); return; }
  // свернутые узлы и параметры запуска меняет только интерфейс: ответ, запрошенный до клика,
  // не должен возвращать старые значения (иначе клик по ˅/› "не срабатывает" с первого раза)
  if (S.st) { st.collapsed = S.st.collapsed; st.params = S.st.params; st.columns = S.st.columns; st.tcollapsed = S.st.tcollapsed; }
  S.st = st;
  for (const p of S.st.procs) (S.procs[p.id] ||= {info: p, events: []}).info = p;
  renderSide();
}
async function poll() {
  let r;
  try { r = await api("poll", S.seq); } catch (e) { return; }
  let ended = false;
  for (const p of r.procs) (S.procs[p.id] ||= {info: p, events: []}).info = p;
  for (const x of r.events) {
    const p = S.procs[x.proc];
    if (!p) continue;
    evAdd(p, x.ev);
    if (x.ev.event === "exit") { ended = true; onExit(p); }
    // пауза наблюдения: файлы не читаются, только кольцо начинает новый отсчет
    if (x.ev.event === "flush" && S.view.k === "session" && S.view.pid === x.proc) S.live.paused ? sessRing(p) : loadSessionTables(p);
  }
  S.seq = r.seq;
  if (r.events.length) updateLive();
  if (ended) refresh();
}
// События процесса в памяти. Операторы, ожидания и строки журнала за часы наблюдения или запуска в цикле -
// сотни тысяч, поэтому их хранится только последние EV_KEEP каждого вида (EV_GROUP); что нужно за все
// время, копится при получении: полоса ожиданий (p.wacc), «прошлый» (p.dur → e.prev). У события номер e.n:
// экраны дорисовывают события после последнего показанного номера (индекс в списке съехал бы при чистке).
const EV_KEEP = 500, EV_GROUP = {statement: "now", wait: "now", idle: "now", log: "log", message: "log", slow: "slow"};
function evAdd(p, e) {
  e.n = p.n = (p.n || 0) + 1;
  p.events.push(e);
  if (e.event === "start") p.profile = e.profile;
  waitFold(p.wacc ||= {m: new Map(), cur: null, t0: 0}, e);
  if (e.event === "statement" || e.event === "idle" || (e.event === "batch" && !p.profile)) {
    const d = p.dur ||= {}, last = p.lastOp;
    if (last) d[opKey(last)] = evMs(e) - evMs(last);       // прежний оператор закончился
    p.lastOp = e.event === "idle" ? null : e;
    if (e.event !== "idle") e.prev = d[opKey(e)];
  }
  const g = EV_GROUP[e.event], cnt = p.cnt ||= {};
  if (g && (cnt[g] = (cnt[g] || 0) + 1) > 2 * EV_KEEP) {   // чистка раз в EV_KEEP событий вида
    let cut = cnt[g] - EV_KEEP;
    p.events = p.events.filter(x => !(cut > 0 && EV_GROUP[x.event] === g && cut--));
    cnt[g] = EV_KEEP;
  }
}
function onExit(p) {
  const i = p.info, v = S.view;
  // неактивные вкладки с экраном этого процесса: их обновления не находят, и экран «Идет запуск» оставался
  // с бегущим таймером, как зависший. Вкладка переходит на итог сразу и рисуется заново при возврате.
  const st = p.events.find(e => e.event === "start"), cancelled = S.cancelled[i.id];
  const next = i.kind === "run" ? (i.report ? {k: "result", report: baseName(i.report)} : null)
    : i.kind === "session" ? (cancelled ? {k: "empty"} : st && st.folder ? {k: "sessiondone", folder: baseName(st.folder)} : null) : null;
  for (const tab of T.list) {
    if (tab === T.cur || !tab.view || tab.view.k !== i.kind || tab.view.pid !== i.id) continue;
    if (next) tab.view = next;
    tab.stale = true;
  }
  if (cancelled) {          // «Отменить наблюдение»: папка - в корзину, когда процесс ее закрыл
    delete S.cancelled[i.id];
    if (st && st.folder) api("delete_session", baseName(st.folder)).then(refresh, fail);
    if (v.k === "session" && v.pid === i.id) go({k: "empty"}, true);
    toast(t("Наблюдение отменено"));
    return;
  }
  if (i.kind === "run") {
    // заметка, написанная во время запуска, сохраняется к отчету: его имя известно только теперь
    const note = S.runNotes[i.id], open = v.k === "run" && v.pid === i.id;
    const saved = note && i.report ? api("set_note", baseName(i.report), note).then(refresh, fail) : Promise.resolve();
    saved.then(() => {
      if (!open || S.view !== v) return;
      if (i.report) go({k: "result", report: baseName(i.report)}, true);
      else renderMain();
    });
    const q = S.queue;         // «В очередь»: следующий запуск - когда запусков не осталось
    if (q && !runBusy()) { S.queue = null; startRun(q.name, q.p, true, true); }
  } else if (i.kind === "session" && v.k === "session" && v.pid === i.id) {
    const st = p.events.find(e => e.event === "start");
    if (st) go({k: "sessiondone", folder: baseName(st.folder)}, true);
  } else if (i.kind === "compare" && v.k === "compare" && v.pid === i.id) renderMain();
  if (i.kind === "run") toast(i.code === 0 ? t("{name}: запуск завершен", {name: i.title}) : t("{name}: запуск завершен с кодом {code}", {name: i.title, code: i.code}));
  if (S.autodetect && S.autodetect.pid === i.id) autodetectDone(i);
  notifyDone(p);
}
function cancelSession(pid) {
  if (!confirm(t("Отменить наблюдение? Собранное будет удалено (в корзину)."))) return;
  S.cancelled[pid] = true;
  api("stop", pid).catch(fail);
}
// уведомление Windows (§5.17): запуск или наблюдение шло дольше 30 с, а окно CompareQuery не активно
async function notifyDone(p) {
  const i = p.info, ms = Date.now() - Date.parse(i.started);
  if (S.st.notify === false || ms < 30000 || document.hasFocus() || i.kind === "compare") return;
  let what = i.code === 0 ? t("завершен") : t("прерван или с ошибкой");
  if (i.kind === "session") what = t("наблюдение завершено");
  else if (i.code === 0 && i.report) {
    try {
      const r = await api("run_details", baseName(i.report)), ref = r.reference;
      if (ref && ref.comparable) what = ref.same ? t("данные совпадают с опорным") : t("данные различаются с опорным");
    } catch (e) { /* без вердикта */ }
  }
  api("notify", "CompareQuery", `${i.kind === "session" ? sessTitle(i) : i.script + ".sql"} · ${clock(ms)} · ${what}`).catch(() => {});
}
const baseName = p => String(p || "").split(/[\\/]/).pop();
// заголовок процесса наблюдения: Python дает "Сессия N" - номер берется из аргументов
const sessTitle = i => t("Сессия {n}", {n: (i.args || [])[1] || String(i.title).replace(/\D+/g, "")});

// ================================================================ левая панель (§3)
function groupKey(stem) { return stem.split("_")[0].toLowerCase(); }
function collapsed(key) { return (S.st.collapsed || []).includes(key); }
function toggleCollapsed(key) {
  const c = new Set(S.st.collapsed || []);
  c.has(key) ? c.delete(key) : c.add(key);
  S.st.collapsed = [...c];
  api("set_gui", "collapsed", S.st.collapsed).catch(fail);
  renderSide();
}
function runningRuns(stem) {
  return Object.values(S.procs).filter(p => p.info.kind === "run" && p.info.running && p.info.script === stem);
}
function renderSide() {
  renderTabs();
  const st = S.st;
  if (!st) return;
  const v = S.view, c = st.connection;
  const qb = $("#q-btn");            // «В очередь» на экране скрипта - пока идет запуск
  if (qb) qb.style.display = runBusy() ? "" : "none";
  let tree = "";
  const skey = x => groupKey(x.stem) + "\u0000" + x.name.toLowerCase();       // (группа, имя), §5.15
  const scripts = [...st.scripts].sort((a, b) => skey(a) < skey(b) ? -1 : skey(a) > skey(b) ? 1 : 0);
  const groups = {};
  for (const s of scripts) (groups[groupKey(s.stem)] ||= []).push(s);
  let lastGroup = null;
  for (const s of scripts) {
    const g = groupKey(s.stem), inGroup = groups[g].length >= 2;
    if (inGroup && g !== lastGroup) {
      const cl = collapsed("g:" + g);
      const busy = groups[g].some(x => runningRuns(x.stem).length), n = groups[g].length;
      // свернутая группа: значок выполнения переходит на нее (в конец строки группы, полной яркости)
      tree += `<div class="sgrp" onclick="toggleCollapsed('g:${h(g)}')">${cl ? I.right(11) : I.down(11)}<span>${h(g)}</span>${cl ? `<span class="gc">· ${n} ${tp(n, "скрипт", "скрипта", "скриптов")}</span>` : ""}<span class="gl"></span>${cl && busy ? `<span class="pulse" title="${t("Идет запуск")}"></span>` : ""}</div>`;
    }
    lastGroup = inGroup ? g : null;
    if (inGroup && collapsed("g:" + g)) continue;
    const scl = collapsed("s:" + s.stem), on = v.k === "script" && v.name === s.name;
    const busy = runningRuns(s.stem);
    tree += `<div class="ti s${on ? " on" : ""}"${inGroup && g === lastGroup ? ' style="margin-top:0"' : ""}${s.missing ? "" : ` data-ctx="script" data-id="${h(s.name)}"`} onclick="go({k:'script',name:${h(JSON.stringify(s.name))}})">
      <span class="chev" onclick="event.stopPropagation();toggleCollapsed('s:${h(s.stem)}')">${scl ? I.right(12) : I.down(12)}</span>${h(s.name)}
      <span class="end">${S.queue && S.queue.name === s.name ? `<span class="cnt" title="${t("Запустится после текущего запуска. Клик — убрать из очереди")}" onclick="event.stopPropagation();S.queue=null;renderSide()">${t("в очереди")} ×</span>` : ""}${scl && (s.runs.length || busy.length) ? `<span class="cnt">${s.runs.length}</span>` : ""}${scl && busy.length ? '<span class="pulse"></span>' : ""}
      ${s.missing ? "" : `<span class="hv${s.ignored ? " on" : ""}" title="${t("Игнорируемые колонки")}${s.ignored ? ": " + s.ignored : ""}" onclick="event.stopPropagation();ignoreDialog(${h(JSON.stringify(s.name))})">${I.filter(15)}</span>`}
      ${s.missing ? "" : `<span class="hv" title="${t("Новый запуск")}" onclick="event.stopPropagation();startRun(${h(JSON.stringify(s.name))})">${I.play(16).replace('fill="currentColor"', 'fill="#3B5BDB"')}</span>`}</span></div>`;
    if (scl) continue;
    for (const p of busy) {
      const pass = [...p.events].reverse().find(e => e.event === "pass");
      tree += `<div class="ti r${v.k === "run" && v.pid === p.info.id ? " on" : ""}" data-ctx="proc" data-id="${p.info.id}" onclick="go({k:'run',pid:${p.info.id}})"><span class="star"><span class="pulse"></span></span>
        ${h(procWhen(p))}<span class="end"><span class="cnt">${pass && pass.of > 1 ? t("прогон {k} из {of}", pass) : t("идет")}</span></span></div>`;
    }
    // запуски в одну минуту различаются секундами: они показываются только у таких запусков
    const perMin = {};
    for (const r of s.runs) perMin[tsText(r.ts)] = (perMin[tsText(r.ts)] || 0) + 1;
    for (const r of s.runs) tree += runItem(r, perMin[tsText(r.ts)] > 1);
  }
  // наблюдения
  const sessProcs = Object.values(S.procs).filter(p => p.info.kind === "session" && p.info.running);
  const scl = collapsed("sessions");
  tree += `<div class="ti s${v.k === "newsession" ? " on" : ""}" onclick="go({k:'newsession'})"><span class="chev" onclick="event.stopPropagation();toggleCollapsed('sessions')">${scl ? I.right(12) : I.down(12)}</span>${t("Сессия")}
    <span class="end">${scl && sessProcs.length ? '<span class="pulse g"></span>' : ""}<span class="hv" title="${t("Наблюдать сессию")}">${I.plus(16).replace('stroke="currentColor"', 'stroke="#3B5BDB"')}</span></span></div>`;
  if (!scl) {
    for (const p of sessProcs) tree += `<div class="ti r${v.k === "session" && v.pid === p.info.id ? " on" : ""}" data-ctx="proc" data-id="${p.info.id}" onclick="go({k:'session',pid:${p.info.id}})"><span class="star"><span class="pulse g"></span></span>${h(String(p.info.title).replace(/\D+/g, ""))} <span class="pale" style="font-weight:500">· ${h(procWhen(p))}</span></div>`;
    const live = new Set(sessProcs.map(p => (p.events.find(e => e.event === "start") || {}).folder).filter(Boolean).map(baseName));
    for (const x of st.sessions) {
      if (live.has(x.folder)) continue;
      // экран сравнения наблюдений: его наблюдения помечены A и B (вместо пустой звезды), B выделено
      const ab = v.k === "compare" && v.sess ? (v.a === x.folder ? "A" : v.b === x.folder ? "B" : "") : "";
      const star = st.session_reference === x.folder ? `<span class="star" title="${t("Опорное наблюдение")}">${I.star(15, true)}</span>`
        : ab ? `<span class="star ab">${ab}</span>`
        : `<span class="star" title="${t("Сделать опорным")}" onclick="event.stopPropagation();setSessionReference(${h(JSON.stringify(x.folder))})"><span class="hollow">${I.star(15)}</span></span>`;
      tree += `<div class="ti r${(v.k === "sessiondone" && v.folder === x.folder) || ab === "B" ? " on" : ""}${S.pair.includes(x.folder) ? " pk" : ""}" data-ctx="sess" data-id="${h(x.folder)}" onclick="sessClick(event,${h(JSON.stringify(x.folder))})">${star}${x.spid} <span class="pale">· ${h(tsText(x.ts))}</span>${x.note ? `<span class="ntx" title="${h(t("Заметки: {note}", {note: x.note}))}">${h(x.note)}</span>` : ""}</div>`;
    }
  }
  const nruns = st.scripts.reduce((n, s) => n + s.runs.filter(r => !r.aborted).length, 0);
  const hints = [];
  if (!st.scripts.length) hints.push(t("Создайте скрипт или положите .sql в рабочую папку"));
  else if (!st.reference && nruns) hints.push(t("Отметьте ★ запуск — с ним будут сравниваться остальные"));
  else if (st.reference) hints.push(t("Открытый запуск сравнивается с опорным&nbsp;★. Переставьте&nbsp;★ на другой запуск, чтобы сравнивать с ним"));
  if (nruns >= 2) hints.push(t("Ctrl+клик по второму запуску — сравнить два любых"));
  if (st.sessions.length >= 2) hints.push(t("Ctrl+клик по двум наблюдениям — сравнить их"));
  const side = $("#side"), html = `
    <div style="display:flex;flex-direction:column;gap:2px">
      <div class="ctx" title="${t("Выбрать рабочую папку")}" onclick="chooseFolder()">${I.folder(18)}<span class="t"><b>${h(st.folder_name)}</b><span>${h(st.folder)}</span></span>${I.down(14)}</div>
      <div class="ctx" id="conn-ctx" title="${t("Изменить подключение и настройки")}" onclick="connDialog()">${I.db(18)}<span class="t"><b>${h(c.database || t("база не указана"))}</b><span>${h(c.server || t("сервер не указан"))}</span></span>${I.pen(15)}</div>
    </div>
    <a class="btn pri" onclick="needConn()||newScriptDialog()">${I.plus(18)}${t("Новый скрипт")}</a>
    <a class="btn" style="margin-top:-4px" onclick="needConn()||go({k:'newsession'})">${I.eye(18)}${t("Наблюдать сессию")}</a>
    <nav class="tree">${tree}</nav>
    ${S.pair.length === 2 ? `<div class="pairbar"><span>${isSess(S.pair[0]) ? t("Выбрано 2 наблюдения") : t("Выбрано 2 запуска")}</span><a class="btn sm pri" style="height:32px" onclick="comparePair()">${t("Сравнить")}</a></div>` : ""}
    <div class="hint">${S.pair.length === 2 ? "" : hints.map(x => `<span>${x}</span>`).join("")}</div>
    <div class="menu">
      <a class="${v.k === "current" ? "on" : ""}" onclick="needConn()||go({k:'current'})">${I.pulse(18)}${t("Текущие запросы")}</a>
      <a class="${v.k === "load" ? "on" : ""}" onclick="needConn()||go({k:'load'})">${I.flame(18)}${t("Нагрузка сервера")}</a>
      <a class="${v.k === "dbinfo" ? "on" : ""}" onclick="needConn()||go({k:'dbinfo'})">${I.db(18)}${t("База данных")}</a>
      <div class="mrow"><a onclick="api('open_help').catch(fail)">${I.help(18)}${t("Справка")}</a>${langButton()}</div>
      <span class="about">${h(ABOUT_TEXT)} <a class="lnk" onclick="api('open_url', ABOUT_LINK.url).catch(fail)">${h(ABOUT_LINK.text)}</a></span></div>`;
  // панель перерисовывается только при изменении: иначе клик, попавший на перерисовку (раз в секунду,
  // пока идут процессы), теряется, а дерево прокручивается в начало
  if (side._html === html) return;
  const tr = side.querySelector(".tree"), top = tr ? tr.scrollTop : 0;
  side.innerHTML = html;
  side._html = html;
  side.querySelector(".tree").scrollTop = top;
  fitHint();
}
// подсказка внизу панели - только пока дереву хватает места: появилась прокрутка дерева - подсказки нет
function fitHint() {
  const tr = $("#side .tree"), hint = $("#side .hint");
  if (!tr || !hint) return;
  hint.style.display = "";
  if (tr.scrollHeight > tr.clientHeight + 1 || hint.scrollHeight > hint.clientHeight + 1) hint.style.display = "none";
}
// язык интерфейса (§5.22): маленькая кнопка в строке «Справка», список языков всплывает над ней
function langButton() {
  return `<span class="langb" title="Language · Язык" onclick="langMenu(event)">${I.globe(13)}${LANG.toUpperCase()}${I.down(9)}</span>`;
}
function langMenu(e) {
  e.stopPropagation();
  const old = $("#langpop");
  if (old) { old.remove(); return; }
  const b = e.currentTarget.getBoundingClientRect(), el = document.createElement("div");
  el.id = "langpop";
  el.className = "langpop";
  el.innerHTML = LANGS.map(([k, name]) => `<a class="${k === LANG ? "on" : ""}" onclick="chooseLang('${k}')"><b>${k.toUpperCase()}</b>${name}</a>`).join("");
  el.style.left = b.left + "px";
  el.style.bottom = (innerHeight - b.top + 6) + "px";
  document.body.appendChild(el);
  setTimeout(() => document.addEventListener("click", () => el.remove(), {once: true}));
}
async function chooseLang(k) {
  const pop = $("#langpop");
  if (pop) pop.remove();
  if (k === LANG) return;
  try { await setLang(k); } catch (e) { fail(e); return; }
  S.st.lang = k;
  api("set_gui", "lang", k).catch(fail);
  $("#side")._html = null;
  renderSide();
  renderMain();
}
function runItem(r, sec) {
  const st = S.st, v = S.view, isRef = st.reference === r.report;
  // экран сравнения запусков: его запуски помечены A и B (вместо пустой звезды), B выделен
  const ab = v.k === "compare" && !v.sess ? (v.a === r.report ? "A" : v.b === r.report ? "B" : "") : "";
  const on = ((v.k === "result" || v.k === "table") && v.report === r.report) || ab === "B", pk = S.pair.includes(r.report);
  let end = "";
  if (isRef) end = `<span class="cnt">${t("опорный")}</span>`;
  else if (r.aborted) end = `<span class="abt" title="${h(t("Запуск прерван: {why}", {why: r.aborted}))}">${t("прерван")}</span>`;
  else if (r.comparable === false) end = `<span class="inc" title="${h(t("Несравним с опорным: {why}", {why: r.why}))}">${t("несравним")}</span>`;
  else if (r.delta !== undefined && r.delta !== null)
    end = `<span class="d ${r.delta > 0 ? "up" : "down"}">${r.delta > 0 ? "+" : r.delta < 0 ? "−" : "±"}${Math.abs(r.delta)}%</span>` +
          (r.same ? `<span class="eq" style="color:#17714A" title="${t("Данные совпадают")}">=</span>` : `<span class="eq up" title="${t("Данные различаются")}">≠</span>`);
  const star = isRef ? `<span class="star" title="${t("Опорный запуск")}">${I.star(15, true)}</span>`
    : ab ? `<span class="star ab">${ab}</span>`
    : r.aborted ? `<span class="star"></span>`
    : `<span class="star" title="${t("Сделать опорным")}" onclick="event.stopPropagation();setReference(${h(JSON.stringify(r.report))})"><span class="hollow">${I.star(15)}</span></span>`;
  return `<div class="ti r${on ? " on" : ""}${pk ? " pk" : ""}" data-ctx="run" data-id="${h(r.report)}"${r.aborted ? ' data-aborted="1"' : ""} onclick="runClick(event,${h(JSON.stringify(r.report))})">${star}${tsText(r.ts, sec)}${r.note ? `<span class="ntx" title="${h(t("Заметки: {note}", {note: r.note}))}">${h(r.note)}</span>` : ""}<span class="end">${end}</span></div>`;
}
const isSess = x => /^Session_/.test(x);
// Ctrl+клик выбирает пару одного вида: два запуска или два наблюдения (§6.7, §6.8)
function sessClick(e, folder) {
  if (e.ctrlKey) {
    if (S.pair.some(x => !isSess(x))) S.pair = [];
    if (!S.pair.length && S.view.k === "sessiondone" && S.view.folder !== folder) S.pair = [S.view.folder];
    S.pair = S.pair.includes(folder) ? S.pair.filter(x => x !== folder) : [...S.pair, folder].slice(-2);
    renderSide();
    return;
  }
  S.pair = [];
  go({k: "sessiondone", folder});
}
function runClick(e, report) {
  if (e.ctrlKey) {
    if (S.pair.some(isSess)) S.pair = [];
    if (!S.pair.length && S.view.k === "result" && S.view.report !== report) S.pair = [S.view.report];
    S.pair = S.pair.includes(report) ? S.pair.filter(x => x !== report) : [...S.pair, report].slice(-2);
    renderSide();
    return;
  }
  S.pair = [];
  go({k: "result", report});
}
function comparePair() {
  const ts = r => (r.match(/_(\d{8}_\d{6})/) || [""])[0];
  const [a, b] = [...S.pair].sort((x, y) => ts(x).localeCompare(ts(y)));   // старший - база (A), младший - проверяемый (B)
  S.pair = [];
  if (isSess(a)) startSessionCompare(a, b);
  else startCompare(a, b);
}
async function setSessionReference(folder) {
  try { await api("set_session_reference", folder); await refresh(); renderMain(); } catch (e) { fail(e); }
}
async function setReference(report) {
  try { await api("set_reference", report); await refresh(); renderMain(); } catch (e) { fail(e); }
}
async function chooseFolder() {
  try {
    if (window.CQ_DEV) {         // в браузере нет системного окна выбора папки
      modal(`<div class="dlg" style="width:520px"><div class="dh"><h2>${t("Рабочая папка")}</h2></div><div class="db"><input class="inp" id="fld" value="${h(S.st.folder)}"></div>
        <div class="df"><a class="btn" onclick="closeModal()">${t("Отмена")}</a><a class="btn pri" onclick="setFolder($('#fld').value)">${t("Выбрать")}</a></div></div>`);
      return;
    }
    const f = await api("choose_folder");
    if (f) { S.history = []; S.view = {k: "empty"}; await refresh(); renderMain(); }
  } catch (e) { fail(e); }
}
async function setFolder(f) {
  try { await api("set_folder", f); closeModal(); S.history = []; S.view = {k: "empty"}; await refresh(); renderMain(); } catch (e) { fail(e); }
}

// ================================================================ окна поверх
// Закрытие кликом мимо окна: и нажатие, и отпускание кнопки - на затемнении. Иначе выделение текста в поле,
// отпущенное за краем окна, закрывало его (click достается общему предку - затемнению).
function modal(html) { $("#modal").innerHTML = `<div class="overlay" onmousedown="this._down=event.button===0&&event.target===this" onmouseup="if(this._down&&event.target===this)closeModal();this._down=false">${html}</div>`; const i = $("#modal input"); if (i) i.focus(); }
function closeModal() { $("#modal").innerHTML = ""; }
// Настройки (§5.6): сохраненные подключения - выпадающий список «сервер — база — логин», ниже поля
// выбранного; значки «добавить как новое» и «убрать из списка», «Проверить» - вход и легкий запрос с
// введенными значениями. «Сохранить» делает выбранное подключение активным (его использует CLI).
// Пароли в интерфейс не приходят: пустое поле - «не менять».
// Драйвер, сервер и база - поля той же строки подключения: правка поля переписывает в строке только свой
// параметр, правка строки заново заполняет поля. Смена СУБД собирает строку заново из сервера и базы.
const CONN_NEW = "__new";
const connLabel = c => `${c.server || "?"} — ${c.database || "?"} — ${c.login || t("вход Windows")}`;
async function connDialog() {
  let d;
  try { d = await api("connections"); } catch (e) { fail(e); return; }
  window._cn = {items: d.items, active: d.active, drivers: d.drivers, sel: d.active || (d.items[0] || {}).id || null};
  modal(`<div class="dlg" style="width:620px"><div class="dh"><h2>${t("Настройки")}</h2><span class="note">${t("Хранится в CompareQuery.json рядом с CompareQuery.py. Пароль не показывается и не попадает в логи и отчеты.")}</span></div>
    <div class="db">
      <section class="ignb">
        <span class="lbl">${t("Подключение")}</span>
        <div style="display:flex;gap:6px;align-items:center"><select class="inp" id="cn-sel" style="flex:1;min-width:0" onchange="connPick(this.value)"></select>
          <span class="ib" title="${t("Добавить как новое подключение")}" onclick="connAdd()">${I.plus(17)}</span>
          <span class="ib" title="${t("Убрать подключение из списка")}" onclick="connDelete()">${I.trash(17)}</span></div>
        <div class="cndrv"><span class="lbl">${t("Драйвер")}</span><span class="dbk" id="cn-kind"></span><select class="inp" id="cn-drv" onchange="connDriver(this.value)"></select></div>
        <div style="display:flex;gap:12px">
          <label class="field" style="flex:1"><span class="lbl">${t("Сервер")}</span><input class="inp" id="cn-srv" oninput="connWrite()"></label>
          <label class="field" style="flex:1"><span class="lbl">${t("База данных")}</span><input class="inp" id="cn-db" oninput="connWrite()"></label>
        </div>
        <div style="display:flex;gap:12px">
          <label class="field" style="flex:1"><span class="lbl">${t("Логин (пусто — вход Windows)")}</span><input class="inp" id="lg" oninput="connDirty()"></label>
          <label class="field" style="flex:1"><span class="lbl">${t("Пароль")}</span><input class="inp" id="pw" type="password" oninput="connDirty()"></label>
        </div>
        <label class="field"><span class="lbl">${t("Строка подключения")}</span><input class="inp mono" id="cs" style="font-size:13px" oninput="connParse();connDirty()"></label>
        <div style="display:flex;gap:12px;align-items:center;min-height:32px"><a class="btn sm" onclick="connTest()">${t("Проверить")}</a><span class="cnres" id="cn-res"></span></div>
      </section>
      <label class="field"><span class="lbl">${t("Программа сравнения (diff) — путь к exe; пусто — найти самому")}${S.st.diff_found ? ": " + t("сейчас {name}", {name: h(S.st.diff_found)}) : ": " + t("не найдена")}</span><input class="inp" id="dt" value="${h(S.st.diff_tool || "")}" placeholder="C:\\Program Files\\WinMerge\\WinMergeU.exe"></label>
      <span class="popt" onclick="this.firstChild.classList.toggle('on')"><span class="sw${S.st.notify !== false ? " on" : ""}" id="nt"></span>${t("Уведомления Windows, когда запуск или наблюдение закончилось (если шло дольше 30 с, а окно не активно)")}</span></div>
    <div class="df"><span class="note" style="margin-right:auto;align-self:center">${t("«Сохранить» делает выбранное подключение активным")}</span><a class="btn" onclick="closeModal()">${t("Отмена")}</a><a class="btn pri" onclick="saveConn()">${t("Сохранить")}</a></div></div>`);
  connFill();
}
function connFill() {             // список и поля по _cn.sel
  const c = window._cn, cur = c.items.find(x => x.id === c.sel);
  $("#cn-sel").innerHTML = c.items.map(x => `<option value="${h(x.id)}"${x.id === c.sel ? " selected" : ""}>${h(connLabel(x))}${x.id === c.active ? " · " + t("активное") : ""}</option>`).join("") +
    `<option value="${CONN_NEW}"${c.sel ? "" : " selected"}>+ ${t("новое соединение")}</option>`;
  $("#cs").value = cur ? cur.connection_string : "";
  $("#lg").value = cur ? cur.login : "";
  $("#pw").value = "";
  $("#pw").placeholder = cur && cur.has_password ? "•••••••• " + t("(не менять)") : "";
  $("#cn-res").innerHTML = "";
  Object.assign(c, {kind: "ms", driver: c.drivers.mssql[0] || "SQL Server"});   // для пустой строки
  connParse();
  if (!cur) $("#cn-srv").focus();
}
function connPick(id) { window._cn.sel = id === CONN_NEW ? null : id; connFill(); }

// ---- строка подключения <-> поля. Вид СУБД - как cq.is_postgres. MS SQL Server - ODBC «Ключ=значение;»
// (значение в {} с «}}» внутри), PostgreSQL - libpq «ключ=значение» через пробел (значение в '' с \)
// или URI postgresql://... (у URI поля только показываются: правка - в строке).
const PG_URI_RE = /^\s*postgres(?:ql)?:\/\//i;
const isPgConn = cs => PG_URI_RE.test(cs) || (!/(?:^|;)\s*(?:driver|dsn)\s*=/i.test(cs) &&
  /(?:^|\s)(?:host|hostaddr|dbname|port|user|sslmode|service)\s*=/i.test(cs));
function odbcPairs(cs) {          // [[ключ, значение как в строке]]; хвост без «=» - [текст, null]
  const out = [], n = cs.length;
  let i = 0;
  while (i < n) {
    const eq = cs.indexOf("=", i);
    if (eq < 0) { if (cs.slice(i).trim()) out.push([cs.slice(i).trim(), null]); break; }
    let j = eq + 1;
    while (j < n && cs[j] === " ") j++;
    if (cs[j] === "{") {
      for (j++; j < n; j++) if (cs[j] === "}") { if (cs[j + 1] === "}") j++; else { j++; break; } }
    }
    const semi = cs.indexOf(";", j), end = semi < 0 ? n : semi;
    if (cs.slice(i, eq).trim()) out.push([cs.slice(i, eq).trim(), cs.slice(eq + 1, end).trim()]);
    i = end + 1;
  }
  return out;
}
const odbcVal = v => v && v[0] === "{" ? v.slice(1, v.endsWith("}") ? -1 : undefined).replace(/}}/g, "}") : v || "";
const odbcRaw = (v, brace) => brace || /[;{}]|^\s|\s$/.test(v) ? "{" + v.replace(/}/g, "}}") + "}" : v;
const pgPairs = cs => [...cs.matchAll(/(\w+)\s*=\s*('(?:[^'\\]|\\.)*'?|\S*)/g)].map(m => [m[1], m[2]]);
const pgVal = v => v && v[0] === "'" ? v.slice(1, v.length > 1 && v.endsWith("'") ? -1 : undefined).replace(/\\(.)/g, "$1") : v || "";
const pgRaw = v => /^[^\s'\\]+$/.test(v) ? v : "'" + v.replace(/[\\']/g, "\\$&") + "'";
const pairGet = (pairs, key) => (pairs.find(p => p[0].toLowerCase() === key) || [])[1];
// Ставит значение параметра (пустое - убирает параметр). Нового параметра нет - встает после первого
// найденного из after (иначе в начало): так новая строка идет в порядке драйвер, сервер, база.
function pairSet(pairs, key, raw, after) {
  const i = pairs.findIndex(p => p[0].toLowerCase() === key.toLowerCase());
  if (raw === "") { if (i >= 0) pairs.splice(i, 1); return; }
  if (i >= 0) { pairs[i][1] = raw; return; }
  const a = after.map(k => pairs.findIndex(p => p[0].toLowerCase() === k)).find(x => x >= 0);
  pairs.splice(a === undefined ? 0 : a + 1, 0, [key, raw]);
}
function connFields(cs) {         // {kind, driver, server, db, uri}; пустая строка - null
  if (!cs.trim()) return null;
  if (PG_URI_RE.test(cs)) {
    let u = null;
    try { u = new URL(cs.trim().replace(/^postgres(?:ql)?:/i, "http:")); } catch (e) { /* несколько хостов и т. п. */ }
    return {kind: "pg", uri: true, server: u ? decodeURIComponent(u.hostname) + (u.port ? ":" + u.port : "") : "",
            db: u ? decodeURIComponent(u.pathname.slice(1)) : ""};
  }
  if (isPgConn(cs)) {
    const p = pgPairs(cs), port = pgVal(pairGet(p, "port"));
    return {kind: "pg", server: (pgVal(pairGet(p, "host")) || pgVal(pairGet(p, "hostaddr"))) + (port ? ":" + port : ""), db: pgVal(pairGet(p, "dbname"))};
  }
  const p = odbcPairs(cs);
  return {kind: "ms", driver: odbcVal(pairGet(p, "driver")), server: odbcVal(pairGet(p, "server")), db: odbcVal(pairGet(p, "database"))};
}
function connParse() {            // строка -> поля
  const c = window._cn, f = connFields($("#cs").value);
  c.uri = !!(f && f.uri);
  if (f) { c.kind = f.kind; if (f.kind === "ms") c.driver = f.driver; }
  $("#cn-srv").value = f ? f.server : "";
  $("#cn-db").value = f ? f.db : "";
  connShow();
}
function connWrite() {            // поля -> строка: меняются только свои параметры
  const c = window._cn, srv = $("#cn-srv").value.trim(), db = $("#cn-db").value.trim();
  let cs = $("#cs").value.trim();
  if (c.kind === "pg") {
    const p = pgPairs(cs), m = /^([^:]*):(\d+)$/.exec(srv);
    pairSet(p, "host", pgRaw(m ? m[1] : srv).replace(/^''$/, ""), []);
    pairSet(p, "port", m ? m[2] : "", ["host"]);
    pairSet(p, "dbname", db && pgRaw(db), ["port", "host"]);
    cs = p.map(x => x[0] + "=" + x[1]).join(" ");
  } else {
    const fresh = !cs, end = cs.endsWith(";"), p = odbcPairs(cs);
    if (fresh && c.driver) pairSet(p, "Driver", odbcRaw(c.driver, true), []);
    pairSet(p, "Server", srv && odbcRaw(srv), ["driver"]);
    pairSet(p, "Database", db && odbcRaw(db), ["server", "driver"]);
    if (fresh) p.push(["TrustServerCertificate", "yes"]);     // как в примере настроек CLI
    cs = p.map(x => x[1] === null ? x[0] : x[0] + "=" + x[1]).join(";") + (end ? ";" : "");
  }
  $("#cs").value = cs;
  connDirty();
}
function connDriver(v) {          // выбор в списке драйверов
  const c = window._cn, kind = v === "pg" ? "pg" : "ms", cs = $("#cs").value.trim();
  if (kind === "ms") c.driver = v.slice(3);
  if (kind === c.kind) {
    if (kind === "ms" && cs && c.driver) {
      const p = odbcPairs(cs);
      pairSet(p, "Driver", odbcRaw(c.driver, true), []);
      $("#cs").value = p.map(x => x[1] === null ? x[0] : x[0] + "=" + x[1]).join(";") + (cs.endsWith(";") ? ";" : "");
    }
  } else {
    // другая СУБД: прочие параметры у нее свои, строка собирается заново из сервера (без порта) и базы
    c.kind = kind;
    c.uri = false;
    const srv = $("#cn-srv").value.trim();
    $("#cn-srv").value = kind === "pg" ? srv.replace(/[,\\].*$/, "") : srv.replace(/:\d+$/, "");
    $("#cs").value = "";
    if ($("#cn-srv").value || $("#cn-db").value.trim()) connWrite();
  }
  connShow();
  connDirty();
}
function connShow() {             // список драйверов, значок СУБД, доступность полей
  const c = window._cn, d = c.drivers, low = s => (s || "").toLowerCase();
  const ms = d.mssql.map(x => [x, true]);
  if (c.kind === "ms" && c.driver && !d.mssql.some(x => low(x) === low(c.driver))) ms.push([c.driver, false]);
  const msOpt = ([x, ok]) => `<option value="ms:${h(x)}"${c.kind === "ms" && low(x) === low(c.driver) ? " selected" : ""}>${h(x)}${ok ? "" : " — " + t("не установлен")}</option>`;
  $("#cn-drv").innerHTML = `<optgroup label="MS SQL Server">${c.kind === "ms" && !c.driver ? `<option value="ms:" selected>${t("(драйвер не указан)")}</option>` : ""}${ms.map(msOpt).join("")}</optgroup>` +
    `<optgroup label="PostgreSQL"><option value="pg"${c.kind === "pg" ? " selected" : ""}>psycopg${d.pg ? "" : " — " + t("не установлен")}</option></optgroup>`;
  const k = $("#cn-kind");
  k.className = "dbk " + c.kind;
  k.innerHTML = I.db(13) + (c.kind === "pg" ? "PostgreSQL" : "MS SQL Server");
  const tip = c.uri ? t("Строка в виде URI: сервер и базу меняйте в строке подключения") : "";
  for (const id of ["#cn-srv", "#cn-db"]) { $(id).readOnly = c.uri; $(id).title = tip; }
  $("#cn-srv").placeholder = c.kind === "pg" ? "localhost:5432" : "localhost\\SQLEXPRESS";
  $("#cn-db").placeholder = c.kind === "pg" ? "postgres" : "master";
}
function connDirty() { $("#cn-res").innerHTML = ""; }
// пустой пароль: у выбранного сохраненного - «не менять» (null), у нового - пустой
const connPw = () => $("#pw").value !== "" ? $("#pw").value : (window._cn.sel ? null : "");
async function connReload(sel) {
  const d = await api("connections");
  Object.assign(window._cn, {items: d.items, active: d.active, sel});
  connFill();
}
async function connAdd() {
  const c = window._cn, cs = $("#cs").value.trim(), lg = $("#lg").value.trim();
  if (!cs) { toast(t("Введите строку подключения"), true); return; }
  const same = c.items.find(x => x.connection_string === cs && x.login === lg);
  if (same && same.id !== c.sel) { c.sel = same.id; connFill(); toast(t("Такое подключение уже есть")); return; }
  try {
    const id = await api("save_connection", null, cs, lg, $("#pw").value !== "" ? $("#pw").value : null, false, c.sel);
    await connReload(id);
    toast(t("Подключение добавлено в список"));
  } catch (e) { fail(e); }
}
async function connDelete() {
  const c = window._cn, cur = c.items.find(x => x.id === c.sel);
  if (!cur) return;
  if (cur.id === c.active) { toast(t("Активное подключение убрать нельзя: сначала выберите и сохраните другое"), true); return; }
  if (!confirm(t("Убрать подключение {name} из списка?", {name: connLabel(cur)}))) return;
  try { await api("delete_connection", cur.id); await connReload(c.active); } catch (e) { fail(e); }
}
async function connTest() {
  const res = $("#cn-res"), cs = $("#cs").value.trim();
  if (!cs) { toast(t("Введите строку подключения"), true); return; }
  res.className = "cnres";
  res.innerHTML = `<span class="pulse"></span> ${t("Проверка…")}`;
  try {
    const r = await api("test_connection", window._cn.sel, cs, $("#lg").value, connPw());
    if (!$("#cn-res")) return;
    res.className = "cnres ok";
    res.textContent = t("Подключено за {ms} мс: {server} / {db} · {login} · {version}", {ms: nf(r.ms), server: r.server || "?", db: r.database || "?", login: r.login || "?",
      version: r.dbms === "PostgreSQL" ? r.edition || "PostgreSQL " + r.version : ["SQL Server", r.version, r.edition].filter(Boolean).join(" ")});
  } catch (e) {
    if (!$("#cn-res")) return;
    res.className = "cnres err";
    res.textContent = String(e && e.message || e);
  }
}
async function saveConn() {
  const c = window._cn, cs = $("#cs").value.trim();
  if (!cs) { toast(t("Введите строку подключения"), true); return; }
  try {
    const was = connKey(), wasDbms = dbms().name;
    await api("save_connection", c.sel, cs, $("#lg").value, connPw(), true, null);
    await api("set_gui", "diff_tool", $("#dt").value.trim());
    await api("set_gui", "notify", $("#nt").classList.contains("on"));
    closeModal();
    toast(t("Настройки сохранены"));
    await refresh();
    if (connKey() !== was) connChanged(dbms().name !== wasDbms);
    if (S.view.k === "empty") renderMain();       // текст «Для начала задайте подключения…» уходит
  } catch (e) { fail(e); }
}
// Смена активного подключения (сервер, база, логин, СУБД). Экраны с данными сервера (CONN_VIEWS) во всех
// вкладках открываются заново, без отборов прежнего сервера: база в фильтрах - база нового подключения;
// в «Назад» - так же. При смене СУБД (MS SQL Server ↔ PostgreSQL) заново и скрипт - параметры запуска
// (--explain есть не у всех), если текст не изменен. Идущие запуски и наблюдения остаются на своем
// подключении (у процесса CLI свое), их экраны и итоги - по файлам, не трогаются.
const CONN_VIEWS = ["current", "load", "dbinfo", "newsession"];
const connKey = () => { const c = S.st.connection || {}; return c.connection_string + "\n" + c.login; };
function connChanged(dbmsChanged) {
  if (S.load) S.load.db = null;          // базы «Нагрузки сервера» и «Базы данных» - общие для вкладок
  if (S.dbi) S.dbi.db = null;
  for (const tab of T.list) {
    const cur = tab === T.cur, v = cur ? S.view : tab.view, live = cur ? S.live : tab.live;
    for (const x of cur ? S.history : tab.history) if (CONN_VIEWS.includes(x.view.k)) x.view = {k: x.view.k};
    const ta = (cur ? $("#main") : tab.node)?.querySelector("#code");
    if (v.k === "script" ? !dbmsChanged || (ta && ta.value !== live.saved) : !CONN_VIEWS.includes(v.k)) continue;
    const nv = v.k === "script" ? v : {k: v.k};
    if (cur) { S.view = nv; S.live = {}; renderMain(); } else { tab.view = nv; tab.stale = true; }
  }
  renderSide();
}
// Подключений нет (§3): активное - из примера CLI (localhost, master, sa), в списке нет других. Баллон
// у кнопки подключения при запуске и при попытке нажать «Новый скрипт», «Наблюдать сессию», «Текущие
// запросы», «Тяжелые запросы»; пропадает от любого клика.
function needConn() {
  if (!S.st || !S.st.no_connection) return false;
  showConnTip();
  return true;
}
function showConnTip() {
  const old = $("#conn-tip");
  if (old) old.remove();
  const b = $("#conn-ctx");
  if (!b) return;
  const r = b.getBoundingClientRect(), el = document.createElement("div");
  el.id = "conn-tip";
  el.className = "ctip";
  el.textContent = t("Для начала задайте подключения к базе");
  el.style.left = r.right + 12 + "px";
  document.body.appendChild(el);
  el.style.top = r.top + r.height / 2 - el.offsetHeight / 2 + "px";
  // клик, который показал баллон, его не закрывает: слушатель - после него
  setTimeout(() => document.addEventListener("mousedown", () => el.remove(), {once: true, capture: true}));
}
function newScriptDialog() {
  modal(`<div class="dlg" style="width:440px"><div class="dh"><h2>${t("Новый скрипт")}</h2><span class="note">${t("Пустой .sql в рабочей папке")}</span></div>
    <div class="db"><input class="inp" id="nsn" placeholder="query_v3.sql" onkeydown="if(event.key==='Enter')createScript()">
      <span class="note">${t("Символ _ в имени файла поможет выделить группу по левой части от него")}</span></div>
    <div class="df"><a class="btn" onclick="closeModal()">${t("Отмена")}</a><a class="btn pri" onclick="createScript()">${t("Создать")}</a></div></div>`);
}
function copyScriptDialog(name) {       // копия скрипта под новым именем (в поле - текущее)
  window._copyOf = name;
  modal(`<div class="dlg" style="width:440px"><div class="dh"><h2>${t("Копия скрипта")}</h2><span class="note">${t("Новый файл с текстом {name}", {name: h(name)})}</span></div>
    <div class="db"><input class="inp" id="nsn" value="${h(name)}" onkeydown="if(event.key==='Enter')createScript(_copyOf)"></div>
    <div class="df"><a class="btn" onclick="closeModal()">${t("Отмена")}</a><a class="btn pri" onclick="createScript(_copyOf)">${t("Создать")}</a></div></div>`);
  const i = $("#nsn");
  i.focus();
  i.setSelectionRange(0, name.replace(/\.sql$/i, "").length);
}
async function createScript(source) {
  try { const name = await api("new_script", $("#nsn").value, source || null); closeModal(); await refresh(); go({k: "script", name}); } catch (e) { fail(e); }
}
// У скрипта с запусками - выбор: удалить и запуски (отчеты, CSV, реестры, файлы сравнения) или только файл
function deleteScript(name) {
  const sc = S.st.scripts.find(x => x.name === name), n = sc ? sc.runs.length : 0, q = h(JSON.stringify(name));
  modal(`<div class="dlg" style="width:${n ? 560 : 420}px"><div class="dh"><h2>${t("Удалить скрипт?")}</h2><span class="note">${t("Файл {name} будет перемещен в корзину Windows.", {name: h(name)})}${n ? " " + t("У скрипта есть запуски: {n}. Их отчеты, CSV, реестры и файлы сравнения можно удалить вместе с ним.", {n}) : ""}</span></div>
    <div class="df"><a class="btn" onclick="closeModal()">${t("Отмена")}</a>${n ? `<a class="btn" onclick="doDeleteScript(${q}, false)">${t("Удалить только скрипт")}</a><a class="btn dark" onclick="doDeleteScript(${q}, true)">${t("Удалить связанные")}</a>`
      : `<a class="btn dark" onclick="doDeleteScript(${q}, false)">${t("В корзину")}</a>`}</div></div>`);
}
async function doDeleteScript(name, withRuns) {
  try {
    await api("delete_script", name, withRuns);
    closeModal();
    const stem = name.replace(/\.sql$/i, ""), v = S.view;
    // вместе с запусками закрываются и их экраны (итог, таблица, сравнение)
    const open = (v.k === "script" && v.name === name) ||
      (withRuns && [v.report, v.a, v.b].some(r => typeof r === "string" && reportStem(r) === stem));
    if (open) { S.view = {k: "empty"}; S.history = []; }
    await refresh();
    if (open) renderMain();
    toast(t("Перемещено в корзину"));
  } catch (e) { fail(e); }
}
window.cqAskClose = function () {         // §6.6: вызывается из Python при закрытии окна, если что-то идет
  const run = Object.values(S.procs).filter(p => p.info.running);
  modal(`<div class="dlg" style="width:440px"><div class="dh"><h2>${t("Закрыть CompareQuery?")}</h2><span class="note">${t("Идут процессы. Они будут остановлены корректно: текущий оператор на сервере отменяется.")}</span></div>
    <div class="db" style="gap:8px">${run.map(p => `<div class="proc"><span class="pulse${p.info.kind === "session" ? " g" : ""}"></span><span style="display:flex;flex-direction:column;gap:2px"><b>${p.info.kind === "session" ? t("Наблюдение: {name}", {name: h(sessTitle(p.info))}) : p.info.kind === "run" ? t("Запуск {name}", {name: h(p.info.title)}) : t("Сравнение {name}", {name: h(p.info.title)})}</b><span class="note">${p.info.kind === "session" ? t("остановится с сохранением") : t("будет прерван, отчет помечается прерванным")}</span></span></div>`).join("")}</div>
    <div class="df"><a class="btn" onclick="closeModal()">${t("Отмена")}</a><a class="btn dark" onclick="api('close_app')">${t("Остановить и закрыть")}</a></div></div>`);
};

// ---------------------------------------------------------------- игнорируемые колонки (§5.6, §6.3)
// Колонки всех групп ignored_columns, маска которых подходит к имени скрипта, объединяются (как в CLI).
// Окно правит копию групп; "Сохранить" пишет их в CompareQuery.json. Области добавления: только этот
// скрипт (маска - имя скрипта), все скрипты группы панели (<группа>*), все скрипты (*).
function fnRe(mask) {           // маска fnmatch (*, ?, [..]) -> RegExp без учета регистра
  let re = "";
  for (let i = 0; i < mask.length; i++) {
    const c = mask[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const j = mask.indexOf("]", i + 2);
      if (j < 0) { re += "\\["; continue; }
      let body = mask.slice(i + 1, j).replace(/\\/g, "\\\\");
      if (body[0] === "!") body = "^" + body.slice(1);
      re += "[" + body + "]";
      i = j;
    } else re += c.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  return new RegExp("^" + re + "$", "i");
}
const fnEscape = name => name.replace(/[*?[]/g, c => `[${c}]`);
const ignPrefix = stem => stem.split("_")[0];
function ignMask(scope) {
  const g = S.ign;
  return scope === "script" ? fnEscape(g.stem) : scope === "group" ? ignPrefix(g.stem) + "*" : "*";
}
function ignSource(mask) {      // подпись источника колонки: пусто - этот скрипт
  return mask === "*" ? t("все скрипты") : mask.toLowerCase() === fnEscape(S.ign.stem).toLowerCase() ? "" : mask;
}
async function ignoreDialog(script, preset) {
  let d;
  try { d = await api("ignore_info", script); } catch (e) { fail(e); return; }
  S.ign = {script, stem: d.stem, scripts: d.scripts, tables: d.tables, groups: JSON.parse(JSON.stringify(d.groups)),
           orig: JSON.stringify(d.groups), added: new Set(), rollback: false};
  for (const c of (preset && preset.cols) || []) ignAdd(c, preset.table || "*", "script", true);
  renderIgn();
}
function ignAdd(col, table, scope, quiet) {
  col = (col || "").trim();
  if (!col) { if (!quiet) toast(t("Введите имя колонки"), true); return; }
  const g = S.ign, mask = ignMask(scope);
  let grp = g.groups.find(x => (x.mask || "").toLowerCase() === mask.toLowerCase());
  if (!grp) {              // новые группы - в начало списка, группа "*" - в конце
    grp = {mask, tables: {}};
    if (mask === "*") g.groups.push(grp); else g.groups.unshift(grp);
  }
  const list = grp.tables[table] ||= [];
  if (!list.some(x => x.toLowerCase() === col.toLowerCase())) list.push(col);
  g.added.add(`${mask.toLowerCase()}|${table}|${col.toLowerCase()}`);
}
function ignRemove(mask, table, col) {
  const g = S.ign, grp = g.groups.find(x => x.mask === mask);
  if (!grp) return;
  const src = ignSource(mask);
  if (src) {
    const who = g.scripts.filter(s => fnRe(mask).test(s)).map(s => s + ".sql").join(", ");
    if (!confirm(mask === "*" ? t("Убрать {col} для всех скриптов?", {col}) : t("Убрать {col} для всех {mask}{who}?", {col, mask, who: who ? " (" + who + ")" : ""}))) return;
  }
  grp.tables[table] = (grp.tables[table] || []).filter(x => x !== col);
  if (!grp.tables[table].length) delete grp.tables[table];
  if (!Object.keys(grp.tables).length) g.groups = g.groups.filter(x => x !== grp);
  renderIgn();
}
function renderIgn() {
  const g = S.ign, changed = JSON.stringify(g.groups) !== g.orig;
  const eff = {};               // таблица -> [{col, mask}]
  for (const grp of g.groups) {
    if (!grp.mask || !fnRe(grp.mask).test(g.stem)) continue;
    for (const [tk, cols] of Object.entries(grp.tables || {})) for (const c of cols) (eff[tk] ||= []).push({col: c, mask: grp.mask});
  }
  const tkeys = Object.keys(eff).sort((a, b) => a === "*" ? -1 : b === "*" ? 1 : a - b);
  const effHtml = tkeys.length ? tkeys.map(tk => `<div class="igt"><span class="igl">${tk === "*" ? t("Все таблицы") : t("Таблица {n}", {n: tk})}</span><span class="igc">${eff[tk].map(x => {
    const src = ignSource(x.mask), isNew = g.added.has(`${x.mask.toLowerCase()}|${tk}|${x.col.toLowerCase()}`);
    return `<span class="igk${isNew ? " new" : ""}">${h(x.col)}${src ? `<span class="pale"> · ${h(src)}</span>` : ""}<a title="${t("Убрать")}" onclick="ignRemove(${h(JSON.stringify(x.mask))}, ${h(JSON.stringify(tk))}, ${h(JSON.stringify(x.col))})">×</a></span>`;
  }).join("")}</span></div>`).join("") : `<span class="pale">${t("Колонок нет: сравниваются все колонки")}</span>`;
  const allCols = [...new Set(Object.values(g.tables).flat())];
  const pfx = ignPrefix(g.stem), inGroup = g.scripts.filter(s => fnRe(pfx + "*").test(s)).map(s => s + ".sql");
  const tOpts = ["*", ...Object.keys(g.tables)].map(tk => `<option value="${h(tk)}">${tk === "*" ? t("все таблицы") : t("таблица {n}", {n: tk})}</option>`).join("");
  modal(`<div class="dlg" style="width:660px"><div class="dh"><h2>${t("Игнорируемые колонки")} · ${h(g.script)}</h2>
      <span class="note">${t("Такие колонки не сравниваются: время расчета, версии строк и т. п. Учитываются при запуске (хэш таблицы считается без них), поэтому изменения действуют со следующего запуска.")}</span></div>
    <div class="db" style="gap:14px;max-height:66vh;overflow:auto">
      <div class="igwarn">${t("Изменения действуют только на новые запуски. Уже выполненные запуски и их сравнения не меняются: колонка учитывается, пока она не попадет в отчет хотя бы одного из двух сравниваемых запусков.")}</div>
      <section class="ignb${changed ? " chg" : ""}">${changed ? `<span class="igpen">${I.pen(34)}</span>` : ""}<span class="lbl">${t("Действует для {name}", {name: h(g.script)})}</span>${effHtml}</section>
      <section class="ignb"><span class="lbl">${t("Добавить")}</span>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <input class="inp" id="ig-col" list="ig-cols" placeholder="${t("Колонка")}" style="flex:1 1 180px" onkeydown="if(event.key==='Enter')ignAddClick()">
          <datalist id="ig-cols">${allCols.map(c => `<option value="${h(c)}">`).join("")}</datalist>
          <select class="inp" id="ig-tab" style="width:150px">${tOpts}</select>
          <select class="inp" id="ig-scope" style="flex:1 1 220px">
            <option value="script">${t("только {name}", {name: h(g.script)})}</option>
            <option value="group">${t("все {mask} — {list}", {mask: h(pfx) + "*", list: h(inGroup.join(", ") || t("нет скриптов"))})}</option>
            <option value="all">${t("все скрипты")}</option></select>
          <a class="btn sm pri" onclick="ignAddClick()">${t("Добавить")}</a></div></section>
      <section class="ignb"><span class="lbl">${t("Автоопределение")}</span>
        <span class="note">${t("Скрипт выполняется на сервере два раза подряд (--repeat 2); колонки, значения которых различаются между прогонами, вписываются сюда в область «только {name}». Это запуск на сервере — только по кнопке.", {name: h(g.script)})}</span>
        <div style="display:flex;gap:18px;align-items:center"><a class="btn sm" onclick="ignAuto()">${I.play(13)}${t("Автоопределение")}</a>
          <span class="popt" onclick="this.firstChild.classList.toggle('on');S.ign.rollback=this.firstChild.classList.contains('on')"><span class="sw${g.rollback ? " on" : ""}"></span>${t("Откат в конце (--rollback) — для скриптов, которые меняют данные")}</span></div></section>
      <details><summary class="lbl" style="cursor:pointer">${t("Все группы (как в CompareQuery.json)")}</summary><pre class="rep" style="padding:10px 0 0">${h(JSON.stringify(g.groups, null, 2))}</pre></details>
    </div>
    <div class="df"><a class="btn" onclick="closeModal()">${t("Отмена")}</a><a class="btn pri" onclick="ignSave()">${t("Сохранить")}</a></div></div>`);
}
function ignAddClick() {
  ignAdd($("#ig-col").value, $("#ig-tab").value, $("#ig-scope").value);
  renderIgn();
}
async function ignSave() {
  try {
    await api("save_ignored", S.ign.groups);
    closeModal();
    toast(t("Игнорируемые колонки сохранены: действуют со следующего запуска"));
    refresh();
  } catch (e) { fail(e); }
}
function ignAuto() {             // двойной прогон; по окончании окно открывается снова с найденными колонками
  const g = S.ign;
  const busy = Object.values(S.procs).find(x => x.info.kind === "run" && x.info.running);
  if (!confirm(t(g.rollback ? "Автоопределение выполнит {name} на сервере два раза с откатом в конце." : "Автоопределение выполнит {name} на сервере два раза.", {name: g.script}) +
    (busy ? " " + t("Уже идет запуск {name}: два запуска сильнее нагружают сервер.", {name: busy.info.title}) : "") + " " + t("Запустить?"))) return;
  api("start_run", g.script, 2, false, g.rollback).then(info => {
    S.procs[info.id] = {info, events: []};
    S.autodetect = {pid: info.id, ign: g};
    closeModal();
    go({k: "run", pid: info.id});
  }).catch(fail);
}
async function autodetectDone(i) {
  const a = S.autodetect;
  S.autodetect = null;
  if (!i.report || i.code !== 0) { toast(t("Автоопределение: запуск не завершился"), true); return; }
  let r;
  try { r = await api("run_details", baseName(i.report)); } catch (e) { fail(e); return; }
  const line = (r.suggestion || "").split("\n").find(x => x.trim().startsWith("{"));
  let found = {};
  try { found = line ? JSON.parse(line).tables || {} : {}; } catch (e) { found = {}; }
  if (!a.ign) {                    // запуск с «Предложить игнорируемые колонки»: окно - только если есть что предложить
    if (!Object.keys(found).length) { toast(t("Игнорируемые колонки: различающихся колонок нет")); return; }
    await ignoreDialog(a.script);
    if (!S.ign) return;
    a.ign = S.ign;
  }
  S.ign = a.ign;
  for (const [tk, cols] of Object.entries(found)) for (const c of cols) ignAdd(c, tk, "script", true);
  if (!Object.keys(found).length) toast(t("Автоопределение: различающихся колонок нет"));
  renderIgn();
}

// ================================================================ рабочая область
function renderMain() {
  const v = S.view, m = $("#main");
  const f = {script: viewScript, run: viewRun, result: viewResult, table: viewTable, compare: viewCompare,
             newsession: viewNewSession, session: viewSession, sessiondone: viewSessionDone, current: viewCurrent, load: viewLoad, dbinfo: viewDbInfo}[v.k];
  if (!f) {
    m.innerHTML = `<div class="empty" style="margin-top:26vh;display:flex;flex-direction:column;align-items:center;gap:22px"><span style="max-width:600px;font-size:15px;line-height:1.6;color:#2D3646">${t("Программа предназначена для сравнения результатов выполнения произвольных запросов. А также замера производительности и для оптимизации.")}</span>
      <span>${S.st && S.st.no_connection ? t("Для начала задайте подключения к базе") : t("Выберите скрипт или запуск слева")}</span></div>`;
    return;
  }
  const r = f(m, v), tab = T.cur;
  // экран, прерванный уходом с вкладки (проверки S.view !== v), при возврате рисуется заново
  if (r && r.finally) r.finally(() => { if (S.view !== v && tab && tab.view === v && tab !== T.cur) tab.stale = true; });
}

// ---------------------------------------------------------------- редактор SQL
async function viewScript(m, v) {
  let s;
  try { s = await api("read_script", v.name); } catch (e) { m.innerHTML = `<div class="empty">${h(e.message || e)}</div>`; return; }
  if (S.view !== v) return;
  const p = Object.assign({repeat: 1, profile: true, rollback: false}, (S.st.params || {})[v.name]);
  const ref = S.st.reference, refScript = ref ? ref.replace(/_\d{8}_\d{6}(_\d+)?\.txt$/, ".sql") : null;
  m.innerHTML = `
    <header class="head"><div style="display:flex;flex-direction:column;gap:8px">${backLine()}
      <h1 style="display:flex;align-items:center;gap:12px">${h(v.name)} <span class="chip c-acc" id="dirty" style="display:none">● ${t("изменен")}</span></h1></div>
      <div class="row">
        <span class="ib big" title="${t("Сохранить (Ctrl+S)")}" onclick="saveScript(true).catch(fail)">${I.save(19)}</span>
        <span class="ib big" title="${t("Перечитать файл с диска")}" onclick="reloadScript()">${I.refresh(19)}</span>
        <span class="ib big" title="${t("Игнорируемые колонки")}" onclick="ignoreDialog(${h(JSON.stringify(v.name))})">${I.filter(19)}</span>
        <span class="ib big" title="${t("Сделать копию…")}" onclick="saveScript().then(() => copyScriptDialog(${h(JSON.stringify(v.name))}), fail)">${I.copy(19)}</span>
        ${refScript && refScript.toLowerCase() !== v.name.toLowerCase() ? diffButton(t("Сравнить с опорным"), "script", [v.name]) : ""}
        <a class="btn" onclick="api('open_path', ${h(JSON.stringify(S.st.folder + "\\" + v.name))}).catch(fail)" title="${t("Открыть программой по умолчанию")}">${I.open(17)}${t("Открыть файл")}</a>
        <a class="btn" id="q-btn" style="${runBusy() ? "" : "display:none"}" title="${t("Запустится, когда закончится текущий запуск")}" onclick="saveAndRun(true)">${I.play(16)}${t("В очередь")}</a>
        <a class="btn pri" onclick="saveAndRun()">${I.play(16)}${t("Запустить")}</a>
      </div></header>
    <section class="card" style="padding:14px 20px;display:flex;flex-wrap:wrap;align-items:center;gap:28px">
      <span class="lbl">${t("Параметры запуска")}</span>
      <span class="popt">${t("Повторов")} <input class="num" id="p-rep" type="number" min="1" max="20" value="${p.repeat}" oninput="$('#p-warm').style.visibility=+this.value>1?'':'hidden'"><span class="pale" id="p-warm" style="font-size:12px${p.repeat > 1 ? "" : ";visibility:hidden"}">${t("первый — прогрев")}</span></span>
      <span class="popt" onclick="this.firstChild.classList.toggle('on')"><span class="sw${p.profile ? " on" : ""}" id="p-prof"></span>${t("Профиль операторов")}</span>
      <span class="popt" onclick="this.firstChild.classList.toggle('on')"><span class="sw${p.rollback ? " on" : ""}" id="p-rb"></span>${t("Откат в конце (--rollback)")}</span>
      ${dbms().can_explain ? `<span class="popt" title="${t("Фактические планы операторов (auto_explain, нужны права суперпользователя; без них — отдельный прогон EXPLAIN ANALYZE, только с откатом). Включает профиль; время такого запуска завышено замером планов")}"><span class="sw${p.explain != null ? " on" : ""}" id="p-exp" onclick="explainToggle()"></span><span onclick="explainToggle()">${t("Планы (--explain)")}</span>
        <span class="pale" style="font-size:12px">${t("от")}</span><input class="num" id="p-exms" type="number" min="0" value="${p.explain || 0}" title="${t("План пишется для операторов не короче стольких мс (0 — для всех)")}"><span class="pale" style="font-size:12px">${t("мс")}</span></span>` : ""}
      <span class="popt" onclick="ignSuggestToggle()" title="${t("Два прогона: первый — прогрев, после запуска откроется окно игнорируемых колонок с колонками, которые различаются между прогонами (можно поправить или отказаться). Параметры этого запуска не запоминаются")}"><span class="sw" id="p-ign"></span>${t("Предложить игнорируемые колонки")}</span>
      <span class="pale" style="margin-left:auto;font-size:12px" id="p-mem">${t("запоминаются для скрипта")}</span>
    </section>
    <section class="card" style="display:flex;flex-direction:column;flex:1;min-height:420px;overflow:hidden">
      <div class="ed"><div class="ln" id="ln"></div><div class="edw"><pre class="code hl" id="hl" aria-hidden="true"></pre><textarea class="code" id="code" spellcheck="false"></textarea></div></div>
      <div class="status"><span id="pos">${t("Строка {n}", {n: 1})}</span><span style="margin-left:auto">${t("Ctrl+S — сохранить")}</span></div>
    </section>`;
  const ta = $("#code"), ln = $("#ln"), hl = $("#hl");
  ta.value = s.text;
  S.live.saved = s.text;
  // подсветка: под прозрачным текстом textarea - pre с тем же текстом в цветах (шрифт и отступы одинаковые)
  const lines = () => {
    ln.textContent = Array.from({length: ta.value.split("\n").length}, (_, i) => i + 1).join("\n");
    hl.innerHTML = hlSql(ta.value) + "\n";
  };
  lines();
  hydrateDiffButtons();
  ta.addEventListener("input", () => { lines(); $("#dirty").style.display = ta.value !== S.live.saved ? "" : "none"; });
  ta.addEventListener("scroll", () => { ln.scrollTop = ta.scrollTop; hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; });
  ta.addEventListener("keyup", () => { $("#pos").textContent = t("Строка {n}", {n: ta.value.slice(0, ta.selectionStart).split("\n").length}); });
  ta.addEventListener("keydown", e => {         // Ctrl+S - общий обработчик клавиш (по e.code)
    if (e.key === "Tab") { e.preventDefault(); ta.setRangeText("\t", ta.selectionStart, ta.selectionEnd, "end"); ta.dispatchEvent(new Event("input")); }
  });
  // позиция курсора и прокрутка - своя у каждого скрипта (до закрытия приложения); впервые - начало текста.
  // Без этого focus() ставил курсор в конец и прокручивал вниз
  const pos = (S.scriptPos ||= {})[v.name] || {sel: 0, top: 0};
  ta.setSelectionRange(pos.sel, pos.sel);
  ta.focus({preventScroll: true});
  ta.scrollTop = pos.top;
  ta.dispatchEvent(new Event("keyup"));
  const keep = () => { S.scriptPos[v.name] = {sel: ta.selectionStart, top: ta.scrollTop}; };
  ["scroll", "keyup", "mouseup"].forEach(ev => ta.addEventListener(ev, keep));
}
// подсветка синтаксиса T-SQL: комментарии, строки, [имена], @переменные, #временные таблицы, числа, ключевые слова
const SQL_KW = new Set(("select from where and or not insert into update delete set values create table drop alter exec execute declare " +
  "begin end if else while return as on join left right inner outer full cross apply group by order having union all distinct top " +
  "case when then is null like in exists between with nolock go print raiserror truncate merge using output cursor fetch next open " +
  "close deallocate transaction tran commit rollback try catch throw procedure proc function view index primary key identity default " +
  "nocount option recompile asc desc over partition row_number count sum min max avg cast convert isnull coalesce temp waitfor delay " +
  "except intersect pivot unpivot readuncommitted holdlock updlock rowlock tablock nowait").split(" "));
function hlSql(s) {
  const re = /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(N?'(?:[^']|'')*(?:'|$))|(\[[^\]\n]*\]?)|(@@?\w+)|(#{1,2}\w+)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)/g;
  let out = "", last = 0, m;
  while ((m = re.exec(s))) {
    const t = m[0];
    const c = m[1] ? "c" : m[2] ? "s" : m[3] ? "q" : m[4] ? "v" : m[5] ? "t" : m[6] ? "n" : SQL_KW.has(t.toLowerCase()) ? "k" : "";
    out += h(s.slice(last, m.index)) + (c ? `<span class="x${c}">${h(t)}</span>` : h(t));
    last = re.lastIndex;
  }
  return out + h(s.slice(last));
}
async function saveScript(notify) {
  const ta = $("#code");
  if (!ta) return;
  await api("save_script", S.view.name, ta.value);
  S.live.saved = ta.value;
  $("#dirty").style.display = "none";
  if (notify) toast(t("Сохранено"));
}
function reloadScript() {
  const ta = $("#code");
  if (!ta || ta.value === S.live.saved) { renderMain(); return; }
  modal(`<div class="dlg" style="width:420px"><div class="dh"><h2>${t("Перечитать файл?")}</h2><span class="note">${t("Несохраненные изменения в редакторе пропадут.")}</span></div>
    <div class="df"><a class="btn" onclick="closeModal()">${t("Отмена")}</a><a class="btn dark" onclick="closeModal();renderMain()">${t("Перечитать")}</a></div></div>`);
}
// «Предложить игнорируемые колонки»: повторов ровно 2 (поле не редактируется), параметры не запоминаются;
// выключили - в поле прежнее число
function ignSuggestToggle() {
  const sw = $("#p-ign"), rep = $("#p-rep"), on = !sw.classList.contains("on");
  sw.classList.toggle("on", on);
  if (on) { rep.dataset.prev = rep.value; rep.value = 2; } else rep.value = rep.dataset.prev || 1;
  rep.disabled = on;
  $("#p-warm").style.visibility = +rep.value > 1 ? "" : "hidden";
  $("#p-mem").style.visibility = on ? "hidden" : "";
}
// «Планы (--explain)» включает и профиль (CLI включает его сам, переключатель показывает это)
function explainToggle() {
  const on = $("#p-exp").classList.toggle("on");
  if (on) $("#p-prof").classList.add("on");
}
async function saveAndRun(queue) {
  try {
    await saveScript();
    const suggest = $("#p-ign").classList.contains("on");
    const exp = $("#p-exp"), p = {repeat: suggest ? 2 : Math.max(1, +$("#p-rep").value || 1), profile: $("#p-prof").classList.contains("on"), rollback: $("#p-rb").classList.contains("on"),
      explain: exp && exp.classList.contains("on") ? Math.max(0, +$("#p-exms").value || 0) : null};
    if (!suggest) {
      S.st.params = Object.assign({}, S.st.params, {[S.view.name]: p});
      api("set_gui", "params", S.st.params).catch(fail);
    }
    (queue ? queueRun : startRun)(S.view.name, Object.assign({suggest}, p));
  } catch (e) { fail(e); }
}
// «В очередь»: скрипт запустится, когда закончится текущий запуск. Очередь - из одного скрипта:
// новый заменяет прежний. Живет в окне приложения (закрыли - очереди нет).
function queueRun(name, p) {
  if (!runBusy()) { startRun(name, p); return; }
  S.queue = {name, p};
  toast(t("{name} запустится после текущего запуска", {name}));
  renderSide();
}
function startRun(name, p, force, quiet) {       // quiet - из очереди: экран не меняется
  p = p || Object.assign({repeat: 1, profile: true, rollback: false}, (S.st.params || {})[name]);
  const busy = Object.values(S.procs).find(x => x.info.kind === "run" && x.info.running);
  if (busy && !force) {          // §6.6: второй запуск - после предупреждения
    window._pending = [name, p];
    modal(`<div class="dlg" style="width:420px"><div class="dh"><h2>${t("Уже идет запуск")}</h2><span class="note"><b style="color:#1B2230">${h(busy.info.title)}</b>. ${t("Два запуска одновременно сильнее нагружают сервер и влияют на замеры друг друга.")}</span></div>
      <div class="df" style="border-top:none"><a class="btn" onclick="closeModal();startRun(..._pending, true)">${t("Запустить все равно")}</a><a class="btn pri" onclick="closeModal()">${t("Отмена")}</a></div></div>`);
    return;
  }
  // --explain - только у СУБД, которая его умеет (параметры скрипта могли запомниться с другим подключением)
  api("start_run", name, p.repeat, p.profile, p.rollback, p.explain != null && dbms().can_explain ? p.explain : null).then(info => {
    S.procs[info.id] = {info, events: []};
    if (p.suggest) S.autodetect = {pid: info.id, script: name};      // по окончании - окно игнорируемых колонок
    if (quiet) renderSide(); else go({k: "run", pid: info.id});
  }).catch(fail);
}

// ---------------------------------------------------------------- счетчик с прокруткой (§5.11, 250 мс)
// Как механический счетчик: число выросло - все изменившиеся разряды крутятся вперед (9 -> 0 тоже вперед),
// уменьшилось - все назад. Разряды сопоставляются справа; новых старших разрядов раньше не было - они
// крутятся от 0. Младшие разряды чуть быстрее старших (190-250 мс), в целом одновременно.
// Колонка цифр - 0..9 дважды: прокрутка идет до нужной цифры в соседнем десятке, а после нее колонка
// стоит на той же цифре первого десятка (вид тот же).
const ROLL_MS = 250, ROLL_EM = 1.2;
const ROLL_COL = "0123456789".repeat(2).split("").join("<br>");
function rollHtml(text) {
  return [...text].map(ch => /\d/.test(ch)
    ? `<span class="dg"><i style="transform:translateY(-${+ch * ROLL_EM}em)">${ROLL_COL}</i></span>`
    : (ch === " " ? "&#8239;" : h(ch))).join("");
}
function digitsCmp(a, b) {        // сравнение чисел из цифр строки (длина без ведущих нулей, затем текст)
  a = a.replace(/^0+/, ""); b = b.replace(/^0+/, "");
  return a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;
}
function setRoll(el, text) {
  text = String(text);
  if (!el || el.dataset.v === text) return;
  const old = el.dataset.v;
  el.dataset.v = text;
  el.innerHTML = rollHtml(text);
  if (old === undefined || !el.animate) return;
  const od = (old.match(/\d/g) || []).join(""), nd = (text.match(/\d/g) || []).join("");
  const dir = Math.sign(digitsCmp(nd, od));
  if (!dir) return;
  const cols = el.querySelectorAll(".dg i"), n = cols.length;
  cols.forEach((col, k) => {
    const r = n - 1 - k;                                     // разряд, считая справа
    const to = +nd[k], from = r < od.length ? +od[od.length - 1 - r] : 0;
    const steps = (dir > 0 ? to - from : from - to) + 10;
    if (steps % 10 === 0) return;
    const a = dir > 0 ? from : from + 10, b = dir > 0 ? from + steps % 10 : from + 10 - steps % 10;
    col.animate([{transform: `translateY(-${a * ROLL_EM}em)`}, {transform: `translateY(-${b * ROLL_EM}em)`}],
      {duration: n > 1 ? ROLL_MS - 60 * (1 - r / (n - 1)) : ROLL_MS, easing: "cubic-bezier(.2,.7,.3,1)"});
  });
}
function kpiBox(id, label, small) {
  return `<div class="card kpi"><span class="lbl">${t(label)}</span><span class="v"><span id="${id}">—</span>${small ? ` <small>${t(small)}</small>` : ""}</span><span class="dur" id="${id}-d">&nbsp;</span></div>`;
}
function setKpi(id, v, ms) {          // v null - счетчика у сервера нет (CPU у PostgreSQL)
  setRoll($("#" + id), v === null ? "—" : nf(v ?? 0));
  const d = $("#" + id + "-d");
  if (d) { if (ms && v >= 1000) setRoll(d, dur(v)); else { d.innerHTML = "&nbsp;"; delete d.dataset.v; } }
}
// плашка задержек выборки (--profile, --session): ответ сервера на опрос дольше 80 мс. Красная рамка,
// если задержек больше SLOW_WARN_MS или больше SLOW_WARN_PCT % времени запроса (total, мс); меньше
// SLOW_OK_PCT % времени запроса - не красная в любом случае. slow - {count, ms} или null (нет данных)
const SLOW_WARN_MS = 5000, SLOW_WARN_PCT = 1, SLOW_OK_PCT = 0.05;
function slowWarn(ms, total) {
  if (total > 0 && ms * 100 < total * SLOW_OK_PCT) return false;
  return ms > SLOW_WARN_MS || (total > 0 && ms * 100 > total * SLOW_WARN_PCT);
}
function slowBox(id, slow, hidden, total) {
  const c = slow ? slow.count : 0, ms = slow ? slow.ms : 0;
  return `<div class="card kpi slowk${slowWarn(ms, total) ? " warn" : ""}" id="${id}"${hidden ? ' style="display:none"' : ""}>
    <span class="lbl">${t("Задержки выборки")}</span>
    <span class="v"><span class="c">${nf(c)}</span> <small>· <span class="m">${nf(ms)}</span> ${t("мс")}</small></span>
    <span class="sn">${t("Ответы сервера на опрос дольше 80 мс. Чем их больше, тем менее точно время распределено по операторам")}</span></div>`;
}
function setSlow(id, count, ms, total) {
  const el = $("#" + id);
  if (!el) return;
  el.style.display = "";
  el.classList.toggle("warn", slowWarn(ms, total));
  el.querySelector(".c").textContent = nf(count);
  el.querySelector(".m").textContent = nf(ms);
}

// Оценка выполнения по похожему запуску (§4.1): последний завершенный запуск того же скрипта с тем же
// числом прогонов и профилем; его общее время («Общее время запуска» отчета) - 100%. Грубая подсказка,
// полосу прогресса не меняет.
function etaBase(script, repeat, profile) {
  const sc = (S.st.scripts || []).find(x => x.stem === script);
  const r = sc && sc.runs.find(x => !x.aborted && x.total > 0 && (+x.repeat || 1) === (+repeat || 1) && !!x.profile === !!profile);
  return r ? {total: r.total, ts: r.ts, shown: ""} : null;
}
function etaTick(now) {
  const L = S.live, el = L && L.eta && $("#r-eta");
  if (!el) return;
  const e = L.eta, done = now - e.t0, pct = Math.floor(done * 100 / e.total);
  const txt = done <= e.total ? t("≈ {p}% · осталось ≈ {left}", {p: pct, left: clock(e.total - done)})
    : t("≈ дольше похожего на {over}", {over: clock(done - e.total)});
  if (txt === e.shown) return;
  e.shown = txt;
  el.textContent = txt;
  el.title = t("Оценка по похожему запуску {when} ({dur}): тот же скрипт, столько же прогонов, тот же профиль. Приблизительно", {when: tsText(e.ts), dur: clock(e.total)});
}
// бегущее время: элементы с data-t0 (мс эпохи) и необязательным data-t1 (остановлено)
function tick() {
  const now = Date.now();
  etaTick(now);
  if (qtipEl && !qtipEl.isConnected) qtipHide();      // элемент с подсказкой перерисован (таблица раз в 4 с)
  if (S.live.wbar && now - (S.live.wbarAt || 0) > 2000) { S.live.wbarAt = now; S.live.wbar(); }    // полоса идущего запуска
  document.querySelectorAll("[data-t0]").forEach(el => {
    const t1 = el.dataset.t1 ? +el.dataset.t1 : now;
    el.textContent = clock(t1 - +el.dataset.t0, true);
  });
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- идет запуск (§4.1)
function viewRun(m, v) {
  const p = S.procs[v.pid];
  if (!p) { m.innerHTML = `<div class="empty">${t("Процесс не найден")}</div>`; return; }
  const i = p.info;
  m.innerHTML = `
    <header class="head"><div style="display:flex;flex-direction:column;gap:8px">${backLine()}
      <h1 style="display:flex;align-items:center;gap:14px">${t("Запуск")} <span id="r-when">${h(procWhen(p))}</span> <span class="chip c-acc" id="r-chip"><span class="pulse"></span>${t("идет")} · <span class="tm" data-t0="${Date.parse(i.started)}"></span></span></h1>
      <span class="noteed" title="${t("Заметка к запуску")}">${I.pen(15)}<span class="txt" data-ph="${t("+ заметка")}" contenteditable="true" onblur="S.runNotes[${i.id}] = this.textContent.trim()" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}">${h(S.runNotes[i.id] || "")}</span></span>
      <div class="row"><span class="row" id="r-params"></span><span class="chip" id="r-spid" style="display:none" title="${t("Сессия на сервере, в которой выполняется скрипт")}"></span></div></div>
      <a class="btn" id="r-stop" style="color:#9A3412" title="${t("Текущий оператор на сервере отменяется сразу")}" onclick="api('stop', ${i.id})">${I.stop(14)}${t("Остановить")}</a></header>
    <section class="card" style="padding:22px 24px;display:flex;flex-direction:column;gap:16px">
      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:12px">
        <span style="font-size:18px;font-weight:700" id="r-pos">${t("Подключение…")}</span>
        <span class="tm" id="r-ptm" style="font-size:26px;font-weight:500;color:#2D3646"></span></div>
      <div class="track"><div class="seg" id="r-seg"></div><div class="fill" id="r-fill" style="width:2%"></div></div>
      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:12px"><div style="display:flex;flex-wrap:wrap;gap:28px" id="r-steps"></div><span class="eta" id="r-eta"></span></div>
    </section>
    <section class="stack" id="r-stack"></section>
    <section class="kpis">${kpiBox("k-t", "Время", "мс")}${kpiBox("k-c", "CPU", "мс")}${kpiBox("k-r", "Логических чтений")}${kpiBox("k-n", "Таблиц получено")}${slowBox("k-slow", null, true)}</section>
    <section class="card wcard" id="r-waits" style="display:none"></section>
    <section class="card tw${tcolCls("journal")}">${tcolBtn("journal")}<div class="tbar"><h2>${t("Журнал")}</h2><span class="lbl">${t("ход выполнения и сообщения SQL (PRINT, RAISERROR, ошибки) · время сервера · новые строки снизу")}</span></div>
      <div class="logbox" id="r-log"></div></section>`;
  S.live = {cards: []};
  updateLive();
}
function opcHtml(title, text, t0, prev) {      // карточка оператора или батча в стопке (§5.10)
  return `<div class="oph"><span class="lbl now">${t("Сейчас выполняется")}</span><span class="wbox"></span>${optmHtml(t0, prev)}</div>
      <div class="opb"><div class="opn">${title}</div><div class="opx" title="${h(text)}">${h(text)}</div></div>`;
}
// Стопка «Сейчас выполняется» (§5.10): текущая карточка, прошлая и позапрошлая, тающая маской.
// Смена: новая карточка сразу встает на свое место под прежними, прежние едут со своих мест на позицию
// ниже с замедлением (settleMs) и открывают ее; открываясь, новая коротко вспыхивает (рамка и фон ярче -
// резко, затем плавно обратно, flashMs; только внутри своей рамки, поэтому прежнюю не красит, а пока
// прежняя ее накрывает, вспышки не видно - она начинается с задержкой flashDelay). Пока карточка не простояла holdMs, пришедшие ждут;
// показывается последняя из них (быстрые операторы пропускаются, они есть в журнале и реестре).
// «прошлый»: сколько тот же оператор (батч) шел в прошлый раз в этом же запуске или наблюдении - циклы,
// повторные вызовы процедуры, следующие прогоны. Считается при получении событий (evAdd; журнал на диске
// обновляется только раз в 10 с): длительность - от события оператора до следующего, как у остановленного
// таймера. Короче PREV_MIN_MS не показывается.
const PREV_MIN_MS = 300;
// ключ - без текста: объект и строка оператора однозначны, а тяжелые тексты в словаре не нужны; записей -
// столько, сколько разных операторов, повторы (цикл 1000 раз) перезаписывают свою
const opKey = e => e.event === "batch" ? "batch " + e.k : e.object + ":" + e.line;
function optmHtml(t0, prev) {
  return `<span class="optw"><span class="tm optm" data-t0="${t0}"></span>${prev >= PREV_MIN_MS ? `<span class="opprev">${t("прошлый")} ${clock(prev, true)}</span>` : ""}</span>`;
}
const STK = {gap: 12, flashMs: 500, flashDelay: 120, settleMs: 450, holdMs: 350};
const slotTop = (k, s) => s * (k.h + STK.gap);
function stackShow(el, slots) {
  const st = $("#r-stack"), L = S.live;
  if (!st) return;
  const k = L.stk ||= {cards: [], busy: false, next: null, h: 0};
  if (k.busy) { k.next = el; return; }
  k.busy = true;
  k.slots = slots;
  for (const c of k.cards) if (++c._slot >= k.slots) c.remove();
  k.cards = k.cards.filter(c => c._slot < k.slots);
  el._slot = 0;
  el.style.top = "0px";
  el.style.zIndex = k.z = (k.z || 100000) - 1;
  st.prepend(el);
  // высота места - по самой высокой из показанных карточек (карточка без текста ниже, после нее
  // карточки с текстом шли бы вплотную рамками)
  if (el.offsetHeight > k.h) { k.h = el.offsetHeight; stackLayout(st, k); }
  // прежние едут со своих мест (с того места, где видны сейчас) на позицию ниже и открывают новую:
  // новая карточка - под прежними (z-index убывает с каждой новой)
  const under = k.cards.length > 0;
  for (const c of k.cards) {
    const v = c.getBoundingClientRect().top - st.getBoundingClientRect().top;
    slide(c, slotTop(k, c._slot), v - slotTop(k, c._slot), STK.settleMs);
  }
  k.cards.unshift(el);
  el.animate([{borderColor: "#9FB2F2", backgroundColor: "#F7F9FF"},
              {borderColor: "#6D87E6", backgroundColor: "#ECF0FF", offset: 0.12},
              {borderColor: "#9FB2F2", backgroundColor: "#F7F9FF"}],
             {duration: STK.flashMs, delay: under ? STK.flashDelay : 0, easing: "ease-out"});
  setTimeout(() => {
    k.busy = false;
    const n = k.next;
    k.next = null;
    if (n) stackShow(n, slots);
  }, STK.holdMs);
}
// карточка встает верхом в y и съезжает к нему со смещения from с замедлением
function slide(c, y, from, ms) {
  c.getAnimations().forEach(a => a.cancel());
  c.style.top = y + "px";
  c.animate([{transform: `translateY(${from}px)`}, {transform: "none"}], {duration: ms, easing: "cubic-bezier(.15,.6,.3,1)"});
}
// высота стопки - по высоте места k.h. Три места: стопка кончается на середине третьей карточки,
// маска прозрачности - от ее верхней рамки (видна) до середины (прозрачно), поэтому следующие блоки
// страницы идут сразу за ней, без пустого куска фона
function stackLayout(st, k) {
  const slots = k.slots;
  if (slots === 3) {
    const third = slotTop(k, 2);
    st.style.height = third + Math.round(k.h / 2) + "px";
    st.style.webkitMaskImage = st.style.maskImage = `linear-gradient(#000 0, #000 ${third + 6}px, transparent 100%)`;
  } else st.style.height = slotTop(k, slots - 1) + k.h + "px";
}
function updateRun(p) {
  const i = p.info, ev = p.events, L = S.live;
  const start = ev.find(e => e.event === "start");
  if (start && !L.params) {
    L.params = true;
    $("#r-params").innerHTML = (start.repeat > 1 ? `<span class="chip">${t("повторов {n}", {n: start.repeat})}</span>` : "") +
      (start.profile ? `<span class="chip">${t("профиль")}</span>` : "") + `<span class="chip">${start.rollback ? "rollback" : "autocommit"}</span>`;
    if (start.profile) setSlow("k-slow", 0, 0);
    L.eta = etaBase(i.script, start.repeat, start.profile);
    if (L.eta) L.eta.t0 = Date.parse(i.started);
  }
  if (!L.when && srvOffset(p)) { L.when = true; $("#r-when").textContent = procWhen(p); }
  const sp = [...ev].reverse().find(e => e.event === "spid");       // у каждого прогона свое подключение
  if (sp && L.spid !== sp.spid) { L.spid = sp.spid; const el = $("#r-spid"); el.textContent = t("сессия {n}", {n: sp.spid}); el.style.display = ""; }
  const passes = ev.filter(e => e.event === "pass"), pass = passes[passes.length - 1];
  const batches = ev.filter(e => e.event === "batch"), batch = batches[batches.length - 1];
  const of = pass ? pass.of : (start ? start.repeat : 1);
  if (pass) {
    $("#r-pos").textContent = (of > 1 ? t("Прогон {k} из {of}", {k: pass.k, of}) : t("Выполнение")) + (batch && batch.pass === pass.k ? " · " + t("батч {k} из {of}", batch) : "");
    const ptm = $("#r-ptm");
    ptm.dataset.t0 = evMs(pass);
    const frac = batch && batch.pass === pass.k ? (batch.k - 1) / batch.of : 0;
    const done = Math.max(2, ((pass.k - 1 + frac) / of) * 100);
    $("#r-fill").style.width = done + "%";
    // несколько прогонов: участок, который закрасится по окончании текущего, - светлее, по нему бегает
    // ползунок (как у полосы без известного процента)
    const seg = $("#r-seg");
    seg.style.display = of > 1 && i.code === null ? "" : "none";
    seg.style.left = done + "%";
    seg.style.width = Math.max(0, pass.k / of * 100 - done) + "%";
    const lastCounters = k => [...ev].reverse().find(e => e.event === "counters" && e.pass === k);
    $("#r-steps").innerHTML = Array.from({length: of}, (_, n) => {
      const k = n + 1, c = lastCounters(k);
      if (k < pass.k) return `<div class="step"><span class="dot c-ok">✓</span><span>${t("Прогон {k}", {k})}${k === 1 && of > 1 ? ` <span class='pale'>· ${t("прогрев")}</span>` : ""}${c ? ` <span class="pale">· ${nf(c.time_ms)} ${t("мс")} <span class="dur">${dur(c.time_ms)}</span></span>` : ""}</span></div>`;
      if (k === pass.k) return `<div class="step"><span class="dot" style="background:#3B5BDB;color:#FFF">${k}</span><span style="font-weight:600">${t("Прогон {k}", {k})} <span class="pale" style="font-weight:500">· ${t("идет")}</span></span></div>`;
      return `<div class="step"><span class="dot" style="background:#EEF1F6;color:#485264">${k}</span><span class="pale">${t("Прогон {k}", {k})}</span></div>`;
    }).join("");
    const c = lastCounters(pass.k);
    if (c) { setKpi("k-t", c.time_ms, true); setKpi("k-c", c.cpu_ms, true); setKpi("k-r", c.logical_reads); }
    else { setKpi("k-t", 0, true); setKpi("k-c", 0, true); setKpi("k-r", 0); }
    const got = ev.filter(e => e.event === "table" && e.pass === pass.k);      // счетчики - текущего прогона
    setKpi("k-n", got.length);
    $("#k-n-d").textContent = got.length ? t("всего строк") + " " + nf(got.reduce((s, e) => s + e.rows, 0)) : " ";
    if (start && start.profile) {      // задержки выборки текущего прогона
      const s = [...ev].reverse().find(e => e.event === "slow" && e.pass === pass.k);
      setSlow("k-slow", s ? s.count : 0, s ? s.ms : 0, c ? c.time_ms : 0);
    }
  }
  // текущая работа: операторы (--profile) или батчи
  const items = ev.filter(e => e.n > (L.n || 0) && (e.event === "statement" || e.event === "idle" || (!start?.profile && e.event === "batch")));
  for (const e of items) {
    L.n = e.n;
    L.stmt = e;
    const prev = L.cards[L.cards.length - 1];
    if (prev) finishCard(prev, evMs(e));
    if (L.cards.length > 4) L.cards.shift();      // показано не больше трех: прежние больше не нужны
    if (e.event === "idle") { L.cards.push(null); continue; }
    const el = document.createElement("div");
    el.className = "opc";
    const title = e.event === "batch" ? `${t("Батч {k}", e)} <span>${t("из {of}", e)}${e.ignored ? " · " + t("служебный") : ""}</span>` : `${h(e.object)} <span>${t("строка {n}", {n: e.line})}</span>`;
    const text = e.text;      // у batch - начало батча (CLI делит файл сам: GO у MS SQL Server, ";" у PostgreSQL)
    el.innerHTML = opcHtml(title, text, evMs(e), e.prev);
    L.cards.push(el);
    if (e.wait) setWait(el, e.wait, e.blocked_by, evMs(e));
    stackShow(el, start?.profile ? 3 : Math.min(3, e.of || 3));
  }
  const cur = L.cards[L.cards.length - 1];
  if (cur) {                             // ожидание текущего оператора (§5.8); карточка может ждать показа
    const waits = ev.filter(e => e.event === "wait" && evMs(e) >= evMs(L.stmt));
    const w = waits[waits.length - 1];
    if (w && w !== L.lastWait) { L.lastWait = w; setWait(cur, w.wait, w.blocked_by, evMs(w)); }
  }
  if (i.code !== null && cur) finishCard(cur, Date.now());
  // журнал: строки CompareQuery и сообщения SQL в порядке поступления, время сервера
  const logs = ev.filter(e => e.n > (L.logN || 0) && (e.event === "log" || e.event === "message")), box = $("#r-log");
  if (box && logs.length) {
    const bottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;   // прокрутка вниз, если журнал внизу
    for (const e of logs) {
      const d = document.createElement("div");
      if (e.event === "message") {
        d.className = "logl msg" + (e.error ? " err" : "");
        d.innerHTML = `<span>${h(hms(new Date(Date.parse(e.server_time)), true))}</span><span><b class="tagm">${e.error ? t("ошибка") : "SQL"}</b>${h(e.text)}</span>`;
      } else {
        d.className = "logl";
        d.innerHTML = `<span>${h(hms(srvDate(p, evMs(e))))}</span><span>${h(e.text)}</span>`;
      }
      box.appendChild(d);
    }
    L.logN = logs[logs.length - 1].n;
    // на экране - последние EV_KEEP строк (PRINT в цикле); все - в журнале запуска (_message.txt)
    while (box.childElementCount > EV_KEEP) box.firstChild.remove();
    if (bottom) box.scrollTop = box.scrollHeight;
  }
  if (start && start.profile) {          // полоса ожиданий по событиям; пока идет - и по таймеру (tick)
    const ex = ev.find(e => e.event === "exit");
    L.wbar = () => liveWaits("r-waits", evWaitItems(p, ex ? evMs(ex) : Date.now()));
    L.wbar();
  }
  if (i.code !== null && L.eta) { L.eta = null; const e = $("#r-eta"); if (e) e.textContent = ""; }
  if (i.code !== null) {
    if (!pass) $("#r-pos").textContent = t("Запуск не выполнен");
    $("#r-chip").innerHTML = i.code === 0 ? t("завершен") : t("завершен с кодом {code}", {code: i.code});
    $("#r-stop").setAttribute("disabled", "");
  }
}
// плашка с полосой ожиданий идущего запуска или наблюдения: перерисовывается, только если изменилась
function liveWaits(id, items) {
  const el = $("#" + id);
  if (!el) return;
  const html = waitBarHtml(items);
  if (el._html === html) return;
  el._html = html;
  el.innerHTML = html;
  el.style.display = html ? "" : "none";
}
function finishCard(el, end) {           // end - время окончания (мс); имя не t: t() - перевод
  if (!el || el.classList.contains("done")) return;
  el.classList.add("done");
  el.querySelector(".lbl.now").textContent = t("Завершено");
  const tm = el.querySelector(".optm");
  if (tm && !tm.dataset.t1) tm.dataset.t1 = end;
  const w = el.querySelector(".wbox");
  if (w) w.innerHTML = "";
}
function setWait(el, wait, by, t0) {     // ожидание: появилось (жирно, пульс, время), кончилось (тает вправо)
  const box = el.querySelector(".wbox");
  if (!box) return;
  const cur = box.querySelector(".wt");
  if (wait) {
    box.innerHTML = `<span class="wt">${waitHtml(wait)} <span class="tm" data-t0="${t0}"></span>${by ? " · " + t("ждет {n}", {n: by}) : ""}</span>`;
  } else if (cur && !cur.classList.contains("ended")) {
    cur.classList.add("ended");
    const tm = cur.querySelector(".tm");
    if (tm) tm.dataset.t1 = t0;
    setTimeout(() => cur.classList.add("fade"), 2000);
    setTimeout(() => { if (cur.parentNode === box) cur.remove(); }, 5200);
  }
}

// ---------------------------------------------------------------- итог запуска
async function viewResult(m, v) {
  let r;
  try { r = await api("run_details", v.report); } catch (e) { m.innerHTML = `<div class="empty">${h(e.message || e)}</div>`; return; }
  if (S.view !== v) return;
  S.live.result = r;
  const sum = r.summary, ref = r.reference, ts = (v.report.match(/_(\d{8}_\d{6})/) || [])[1];
  const isRef = S.st.reference === v.report, script = v.report.replace(/_\d{8}_\d{6}(_\d+)?\.txt$/, ".sql");
  let verdict;
  if (r.aborted) verdict = `<div class="card verdict v-diff"><span class="ic">!</span><span style="display:flex;flex-direction:column;gap:3px"><span style="font-size:18px;font-weight:700">${t("Запуск прерван")}</span><span class="lbl">${h(r.aborted)}</span></span></div>`;
  else if (isRef) verdict = `<div class="card verdict v-none"><span class="ic">${I.star(20, true)}</span><span style="font-size:16px;font-weight:600">${t("Это опорный запуск: с ним сравниваются остальные")}</span></div>`;
  else if (!ref) verdict = `<div class="card verdict v-none"><span class="ic">★</span><span class="lbl" style="font-size:14px">${t("Опорного запуска нет: отметьте ★ запуск, с которым сравнивать")}</span></div>`;
  else if (!ref.comparable) verdict = `<div class="card verdict v-none"><span class="ic">≁</span><span style="display:flex;flex-direction:column;gap:3px"><span style="font-size:17px;font-weight:700">${t("Несравним с опорным")}</span><span class="lbl">${h(ref.why)} · ${t("опорный — {name}", {name: h(ref.report)})}</span></span><a class="btn sm" style="margin-left:auto" onclick="startCompare(${h(JSON.stringify(ref.report))}, ${h(JSON.stringify(v.report))})">${t("Сравнить все равно")}</a></div>`;
  else {
    const t0 = ref.summary.time, t1 = sum.time, d = t0 && t1 != null ? Math.round((t1 - t0) * 100 / t0) : null;
    const tail = t("опорный — {name}", {name: h(ref.report)}) + (d !== null ? " · " + t("время {d}", {d: `${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d)}%`}) : "");
    const more = ref.compared ? t("Подробнее") : t("Сравнить");    // «Подробнее» - сравнение уже сделано, откроется сразу
    verdict = ref.same
      ? `<div class="card verdict v-ok"><span class="ic">=</span><span style="display:flex;flex-direction:column;gap:3px"><span style="font-size:18px;font-weight:700">${t("Данные совпадают с опорным")}</span><span class="lbl">${tail}</span></span><a class="btn sm" style="margin-left:auto" onclick="startCompare(${h(JSON.stringify(ref.report))}, ${h(JSON.stringify(v.report))})">${more}</a></div>`
      : `<div class="card verdict v-diff" style="cursor:pointer" onclick="startCompare(${h(JSON.stringify(ref.report))}, ${h(JSON.stringify(v.report))})"><span class="ic">≠</span><span style="display:flex;flex-direction:column;gap:3px"><span style="font-size:18px;font-weight:700">${t("Данные различаются с опорным в {n} табл. из {of}", {n: ref.diff_tables.length, of: Object.keys(r.tables).length})}</span><span class="lbl">${tail}</span></span><span class="btn sm" style="margin-left:auto">${more}</span></div>`;
  }
  const rs = ref && ref.comparable ? ref.summary : null;
  const delta = (k, ms) => {
    if (!rs || rs[k] == null || sum[k] == null || !rs[k]) return "";
    const d = Math.round((sum[k] - rs[k]) * 100 / rs[k]);
    if (Math.abs(d) < 3) return `<span class="delta pale">≈ ${t("как у опорного")}</span>`;
    return `<span class="delta ${d < 0 ? "down" : "up"}">${d < 0 ? "↓" : "↑"} ${Math.abs(d)}% · ${t("было {v}", {v: nf(rs[k])})}</span>`;
  };
  const kpi = (label, k, ms) => `<div class="card kpi"><span class="lbl">${t(label)}</span><span class="v">${sum[k] == null ? "—" : nf(sum[k])}${ms ? ` <small>${t("мс")}</small>` : ""}</span><span class="dur">${ms && sum[k] >= 1000 ? dur(sum[k]) : "&nbsp;"}</span>${delta(k, ms)}</div>`;
  const tables = Object.entries(r.tables).map(([n, tb]) => {
    const differs = ref && ref.comparable && ref.diff_tables.includes(+n);
    const diff = ref && ref.comparable ? (differs ? `<span class="chip c-diff">${t("различается с опорным")}</span>` : `<span class="chip c-ok">${t("идентична опорному")}</span>`) : "";
    const tg = differs ? `<span class="btn sm dtg" title="${t("Какие строки отличаются от опорного и чем")}" onclick="event.stopPropagation();toggleDiff(${h(JSON.stringify(v.report))}, ${n})">${I.down(12)}${t("Отличия")}</span>` : "";
    return `<div class="res" onclick="go({k:'table',report:${h(JSON.stringify(v.report))},n:${n}})"><span class="nm">${t("Таблица {n}", {n})}</span><span class="lbl">${nf(tb.rows)} ${tp(tb.rows, "строка", "строки", "строк")} · ${tb.names.length} ${tp(tb.names.length, "колонка", "колонки", "колонок")}${tb.key.length ? " · " + t("ключ: {k}", {k: h(tb.key.filter(x => x !== "#dup").join(", "))}) : ""}</span>${diff}${tg}<span class="go">›</span></div>` +
      (differs ? `<div class="rdiff" id="rd-${n}"><div></div></div>` : "");
  }).join("") || `<div class="empty">${t("Таблиц нет")}</div>`;
  const chips = [r.run["Прогонов"] ? t("повторов {n}", {n: r.run["Прогонов"]}) : "", r.run["Реестр"] ? t("профиль") : "",
    r.run["Планы (--explain)"] ? t("планы: {how}", {how: t(r.run["Планы (--explain)"])}) : "", r.run["Режим"] || ""].filter(Boolean).map(x => `<span class="chip">${h(x)}</span>`).join("");
  m.innerHTML = `
    <header class="head"><div style="display:flex;flex-direction:column;gap:8px">${backLine()}
      <h1>${t("Запуск")} ${tsText(ts)}</h1>
      <span class="noteed" title="${t("Заметка к запуску")}">${I.pen(15)}<span class="txt" data-ph="${t("+ заметка")}" contenteditable="true" onblur="saveNote(${h(JSON.stringify(v.report))}, this.textContent)" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}">${h(r.note || "")}</span></span>
      <div class="row">${chips}</div></div>
      <div class="row">
        <span class="ib big" title="${t("Показать в папке")}" onclick="api('show_in_folder', ${h(JSON.stringify(r.path))})">${I.folder(19)}</span>
        <span class="ib big" title="${t("Удалить в корзину")}" onclick="deleteRun(${h(JSON.stringify(v.report))})">${I.trash(19)}</span>
        ${isRef || r.aborted ? "" : `<a class="btn" onclick="setReference(${h(JSON.stringify(v.report))})">${I.star(17)}${t("Пометить опорным")}</a>`}
        <a class="btn pri" onclick="go({k:'script',name:${h(JSON.stringify(script))}})" title="${t("Открыть скрипт с параметрами запуска")}">${I.play(16)}${t("Перейти к запуску")}</a>
      </div></header>
    ${verdict}
    <section class="kpis">${kpi("Время", "time", true)}${kpi("CPU", "cpu", true)}${kpi("Логических чтений", "reads")}${kpi("Ожидание клиента", "client", true)}${r.slow ? slowBox("r-slow", r.slow, false, sum.time) : ""}</section>
    <section class="card tw${tcolCls("results")}">${tcolBtn("results")}<div class="tbar"><h2>${t("Таблицы результата")}</h2></div>${tables}</section>
    ${r.journal && r.journal.length ? journalCard(r.journal) : ""}
    ${r.aborted ? "" : lineCard(r)}
    ${r.registry ? tableCard("reg", t("Реестр операторов"), (r.run["Прогонов"] > 1 ? t("медиана прогонов 2–{n}", {n: r.run["Прогонов"]}) : "") + " · registry.csv", REG_COLS, r.registry, r.registry_dir + "\\registry.csv", r.registry_dir, "reg", "", 0, waitBarHtml(regWaitItems(r.registry))) : ""}
    ${r.log ? tableCard("log", t("Журнал выполнения"), "log.csv", LOG_COLS, linkLog(r.log, r.registry || []), r.registry_dir + "\\log.csv", r.registry_dir, "log", "", LOG_COLLAPSE) : ""}
    ${(r.extra_tables || []).map(x => extraCard(x, r.registry_dir)).join("")}`;
  const lb = m.querySelector(".logbox");       // журнал - на последних строках
  if (lb) lb.scrollTop = lb.scrollHeight;
  if (r.line && r.line.length >= 2) drawLine(r.line, v.report);
}
// журнал хода запуска из файла <запуск>_message.txt: как журнал идущего запуска
function journalCard(rows) {
  const line = e => e.tag ? `<div class="logl msg${e.tag === "Ошибка" ? " err" : ""}"><span>${h(e.time)}</span><span><b class="tagm">${e.tag === "Ошибка" ? t("ошибка") : "SQL"}</b>${h(e.text)}</span></div>`
    : `<div class="logl"><span>${h(e.time)}</span><span>${h(e.text)}</span></div>`;
  const msgs = rows.filter(e => e.tag).length;
  return `<section class="card tw${tcolCls("journal")}">${tcolBtn("journal")}<div class="tbar"><h2>${t("Журнал")}</h2><span class="lbl">${t("ход выполнения и сообщения SQL (PRINT, RAISERROR, ошибки) · время сервера")} · ${t("сообщений SQL: {n}", {n: nf(msgs)})}</span></div>
    <div class="logbox">${rows.map(line).join("")}</div></section>`;
}
// Отличия таблицы от опорного (§5.19): плашка раскрывается под строкой таблицы, данные - при первом
// раскрытии (сравнение как в режиме 2, только чтение CSV): итог таблицы и примеры строк
async function toggleDiff(report, n) {
  const box = $("#rd-" + n), open = !box.classList.contains("open");
  box.classList.toggle("open", open);
  box.previousElementSibling.classList.toggle("dopen", open);
  if (!open || box._loaded) return;
  box._loaded = true;
  const inner = box.firstElementChild;
  inner.innerHTML = `<div class="empty"><span class="pulse"></span> ${t("Сравнение строк с опорным…")}</div>`;
  let d;
  try { d = await api("table_diff", report, n); } catch (e) { inner.innerHTML = `<div class="empty">${h(e.message || e)}</div>`; box._loaded = false; return; }
  if (!box.isConnected) return;
  inner.innerHTML = diffHtml(d);
  hbar(inner.querySelector(".tscroll"));
}
const DIFF_STACK = 20;        // отличия длиннее - старое над новым (diffHtml)
function diffHtml(d, na = "опорный", nb = "этот") {     // na, nb - как назвать A и B
  const low = d.names.map(x => x.toLowerCase());
  const key = d.key.map(x => low.indexOf(x.toLowerCase())).filter(i => i >= 0);
  const changed = new Set(d.examples.flatMap(e => e.cols || []));
  // колонки: ключ и отличающиеся; если отличий в сопоставленных строках нет - все колонки
  const cols = changed.size ? key.concat(d.names.map((_, j) => j).filter(j => changed.has(j) && !key.includes(j))) : d.names.map((_, j) => j);
  const val = x => x === null ? '<span class="pale">NULL</span>' : h(x);
  const kinds = {diff: t("изменена"), A: na === "опорный" ? t("только в опорном") : t("только в {x}", {x: na}), B: nb === "этот" ? t("только в этом") : t("только в {x}", {x: nb})};
  // отличающаяся колонка с длинными значениями (длиннее DIFF_STACK символов среди показанных) - старое и
  // новое двумя строками моноширинным шрифтом, буква под буквой: так видна замена одной буквы
  const vals = j => d.examples.flatMap(e => e.kind === "diff" ? [e.a[j], e.b[j]] : [e.row[j]]);
  const stack = new Set([...changed].filter(j => Math.max(0, ...vals(j).map(x => x === null ? 4 : String(x).length)) > DIFF_STACK));
  const rows = d.examples.map(e => {
    const row = e.kind === "diff" ? e.b : e.row;
    return `<tr class="k-${e.kind}"><td><span class="dk">${kinds[e.kind]}</span></td>` + cols.map(j =>
      e.kind === "diff" && e.cols.includes(j) ? (stack.has(j) ? `<td class="dd2"><span class="old">${val(e.a[j])}</span><span class="new">${val(e.b[j])}</span></td>`
        : `<td><span class="old">${val(e.a[j])}</span> → <span class="new">${val(e.b[j])}</span></td>`)
        : `<td class="${key.includes(j) ? "b" : ""}${stack.has(j) ? " dd1" : ""}">${val(row[j])}</td>`).join("") + "</tr>";
  }).join("");
  const full = ["diff", "A", "B"].some(k => d.examples.filter(e => e.kind === k).length >= d.limit);
  return `<div class="dsum">${d.lines.map(x => `<span>${h(x)}</span>`).join("")}${na === "опорный" ? `<span class="pale">${t("A — опорный запуск, B — этот")}</span>` : ""}</div>` +
    (rows ? `<div class="tscroll"><table class="t compact"><thead><tr><th></th>${cols.map(j => `<th>${h(d.names[j])}${changed.has(j) ? ` <span class="pale">${h(na === "опорный" ? t("опорный") : na)} ${stack.has(j) ? "/" : "→"} ${h(nb === "этот" ? t("этот") : nb)}</span>` : ""}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="empty">${t("Примеров строк нет")}: ${d.differs ? t("строки не сравнивались, отличия - в строках выше") : t("строки совпадают")}</div>`) +
    (full ? `<div class="dmore">${t("Показаны первые {n} строк каждого вида", {n: d.limit})}. ${na === "опорный" ? t("Все отличия — в сравнении («Подробнее» вверху)") : t("Все отличия — в CSV («Сравнить CSV») и в полном отчете")}</div>` : "");
}
// График линейки (§5.14): время запусков, связанных сравнениями, по порядку запуска. Одна линия
// акцентным цветом, точки 8 px, тихая сетка; текущий запуск - вертикальная черта и крупная точка,
// опорный - ★ над точкой. Наведение - подсказка, клик - открыть запуск.
function lineCard(r) {
  if (!r.line || r.line.length < 2) return "";       // график нельзя построить - плашки нет
  return `<section class="card"><div style="padding:14px 20px 0;display:flex;gap:12px;align-items:baseline"><h2>${t("Время по линейке")}</h2><span class="lbl">${r.line.length} ${tp(r.line.length, "запуск", "запуска", "запусков")}, ${t("связанных сравнениями")} · ${t("мс")}</span></div><div class="lchart" id="lchart"></div></section>`;
}
function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
function drawLine(line, cur) {
  const box = $("#lchart");
  if (!box) return;
  const W = box.clientWidth - 40, H = 200, L = 64, R = 44, T = 22, B = 28;   // R: место под подпись крайней точки
  const times = line.map(x => x.time).filter(v => v != null), step = niceStep(Math.max(...times, 1) / 4);
  const top = Math.ceil(Math.max(...times, 1) / step) * step, n = line.length;
  const X = i => L + (n === 1 ? 0 : i * (W - L - R) / (n - 1)), Y = v => T + (H - T - B) * (1 - v / top);
  const ref = S.st.reference, refRun = line.find(x => x.report === ref);
  let svg = "";
  for (let v = 0; v <= top + 1e-9; v += step)
    svg += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#EEF1F6"/><text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="#6E788B">${nf(v)}</text>`;
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((W - L) / 96))));
  line.forEach((x, i) => { if (i % every === 0 || x.report === cur) svg += `<text x="${X(i)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="${x.report === cur ? "#1B2230" : "#6E788B"}"${x.report === cur ? ' font-weight="600"' : ""}>${tsText(x.ts)}</text>`; });
  const ci = line.findIndex(x => x.report === cur);
  if (ci >= 0) svg += `<line x1="${X(ci)}" x2="${X(ci)}" y1="${T - 6}" y2="${H - B}" stroke="#3B5BDB" stroke-opacity=".35" stroke-width="1.5"/>`;
  const pts = line.map((x, i) => x.time == null ? null : [X(i), Y(x.time)]);
  svg += `<path d="${pts.filter(Boolean).map((p, i) => (i ? "L" : "M") + p[0] + " " + p[1]).join(" ")}" fill="none" stroke="#3B5BDB" stroke-width="2" stroke-linejoin="round"/>`;
  line.forEach((x, i) => {
    if (!pts[i]) return;
    const big = x.report === cur;
    svg += `<circle class="pt" data-i="${i}" cx="${pts[i][0]}" cy="${pts[i][1]}" r="${big ? 6 : 4}" fill="${big ? "#3B5BDB" : "#FFF"}" stroke="#3B5BDB" stroke-width="2"/>`;
    if (x.report === ref) svg += `<text x="${pts[i][0]}" y="${pts[i][1] - 11}" text-anchor="middle" font-size="13" fill="#E8A21A">★</text>`;
    svg += `<circle class="pt" data-i="${i}" cx="${pts[i][0]}" cy="${pts[i][1]}" r="12" fill="transparent"/>`;     // зона наведения больше точки
  });
  box.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="${t("Время запусков линейки")}">${svg}</svg><div class="ltip" style="display:none"></div>`;
  const tip = box.querySelector(".ltip");
  box.querySelectorAll(".pt").forEach(c => {
    const x = line[+c.dataset.i];
    c.addEventListener("mouseenter", () => {
      const d = refRun && refRun.time && x.report !== ref ? Math.round((x.time - refRun.time) * 100 / refRun.time) : null;
      tip.innerHTML = `<b>${h(x.stem)}.sql</b> · ${tsText(x.ts, true)}<br>${nf(x.time)} ${t("мс")} ${dur(x.time)}${d !== null ? " · " + t("{d} к опорному", {d: `${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d)}%`}) : x.report === ref ? " · " + t("опорный") : ""}${x.note ? "<br>" + h(x.note) : ""}`;
      tip.style.left = 20 + +c.getAttribute("cx") + "px";
      tip.style.top = 4 + +c.getAttribute("cy") + "px";
      tip.style.display = "";
    });
    c.addEventListener("mouseleave", () => { tip.style.display = "none"; });
    c.addEventListener("click", () => { if (x.report !== cur) go({k: "result", report: x.report}); });
  });
}
// заметка к запуску или наблюдению (§5.16): раздел "GUI" json, notes - {имя отчета или папки наблюдения: текст}
async function saveNote(key, text) {
  try { await api("set_note", key, text.trim()); refresh(); } catch (e) { fail(e); }
}
function deleteRun(report) {
  modal(`<div class="dlg" style="width:420px"><div class="dh"><h2>${t("Удалить запуск?")}</h2><span class="note">${t("Отчет {name}, его CSV, папка реестра и файлы сравнения будут перемещены в корзину Windows.", {name: h(report)})}</span></div>
    <div class="df"><a class="btn" onclick="closeModal()">${t("Отмена")}</a><a class="btn dark" onclick="doDelete(${h(JSON.stringify(report))})">${t("В корзину")}</a></div></div>`);
}
async function doDelete(report) {
  try {
    await api("delete_run", report);
    closeModal();
    const open = S.view.report === report || (S.view.k === "compare" && (S.view.a === report || S.view.b === report));
    if (open) { S.view = {k: "empty"}; S.history = []; }
    await refresh();
    if (open) renderMain();
    toast(t("Перемещено в корзину"));
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- таблицы реестра и журнала (§5.2)
const REG_COLS = [
  {k: "№", t: "№", kind: "num"}, {k: "op", t: "Оператор", kind: "op"},
  {k: "Время мс", t: "Время\nмс", kind: "ms"}, {k: "Время %", t: "Время\n%", kind: "num"}, {k: "CPU мс", t: "CPU\nмс", kind: "ms"},
  {k: "Ожидание блокировок мс", t: "Ожидание\nблокировок мс", kind: "ms", hot: true},
  {k: "Блокировал сам мс", t: "Блокировал\nсам мс", kind: "ms"},
  {k: "Ожидание ресурсов мс", t: "Ожидание\nресурсов мс", kind: "ms"},
  {k: "Ожидание ресурсов 1 место", t: "Ожидание ресурсов\n1 место", kind: "wait"}, {k: "Ожидание ресурсов 2 место", t: "Ожидание ресурсов\n2 место", kind: "wait"},
  {k: "Ожидание ресурсов 3 место", t: "Ожидание ресурсов\n3 место", kind: "wait"},
  {k: "Выделено памяти МБ", t: "Выделено\nпамяти МБ", kind: "num"}, {k: "Ожидание клиента мс", t: "Ожидание\nклиента мс", kind: "ms"},
  {k: "Логических чтений", t: "Логических\nчтений", kind: "num"}, {k: "Физических чтений", t: "Физических\nчтений", kind: "num"},
  {k: "Выборок", t: "Выборок", kind: "num"},   // «Текст» и «План» - кнопками в начале строки (fileActs)
];
const LOG_COLS = [{k: "Время сервера", t: "Время сервера", kind: "mono"}].concat(REG_COLS.filter(c => !["№", "Время %", "Текст", "План"].includes(c.k)));
function cellVal(row, c) {
  if (c.k === "op") return (row["Объект"] || "") + (row["Строка"] && row["Строка"] !== "0" ? ":" + row["Строка"] : "");
  return row[c.k] ?? "";
}
function cellHtml(row, c, dir) {
  const v = cellVal(row, c);
  // оператор и число его запусков (реестр) - одна колонка: начало текста идет под обоими
  if (c.kind === "op") {
    const n = row["Запусков"], runs = n ? `<span class="runs${+n > 1 ? " many" : ""}" title="${t("Запусков: возвратов к оператору после других операторов (цикл, повторный вызов) и новых запросов с ним; не меньше")}">×${nf(n)}</span>` : "";
    return `<td class="op b" data-op="${h(v)}" title="${h(row["Начало текста"] || "")}"><span class="opl"><span>${h(v)}</span>${runs}</span><span class="sv">${h(row["Начало текста"] || "")}</span></td>`;
  }
  if (c.kind === "ms") {
    const n = +v, hot = c.hot && n > 0;
    return `<td class="n"${hot ? ' style="color:#9A4A07;font-weight:600"' : ""}>${v === "" ? "" : nf(v)}${n >= 1000 ? `<span class="sv">${dur(n)}</span>` : ""}</td>`;
  }
  if (c.kind === "num") return `<td class="n">${nf(v)}</td>`;
  if (c.kind === "mono") return `<td class="mono">${h(v.slice(11) || v)}</td>`;
  if (c.kind === "wait") {
    const m = /^(.*) \((\d+) мс\)$/.exec(v);
    return m ? `<td>${waitHtml(m[1])}<span class="sv wi">${nf(m[2])} ${t("мс")}</span></td>` : `<td class="pale">${v ? h(v) : "—"}</td>`;
  }
  if (c.kind === "file") return v ? `<td><a onclick="api('open_path', ${h(JSON.stringify(dir + "\\" + v))}).catch(fail)">${c.k === "Текст" ? "SQL" : t("План")}</a></td>` : "<td></td>";
  return `<td>${h(v)}</td>`;
}
// Горизонтальная прокрутка широкой таблицы (§5.2): своя полоса под таблицей прилипает к низу окна,
// пока видна хоть часть таблицы, а когда низ таблицы на экране - стоит на своем месте под ней.
// Высота таблицы не ограничивается, вертикальная прокрутка одна - у окна. Родная полоса .tscroll
// скрыта (Shift+колесо и тачпад прокручивают таблицу как раньше).
function hbar(ts) {
  if (!ts) return;
  if (!ts._bar) {
    const bar = document.createElement("div");
    bar.className = "hbar";
    bar.innerHTML = "<div></div>";
    ts.after(bar);
    ts._bar = bar;
    bar.addEventListener("scroll", () => { if (ts.scrollLeft !== bar.scrollLeft) ts.scrollLeft = bar.scrollLeft; });
    ts.addEventListener("scroll", () => { if (bar.scrollLeft !== ts.scrollLeft) bar.scrollLeft = ts.scrollLeft; });
    ts._ro = new ResizeObserver(() => hbar(ts));
    ts._ro.observe(ts);
  }
  const t = ts.firstElementChild;
  if (t && ts._seen !== t) { ts._seen = t; ts._ro.observe(t); }    // ширина содержимого (новая таблица после сортировки)
  const bar = ts._bar, wide = ts.scrollWidth > ts.clientWidth + 1;
  bar.style.display = wide ? "" : "none";
  bar.firstChild.style.width = ts.scrollWidth + "px";
  if (wide) bar.scrollLeft = ts.scrollLeft;
}
function sortRows(id, cols, rows) {
  const s = S.sort[id];
  if (!s) return rows;
  const c = cols.find(x => x.k === s.col) || {k: s.col, kind: "num"};      // "Запусков" - внутри колонки оператора
  const num = c && ["ms", "num"].includes(c.kind);
  return [...rows].sort((a, b) => {
    let x = cellVal(a, c), y = cellVal(b, c);
    if (num) { x = +x || 0; y = +y || 0; return (x - y) * s.dir; }
    return String(x).localeCompare(String(y), "ru") * s.dir;
  });
}
function sortBy(id, col) {
  const s = S.sort[id];
  S.sort[id] = !s || s.col !== col ? {col, dir: 1} : s.dir === 1 ? {col, dir: -1} : undefined;
  const el = document.getElementById("tw-" + id);
  if (el && el._render) el._render();
}

// Порядок и видимость колонок (§5.2) - по видам таблиц: "reg" (реестр), "log" (журнал), "csv:<скрипт>:<N>"
// (содержимое CSV). Хранятся в "GUI" json (columns: {вид: {order, hidden}}); ширину задает содержимое.
// Колонка перетаскивается за заголовок, скрывается в окне "Колонки".
function colPrefs(kind) { return Object.assign({order: [], hidden: []}, (S.st.columns || {})[kind]); }
function arrangeCols(kind, keys, all) {     // ключи колонок в порядке показа; all - со скрытыми
  const p = colPrefs(kind), pos = k => { const i = p.order.indexOf(k); return i < 0 ? 1e6 + keys.indexOf(k) : i; };
  const out = [...keys].sort((a, b) => pos(a) - pos(b));
  return all ? out : out.filter(k => !p.hidden.includes(k));
}
function saveColPrefs(kind, p) {
  S.st.columns = Object.assign({}, S.st.columns, {[kind]: p});
  api("set_gui", "columns", S.st.columns).catch(fail);
}
let colDragKey = null;
function colDrag(e, key) { colDragKey = key; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", key); }
function colDrop(e, kind, keys, to, rerender) {     // колонка colDragKey встает перед колонкой to
  e.preventDefault();
  const from = colDragKey;
  colDragKey = null;
  if (from === null || from === to) return;
  const p = colPrefs(kind), order = arrangeCols(kind, keys, true).filter(k => k !== from);
  order.splice(order.indexOf(to), 0, from);
  saveColPrefs(kind, Object.assign(p, {order}));
  rerender();
}
const thDrag = (kind, keysRef, key, rerender) =>
  `draggable="true" ondragstart="colDrag(event, ${h(JSON.stringify(key))})" ondragover="event.preventDefault()" ondrop="colDrop(event, ${h(JSON.stringify(kind))}, ${keysRef}, ${h(JSON.stringify(key))}, ${rerender})"`;
function colsDialog(kind, keys, titles, rerender) {   // окно "Колонки": показать или скрыть
  window._cols = {kind, keys, rerender};
  const p = colPrefs(kind);
  modal(`<div class="dlg" style="width:420px"><div class="dh"><h2>${t("Колонки")}</h2><span class="note">${t("Порядок меняется перетаскиванием заголовка. Запоминается для таблиц этого вида.")}</span></div>
    <div class="db" style="gap:2px;max-height:56vh;overflow:auto">${arrangeCols(kind, keys, true).map(k =>
      `<span class="popt" style="padding:5px 0" onclick="this.firstChild.classList.toggle('on')"><span class="sw${p.hidden.includes(k) ? "" : " on"}" data-k="${h(k)}"></span>${h(titles[k] || k)}</span>`).join("")}</div>
    <div class="df"><a class="btn" onclick="saveColPrefs(_cols.kind, {order: [], hidden: []});closeModal();_cols.rerender()">${t("Как в файле")}</a>
      <a class="btn" onclick="closeModal()">${t("Отмена")}</a><a class="btn pri" onclick="colsApply()">${t("Применить")}</a></div></div>`);
}
function colsApply() {
  const c = window._cols, hidden = [...document.querySelectorAll("#modal .sw[data-k]")].filter(x => !x.classList.contains("on")).map(x => x.dataset.k);
  if (hidden.length === c.keys.length) { toast(t("Нужна хотя бы одна колонка"), true); return; }
  saveColPrefs(c.kind, Object.assign(colPrefs(c.kind), {hidden}));
  closeModal();
  c.rerender();
}

// Сворачивание таблиц (§5.2): значок справа в заголовке карточки (.tw.tc), всегда у правого края;
// состояние - по виду таблицы ("GUI".tcollapsed: {вид: true/false}), поэтому переживает перерисовку
// экрана и одинаково у всех запусков и наблюдений. dflt - свернута, пока пользователь не решил сам.
function tcolOn(key, dflt) { const c = S.st.tcollapsed || {}; return key in c ? !!c[key] : !!dflt; }
const tcolCls = (key, dflt) => " tc" + (tcolOn(key, dflt) ? " tcl" : "");
const tcolBtn = key => `<span class="tcol" title="${t("Свернуть или развернуть")}" onclick="tcolToggle(this, ${h(JSON.stringify(key))})">${I.down(15)}</span>`;
function tcolToggle(b, key) {
  const card = b.closest(".tw"), on = !card.classList.contains("tcl"), upd = {[key]: on};
  // разделы «Нагрузки сервера» и «Базы данных»: открыт один, остальные сворачиваются
  if (!on && card.classList.contains("sec"))
    for (const c of document.querySelectorAll("section.sec:not(.tcl)")) { c.classList.add("tcl"); upd[c.id] = true; }
  S.st.tcollapsed = Object.assign({}, S.st.tcollapsed, upd);
  api("set_gui", "tcollapsed", S.st.tcollapsed).catch(fail);
  if (on) { card.classList.add("tcl"); return; }
  // строки строятся при разворачивании: на это время вместо стрелки - значок ожидания (длинная таблица)
  card.classList.add("tbusy");
  requestAnimationFrame(() => setTimeout(() => {
    card.classList.remove("tcl", "tbusy");
    if (card._render) card._render();
    card.querySelectorAll(".tscroll").forEach(hbar);
    const lb = card.querySelector(".logbox");       // журнал - на последних строках
    if (lb) lb.scrollTop = lb.scrollHeight;
  }));
}
// свернутая карточка разворачивается кликом по любому ее месту, кроме кнопок
document.addEventListener("click", e => {
  const card = e.target.closest && e.target.closest(".tw.tcl");
  if (card && !e.target.closest("a, .ib, .btn, .tcol, input, [onclick]")) card.querySelector(".tcol").click();
});
// кнопка «Колонки» таблицы вида kind; ref - выражение JS с объектом {keys, titles, render}
const colsBtn = (kind, ref) => `<span class="ib" title="${t("Колонки: показать или скрыть")}" onclick="colsDialog(${h(JSON.stringify(kind))}, ${ref}.keys, ${ref}.titles, ${ref}.render)">${I.cols(15)}</span>`;

// collapseOver - свернута по умолчанию, если строк больше (журнал: не грузить страницу); строки свернутой
// таблицы строятся при разворачивании. У строк реестра с файлами текста и плана - кнопки в начале строки
function tableCard(id, title, note, allCols, rows, file, dir, kind, extra, collapseOver, top) {     // top - HTML над таблицей
  setTimeout(() => {
    const el = document.getElementById("tw-" + id);
    if (!el) return;
    el._keys = allCols.map(c => c.k);
    el._render = () => {
      if (el.classList.contains("tcl")) return;
      // числовая колонка, пустая во всех строках, - счетчика у СУБД нет (PostgreSQL: память, чтения без pg_stat_statements)
      const none = c => ["ms", "num"].includes(c.kind) && rows.length && rows.every(r => (r[c.k] ?? "") === "");
      const s = S.sort[id], cols = arrangeCols(kind, el._keys).map(k => allCols.find(c => c.k === k)).filter(c => !none(c));
      el._cols = cols;
      const acts = rows.some(r => r["Текст"] || r["План"]), runs = rows.some(r => r["Запусков"]);
      const keysRef = `document.getElementById('tw-${id}')._keys`, rr = `document.getElementById('tw-${id}')._render`;
      el.querySelector(".tscroll").innerHTML = rows.length ? `<table class="t"><thead><tr>${acts ? "<th></th>" : ""}${cols.map(c =>
        `<th class="${["ms", "num"].includes(c.kind) ? "n" : ""}${c.kind === "op" ? " op" : ""}" ${thDrag(kind, keysRef, c.k, rr)} onclick="sortBy('${id}', ${h(JSON.stringify(c.k))})">${c.kind === "op" && runs ? `<span class="opl"><span>${h(t(c.t))}${s && s.col === c.k ? `<span class="s">${s.dir > 0 ? "▲" : "▼"}</span>` : ""}</span><span class="runs" title="${t("Сортировать по числу запусков")}" onclick="event.stopPropagation();sortBy('${id}', 'Запусков')">${t("запусков")}${s && s.col === "Запусков" ? `<span class="s">${s.dir > 0 ? "▲" : "▼"}</span>` : ""}</span></span>` : h(t(c.t)).replace("\n", "<br>") + (s && s.col === c.k ? `<span class="s">${s.dir > 0 ? "▲" : "▼"}</span>` : "")}</th>`).join("")}</tr></thead>
        <tbody>${sortRows(id, cols, rows).slice(0, el._show || TABLE_SHOW).map(r => "<tr>" + (acts ? fileActs(r, dir) : "") + cols.map(c => cellHtml(r, c, dir)).join("") + "</tr>").join("")}</tbody></table>` : `<div class="empty">${t("Строк нет")}</div>`;
      hbar(el.querySelector(".tscroll"));
      // длинная таблица - первые TABLE_SHOW строк и «показать еще» (раскладка 3600 строк ~1 с); сортировка и копирование - по всем
      const lim = el._show || TABLE_SHOW;
      el.querySelector(".tmore").innerHTML = rows.length > lim
        ? tableMore(lim, rows.length, `const e=document.getElementById('tw-${id}');e._show=${lim + TABLE_SHOW};e._render()`).replace(/^<div class="tmore stick">|<\/div>$/g, "") : "";
    };
    el._rows = rows;
    el._render();
  });
  const titles = h(JSON.stringify(Object.fromEntries(allCols.map(c => [c.k, t(c.t).replace("\n", " ")]))));
  return `<section class="card tw${tcolCls(kind, collapseOver && rows.length > collapseOver)}" id="tw-${id}">${tcolBtn(kind)}<div class="tbar"><h2>${h(title)}</h2><span class="lbl">${h(note)}${rows.length > 20 ? " · " + nf(rows.length) + " " + tp(rows.length, "строка", "строки", "строк") : ""}</span>${extra || ""}</div>
    <div class="acts"><span class="ib" title="${t("Скопировать для Excel")}" onclick="copyTsv('${id}')">${I.copy(15)}</span>
      <span class="ib" title="${t("Показать в папке")}" onclick="api('show_in_folder', ${h(JSON.stringify(file))})">${I.folder(15)}</span>
      <span class="ib" title="${t("Открыть CSV")}" onclick="api('open_path', ${h(JSON.stringify(file))}).catch(fail)">${I.open(15)}</span>
      <span class="ib" title="${t("Колонки: показать или скрыть")}" onclick="colsDialog(${h(JSON.stringify(kind))}, document.getElementById('tw-${id}')._keys, ${titles}, document.getElementById('tw-${id}')._render)">${I.cols(15)}</span></div>
    ${top || ""}<div class="tscroll"></div><div class="tmore"></div></section>`;
}
// Остальные таблицы папки реестра (PostgreSQL): операторы внутри функций (--explain), функции и таблицы
// (--profile). Колонки - из заголовка файла: числовые - по значениям; «План» - кнопкой в начале строки.
const EXTRA_TITLES = {"nested.csv": "Операторы внутри функций", "functions.csv": "Функции", "tables.csv": "Таблицы"};
function extraCard(x, dir) {
  const isNum = k => k !== "Хэш" && x.rows.some(r => r[k] !== "") && x.rows.every(r => r[k] === "" || /^-?\d+(\.\d+)?$/.test(r[k]));
  const cols = x.header.filter(k => k !== "План").map(k => ({k, t: k, kind: isNum(k) ? "num" : ""}));
  const id = "x" + x.name.replace(/\W/g, "");
  return tableCard(id, t(EXTRA_TITLES[x.name] || x.name), x.name, cols, x.rows, x.file, dir, id, "", LOG_COLLAPSE);
}
const TABLE_SHOW = 500;          // строк любой таблицы до кнопки «показать еще» (tableCard, srvTable, CSV)
const LOG_COLLAPSE = 100;        // журнал длиннее - свернут по умолчанию
function fileActs(r, dir) {        // кнопки строки реестра: текст оператора (.sql) и план (.sqlplan)
  const b = (f, title, icon) => f ? `<span class="ib" title="${t(title)}" onclick="api('open_path', ${h(JSON.stringify(dir + "\\" + f))}).catch(fail)">${icon}</span>` : "";
  // текст - в окне приложения с начала (внешняя программа открывала файл прокрученным в конец)
  const txt = r["Текст"] ? textActs(dir + "\\" + r["Текст"], t("Текст оператора")) : "";
  return `<td class="acts2">${txt}${b(r["План"], "План", I.plan(14))}</td>`;
}
// кнопка текста оператора из файла реестра; «Показать в папке» - только в контекстном меню строки
function textActs(path, title) {
  return `<span class="ib" title="${h(title)}" onclick="fileText(${h(JSON.stringify(path))})">${I.note(14)}</span>` +
    `<span class="ib ctxonly" title="${t("Показать в папке")}" onclick="api('show_in_folder', ${h(JSON.stringify(path))})">${I.folder(14)}</span>`;
}
// Строки журнала получают файлы текста и плана своего оператора из реестра (в журнале их нет:
// номера файлов меняются); связь - объект, строка и начало текста
function linkLog(log, reg) {
  const key = r => [r["Объект"], r["Строка"], r["Начало текста"]].join("\u0000");
  const m = new Map(reg.map(r => [key(r), r]));
  for (const r of log) { const x = m.get(key(r)); if (x) { r["Текст"] = x["Текст"]; r["План"] = x["План"]; } }
  return log;
}
async function fileText(path) {
  try {
    const d = await api("read_text", path);
    textDialog(baseName(path), d.text, baseName(path).replace(/\.sql$/i, ""), {path, plan: d.plan});
    const box = $("#modal pre");
    if (box) box.scrollTop = 0;
  } catch (e) { fail(e); }
}
function copyText(text) {
  return navigator.clipboard.writeText(text).then(() => toast(t("Скопировано: вставляется в Excel по колонкам")), fail);
}
function copyTsv(id) {            // копирование для Excel: видимые колонки через табуляцию (§5.2)
  const el = document.getElementById("tw-" + id);
  const cols = el._cols, rows = sortRows(id, cols, el._rows);
  const runs = rows.some(r => r["Запусков"]);
  const head = cols.flatMap(c => c.kind === "op" ? [t("Оператор")].concat(runs ? [t("Запусков")] : [], [t("Начало текста")]) : [t(c.t).replace("\n", " ")]);
  const lines = [head.join("\t")].concat(rows.map(r => cols.flatMap(c => c.kind === "op" ? [cellVal(r, c)].concat(runs ? [r["Запусков"] || ""] : [], [r["Начало текста"] || ""]) : [cellVal(r, c)]).join("\t")));
  copyText(lines.join("\r\n"));
}

// ---------------------------------------------------------------- содержимое таблицы (CSV)
const reportStem = r => r.replace(/_\d{8}_\d{6}(_\d+)?\.txt$/, "");
async function viewTable(m, v) {
  const ts = (v.report.match(/_(\d{8}_\d{6})/) || [])[1], ref = S.st.reference;
  m.innerHTML = `
    <header class="head"><div style="display:flex;flex-direction:column;gap:10px">${backLine()}<h1>${t("Таблица {n}", {n: v.n})}</h1><div class="row" id="t-chips"></div></div>
      <div class="row">${ref && ref !== v.report ? diffButton(t("Сравнить с опорным"), "table", [ref, v.report, v.n]) : ""}
      <a class="btn" onclick="go({k:'result',report:${h(JSON.stringify(v.report))}})" title="${t("Итог запуска, из которого эта таблица")}">${I.back(16)}${t("К запуску {when}", {when: h(tsText(ts))})}</a></div></header>
    <section class="card tw show" style="flex:1 0 auto;min-height:300px">
      <div class="tbar"><span class="fl">${I.search(15)}<input id="t-flt" placeholder="${t("Фильтр строк (Ctrl+F)")}" value="${h(v.filter || "")}">${FLX}</span><span class="lbl" id="t-cnt"></span><span class="pale" style="font-size:12px" id="t-file"></span></div>
      <div class="acts"><span class="ib" title="${t("Скопировать для Excel")}" onclick="copyCsvTsv()">${I.copy(15)}</span>
        <span class="ib" title="${t("Показать в папке")}" onclick="api('show_in_folder', S.live.tfile)">${I.folder(15)}</span>
        <span class="ib" title="${t("Открыть CSV")}" onclick="api('open_path', S.live.tfile).catch(fail)">${I.open(15)}</span>
        <span class="ib" title="${t("Колонки: показать или скрыть")}" onclick="csvCols()">${I.cols(15)}</span></div>
      <div class="tscroll" id="t-body"><div class="empty">${t("Чтение…")}</div></div>
      <div id="t-more"></div>
    </section>`;
  const inp = $("#t-flt");
  let timer;
  inp.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { v.filter = inp.value; loadCsv(v); }, 300); });
  inp.addEventListener("keydown", e => { if (e.key === "Escape") { inp.value = ""; v.filter = ""; loadCsv(v); e.stopPropagation(); } });
  loadCsv(v);
  hydrateDiffButtons();
}
async function loadCsv(v, more) {      // more - дочитать следующие строки (кнопка "Показать еще")
  const have = more ? S.live.tdata.rows.length : 0;
  let d;
  try { d = await api("read_table", v.report, v.n, v.filter || "", have); } catch (e) { $("#t-body").innerHTML = `<div class="empty">${h(e.message || e)}</div>`; return; }
  if (S.view !== v) return;
  if (more) d.rows = S.live.tdata.rows.concat(d.rows);
  S.live.tfile = d.file; S.live.tdata = d; S.live.tkind = `csv:${reportStem(v.report)}:${v.n}`;
  $("#t-file").textContent = baseName(d.file);
  $("#t-chips").innerHTML = `<span class="chip">${nf(d.total)} ${tp(d.total, "строка", "строки", "строк")} · ${d.columns.length} ${tp(d.columns.length, "колонка", "колонки", "колонок")}</span>${d.key.length ? `<span class="chip">${t("ключ: {k}", {k: h(d.key.filter(x => x !== "#dup").join(", "))})}</span>` : ""}${d.ignored.length ? `<span class="chip">${t("игнорируются: {list}", {list: h(d.ignored.join(", "))})}</span>` : ""}`;
  $("#t-cnt").textContent = v.filter ? t("найдено {n} из {of}", {n: nf(d.matched), of: nf(d.total)}) : "";
  renderCsv();
}
function renderCsv() {
  const d = S.live.tdata, v = S.view, kind = S.live.tkind;
  if (!d || !$("#t-body")) return;
  const f = (v.filter || "").toLowerCase();
  const mark = s => {
    if (s === null) return '<span class="pale">NULL</span>';
    if (!f) return h(s);
    const i = s.toLowerCase().indexOf(f);
    return i < 0 ? h(s) : h(s.slice(0, i)) + "<mark>" + h(s.slice(i, i + f.length)) + "</mark>" + h(s.slice(i + f.length));
  };
  const keyCols = new Set(d.key), idx = arrangeCols(kind, d.columns).map(c => d.columns.indexOf(c));
  $("#t-body").innerHTML = `<table class="t"><thead><tr>${idx.map(i => `<th ${thDrag(kind, "S.live.tdata.columns", d.columns[i], "renderCsv")}>${h(d.columns[i])}</th>`).join("")}</tr></thead><tbody>${d.rows.map(r =>
    "<tr>" + idx.map(i => `<td${keyCols.has(d.columns[i]) ? ' class="b"' : ""}>${mark(r[i])}</td>`).join("") + "</tr>").join("")}</tbody></table>`;
  const left = d.matched - d.rows.length;
  $("#t-more").innerHTML = left > 0 ? `<div class="empty">${t("Показаны первые {n} строк из {of}", {n: nf(d.rows.length), of: nf(d.matched)})} · <a onclick="loadCsv(S.view, true)">${t("показать еще {n}", {n: nf(Math.min(left, TABLE_SHOW))})}</a></div>` : "";
  hbar($("#t-body"));
}
function csvCols() {
  const d = S.live.tdata;
  if (d) colsDialog(S.live.tkind, d.columns, {}, renderCsv);
}
function copyCsvTsv() {
  const d = S.live.tdata;
  if (!d) return;
  const idx = arrangeCols(S.live.tkind, d.columns).map(c => d.columns.indexOf(c));
  copyText([idx.map(i => d.columns[i]).join("\t")].concat(d.rows.map(r => idx.map(i => r[i] ?? "").join("\t"))).join("\r\n"));
}

// ---------------------------------------------------------------- внешний diff (§5.5)
// Кнопка: подсказка - какие файлы и какой программой откроются (или где указать программу).
// kind/args - как у _diff_files в CompareQueryGUI.py: reports, scripts, table, script
function diffButton(label, kind, args, sm) {
  return `<a class="btn${sm ? " sm" : ""}" data-diff="${h(JSON.stringify([kind, args]))}" onclick="runDiff(this)">${I.diff(sm ? 15 : 17)}${label}</a>`;
}
// только отличающиеся строки таблицы: два CSV, папка с ними и поверх - программа сравнения (diff_rows)
async function diffRows(a, b, n, btn) {
  btn.setAttribute("disabled", "");
  try {
    const r = await api("diff_rows", a, b, n);
    toast(r.tool ? t("Отличающихся строк: в A {a}, в B {b}", {a: nf(r.a), b: nf(r.b)})
      : t("Программа сравнения не найдена: файлы отличий — в открытой папке ({a}, {b})", {a: r.files[0], b: r.files[1]}));
  } catch (e) { fail(e); }
  btn.removeAttribute("disabled");
}
function hydrateDiffButtons() {
  document.querySelectorAll("[data-diff]:not([title])").forEach(async b => {
    b.title = "…";
    const [kind, args] = JSON.parse(b.dataset.diff);
    try {
      const d = await api("diff_info", kind, args);
      b.title = d.tool ? t("Откроется в {tool}: {a} ↔ {b}", {tool: d.tool, a: d.files[0], b: d.files[1]}) : t("Программа сравнения не найдена: укажите путь в настройках (клик по базе вверху панели)");
    } catch (e) { b.title = String(e.message || e); }
  });
}
function runDiff(b) { const [kind, args] = JSON.parse(b.dataset.diff); api("run_diff", kind, args).catch(fail); }

// ---------------------------------------------------------------- сравнение (режим 2, §4.2, §6.7)
// Отчеты запусков не меняются, поэтому готовое сравнение пары открывается сразу (v.report - файл
// сравнения), а процесс режима 2 запускается, только если его еще нет; fresh - сравнить заново.
async function startCompare(a, b, fresh) {
  try {
    const cached = fresh ? null : await api("compare_cached", a, b);
    if (cached) { go({k: "compare", report: cached, a, b}); return; }
    const info = await api("compare", a, b);
    S.procs[info.id] = {info, events: []};
    go({k: "compare", pid: info.id, a, b}, fresh);
  } catch (e) { fail(e); }
}
const runName = r => `${reportStem(r)}.sql · ${tsText((r.match(/_(\d{8}_\d{6})/) || [])[1])}`;
async function viewCompare(m, v) {
  if (v.sess) return viewSessionCompare(m, v);
  const p = S.procs[v.pid], refA = S.st.reference === v.a;
  const na = refA ? "опорный" : "A", nb = refA ? "этот" : "B";     // внутренние имена; выводятся через t()
  const chip = (r, cls, pre) => `<span class="chip link${cls}" title="${t("Открыть этот запуск")}" onclick="go({k:'result',report:${h(JSON.stringify(r))}})">${pre}${h(runName(r))}</span>`;
  const head = acts => `<header class="head"><div style="display:flex;flex-direction:column;gap:10px">${backLine()}<h1>${refA ? t("Сравнение с опорным") : t("Сравнение запусков")}</h1>
    <div class="row">${chip(v.b, " c-acc", "B · ")}<span class="pale">${t("против")}</span>${chip(v.a, "", refA ? I.star(13, true) + t("опорный") + " · " : "A · ")}</div></div>
    <div class="row">${acts || ""}</div></header>`;
  if (!v.report && (!p || p.info.running)) { m.innerHTML = head() + `<div class="card empty"><span class="pulse"></span> ${t("Сравнение идет…")}</div>`; return; }
  const file = v.report ? S.st.folder + "\\" + v.report : p.info.report;      // файл сравнения: готовый или только что сделанный
  let d = null, txt = {full: ""};
  if (file) {
    try { [d, txt] = await Promise.all([api("compare_details", file, v.a, v.b, !!v.allOps), api("compare_text", file)]); } catch (e) { fail(e); }
  }
  if (S.view !== v) return;
  if (!d) {
    m.innerHTML = head() + `<div class="card verdict v-diff"><span class="ic">!</span><span style="display:flex;flex-direction:column;gap:3px"><span style="font-size:18px;font-weight:700">${t("Сравнение не выполнено")}</span><span class="lbl">${h(((p ? p.events : []).filter(e => e.event === "log").pop() || {}).text || "")}</span></span></div>`;
    return;
  }
  const identical = d.head.some(x => x.startsWith("Итог: результаты идентичны"));
  const acts = `<span class="ib big" title="${t("Показать файлы сравнения в папке")}" onclick="api('show_in_folder', ${h(JSON.stringify(file))})">${I.folder(19)}</span>` +
    `<span class="ib big" title="${t("Сравнить заново")}" onclick="startCompare(${h(JSON.stringify(v.a))}, ${h(JSON.stringify(v.b))}, true)">${I.refresh(19)}</span>` +
    (d.scripts[0].toLowerCase() !== d.scripts[1].toLowerCase() ? diffButton(t("Сравнить скрипты"), "scripts", [v.a, v.b]) : "") + diffButton(t("Сравнение в diff"), "reports", [v.a, v.b]);
  // вердикты: данные и время
  const diffT = d.tables.filter(tb => tb.state !== "идентична");
  const dataV = identical
    ? `<div class="card verdict v-ok" style="flex:1"><span class="ic">=</span><span style="display:flex;flex-direction:column;gap:3px"><span style="font-size:18px;font-weight:700">${t("Данные совпадают")}</span><span class="lbl">${t("{n} табл.", {n: d.tables.length})}</span></span></div>`
    : `<div class="card verdict v-diff" style="flex:1"><span class="ic">≠</span><span style="display:flex;flex-direction:column;gap:3px"><span style="font-size:18px;font-weight:700">${t("Данные различаются")}</span><span class="lbl">${t("{n} табл. из {of}", {n: diffT.length, of: d.tables.length})}</span></span></div>`;
  const [t0, t1] = d.time, pct = t0 && t1 != null ? Math.round((t1 - t0) * 100 / t0) : null;
  const timeV = pct === null ? "" : `<div class="card verdict ${Math.abs(pct) < 3 ? "v-none" : pct < 0 ? "v-fast" : "v-diff"}" style="flex:1"><span class="ic">${Math.abs(pct) < 3 ? "≈" : pct < 0 ? I.dn(22) : I.up(22)}</span>
    <span style="display:flex;flex-direction:column;gap:2px"><span style="font-size:18px;font-weight:700">${Math.abs(pct) < 3 ? t("Время почти то же") : t(pct < 0 ? "Быстрее на {p}%" : "Медленнее на {p}%", {p: Math.abs(pct)})}</span>
    <span class="lbl">${t("{a} мс против {b} мс", {a: nf(t1), b: nf(t0)})}</span><span class="dur">${dur(t1) || ""}${t1 >= 1000 || t0 >= 1000 ? " " + t("против") + " " + (dur(t0) || "<1 " + t("с")) : ""}</span></span></div>`;
  const notes = d.head.filter(x => /^(Внимание|Значения сравниваются|Допуск)/.test(x));
  // таблицы: различающиеся - карточками с примерами строк, идентичные - списком
  const ignCol = tb => { const l = tb.lines.find(x => x.startsWith("Отличающиеся колонки")); const m2 = l && /:\s*([^,(]+)/.exec(l); return m2 && m2[1].trim() !== "нет" ? m2[1].trim() : null; };
  const cards = diffT.map(tb => {
    const col = ignCol(tb), key = (tb.lines.find(x => x.startsWith("Ключ")) || "").replace(/;.*$/, "");
    const both = !tb.state.startsWith("есть только");
    return `<section class="card tw show${tcolCls("cmptable")}">${tcolBtn("cmptable")}<div class="tbar" style="flex-wrap:wrap"><h2>${t("Таблица {n}", {n: tb.n})}</h2><span class="chip c-diff">${h(t(tb.state))}</span><span class="lbl">${h(key)}</span>
      <span class="row" style="width:100%;margin-top:4px">${both ? diffButton(t("Сравнить CSV"), "table", [v.a, v.b, tb.n], true) + `<a class="btn sm" title="${t("Два CSV только с отличающимися строками (рядом с CSV таблицы) — в программе сравнения")}" onclick="diffRows(${h(JSON.stringify(v.a))}, ${h(JSON.stringify(v.b))}, ${tb.n}, this)">${I.diff(15)}${t("Сравнить отличия")}</a>` : ""}${col ? `<a class="btn sm" onclick="ignoreDialog(${h(JSON.stringify(d.scripts[1]))}, {cols: [${h(JSON.stringify(col))}], table: '${tb.n}'})">${t("Игнорировать {col}…", {col: h(col)})}</a>` : ""}</span></div>
      <div id="cd-${tb.n}">${both ? `<div class="empty"><span class="pulse"></span> ${t("Примеры строк…")}</div>` : `<div class="dsum">${tb.lines.map(x => `<span>${h(x)}</span>`).join("")}</div>`}</div></section>`;
  }).join("");
  const same = d.tables.filter(tb => tb.state === "идентична");
  const sameCard = same.length ? `<section class="card tw${tcolCls("cmpsame", true)}">${tcolBtn("cmpsame")}<div class="tbar"><h2>${t("Идентичные таблицы")}</h2><span class="lbl">${nf(same.length)}</span></div><div>${same.map(tb => `<div class="trow"><h2 style="min-width:110px">${t("Таблица {n}", {n: tb.n})}</h2><span class="chip c-ok">${t("идентична")}</span><span class="lbl">${h(tb.lines[0] || "")}</span></div>`).join("")}</div></section>` : "";
  const st = d.statements;
  // операторы - srvTable (вид "cmp": колонки, порядок, сортировка), полосы ожиданий, «только значимые»
  const stmts = st === null ? "" : cmpStmtsCard(d, {refA, reload: all => api("compare_details", file, v.a, v.b, all)});
  m.innerHTML = head(acts) +
    (d.why ? `<div class="card verdict v-none"><span class="ic">≁</span><span style="display:flex;flex-direction:column;gap:3px"><span style="font-size:17px;font-weight:700">${t("Запуски несравнимы")}</span><span class="lbl">${h(d.why)} · ${t("сравнение выполнено по просьбе")}</span></span></div>` : "") +
    `<div style="display:flex;flex-wrap:wrap;gap:16px">${dataV}${timeV}</div>` +
    (notes.length ? `<div class="pale" style="font-size:12.5px;margin-top:-6px">${notes.map(h).join(" · ")}</div>` : "") +
    cards + sameCard + stmts +
    (txt.full ? `<section class="card tw${tcolCls("cmpfull", true)}">${tcolBtn("cmpfull")}<div class="tbar"><h2>${t("Полный отчет сравнения")}</h2></div><pre class="rep">${h(txt.full)}</pre></section>` : "");
  if (st && st.length) S.live.cmp.render();
  document.querySelectorAll("#main .tscroll").forEach(hbar);
  hydrateDiffButtons();
  for (const tb of diffT.filter(x => !x.state.startsWith("есть только"))) {    // примеры строк - по таблицам, по очереди
    const box = $("#cd-" + tb.n);
    try {
      const x = await api("table_diff", v.b, tb.n, v.a);
      if (!box.isConnected) return;
      box.innerHTML = diffHtml(x, na, nb);
      const ts = box.querySelector(".tscroll");
      if (ts) hbar(ts);
    } catch (e) { if (box.isConnected) box.innerHTML = `<div class="empty">${h(e.message || e)}</div>`; }
  }
}

// Карточка «Значимые изменения операторов» экранов сравнения запусков и наблюдений (§4.2, §4.3):
// - две полосы долей ожиданий в одном масштабе: сверху B (новый, «этот»), снизу A (★ - опорный); у кого
//   меньше времени, та полоса короче;
// - переключатель «только значимые» (по умолчанию включен): выключен - фраза отбора зачеркнута, все пары
//   операторов, первые STMT_ALL_TOP по модулю разницы (тот же API с all_ops; без реестров переключателя нет);
// - таблица (вид "cmp", srvTable). o: {refA, sess, star (A опорный), reload(all) -> ответ API}.
function cmpStmtsCard(d, o) {
  const st = d.statements, stCols = cmpStCols(o.refA, o.sess);
  S.live.cmp = {sort: (S.live.cmp || {}).sort || null, card: o, render: () => { const b = $("#cmp-body"); if (b) { b.innerHTML = srvTable("cmp", stCols, st); hbar(b); } }};
  let bars = "";
  if (d.waits) {
    const ia = regWaitItems(d.waits[0]), ib = regWaitItems(d.waits[1]), ta = waitTotal(ia), tb = waitTotal(ib), mx = Math.max(ta, tb);
    // значки одной ширины (.wic), чтобы обе полосы начинались с одного пикселя: B - «новый», A - ★ опорного
    const ref = o.refA || o.star;
    const icB = ref ? `<span class="wic" title="${h(o.sess ? t("Новое (B)") : t("Новый (B)"))}">${I.spark(16)}</span>` : `<span class="wic ab" title="B">B</span>`;
    const icA = ref ? `<span class="wic" title="${o.sess ? t("Опорное (A)") : t("Опорный (A)")}">${I.star(16, true)}</span>` : `<span class="wic ab" title="A">A</span>`;
    if (mx > 0) bars = `<div class="wpair">${waitBarHtml(ib, {scale: tb / mx, icon: icB}) || `<div class="wrow">${icB}<span class="pale" style="font-size:12px;padding-bottom:10px">${t("нет данных")}</span></div>`}${waitBarHtml(ia, {scale: ta / mx, icon: icA}) || `<div class="wrow">${icA}<span class="pale" style="font-size:12px;padding-bottom:10px">${t("нет данных")}</span></div>`}</div>`;
  }
  const all = !!d.all, sw = d.count == null ? "" : `<span class="sw sm${all ? "" : " on"}" title="${t("Только значимые изменения; выключить — все операторы (первые {n} по разнице)", {n: 500})}" onclick="cmpAllToggle(this)"></span>`;
  const phrase = `<span class="lbl cmpsig">${sw}<span class="${all ? "off" : ""}">${t("от 20% и от 1 000 мс")}</span>${all ? ` · ${d.count > st.length ? t("первые {n} из {of} по разнице", {n: nf(st.length), of: nf(d.count)}) : t("все операторы: {n}", {n: nf(d.count)})}` : ""}</span>`;
  return `<section class="card tw${tcolCls("cmp")}" id="cmp-card">${tcolBtn("cmp")}<div class="tbar"><h2>${t("Значимые изменения операторов")}</h2>${phrase}</div>
    ${bars}${st.length ? `<div class="acts">${colsBtn("cmp", "S.live.cmp")}</div><div class="tscroll" id="cmp-body"></div>` : `<div class="empty">${t("нет")}</div>`}${(d.statement_notes || []).length ? `<div class="dsum">${d.statement_notes.map(x => `<span>${h(x)}</span>`).join("")}</div>` : ""}</section>`;
}
async function cmpAllToggle(sw) {
  const L = S.live.cmp, v = S.view, all = sw.classList.contains("on");      // был включен - станут все
  if (!L || sw.dataset.busy) return;
  sw.dataset.busy = "1";
  sw.classList.toggle("on");
  let d;
  try { d = await L.card.reload(all); } catch (e) { fail(e); sw.classList.toggle("on"); delete sw.dataset.busy; return; }
  if (S.view !== v || !$("#cmp-card")) return;
  v.allOps = all;               // переживает возврат на экран
  $("#cmp-card").outerHTML = cmpStmtsCard(d, L.card);
  if (d.statements.length) S.live.cmp.render();
}
// Колонки таблицы значимых изменений операторов (вид "cmp"): сравнение запусков и наблюдений.
// runs - у наблюдений: число запусков оператора и время на запуск (циклы, позднее подключение).
function cmpStCols(refA, runs) {
  const delta = x => { const dd = x.b - x.a; return dd < 0 ? "#1F55A8" : "#9A4A07"; };
  // кнопки: текст и план оператора в каждом запуске (файлы реестров; нет файла - кнопки нет)
  const fb = (f, side) => [f && f[0] ? textActs(f[0], t("Текст оператора") + " · " + side) : `<span class="ib off"></span>`,
    f && f[1] ? `<span class="ib" title="${t("План")} · ${h(side)}" onclick="api('open_path', ${h(JSON.stringify(f[1]))}).catch(fail)">${I.plan(14)}</span>` : `<span class="ib off"></span>`].join("");
  const sideA = refA ? t("Опорный") : "A", sideB = refA ? t("Этот") : "B";
  // сравнение текста оператора A и B во внешней программе (только текст, временные файлы); оператор только
  // с одной стороны - кнопки нет. Стоит третьей в первой колонке - между парами «текст, план» A и B.
  const cmpBtn = x => x.files_a && x.files_a[0] && x.files_b && x.files_b[0]
    ? `<span class="ib" title="${t("Сравнить текст оператора ({a} ↔ {b}) в программе сравнения", {a: sideA, b: sideB})}" onclick="api('run_diff', 'stmt', ${h(JSON.stringify([x.files_a[0], x.files_b[0]]))}).catch(fail)">${I.diff(14)}</span>` : `<span class="ib off"></span>`;
  const waitCell = v => { const w = /^(.*) \((\d+) мс\)$/.exec(v || ""); return `<td>${w ? `${waitHtml(w[1])}<span class="sv wi">${nf(w[2])} ${t("мс")}</span>` : '<span class="pale">—</span>'}</td>`; };
  const dw = x => x.waits_a == null && x.waits_b == null ? null : (x.waits_b || 0) - (x.waits_a || 0);
  const cols = [
    [null, ["{x}", {x: sideA}], null, x => `<td class="acts2 tight">${fb(x.files_a, sideA)}${cmpBtn(x)}</td>`],
    [null, ["{x}", {x: sideB}], null, x => `<td class="acts2 tight">${fb(x.files_b, sideB)}</td>`],
    ["op", "Оператор", "", x => `<td class="op wide b" style="min-width:300px" data-op="${h(x.label)}:${x.line}" title="${h(x.text || "")}"><span class="opl"><span>${h(x.label)}:${x.line}${x.note ? ` <span class="pale" style="font-weight:500">${h(x.note.trim())}</span>` : ""}</span></span><span class="sv">${h(x.text || "")}</span></td>`, x => `${x.label}:${String(x.line).padStart(7, "0")}`],
    ["a", ["{x}<br>мс", {x: refA ? t("Опорный") : "A"}], "n", x => `<td class="n">${nf(x.a)}${x.a >= 1000 ? `<span class="sv">${dur(x.a)}</span>` : ""}</td>`],
    ["b", ["{x}<br>мс", {x: refA ? t("Этот") : "B"}], "n", x => `<td class="n">${nf(x.b)}${x.b >= 1000 ? `<span class="sv">${dur(x.b)}</span>` : ""}</td>`],
    ["d", "Разница<br>мс", "n", x => { const dd = x.b - x.a; return `<td class="n b" style="color:${delta(x)}">${dd > 0 ? "+" : dd < 0 ? "−" : ""}${nf(Math.abs(dd))}</td>`; }, x => x.b - x.a],
    ["pct", "Разница<br>%", "n", x => `<td class="n" style="color:${delta(x)}">${h(x.pct.replace("-", "−"))}</td>`, x => parseFloat(x.pct) || 0],
    ["dw", "Разница<br>ожиданий мс", "n", x => { const v = dw(x); return v === null ? `<td class="n"></td>` : `<td class="n" style="color:${v < 0 ? "#1F55A8" : "#9A4A07"}" title="${t("Ожидания блокировок и ресурсов: {b} мс против {a} мс", {b: nf(x.waits_b || 0), a: nf(x.waits_a || 0)})}">${v > 0 ? "+" : v < 0 ? "−" : ""}${nf(Math.abs(v))}</td>`; }, x => dw(x) ?? 0],
    ["wait", ["Ожидание ресурсов<br>1 место ({x})", {x: refA ? t("этот") : "B"}], "", x => waitCell(x.wait)],
    ["wait_a", ["Ожидание ресурсов<br>1 место ({x})", {x: refA ? t("опорный") : "A"}], "", x => waitCell(x.wait_a)]];
  if (runs) cols.splice(7, 0, ["runs", "Запусков", "n", x => `<td class="n">${nf(x.runs_a)} → ${nf(x.runs_b)}${x.runs_a && x.runs_b ? `<span class="sv">${nf(Math.round(x.a / x.runs_a))} → ${nf(Math.round(x.b / x.runs_b))} ${t("мс на запуск")}</span>` : ""}</td>`, x => x.runs_b - x.runs_a]);
  return cols;
}

// ---------------------------------------------------------------- сравнение наблюдений (§4.3, §6.8)
function startSessionCompare(a, b) {
  api("compare_sessions", a, b).then(info => {
    S.procs[info.id] = {info, events: []};
    go({k: "compare", sess: true, pid: info.id, a, b});
  }).catch(fail);
}
const sessName = f => { const m = /^Session_(\d{8}_\d{6})_(\d+)/.exec(f) || []; return `${t("сессия")} ${m[2] || "?"} · ${tsText(m[1])}`; };
async function viewSessionCompare(m, v) {
  const p = S.procs[v.pid];
  const chip = (f, cls, pre) => `<span class="chip link${cls}" title="${t("Открыть это наблюдение")}" onclick="go({k:'sessiondone',folder:${h(JSON.stringify(f))}})">${pre}${h(sessName(f))}</span>`;
  const head = acts => `<header class="head"><div style="display:flex;flex-direction:column;gap:10px">${backLine()}<h1>${t("Сравнение наблюдений")}</h1>
    <div class="row">${chip(v.b, " c-acc", "B · ")}<span class="pale">${t("против")}</span>${chip(v.a, "", S.st.session_reference === v.a ? I.star(13, true) + t("опорное") + " · " : "A · ")}</div></div>
    <div class="row">${acts || ""}</div></header>`;
  if (!p || p.info.running) { m.innerHTML = head() + `<div class="card empty"><span class="pulse"></span> ${t("Сравнение идет…")}</div>`; return; }
  let d = null, txt = {full: ""};
  if (p.info.report && p.info.code === 0) {
    try { [d, txt] = await Promise.all([api("session_compare_details", v.a, v.b, !!v.allOps), api("compare_text", p.info.report)]); } catch (e) { fail(e); }
  }
  if (S.view !== v) return;
  if (!d) {
    m.innerHTML = head() + `<div class="card verdict v-diff"><span class="ic">!</span><span style="display:flex;flex-direction:column;gap:3px"><span style="font-size:18px;font-weight:700">${t("Сравнение не выполнено")}</span><span class="lbl">${h((p.events.filter(e => e.event === "log").pop() || {}).text || "")}</span></span></div>`;
    return;
  }
  const acts = `<span class="ib big" title="${t("Показать файлы сравнения в папке")}" onclick="api('show_in_folder', ${h(JSON.stringify(p.info.report))})">${I.folder(19)}</span>`;
  // время общей части (без операторов до начала более позднего наблюдения)
  const [t0, t1] = d.total, pct = t0 ? Math.round((t1 - t0) * 100 / t0) : null;
  const timeV = pct === null ? "" : `<div class="card verdict ${Math.abs(pct) < 3 ? "v-none" : pct < 0 ? "v-fast" : "v-diff"}"><span class="ic">${Math.abs(pct) < 3 ? "≈" : pct < 0 ? I.dn(22) : I.up(22)}</span>
    <span style="display:flex;flex-direction:column;gap:2px"><span style="font-size:18px;font-weight:700">${Math.abs(pct) < 3 ? t("Время почти то же") : t(pct < 0 ? "Быстрее на {p}%" : "Медленнее на {p}%", {p: Math.abs(pct)})}</span>
    <span class="lbl">${t("{a} мс против {b} мс", {a: nf(t1), b: nf(t0)})} · ${t("время по выборкам, общая часть наблюдений")}</span></span></div>`;
  const notes = d.notes.filter(x => !x.startsWith("  "));
  const notesCard = notes.length ? `<div class="dsum" style="margin-top:-6px">${notes.map(x => `<span>${h(x)}</span>`).join("")}</div>` : "";
  // объекты: время по процедурам и скриптам (вид "cmpobj")
  const col = x => x.b < x.a ? "#1F55A8" : "#9A4A07";
  const objCols = [
    ["name", "Объект", "", x => `<td class="b">${h(x.name)}${x.significant ? "" : ` <span class="pale" style="font-weight:500">${t("незначимо")}</span>`}</td>`],
    ["a", "A<br>мс", "n", x => `<td class="n">${nf(x.a)}${x.a >= 1000 ? `<span class="sv">${dur(x.a)}</span>` : ""}</td>`],
    ["b", "B<br>мс", "n", x => `<td class="n">${nf(x.b)}${x.b >= 1000 ? `<span class="sv">${dur(x.b)}</span>` : ""}</td>`],
    ["d", "Разница<br>мс", "n", x => { const dd = x.b - x.a; return `<td class="n b" style="color:${col(x)}">${dd > 0 ? "+" : dd < 0 ? "−" : ""}${nf(Math.abs(dd))}</td>`; }, x => x.b - x.a],
    ["pct", "Разница<br>%", "n", x => `<td class="n" style="color:${col(x)}">${x.a ? (x.b >= x.a ? "+" : "−") + Math.abs(Math.round((x.b - x.a) * 100 / x.a)) + "%" : t("было 0")}</td>`, x => x.a ? (x.b - x.a) / x.a : 1e9]];
  S.live.cmpobj = {sort: null, render: () => { const b = $("#cmpobj-body"); if (b) { b.innerHTML = srvTable("cmpobj", objCols, d.objects); hbar(b); } }};
  const objs = `<section class="card tw${tcolCls("cmpobj")}">${tcolBtn("cmpobj")}<div class="tbar"><h2>${t("Время по объектам")}</h2><span class="lbl">${t("работает и при другом алгоритме внутри объекта")}</span></div>
    ${d.objects.length ? `<div class="acts">${colsBtn("cmpobj", "S.live.cmpobj")}</div><div class="tscroll" id="cmpobj-body"></div>` : `<div class="empty">${t("нет")}</div>`}</section>`;
  const st = d.statements;
  const stmts = cmpStmtsCard(d, {refA: false, sess: true, star: S.st.session_reference === v.a, reload: all => api("session_compare_details", v.a, v.b, all)});
  m.innerHTML = head(acts) + timeV + notesCard + objs + stmts +
    (txt.full ? `<section class="card tw${tcolCls("cmpfull", true)}">${tcolBtn("cmpfull")}<div class="tbar"><h2>${t("Полный отчет сравнения")}</h2></div><pre class="rep">${h(txt.full)}</pre></section>` : "");
  if (d.objects.length) S.live.cmpobj.render();
  if (st.length) S.live.cmp.render();
  document.querySelectorAll("#main .tscroll").forEach(hbar);
}

// ---------------------------------------------------------------- запросы на сервере: общие части
// Сортируемая таблица из описаний колонок: [ключ, заголовок, вид, функция ячейки]; вид "n" - число
// (сортировка как чисел, выравнивание вправо). Сортировка - клик по заголовку (S.live.<id>.sort).
// Колонки без ключа (кнопки строки) - всегда первые; остальные - в порядке и с видимостью вида id
// (colPrefs, окно «Колонки» - colsBtn(id, "S.live." + id)), перетаскиваются за заголовок.
// Длинная таблица - первые TABLE_SHOW строк после сортировки и «показать еще» (S.live.<id>.show): правило
// для всех таблиц GUI, раскладка тысяч строк занимает секунды.
function srvTable(id, cols, rows, rowAttr) {
  const L = S.live[id], s = L.sort;
  L.keys = cols.filter(c => c[0]).map(c => c[0]);
  const tt = x => Array.isArray(x) ? t(x[0], x[1]) : t(x);      // заголовок: строка или [шаблон, подстановки]
  L.titles = Object.fromEntries(cols.filter(c => c[0]).map(c => [c[0], tt(c[1]).replace(/<br>/g, " ").replace(/-\s/g, "")]));
  cols = cols.filter(c => !c[0]).concat(arrangeCols(id, L.keys).map(k => cols.find(c => c[0] === k)));
  rows = srvSorted(id, cols, rows);
  const lim = L.show || TABLE_SHOW, more = rows.length - lim;
  if (more > 0) rows = rows.slice(0, lim);
  return `<table class="t compact srv"><thead><tr>${cols.map(([k, title, kind]) => k
    ? `<th class="${kind === "n" ? "n" : ""}${L.hot === k ? " hot" : ""}" ${thDrag(id, `S.live.${id}.keys`, k, `S.live.${id}.render`)} onclick="srvSort('${id}', '${k}')">${tt(title)}${s && s.k === k ? `<span class="s">${s.dir > 0 ? "▲" : "▼"}</span>` : ""}</th>`
    : `<th${title ? ' class="tight"' : ""}>${title ? tt(title) : ""}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr${rowAttr ? rowAttr(r) : ""}>${cols.map(c => c[3](r)).join("")}</tr>`).join("")}</tbody></table>` +
    (more > 0 ? tableMore(lim, lim + more, `S.live.${id}.show=${lim + TABLE_SHOW};S.live.${id}.render()`) : "");
}
// строка под длинной таблицей: показано n из all, «показать еще» (не больше TABLE_SHOW)
const tableMore = (n, all, on) => `<div class="tmore stick"><span class="pale">${t("Показаны первые {n} строк из {of}", {n: nf(n), of: nf(all)})}</span><a class="btn sm" data-more onclick="${on}">${t("показать еще {n}", {n: nf(Math.min(all - n, TABLE_SHOW))})}</a></div>`;
function srvSorted(id, cols, rows) {     // строки в порядке сортировки S.live.<id>.sort
  const s = S.live[id].sort, c = s && cols.find(x => x[0] === s.k);
  if (!c) return rows;
  const num = c[2] === "n", val = c[4] || (r => r[c[0]]);
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null || y == null) return (x == null) - (y == null);
    return (num ? x - y : String(x).localeCompare(String(y), "ru")) * s.dir;
  });
}
function srvSort(id, k) {
  const L = S.live[id], s = L.sort;
  L.sort = !s || s.k !== k ? {k, dir: -1} : {k, dir: -s.dir};
  L.render();
}
const srvMatch = (r, f, keys) => !f || keys.some(k => r[k] != null && String(r[k]).toLowerCase().includes(f));
const opCell = (obj, line, stmt) => `<td class="op b" data-op="${h(obj ? obj + (line ? ":" + line : "") : "")}" title="${h(stmt)}">${h(obj || t("запрос (ad hoc)"))}${line ? ":" + line : ""}<span class="sv">${h((stmt || "").replace(/\s+/g, " ").slice(0, 200))}</span></td>`;
const msCell = v => `<td class="n">${v == null ? "" : nf(v)}${v >= 1000 ? `<span class="sv">${dur(v)}</span>` : ""}</td>`;
// Текст запроса: выделить, скопировать, открыть программой. file - {path, plan}: текст оператора из
// файла реестра - еще «Показать в папке» и план (лежит рядом с текстом; нет - значок бледный)
// db - база оператора для оценочного плана (PostgreSQL; null - база подключения)
function textDialog(title, text, name, file, db = null, plan = true) {     // plan - кнопка оценочного плана
  window._txt = {text, name, file, db};
  const est = plan && dbms().can_estimate && text ? `<a class="btn" title="${t("EXPLAIN без выполнения: план, который построит сервер (с параметрами $1 — общий план, PostgreSQL 16+)")}" onclick="api('estimate_plan', _txt.text, _txt.db, _txt.name).catch(fail)">${I.plan(16)}${t("Оценочный план")}</a>` : "";
  modal(`<div class="dlg" style="width:min(1000px,90vw)"><div class="dh"><h2>${h(title)}</h2></div>
    <div class="db"><pre class="rep sqlbox">${text ? hlSql(text) : `<span class="pale">${t("текста нет")}</span>`}</pre></div>
    <div class="df" style="align-items:center"><span class="row" style="margin-right:auto">${file ? `<span class="ib" title="${t("Показать в папке")}" onclick="api('show_in_folder', _txt.file.path)">${I.folder(17)}</span>` +
        (file.plan ? `<span class="ib" title="${t("План")}" onclick="api('open_path', _txt.file.plan).catch(fail)">${I.plan(17)}</span>` : `<span class="ib dis" title="${t("Плана нет")}">${I.plan(17)}</span>`) : ""}
      <span class="ib" title="${t("Скопировать")}" onclick="navigator.clipboard.writeText(_txt.text).then(() => toast(t('Скопировано')), fail)">${I.copy(17)}</span></span>${est}<a class="btn" onclick="api('open_text', _txt.name, _txt.text).catch(fail)">${I.open(16)}${t("Открыть в программе")}</a><a class="btn pri" onclick="closeModal()">${t("Закрыть")}</a></div></div>`);
}

// ---------------------------------------------------------------- текущие запросы (§5.20)
// Раз в CUR_S секунд - один легкий запрос (сессии с запросом и блокирующие). Кольцо - отсчет до
// обновления; клик по нему - пауза/продолжить. Пока пользователь выделяет текст в таблице, таблица
// не перерисовывается.
const CUR_S = 4, KILL_TRUST_MS = 10000;
function viewCurrent(m, v) {
  m.innerHTML = `
    <header class="head"><div style="display:flex;flex-direction:column;gap:8px">${backLine()}<h1 style="display:flex;align-items:center;gap:14px">${t("Текущие запросы")} <span id="cq-ring"></span></h1>
      <span class="lbl" id="cq-info">${t("пользовательские сессии с запросом и сессии, которые блокируют других · обновление раз в {n} с", {n: CUR_S})}</span></div></header>
    <section class="kpis k6" id="cq-kpis">${kpiBox("cq-s", "Сессий пользователей")}${kpiBox("cq-r", "Выполняется запросов")}${kpiBox("cq-b", "Ждут блокировку")}${kpiBox("cq-m", "Ждут память")}${kpiBox("cq-q", "Очередь на процессор")}${kpiBox("cq-l", "Самый долгий запрос")}</section>
    <section class="card tw show${tcolCls("cur")}">${tcolBtn("cur")}<div class="tbar"><span class="fl">${I.search(15)}<input id="cq-flt" placeholder="${t("Фильтр: база, программа, логин, текст")}">${FLX}</span><span class="lbl" id="cq-cnt"></span></div>
      <div class="acts">${colsBtn("cur", "S.live.cur")}</div>
      <div class="tscroll" id="cq-body"><div class="empty">${t("Загрузка…")}</div></div></section>`;
  const L = S.live.cur = {paused: false, sort: {k: v.sort || "elapsed", dir: -1}, filter: (v.filter || "").toLowerCase(), hl: v.hl, render: curRender};
  $("#cq-flt").value = v.filter || "";
  $("#cq-flt").addEventListener("input", e => { L.filter = e.target.value.trim().toLowerCase(); curRender(); });
  curLoad();
}
async function curLoad() {
  const L = S.live.cur;
  if (!L || S.view.k !== "current") return;
  clearTimeout(L.timer);
  // окно свернуто или скрыто - запроса нет; обновление - как только окно снова видно
  if (document.hidden) { L.hiddenWait = true; return; }
  curRing("load");
  try { L.data = await api("current_queries"); L.err = null; } catch (e) { L.err = String(e.message || e); }
  if (S.live.cur !== L || S.view.k !== "current") return;
  curRender();
  if (!L.paused) { L.timer = setTimeout(curLoad, CUR_S * 1000); curRing("wait"); } else curRing("pause");
}
document.addEventListener("visibilitychange", () => {
  const L = S.live.cur;
  if (!document.hidden && L && L.hiddenWait && !L.paused) { L.hiddenWait = false; curLoad(); }
});
function curRing(state) {      // wait - отсчет, load - идет запрос, pause - пауза
  const el = $("#cq-ring");
  if (!el) return;
  const tip = state === "pause" ? t("Обновление приостановлено — продолжить") : t("Отсчет до обновления — приостановить");
  el.innerHTML = `<span class="ring cd ${state}" title="${tip}" onclick="curToggle()"><svg width="22" height="22" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" class="rb"/><circle cx="10" cy="10" r="8" class="rf" style="animation-duration:${CUR_S}s"/>${state === "pause" ? '<path d="M8 6.5v7M12 6.5v7" stroke="#485264" stroke-width="2" stroke-linecap="round"/>' : ""}</svg></span>`;
}
function curToggle() {
  const L = S.live.cur;
  L.paused = !L.paused;
  if (L.paused) { clearTimeout(L.timer); curRing("pause"); } else curLoad();
}
function curRender() {
  const L = S.live.cur, d = L.data, body = $("#cq-body");
  if (!body) return;
  if (L.err) { body.innerHTML = `<div class="empty">${t("Не удалось получить список: {err}", {err: h(L.err)})}</div>`; return; }
  if (!d) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && body.contains(sel.anchorNode)) return;     // пользователь выделяет текст
  const rows = d.rows, active = rows.filter(r => r.status);
  setKpi("cq-s", d.sessions ?? 0);
  setKpi("cq-r", active.length);
  setKpi("cq-b", rows.filter(r => r.blocked_by > 0 && r.blocked_by !== r.spid).length);
  setKpi("cq-m", d.memory_waits);       // null - у СУБД нет (PostgreSQL): "—"
  setKpi("cq-q", d.runnable);
  setRoll($("#cq-l"), clock(Math.max(0, ...active.map(r => r.elapsed || 0))));
  for (const [id, bad] of [["cq-b", rows.some(r => r.blocked_by > 0 && r.blocked_by !== r.spid)], ["cq-m", d.memory_waits > 0]]) $("#" + id).closest(".kpi").classList.toggle("warn", bad);
  if (d.server_time) $("#cq-info").textContent = t("пользовательские сессии с запросом и сессии, которые блокируют других · обновление раз в {n} с", {n: CUR_S}) + " · " + t("сервер {time}", {time: d.server_time.slice(11)});
  const shown = rows.filter(r => srvMatch(r, L.filter, ["db", "program", "login", "host", "object", "statement", "spid", "wait", "input"]));
  $("#cq-cnt").textContent = shown.length !== rows.length ? t("{n} из {of}", {n: shown.length, of: rows.length}) : String(shown.length);
  const ib = (title, on, icon, extra = "") => `<span class="ib${extra}" title="${t(title)}" onclick="${on}">${icon}</span>`;
  const inbuf = !(dbms().absent.current || []).includes("input");     // у PostgreSQL исходный запрос и есть текст
  const cancel = dbms().can_cancel;     // отменить запрос, не закрывая сессию (PostgreSQL)
  const cols = absentCols("current", [
    [null, "", null, r => `<td class="acts2">${ib("Текст запроса", `curText(${r.spid})`, I.note(14))}${r.plan_handle ? ib("План", `curPlan(${r.spid})`, I.plan(14)) : ""}${inbuf ? ib("Исходный запрос: что прислал клиент", `curInput(${r.spid})`, I.input(14)) : ""}${ib("Наблюдать сессию", `startSession(${r.spid})`, I.eye(14))}${ib("К экрану «База данных», таблица «Временные данные»: эта сессия", goJs({k: "dbinfo", spid: r.spid}), I.db(14))}${cancel && r.status ? ib("Отменить запрос: сессия остается", `curCancel(${r.spid})`, I.cancel(14), " danger") : ""}${ib("KILL — прервать сессию", `curKill(${r.spid})`, I.kill(14), " danger")}</td>`],
    ["spid", "№", "n", r => `<td class="n b">${r.spid}</td>`],
    ["db", "База", "", r => `<td>${h(r.db)}</td>`],
    ["object", "Оператор", "", r => r.status ? opCell(r.object, r.line, r.statement)
      : `<td class="op" title="${h(r.last_text)}"><span class="pale">${t("нет запроса — держит блокировку; последний запрос:")}</span><span class="sv">${h(r.last_text.replace(/\s+/g, " ").slice(0, 200))}</span></td>`],
    ["input", "Исходный запрос", "", r => `<td class="mono inbuf" title="${h(r.input || "")}">${h((r.input || "").slice(0, 160))}</td>`],
    ["login", "Логин", "", r => `<td>${h(r.login)}</td>`],
    ["host", "Компьютер", "", r => `<td>${h(r.host)}</td>`],
    ["status", "Состояние", "", r => `<td>${r.status ? h(r.status) : `<span class="pale">${t("простаивает")} ${r.idle_s != null ? clock(r.idle_s * 1000) : ""}</span>`}${r.percent ? `<span class="sv">${Math.round(r.percent)}%</span>` : ""}</td>`],
    ["elapsed", "Выпол-<br>няется", "n", r => `<td class="n">${r.elapsed != null ? `<span class="mono">${clock(r.elapsed)}</span>` : ""}</td>`],
    ["cpu", "CPU<br>мс", "n", r => msCell(r.cpu)],
    ["reads", "Логических<br>чтений", "n", r => `<td class="n">${nf(r.reads)}</td>`],
    ["writes", "Записей", "n", r => `<td class="n">${nf(r.writes)}</td>`],
    ["memory", "Память<br>МБ", "n", r => `<td class="n">${r.memory ? nf(r.memory) : ""}</td>`],
    ["wait", "Ожидание", "", r => r.wait ? `<td>${waitHtml(r.wait)}${r.wait_ms != null ? `<span class="sv wi">${nf(r.wait_ms)} ${t("мс")}</span>` : ""}</td>` : "<td></td>"],
    ["blocked_by", "Ждет<br>сессию", "n", r => `<td class="n">${r.blocked_by > 0 && r.blocked_by !== r.spid ? `<b class="hotv">${r.blocked_by}</b>` : ""}</td>`],
    ["blocks", "Блоки-<br>рует", "n", r => `<td class="n">${r.blocks ? `<b class="hotv">${r.blocks}</b>` : ""}</td>`],
    ["trans", "Транз-<br>акций", "n", r => `<td class="n">${r.trans || ""}</td>`],
    ["program", "Программа", "", r => `<td class="clip" title="${h(r.program)}">${h(r.program)}</td>`],
  ]);
  L.hot = null;
  L.byId = Object.fromEntries(rows.map(r => [r.spid, r]));
  body.innerHTML = shown.length ? srvTable("cur", cols, shown, r => ` class="${r.spid === L.hl ? "hl " : ""}${r.blocks ? "blocker" : r.blocked_by > 0 && r.blocked_by !== r.spid ? "blocked" : ""}"`)
    : `<div class="empty">${rows.length ? t("Нет строк по фильтру") : t("Сейчас на сервере нет пользовательских запросов")}</div>`;
  hbar(body);
  if (L.hl && !L.hlDone) { L.hlDone = true; hlRow(body); }
}
const curRow = spid => S.live.cur && S.live.cur.byId[spid];
function curText(spid) {
  const r = curRow(spid);
  if (r) textDialog(r.status ? `${t("Сессия {n}", {n: spid})} · ${r.object || t("запрос")}${r.line ? ":" + r.line : ""}` : `${t("Сессия {n}", {n: spid})} · ${t("последний запрос")}`, r.status ? r.text || r.statement : r.last_text, `session_${spid}`, null, r.db);
}
function curPlan(spid) { const r = curRow(spid); if (r) api("open_plan", r.plan_handle, r.start, r.end, `session_${spid}`).catch(fail); }
async function curInput(spid) {
  try { textDialog(`${t("Сессия {n}", {n: spid})} · ${t("исходный запрос")}`, await api("input_buffer", spid), `session_${spid}_input`); } catch (e) { fail(e); }
}
// KILL: подтверждение; после "да" следующие KILL_TRUST_MS без подтверждения, каждое нажатие продлевает
function curKill(spid) {
  if (Date.now() < (S.killTrust || 0)) { doKill(spid); return; }
  const r = curRow(spid) || {};
  modal(`<div class="dlg" style="width:460px"><div class="dh"><h2>${t("Прервать сессию {n}?", {n: spid})}</h2><span class="note">KILL ${spid}: ${h([r.login, r.host, r.program].filter(Boolean).join(" · "))}. ${t("Открытая транзакция сессии откатится (откат может занять время). Следующие 10 с KILL выполняется без вопроса.")}</span></div>
    <div class="df"><a class="btn pri" onclick="closeModal()">${t("Отмена")}</a><a class="btn dark" style="color:#FFF" onclick="closeModal();doKill(${spid})">KILL ${spid}</a></div></div>`);
}
async function doKill(spid) {
  S.killTrust = Date.now() + KILL_TRUST_MS;
  try { await api("kill_session", spid); toast(t("Сессия {n} прервана", {n: spid})); curLoad(); } catch (e) { fail(e); }
}
// Отмена запроса (PostgreSQL, pg_cancel_backend): так же с подтверждением, свое окно доверия
function curCancel(spid) {
  if (Date.now() < (S.cancelTrust || 0)) { doCancel(spid); return; }
  const r = curRow(spid) || {};
  modal(`<div class="dlg" style="width:460px"><div class="dh"><h2>${t("Отменить запрос сессии {n}?", {n: spid})}</h2><span class="note">${h([r.login, r.host, r.program].filter(Boolean).join(" · "))}. ${t("Текущий запрос прервется с ошибкой, сессия останется; если запрос был в транзакции, программе придется ее откатить. Следующие 10 с отмена выполняется без вопроса.")}</span></div>
    <div class="df"><a class="btn pri" onclick="closeModal()">${t("Отмена")}</a><a class="btn dark" style="color:#FFF" onclick="closeModal();doCancel(${spid})">${t("Отменить запрос")}</a></div></div>`);
}
async function doCancel(spid) {
  S.cancelTrust = Date.now() + KILL_TRUST_MS;
  try { await api("cancel_query", spid); toast(t("Запрос сессии {n} отменен", {n: spid})); curLoad(); } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- разделы «Нагрузки сервера» и «Базы данных»
// Раздел - сворачиваемая карточка (ключ свернутости "s-<раздел>"): название и мелко-бледно - откуда данные.
// Свернутый раздел не запрашивается: данные - при разворачивании (card._render) и по «Обновить» (только открытые).
const HEAVY_METRICS = [["cpu", "CPU всего"], ["cpu_avg", "CPU на выполнение"], ["time", "Время всего"], ["time_avg", "Время на выполнение"],
  ["max_time", "Наибольшее время"], ["reads", "Чтений всего"], ["reads_avg", "Чтений на выполнение"], ["writes", "Записей всего"], ["execs", "Выполнений"]];
const HEAVY_HOT = {cpu: "cpu", cpu_avg: "cpu_avg", time: "time", time_avg: "time_avg", max_time: "max_time", reads: "reads", reads_avg: "reads_avg", writes: "writes", execs: "execs"};
function dbms() { return S.st.dbms || {heavy_orders: HEAVY_METRICS.map(x => x[0]), heavy_hours: true, absent: {}, load_by_db: []}; }
const absentCols = (kind, cols) => cols.filter(c => !(dbms().absent[kind] || []).includes(c[0]));   // колонки без данных у СУБД
const isPg = () => dbms().name === "PostgreSQL";
// [название, пояснение MS SQL Server, пояснение PostgreSQL]
const SECS = {
  heavy: ["Тяжелые запросы", "статистика кэша планов sys.dm_exec_query_stats", "статистика запросов pg_stat_statements"],
  waits: ["Ожидания", "ожидания всего сервера sys.dm_os_wait_stats, без фоновых", "выборка активных сессий pg_stat_activity раз в 100 мс"],
  io: ["Ввод-вывод", "чтения и записи файлов баз sys.dm_io_virtual_file_stats", "чтения и записи по процессам pg_stat_io, с PostgreSQL 16"],
  space: ["Место", "файлы базы и свободное место на дисках sys.database_files, sys.dm_os_volume_stats", "размер баз и WAL pg_database_size, pg_replication_slots"],
  tables: ["Таблицы", "размеры и обращения sys.allocation_units, sys.dm_db_index_usage_stats", "размеры (оценка по pg_class) и обращения pg_stat_user_tables"],
  functions: ["Функции и процедуры", "статистика кэша планов sys.dm_exec_procedure_stats, sys.dm_exec_function_stats", "статистика функций pg_stat_user_functions, только при track_functions"],
  temp: ["Временные данные", "занятое сессиями в tempdb sys.dm_db_session_space_usage, sys.dm_db_task_space_usage", "временные файлы сессий pg_ls_tmpdir, pg_stat_database"],
};
// все свернуты, пока пользователь не открыл раздел; открыт не больше одного (tcolToggle)
const secOpen = k => !tcolOn("sec-" + k, true);
function secCard(k, inner) {
  const [title, ms, pg] = SECS[k];
  return `<section class="card tw show sec${tcolCls("sec-" + k, true)}" id="sec-${k}">${tcolBtn("sec-" + k)}<div class="tbar"><h2>${t(title)}</h2><span class="secn">(${h(t(isPg() ? pg : ms))})</span><span class="lbl" id="${k}-cnt"></span></div>${inner}</section>`;
}
function secHooks(load) {       // разворачивание раздела без данных - запрос
  for (const k of Object.keys(S.live.secs)) { const c = $("#sec-" + k); if (c) c._render = () => { if (!S.live.secs[k].data) load([k]); }; }
}
const secBody = k => $("#" + k + "-body");
const secWait = (k, text) => { const b = secBody(k); if (b) b.innerHTML = `<div class="empty"><span class="pulse"></span> ${text}</div>`; };
function secErr(k, err) {
  secBody(k).innerHTML = `<div class="empty">${t("Не удалось получить данные: {err}", {err: h(err)})}</div>`;
  $("#" + k + "-cnt").textContent = "";
}
function secOpenScroll(k) {      // развернуть раздел (если свернут) и прокрутить к нему
  const c = $("#sec-" + k);
  if (!c) return;
  if (c.classList.contains("tcl")) c.querySelector(".tcol").click();
  c.scrollIntoView({behavior: "smooth", block: "start"});
}
const mbCell = (v, cls = "", pre = "") => `<td class="n${cls}">${pre}${v == null ? "" : nf(v)}${v >= 1024 ? `<span class="sv">${nf(Math.round(v / 102.4) / 10)} ${t("ГБ")}</span>` : ""}</td>`;
const numCell = (v, cls = "") => `<td class="n${cls}">${v == null ? "" : nf(v)}</td>`;
// значок-подсказка: на что обратить внимание (только то, что верно почти для любого сервера)
const warnIco = text => `<span class="warn" title="${h(text)}">${I.warn(14)}</span>`;
const WARN = {
  get unusedIdx() { return t("Индекс не читался с перезапуска сервера (или сброса статистики), но обновляется при каждом изменении таблицы: возможно, он только нагружает сервер. Перед удалением убедитесь, что сервер работает давно и индекс не нужен редким отчетам."); },
  get heap() { return t("Большая куча — таблица без кластерного индекса: строка, которая выросла при изменении, переносится, и чтение идет через ссылку на новое место; место после удаления строк часто не освобождается. Обычно таблице нужен кластерный индекс."); },
  get scan() { return t("Таблица больше 100 МБ чаще читается полным просмотром, чем поиском по индексу: возможно, частым запросам не хватает индекса (тяжелые запросы с таблицей — кнопка в начале строки)."); },
  get dead() { return t("Мертвых строк больше 20%: autovacuum не успевает или его держит долгая транзакция; таблица и индексы занимают лишнее место и читаются медленнее."); },
  get emptyCol() { return t("По статистике ANALYZE столбец пуст (NULL) во всех строках."); },
  get growPct() { return t("Прирост в процентах: у большого файла каждый прирост большой и долгий, а размер следующего не угадать. Обычно задают прирост в МБ."); },
  get growLog() { return t("Маленький прирост журнала у большого файла: каждый прирост добавляет виртуальные журналы (VLF), и их тысячи — дольше восстановление и запуск базы."); },
  get growData() { return t("Маленький прирост у большого файла: файл растет часто, и каждый прирост — ожидание для запросов, которые пишут."); },
  get low() { return t("Можно занять еще меньше 1 ГБ или меньше 10% размера: база скоро упрется в предел файла или в диск."); },
  get slot() { return t("Неактивный слот репликации: сервер хранит WAL, пока слот его не прочитает, и папка WAL растет, пока не кончится место."); },
  get slowRead() { return t("Чтение дольше 20 мс на операцию: диск не успевает (или его делят с другими)."); },
  get slowData() { return t("Запись файла данных дольше 20 мс на операцию: диск не успевает."); },
  get slowLog() { return t("Запись журнала дольше 5 мс на операцию: каждая фиксация транзакции ждет диск."); },
  get lowHit() { return t("Меньше 90% страниц найдено в кэше: данные часто читаются с диска — мал shared_buffers или много полных просмотров больших таблиц."); },
  get selfWrite() { return t("Клиентские процессы сами пишут страницы на диск: фоновая запись (bgwriter, checkpointer) не успевает, и запросы ждут записи."); },
};
// число с подсказкой: warn - текст (тогда красным со значком) или false
const warnNum = (v, warn, cls = "") => `<td class="n${warn ? " hotv b" : cls}">${warn ? warnIco(warn) : ""}${v == null ? "" : nf(v)}</td>`;
const GROW_SMALL_MB = 64, ROW_BYTES_MIN = 1000, SCAN_MIN = 5;     // маленький прирост у файла от 1 ГБ; байт на строку - от 1000 строк
const rbCell = r => `<td class="n"${r.rb == null ? "" : ` title="${t("Занятые страницы на строку: данные {d} байт, индексы {i} байт. Оценка роста: столько займет каждая новая строка с похожими данными", {d: nf(r.data_row_bytes), i: nf(r.row_bytes - r.data_row_bytes)}) + (isPg() ? " " + t("(у PostgreSQL в индексы входит и TOAST)") : "")}"`}>${r.rb == null ? "" : nf(r.rb)}</td>`;
const tsCell = v => `<td class="mono pale">${h((v || "").slice(0, 16))}</td>`;
const pct = x => nf(Math.round(x * 1000) / 10) + "%";
const fileType = x => ({ROWS: t("данные"), LOG: t("лог")})[x] || x || "";
const bareName = x => String(x || "").replace(/\(.*$/, "").split(".").pop().replace(/"/g, "");   // dbo.T, s.f(integer) -> T, f
// колонки, пустые во всех строках, не показываются (счетчика нет у СУБД или нет данных); c[5] - показывать всегда
const filled = (cols, rows) => cols.filter(c => !c[0] || c[5] || rows.some(r => r[c[0]] != null && r[c[0]] !== ""));
function hlRow(body) {       // подсвеченная строка (переход с другого экрана) - в видимую часть
  const tr = body.querySelector("tr.hl");
  if (tr) setTimeout(() => tr.scrollIntoView({block: "center"}), 60);
}
// базы для выбора: список с сервера; выбранная остается, даже если ее нет в списке. Возвращает имя выбранной
// так, как его пишет сервер (регистр)
async function dbOptions(sel, cur, all) {
  const fill = list => {
    const names = [...new Set([...(cur ? [cur] : []), ...list])];
    sel.innerHTML = (all ? `<option value=""${cur ? "" : " selected"}>${t("Все")}</option>` : "") +
      names.map(x => `<option value="${h(x)}"${x === cur ? " selected" : ""}>${h(x)}</option>`).join("");
    if (sel.classList.contains("flt")) fltMark(sel);
  };
  fill([]);
  try {
    const list = await api("databases");
    cur = list.find(x => cur && x.toLowerCase() === cur.toLowerCase()) || cur;
    fill(list);
  } catch (e) { /* список не получен - только выбранная */ }
  return cur;
}
const connDb = () => (S.st.connection || {}).database || "";
const selHtml = (id, opts, val, on, cls = "") => `<select class="inp${cls}" id="${id}"${on ? ` onchange="${on}"` : ""}>${opts.map(([k, lbl]) => `<option value="${k}"${String(k) === String(val) ? " selected" : ""}>${t(lbl)}</option>`).join("")}</select>`;
const flHtml = (id, ph) => `<span class="fl">${I.search(15)}<input id="${id}" placeholder="${t(ph)}">${FLX}</span>`;
const ibHtml = (title, on, icon, extra = "") => `<span class="ib${extra}" title="${h(title)}" onclick="${on}">${icon}</span>`;
const goJs = v => h(`go(${JSON.stringify(v)})`);

// ---------------------------------------------------------------- нагрузка сервера (§5.21)
// Тяжелые запросы, ожидания и ввод-вывод. Замер за интервал - один вызов server_load: первые снимки, замер
// ожиданий (он же пауза), вторые снимки - все открытые разделы за одни и те же секунды. Накопленное - разделы
// по отдельности, каждый показывается, как только готов (ожидания PostgreSQL - всегда замер, 10 с).
function viewLoad(m, v) {
  const d = dbms(), metrics = HEAVY_METRICS.filter(x => d.heavy_orders.includes(x[0]));
  const o = S.load ||= {db: null, interval: 0, order: null, hours: 0, top: 100};
  if (o.db === null) o.db = connDb();
  if (v.db !== undefined) o.db = v.db;
  if (!d.heavy_orders.includes(o.order)) o.order = d.heavy_orders[0];      // первый показатель СУБД
  if (!d.heavy_hours) o.hours = 0;
  m.innerHTML = `
    <header class="head"><div style="display:flex;flex-direction:column;gap:8px">${backLine()}<h1>${t("Нагрузка сервера")}</h1>
      <span class="lbl">${t("что нагружает сервер: запросы, ожидания, диски · запросы к статистике сервера — при открытии раздела и по кнопке «Обновить»")}</span></div></header>
    <section class="card" style="padding:14px 20px;display:flex;flex-wrap:wrap;align-items:flex-end;gap:16px">
      <label class="field"><span class="lbl">${t("База данных")}</span><select class="inp flt" id="ld-db" onchange="S.load.db=this.value;loadRefresh()"></select></label>
      <label class="field" title="${t("Два снимка статистики с паузой и их разница: что нагружало сервер именно за эти секунды")}"><span class="lbl">${t("Период")}</span>${selHtml("ld-int", [[0, "накоплено с перезапуска или сброса статистики"], [10, "замер за 10 с"], [30, "замер за 30 с"], [60, "замер за 60 с"]], o.interval, "loadRefresh()")}</label>
      <a class="btn pri" onclick="loadRefresh()">${I.refresh(16)}${t("Обновить")}</a>
      <span class="pale" style="font-size:12px;margin-left:auto;max-width:380px">${t("Замер за интервал: все открытые разделы — за одни и те же секунды.")}${d.heavy_interval ? "" : " " + t("Тяжелые запросы MS SQL Server — по своему отбору «Выполнялись».")}</span></section>
    ${secCard("heavy", `<div class="flts">
        <label class="field"><span class="lbl">${t("Сортировать по")}</span>${selHtml("hv-order", metrics, o.order, "loadRefresh(['heavy'])")}</label>
        ${d.heavy_hours ? `<label class="field"><span class="lbl">${t("Выполнялись")}</span>${selHtml("hv-hours", [[0, "за все время в кэше"], [1, "за последний час"], [24, "за последние сутки"], [168, "за последнюю неделю"]], o.hours, "loadRefresh(['heavy'])", " flt")}</label>` : ""}
        <label class="field" style="flex:0 1 110px;min-width:90px"><span class="lbl">${t("Сколько")}</span>${selHtml("hv-top", [[50, "50"], [100, "100"], [200, "200"]], o.top, "loadRefresh(['heavy'])")}</label>
        ${flHtml("hv-flt", "Фильтр: объект, база, текст")}</div>
      <div class="acts">${colsBtn("heavy", "S.live.heavy")}</div><div class="tscroll" id="heavy-body"></div>`)}
    ${secCard("waits", `<div id="waits-bar"></div><div class="acts">${colsBtn("waits", "S.live.waits")}</div><div class="tscroll" id="waits-body"></div>`)}
    ${secCard("io", `<div class="flts">${flHtml("io-flt", isPg() ? "Фильтр: процесс, объект, контекст" : "Фильтр: база, файл, путь")}
        <span class="popt" style="align-self:center" onclick="S.live.io.slow=!S.live.io.slow;this.firstChild.classList.toggle('on');ioRender()"><span class="sw"></span>${t(isPg() ? "Только проблемные" : "Только медленные")}</span></div>
      <div class="acts">${colsBtn("io", "S.live.io")}</div><div class="tscroll" id="io-body"></div>`)}`;
  S.live.heavy = {sort: null, filter: (v.filter || "").toLowerCase(), render: heavyRender};
  S.live.waits = {sort: null, render: waitsRender};
  S.live.io = {sort: null, filter: "", slow: false, render: ioRender};
  S.live.secs = {heavy: S.live.heavy, waits: S.live.waits, io: S.live.io};
  $("#hv-flt").value = v.filter || "";
  $("#hv-flt").addEventListener("input", e => { S.live.heavy.filter = e.target.value.trim().toLowerCase(); heavyRender(); });
  $("#io-flt").addEventListener("input", e => { S.live.io.filter = e.target.value.trim().toLowerCase(); ioRender(); });
  dbOptions($("#ld-db"), o.db, true).then(x => { if (x && o.db && x.toLowerCase() === o.db.toLowerCase()) o.db = x; });
  fltMarks(m);
  secHooks(loadRefresh);
  loadRefresh();
  if (v.filter) secOpenScroll("heavy");
}
async function loadRefresh(only) {
  const o = S.load, secs = S.live.secs, d = dbms();
  if (!secs || !$("#ld-int")) return;
  o.interval = +$("#ld-int").value; o.order = $("#hv-order").value; o.top = +$("#hv-top").value;
  o.hours = $("#hv-hours") ? +$("#hv-hours").value : 0;
  const n = o.interval;
  if (n && d.heavy_interval && o.order === "max_time") { o.order = "time"; $("#hv-order").value = "time"; toast(t("Наибольшее время за интервал не считается — сортировка по времени")); }
  const parts = (only || ["heavy", "waits", "io"]).filter(secOpen);
  if (!parts.length) return;
  for (const k of parts) {
    const measure = k === "waits" ? n || !d.waits_total : k === "heavy" ? n && d.heavy_interval : n;
    secWait(k, measure ? t("Замер за {n} с…", {n: n || 10}) : t("Запрос к статистике сервера…"));
  }
  const tokens = Object.fromEntries(parts.map(k => [k, secs[k].token = {}]));     // ответ после нового «Обновить» не нужен
  await Promise.all((n ? [parts] : parts.map(k => [k])).map(async g => {
    let res;
    try { res = await api("server_load", g, o.db, n, o.order, o.hours, o.top); } catch (e) { res = Object.fromEntries(g.map(k => [k, {err: String(e.message || e)}])); }
    if (S.live.secs !== secs) return;
    for (const k of g) if (secs[k].token === tokens[k]) { secs[k].data = res[k] || {err: "—"}; secs[k].db = o.db; secs[k].sort = null; secs[k].render(); }
  }));
}
function heavyRender() {
  const L = S.live.heavy, body = secBody("heavy"), D = L.data;
  if (!body || !D) return;
  if (D.err) return secErr("heavy", D.err);
  const avg = (r, k) => r.execs ? Math.round(r[k] / r.execs) : null;
  const rows = L.rows = D.rows.map((r, i) => Object.assign(r, {i, cpu_avg: avg(r, "cpu"), time_avg: avg(r, "time"), reads_avg: avg(r, "reads"), rows_avg: avg(r, "rows")}));
  const shown = rows.filter(r => srvMatch(r, L.filter, ["db", "object", "statement"]));
  $("#heavy-cnt").textContent = (shown.length !== rows.length ? t("{n} из {of}", {n: shown.length, of: rows.length}) : String(shown.length)) +
    (D.seconds ? " · " + t("за последние {n} с", {n: D.seconds}) : "") +
    (L.db ? " · " + (isPg() ? t("база {db}", {db: L.db}) : t("база {db}: среди самых тяжелых запросов всего сервера", {db: L.db})) : "");
  const cols = absentCols("heavy", [
    [null, "", null, r => `<td class="acts2"><span class="ib" title="${t("Показать текст запроса")}" onclick="heavyText(${r.i})">${I.note(14)}</span>${r.plan_handle ? `<span class="ib" title="${t("Открыть план запроса")}" onclick="heavyPlan(${r.i})">${I.plan(14)}</span>` : ""}</td>`],
    ["object", "Оператор", "", r => opCell(r.object, r.object ? r.line : 0, r.statement)],
    ["db", "База", "", r => `<td>${h(r.db || "")}</td>`],
    ["execs", "Выпол-<br>нений", "n", r => `<td class="n">${nf(r.execs)}</td>`],
    ["cpu", "CPU всего<br>мс", "n", r => msCell(r.cpu)],
    ["cpu_avg", "CPU на<br>выполнение мс", "n", r => msCell(r.cpu_avg)],
    ["time", "Время всего<br>мс", "n", r => msCell(r.time)],
    ["time_avg", "Время на<br>выполнение мс", "n", r => msCell(r.time_avg)],
    ["max_time", "Наибольшее<br>время мс", "n", r => msCell(r.max_time)],
    ["reads", "Чтений<br>всего", "n", r => `<td class="n">${nf(r.reads)}</td>`],
    ["reads_avg", "Чтений на<br>выполнение", "n", r => `<td class="n">${nf(r.reads_avg)}</td>`],
    ["writes", "Записей<br>всего", "n", r => `<td class="n">${nf(r.writes)}</td>`],
    ["rows_avg", "Строк на<br>выполнение", "n", r => `<td class="n">${nf(r.rows_avg)}</td>`],
    ["last", "Последнее<br>выполнение", "", r => `<td class="mono">${h((r.last || "").slice(5, 16))}</td>`],
    ["created", "В кэше с", "", r => `<td class="mono pale">${h((r.created || "").slice(5, 16))}</td>`],
  ]);
  L.hot = HEAVY_HOT[S.load.order];
  body.innerHTML = shown.length ? srvTable("heavy", cols, shown) : `<div class="empty">${rows.length ? t("Нет строк по фильтру") : t("Статистики нет")}</div>`;
  hbar(body);
}
function heavyText(i) { const r = S.live.heavy.rows[i]; textDialog(`${r.object || t("Запрос (ad hoc)")}${r.object && r.line ? ":" + r.line : ""}`, r.text || r.statement, `heavy_${i + 1}`, null, r.db); }
function heavyPlan(i) { const r = S.live.heavy.rows[i]; api("open_plan", r.plan_handle, r.start, r.end, `heavy_${i + 1}`).catch(fail); }
function heavyBy(order) {        // из ожиданий диска: тяжелые запросы по чтениям
  $("#hv-order").value = order;
  secOpenScroll("heavy");
  loadRefresh(["heavy"]);
}

// группы ожиданий для полосы долей (waitCat; §5.3)
// [группа, подпись, первая строка подсказки легенды]
const WAIT_GROUPS = [["lock", "Блокировки", "Ожидания блокировок: другая сессия держит строку или таблицу"],
  ["disk", "Диск", "Ожидания дисковой системы: чтение страниц, запись журнала"],
  ["cpu", "CPU", "Процессор: работа запроса и очередь к процессору"],
  ["net", "Клиент", "Ожидание клиента: программа забирает результат"],
  ["mem", "Память", "Ожидание выделения памяти запросу"],
  ["par", "Параллелизм", "Потоки параллельного запроса ждут друг друга"],
  ["page", "Страницы", "Ожидание доступа к страницам в памяти: одну страницу меняют одновременно"],
  ["oth", "Прочее", "Прочие ожидания"]];
const WAIT_TIP_MAX = 15;          // строк ожиданий в подсказке группы
function waitTip(rows, k, tip, total) {     // подсказка группы: что в нее входит, по убыванию времени
  const list = rows.filter(r => r.cat === k).sort((a, b) => b.time - a.time);
  return [t(tip), ...list.slice(0, WAIT_TIP_MAX).map(r => `${r.wait} — ${pct(r.time / total)}`),
    ...(list.length > WAIT_TIP_MAX ? [t("и еще {n}", {n: list.length - WAIT_TIP_MAX})] : [])].join("\n");
}
// Полоса долей ожиданий (§5.29) и легенда под ней: «Нагрузка сервера», реестры операторов, идущие запуск и
// наблюдение, сравнения. На странице - в одном месте (копии с тем же значением путали бы). items -
// [{wait, cat, time}] (cat - группа WAIT_GROUPS). В начале легенды жирно - доля и время всех ожиданий
// (все, кроме CPU). opts.scale (0..1) - доля ширины: две полосы в одном масштабе (сравнение, меньше
// времени - короче); opts.icon - значок перед полосой (чей запуск).
function waitBarHtml(items, opts = {}) {
  const sums = {}, total = items.reduce((a, r) => a + r.time, 0);
  if (!(total > 0)) return "";
  for (const r of items) sums[r.cat] = (sums[r.cat] || 0) + r.time;
  const groups = WAIT_GROUPS.filter(([k]) => sums[k]), waited = total - (sums.cpu || 0);
  const tip = (k, n, d) => h(t(n) + " " + pct(sums[k] / total) + "\n" + waitTip(items, k, d, total));
  const html = `<div class="wbar"${opts.scale != null ? ` style="width:${Math.max(2, opts.scale * 100)}%"` : ""}>${groups.map(([k, n, d]) => `<span class="g-${k}" style="flex:${sums[k]}" title="${tip(k, n, d)}"></span>`).join("")}</div>
    <div class="wleg"><span class="wsum" title="${t("Все ожидания, кроме CPU: доля от всего времени и время")}">${t("Ожидания {p}", {p: pct(waited / total)})} · =${clock(waited)}</span>${groups.map(([k, n, d]) => `<span title="${h(waitTip(items, k, d, total))}"><i class="g-${k}"></i>${t(n)} <b>${pct(sums[k] / total)}</b></span>`).join("")}</div>`;
  return opts.icon ? `<div class="wrow">${opts.icon}<div class="wtrk">${html}</div></div>` : html;
}
const waitTotal = items => items.reduce((a, r) => a + r.time, 0);
// Ожидания реестра операторов (строки registry.csv): CPU, блокировки, клиент и ожидания ресурсов по их
// 1-3 местам у каждого оператора; остаток «Ожидания ресурсов» сверх трех мест - «прочие»
function regWaitItems(rows) {
  const m = new Map(), add = (wait, cat, ms) => {
    if (!(ms > 0)) return;
    const x = m.get(cat + "\n" + wait) || m.set(cat + "\n" + wait, {wait, cat, time: 0}).get(cat + "\n" + wait);
    x.time += ms;
  };
  for (const r of rows || []) {
    add("CPU", "cpu", +r["CPU мс"] || 0);
    add(t("Ожидание блокировок"), "lock", +r["Ожидание блокировок мс"] || 0);
    add(t("Ожидание клиента"), "net", +r["Ожидание клиента мс"] || 0);
    let rest = +r["Ожидание ресурсов мс"] || 0;
    for (const k of [1, 2, 3]) {
      const w = /^(.*) \((\d+) мс\)$/.exec(r[`Ожидание ресурсов ${k} место`] || "");
      if (w) { add(w[1], waitCat(w[1]), +w[2]); rest -= +w[2]; }
    }
    add(t("прочие ожидания ресурсов (после 3 мест оператора)"), "oth", rest);
  }
  return [...m.values()];
}
// Ожидания идущего запуска по событиям (--profile): время между событиями statement/wait/idle - по состоянию
// в начале отрезка (ожидание или работа = CPU); простой сессии и время между прогонами не считаются.
// end - конец последнего отрезка (сейчас или конец процесса).
// полоса идущего запуска по событиям: время от события до следующего - по состоянию в начале отрезка
// (ожидание или CPU), простой и между прогонами - не считаются. Копится при получении (evAdd, waitFold):
// события операторов в памяти хранятся не все.
function waitAdd(m, w, ms) {
  if (!(ms > 0)) return;
  const name = w || "CPU", x = m.get(name) || m.set(name, {wait: name, cat: w ? waitCat(w) : "cpu", time: 0}).get(name);
  x.time += ms;
}
function waitFold(a, e) {
  if (!["statement", "wait", "idle", "pass"].includes(e.event)) return;
  const at = evMs(e);
  if (a.cur !== null) waitAdd(a.m, a.cur, at - a.t0);
  a.cur = e.event === "idle" || e.event === "pass" ? null : (e.wait || "");
  a.t0 = at;
}
function evWaitItems(p, end) {
  const a = p.wacc;
  if (!a) return [];
  const m = new Map([...a.m].map(([k, x]) => [k, {...x}]));
  if (a.cur !== null) waitAdd(m, a.cur, end - a.t0);
  return [...m.values()];
}
function waitsRender() {
  const L = S.live.waits, body = secBody("waits"), D = L.data;
  if (!body || !D) return;
  if (D.err) { $("#waits-bar").innerHTML = ""; return secErr("waits", D.err); }
  const pg = isPg(), all = L.db && !dbms().load_by_db.includes("waits");
  const rows = L.rows = D.rows.map((r, i) => Object.assign(r, {i, cat: waitCat(r.wait)}));
  $("#waits-cnt").textContent = (pg ? t("за {n} с: выборок {k}, в среднем активных сессий {a}; время — оценка по выборкам", {n: D.seconds, k: nf(D.samples), a: nf(D.active)})
    : D.seconds ? t("за {n} с, всего {ms} мс", {n: D.seconds, ms: nf(D.total)}) : t("накоплено с перезапуска сервера, всего {ms} мс", {ms: nf(D.total)})) +
    (all ? " · " + t("весь сервер: отбора по базе нет") : L.db ? " · " + t("база {db}", {db: L.db}) : "");
  $("#waits-bar").innerHTML = waitBarHtml(rows);
  const cols = filled([
    [null, "", null, r => `<td class="acts2">${waitActs(r)}</td>`],
    ["wait", "Ожидание", "", r => `<td>${waitHtml(r.wait)}</td>`],
    ["cat", "Группа", "", r => `<td>${t((WAIT_GROUPS.find(g => g[0] === r.cat) || [0, "Прочее"])[1])}</td>`],
    ["time", pg ? "Время мс<br>(оценка)" : "Время<br>мс", "n", r => msCell(r.time)],
    ["share", "Доля<br>%", "n", r => `<td class="n"><span class="shr"><i style="width:${Math.min(100, r.share)}%"></i></span>${nf(r.share)}</td>`],
    ["tasks", "Ожида-<br>ний", "n", r => numCell(r.tasks)],
    ["signal", "Из них сигнал мс<br>(очередь к CPU)", "n", r => msCell(r.signal)],
    ["sessions", "Сессий", "n", r => numCell(r.sessions)],
    ["db", "База", "", r => `<td>${h(r.db || "")}</td>`],
    ["statement", "Самый частый запрос", "", r => `<td class="mono clip wide" title="${h(r.statement || "")}">${h((r.statement || "").slice(0, 200))}</td>`],
  ], rows);
  L.hot = "time";
  body.innerHTML = rows.length ? srvTable("waits", cols, rows) : `<div class="empty">${t("Ожиданий не было")}</div>`;
  hbar(body);
}
function waitActs(r) {
  let s = "";
  if (r.cat === "lock") s += ibHtml(t("К экрану «Текущие запросы», сначала блокирующие"), goJs({k: "current", sort: "blocks"}), I.pulse(14));
  if (r.cat === "disk") s += ibHtml(t("К таблице «Ввод-вывод»"), "secOpenScroll('io')", I.db(14)) + ibHtml(t("К таблице «Тяжелые запросы», сортировка «Чтений всего»"), "heavyBy('reads')", I.flame(14));
  if (isPg() && r.wait !== "CPU") s += ibHtml(t("К экрану «Текущие запросы», фильтр по этому ожиданию"), goJs({k: "current", filter: r.wait}), I.eye(14));
  return s;
}
function ioRender() {
  const L = S.live.io, body = secBody("io"), D = L.data;
  if (!body || !D) return;
  if (D.err) return secErr("io", D.err);
  const pg = isPg(), r10 = x => Math.round(x * 10) / 10;
  const rows = L.rows = D.rows.map((r, i) => {
    Object.assign(r, {i});
    if (pg) {
      const all = (r.reads || 0) + (r.hits || 0);
      r.hit_pct = all ? r10(100 * (r.hits || 0) / all) : null;
      // только обычная работа с общим кэшем: bulkread, bulkwrite, vacuum идут через свое маленькое кольцо буферов,
      // временные таблицы пишет сам процесс - это не проблема
      const usual = r.object === "relation" && r.context === "normal";
      r.low_hit = usual && all > 1000 && r.hit_pct < 90;
      r.self_write = usual && r.backend === "client backend" && r.writes > 0;     // обычно грязные страницы пишут фоновые процессы
      r.bad = r.low_hit || r.self_write;
    } else {
      r.read_avg = r.reads ? r10(r.read_ms / r.reads) : null;
      r.write_avg = r.writes ? r10(r.write_ms / r.writes) : null;
      r.slow_read = r.type !== "LOG" && r.read_avg > 20;
      r.slow_write = r.type === "LOG" ? r.write_avg > 5 : r.write_avg > 20;
      r.bad = r.slow_read || r.slow_write;
    }
    return r;
  });
  const shown = rows.filter(r => (!L.slow || r.bad) && srvMatch(r, L.filter, pg ? ["backend", "object", "context"] : ["db", "file", "path"]));
  $("#io-cnt").textContent = (shown.length !== rows.length ? t("{n} из {of}", {n: shown.length, of: rows.length}) : String(shown.length)) + " · " +
    (D.seconds ? t("за {n} с", {n: D.seconds}) : pg ? t("с последнего сброса статистики") : t("с перезапуска сервера")) +
    (L.db ? " · " + (pg ? t("весь сервер: в pg_stat_io нет деления по базам") : t("база {db}", {db: L.db})) : "") + (D.note ? " · " + D.note : "");
  const cols = filled(pg ? [
    ["backend", "Процесс", "", r => `<td>${h(r.backend)}</td>`],
    ["object", "Объект", "", r => `<td>${h(r.object)}</td>`],
    ["context", "Контекст", "", r => `<td>${h(r.context)}</td>`],
    ["reads", "Чтений", "n", r => numCell(r.reads)],
    ["hits", "Из кэша", "n", r => numCell(r.hits)],
    ["hit_pct", "Доля<br>кэша %", "n", r => warnNum(r.hit_pct, r.low_hit && WARN.lowHit)],
    ["read_ms", "Чтение<br>мс", "n", r => msCell(r.read_ms)],
    ["writes", "Записей", "n", r => warnNum(r.writes, r.self_write && WARN.selfWrite)],
    ["write_ms", "Запись<br>мс", "n", r => msCell(r.write_ms)],
    ["extends", "Расши-<br>рений", "n", r => numCell(r.extends)],
    ["evictions", "Вытес-<br>нений", "n", r => numCell(r.evictions)],
    ["fsyncs", "fsync", "n", r => numCell(r.fsyncs)],
  ] : [
    [null, "", null, r => `<td class="acts2">${ibHtml(t("К экрану «База данных», таблица «Место»: файлы базы {db}", {db: r.db}), goJs({k: "dbinfo", db: r.db, hl: r.file}), I.db(14))}</td>`],
    ["db", "База", "", r => `<td>${h(r.db)}</td>`],
    ["file", "Файл", "", r => `<td class="b">${h(r.file)}</td>`],
    ["type", "Тип", "", r => `<td>${h(fileType(r.type))}</td>`],
    ["read_avg", "Чтение<br>мс на операцию", "n", r => warnNum(r.read_avg, r.slow_read && WARN.slowRead, " b")],
    ["write_avg", "Запись<br>мс на операцию", "n", r => warnNum(r.write_avg, r.slow_write && (r.type === "LOG" ? WARN.slowLog : WARN.slowData), " b")],
    ["reads", "Чтений", "n", r => numCell(r.reads)],
    ["read_mb", "Прочитано<br>МБ", "n", r => mbCell(r.read_mb)],
    ["read_ms", "Ожидание<br>чтения мс", "n", r => msCell(r.read_ms)],
    ["writes", "Записей", "n", r => numCell(r.writes)],
    ["write_mb", "Записано<br>МБ", "n", r => mbCell(r.write_mb)],
    ["write_ms", "Ожидание<br>записи мс", "n", r => msCell(r.write_ms)],
    ["stall", "Ожидание<br>всего мс", "n", r => msCell(r.stall)],
    ["path", "Путь", "", r => `<td class="mono pale clip" title="${h(r.path)}">${h(r.path)}</td>`],
  ], rows);
  L.hot = pg ? null : "read_avg";
  body.innerHTML = shown.length ? srvTable("io", cols, shown) : `<div class="empty">${rows.length ? t("Нет строк по фильтру") : t("Чтений и записей не было")}</div>`;
  hbar(body);
}

// ---------------------------------------------------------------- база данных (§5.28)
// Место, таблицы (строка раскрывается - индексы), функции и процедуры выбранной базы и временные данные
// сервера. Только каталог и статистика сервера: данные таблиц не читаются.
function viewDbInfo(m, v) {
  const o = S.dbi ||= {db: null};
  if (v.db) o.db = v.db;
  if (!o.db) o.db = connDb();
  const pg = isPg();
  m.innerHTML = `
    <header class="head"><div style="display:flex;flex-direction:column;gap:8px">${backLine()}<h1>${t("База данных")}</h1>
      <span class="lbl">${t("место, таблицы, функции и временные данные · только каталог и статистика сервера, данные таблиц не читаются")}</span></div></header>
    <section class="card" style="padding:14px 20px;display:flex;flex-wrap:wrap;align-items:flex-end;gap:16px">
      <label class="field"><span class="lbl">${t("База данных")}</span><select class="inp" id="dbi-db" onchange="S.dbi.db=this.value;dbRefresh(['space','tables','functions'])"></select></label>
      <a class="btn pri" onclick="dbRefresh()">${I.refresh(16)}${t("Обновить")}</a>
      <span class="pale" style="font-size:12px;margin-left:auto;max-width:380px">${t("Запросы — при открытии раздела и по кнопке «Обновить». Временные данные — всего сервера.")}</span></section>
    ${secCard("space", `<div class="secsum" id="space-sum"></div><div class="acts">${colsBtn("space", "S.live.space")}</div><div class="tscroll" id="space-body"></div>`)}
    ${secCard("tables", `<div class="flts">${flHtml("tb-flt", pg ? "Фильтр: таблица, схема, табличное пространство" : "Фильтр: таблица, схема, файловая группа")}
        <label class="field" style="flex:0 1 150px"><span class="lbl">${t("Размер")}</span>${selHtml("tb-size", [[0, "все"], [10, "от 10 МБ"], [100, "от 100 МБ"], [1024, "от 1 ГБ"]], 0, "S.live.tables.size=+this.value;tablesRender()", " flt")}</label>
        <span class="popt" style="align-self:center" title="${t("Ни чтений, ни изменений с перезапуска сервера (или сброса статистики)")}" onclick="S.live.tables.unused=!S.live.tables.unused;this.firstChild.classList.toggle('on');tablesRender()"><span class="sw"></span>${t("Не использовались")}</span></div>
      <div class="acts">${colsBtn("tables", "S.live.tables")}</div><div class="tscroll" id="tables-body"></div>`)}
    ${secCard("functions", `<div class="flts">${flHtml("fn-flt", "Фильтр: объект, схема")}</div><div class="acts">${colsBtn("functions", "S.live.functions")}</div><div class="tscroll" id="functions-body"></div>`)}
    ${secCard("temp", `<div class="secsum" id="temp-sum"></div><div class="acts">${colsBtn("temp", "S.live.temp")}</div><div class="tscroll" id="temp-body"></div><div id="temp-more"></div>`)}`;
  S.live.space = {sort: null, hl: v.hl, render: spaceRender};
  S.live.tables = {sort: {k: "total_mb", dir: -1}, filter: "", size: 0, unused: false, open: null, sub: {}, render: tablesRender};
  S.live.functions = {sort: {k: "time", dir: -1}, filter: "", render: funcsRender};
  S.live.temp = {sort: null, hl: v.spid, render: tempRender};
  S.live.secs = {space: S.live.space, tables: S.live.tables, functions: S.live.functions, temp: S.live.temp};
  $("#tb-flt").addEventListener("input", e => { S.live.tables.filter = e.target.value.trim().toLowerCase(); tablesRender(); });
  $("#fn-flt").addEventListener("input", e => { S.live.functions.filter = e.target.value.trim().toLowerCase(); funcsRender(); });
  dbOptions($("#dbi-db"), o.db, false).then(x => { if (x && o.db && x.toLowerCase() === o.db.toLowerCase()) o.db = x; });
  secHooks(dbRefresh);
  dbRefresh();              // свернутый раздел, к которому переходим, запросится при разворачивании
  if (v.hl) secOpenScroll("space");
  if (v.spid) secOpenScroll("temp");
}
async function dbRefresh(only) {
  const o = S.dbi, secs = S.live.secs;
  if (!secs || !$("#dbi-db")) return;
  const parts = (only || ["space", "tables", "functions", "temp"]).filter(secOpen);
  for (const k of parts) secWait(k, t("Запрос к серверу…"));
  await Promise.all(parts.map(async k => {
    const token = secs[k].token = {};
    let res;
    try { res = await api("db_info", k, o.db); } catch (e) { res = {err: String(e.message || e)}; }
    if (S.live.secs !== secs || secs[k].token !== token) return;
    Object.assign(secs[k], {data: res, db: o.db});
    if (k === "tables") Object.assign(secs[k], {open: null, sub: {}});
    secs[k].render();
  }));
}
function spaceRender() {
  const L = S.live.space, body = secBody("space"), D = L.data;
  if (!body || !D) return;
  if (D.err) { $("#space-sum").innerHTML = ""; return secErr("space", D.err); }
  const pg = isPg(), low = (avail, size) => avail != null && (avail < 1024 || avail < size * 0.1);
  // порядок по умолчанию: главное сверху. MS SQL Server - данные PRIMARY, лог, остальные файловые группы;
  // PostgreSQL - выбранная база, другие базы, табличные пространства, WAL, слоты; внутри - по занятому месту
  const rank = r => pg ? (r.kind === "db" && r.name === L.db ? 0 : {db: 1, tablespace: 2, wal: 3, slot: 4}[r.kind] ?? 5)
    : r.type === "ROWS" && r.filegroup === "PRIMARY" ? 0 : r.type === "LOG" ? 1 : 2;
  const used = r => (pg ? r.size_mb : r.used_mb) || 0;
  const rows = L.rows = [...D.rows].sort((a, b) => rank(a) - rank(b) || used(b) - used(a))
    .map((r, i) => Object.assign(r, {i, low: !pg && low(r.avail_mb, r.size_mb)}));
  $("#space-sum").innerHTML = (D.summary || []).map(s => `<span class="chip ${low(s.avail_mb, s.size_mb) ? "c-diff" : "c-ok"}">${h(fileType(s.type))}: ${
    t("занято {u} из {s} МБ · можно занять еще {a}", {u: nf(s.used_mb), s: nf(s.size_mb), a: s.avail_mb == null ? t("нет данных") : nf(s.avail_mb) + " " + t("МБ")})}</span>`).join("");
  $("#space-cnt").textContent = (pg ? t("база {db} выделена; свободное место на диске средствами SQL не узнать", {db: L.db}) : t("база {db}: файлов {n}", {db: L.db, n: rows.length})) + (D.note ? " · " + D.note : "");
  const KINDS = {db: "база", tablespace: "табличное пространство", wal: "WAL", slot: "слот репликации"};
  const cols = filled(pg ? [
    ["name", "Объект", "", r => `<td class="b">${h(r.name)}</td>`],
    ["kind", "Вид", "", r => `<td>${t(KINDS[r.kind] || r.kind)}</td>`],
    ["place", "Табличное<br>пространство", "", r => `<td>${h(r.place || "")}</td>`],
    ["size_mb", "Размер<br>МБ", "n", r => mbCell(r.size_mb, r.kind === "slot" && !r.extra && r.size_mb >= 1024 ? " hotv b" : "")],
    ["extra", "", "", r => `<td>${r.kind === "wal" ? t("файлов: {n}", {n: nf(r.extra)}) : r.kind === "slot" ? (r.extra ? t("активен") : `${warnIco(WARN.slot)}<span class="hotv">${t("неактивен: WAL копится, пока слот не прочитают")}</span>`) : ""}</td>`, null, true],
  ] : [
    ["file", "Файл", "", r => `<td class="b">${h(r.file)}</td>`],
    ["filegroup", "Файловая<br>группа", "", r => `<td>${h(r.filegroup || "")}</td>`],
    ["type", "Тип", "", r => `<td>${h(fileType(r.type))}</td>`],
    ["size_mb", "Размер<br>МБ", "n", r => mbCell(r.size_mb)],
    ["used_mb", "Занято<br>МБ", "n", r => mbCell(r.used_mb)],
    ["free_mb", "Свободно<br>в файле МБ", "n", r => mbCell(r.free_mb)],
    ["growth_mb", "Прирост", "", r => `<td class="n${r.growth_pct ? " hotv" : ""}">${r.growth_pct ? warnIco(WARN.growPct) + r.growth_pct + "%" : r.growth_mb ? (r.growth_mb < GROW_SMALL_MB && r.size_mb >= 1024 ? warnIco(r.type === "LOG" ? WARN.growLog : WARN.growData) : "") + nf(r.growth_mb) + " " + t("МБ") : `<span class="pale">${t("не растет")}</span>`}</td>`, null, true],
    ["max_mb", "Предел<br>МБ", "n", r => r.max_mb == null ? `<td class="n pale">${t("без предела")}</td>` : mbCell(r.max_mb), null, true],
    ["avail_mb", "Можно занять<br>еще МБ", "n", r => r.low ? mbCell(r.avail_mb, " hotv b", warnIco(WARN.low)) : mbCell(r.avail_mb, " b")],
    ["disk", "Диск", "", r => `<td class="mono">${h(r.disk || "")}</td>`],
    ["disk_free_mb", "Свободно<br>на диске МБ", "n", r => mbCell(r.disk_free_mb)],
    ["disk_total_mb", "Размер<br>диска МБ", "n", r => mbCell(r.disk_total_mb)],
    ["path", "Путь", "", r => `<td class="mono pale clip" title="${h(r.path)}">${h(r.path)}</td>`],
  ], rows);
  L.hot = pg ? "size_mb" : "avail_mb";
  body.innerHTML = rows.length ? srvTable("space", cols, rows, r => (pg ? r.kind === "db" && r.name === L.db : L.hl && r.file === L.hl) ? ' class="hl"' : "") : `<div class="empty">${t("Нет данных")}</div>`;
  hbar(body);
  if (L.hl && !L.hlDone) { L.hlDone = true; hlRow(body); }
}
function tablesRender() {
  const L = S.live.tables, body = secBody("tables"), D = L.data;
  if (!body || !D) return;
  if (D.err) return secErr("tables", D.err);
  const pg = isPg();
  const rows = L.rows = D.rows.map(r => Object.assign(r, {
    dead_pct: pg && r.rows + r.dead > 0 ? Math.round(1000 * r.dead / (r.rows + r.dead)) / 10 : null,
    idle: pg ? !(r.reads || r.ins || r.upd || r.del) : !(r.reads || r.updates),
    many_dead: pg && r.dead > 10000 && r.rows + r.dead > 0 && r.dead / (r.rows + r.dead) > 0.2,
    // полных просмотров больше поисков, и их не единицы (SCAN_MIN)
    big_scan: r.total_mb >= 100 && (pg ? r.seq_scan > SCAN_MIN && r.seq_scan > (r.idx_scan || 0) : r.scans > SCAN_MIN && r.scans > (r.seeks || 0)),
    parts: r.partitions > 1 ? r.partitions : null,
    rb: r.rows >= ROW_BYTES_MIN ? r.row_bytes : null}));
  const shown = rows.filter(r => r.total_mb >= L.size && (!L.unused || r.idle) && srvMatch(r, L.filter, ["table", "filegroup"]));
  $("#tables-cnt").textContent = (shown.length !== rows.length ? t("{n} из {of}", {n: nf(shown.length), of: nf(rows.length)}) : nf(rows.length)) +
    " · " + t("база {db}", {db: L.db}) + " · " +
    (pg ? t("обращения — с последнего сброса статистики") : t("обращения — с перезапуска сервера"));
  const hot = on => on ? " hotv b" : "";
  const on = (id, kind) => L.open && L.open.id === id && L.open.kind === kind;
  const acts = r => `<td class="acts2">${ibHtml(t("Показать индексы таблицы"), `tblSub(${r.id}, 'idx')`, on(r.id, "idx") ? I.down(14) : I.right(14))}${
    ibHtml(t("Показать столбцы таблицы"), `tblSub(${r.id}, 'cols')`, I.cols(14), on(r.id, "cols") ? " on" : "")}${
    ibHtml(t("Показать триггеры таблицы"), `tblSub(${r.id}, 'trg')`, I.bolt(14), on(r.id, "trg") ? " on" : "")}${
    ibHtml(t("Показать SQL создания таблицы"), `tblSql(${r.id})`, I.code(14))}${ibHtml(t("К экрану «Нагрузка сервера», таблица «Тяжелые запросы»: запросы с этой таблицей"), goJs({k: "load", filter: bareName(r.table), db: L.db}), I.flame(14))}</td>`;
  const cols = filled(pg ? [
    [null, "", null, acts],
    ["table", "Таблица", "", r => `<td class="b mono">${h(r.table)}</td>`],
    ["filegroup", "Табличное<br>пространство", "", r => `<td>${h(r.filegroup || "")}</td>`],
    ["rows", "Живых<br>строк", "n", r => numCell(r.rows)],
    ["dead", "Мертвых<br>строк", "n", r => `<td class="n${hot(r.many_dead)}">${r.many_dead ? warnIco(WARN.dead) : ""}${nf(r.dead)}${r.dead_pct ? `<span class="sv">${nf(r.dead_pct)}%</span>` : ""}</td>`],
    ["total_mb", "Размер МБ<br>(оценка)", "n", r => mbCell(r.total_mb, " b")],
    ["rb", "Байт на<br>строку", "n", rbCell],
    ["data_mb", "Таблица<br>МБ", "n", r => mbCell(r.data_mb)],
    ["index_mb", "Индексы<br>МБ", "n", r => mbCell(r.index_mb)],
    ["toast_mb", "TOAST<br>МБ", "n", r => mbCell(r.toast_mb)],
    ["reads", "Строк<br>прочитано", "n", r => numCell(r.reads)],
    ["seq_scan", "Seq scan", "n", r => warnNum(r.seq_scan, r.big_scan && WARN.scan)],
    ["seq_rows", "Строк<br>seq scan", "n", r => numCell(r.seq_rows)],
    ["idx_scan", "Index scan", "n", r => numCell(r.idx_scan)],
    ["ins", "Встав-<br>лено", "n", r => numCell(r.ins)],
    ["upd", "Изме-<br>нено", "n", r => numCell(r.upd)],
    ["del", "Уда-<br>лено", "n", r => numCell(r.del)],
    ["vacuum", "Последний<br>vacuum", "", r => tsCell(r.vacuum)],
    ["analyze", "Последний<br>analyze", "", r => tsCell(r.analyze)],
  ] : [
    [null, "", null, acts],
    ["table", "Таблица", "", r => `<td class="b mono">${h(r.table)}${r.heap ? ` <span class="chip sm" title="${t("Куча: таблица без кластерного индекса")}">${t("куча")}</span>` : ""}${r.heap && r.total_mb >= 100 ? warnIco(WARN.heap) : ""}</td>`],
    ["filegroup", "Файловая<br>группа", "", r => `<td>${h(r.filegroup || "")}</td>`],
    ["rows", "Строк", "n", r => numCell(r.rows)],
    ["total_mb", "Занято<br>всего МБ", "n", r => mbCell(r.total_mb, " b")],
    ["used_mb", "Исполь-<br>зовано МБ", "n", r => mbCell(r.used_mb)],
    ["rb", "Байт на<br>строку", "n", rbCell],
    ["data_mb", "Данные<br>МБ", "n", r => mbCell(r.data_mb)],
    ["index_mb", "Индексы<br>МБ", "n", r => mbCell(r.index_mb)],
    ["parts", "Секций", "n", r => numCell(r.parts)],
    ["reads", "Обращений<br>на чтение", "n", r => numCell(r.reads)],
    ["seeks", "Seek", "n", r => numCell(r.seeks)],
    ["scans", "Scan", "n", r => warnNum(r.scans, r.big_scan && WARN.scan)],
    ["lookups", "Lookup", "n", r => numCell(r.lookups)],
    ["updates", "Изме-<br>нений", "n", r => numCell(r.updates)],
    ["last_read", "Последнее<br>чтение", "", r => tsCell(r.last_read)],
    ["last_update", "Последнее<br>изменение", "", r => tsCell(r.last_update)],
  ], rows);
  L.hot = "total_mb";
  body.innerHTML = shown.length ? srvTable("tables", cols, shown, r => ` data-tid="${r.id}"`) : `<div class="empty">${rows.length ? t("Нет строк по фильтру") : t("Таблиц нет")}</div>`;
  const ncol = (body.querySelector("thead tr") || {children: []}).children.length;
  const tr = L.open && body.querySelector(`tr[data-tid="${L.open.id}"]`);
  if (tr) tr.insertAdjacentHTML("afterend", `<tr class="sub"><td colspan="${ncol}">${SUB_HTML[L.open.kind](L.open.id)}</td></tr>`);
  hbar(body);
}
// подтаблица строки «Таблиц» - индексы или столбцы; открыта одна, данные запрашиваются один раз
async function tblSub(id, kind) {
  const L = S.live.tables, key = kind + id;
  if (L.open && L.open.id === id && L.open.kind === kind) { L.open = null; tablesRender(); return; }
  L.open = {id, kind};
  if (!L.sub[key]) {
    L.sub[key] = {loading: true};
    tablesRender();
    let x;
    try {
      const res = await api({idx: "table_indexes", cols: "table_columns", trg: "table_triggers"}[kind], L.db, id);
      x = Array.isArray(res) ? {rows: res} : res;      // строки или {rows, note}
    } catch (e) { x = {err: String(e.message || e)}; }
    if (S.live.tables !== L) return;
    L.sub[key] = x;
  }
  tablesRender();
}
// триггеры таблицы: вид, события, включен ли, статистика выполнения; SQL - кнопкой у строки
const TRG_ON = {O: "включен", D: "отключен", R: "только на реплике", A: "всегда"};
function trgHtml(id) {
  const x = S.live.tables.sub["trg" + id] || {}, pg = isPg();
  const avg = r => r.execs ? Math.round(r.time / r.execs * 1000) / 1000 : null;
  const cols = [["", r => `<td class="acts2">${ibHtml(t("Показать SQL триггера"), `trgSql(${id}, ${x.rows.indexOf(r)})`, I.code(14))}</td>`],
    ["Триггер", r => `<td class="mono b">${h(r.name)}</td>`],
    ["Включен", r => `<td>${r.enabled === "D" ? `<span class="chip sm c-diff">${t(TRG_ON.D)}</span>` : t(TRG_ON[r.enabled] || r.enabled)}</td>`],
    ["Когда", r => `<td>${h(r.timing)}${pg ? `<span class="sv">${t(r.level === "row" ? "на каждую строку" : "на оператор")}</span>` : ""}</td>`],
    ["События", r => `<td>${h(r.events || "")}</td>`]].concat(pg
    ? [["Функция", r => `<td class="mono">${h(r.function)}</td>`], ["Вызовов", r => numCell(r.execs), true],
       ["Время мс", r => msCell(r.time), true], ["Собственное<br>время мс", r => msCell(r.self_time), true], ["Время на<br>вызов мс", r => numCell(avg(r)), true]]
    : [["Выполнений", r => numCell(r.execs), true], ["CPU мс", r => msCell(r.cpu), true], ["Время мс", r => msCell(r.time), true],
       ["Время на<br>выполнение мс", r => numCell(avg(r)), true], ["Наибольшее<br>время мс", r => msCell(r.max_time), true],
       ["Логических<br>чтений", r => numCell(r.reads), true], ["Последнее<br>выполнение", r => tsCell(r.last)], ["В кэше с", r => tsCell(r.cached)]]);
  const note = pg ? t("статистика — функции триггера (pg_stat_user_functions): если функция служит нескольким таблицам, вызовы общие")
    : t("статистика — sys.dm_exec_trigger_stats: с попадания плана триггера в кэш");
  return subHtml(x, "Триггеров нет", cols) + (x.rows && x.rows.length ? `<div class="pale" style="font-size:12px;margin-top:4px">${note}${x.note ? " · " + h(x.note) : ""}</div>` : "");
}
function trgSql(id, i) {
  const L = S.live.tables, r = L.sub["trg" + id].rows[i];
  textDialog(t("SQL триггера {x}", {x: r.name}), r.text, `trigger_${r.name}`, null, L.db, false);
}
// SQL создания таблицы: собирает диалект по каталогу (table_sql), показ - окно текста (скопировать, открыть программой)
async function tblSql(id) {
  const L = S.live.tables, r = L.rows.find(x => x.id === id);
  try { textDialog(t("SQL создания таблицы {x}", {x: r.table}), await api("table_sql", L.db, id), `create_${bareName(r.table)}`, null, L.db, false); }
  catch (e) { fail(e); }
}
function subHtml(x, empty, cols) {      // cols: [заголовок, ячейка строки, числовая]
  if (x.loading) return `<span class="pulse"></span>`;
  if (x.err) return `<span class="hotv">${t("Не удалось получить данные: {err}", {err: h(x.err)})}</span>`;
  if (!x.rows.length) return `<span class="pale">${t(empty)}</span>`;
  return `<table class="t compact isub"><thead><tr>${cols.map(c => `<th${c[2] ? ' class="n"' : ""}>${t(c[0])}</th>`).join("")}</tr></thead><tbody>${x.rows.map(r => `<tr>${cols.map(c => c[1](r)).join("")}</tr>`).join("")}</tbody></table>`;
}
// лишние индексы: тот же ключ (и включенные, и условие) или ключ - начало ключа другого обычного индекса
const IDX_PLAIN = r => r.type === "NONCLUSTERED" || r.type === "btree";
function idxDup(rows, r) {
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (r.primary) return null;
  for (const o of rows) {
    if (o === r || o.filter !== r.filter) continue;
    // полный повтор: помечается неуникальный (оба уникальные или оба нет - тот, что ниже в списке)
    if (same(o.keys, r.keys) && same([...o.include].sort(), [...r.include].sort()) && IDX_PLAIN(o) === IDX_PLAIN(r)
        && (o.primary || (o.unique && !r.unique) || (!!o.unique === !!r.unique && rows.indexOf(o) < rows.indexOf(r))))
      return t("Тот же ключ, что у индекса {x}: один из них лишний, а сервер обновляет оба при каждом изменении таблицы", {x: o.name});
    // начало ключа другого: только неуникальный обычный индекс без условия, и его включенные столбцы есть в другом
    if (!r.unique && !r.filter && IDX_PLAIN(r) && IDX_PLAIN(o) && o.keys.length > r.keys.length && same(o.keys.slice(0, r.keys.length), r.keys)
        && r.include.every(c => o.keys.includes(c) || o.include.includes(c)))
      return t("Ключ этого индекса — начало ключа индекса {x}: запросы по этому ключу может обслужить и {x}, этот индекс, возможно, лишний", {x: o.name});
  }
  return null;
}
function idxHtml(id) {
  const L = S.live.tables, x = L.sub["idx" + id] || {}, pg = isPg(), tb = L.rows.find(r => r.id === id) || {};
  const changed = pg ? tb.ins || tb.upd || tb.del : null;
  const unused = r => r.unused && (pg ? changed : r.updates > 0);      // не читается, но таблица меняется
  const keys = r => `<td class="mono">${h(r.keys.join(", "))}${r.include.length ? `<span class="sv">INCLUDE ${h(r.include.join(", "))}</span>` : ""}${r.filter ? `<span class="sv">WHERE ${h(r.filter)}</span>` : ""}</td>`;
  // кластеризация: в каком порядке лежат строки таблицы относительно индекса
  const order = r => pg ? `<td class="n"${r.correlation == null ? "" : ` title="${t("Корреляция первого столбца ключа (статистика ANALYZE): 100% — строки таблицы лежат в порядке индекса, около 0 — вразброс, и чтение диапазона по индексу читает много разных страниц")}"`}>${r.correlation == null ? "" : nf(Math.round(Math.abs(r.correlation) * 100)) + "%"}${r.clustered ? `<span class="sv">CLUSTER</span>` : ""}</td>`
    : `<td>${r.clustered ? t("таблица хранится в порядке этого индекса") : ""}</td>`;
  const cols = [["Индекс", r => {
    const dup = x.rows && idxDup(x.rows, r);
    return `<td class="mono b">${h(r.name || t("(куча)"))}${r.primary ? ' <span class="chip sm c-acc">PK</span>' : r.unique ? ` <span class="chip sm">${t("уникальный")}</span>` : ""}${unused(r) ? warnIco(WARN.unusedIdx) : ""}${dup ? warnIco(dup) : ""}</td>`;
  }], ["Вид", r => `<td>${h(r.type || "")}</td>`], ["Ключ", keys], [pg ? "Порядок строк<br>таблицы" : "Порядок строк таблицы", order, pg],
    ["Размер МБ", r => mbCell(r.mb), true], [pg ? "Index scan" : "Обращений на чтение", r => numCell(r.reads), true]].concat(pg
    ? [["Строк прочитано", r => numCell(r.tup_read), true], ["Строк выбрано", r => numCell(r.tup_fetch), true]]
    : [["Seek", r => numCell(r.seeks), true], ["Scan", r => numCell(r.scans), true], ["Lookup", r => numCell(r.lookups), true], ["Изменений", r => numCell(r.updates), true],
       ["Последнее чтение", r => tsCell(r.last_read)], ["Последнее изменение", r => tsCell(r.last_update)]]);
  return subHtml(x, "Индексов нет", cols);
}
const SUB_HTML = {idx: id => idxHtml(id), cols: id => colsHtml(id), trg: id => trgHtml(id)};
function colsHtml(id) {
  const x = S.live.tables.sub["cols" + id] || {}, pg = isPg();
  const flags = r => [r.identity && "IDENTITY", r.computed && t("вычисляемый"), r.sparse && "SPARSE"].filter(Boolean).map(f => ` <span class="chip sm">${f}</span>`).join("");
  const cols = [["Столбец", r => `<td class="mono b">${h(r.column)}${flags(r)}${r.null_pct === 100 ? warnIco(WARN.emptyCol) : ""}</td>`],
    ["Тип", r => `<td class="mono">${h(r.type)}</td>`],
    ["NULL", r => `<td>${r.nullable ? t("можно") : `<span class="pale">${t("нельзя")}</span>`}</td>`],
    pg ? ["Байт<br>в среднем", r => `<td class="n"${r.var ? ` title="${t("Средний размер значения по статистике ANALYZE (у длинных значений — после сжатия)")}"` : ""}>${nf(r.bytes)}</td>`, true]
      : ["Байт", r => `<td class="n">${r.bytes == null ? "max" : (r.var ? t("до {n}", {n: nf(r.bytes)}) : nf(r.bytes))}</td>`, true]];
  if (pg) cols.push(["NULL<br>в строках %", r => numCell(r.null_pct), true], ["Различных<br>значений", r => numCell(r.distinct), true]);
  const note = pg ? t("«Байт в среднем», «NULL в строках %» и «Различных значений» — статистика ANALYZE") : t("«Байт» — по объявленному типу: средний размер значения без чтения данных таблицы не узнать");
  return subHtml(x, "Столбцов нет", cols) + (x.rows && x.rows.length ? `<div class="pale" style="font-size:12px;margin-top:4px">${note}</div>` : "");
}
function funcsRender() {
  const L = S.live.functions, body = secBody("functions"), D = L.data;
  if (!body || !D) return;
  if (D.err) return secErr("functions", D.err);
  const pg = isPg();
  const rows = L.rows = D.rows.map(r => Object.assign(r, pg ? {object: r.function, execs: r.calls} : {}, {time_avg: (pg ? r.calls : r.execs) ? Math.round(r.time / (pg ? r.calls : r.execs) * 10) / 10 : null}));
  const shown = rows.filter(r => srvMatch(r, L.filter, ["object", "type"]));
  $("#functions-cnt").textContent = (shown.length !== rows.length ? t("{n} из {of}", {n: shown.length, of: rows.length}) : String(rows.length)) + " · " + t("база {db}", {db: L.db}) + " · " +
    (pg ? t("с последнего сброса статистики") : t("с попадания плана в кэш, только объекты с планом в кэше")) + (D.note ? " · " + D.note : "");
  const cols = filled([
    [null, "", null, r => `<td class="acts2">${ibHtml(t("К экрану «Нагрузка сервера», таблица «Тяжелые запросы»: запросы с этим объектом"), goJs({k: "load", filter: bareName(r.object), db: L.db}), I.flame(14))}</td>`],
    ["object", pg ? "Функция" : "Объект", "", r => `<td class="b mono">${h(r.object)}</td>`],
    ["type", "Тип", "", r => `<td>${h(r.type || "")}</td>`],
    ["execs", "Выпол-<br>нений", "n", r => numCell(r.execs)],
    ["cpu", "CPU<br>мс", "n", r => msCell(r.cpu)],
    ["time", "Время<br>мс", "n", r => msCell(r.time)],
    ["self_time", "Собственное<br>время мс", "n", r => msCell(r.self_time)],
    ["time_avg", "Время на<br>выполнение мс", "n", r => numCell(r.time_avg)],
    ["reads", "Логических<br>чтений", "n", r => numCell(r.reads)],
  ], rows);
  L.hot = "time";
  body.innerHTML = shown.length ? srvTable("functions", cols, shown) : `<div class="empty">${rows.length ? t("Нет строк по фильтру") : t("Статистики нет")}</div>`;
  hbar(body);
}
function tempRender() {
  const L = S.live.temp, body = secBody("temp"), D = L.data;
  if (!body || !D) return;
  if (D.err) { $("#temp-sum").innerHTML = ""; $("#temp-more").innerHTML = ""; return secErr("temp", D.err); }
  const pg = isPg(), s = D.summary, rows = L.rows = D.rows.map((r, i) => Object.assign(r, {i}));
  $("#temp-sum").innerHTML = s ? `<span class="chip">tempdb: ${t("всего {a} МБ, свободно {f} МБ", {a: nf(s.total_mb), f: nf(s.free_mb)})}</span><span class="chip">${t("хранилище версий {n} МБ", {n: nf(s.version_mb)})}</span><span class="chip">${t("внутренние объекты {n} МБ", {n: nf(s.internal_mb)})}</span><span class="chip">${t("пользовательские объекты {n} МБ", {n: nf(s.user_mb)})}</span>` : "";
  $("#temp-cnt").textContent = t("сессий: {n}", {n: rows.length}) + " · " + t("весь сервер") + (D.note ? " · " + D.note : "");
  const cols = filled([
    [null, "", null, r => `<td class="acts2">${r.text ? ibHtml(t("Показать текст запроса"), `tempText(${r.i})`, I.note(14)) : ""}${r.db ? ibHtml(t("К экрану «Текущие запросы»: эта сессия"), goJs({k: "current", hl: r.spid}), I.pulse(14)) + ibHtml(t("Наблюдать сессию"), `startSession(${r.spid})`, I.eye(14)) : ""}</td>`],
    ["spid", "№", "n", r => `<td class="n b">${r.spid}</td>`],
    ["db", "База", "", r => `<td>${h(r.db || "")}</td>`],
    ["login", "Логин", "", r => `<td>${h(r.login || "")}</td>`],
    ["program", "Программа", "", r => `<td class="clip" title="${h(r.program || "")}">${h(r.program || "")}</td>`],
    ["status", "Состояние", "", r => `<td>${h(r.status || "")}</td>`],
    ["elapsed", "Выпол-<br>няется", "n", r => `<td class="n">${r.elapsed != null ? `<span class="mono">${clock(r.elapsed)}</span>` : ""}</td>`],
    ["total_mb", "Всего<br>МБ", "n", r => mbCell(r.total_mb, " b")],
    ["user_mb", "Пользовательские МБ<br>(#temp, @table)", "n", r => mbCell(r.user_mb)],
    ["internal_mb", "Внутренние МБ<br>(сортировки, hash)", "n", r => mbCell(r.internal_mb)],
    ["files", "Временных<br>файлов", "n", r => numCell(r.files)],
    ["text", "Запрос", "", r => `<td class="mono clip wide" title="${h(r.text || "")}">${h((r.text || "").replace(/\s+/g, " ").slice(0, 200))}</td>`],
  ], rows);
  L.hot = "total_mb";
  body.innerHTML = rows.length ? srvTable("temp", cols, rows, r => r.spid === L.hl ? ' class="hl"' : "") : `<div class="empty">${t("Сейчас ни одна сессия не занимает временное место")}</div>`;
  hbar(body);
  if (L.hl && !L.hlDone) {
    L.hlDone = true;
    if (rows.some(r => r.spid === L.hl)) hlRow(body); else toast(t("Сессия {n} сейчас не занимает временного места", {n: L.hl}));
  }
  const more = $("#temp-more");
  if (pg) more.innerHTML = (D.dbs || []).length ? `<div class="tbar"><h2 style="font-size:14px">${t("Временные файлы баз")}</h2><span class="secn">(${t("с последнего сброса статистики")})</span></div><div class="tscroll"><table class="t compact"><thead><tr><th>${t("База")}</th><th class="n">${t("Файлов")}</th><th class="n">${t("МБ")}</th><th>${t("Статистика с")}</th></tr></thead><tbody>${D.dbs.map(x => `<tr><td>${h(x.db)}</td>${numCell(x.files)}${mbCell(x.mb)}${tsCell(x.since)}</tr>`).join("")}</tbody></table></div>` : "";
  else if (dbms().has_temp_tables) more.innerHTML = L.tables ? tempTablesHtml() : `<div class="tbar"><a class="btn sm" onclick="tempTables()">${I.cols(15)}${t("Самые большие временные таблицы")}</a><span class="pale" style="font-size:12px">${t("каталог tempdb; сессию у таблицы не узнать без чтения блокировок — это долгий запрос")}</span></div>`;
}
function tempText(i) { const r = S.live.temp.rows[i]; textDialog(t("Сессия {n}", {n: r.spid}), r.text, `temp_${r.spid}`, null, r.db); }
async function tempTables() {
  const L = S.live.temp;
  $("#temp-more").innerHTML = `<div class="empty"><span class="pulse"></span></div>`;
  try { L.tables = {rows: await api("temp_tables")}; } catch (e) { L.tables = {err: String(e.message || e)}; }
  if (S.live.temp === L) tempRender();
}
function tempTablesHtml() {
  const x = S.live.temp.tables;
  if (x.err) return `<div class="empty">${t("Не удалось получить данные: {err}", {err: h(x.err)})}</div>`;
  return `<div class="tbar"><h2 style="font-size:14px">${t("Самые большие временные таблицы")}</h2><span class="secn">(tempdb.sys.tables)</span><a class="btn sm" style="margin-left:auto" onclick="tempTables()">${I.refresh(14)}${t("Обновить")}</a></div>
    <div class="tscroll">${x.rows.length ? `<table class="t compact"><thead><tr><th>${t("Таблица")}</th><th class="n">${t("Строк")}</th><th class="n">${t("МБ")}</th><th>${t("Создана")}</th></tr></thead><tbody>${x.rows.map(r => `<tr><td class="mono b" title="${h(r.internal_name)}">${h(r.name)}</td>${numCell(r.rows)}${mbCell(r.mb)}${tsCell(r.created)}</tr>`).join("")}</tbody></table>` : `<div class="empty">${t("Временных таблиц нет")}</div>`}</div>`;
}

// ---------------------------------------------------------------- новое наблюдение (§5.9)
function viewNewSession(m) {
  m.innerHTML = `
    <header style="display:flex;flex-direction:column;gap:8px">${backLine()}<h1>${t("Новое наблюдение")}</h1></header>
    <div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap">
      <section class="card" style="flex:0 0 300px;padding:24px;display:flex;flex-direction:column;gap:16px">
        <span class="lbl">${t("Номер сессии")}</span>
        <input class="bignum" id="spid" inputmode="numeric" onkeydown="if(event.key==='Enter')startSession()">
        <a class="btn pri" onclick="startSession()">${I.eye(18)}${t("Начать наблюдение")}</a>
        <span class="note">${t("Enter — начать. Наблюдение только читает системные представления по этой сессии и не мешает ей.")}</span>
      </section>
      <section class="card tw" style="flex:1 1 600px;min-width:0">
        <div class="tbar"><h2>${t("Активные сессии")}</h2><span class="lbl" id="ss-cnt">${t("база → программа → номер")}</span>
          <a class="btn sm" style="margin-left:auto" onclick="loadSessions()">${I.refresh(15)}${t("Обновить")}</a></div>
        <div class="flts" id="ss-flt"></div>
        <div class="tscroll" id="ss-body" style="border-top:1px solid #EEF1F6"><div class="empty">${t("Загрузка списка…")}</div></div>
      </section>
    </div>`;
  $("#spid").focus();
  // фильтр «База данных» по умолчанию - база подключения
  S.live.flt = {db: (S.st.connection || {}).database || "", program: "", login: "", active: true};
  loadSessions();
}
async function loadSessions() {
  try { S.live.sessions = await api("list_sessions"); } catch (e) { $("#ss-body").innerHTML = `<div class="empty">${t("Список не получен: {err}", {err: h(e.message || e)})}</div>`; return; }
  // имя базы подключения - как его пишет сервер (регистр)
  const f = S.live.flt, same = S.live.sessions.find(x => (x.db || "").toLowerCase() === f.db.toLowerCase());
  if (same && same.db !== f.db) f.db = same.db;
  renderSessions();
}
// колонки списка сессий (srvTable, вид "ss"): ключ, заголовок, "n" - число
const SS_COLS = [
  [null, "", null, x => `<td class="acts2"><span class="ib" title="${t("Начать наблюдение за сессией {n}", {n: x.spid})}" onclick="startSession(${x.spid})">${I.eye(14)}</span></td>`],
  ["spid", "№", "n", x => `<td class="n" style="font-weight:700">${x.spid}</td>`],
  ["db", "База", "", x => `<td>${h(x.db)}</td>`],
  ["proc", "Процедура", "", x => `<td>${x.proc ? `<span class="mono">${h(x.proc)}</span>` : ""}</td>`],
  ["host", "Компьютер", "", x => `<td>${h(x.host)}</td>`],
  ["login", "Логин", "", x => `<td>${h(x.login)}</td>`],
  ["elapsed", "Выпол-<br>няется", "n", x => `<td class="n">${x.elapsed != null ? `<span class="mono">${clock(x.elapsed)}</span>` : '<span class="pale">—</span>'}</td>`],
  ["program", "Программа", "", x => `<td>${h(x.program)}</td>`]];
function renderSessions() {
  const all = S.live.sessions || [], f = S.live.flt;
  const L = S.live.ss ||= {sort: null, render: renderSessions}, s = L.sort;
  // выбранное значение остается в списке, даже если сейчас таких сессий нет (база подключения)
  const opts = k => ["", ...new Set(all.map(x => x[k] || "").concat(f[k] ? [f[k]] : []))].map(x => `<option value="${h(x)}"${f[k] === x ? " selected" : ""}>${x === "" ? t("Все") : h(x)}</option>`).join("");
  $("#ss-flt").innerHTML = [["db", "База данных"], ["program", "Программа"], ["login", "Логин"]].map(([k, lbl]) =>
    `<label class="field"><span class="lbl">${t(lbl)}</span><select class="inp flt${f[k] ? " set" : ""}" onchange="S.live.flt.${k}=this.value;renderSessions()">${opts(k)}</select></label>`).join("") +
    `<span class="popt" style="align-self:end;height:44px" onclick="S.live.flt.active=!S.live.flt.active;renderSessions()"><span class="sw${f.active ? " on" : ""}"></span>${t("Только выполняющиеся")}</span>`;
  const rows = all.filter(x => (!f.db || x.db === f.db) && (!f.program || x.program === f.program) && (!f.login || x.login === f.login) && (!f.active || x.elapsed != null));
  $("#ss-cnt").textContent = t("{n} из {of}", {n: rows.length, of: all.length}) + " · " + (s ? t("по колонке") : t("база → программа → номер"));
  const cur = +$("#spid").value;
  $("#ss-body").innerHTML = rows.length ? srvTable("ss", SS_COLS, rows, x => ` class="${x.spid === cur ? "on" : ""}" ondblclick="startSession(${x.spid})"`)
    : `<div class="empty">${all.length ? t("Нет сессий по фильтру") + (f.active ? ": " + t("сейчас ни одна не выполняет запрос") : "") : t("Сессий нет")}</div>`;
  hbar($("#ss-body"));
}
function startSession(spid) {
  spid = spid || +$("#spid").value;
  if (!spid) { toast(t("Введите номер сессии"), true); return; }
  api("start_session", spid).then(info => { S.procs[info.id] = {info, events: []}; go({k: "session", pid: info.id}); }).catch(fail);
}

// ---------------------------------------------------------------- идет наблюдение (§4.1, §5.8)
function viewSession(m, v) {
  const p = S.procs[v.pid];
  if (!p) { m.innerHTML = `<div class="empty">${t("Процесс не найден")}</div>`; return; }
  m.innerHTML = `
    <header class="head"><div style="display:flex;flex-direction:column;gap:8px">${backLine()}
      <h1 style="display:flex;align-items:center;gap:14px">${h(sessTitle(p.info))} <span class="chip c-ok" id="s-chip"><span class="pulse g"></span>${t("идет наблюдение")} · <span class="tm" data-t0="${Date.parse(p.info.started)}"></span></span></h1>
      <span class="noteed" title="${t("Заметка к наблюдению")}">${I.pen(15)}<span class="txt" id="s-note" data-ph="${t("+ заметка")}" contenteditable="true" onblur="if(S.live.folder)saveNote(baseName(S.live.folder), this.textContent)" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}"></span></span>
      <span class="lbl" id="s-info"></span><span class="inpq" id="s-inp"></span></div>
      <div class="row"><span class="ib big" title="${t("Показать в папке")}" onclick="if(S.live.folder)api('show_in_folder', S.live.folder)">${I.folder(19)}</span>
        <a class="btn" id="s-cancel" style="color:#9A3412" title="${t("Остановить наблюдение и удалить собранное (в корзину)")}" onclick="cancelSession(${p.info.id})">${I.trash(14)}${t("Отменить наблюдение")}</a>
        <a class="btn dark" id="s-stop" onclick="api('stop', ${p.info.id})">${I.stop(14)}${t("Не наблюдать и сохранить")}</a></div></header>
    <section class="card hl strip"><span class="lbl" style="color:#2F4AC0;white-space:nowrap;margin-top:22px">${t("Сейчас")}</span><div class="lines" id="s-lines"></div></section>
    <section class="kpis">${kpiBox("q-t", "Время операторов", "мс")}${kpiBox("q-c", "CPU", "мс")}${kpiBox("q-l", "Ожидание блокировок", "мс")}${kpiBox("q-r", "Ожидание ресурсов", "мс")}${slowBox("q-slow", null)}</section>
    <section class="card wcard" id="s-waits" style="display:none"></section>
    <div id="s-tables"></div>`;
  S.live = {el: []};
  updateLive();
  loadSessionTables(p);
}
async function loadSessionTables(p) {
  const st = p.events.find(e => e.event === "start");
  if (!st) return;
  S.live.folder = st.folder;
  let d;
  try { d = await api("session_details", baseName(st.folder), TABLE_SHOW); } catch (e) { return; }
  if (!(S.view.k === "session" && S.view.pid === p.info.id)) return;
  $("#s-info").textContent = (d.header["Сессия"] ? d.header["Сессия"].split(";").slice(1).join(" ·") : "") + " · " + t("реестр обновлен {time}", {time: (d.header["Обновлено"] || "").slice(11)});
  $("#s-inp").outerHTML = inputLine(d.header, "s-inp");
  const nt = $("#s-note");          // заметка: один раз, пока ее не правят
  if (nt && !S.live.noted && document.activeElement !== nt) { S.live.noted = true; nt.textContent = d.note || ""; }
  const sum = k => d.registry.reduce((n, r) => n + (+cellVal(r, {k}) || 0), 0);
  S.live.total = sum("Время мс");
  setKpi("q-t", sum("Время мс"), true); setKpi("q-c", sum("CPU мс"), true);
  setKpi("q-l", sum("Ожидание блокировок мс"), true); setKpi("q-r", sum("Ожидание ресурсов мс"), true);
  const ql = $("#q-l"); if (ql) ql.parentNode.style.color = sum("Ожидание блокировок мс") ? "#9A4A07" : "";
  liveWaits("s-waits", regWaitItems(d.registry));      // по реестру (точнее событий), обновляется с ним раз в 10 с
  // реестр - выше журнала; кольцо у заголовка заполняется за FLUSH_S до следующего обновления файлов
  // (отсчет от последнего события flush, до первого - от начала наблюдения) и обнуляется, когда
  // новые файлы пришли и таблицы перерисованы (кольцо создается заново)
  const ring = sessRingHtml(p);
  // высота блока держится до отрисовки строк (tableCard рисует их следующим шагом), иначе страница на миг
  // становится короче и прокрутка уезжает наверх
  const box = $("#s-tables"), main = $("#main"), top = main.scrollTop;
  box.style.minHeight = box.offsetHeight + "px";
  box.innerHTML = tableCard("sreg", t("Реестр операторов"), t("по времени · обновляется раз в 10 с"), REG_COLS, d.registry, d.folder + "\\registry.csv", d.folder, "reg", ring) +
    tableCard("slog", t("Журнал выполнения"), "log.csv · " + t("новые сверху") + (d.log.length >= TABLE_SHOW ? " · " + t("последние {n}", {n: nf(TABLE_SHOW)}) : ""), LOG_COLS, linkLog(d.log, d.registry).reverse(), d.folder + "\\log.csv", d.folder, "log");
  setTimeout(() => { box.style.minHeight = ""; main.scrollTop = top; });     // после строк таблиц
}
// исходный запрос сессии из шапки registry.txt (последний батч клиента: часто вызов процедуры с параметрами)
function inputLine(header, id) {
  const k = Object.keys(header).find(x => x.startsWith("Исходный запрос")), q = k ? header[k] : "";
  return `<span class="inpq" id="${id}" title="${h(q)}">${q && q !== "нет данных" ? `<span class="pale">${t("исходный запрос:")}</span> ${h(q)}` : ""}</span>`;
}
const FLUSH_S = 10;         // --session: файлы реестра перезаписываются раз в столько секунд (SESSION_FLUSH_S)
// Клик по кольцу - пауза экрана (§4.1): процесс собирает и пишет файлы как обычно, экран их не читает;
// кольцо серое в два тона и идет дальше. Снятие паузы - одно чтение последних файлов.
function sessRingHtml(p) {
  if (p.info.code !== null) return "";
  const st = p.events.find(e => e.event === "start"), last = [...p.events].reverse().find(e => e.event === "flush") || st;
  const elapsed = Math.min(Math.max(0, Date.now() - evMs(last)), FLUSH_S * 1000), pz = S.live.paused;
  const tip = pz ? t("Обновление экрана приостановлено с {time}, данные собираются — продолжить", {time: hms(new Date(S.live.pausedAt))}) : t("До следующего обновления реестра — приостановить обновление экрана");
  return `<span class="ring sr${pz ? " pause" : ""}" id="s-ring" title="${tip}" onclick="event.stopPropagation();sessPause()"><svg width="18" height="18" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" class="rb"/><circle cx="10" cy="10" r="8" class="rf" style="animation-duration:${FLUSH_S}s;animation-delay:-${elapsed}ms"/>${pz ? '<path d="M8 6.5v7M12 6.5v7" stroke="#485264" stroke-width="2" stroke-linecap="round"/>' : ""}</svg></span>`;
}
function sessRing(p) {
  const el = $("#s-ring");
  if (el) el.outerHTML = sessRingHtml(p);
}
function sessPause() {
  const p = S.procs[S.view.pid];
  if (!p || S.view.k !== "session") return;
  S.live.paused = !S.live.paused;
  S.live.pausedAt = Date.now();
  S.live.paused ? sessRing(p) : loadSessionTables(p);
}
function updateSession(p) {
  const ev = p.events, L = S.live, box = $("#s-lines");
  if (!box) return;
  const items = ev.filter(e => e.n > (L.n || 0) && (e.event === "statement" || e.event === "idle"));
  for (const e of items) {
    L.n = e.n;
    const prev = L.el[L.el.length - 1];
    if (prev) {                 // старая строка поднимается, замирает 2 с и уходит (при новой смене - сразу)
      const t = prev.querySelector(".optm");
      if (t && !t.dataset.t1) t.dataset.t1 = evMs(e);
      const w = prev.querySelector(".wt");
      if (w) w.remove();
      L.el.filter(x => x.classList.contains("old")).forEach(x => { x.classList.add("gone"); setTimeout(() => x.remove(), 700); });
      prev.classList.add("old");
      setTimeout(() => { prev.classList.add("gone"); setTimeout(() => prev.remove(), 700); }, 2500);
    }
    const el = document.createElement("div");
    el.className = "cl";
    const since = hms(srvDate(p, evMs(e)));     // время сервера, когда оператор попал в выборку
    el.innerHTML = e.event === "idle" ? `<span class="tmc">${since}</span><span class="tx">${t("нет запроса")}</span>`
      : `<span class="tmc">${since}</span><span class="ob">${h(e.object)}${e.line ? ":" + e.line : ""}</span><span class="tx" title="${h(e.text)}">${h(e.text)}</span><span class="wbox"></span>${optmHtml(evMs(e), e.prev)}`;
    box.appendChild(el);
    L.el = L.el.filter(x => x.isConnected).concat(el);
    if (e.wait) setWait(el, e.wait, e.blocked_by, evMs(e));
    L.stmt = e;
  }
  const cur = L.el[L.el.length - 1];
  if (cur && L.stmt) {
    const waits = ev.filter(x => x.event === "wait" && evMs(x) >= evMs(L.stmt));
    const w = waits[waits.length - 1];
    if (w && w !== L.lastWait) { L.lastWait = w; setWait(cur, w.wait, w.blocked_by, evMs(w)); }
  }
  const slow = [...ev].reverse().find(x => x.event === "slow");
  if (slow) setSlow("q-slow", slow.count, slow.ms, L.total);
  if (p.info.code !== null) {
    $("#s-chip").innerHTML = t("завершено");
    $("#s-stop").setAttribute("disabled", "");
    $("#s-cancel").setAttribute("disabled", "");
  }
}

// ---------------------------------------------------------------- итог наблюдения
// Опорное наблюдение (§6.9): у опорного - пометка, у остальных - «Сравнить с опорным» (A - опорное, B - это)
function sessRefActs(folder) {
  const ref = S.st.session_reference;
  if (ref === folder) return `<span class="chip">${I.star(13, true)}${t("опорное")}</span><a class="btn sm" onclick="setSessionReference(null)">${t("Снять пометку")}</a>`;
  return (ref ? `<a class="btn sm pri" onclick="startSessionCompare(${h(JSON.stringify(ref))}, ${h(JSON.stringify(folder))})">${t("Сравнить с опорным")}</a>` : "") +
    `<a class="btn sm" onclick="setSessionReference(${h(JSON.stringify(folder))})">${t("Пометить опорным")}</a>`;
}
async function viewSessionDone(m, v) {
  let d;
  try { d = await api("session_details", v.folder); } catch (e) { m.innerHTML = `<div class="empty">${h(e.message || e)}</div>`; return; }
  if (S.view !== v) return;
  const sum = k => d.registry.reduce((n, r) => n + (+cellVal(r, {k}) || 0), 0);
  const kpi = (label, k) => { const x = sum(k); return `<div class="card kpi"><span class="lbl">${t(label)}</span><span class="v">${nf(x)} <small>${t("мс")}</small></span><span class="dur">${x >= 1000 ? dur(x) : "&nbsp;"}</span></div>`; };
  const spid = (d.header["Сессия"] || "").split(";")[0];
  m.innerHTML = `
    <header class="head"><div style="display:flex;flex-direction:column;gap:8px">${backLine()}
      <h1 style="display:flex;align-items:center;gap:14px">${t("Сессия {n}", {n: h(spid)})} <span class="chip">${h(d.header["Состояние"] || "")}</span></h1>
      <span class="noteed" title="${t("Заметка к наблюдению")}">${I.pen(15)}<span class="txt" data-ph="${t("+ заметка")}" contenteditable="true" onblur="saveNote(${h(JSON.stringify(v.folder))}, this.textContent)" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}">${h(d.note || "")}</span></span>
      <span class="lbl">${h((d.header["Сессия"] || "").split(";").slice(1).join(" ·"))} · ${t("начало {time}", {time: h(d.header["Начало наблюдения"] || "")})}</span>${inputLine(d.header, "d-inp")}</div>
      <div class="row">${sessRefActs(v.folder)}<span class="ib big" title="${t("Показать в папке")}" onclick="api('show_in_folder', ${h(JSON.stringify(d.folder + "\\registry.txt"))})">${I.folder(19)}</span>
        <span class="ib big" title="${t("Удалить в корзину")}" onclick="deleteSession(${h(JSON.stringify(v.folder))})">${I.trash(19)}</span></div></header>
    <section class="kpis">${kpi("Время операторов", "Время мс")}${kpi("CPU", "CPU мс")}${kpi("Ожидание блокировок", "Ожидание блокировок мс")}${kpi("Ожидание ресурсов", "Ожидание ресурсов мс")}${d.slow ? slowBox("d-slow", d.slow, false, sum("Время мс")) : ""}</section>
    ${tableCard("dreg", t("Реестр операторов"), "registry.csv", REG_COLS, d.registry, d.folder + "\\registry.csv", d.folder, "reg", "", 0, waitBarHtml(regWaitItems(d.registry)))}
    ${tableCard("dlog", t("Журнал выполнения"), "log.csv", LOG_COLS, linkLog(d.log, d.registry), d.folder + "\\log.csv", d.folder, "log", "", LOG_COLLAPSE)}`;
}

function deleteSession(folder) {     // §6.5: папка наблюдения - в корзину
  modal(`<div class="dlg" style="width:420px"><div class="dh"><h2>${t("Удалить наблюдение?")}</h2><span class="note">${t("Папка {name} (реестр, журнал, планы) будет перемещена в корзину Windows.", {name: h(folder)})}</span></div>
    <div class="df"><a class="btn" onclick="closeModal()">${t("Отмена")}</a><a class="btn dark" onclick="doDeleteSession(${h(JSON.stringify(folder))})">${t("В корзину")}</a></div></div>`);
}
async function doDeleteSession(folder) {
  try {
    await api("delete_session", folder);
    closeModal();
    const open = S.view.folder === folder || (S.view.k === "compare" && (S.view.a === folder || S.view.b === folder));
    if (open) { S.view = {k: "empty"}; S.history = []; }
    await refresh();
    if (open) renderMain();
    toast(t("Перемещено в корзину"));
  } catch (e) { fail(e); }
}

// ================================================================ обновление живых экранов
function updateLive() {
  const v = S.view;
  if (v.k === "run" && S.procs[v.pid] && $("#r-stack")) updateRun(S.procs[v.pid]);
  if (v.k === "session" && S.procs[v.pid]) updateSession(S.procs[v.pid]);
  if (v.k === "compare" && S.procs[v.pid] && !S.procs[v.pid].info.running && !S.live.shown) { S.live.shown = true; renderMain(); }
  renderSideLight();
}
let sideTimer = 0;
function renderSideLight() {        // счетчики прогонов в дереве - не чаще раза в секунду
  if (Date.now() - sideTimer < 1000) return;
  sideTimer = Date.now();
  renderSide();
}

// ================================================================ старт
async function start() {
  T.list = [T.cur = {id: ++T.seq, view: S.view, history: S.history, live: S.live, node: null}];
  await refresh();
  // язык: из настроек ("GUI".lang), при первом запуске - системный (и запоминается)
  const lang = (S.st && S.st.lang) || systemLang();
  try { await setLang(lang); } catch (e) { fail(e); }
  if (S.st && !S.st.lang) { S.st.lang = LANG; api("set_gui", "lang", LANG).catch(fail); }
  renderSide();
  renderMain();
  if (S.st && S.st.no_connection) showConnTip();
  setInterval(poll, 250);
  setInterval(refresh, 5000);
  requestAnimationFrame(tick);
}
let started = false;
function startOnce() { if (!started) { started = true; start(); } }
// окно: старт, когда мост pywebview готов (событие или уже готов); --dev - сразу
window.addEventListener("pywebviewready", startOnce);
if (window.CQ_DEV || (window.pywebview && window.pywebview.api && window.pywebview.api.state)) startOnce();
window.addEventListener("resize", () => fitHint());
