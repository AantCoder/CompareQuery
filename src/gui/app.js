// CompareQuery GUI: интерфейс (экраны и компоненты - GUI.md). Данные - через api() из CompareQueryGUI.py.
"use strict";

// строка внизу левой панели (под «Справка»); ссылка открывается в браузере
const ABOUT_TEXT = "v1.0 · © 2026 Ant · MIT License ·";
const ABOUT_LINK = {text: "GitHub", url: "https://github.com/"};

// ================================================================ связь с Python
function api(name, ...args) {
  if (window.pywebview && window.pywebview.api) return window.pywebview.api[name](...args);
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
};

// ================================================================ мелочи
const h = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
// \u0447\u0438\u0441\u043b\u0430 - \u043f\u043e \u044f\u0437\u044b\u043a\u0443 \u0438\u043d\u0442\u0435\u0440\u0444\u0435\u0439\u0441\u0430: 1 234 567 (ru) \u0438\u043b\u0438 1,234,567 (en)
const nf = v => v === null || v === undefined || v === "" || isNaN(+v) ? (v ?? "") : (+v).toLocaleString(LANG === "ru" ? "ru-RU" : "en-US").replace(/\u00a0/g, " ");
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
document.addEventListener("scroll", qtipHide, true);
// Контекстное меню строки таблицы (правая кнопка): те же действия, что кнопки в начале строки
// (td.acts2), с подписями из их подсказок; при выделенном тексте первым пунктом - «Скопировать».
document.addEventListener("contextmenu", e => {
  const tr = e.target.closest && e.target.closest("tr");
  if (!tr) return;
  const btns = [...tr.querySelectorAll("td.acts2 .ib:not(.off)")];     // кнопок-столбцов может быть несколько
  if (!btns.length) return;
  e.preventDefault();
  qtipHide();
  ctxClose();
  const sel = String(window.getSelection() || "");
  const m = document.createElement("div");
  m.id = "ctxm";
  m.className = "ctxm";
  m.innerHTML = (sel ? `<a data-i="copy">${I.copy(14)}<span>${t("Скопировать")}</span></a><hr>` : "") +
    btns.map((b, i) => `<a data-i="${i}" class="${b.classList.contains("danger") ? "danger" : ""}">${b.innerHTML}<span>${h(b.getAttribute("title") || b.dataset.qtip || "")}</span></a>`).join("");
  m.addEventListener("click", ev => {
    const a = ev.target.closest("a");
    if (!a) return;
    ctxClose();
    if (a.dataset.i === "copy") navigator.clipboard.writeText(sel).then(() => toast(t("Скопировано")), fail);
    else btns[+a.dataset.i].click();
  });
  document.body.appendChild(m);
  m.style.left = Math.min(e.clientX, innerWidth - m.offsetWidth - 6) + "px";
  m.style.top = Math.min(e.clientY, innerHeight - m.offsetHeight - 6) + "px";
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
  input: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5M3 12h11M10 8l4 4-4 4"/></svg>`,
  kill: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>`,
  pulse: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.5-6 4 12 2.5-6H21"/></svg>`,
  flame: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2.5 1.5-4 2.5-5 .3 1.6 1 2.6 2 3 .5-2.5-.5-5.5.5-8z"/></svg>`,
  cols: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M9.5 4v16M14.5 4v16"/></svg>`,
  filter: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 5h16l-6.5 7.5V19l-3-1.5v-5z"/></svg>`,
  diff: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="7.5" height="16" rx="1.5"/><rect x="13.5" y="4" width="7.5" height="16" rx="1.5"/><path d="M6 9h2M6 13h2M16.5 9h2M16.5 13h2"/></svg>`,
  save: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 4h11l3 3v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/></svg>`,
};

// категории ожиданий (§5.3)
function waitCat(name) {
  const n = (name || "").toUpperCase();
  if (n.startsWith("LCK_M_")) return "lock";
  if (/^(PAGEIOLATCH|WRITELOG|IO_COMPLETION|ASYNC_IO_COMPLETION|LOGBUFFER)/.test(n)) return "disk";
  if (/^(RESOURCE_SEMAPHORE|CMEMTHREAD|MEMORY_ALLOCATION_EXT)/.test(n)) return "mem";
  if (/^(SOS_SCHEDULER_YIELD|THREADPOOL)/.test(n)) return "cpu";
  if (/^(CXPACKET|CXCONSUMER|CXSYNC_)/.test(n)) return "par";
  if (/^(PAGELATCH|LATCH_)/.test(n)) return "latch";
  if (n === "ASYNC_NETWORK_IO") return "net";
  return "oth";
}
const waitHtml = name => `<span class="w w-${waitCat(name)}">${h(name)}</span>`;

// ================================================================ навигация (§5.12)
function titleOf(v) {
  switch (v.k) {
    case "script": return v.name;
    case "run": return t("Идет запуск");
    case "result": return t("Итог запуска {when}", {when: tsText((v.report.match(/_(\d{8}_\d{6})/) || [])[1])});
    case "table": return t("Таблица {n}", {n: v.n});
    case "compare": return t("Сравнение");
    case "newsession": return t("Новое наблюдение");
    case "session": return t("Идет наблюдение");
    case "current": return t("Текущие запросы");
    case "heavy": return t("Тяжелые запросы");
    case "sessiondone": return t("Итог наблюдения · сессия {n}", {n: (v.folder.match(/^Session_\d{8}_\d{6}_(\d+)/) || [])[1]});
    default: return "";
  }
}
function go(v, replace) {
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
  return prev ? `<a class="back" onclick="back()">${I.back(14)}${h(titleOf(prev.view))}</a>` : `<span class="ctxl">${h(S.st ? S.st.folder : "")}</span>`;
}
window.addEventListener("keydown", e => {
  if (e.altKey && e.key === "ArrowLeft") { back(); e.preventDefault(); }
  if (e.key === "Escape") { if ($("#modal").innerHTML) closeModal(); else if (S.pair.length) { S.pair = []; renderSide(); } }
  // e.code - физическая клавиша: сочетания работают в любой раскладке
  if (e.ctrlKey && e.code === "KeyS" && S.view.k === "script") { e.preventDefault(); saveScript(true).catch(fail); }
  if (e.ctrlKey && e.code === "KeyF" && S.view.k === "table") { e.preventDefault(); const i = $("#t-flt"); if (i) i.focus(); }
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
    p.events.push(x.ev);
    if (x.ev.event === "exit") { ended = true; onExit(p); }
    if (x.ev.event === "flush" && S.view.k === "session" && S.view.pid === x.proc) loadSessionTables(p);
  }
  S.seq = r.seq;
  if (r.events.length) updateLive();
  if (ended) refresh();
}
function onExit(p) {
  const i = p.info, v = S.view;
  if (i.kind === "run" && v.k === "run" && v.pid === i.id) {
    if (i.report) go({k: "result", report: baseName(i.report)}, true);
    else renderMain();
  } else if (i.kind === "session" && v.k === "session" && v.pid === i.id) {
    const st = p.events.find(e => e.event === "start");
    if (st) go({k: "sessiondone", folder: baseName(st.folder)}, true);
  } else if (i.kind === "compare" && v.k === "compare" && v.pid === i.id) renderMain();
  if (i.kind === "run") toast(i.code === 0 ? t("{name}: запуск завершен", {name: i.title}) : t("{name}: запуск завершен с кодом {code}", {name: i.title, code: i.code}));
  if (S.autodetect && S.autodetect.pid === i.id) autodetectDone(i);
  notifyDone(p);
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
  const st = S.st;
  if (!st) return;
  const v = S.view, c = st.connection;
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
    tree += `<div class="ti s${on ? " on" : ""}"${inGroup && g === lastGroup ? ' style="margin-top:0"' : ""} onclick="go({k:'script',name:${h(JSON.stringify(s.name))}})">
      <span class="chev" onclick="event.stopPropagation();toggleCollapsed('s:${h(s.stem)}')">${scl ? I.right(12) : I.down(12)}</span>${h(s.name)}
      <span class="end">${scl && (s.runs.length || busy.length) ? `<span class="cnt">${s.runs.length}</span>` : ""}${scl && busy.length ? '<span class="pulse"></span>' : ""}
      ${s.missing ? "" : `<span class="hv${s.ignored ? " on" : ""}" title="${t("Игнорируемые колонки")}${s.ignored ? ": " + s.ignored : ""}" onclick="event.stopPropagation();ignoreDialog(${h(JSON.stringify(s.name))})">${I.filter(15)}</span>`}
      ${s.missing ? "" : `<span class="hv" title="${t("Новый запуск")}" onclick="event.stopPropagation();startRun(${h(JSON.stringify(s.name))})">${I.play(16).replace('fill="currentColor"', 'fill="#3B5BDB"')}</span>`}</span></div>`;
    if (scl) continue;
    for (const p of busy) {
      const pass = [...p.events].reverse().find(e => e.event === "pass");
      tree += `<div class="ti r${v.k === "run" && v.pid === p.info.id ? " on" : ""}" onclick="go({k:'run',pid:${p.info.id}})"><span class="star"><span class="pulse"></span></span>
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
    for (const p of sessProcs) tree += `<div class="ti r${v.k === "session" && v.pid === p.info.id ? " on" : ""}" onclick="go({k:'session',pid:${p.info.id}})"><span class="star"><span class="pulse g"></span></span>${h(String(p.info.title).replace(/\D+/g, ""))} <span class="pale" style="font-weight:500">· ${h(procWhen(p))}</span></div>`;
    const live = new Set(sessProcs.map(p => (p.events.find(e => e.event === "start") || {}).folder).filter(Boolean).map(baseName));
    for (const x of st.sessions) {
      if (live.has(x.folder)) continue;
      tree += `<div class="ti r${v.k === "sessiondone" && v.folder === x.folder ? " on" : ""}" onclick="go({k:'sessiondone',folder:${h(JSON.stringify(x.folder))}})"><span class="star"></span>${x.spid} <span class="pale">· ${h(tsText(x.ts))}</span></div>`;
    }
  }
  const nruns = st.scripts.reduce((n, s) => n + s.runs.filter(r => !r.aborted).length, 0);
  const hints = [];
  if (!st.scripts.length) hints.push(t("Создайте скрипт или положите .sql в рабочую папку"));
  else if (!st.reference && nruns) hints.push(t("Отметьте ★ запуск — с ним будут сравниваться остальные"));
  else if (st.reference) hints.push(t("Открытый запуск сравнивается с опорным&nbsp;★. Переставьте&nbsp;★ на другой запуск, чтобы сравнивать с ним"));
  if (nruns >= 2) hints.push(t("Ctrl+клик по второму запуску — сравнить два любых"));
  const side = $("#side"), html = `
    <div style="display:flex;flex-direction:column;gap:2px">
      <div class="ctx" title="${t("Выбрать рабочую папку")}" onclick="chooseFolder()">${I.folder(18)}<span class="t"><b>${h(st.folder_name)}</b><span>${h(st.folder)}</span></span>${I.down(14)}</div>
      <div class="ctx" id="conn-ctx" title="${t("Изменить подключение и настройки")}" onclick="connDialog()">${I.db(18)}<span class="t"><b>${h(c.database || t("база не указана"))}</b><span>${h(c.server || t("сервер не указан"))}</span></span>${I.pen(15)}</div>
    </div>
    <a class="btn pri" onclick="needConn()||newScriptDialog()">${I.plus(18)}${t("Новый скрипт")}</a>
    <a class="btn" style="margin-top:-4px" onclick="needConn()||go({k:'newsession'})">${I.eye(18)}${t("Наблюдать сессию")}</a>
    <nav class="tree">${tree}</nav>
    ${S.pair.length === 2 ? `<div class="pairbar"><span>${t("Выбрано 2 запуска")}</span><a class="btn sm pri" style="height:32px" onclick="comparePair()">${t("Сравнить")}</a></div>` : ""}
    <div class="hint">${S.pair.length === 2 ? "" : hints.map(x => `<span>${x}</span>`).join("")}</div>
    <div class="menu">
      <a class="${v.k === "current" ? "on" : ""}" onclick="needConn()||go({k:'current'})">${I.pulse(18)}${t("Текущие запросы")}</a>
      <a class="${v.k === "heavy" ? "on" : ""}" onclick="needConn()||go({k:'heavy'})">${I.flame(18)}${t("Тяжелые запросы")}</a>
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
  const on = (v.k === "result" || v.k === "table") && v.report === r.report, pk = S.pair.includes(r.report);
  let end = "";
  if (isRef) end = `<span class="cnt">${t("опорный")}</span>`;
  else if (r.aborted) end = `<span class="abt" title="${h(t("Запуск прерван: {why}", {why: r.aborted}))}">${t("прерван")}</span>`;
  else if (r.comparable === false) end = `<span class="inc" title="${h(t("Несравним с опорным: {why}", {why: r.why}))}">${t("несравним")}</span>`;
  else if (r.delta !== undefined && r.delta !== null)
    end = `<span class="d ${r.delta > 0 ? "up" : "down"}">${r.delta > 0 ? "+" : r.delta < 0 ? "−" : "±"}${Math.abs(r.delta)}%</span>` +
          (r.same ? `<span class="eq" style="color:#17714A" title="${t("Данные совпадают")}">=</span>` : `<span class="eq up" title="${t("Данные различаются")}">≠</span>`);
  const star = isRef ? `<span class="star" title="${t("Опорный запуск")}">${I.star(15, true)}</span>`
    : r.aborted ? `<span class="star"></span>`
    : `<span class="star" title="${t("Сделать опорным")}" onclick="event.stopPropagation();setReference(${h(JSON.stringify(r.report))})"><span class="hollow">${I.star(15)}</span></span>`;
  return `<div class="ti r${on ? " on" : ""}${pk ? " pk" : ""}" onclick="runClick(event,${h(JSON.stringify(r.report))})">${star}${tsText(r.ts, sec)}${r.note ? `<span class="nt" title="${h(t("Заметка: {note}", {note: r.note}))}">${I.note(13)}</span><span class="ntx" title="${h(r.note)}">${h(r.note)}</span>` : ""}<span class="end">${end}</span></div>`;
}
function runClick(e, report) {
  if (e.ctrlKey) {
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
  startCompare(a, b);
}
async function setReference(report) {
  try { await api("set_reference", report); await refresh(); renderMain(); } catch (e) { fail(e); }
}
async function chooseFolder() {
  try {
    if (!window.pywebview) {
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
function modal(html) { $("#modal").innerHTML = `<div class="overlay" onclick="if(event.target===this)closeModal()">${html}</div>`; const i = $("#modal input"); if (i) i.focus(); }
function closeModal() { $("#modal").innerHTML = ""; }
// Настройки (§5.6): сохраненные подключения - выпадающий список «сервер — база — логин», ниже поля
// выбранного; значки «добавить как новое» и «убрать из списка», «Проверить» - вход и легкий запрос с
// введенными значениями. «Сохранить» делает выбранное подключение активным (его использует CLI).
// Пароли в интерфейс не приходят: пустое поле - «не менять».
const CONN_NEW = "__new";
const connLabel = c => `${c.server || "?"} — ${c.database || "?"} — ${c.login || t("вход Windows")}`;
async function connDialog() {
  let d;
  try { d = await api("connections"); } catch (e) { fail(e); return; }
  window._cn = {items: d.items, active: d.active, sel: d.active || (d.items[0] || {}).id || null};
  modal(`<div class="dlg" style="width:620px"><div class="dh"><h2>${t("Настройки")}</h2><span class="note">${t("Хранится в CompareQuery.json рядом с CompareQuery.py. Пароль не показывается и не попадает в логи и отчеты.")}</span></div>
    <div class="db">
      <section class="ignb">
        <span class="lbl">${t("Подключение")}</span>
        <div style="display:flex;gap:6px;align-items:center"><select class="inp" id="cn-sel" style="flex:1;min-width:0" onchange="connPick(this.value)"></select>
          <span class="ib" title="${t("Добавить как новое подключение")}" onclick="connAdd()">${I.plus(17)}</span>
          <span class="ib" title="${t("Убрать подключение из списка")}" onclick="connDelete()">${I.trash(17)}</span></div>
        <label class="field"><span class="lbl">${t("Строка подключения")}</span><input class="inp mono" id="cs" style="font-size:13px" oninput="connDirty()"></label>
        <div style="display:flex;gap:12px">
          <label class="field" style="flex:1"><span class="lbl">${t("Логин (пусто — вход Windows)")}</span><input class="inp" id="lg" oninput="connDirty()"></label>
          <label class="field" style="flex:1"><span class="lbl">${t("Пароль")}</span><input class="inp" id="pw" type="password" oninput="connDirty()"></label>
        </div>
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
  if (!cur) $("#cs").focus();
}
function connPick(id) { window._cn.sel = id === CONN_NEW ? null : id; connFill(); }
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
    res.textContent = t("Подключено за {ms} мс: {server} / {db} · {login} · SQL Server {version}", {ms: nf(r.ms), server: r.server || "?", db: r.database || "?", login: r.login || "?", version: [r.version, r.edition].filter(Boolean).join(" ")});
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
    await api("save_connection", c.sel, cs, $("#lg").value, connPw(), true, null);
    await api("set_gui", "diff_tool", $("#dt").value.trim());
    await api("set_gui", "notify", $("#nt").classList.contains("on"));
    closeModal();
    toast(t("Настройки сохранены"));
    await refresh();
    if (S.view.k === "empty") renderMain();       // текст «Для начала задайте подключения…» уходит
  } catch (e) { fail(e); }
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
    <div class="db"><input class="inp" id="nsn" placeholder="query_v3.sql" onkeydown="if(event.key==='Enter')createScript()"></div>
    <div class="df"><a class="btn" onclick="closeModal()">${t("Отмена")}</a><a class="btn pri" onclick="createScript()">${t("Создать")}</a></div></div>`);
}
async function createScript() {
  try { const name = await api("new_script", $("#nsn").value); closeModal(); await refresh(); go({k: "script", name}); } catch (e) { fail(e); }
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
             newsession: viewNewSession, session: viewSession, sessiondone: viewSessionDone, current: viewCurrent, heavy: viewHeavy}[v.k];
  if (!f) { m.innerHTML = `<div class="empty" style="margin-top:30vh">${S.st && S.st.no_connection ? t("Для начала задайте подключения к базе") : t("Выберите скрипт или запуск слева")}</div>`; return; }
  f(m, v);
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
        ${refScript && refScript.toLowerCase() !== v.name.toLowerCase() ? diffButton(t("Сравнить с опорным"), "script", [v.name]) : ""}
        <a class="btn" onclick="api('open_path', ${h(JSON.stringify(S.st.folder + "\\" + v.name))}).catch(fail)" title="${t("Открыть программой по умолчанию")}">${I.open(17)}${t("Открыть файл")}</a>
        <a class="btn pri" onclick="saveAndRun()">${I.play(16)}${t("Запустить")}</a>
      </div></header>
    <section class="card" style="padding:14px 20px;display:flex;flex-wrap:wrap;align-items:center;gap:28px">
      <span class="lbl">${t("Параметры запуска")}</span>
      <span class="popt">${t("Повторов")} <input class="num" id="p-rep" type="number" min="1" max="20" value="${p.repeat}" oninput="$('#p-warm').style.visibility=+this.value>1?'':'hidden'"><span class="pale" id="p-warm" style="font-size:12px${p.repeat > 1 ? "" : ";visibility:hidden"}">${t("первый — прогрев")}</span></span>
      <span class="popt" onclick="this.firstChild.classList.toggle('on')"><span class="sw${p.profile ? " on" : ""}" id="p-prof"></span>${t("Профиль операторов")}</span>
      <span class="popt" onclick="this.firstChild.classList.toggle('on')"><span class="sw${p.rollback ? " on" : ""}" id="p-rb"></span>${t("Откат в конце (--rollback)")}</span>
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
  ta.focus();
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
async function saveAndRun() {
  try {
    await saveScript();
    const suggest = $("#p-ign").classList.contains("on");
    const p = {repeat: suggest ? 2 : Math.max(1, +$("#p-rep").value || 1), profile: $("#p-prof").classList.contains("on"), rollback: $("#p-rb").classList.contains("on")};
    if (!suggest) {
      S.st.params = Object.assign({}, S.st.params, {[S.view.name]: p});
      api("set_gui", "params", S.st.params).catch(fail);
    }
    startRun(S.view.name, Object.assign({suggest}, p));
  } catch (e) { fail(e); }
}
function startRun(name, p, force) {
  p = p || Object.assign({repeat: 1, profile: true, rollback: false}, (S.st.params || {})[name]);
  const busy = Object.values(S.procs).find(x => x.info.kind === "run" && x.info.running);
  if (busy && !force) {          // §6.6: второй запуск - после предупреждения
    window._pending = [name, p];
    modal(`<div class="dlg" style="width:420px"><div class="dh"><h2>${t("Уже идет запуск")}</h2><span class="note"><b style="color:#1B2230">${h(busy.info.title)}</b>. ${t("Два запуска одновременно сильнее нагружают сервер и влияют на замеры друг друга.")}</span></div>
      <div class="df" style="border-top:none"><a class="btn" onclick="closeModal();startRun(..._pending, true)">${t("Запустить все равно")}</a><a class="btn pri" onclick="closeModal()">${t("Отмена")}</a></div></div>`);
    return;
  }
  api("start_run", name, p.repeat, p.profile, p.rollback).then(info => {
    S.procs[info.id] = {info, events: []};
    if (p.suggest) S.autodetect = {pid: info.id, script: name};      // по окончании - окно игнорируемых колонок
    go({k: "run", pid: info.id});
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
function setKpi(id, v, ms) {
  setRoll($("#" + id), nf(v ?? 0));
  const d = $("#" + id + "-d");
  if (d) { if (ms && v >= 1000) setRoll(d, dur(v)); else { d.innerHTML = "&nbsp;"; delete d.dataset.v; } }
}
// плашка задержек выборки (--profile, --session): ответ сервера на опрос дольше 80 мс; больше 1 с всего -
// красная рамка. slow - {count, ms} или null (нет данных)
const SLOW_WARN_MS = 1000;
function slowBox(id, slow, hidden) {
  const c = slow ? slow.count : 0, ms = slow ? slow.ms : 0;
  return `<div class="card kpi slowk${ms > SLOW_WARN_MS ? " warn" : ""}" id="${id}"${hidden ? ' style="display:none"' : ""}>
    <span class="lbl">${t("Задержки выборки")}</span>
    <span class="v"><span class="c">${nf(c)}</span> <small>· <span class="m">${nf(ms)}</span> ${t("мс")}</small></span>
    <span class="sn">${t("Ответы сервера на опрос дольше 80 мс. Чем их больше, тем менее точно время распределено по операторам")}</span></div>`;
}
function setSlow(id, count, ms) {
  const el = $("#" + id);
  if (!el) return;
  el.style.display = "";
  el.classList.toggle("warn", ms > SLOW_WARN_MS);
  el.querySelector(".c").textContent = nf(count);
  el.querySelector(".m").textContent = nf(ms);
}

// бегущее время: элементы с data-t0 (мс эпохи) и необязательным data-t1 (остановлено)
function tick() {
  const now = Date.now();
  if (qtipEl && !qtipEl.isConnected) qtipHide();      // элемент с подсказкой перерисован (таблица раз в 4 с)
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
      <div class="row" id="r-params"></div></div>
      <a class="btn" id="r-stop" style="color:#9A3412" title="${t("Текущий оператор на сервере отменяется сразу")}" onclick="api('stop', ${i.id})">${I.stop(14)}${t("Остановить")}</a></header>
    <section class="card" style="padding:22px 24px;display:flex;flex-direction:column;gap:16px">
      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:12px">
        <span style="font-size:18px;font-weight:700" id="r-pos">${t("Подключение…")}</span>
        <span class="tm" id="r-ptm" style="font-size:26px;font-weight:500;color:#2D3646"></span></div>
      <div class="track"><div class="seg" id="r-seg"></div><div class="fill" id="r-fill" style="width:2%"></div></div>
      <div style="display:flex;flex-wrap:wrap;gap:28px" id="r-steps"></div>
    </section>
    <section class="stack" id="r-stack"></section>
    <section class="kpis">${kpiBox("k-t", "Время", "мс")}${kpiBox("k-c", "CPU", "мс")}${kpiBox("k-r", "Логических чтений")}${kpiBox("k-n", "Таблиц получено")}${slowBox("k-slow", null, true)}</section>
    <section class="card tw${tcolCls("journal")}">${tcolBtn("journal")}<div class="tbar"><h2>${t("Журнал")}</h2><span class="lbl">${t("ход выполнения и сообщения SQL (PRINT, RAISERROR, ошибки) · время сервера · новые строки снизу")}</span></div>
      <div class="logbox" id="r-log"></div></section>`;
  S.live = {cards: [], log: 0};
  if (!S.live.script) api("read_script", i.script + ".sql").then(s => { S.live.script = s.text; updateLive(); }).catch(() => {});
  updateLive();
}
function opcHtml(title, text, t0) {      // карточка оператора или батча в стопке (§5.10)
  return `<div class="oph"><span class="lbl now">${t("Сейчас выполняется")}</span><span class="wbox"></span><span class="tm optm" data-t0="${t0}"></span></div>
      <div class="opb"><div class="opn">${title}</div><div class="opx" title="${h(text)}">${h(text)}</div></div>`;
}
// Стопка «Сейчас выполняется» (§5.10): текущая карточка, прошлая и позапрошлая, тающая маской.
// Смена: новая карточка сразу встает на свое место под прежними, прежние едут со своих мест на позицию
// ниже с замедлением (settleMs) и открывают ее; открываясь, новая коротко вспыхивает (рамка и фон ярче -
// резко, затем плавно обратно, flashMs; только внутри своей рамки, поэтому прежнюю не красит, а пока
// прежняя ее накрывает, вспышки не видно - она начинается с задержкой flashDelay). Пока карточка не простояла holdMs, пришедшие ждут;
// показывается последняя из них (быстрые операторы пропускаются, они есть в журнале и реестре).
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
function batchText(script, k) {        // первые строки батча k из файла скрипта (для запуска без --profile)
  if (!script) return "";
  const parts = script.split(/^[ \t]*go[ \t]*(?:--.*)?$/im);
  return (parts[k - 1] || "").trim().split("\n").slice(0, 2).join(" ");
}
function updateRun(p) {
  const i = p.info, ev = p.events, L = S.live;
  const start = ev.find(e => e.event === "start");
  if (start && !L.params) {
    L.params = true;
    $("#r-params").innerHTML = (start.repeat > 1 ? `<span class="chip">${t("повторов {n}", {n: start.repeat})}</span>` : "") +
      (start.profile ? `<span class="chip">${t("профиль")}</span>` : "") + `<span class="chip">${start.rollback ? "rollback" : "autocommit"}</span>`;
    if (start.profile) setSlow("k-slow", 0, 0);
  }
  if (!L.when && srvOffset(p)) { L.when = true; $("#r-when").textContent = procWhen(p); }
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
      setSlow("k-slow", s ? s.count : 0, s ? s.ms : 0);
    }
  }
  // текущая работа: операторы (--profile) или батчи
  const items = ev.filter(e => e.event === "statement" || e.event === "idle" || (!start?.profile && e.event === "batch"));
  while (L.cards.length < items.length) {
    const e = items[L.cards.length], prev = L.cards[L.cards.length - 1];
    if (prev) finishCard(prev, evMs(e));
    if (e.event === "idle") { L.cards.push(null); continue; }
    const el = document.createElement("div");
    el.className = "opc";
    const title = e.event === "batch" ? `${t("Батч {k}", e)} <span>${t("из {of}", e)}${e.ignored ? " · " + t("служебный") : ""}</span>` : `${h(e.object)} <span>${t("строка {n}", {n: e.line})}</span>`;
    const text = e.event === "batch" ? batchText(L.script, e.k) : e.text;
    el.innerHTML = opcHtml(title, text, evMs(e));
    L.cards.push(el);
    if (e.wait) setWait(el, e.wait, e.blocked_by, evMs(e));
    stackShow(el, start?.profile ? 3 : Math.min(3, e.of || 3));
  }
  const cur = L.cards[L.cards.length - 1];
  if (cur) {                             // ожидание текущего оператора (§5.8); карточка может ждать показа
    const lastStmt = items[items.length - 1];
    const waits = ev.filter(e => e.event === "wait" && evMs(e) >= evMs(lastStmt));
    const w = waits[waits.length - 1];
    if (w && w !== L.lastWait) { L.lastWait = w; setWait(cur, w.wait, w.blocked_by, evMs(w)); }
  }
  if (i.code !== null && cur) finishCard(cur, Date.now());
  // журнал: строки CompareQuery и сообщения SQL в порядке поступления, время сервера
  const logs = ev.filter(e => e.event === "log" || e.event === "message"), box = $("#r-log");
  if (box && logs.length > L.log) {
    const bottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;   // прокрутка вниз, если журнал внизу
    for (const e of logs.slice(L.log)) {
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
    L.log = logs.length;
    if (bottom) box.scrollTop = box.scrollHeight;
  }
  if (i.code !== null) {
    if (!pass) $("#r-pos").textContent = t("Запуск не выполнен");
    $("#r-chip").innerHTML = i.code === 0 ? t("завершен") : t("завершен с кодом {code}", {code: i.code});
    $("#r-stop").setAttribute("disabled", "");
  }
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
    verdict = ref.same
      ? `<div class="card verdict v-ok"><span class="ic">=</span><span style="display:flex;flex-direction:column;gap:3px"><span style="font-size:18px;font-weight:700">${t("Данные совпадают с опорным")}</span><span class="lbl">${tail}</span></span><a class="btn sm" style="margin-left:auto" onclick="startCompare(${h(JSON.stringify(ref.report))}, ${h(JSON.stringify(v.report))})">${t("Подробнее")}</a></div>`
      : `<div class="card verdict v-diff" style="cursor:pointer" onclick="startCompare(${h(JSON.stringify(ref.report))}, ${h(JSON.stringify(v.report))})"><span class="ic">≠</span><span style="display:flex;flex-direction:column;gap:3px"><span style="font-size:18px;font-weight:700">${t("Данные различаются с опорным в {n} табл. из {of}", {n: ref.diff_tables.length, of: Object.keys(r.tables).length})}</span><span class="lbl">${tail}</span></span><span class="btn sm" style="margin-left:auto">${t("Подробнее")}</span></div>`;
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
  const chips = [r.run["Прогонов"] ? t("повторов {n}", {n: r.run["Прогонов"]}) : "", r.run["Реестр"] ? t("профиль") : "", r.run["Режим"] || ""].filter(Boolean).map(x => `<span class="chip">${h(x)}</span>`).join("");
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
    <section class="kpis">${kpi("Время", "time", true)}${kpi("CPU", "cpu", true)}${kpi("Логических чтений", "reads")}${kpi("Ожидание клиента", "client", true)}${r.slow ? slowBox("r-slow", r.slow) : ""}</section>
    <section class="card tw${tcolCls("results")}">${tcolBtn("results")}<div class="tbar"><h2>${t("Таблицы результата")}</h2></div>${tables}</section>
    ${r.journal && r.journal.length ? journalCard(r.journal) : ""}
    ${r.aborted ? "" : lineCard(r)}
    ${r.registry ? tableCard("reg", t("Реестр операторов"), (r.run["Прогонов"] > 1 ? t("медиана прогонов 2–{n}", {n: r.run["Прогонов"]}) : "") + " · registry.csv", REG_COLS, r.registry, r.registry_dir + "\\registry.csv", r.registry_dir, "reg") : ""}
    ${r.log ? tableCard("log", t("Журнал выполнения"), "log.csv", LOG_COLS, r.log, r.registry_dir + "\\log.csv", r.registry_dir, "log", "", LOG_COLLAPSE) : ""}`;
  if (r.line && r.line.length >= 2) drawLine(r.line, v.report);
}
// журнал хода запуска из файла <запуск>_message.txt: как журнал идущего запуска; длинный свернут по умолчанию
function journalCard(rows) {
  const line = e => e.tag ? `<div class="logl msg${e.tag === "Ошибка" ? " err" : ""}"><span>${h(e.time)}</span><span><b class="tagm">${e.tag === "Ошибка" ? t("ошибка") : "SQL"}</b>${h(e.text)}</span></div>`
    : `<div class="logl"><span>${h(e.time)}</span><span>${h(e.text)}</span></div>`;
  const msgs = rows.filter(e => e.tag).length;
  return `<section class="card tw${tcolCls("journal", rows.length > LOG_COLLAPSE)}">${tcolBtn("journal")}<div class="tbar"><h2>${t("Журнал")}</h2><span class="lbl">${t("ход выполнения и сообщения SQL (PRINT, RAISERROR, ошибки) · время сервера")} · ${t("сообщений SQL: {n}", {n: nf(msgs)})}</span></div>
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
function diffHtml(d, na = "опорный", nb = "этот") {     // na, nb - как назвать A и B
  const low = d.names.map(x => x.toLowerCase());
  const key = d.key.map(x => low.indexOf(x.toLowerCase())).filter(i => i >= 0);
  const changed = new Set(d.examples.flatMap(e => e.cols || []));
  // колонки: ключ и отличающиеся; если отличий в сопоставленных строках нет - все колонки
  const cols = changed.size ? key.concat(d.names.map((_, j) => j).filter(j => changed.has(j) && !key.includes(j))) : d.names.map((_, j) => j);
  const val = x => x === null ? '<span class="pale">NULL</span>' : h(x);
  const kinds = {diff: t("изменена"), A: na === "опорный" ? t("только в опорном") : t("только в {x}", {x: na}), B: nb === "этот" ? t("только в этом") : t("только в {x}", {x: nb})};
  const rows = d.examples.map(e => {
    const row = e.kind === "diff" ? e.b : e.row;
    return `<tr class="k-${e.kind}"><td><span class="dk">${kinds[e.kind]}</span></td>` + cols.map(j =>
      e.kind === "diff" && e.cols.includes(j) ? `<td><span class="old">${val(e.a[j])}</span> → <span class="new">${val(e.b[j])}</span></td>`
        : `<td${key.includes(j) ? ' class="b"' : ""}>${val(row[j])}</td>`).join("") + "</tr>";
  }).join("");
  const full = ["diff", "A", "B"].some(k => d.examples.filter(e => e.kind === k).length >= d.limit);
  return `<div class="dsum">${d.lines.map(x => `<span>${h(x)}</span>`).join("")}${na === "опорный" ? `<span class="pale">${t("A — опорный запуск, B — этот")}</span>` : ""}</div>` +
    (rows ? `<div class="tscroll"><table class="t compact"><thead><tr><th></th>${cols.map(j => `<th>${h(d.names[j])}${changed.has(j) ? ` <span class="pale">${h(na === "опорный" ? t("опорный") : na)} → ${h(nb === "этот" ? t("этот") : nb)}</span>` : ""}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`
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
async function saveNote(report, text) {   // заметка к запуску (§5.16): раздел "GUI" json
  text = text.trim();
  const cur = {};
  for (const sc of S.st.scripts) for (const r of sc.runs) if (r.note) cur[r.report] = r.note;
  if ((cur[report] || "") === text) return;
  if (text) cur[report] = text; else delete cur[report];
  try { await api("set_gui", "notes", cur); refresh(); } catch (e) { fail(e); }
}
function deleteRun(report) {
  modal(`<div class="dlg" style="width:420px"><div class="dh"><h2>${t("Удалить запуск?")}</h2><span class="note">${t("Отчет {name}, его CSV, папка реестра и файлы сравнения будут перемещены в корзину Windows.", {name: h(report)})}</span></div>
    <div class="df"><a class="btn" onclick="closeModal()">${t("Отмена")}</a><a class="btn dark" onclick="doDelete(${h(JSON.stringify(report))})">${t("В корзину")}</a></div></div>`);
}
async function doDelete(report) {
  try { await api("delete_run", report); closeModal(); S.view = {k: "empty"}; S.history = []; await refresh(); renderMain(); toast(t("Перемещено в корзину")); } catch (e) { fail(e); }
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
    return `<td class="op b" title="${h(row["Начало текста"] || "")}"><span class="opl"><span>${h(v)}</span>${runs}</span><span class="sv">${h(row["Начало текста"] || "")}</span></td>`;
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
  const card = b.closest(".tw"), on = !card.classList.contains("tcl");
  card.classList.toggle("tcl", on);
  S.st.tcollapsed = Object.assign({}, S.st.tcollapsed, {[key]: on});
  api("set_gui", "tcollapsed", S.st.tcollapsed).catch(fail);
  if (!on) { if (card._render) card._render(); card.querySelectorAll(".tscroll").forEach(hbar); }
}
// кнопка «Колонки» таблицы вида kind; ref - выражение JS с объектом {keys, titles, render}
const colsBtn = (kind, ref) => `<span class="ib" title="${t("Колонки: показать или скрыть")}" onclick="colsDialog(${h(JSON.stringify(kind))}, ${ref}.keys, ${ref}.titles, ${ref}.render)">${I.cols(15)}</span>`;

// collapseOver - свернута по умолчанию, если строк больше (журнал: не грузить страницу); строки свернутой
// таблицы строятся при разворачивании. У строк реестра с файлами текста и плана - кнопки в начале строки
function tableCard(id, title, note, allCols, rows, file, dir, kind, extra, collapseOver) {
  setTimeout(() => {
    const el = document.getElementById("tw-" + id);
    if (!el) return;
    el._keys = allCols.map(c => c.k);
    el._render = () => {
      if (el.classList.contains("tcl")) return;
      const s = S.sort[id], cols = arrangeCols(kind, el._keys).map(k => allCols.find(c => c.k === k));
      el._cols = cols;
      const acts = rows.some(r => r["Текст"] || r["План"]), runs = rows.some(r => r["Запусков"]);
      const keysRef = `document.getElementById('tw-${id}')._keys`, rr = `document.getElementById('tw-${id}')._render`;
      el.querySelector(".tscroll").innerHTML = rows.length ? `<table class="t"><thead><tr>${acts ? "<th></th>" : ""}${cols.map(c =>
        `<th class="${["ms", "num"].includes(c.kind) ? "n" : ""}${c.kind === "op" ? " op" : ""}" ${thDrag(kind, keysRef, c.k, rr)} onclick="sortBy('${id}', ${h(JSON.stringify(c.k))})">${c.kind === "op" && runs ? `<span class="opl"><span>${h(t(c.t))}${s && s.col === c.k ? `<span class="s">${s.dir > 0 ? "▲" : "▼"}</span>` : ""}</span><span class="runs" title="${t("Сортировать по числу запусков")}" onclick="event.stopPropagation();sortBy('${id}', 'Запусков')">${t("запусков")}${s && s.col === "Запусков" ? `<span class="s">${s.dir > 0 ? "▲" : "▼"}</span>` : ""}</span></span>` : h(t(c.t)).replace("\n", "<br>") + (s && s.col === c.k ? `<span class="s">${s.dir > 0 ? "▲" : "▼"}</span>` : "")}</th>`).join("")}</tr></thead>
        <tbody>${sortRows(id, cols, rows).map(r => "<tr>" + (acts ? fileActs(r, dir) : "") + cols.map(c => cellHtml(r, c, dir)).join("") + "</tr>").join("")}</tbody></table>` : `<div class="empty">${t("Строк нет")}</div>`;
      hbar(el.querySelector(".tscroll"));
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
    <div class="tscroll"></div></section>`;
}
const LOG_COLLAPSE = 100;        // журнал длиннее - свернут по умолчанию
function fileActs(r, dir) {        // кнопки строки реестра: текст оператора (.sql) и план (.sqlplan)
  const b = (f, title, icon) => f ? `<span class="ib" title="${t(title)}" onclick="api('open_path', ${h(JSON.stringify(dir + "\\" + f))}).catch(fail)">${icon}</span>` : "";
  // текст - в окне приложения с начала (внешняя программа открывала файл прокрученным в конец)
  const txt = r["Текст"] ? `<span class="ib" title="${t("Текст оператора")}" onclick="fileText(${h(JSON.stringify(dir + "\\" + r["Текст"]))})">${I.note(14)}</span>` : "";
  return `<td class="acts2">${txt}${b(r["План"], "План", I.plan(14))}</td>`;
}
async function fileText(path) {
  try {
    const d = await api("read_text", path);
    textDialog(baseName(path), d.text, baseName(path).replace(/\.sql$/i, ""));
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
      <div class="tbar"><span class="fl">${I.search(15)}<input id="t-flt" placeholder="${t("Фильтр строк (Ctrl+F)")}" value="${h(v.filter || "")}"></span><span class="lbl" id="t-cnt"></span><span class="pale" style="font-size:12px" id="t-file"></span></div>
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
  $("#t-more").innerHTML = left > 0 ? `<div class="empty">${t("Показаны первые {n} строк из {of}", {n: nf(d.rows.length), of: nf(d.matched)})} · <a onclick="loadCsv(S.view, true)">${t("показать еще {n}", {n: nf(Math.min(left, 500))})}</a></div>` : "";
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
function startCompare(a, b) {
  api("compare", a, b).then(info => {
    S.procs[info.id] = {info, events: []};
    go({k: "compare", pid: info.id, a, b});
  }).catch(fail);
}
const runName = r => `${reportStem(r)}.sql · ${tsText((r.match(/_(\d{8}_\d{6})/) || [])[1])}`;
async function viewCompare(m, v) {
  const p = S.procs[v.pid], refA = S.st.reference === v.a;
  const na = refA ? "опорный" : "A", nb = refA ? "этот" : "B";     // внутренние имена; выводятся через t()
  const head = acts => `<header class="head"><div style="display:flex;flex-direction:column;gap:10px">${backLine()}<h1>${refA ? t("Сравнение с опорным") : t("Сравнение запусков")}</h1>
    <div class="row"><span class="chip c-acc">B · ${h(runName(v.b))}</span><span class="pale">${t("против")}</span><span class="chip">${refA ? I.star(13, true) + t("опорный") + " · " : "A · "}${h(runName(v.a))}</span></div></div>
    <div class="row">${acts || ""}</div></header>`;
  if (!p || p.info.running) { m.innerHTML = head() + `<div class="card empty"><span class="pulse"></span> ${t("Сравнение идет…")}</div>`; return; }
  const code = p.info.code;
  let d = null, txt = {full: ""};
  if (p.info.report) {
    try { [d, txt] = await Promise.all([api("compare_details", p.info.report, v.a, v.b), api("compare_text", p.info.report)]); } catch (e) { fail(e); }
  }
  if (S.view !== v) return;
  if (!d) {
    m.innerHTML = head() + `<div class="card verdict v-diff"><span class="ic">!</span><span style="display:flex;flex-direction:column;gap:3px"><span style="font-size:18px;font-weight:700">${t("Сравнение не выполнено")}</span><span class="lbl">${h((p.events.filter(e => e.event === "log").pop() || {}).text || "")}</span></span></div>`;
    return;
  }
  const acts = `<span class="ib big" title="${t("Показать файлы сравнения в папке")}" onclick="api('show_in_folder', ${h(JSON.stringify(p.info.report))})">${I.folder(19)}</span>` +
    (d.scripts[0].toLowerCase() !== d.scripts[1].toLowerCase() ? diffButton(t("Сравнить скрипты"), "scripts", [v.a, v.b]) : "") + diffButton(t("Сравнение в diff"), "reports", [v.a, v.b]);
  // вердикты: данные и время
  const diffT = d.tables.filter(tb => tb.state !== "идентична");
  const dataV = code === 0
    ? `<div class="card verdict v-ok" style="flex:1"><span class="ic">=</span><span style="display:flex;flex-direction:column;gap:3px"><span style="font-size:18px;font-weight:700">${t("Данные совпадают")}</span><span class="lbl">${t("{n} табл.", {n: d.tables.length})}</span></span></div>`
    : `<div class="card verdict v-diff" style="flex:1"><span class="ic">≠</span><span style="display:flex;flex-direction:column;gap:3px"><span style="font-size:18px;font-weight:700">${t("Данные различаются")}</span><span class="lbl">${t("{n} табл. из {of}", {n: diffT.length, of: d.tables.length})}</span></span></div>`;
  const [t0, t1] = d.time, pct = t0 && t1 != null ? Math.round((t1 - t0) * 100 / t0) : null;
  const timeV = pct === null ? "" : `<div class="card verdict ${Math.abs(pct) < 3 ? "v-none" : pct < 0 ? "v-fast" : "v-diff"}" style="flex:1"><span class="ic">${Math.abs(pct) < 3 ? "≈" : pct < 0 ? "↓" : "↑"}</span>
    <span style="display:flex;flex-direction:column;gap:2px"><span style="font-size:18px;font-weight:700">${Math.abs(pct) < 3 ? t("Время почти то же") : t(pct < 0 ? "Быстрее на {p}%" : "Медленнее на {p}%", {p: Math.abs(pct)})}</span>
    <span class="lbl">${t("{a} мс против {b} мс", {a: nf(t1), b: nf(t0)})}</span><span class="dur">${dur(t1) || ""}${t1 >= 1000 || t0 >= 1000 ? " " + t("против") + " " + (dur(t0) || "<1 " + t("с")) : ""}</span></span></div>`;
  const notes = d.head.filter(x => /^(Внимание|Значения сравниваются|Допуск)/.test(x));
  // таблицы: различающиеся - карточками с примерами строк, идентичные - списком
  const ignCol = tb => { const l = tb.lines.find(x => x.startsWith("Отличающиеся колонки")); const m2 = l && /:\s*([^,(]+)/.exec(l); return m2 && m2[1].trim() !== "нет" ? m2[1].trim() : null; };
  const cards = diffT.map(tb => {
    const col = ignCol(tb), key = (tb.lines.find(x => x.startsWith("Ключ")) || "").replace(/;.*$/, "");
    const both = !tb.state.startsWith("есть только");
    return `<section class="card tw show${tcolCls("cmptable")}">${tcolBtn("cmptable")}<div class="tbar" style="flex-wrap:wrap"><h2>${t("Таблица {n}", {n: tb.n})}</h2><span class="chip c-diff">${h(t(tb.state))}</span><span class="lbl">${h(key)}</span>
      <span class="row" style="width:100%;margin-top:4px">${both ? diffButton(t("Сравнить CSV"), "table", [v.a, v.b, tb.n], true) : ""}${col ? `<a class="btn sm" onclick="ignoreDialog(${h(JSON.stringify(d.scripts[1]))}, {cols: [${h(JSON.stringify(col))}], table: '${tb.n}'})">${t("Игнорировать {col}…", {col: h(col)})}</a>` : ""}</span></div>
      <div id="cd-${tb.n}">${both ? `<div class="empty"><span class="pulse"></span> ${t("Примеры строк…")}</div>` : `<div class="dsum">${tb.lines.map(x => `<span>${h(x)}</span>`).join("")}</div>`}</div></section>`;
  }).join("");
  const same = d.tables.filter(tb => tb.state === "идентична");
  const sameCard = same.length ? `<section class="card tw${tcolCls("cmpsame")}">${tcolBtn("cmpsame")}<div class="tbar"><h2>${t("Идентичные таблицы")}</h2><span class="lbl">${nf(same.length)}</span></div><div>${same.map(tb => `<div class="trow"><h2 style="min-width:110px">${t("Таблица {n}", {n: tb.n})}</h2><span class="chip c-ok">${t("идентична")}</span><span class="lbl">${h(tb.lines[0] || "")}</span></div>`).join("")}</div></section>` : "";
  const st = d.statements;
  // операторы - srvTable (вид "cmp": колонки, порядок, сортировка)
  const delta = x => { const dd = x.b - x.a; return dd < 0 ? "#1F55A8" : "#9A4A07"; };
  // кнопки: текст и план оператора в каждом запуске (файлы реестров; нет файла - кнопки нет)
  const fb = (f, side) => [f && f[0] ? `<span class="ib" title="${t("Текст оператора")} · ${h(side)}" onclick="fileText(${h(JSON.stringify(f[0]))})">${I.note(14)}</span>` : `<span class="ib off"></span>`,
    f && f[1] ? `<span class="ib" title="${t("План")} · ${h(side)}" onclick="api('open_path', ${h(JSON.stringify(f[1]))}).catch(fail)">${I.plan(14)}</span>` : `<span class="ib off"></span>`].join("");
  const sideA = refA ? t("Опорный") : "A", sideB = refA ? t("Этот") : "B";
  const stCols = [
    [null, ["{x}", {x: sideA}], null, x => `<td class="acts2">${fb(x.files_a, sideA)}</td>`],
    [null, ["{x}", {x: sideB}], null, x => `<td class="acts2">${fb(x.files_b, sideB)}</td>`],
    ["op", "Оператор", "", x => `<td class="b" title="${h(x.text || "")}">${h(x.label)}:${x.line}${x.note ? ` <span class="pale" style="font-weight:500">${h(x.note.trim())}</span>` : ""}</td>`, x => `${x.label}:${String(x.line).padStart(7, "0")}`],
    ["a", ["{x}<br>мс", {x: refA ? t("Опорный") : "A"}], "n", x => `<td class="n">${nf(x.a)}${x.a >= 1000 ? `<span class="sv">${dur(x.a)}</span>` : ""}</td>`],
    ["b", ["{x}<br>мс", {x: refA ? t("Этот") : "B"}], "n", x => `<td class="n">${nf(x.b)}${x.b >= 1000 ? `<span class="sv">${dur(x.b)}</span>` : ""}</td>`],
    ["d", "Разница<br>мс", "n", x => { const dd = x.b - x.a; return `<td class="n b" style="color:${delta(x)}">${dd > 0 ? "+" : dd < 0 ? "−" : ""}${nf(Math.abs(dd))}</td>`; }, x => x.b - x.a],
    ["pct", "Разница<br>%", "n", x => `<td class="n" style="color:${delta(x)}">${h(x.pct.replace("-", "−"))}</td>`, x => parseFloat(x.pct) || 0],
    ["wait", ["Ожидание ресурсов<br>1 место ({x})", {x: refA ? t("этот") : "B"}], "", x => { const w = /^(.*) \((\d+) мс\)$/.exec(x.wait || ""); return `<td>${w ? `${waitHtml(w[1])}<span class="sv wi">${nf(w[2])} ${t("мс")}</span>` : '<span class="pale">—</span>'}</td>`; }],
    ["text", "Начало текста", "", x => `<td class="mono pale" style="max-width:420px;overflow:hidden;text-overflow:ellipsis" title="${h(x.text || "")}">${h(x.text || "")}</td>`]];
  S.live.cmp = {sort: null, render: () => { const b = $("#cmp-body"); if (b) { b.innerHTML = srvTable("cmp", stCols, st); hbar(b); } }};
  const stmts = st === null ? "" : `<section class="card tw${tcolCls("cmp")}">${tcolBtn("cmp")}<div class="tbar"><h2>${t("Значимые изменения операторов")}</h2><span class="lbl">${t("от 20% и от 1 000 мс")}</span></div>
    ${st.length ? `<div class="acts">${colsBtn("cmp", "S.live.cmp")}</div><div class="tscroll" id="cmp-body"></div>` : ""}${d.statement_notes.length ? `<div class="dsum">${d.statement_notes.map(x => `<span>${h(x)}</span>`).join("")}</div>` : ""}</section>`;
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

// ---------------------------------------------------------------- запросы на сервере: общие части
// Сортируемая таблица из описаний колонок: [ключ, заголовок, вид, функция ячейки]; вид "n" - число
// (сортировка как чисел, выравнивание вправо). Сортировка - клик по заголовку (S.live.<id>.sort).
// Колонки без ключа (кнопки строки) - всегда первые; остальные - в порядке и с видимостью вида id
// (colPrefs, окно «Колонки» - colsBtn(id, "S.live." + id)), перетаскиваются за заголовок.
function srvTable(id, cols, rows, rowAttr) {
  const L = S.live[id], s = L.sort;
  L.keys = cols.filter(c => c[0]).map(c => c[0]);
  const tt = x => Array.isArray(x) ? t(x[0], x[1]) : t(x);      // заголовок: строка или [шаблон, подстановки]
  L.titles = Object.fromEntries(cols.filter(c => c[0]).map(c => [c[0], tt(c[1]).replace(/<br>/g, " ").replace(/-\s/g, "")]));
  cols = cols.filter(c => !c[0]).concat(arrangeCols(id, L.keys).map(k => cols.find(c => c[0] === k)));
  if (s) {
    const c = cols.find(x => x[0] === s.k), num = c && c[2] === "n", val = c && (c[4] || (r => r[c[0]]));
    rows = [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null || y == null) return (x == null) - (y == null);
      return (num ? x - y : String(x).localeCompare(String(y), "ru")) * s.dir;
    });
  }
  return `<table class="t compact srv"><thead><tr>${cols.map(([k, title, kind]) => k
    ? `<th class="${kind === "n" ? "n" : ""}${L.hot === k ? " hot" : ""}" ${thDrag(id, `S.live.${id}.keys`, k, `S.live.${id}.render`)} onclick="srvSort('${id}', '${k}')">${tt(title)}${s && s.k === k ? `<span class="s">${s.dir > 0 ? "▲" : "▼"}</span>` : ""}</th>`
    : `<th>${title ? tt(title) : ""}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr${rowAttr ? rowAttr(r) : ""}>${cols.map(c => c[3](r)).join("")}</tr>`).join("")}</tbody></table>`;
}
function srvSort(id, k) {
  const L = S.live[id], s = L.sort;
  L.sort = !s || s.k !== k ? {k, dir: -1} : {k, dir: -s.dir};
  L.render();
}
const srvMatch = (r, f, keys) => !f || keys.some(k => r[k] != null && String(r[k]).toLowerCase().includes(f));
const opCell = (obj, line, stmt) => `<td class="op b" title="${h(stmt)}">${h(obj || t("запрос (ad hoc)"))}${line ? ":" + line : ""}<span class="sv">${h((stmt || "").replace(/\s+/g, " ").slice(0, 200))}</span></td>`;
const msCell = v => `<td class="n">${v == null ? "" : nf(v)}${v >= 1000 ? `<span class="sv">${dur(v)}</span>` : ""}</td>`;
function textDialog(title, text, name) {          // текст запроса: выделить, скопировать, открыть программой
  window._txt = {text, name};
  modal(`<div class="dlg" style="width:min(1000px,90vw)"><div class="dh"><h2>${h(title)}</h2></div>
    <div class="db"><pre class="rep sqlbox">${text ? hlSql(text) : `<span class="pale">${t("текста нет")}</span>`}</pre></div>
    <div class="df"><a class="btn" onclick="copyText(_txt.text)">${I.copy(16)}${t("Скопировать")}</a><a class="btn" onclick="api('open_text', _txt.name, _txt.text).catch(fail)">${I.open(16)}${t("Открыть в программе")}</a><a class="btn pri" onclick="closeModal()">${t("Закрыть")}</a></div></div>`);
}

// ---------------------------------------------------------------- текущие запросы (§5.20)
// Раз в CUR_S секунд - один легкий запрос (сессии с запросом и блокирующие). Кольцо - отсчет до
// обновления; клик по нему - пауза/продолжить. Пока пользователь выделяет текст в таблице, таблица
// не перерисовывается.
const CUR_S = 4, KILL_TRUST_MS = 10000;
function viewCurrent(m) {
  m.innerHTML = `
    <header class="head"><div style="display:flex;flex-direction:column;gap:8px">${backLine()}<h1 style="display:flex;align-items:center;gap:14px">${t("Текущие запросы")} <span id="cq-ring"></span></h1>
      <span class="lbl" id="cq-info">${t("пользовательские сессии с запросом и сессии, которые блокируют других · обновление раз в {n} с", {n: CUR_S})}</span></div></header>
    <section class="kpis k6" id="cq-kpis">${kpiBox("cq-s", "Сессий пользователей")}${kpiBox("cq-r", "Выполняется запросов")}${kpiBox("cq-b", "Ждут блокировку")}${kpiBox("cq-m", "Ждут память")}${kpiBox("cq-q", "Очередь на процессор")}${kpiBox("cq-l", "Самый долгий запрос")}</section>
    <section class="card tw show${tcolCls("cur")}">${tcolBtn("cur")}<div class="tbar"><span class="fl">${I.search(15)}<input id="cq-flt" placeholder="${t("Фильтр: база, программа, логин, текст")}"></span><span class="lbl" id="cq-cnt"></span></div>
      <div class="acts">${colsBtn("cur", "S.live.cur")}</div>
      <div class="tscroll" id="cq-body"><div class="empty">${t("Загрузка…")}</div></div></section>`;
  const L = S.live.cur = {paused: false, sort: {k: "elapsed", dir: -1}, filter: "", render: curRender};
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
  setKpi("cq-m", d.memory_waits ?? 0);
  setKpi("cq-q", d.runnable ?? 0);
  setRoll($("#cq-l"), clock(Math.max(0, ...active.map(r => r.elapsed || 0))));
  for (const [id, bad] of [["cq-b", rows.some(r => r.blocked_by > 0 && r.blocked_by !== r.spid)], ["cq-m", d.memory_waits > 0]]) $("#" + id).closest(".kpi").classList.toggle("warn", bad);
  if (d.server_time) $("#cq-info").textContent = t("пользовательские сессии с запросом и сессии, которые блокируют других · обновление раз в {n} с", {n: CUR_S}) + " · " + t("сервер {time}", {time: d.server_time.slice(11)});
  const shown = rows.filter(r => srvMatch(r, L.filter, ["db", "program", "login", "host", "object", "statement", "spid", "wait", "input"]));
  $("#cq-cnt").textContent = shown.length !== rows.length ? t("{n} из {of}", {n: shown.length, of: rows.length}) : String(shown.length);
  const ib = (title, on, icon, extra = "") => `<span class="ib${extra}" title="${t(title)}" onclick="${on}">${icon}</span>`;
  const cols = [
    [null, "", null, r => `<td class="acts2">${ib("Текст запроса", `curText(${r.spid})`, I.note(14))}${r.plan_handle ? ib("План", `curPlan(${r.spid})`, I.plan(14)) : ""}${ib("Исходный запрос: что прислал клиент", `curInput(${r.spid})`, I.input(14))}${ib("Наблюдать сессию", `startSession(${r.spid})`, I.eye(14))}${ib("KILL — прервать сессию", `curKill(${r.spid})`, I.kill(14), " danger")}</td>`],
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
    ["wait", "Ожидание", "", r => r.wait ? `<td>${waitHtml(r.wait)}<span class="sv wi">${nf(r.wait_ms)} ${t("мс")}</span></td>` : "<td></td>"],
    ["blocked_by", "Ждет<br>сессию", "n", r => `<td class="n">${r.blocked_by > 0 && r.blocked_by !== r.spid ? `<b class="hotv">${r.blocked_by}</b>` : ""}</td>`],
    ["blocks", "Блоки-<br>рует", "n", r => `<td class="n">${r.blocks ? `<b class="hotv">${r.blocks}</b>` : ""}</td>`],
    ["trans", "Транз-<br>акций", "n", r => `<td class="n">${r.trans || ""}</td>`],
    ["program", "Программа", "", r => `<td class="clip" title="${h(r.program)}">${h(r.program)}</td>`],
  ];
  L.hot = null;
  L.byId = Object.fromEntries(rows.map(r => [r.spid, r]));
  body.innerHTML = shown.length ? srvTable("cur", cols, shown, r => r.blocks ? ' class="blocker"' : r.blocked_by > 0 && r.blocked_by !== r.spid ? ' class="blocked"' : "")
    : `<div class="empty">${rows.length ? t("Нет строк по фильтру") : t("Сейчас на сервере нет пользовательских запросов")}</div>`;
  hbar(body);
}
const curRow = spid => S.live.cur && S.live.cur.byId[spid];
function curText(spid) {
  const r = curRow(spid);
  if (r) textDialog(r.status ? `${t("Сессия {n}", {n: spid})} · ${r.object || t("запрос")}${r.line ? ":" + r.line : ""}` : `${t("Сессия {n}", {n: spid})} · ${t("последний запрос")}`, r.status ? r.statement : r.last_text, `session_${spid}`);
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

// ---------------------------------------------------------------- тяжелые запросы (§5.21)
// Статистика кэша планов сервера: один запрос по открытию экрана и по кнопке "Обновить".
const HEAVY_METRICS = [["cpu", "CPU всего"], ["cpu_avg", "CPU на выполнение"], ["time", "Время всего"], ["time_avg", "Время на выполнение"],
  ["max_time", "Наибольшее время"], ["reads", "Чтений всего"], ["reads_avg", "Чтений на выполнение"], ["writes", "Записей всего"], ["execs", "Выполнений"]];
const HEAVY_HOT = {cpu: "cpu", cpu_avg: "cpu_avg", time: "time", time_avg: "time_avg", max_time: "max_time", reads: "reads", reads_avg: "reads_avg", writes: "writes", execs: "execs"};
function viewHeavy(m) {
  const o = S.heavy ||= {order: "cpu", hours: 0, top: 100};
  const sel = (id, opts, v) => `<select class="inp" id="${id}">${opts.map(([k, lbl]) => `<option value="${k}"${String(k) === String(v) ? " selected" : ""}>${t(lbl)}</option>`).join("")}</select>`;
  m.innerHTML = `
    <header class="head"><div style="display:flex;flex-direction:column;gap:8px">${backLine()}<h1>${t("Тяжелые запросы")}</h1>
      <span class="lbl">${t("статистика кэша планов сервера: что больше всего нагружает сервер. Числа накоплены с момента, когда план попал в кэш (колонка «В кэше с»)")}</span></div></header>
    <section class="card" style="padding:14px 20px;display:flex;flex-wrap:wrap;align-items:flex-end;gap:16px">
      <label class="field"><span class="lbl">${t("Сортировать по")}</span>${sel("hv-order", HEAVY_METRICS, o.order)}</label>
      <label class="field"><span class="lbl">${t("Выполнялись")}</span>${sel("hv-hours", [[0, "за все время в кэше"], [1, "за последний час"], [24, "за последние сутки"], [168, "за последнюю неделю"]], o.hours)}</label>
      <label class="field"><span class="lbl">${t("Сколько")}</span>${sel("hv-top", [[50, "50"], [100, "100"], [200, "200"]], o.top)}</label>
      <a class="btn pri" onclick="heavyLoad()">${I.refresh(16)}${t("Обновить")}</a>
      <span class="pale" style="font-size:12px;margin-left:auto;max-width:360px">${t("Один запрос к статистике сервера по кнопке; планы — по кнопке у строки")}</span></section>
    <section class="card tw show${tcolCls("heavy")}">${tcolBtn("heavy")}<div class="tbar"><span class="fl">${I.search(15)}<input id="hv-flt" placeholder="${t("Фильтр: объект, база, текст")}"></span><span class="lbl" id="hv-cnt"></span></div>
      <div class="acts">${colsBtn("heavy", "S.live.heavy")}</div>
      <div class="tscroll" id="hv-body"><div class="empty">${t("Загрузка…")}</div></div></section>`;
  S.live.heavy = {sort: null, filter: "", render: heavyRender};
  $("#hv-flt").addEventListener("input", e => { S.live.heavy.filter = e.target.value.trim().toLowerCase(); heavyRender(); });
  heavyLoad();
}
async function heavyLoad() {
  const o = S.heavy, L = S.live.heavy;
  o.order = $("#hv-order").value; o.hours = +$("#hv-hours").value; o.top = +$("#hv-top").value;
  $("#hv-body").innerHTML = `<div class="empty"><span class="pulse"></span> ${t("Запрос к статистике сервера…")}</div>`;
  try { L.rows = await api("heavy_queries", o.order, o.hours, o.top); L.err = null; } catch (e) { L.err = String(e.message || e); }
  if (S.live.heavy !== L) return;
  L.sort = null;
  heavyRender();
}
function heavyRender() {
  const L = S.live.heavy, body = $("#hv-body");
  if (!body) return;
  if (L.err) { body.innerHTML = `<div class="empty">${t("Не удалось получить статистику: {err}", {err: h(L.err)})}</div>`; return; }
  const avg = (r, k) => r.execs ? Math.round(r[k] / r.execs) : null;
  const rows = (L.rows || []).map((r, i) => Object.assign(r, {i, cpu_avg: avg(r, "cpu"), time_avg: avg(r, "time"), reads_avg: avg(r, "reads"), rows_avg: avg(r, "rows")}));
  const shown = rows.filter(r => srvMatch(r, L.filter, ["db", "object", "statement"]));
  $("#hv-cnt").textContent = shown.length !== rows.length ? t("{n} из {of}", {n: shown.length, of: rows.length}) : String(shown.length);
  const cols = [
    [null, "", null, r => `<td class="acts2"><span class="ib" title="${t("Текст запроса")}" onclick="heavyText(${r.i})">${I.note(14)}</span><span class="ib" title="${t("План")}" onclick="heavyPlan(${r.i})">${I.plan(14)}</span></td>`],
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
  ];
  L.hot = HEAVY_HOT[S.heavy.order];
  body.innerHTML = shown.length ? srvTable("heavy", cols, shown) : `<div class="empty">${rows.length ? t("Нет строк по фильтру") : t("Статистики нет")}</div>`;
  hbar(body);
}
function heavyText(i) { const r = S.live.heavy.rows[i]; textDialog(`${r.object || t("Запрос (ad hoc)")}${r.object && r.line ? ":" + r.line : ""}`, r.statement, `heavy_${i + 1}`); }
function heavyPlan(i) { const r = S.live.heavy.rows[i]; api("open_plan", r.plan_handle, r.start, r.end, `heavy_${i + 1}`).catch(fail); }

// ---------------------------------------------------------------- плашки «Новое наблюдение» (§5.9)
// Сверху экрана - выбранная база (по умолчанию - база подключения) и плашки: две свои (активные сессии,
// свободное место) и пользовательские ("GUI".tiles). Все запросы - в выбранной базе; база не выбрана -
// ничего не выполняется, значения стираются. «Активные сессии» обновляются вместе с таблицей сессий,
// остальные - при открытии экрана и по всплывающей кнопке «обновить».
function tileList() {
  return [{k: "sessions", name: t("Активные сессии")}, {k: "space", name: t("Свободное место")}]
    .concat((S.st.tiles || []).map(x => ({k: x.id, name: x.name, user: true})));
}
const TILES_ON = false;      // плашки временно скрыты (пользователь вернет позже): код и API остаются
function tilesDb(db) {       // база плашек - фильтр «База данных» таблицы сессий («Все» - не выбрана)
  if (!TILES_ON || S.live.tdb === db) return;
  S.live.tdb = db;
  S.live.tiles = {};
  renderTiles();
  tilesLoad(true);
}
function renderTiles() {
  const box = $("#tl-box");
  if (!box) return;
  box.innerHTML = tileList().map(x => `<div class="card kpi tile" id="tile-${h(x.k)}"><span class="lbl" title="${h(x.name)}">${h(x.name)}</span><div class="tvals"></div>
      ${x.user ? `<span class="ib tedit" title="${t("Изменить плашку")}" onclick="tileDialog(${h(JSON.stringify(x.k))})">${I.pen(14)}</span>` : ""}</div>`).join("") +
    `<div class="tacts"><span class="ib" title="${t("Добавить плашку")}" onclick="tileDialog(null)">${I.plus(16)}</span><span class="ib" title="${t("Обновить плашки")}" onclick="tilesLoad(false)">${I.refresh(15)}</span></div>`;
  for (const x of tileList()) fillTile(x.k);
}
function tilesLoad(withSessions) {          // withSessions - и «Активные сессии» (при открытии и смене базы)
  for (const x of tileList()) if (withSessions || x.k !== "sessions") tileLoad(x.k);
}
async function tileLoad(k) {
  const db = S.live.tdb, tiles = S.live.tiles ||= {};
  if (!db) { delete tiles[k]; fillTile(k); return; }
  tiles[k] = {loading: true};
  fillTile(k);
  const kind = k === "sessions" || k === "space" ? k : "user";
  let r;
  try { r = {data: await api("tile", db, kind, kind === "user" ? k : null)}; } catch (e) { r = {err: String(e.message || e)}; }
  if (S.live.tiles !== tiles || S.live.tdb !== db) return;     // за время запроса сменили базу или экран
  tiles[k] = r;
  fillTile(k);
}
function fillTile(k) {
  const el = document.querySelector(`#tile-${CSS.escape(k)} .tvals`);
  if (!el) return;
  const r = (S.live.tiles || {})[k], big = s => `<span class="tb">${h(s)}</span>`, sub = s => `<span class="ts">${h(s)}</span>`;
  const val = v => typeof v === "number" ? nf(v) : v == null ? "—" : String(v);
  let html;
  if (!S.live.tdb) html = big("—") + sub(t("база не выбрана"));
  else if (!r) html = big("—");
  else if (r.loading) html = `<span class="tb pale"><span class="pulse"></span></span>`;
  else if (r.err) html = big("—") + `<span class="ts err" title="${h(r.err)}">${h(r.err)}</span>`;
  else if (k === "sessions") html = big(nf(r.data.active)) + sub(t("дольше 5 минут: {n}", {n: nf(r.data.long)}));
  else if (k === "space") {
    // бледно - две строки: диски базы и диски лога (даже если диск один и тот же); дисков несколько -
    // все, где файлы могут расти, и их суммарное свободное место
    const d = r.data, disk = (label, x) => `<span class="ts one" title="${h(x ? x.mounts.join(", ") : "")}">${h(x
      ? t(x.mounts.length > 1 ? "{what}: диски {m} — свободно {n} МБ" : "{what}: диск {m} — свободно {n} МБ", {what: label, m: x.mounts.join(", "), n: nf(x.free_mb)})
      : t("{what}: диск — нет данных", {what: label}))}</span>`;
    html = big(t("данные: {n} МБ", {n: val(d.data_mb)})) + big(t("лог: {n} МБ", {n: val(d.log_mb)})) +
      disk(t("база"), d.data_disk) + disk(t("лог"), d.log_disk);
  } else html = big(val(r.data.main)) + (r.data.sub != null ? sub(val(r.data.sub)) : "");
  el.innerHTML = html;
  el.querySelectorAll(".tb").forEach(fitText);
}
// крупный текст в одну строку: шрифт уменьшается, пока строка не поместится (не меньше 11 px)
function fitText(el) {
  el.style.fontSize = "";
  let s = parseFloat(getComputedStyle(el).fontSize);
  while (el.scrollWidth > el.clientWidth + 1 && s > 11) el.style.fontSize = (s -= 1) + "px";
}
function tileDialog(id) {
  const x = (S.st.tiles || []).find(y => y.id === id) || {name: "", sql: ""};
  window._tile = id;
  modal(`<div class="dlg" style="width:640px"><div class="dh"><h2>${id ? t("Плашка") : t("Новая плашка")}</h2>
      <span class="note">${t("Выводится последняя таблица скрипта: первая ячейка первой строки — крупно, первая ячейка второй строки — мелко. Скрипт выполняется в выбранной базе как есть: пишите только чтение, сервер боевой.")}</span></div>
    <div class="db"><label class="field"><span class="lbl">${t("Название")}</span><input class="inp" id="tl-name" value="${h(x.name)}"></label>
      <label class="field"><span class="lbl">${t("SQL-скрипт")}</span><textarea class="inp mono tsql" id="tl-sql" spellcheck="false">${h(x.sql)}</textarea></label></div>
    <div class="df">${id ? `<a class="btn" style="margin-right:auto;color:#9A3412" onclick="tileDelete()">${I.trash(15)}${t("Удалить")}</a>` : ""}<a class="btn" onclick="closeModal()">${t("Отмена")}</a><a class="btn pri" onclick="tileSave()">${t("Сохранить")}</a></div></div>`);
}
async function tileSave() {
  try {
    const id = await api("save_tile", window._tile, $("#tl-name").value, $("#tl-sql").value);
    closeModal();
    await refresh();
    renderTiles();
    tileLoad(id);
  } catch (e) { fail(e); }
}
async function tileDelete() {
  if (!confirm(t("Удалить плашку?"))) return;
  try { await api("delete_tile", window._tile); closeModal(); await refresh(); renderTiles(); } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- новое наблюдение (§5.9)
function viewNewSession(m) {
  m.innerHTML = `
    <header style="display:flex;flex-direction:column;gap:8px">${backLine()}<h1>${t("Новое наблюдение")}</h1></header>
    ${TILES_ON ? '<section class="kpis tiles" id="tl-box"></section>' : ""}
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
  // фильтр «База данных» по умолчанию - база подключения; он же - база плашек
  S.live.flt = {db: (S.st.connection || {}).database || "", program: "", login: "", active: true};
  S.live.tiles = {};
  S.live.tdb = null;
  tilesDb(S.live.flt.db);
  loadSessions(true);
}
async function loadSessions(first) {      // first - при открытии: «Активные сессии» уже загружает tilesDb
  if (!first && TILES_ON && S.live.tdb) tileLoad("sessions");
  try { S.live.sessions = await api("list_sessions"); } catch (e) { $("#ss-body").innerHTML = `<div class="empty">${t("Список не получен: {err}", {err: h(e.message || e)})}</div>`; return; }
  // имя базы подключения - как его пишет сервер (регистр)
  const f = S.live.flt, same = S.live.sessions.find(x => (x.db || "").toLowerCase() === f.db.toLowerCase());
  if (same && same.db !== f.db) { f.db = same.db; tilesDb(f.db); }
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
    `<label class="field"><span class="lbl">${t(lbl)}</span><select class="inp" onchange="S.live.flt.${k}=this.value;renderSessions()${k === "db" ? ";tilesDb(this.value)" : ""}">${opts(k)}</select></label>`).join("") +
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
      <span class="lbl" id="s-info"></span><span class="inpq" id="s-inp"></span></div>
      <div class="row"><span class="ib big" title="${t("Показать в папке")}" onclick="if(S.live.folder)api('show_in_folder', S.live.folder)">${I.folder(19)}</span>
        <a class="btn dark" id="s-stop" onclick="api('stop', ${p.info.id})">${I.stop(14)}${t("Остановить и сохранить")}</a></div></header>
    <section class="card hl strip"><span class="lbl" style="color:#2F4AC0;white-space:nowrap;margin-top:22px">${t("Сейчас")}</span><div class="lines" id="s-lines"></div></section>
    <section class="kpis">${kpiBox("q-t", "Время операторов", "мс")}${kpiBox("q-c", "CPU", "мс")}${kpiBox("q-l", "Ожидание блокировок", "мс")}${kpiBox("q-r", "Ожидание ресурсов", "мс")}${slowBox("q-slow", null)}</section>
    <div id="s-tables"></div>`;
  S.live = {lines: 0, el: []};
  updateLive();
  loadSessionTables(p);
}
async function loadSessionTables(p) {
  const st = p.events.find(e => e.event === "start");
  if (!st) return;
  S.live.folder = st.folder;
  let d;
  try { d = await api("session_details", baseName(st.folder)); } catch (e) { return; }
  if (!(S.view.k === "session" && S.view.pid === p.info.id)) return;
  $("#s-info").textContent = (d.header["Сессия"] ? d.header["Сессия"].split(";").slice(1).join(" ·") : "") + " · " + t("реестр обновлен {time}", {time: (d.header["Обновлено"] || "").slice(11)});
  $("#s-inp").outerHTML = inputLine(d.header, "s-inp");
  const sum = k => d.registry.reduce((n, r) => n + (+cellVal(r, {k}) || 0), 0);
  setKpi("q-t", sum("Время мс"), true); setKpi("q-c", sum("CPU мс"), true);
  setKpi("q-l", sum("Ожидание блокировок мс"), true); setKpi("q-r", sum("Ожидание ресурсов мс"), true);
  const ql = $("#q-l"); if (ql) ql.parentNode.style.color = sum("Ожидание блокировок мс") ? "#9A4A07" : "";
  // реестр - выше журнала; кольцо у заголовка заполняется за FLUSH_S до следующего обновления файлов
  // (отсчет от последнего события flush, до первого - от начала наблюдения) и обнуляется, когда
  // новые файлы пришли и таблицы перерисованы (кольцо создается заново)
  const last = [...p.events].reverse().find(e => e.event === "flush") || st;
  const ring = p.info.code === null ? flushRing(Date.now() - evMs(last)) : "";
  // высота блока держится до отрисовки строк (tableCard рисует их следующим шагом), иначе страница на миг
  // становится короче и прокрутка уезжает наверх
  const box = $("#s-tables"), main = $("#main"), top = main.scrollTop;
  box.style.minHeight = box.offsetHeight + "px";
  box.innerHTML = tableCard("sreg", t("Реестр операторов"), t("по времени · обновляется раз в 10 с"), REG_COLS, d.registry, d.folder + "\\registry.csv", d.folder, "reg", ring) +
    tableCard("slog", t("Журнал выполнения"), "log.csv · " + t("новые сверху"), LOG_COLS, [...d.log].reverse(), d.folder + "\\log.csv", d.folder, "log");
  setTimeout(() => { box.style.minHeight = ""; main.scrollTop = top; });     // после строк таблиц
}
// исходный запрос сессии из шапки registry.txt (последний батч клиента: часто вызов процедуры с параметрами)
function inputLine(header, id) {
  const k = Object.keys(header).find(x => x.startsWith("Исходный запрос")), q = k ? header[k] : "";
  return `<span class="inpq" id="${id}" title="${h(q)}">${q && q !== "нет данных" ? `<span class="pale">${t("исходный запрос:")}</span> ${h(q)}` : ""}</span>`;
}
const FLUSH_S = 10;         // --session: файлы реестра перезаписываются раз в столько секунд (SESSION_FLUSH_S)
function flushRing(elapsed) {
  return `<span class="ring" title="${t("До следующего обновления реестра")}"><svg width="18" height="18" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" class="rb"/><circle cx="10" cy="10" r="8" class="rf" style="animation-duration:${FLUSH_S}s;animation-delay:-${Math.min(Math.max(0, elapsed), FLUSH_S * 1000)}ms"/></svg></span>`;
}
function updateSession(p) {
  const ev = p.events, L = S.live, box = $("#s-lines");
  if (!box) return;
  const items = ev.filter(e => e.event === "statement" || e.event === "idle");
  while (L.lines < items.length) {
    const e = items[L.lines];
    L.lines++;
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
      : `<span class="tmc">${since}</span><span class="ob">${h(e.object)}${e.line ? ":" + e.line : ""}</span><span class="tx" title="${h(e.text)}">${h(e.text)}</span><span class="wbox"></span><span class="tm optm" data-t0="${evMs(e)}"></span>`;
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
  if (slow) setSlow("q-slow", slow.count, slow.ms);
  if (p.info.code !== null) {
    $("#s-chip").innerHTML = t("завершено");
    $("#s-stop").setAttribute("disabled", "");
  }
}

// ---------------------------------------------------------------- итог наблюдения
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
      <span class="lbl">${h((d.header["Сессия"] || "").split(";").slice(1).join(" ·"))} · ${t("начало {time}", {time: h(d.header["Начало наблюдения"] || "")})}</span>${inputLine(d.header, "d-inp")}</div>
      <div class="row"><span class="ib big" title="${t("Показать в папке")}" onclick="api('show_in_folder', ${h(JSON.stringify(d.folder + "\\registry.txt"))})">${I.folder(19)}</span>
        <span class="ib big" title="${t("Удалить в корзину")}" onclick="deleteSession(${h(JSON.stringify(v.folder))})">${I.trash(19)}</span></div></header>
    <section class="kpis">${kpi("Время операторов", "Время мс")}${kpi("CPU", "CPU мс")}${kpi("Ожидание блокировок", "Ожидание блокировок мс")}${kpi("Ожидание ресурсов", "Ожидание ресурсов мс")}${d.slow ? slowBox("d-slow", d.slow) : ""}</section>
    ${tableCard("dreg", t("Реестр операторов"), "registry.csv", REG_COLS, d.registry, d.folder + "\\registry.csv", d.folder, "reg")}
    ${tableCard("dlog", t("Журнал выполнения"), "log.csv", LOG_COLS, d.log, d.folder + "\\log.csv", d.folder, "log", "", LOG_COLLAPSE)}`;
}

function deleteSession(folder) {     // §6.5: папка наблюдения - в корзину
  modal(`<div class="dlg" style="width:420px"><div class="dh"><h2>${t("Удалить наблюдение?")}</h2><span class="note">${t("Папка {name} (реестр, журнал, планы) будет перемещена в корзину Windows.", {name: h(folder)})}</span></div>
    <div class="df"><a class="btn" onclick="closeModal()">${t("Отмена")}</a><a class="btn dark" onclick="doDeleteSession(${h(JSON.stringify(folder))})">${t("В корзину")}</a></div></div>`);
}
async function doDeleteSession(folder) {
  try { await api("delete_session", folder); closeModal(); S.view = {k: "empty"}; S.history = []; await refresh(); renderMain(); toast(t("Перемещено в корзину")); } catch (e) { fail(e); }
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
window.addEventListener("pywebviewready", startOnce);
setTimeout(() => { if (!window.pywebview) startOnce(); }, 300);   // режим --dev: pywebview нет
window.addEventListener("resize", () => fitHint());
