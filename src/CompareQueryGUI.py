#!/usr/bin/env python3
"""CompareQuery GUI: оболочка над CompareQuery.py (принципы и экраны - GUI.md).

Запуск:   python CompareQueryGUI.py          окно (pip install pywebview)
Отладка:  python CompareQueryGUI.py --dev    тот же интерфейс в браузере: http://127.0.0.1:8766

GUI читает файлы запусков и CompareQuery.json и запускает CompareQuery.py отдельными процессами
(--events --parent-pid). Сам он обращается к серверу только легкими чтениями DMV: список сессий
(GUI.md §5.9), «Текущие запросы» (§5.20), «Тяжелые запросы» (§5.21), тексты и планы по кнопке;
изменения - только KILL сессии и отмена ее запроса (PostgreSQL), по подтверждению пользователя.
Свое состояние хранит в разделе "GUI" CompareQuery.json.
"""

import csv
import ctypes
import datetime as dt
import glob
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import CompareQuery as cq

HERE = Path(__file__).resolve().parent
CLI = HERE / "CompareQuery.py"
WEB = HERE / "gui"
DEV_PORT = 8766
TABLE_ROWS = 500              # строк CSV за один запрос интерфейса
REPORT_RE = re.compile(r"^(?P<stem>.+)_(?P<ts>\d{8}_\d{6})(?:_\d+)?\.txt$")
COMPARE_RE = re.compile(r"^(?P<b>.+?)__(?P<a>.+)_compare_\d{8}_\d{6}(?:_\d+)?\.txt$")
SESSION_DIR_RE = re.compile(r"^Session_(?P<ts>\d{8}_\d{6})_(?P<spid>\d+)(?:_\d+)?$")
SLOW_RE = re.compile(r"(\d+), всего (\d+) мс")
STMT_RE = re.compile(r"^(?P<label>.+), стр\. (?P<line>\d+)(?P<note> \([^)]*\))?: (?P<a>\d+) -> (?P<b>\d+) мс "
                     r"\((?P<pct>[^)]*)\), CPU (?P<cpu_a>\d+) -> (?P<cpu_b>\d+), чтений (?P<reads_a>\d+) -> (?P<reads_b>\d+)$")
DIFF_TOOLS = [   # GUI.md §5.5: после пути из "GUI" и git config
    ("TortoiseGitMerge", ["TortoiseGitMerge.exe", r"%ProgramFiles%\TortoiseGit\bin\TortoiseGitMerge.exe"]),
    ("TortoiseMerge", ["TortoiseMerge.exe", r"%ProgramFiles%\TortoiseSVN\bin\TortoiseMerge.exe"]),
    ("WinMerge", ["WinMergeU.exe", r"%ProgramFiles%\WinMerge\WinMergeU.exe", r"%ProgramFiles(x86)%\WinMerge\WinMergeU.exe",
                  r"%LOCALAPPDATA%\Programs\WinMerge\WinMergeU.exe"]),
]
_diff_cache = {}

# Запросы к серверу (сессии, текущие и тяжелые запросы, планы, KILL) - в диалекте СУБД (cq_mssql.py, cq_pg.py).
DB_TIMEOUT_S = 20             # GUI: таймаут запроса к серверу, с

# ============================================================ локализация (GUI.md §5.22)
# Сообщения Python-части GUI - как в интерфейсе: исходный текст - ключ, перевод - gui/locales/<язык>.json
# с префиксом "py:". Язык - "GUI".lang (выбирает интерфейс). Тексты CompareQuery.py (отчеты, журнал CLI,
# его ошибки) не переводятся.

_dict = {}


def set_lang(lang):
    global _dict
    _dict = {}
    if lang and lang != "ru":
        try:
            raw = json.loads((WEB / "locales" / f"{lang}.json").read_text(encoding="utf-8"))
            _dict = {k[3:]: v for k, v in raw.items() if k.startswith("py:")}
        except (OSError, ValueError):
            pass


def tr(text, **kw):
    """Перевод сообщения (нет перевода - исходный текст); подстановки - как str.format."""
    return _dict.get(text, text).format(**kw) if kw else _dict.get(text, text)


# ============================================================ настройки (CompareQuery.json)

def read_json():
    cq.ensure_settings_file()
    try:
        raw = json.loads(cq.SETTINGS_PATH.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        raw = {}
    return raw if isinstance(raw, dict) else {}


def write_json(raw):
    tmp = cq.SETTINGS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, cq.SETTINGS_PATH)


def conn_value(cs, key):
    """Сервер (key "server") или база ("database") строки подключения любой СУБД - для подписей."""
    server, database = cq.conn_parts(cs)
    return server if key == "server" else database


# ============================================================ отчеты

JOURNAL_RE = re.compile(r"\[(\d\d:\d\d:\d\d\.\d{3})\] (?:(SQL|Ошибка): )?(.*)")


def read_journal(path):
    """Журнал хода запуска (<запуск>_message.txt, cq.Journal): [{time, tag, text}]; нет файла - None.
    Строки продолжения многострочного сообщения - с отступом."""
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError:
        return None
    out = []
    for line in text.splitlines():
        m = JOURNAL_RE.fullmatch(line)
        if m:
            out.append({"time": m.group(1), "tag": m.group(2) or "", "text": m.group(3)})
        elif out and line:
            out[-1]["text"] += "\n" + line.strip()
    return out


def read_report(path):
    """Отчет режима 1 для GUI, включая прерванные: шапка, сводка, таблицы."""
    text = path.read_text(encoding="utf-8-sig")
    sections = []
    for line in text.split("\n"):
        line = line.rstrip("\r")
        if line.startswith("# "):
            sections.append((line[2:].strip(), []))
        elif sections:
            sections[-1][1].append(line)
    if not sections or sections[0][0] != "Запуск":
        return None
    run = cq.fields(sections[0][1])
    out = {"path": str(path), "name": path.name, "run": run, "aborted": run.get("ЗАПУСК ПРЕРВАН"),
           "summary": {}, "tables": {}, "suggestion": None}
    for title, lines in sections[1:]:
        m = re.fullmatch(r"Таблица (\d+)", title)
        if m:
            n = int(m.group(1))
            try:
                t = cq.parse_table(path, n, lines)
                out["tables"][n] = {"file": t["file"], "rows": t["rows"], "hash": t["table_hash"],
                                    "cols": t["col_hashes"], "names": t["names"], "ignored": sorted(t["ignored"]),
                                    "key": t["P"][:t["klen"]], "cost": t["cost"]}
            except cq.ScriptError:
                f = cq.fields(lines)
                out["tables"][n] = {"file": f.get("Файл"), "rows": cq.int_value(f.get("Количество строк")),
                                    "hash": f.get("Хэш таблицы"), "cols": {}, "names": [], "ignored": [],
                                    "key": [], "cost": None}
        elif title == "Сводка":
            f = cq.fields(lines)
            out["summary"] = {k: cq.int_value(f.get(name)) for k, name in (
                ("time", "Время"), ("client", "Ожидание клиента"), ("cpu", "CPU"),
                ("reads", "Логических чтений"), ("phys", "Физических чтений"), ("rows", "Всего строк"),
                ("total", "Общее время запуска"))}
        elif title.startswith("Предложение для настроек"):
            out["suggestion"] = "\n".join(lines).strip()
    return out


def comparable(a, b):
    """Сравнимость запусков по отчетам (GUI.md §5.13): (True, None) или (False, причина)."""
    for r in (a, b):
        if r["aborted"]:
            return False, tr("прерван")
    ta, tb = a["tables"], b["tables"]
    if len(ta) != len(tb):
        return False, tr("{a} табл. против {b}", a=len(ta), b=len(tb))
    for n in ta:
        if n not in tb:
            return False, tr("нет таблицы {n}", n=n)
        na = {c.lower() for c in ta[n]["names"]}
        nb = {c.lower() for c in tb[n]["names"]}
        big = max(len(na), len(nb))
        if big and len(na & nb) * 2 < big:
            return False, tr("таблица {n}: общих колонок {common} из {big}", n=n, common=len(na & nb), big=big)
    return True, None


def same_data(a, b):
    """Данные совпадают по хэшам отчетов (как быстрый путь режима 2)."""
    for n, x in a["tables"].items():
        y = b["tables"].get(n)
        if y is None or x["rows"] != y["rows"]:
            return False
        if [c.lower() for c in x["names"]] != [c.lower() for c in y["names"]]:
            return False        # другой состав или порядок колонок - режим 2 считает таблицу отличающейся
        if x["ignored"] == y["ignored"]:
            # Хэш таблицы - по строкам целиком; хэши колонок его не заменяют: значения могут совпасть
            # по каждой колонке, а строки из них сложиться разные (раньше при разном хэше таблицы
            # сравнивались хэши колонок, и итог расходился с режимом 2).
            if x["hash"] != y["hash"]:
                return False
            continue
        # настройки игнорируемых колонок разные: хэш таблицы несравним, остаются хэши колонок (приближенно)
        ign = {c.lower() for c in x["ignored"] + y["ignored"]}
        ca = {k.lower(): v for k, v in x["cols"].items() if k.lower() not in ign}
        cb = {k.lower(): v for k, v in y["cols"].items() if k.lower() not in ign}
        if ca != cb:
            return False
    return True


def read_csv_rows(path, tail=0):
    """registry.csv / log.csv: заголовок и строки-словари; tail - только последние строки (read_csv_tail)."""
    try:
        if tail:
            rows = read_csv_tail(path, tail)
        else:
            with open(path, encoding="utf-8-sig", newline="") as f:
                rows = list(csv.reader(f, delimiter=";"))
    except (OSError, UnicodeDecodeError):
        return [], []
    if not rows:
        return [], []
    head = rows[0]
    return head, [dict(zip(head, r)) for r in rows[1:]]


def read_csv_tail(path, n):
    """Заголовок и последние n строк log.csv. Журнал идущего наблюдения растет все время, и целиком раз
    в 10 с он не читается: файл читается с конца кусками. Строка журнала - одна строка файла (текст
    оператора записан без переводов строк, cq.head_cell)."""
    with open(path, "rb") as f:
        head = f.readline()
        start = len(head)
        f.seek(0, 2)
        pos, data = f.tell(), b""
        while pos > start and data.count(b"\n") <= n:
            step = min(pos - start, 65536)
            pos -= step
            f.seek(pos)
            data = f.read(step) + data
    lines = data.split(b"\n")[1 if pos > start else 0:]      # первая - кусок строки
    data = head + b"\n".join([x for x in lines if x.strip()][-n:])
    return list(csv.reader(data.decode("utf-8-sig").splitlines(), delimiter=";"))


STMT_ALL_TOP = 500      # экран сравнения, «все операторы»: строк не больше (без «показать еще»)
WAIT_KEYS = ("CPU мс", "Ожидание блокировок мс", "Ожидание ресурсов мс", "Ожидание ресурсов 1 место",
             "Ожидание ресурсов 2 место", "Ожидание ресурсов 3 место", "Ожидание клиента мс")


def reg_waits(rows):
    """Колонки ожиданий строк реестра (cq.read_registry) - для полосы долей ожиданий (JS regWaitItems)."""
    return [{k: r["row"].get(k) or "" for k in WAIT_KEYS} for r in rows]


def stmt_waits(r):
    """Ожидания оператора: блокировки + ресурсы, мс; нет строки или пустые счетчики - None."""
    if not r:
        return None
    v = [r["row"].get(k) for k in ("Ожидание блокировок мс", "Ожидание ресурсов мс")]
    v = [int(x) for x in v if x and str(x).isdigit()]
    return sum(v) if v else None


def statement_rows(changes, dir_a, dir_b, runs=False):
    """Строки таблицы операторов экранов сравнения из пар cq.statement_changes: разбор строки файла
    сравнения (cq.statement_text), начало текста, первое ожидание A и B, ожидания мс, файлы текста и плана
    в каждом запуске или наблюдении (нет файла - None); runs - число запусков оператора (наблюдения)."""
    def files(r, d):
        row = r["row"] if r else {}
        return [str(d / row[k]) if row.get(k) else None for k in ("Текст", "План")]
    out = []
    for ar, br, note in changes:
        r = br or ar
        m = STMT_RE.match(cq.statement_text(ar, br, note))
        st = {k: (int(v) if v and v.isdigit() else v) for k, v in m.groupdict().items()} if m else \
            {"label": r["label"], "line": r["line"], "note": note, "a": 0, "b": 0, "pct": ""}
        st["text"] = r["head"]
        st["wait"] = (br["row"].get("Ожидание ресурсов 1 место") if br else "") or ""
        st["wait_a"] = (ar["row"].get("Ожидание ресурсов 1 место") if ar else "") or ""
        st["waits_a"], st["waits_b"] = stmt_waits(ar), stmt_waits(br)
        st["files_a"], st["files_b"] = files(ar, dir_a), files(br, dir_b)
        if runs:
            st["runs_a"], st["runs_b"] = (ar["runs"] if ar else 0), (br["runs"] if br else 0)
        out.append(st)
    return out


def registry_header(path):
    try:
        return cq.fields(Path(path).read_text(encoding="utf-8-sig").split("\n"))
    except OSError:
        return {}


def slow_info(header):
    """Задержки выборки из шапки registry.txt: {count, ms} или None."""
    for k, v in header.items():
        m = SLOW_RE.match(v) if k.startswith("Задержки выборки") else None
        if m:
            return {"count": int(m.group(1)), "ms": int(m.group(2))}
    return None


def temp_file(name, text):
    """Файл для открытия программой по умолчанию (план .sqlplan - в SSMS) во временной папке компьютера."""
    d = Path(os.environ.get("TEMP") or ".") / "CompareQuery"
    d.mkdir(exist_ok=True)
    p = d / re.sub(r'[\\/:*?"<>|]', "_", name)
    p.write_text(text, encoding="utf-8")
    return p


def is_default_connection(cs, login):
    """Подключение из примера, который создает CLI (localhost, master, sa), или пустое."""
    return not (cs or "").strip() or (conn_value(cs, "server").lower() == "localhost"
                                      and conn_value(cs, "database").lower() == "master"
                                      and (login or "").lower() == "sa")


EXTRA_TABLES = ("nested.csv", "functions.csv", "tables.csv")    # PostgreSQL: файлы папки реестра, кроме registry/log


def dbms_info(cs):
    """Что интерфейсу нужно знать о СУБД активного подключения (без подключения к серверу): имя, показатели
    «Тяжелых запросов» (первый - по умолчанию), есть ли --hours и --explain, колонки экранов без данных."""
    db = cq.get_dialect({"connection_string": cs})
    return {"name": db.name, "heavy_orders": list(db.heavy_orders), "heavy_hours": db.heavy_hours, "heavy_interval": db.heavy_interval,
            "can_explain": db.can_explain, "can_cancel": db.can_cancel, "can_estimate": db.can_estimate, "absent": db.gui_absent,
            "load_by_db": list(db.load_by_db), "waits_total": db.waits_total, "has_temp_tables": db.has_temp_tables,
            "space_per_db": db.space_per_db}


def no_connection(raw, g):
    """Пользователь еще не задал ни одного подключения: активное - из примера, и в списке нет других."""
    return is_default_connection(raw.get("connection_string"), raw.get("login")) and all(
        is_default_connection(c.get("connection_string"), c.get("login"))
        for c in (g.get("connections") or []) if isinstance(c, dict))


def new_conn_id():
    import secrets
    return "c" + secrets.token_hex(4)


def ignored_key(raw):
    """Ключ ignored_columns в json как он есть (CLI читает ключи без учета регистра)."""
    return next((k for k in raw if k.lower() == "ignored_columns"), "ignored_columns")


def ignored_count(raw, stem):
    """Сколько колонок игнорируется для скрипта (все таблицы вместе); неверные группы пропускаются."""
    groups = []
    for g in raw.get(ignored_key(raw)) or []:
        if isinstance(g, dict) and isinstance(g.get("mask"), str) and isinstance(g.get("tables"), dict):
            groups.append((g["mask"], {str(t): c for t, c in g["tables"].items() if isinstance(c, list)}))
    return sum(len(c) for c in cq.ignored_columns(groups, stem).values())


def find_diff_tool(custom):
    """Программа внешнего diff: {"name", "cmd"} или None (GUI.md §5.5). Результат запоминается."""
    if custom in _diff_cache:
        return _diff_cache[custom]
    import shutil
    tool = None
    if custom and Path(custom).is_file():
        tool = {"name": Path(custom).stem, "cmd": [custom]}
    if tool is None:
        try:
            def git(*a):
                r = subprocess.run(["git", "config", "--get", *a], capture_output=True, text=True, timeout=5,
                                   creationflags=0x08000000 if os.name == "nt" else 0)
                return r.stdout.strip()
            name = git("diff.tool")
            path = git(f"difftool.{name}.path") if name else ""
            if path and Path(path).is_file():
                tool = {"name": name, "cmd": [path]}
        except (OSError, subprocess.SubprocessError):
            pass
    for name, places in ([] if tool else DIFF_TOOLS):
        for x in places:
            p = shutil.which(x) if "\\" not in x else os.path.expandvars(x)
            if p and Path(p).is_file():
                tool = {"name": name, "cmd": [p]}
                break
        if tool:
            break
    if tool is None and shutil.which("code"):
        tool = {"name": "VS Code", "cmd": [shutil.which("code"), "--diff"]}
    _diff_cache[custom] = tool
    return tool


# ============================================================ корзина Windows

class SHFILEOPSTRUCTW(ctypes.Structure):
    _fields_ = [("hwnd", ctypes.c_void_p), ("wFunc", ctypes.c_uint), ("pFrom", ctypes.c_wchar_p),
                ("pTo", ctypes.c_wchar_p), ("fFlags", ctypes.c_uint16), ("fAnyOperationsAborted", ctypes.c_int),
                ("hNameMappings", ctypes.c_void_p), ("lpszProgressTitle", ctypes.c_wchar_p)]


def to_recycle_bin(paths):
    """Файлы и папки - в корзину (GUI.md §6.5)."""
    paths = [str(Path(p).resolve()) for p in paths if Path(p).exists()]
    if not paths:
        return
    op = SHFILEOPSTRUCTW(None, 3, "\0".join(paths) + "\0\0", None, 0x40 | 0x10 | 0x4 | 0x400, 0, None, None)
    if ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op)) != 0:
        raise OSError(tr("не удалось переместить в корзину"))


# ============================================================ процессы CLI

class Proc:
    """Процесс CompareQuery.py: события --events из stdout, сообщения из stderr."""

    def __init__(self, gui, pid, kind, args, title, script=None):
        self.id, self.kind, self.title, self.script = pid, kind, title, script
        self.started = dt.datetime.now().isoformat(timespec="milliseconds")
        self.code = None
        self.report = None
        self.gui = gui
        flags = 0x08000000 if os.name == "nt" else 0      # CREATE_NO_WINDOW
        env = dict(os.environ, PYTHONIOENCODING="utf-8")
        self.popen = subprocess.Popen(
            [sys.executable, str(CLI)] + args + ["--events", "--parent-pid", str(os.getpid())],
            cwd=gui.folder, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=flags, env=env)
        threading.Thread(target=self.read_events, daemon=True).start()
        threading.Thread(target=self.read_log, daemon=True).start()

    def info(self):
        return {"id": self.id, "kind": self.kind, "title": self.title, "script": self.script,
                "started": self.started, "running": self.code is None, "code": self.code, "report": self.report}

    def read_events(self):
        for raw in self.popen.stdout:
            try:
                ev = json.loads(raw.decode("utf-8"))
            except ValueError:
                continue
            if ev.get("event") == "report" and self.report is None:
                self.report = ev.get("path")
            self.gui.push(self.id, ev)
        self.code = self.popen.wait()
        self.gui.push(self.id, {"event": "exit", "code": self.code,
                                "time": dt.datetime.now().isoformat(timespec="milliseconds")})

    def read_log(self):
        buf = b""
        while True:
            chunk = self.popen.stderr.read1(4096)
            if not chunk:
                break
            buf += chunk
            # строка состояния --session переписывается через \r: каждая версия - отдельная строка журнала
            *lines, buf = re.split(rb"\r\n|\n|\r", buf)
            for line in lines:
                text = line.decode("utf-8", "replace").rstrip()
                if text:
                    self.gui.push(self.id, {"event": "log", "text": text,
                                            "time": dt.datetime.now().isoformat(timespec="milliseconds")})

    def stop(self):
        if self.code is None:
            try:
                self.popen.stdin.write(b"stop\n")
                self.popen.stdin.flush()
            except OSError:
                pass


# ============================================================ API для интерфейса

class Api:
    """Методы, которые вызывает интерфейс (pywebview js_api или POST /api/<метод> в режиме --dev).
    Атрибуты с подчеркиванием интерфейсу не видны."""

    def __init__(self):
        self._lock = threading.Lock()
        self._gui_lock = threading.Lock()
        self._events = []          # (номер, id процесса, событие) - еще не полученные интерфейсом (poll)
        self._base = 0             # столько первых событий интерфейс уже получил, они не хранятся
        self._procs = {}
        self._next = 1
        self._window = None
        self._close_ok = False
        self._cache = {}           # путь отчета -> (mtime, разобранный отчет)
        self._conn = None          # подключение GUI к серверу (_query)
        self._db = None            # диалект СУБД активного подключения (_dialect)
        self._db_lock = threading.RLock()
        raw = read_json()
        g = raw.get("GUI") if isinstance(raw.get("GUI"), dict) else {}
        folder = g.get("folder")
        self.folder = folder if folder and Path(folder).is_dir() else str(Path.cwd())
        set_lang(g.get("lang"))

    # ---------------------------------------------------- служебное

    def push(self, pid, ev):
        with self._lock:
            self._events.append((self._base + len(self._events) + 1, pid, ev))

    def _gui(self):
        raw = read_json()
        g = raw.get("GUI")
        return raw, (g if isinstance(g, dict) else {})

    def _set_gui(self, **values):
        # под блокировкой: два вызова интерфейса подряд (язык и опорный запуск) писали файл одновременно,
        # и один из них падал с Permission denied или терял изменение другого
        with self._gui_lock:
            raw, g = self._gui()
            g.update(values)
            raw["GUI"] = g
            write_json(raw)

    def _path(self, rel):
        """Путь внутри рабочей папки (защита от выхода за нее)."""
        p = (Path(self.folder) / rel).resolve()
        if Path(self.folder).resolve() not in p.parents and p != Path(self.folder).resolve():
            raise ValueError(tr("путь вне рабочей папки: {name}", name=rel))
        return p

    def _report(self, path):
        path = Path(path)
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return None
        c = self._cache.get(str(path))
        if c and c[0] == mtime:
            return c[1]
        try:
            r = read_report(path)
        except (OSError, UnicodeDecodeError):
            r = None
        self._cache[str(path)] = (mtime, r)
        return r

    def _start(self, kind, args, title, script=None):
        with self._lock:
            pid = self._next
            self._next += 1
        p = Proc(self, pid, kind, args, title, script)
        self._procs[pid] = p
        return p.info()

    # ---------------------------------------------------- состояние

    def state(self):
        """Все, что нужно панели: настройки (без пароля), скрипты, запуски, наблюдения, процессы."""
        raw, g = self._gui()
        cs = raw.get("connection_string") or ""
        folder = Path(self.folder)
        ref = g.get("reference")
        ref_report = self._report(folder / ref) if ref else None
        scripts = {}
        for p in sorted(folder.glob("*.sql"), key=lambda x: x.name.lower()):
            scripts[p.stem] = {"name": p.name, "stem": p.stem, "runs": [], "ignored": ignored_count(raw, p.stem)}
        for p in folder.glob("*.txt"):
            m = REPORT_RE.match(p.name)
            if not m or "_compare_" in p.name:
                continue
            r = self._report(p)
            if r is None:
                continue
            stem = m.group("stem")
            run = {"report": p.name, "ts": m.group("ts"), "aborted": r["aborted"], "time": r["summary"].get("time"),
                   "total": r["summary"].get("total"),
                   "repeat": r["run"].get("Прогонов"), "profile": bool(r["run"].get("Реестр")),
                   "mode": r["run"].get("Режим"), "note": (g.get("notes") or {}).get(p.name)}
            if ref_report is not None and p.name != ref:
                ok, why = comparable(r, ref_report)
                run["comparable"], run["why"] = ok, why
                if ok:
                    t0, t1 = ref_report["summary"].get("time"), r["summary"].get("time")
                    run["delta"] = round((t1 - t0) * 100 / t0) if t0 and t1 is not None else None
                    run["same"] = same_data(r, ref_report)
            scripts.setdefault(stem, {"name": stem + ".sql", "stem": stem, "runs": [], "missing": True})["runs"].append(run)
        for s in scripts.values():
            s["runs"].sort(key=lambda x: x["report"], reverse=True)
        sessions = []
        sdir = folder / cq.SESSIONS_DIR
        for p in (sdir.iterdir() if sdir.is_dir() else []):
            m = SESSION_DIR_RE.match(p.name)
            if m and p.is_dir():
                sessions.append({"folder": p.name, "spid": int(m.group("spid")), "ts": m.group("ts"),
                                 "note": (g.get("notes") or {}).get(p.name)})
        sessions.sort(key=lambda x: x["folder"], reverse=True)
        return {"folder": self.folder, "folder_name": folder.name or self.folder,
                "connection": {"server": conn_value(cs, "server"), "database": conn_value(cs, "database"),
                               "login": raw.get("login") or "", "has_password": bool(raw.get("password")),
                               "connection_string": cs},
                "reference": ref, "scripts": list(scripts.values()), "sessions": sessions,
                "session_reference": g.get("session_reference"),
                "params": g.get("params") or {}, "collapsed": g.get("collapsed") or [],
                "columns": g.get("columns") or {}, "tcollapsed": g.get("tcollapsed") or {}, "diff_tool": g.get("diff_tool") or "",
                "diff_found": (find_diff_tool(g.get("diff_tool")) or {}).get("name"),
                "notify": g.get("notify", True), "lang": g.get("lang"),
                "no_connection": no_connection(raw, g), "dbms": dbms_info(cs),
                "procs": [p.info() for p in self._procs.values()]}

    def poll(self, since):
        """События процессов с номером больше since. События до since интерфейс уже получил: они
        удаляются (запуск или наблюдение на часы дали бы сотни тысяч). Перезагруженная страница (--dev)
        получает только еще не полученные."""
        with self._lock:
            drop = min(max(0, since - self._base), len(self._events))
            del self._events[:drop]
            self._base += drop
            return {"seq": self._base + len(self._events), "events": [{"seq": n, "proc": pid, "ev": ev}
                                                                      for n, pid, ev in self._events],
                    "procs": [p.info() for p in self._procs.values()]}

    # ---------------------------------------------------- рабочая папка и настройки

    def choose_folder(self):
        if self._window is None:
            return None
        import webview
        kind = getattr(getattr(webview, "FileDialog", None), "FOLDER", None) or webview.FOLDER_DIALOG
        res = self._window.create_file_dialog(kind, directory=self.folder)
        if not res:
            return None
        self.folder = str(res[0] if isinstance(res, (list, tuple)) else res)
        self._set_gui(folder=self.folder)
        return self.folder

    def set_folder(self, folder):
        if not Path(folder).is_dir():
            raise ValueError(tr("нет папки: {name}", name=folder))
        self.folder = str(Path(folder).resolve())
        self._set_gui(folder=self.folder)
        return self.folder

    # ---------------------------------------------------- подключения (GUI.md §5.6)
    # Сохраненные подключения - "GUI".connections: [{id, connection_string, login, password}].
    # Активное - верхние ключи connection_string, login, password: их читает CLI, он о списке не знает.
    # Активное, которого нет в списке (настроено вручную в json), добавляется в список при чтении.
    # Пароли в интерфейс не передаются: только признак has_password.

    def _connections(self):
        """(raw, g, список подключений, id активного или None)."""
        raw, g = self._gui()
        items = [c for c in (g.get("connections") or []) if isinstance(c, dict) and c.get("id")]
        cur = (raw.get("connection_string") or "", raw.get("login") or "", raw.get("password") or "")
        active = next((c["id"] for c in items if (c.get("connection_string") or "", c.get("login") or "",
                                                  c.get("password") or "") == cur), None)
        if active is None and cur[0]:    # записывается сразу: id должен быть постоянным
            active = new_conn_id()
            items.insert(0, {"id": active, "connection_string": cur[0], "login": cur[1], "password": cur[2]})
            g["connections"] = items
            raw["GUI"] = g
            write_json(raw)
        return raw, g, items, active

    def connections(self):
        """Список для окна настроек: подписи «сервер — база — логин», без паролей; установленные драйверы
        (ODBC-драйверы SQL Server и есть ли psycopg для PostgreSQL)."""
        import importlib.util
        import cq_mssql
        _, _, items, active = self._connections()
        drivers = {"mssql": cq_mssql.sql_server_drivers(), "pg": importlib.util.find_spec("psycopg") is not None}
        return {"active": active, "drivers": drivers, "items": [
            {"id": c["id"], "connection_string": c.get("connection_string") or "", "login": c.get("login") or "",
             "has_password": bool(c.get("password")), "server": conn_value(c.get("connection_string"), "server"),
             "database": conn_value(c.get("connection_string"), "database")} for c in items]}

    def save_connection(self, conn_id, connection_string, login, password, activate=True, source=None):
        """Сохраняет подключение conn_id (None - новое); password None - не менять (у нового - взять
        у подключения source: «добавить как новое» на основе выбранного). activate - сделать активным
        (записать в верхние ключи для CLI). Возвращает id."""
        raw, g, items, _ = self._connections()
        c = next((x for x in items if x["id"] == conn_id), None)
        if c is None:
            src = next((x for x in items if x["id"] == source), {})
            c = {"id": new_conn_id(), "password": src.get("password") or ""}
            items.append(c)
        c["connection_string"], c["login"] = connection_string.strip(), login.strip()
        if password is not None:
            c["password"] = password
        g["connections"] = items
        raw["GUI"] = g
        if activate:
            raw["connection_string"], raw["login"], raw["password"] = c["connection_string"], c["login"], c["password"]
        write_json(raw)
        if activate:
            with self._db_lock:          # новое подключение - со следующего запроса
                self._close_db()
        return c["id"]

    def delete_connection(self, conn_id):
        """Убирает подключение из списка; активное убрать нельзя (его использует CLI)."""
        raw, g, items, active = self._connections()
        if conn_id == active:
            raise ValueError(tr("активное подключение убрать нельзя: сначала выберите и сохраните другое"))
        g["connections"] = [c for c in items if c["id"] != conn_id]
        raw["GUI"] = g
        write_json(raw)
        return True

    def test_connection(self, conn_id, connection_string, login, password):
        """Проверка подключения с введенными значениями (пустой пароль - сохраненный у conn_id):
        вход и один легкий запрос. Возвращает сервер, базу, логин, версию."""
        if password is None:
            _, _, items, _ = self._connections()
            password = next((c.get("password") or "" for c in items if c["id"] == conn_id), "")
        db = cq.get_dialect({"connection_string": connection_string.strip(), "login": login.strip(),
                             "password": password})
        t = time.time()
        conn = db.connect(cq.APP_NAME + " gui", timeout=10)
        try:
            out = db.server_props(cq.conn_query(conn))
        finally:
            conn.close()
        out["ms"] = round((time.time() - t) * 1000)
        out["dbms"] = db.name
        return out

    def set_gui(self, key, value):
        """Значения раздела "GUI": params, collapsed, notes и т. п."""
        if key not in ("params", "collapsed", "notes", "columns", "tcollapsed", "diff_tool", "notify", "lang"):
            raise ValueError(tr("неизвестный ключ GUI: {name}", name=key))
        self._set_gui(**{key: value})
        if key == "lang":
            set_lang(value)
        return True

    def set_note(self, key, text):
        """Заметка к запуску (имя отчета) или наблюдению (имя папки); пустой текст - удалить."""
        old = self._gui()[1].get("notes") or {}
        notes = dict(old)
        text = str(text or "").strip()
        if (old.get(key) or "") == text:
            return True
        if text:
            notes[key] = text
        else:
            notes.pop(key, None)
        self._set_gui(notes=notes)
        return True

    def set_reference(self, report):
        self._set_gui(reference=report)
        return True

    def set_session_reference(self, folder):
        """Опорное наблюдение (имя папки в Sessions_profile или None) - отдельно от опорного запуска."""
        self._set_gui(session_reference=folder)
        return True

    # ---------------------------------------------------- скрипты

    def read_script(self, name):
        text, _ = cq.read_sql(self._path(name))
        return {"name": name, "text": text}

    def save_script(self, name, text):
        p = self._path(name)
        enc = "utf-8"
        if p.exists():   # кодировка файла сохраняется: BOM -> utf-8-sig, не UTF-8 -> cp1251
            data = p.read_bytes()
            if data.startswith(b"\xef\xbb\xbf"):
                enc = "utf-8-sig"
            else:
                try:
                    data.decode("utf-8")
                except UnicodeDecodeError:
                    enc = "cp1251"
            if b"\r\n" in data:
                text = text.replace("\r\n", "\n").replace("\n", "\r\n")
        p.write_bytes(text.encode(enc))
        return True

    def new_script(self, name, source=None):
        """Новый пустой скрипт; source - имя скрипта, текст которого скопировать."""
        name = name.strip()
        if not name.lower().endswith(".sql"):
            name += ".sql"
        if re.search(r'[\\/:*?"<>|]', name):
            raise ValueError(tr("недопустимые символы в имени файла"))
        p = self._path(name)
        if p.exists():
            raise ValueError(tr("файл уже есть: {name}", name=name))
        if source:
            shutil.copyfile(self._path(Path(source).name), p)
        else:
            p.write_text("", encoding="utf-8")
        return name

    def delete_script(self, name, with_runs=False):
        """Файл скрипта - в корзину. with_runs - и все его запуски (как delete_run: отчет, CSV, реестр,
        файлы сравнения) вместе с подпапкой данных скрипта."""
        p = self._path(Path(name).name)
        if with_runs:
            for r in list(Path(self.folder).glob("*.txt")):
                m = REPORT_RE.match(r.name)
                if m and "_compare_" not in r.name and m.group("stem").lower() == p.stem.lower():
                    self.delete_run(r.name)
            data = p.with_suffix("")
            if data.is_dir():
                to_recycle_bin([data])
        to_recycle_bin([p])
        return True

    # ---------------------------------------------------- запуски

    def start_run(self, name, repeat, profile, rollback, explain=None):
        """explain - порог --explain в мс (0 - планы всех операторов), None - без планов."""
        args = [name]
        if repeat and int(repeat) >= 2:
            args += ["--repeat", str(int(repeat))]
        if profile:
            args.append("--profile")
        if rollback:
            args.append("--rollback")
        if explain is not None:
            args += ["--explain", str(max(int(explain), 0))]
        return self._start("run", args, name, Path(name).stem)

    def stop(self, pid):
        p = self._procs.get(pid)
        if p:
            p.stop()
        return True

    def run_details(self, report):
        p = self._path(report)
        r = self._report(p)
        if r is None:
            raise ValueError(tr("не удалось прочитать отчет: {name}", name=report))
        out = dict(r)
        out["tables"] = {str(k): v for k, v in r["tables"].items()}
        reg = r["run"].get("Реестр")
        out["registry"] = out["log"] = out["slow"] = None
        if reg:
            d = (p.parent / reg).parent
            out["registry_dir"] = str(d)
            out["registry"] = read_csv_rows(d / cq.REGISTRY_TABLE)[1]
            out["log"] = read_csv_rows(d / cq.REGISTRY_LOG)[1]
            out["slow"] = slow_info(registry_header(d / cq.REGISTRY_FILE))
            # PostgreSQL: функции, таблицы и операторы внутри функций (--profile, --explain), если есть и не пустые
            out["extra_tables"] = [{"file": str(d / name), "name": name, "header": head, "rows": rows}
                                   for name in EXTRA_TABLES for head, rows in [read_csv_rows(d / name)] if rows]
        jr = r["run"].get("Журнал")
        out["journal"] = read_journal(p.parent / jr) if jr else None
        _, g = self._gui()
        ref = g.get("reference")
        out["reference"] = None
        if ref and ref != report:
            rr = self._report(Path(self.folder) / ref)
            if rr is not None:
                ok, why = comparable(r, rr)
                diff = [n for n in r["tables"] if not same_data({"tables": {n: r["tables"][n]}},
                                                                {"tables": {n: rr["tables"][n]}})] if ok else []
                out["reference"] = {"report": ref, "summary": rr["summary"], "comparable": ok, "why": why,
                                    "same": not diff if ok else None, "diff_tables": diff,
                                    "compared": self.compare_cached(ref, report) is not None}
        out["note"] = (g.get("notes") or {}).get(report)
        out["line"] = self._lineage(report, g)
        return out

    def _lineage(self, report, g):
        """Линейка запуска (GUI.md §5.14): связная группа запусков, связанных файлами сравнения режима 2
        (связь несравнимых не считается). Пусто, если запуск ни с кем не сравнивали."""
        folder = Path(self.folder)
        parent = {}

        def root(x):
            while parent.setdefault(x, x) != x:
                x = parent[x]
            return x
        for p in folder.glob("*_compare_*.txt"):
            m = COMPARE_RE.match(p.name)
            if not m:
                continue
            a, b = m.group("a") + ".txt", m.group("b") + ".txt"
            ra, rb = self._report(folder / a), self._report(folder / b)
            if ra and rb and comparable(ra, rb)[0]:
                parent[root(a)] = root(b)
        if report not in parent:
            return []
        me = root(report)
        out = []
        for x in parent:
            if root(x) != me:
                continue
            m, r = REPORT_RE.match(x), self._report(folder / x)
            if m and r:
                out.append({"report": x, "ts": m.group("ts"), "stem": m.group("stem"), "time": r["summary"].get("time"),
                            "note": (g.get("notes") or {}).get(x)})
        return sorted(out, key=lambda x: x["ts"])

    def read_table(self, report, n, filt="", offset=0):
        """Содержимое CSV таблицы n: колонки, TABLE_ROWS подходящих строк после первых offset
        (кнопка "показать еще"), сколько всего.
        Без фильтра читаются только первые строки (число строк - из отчета). С фильтром файл читается
        целиком, но строка разбирается, только если текст фильтра есть в ней: тексты ячеек стоят в строке
        файла как есть, кроме удвоенных кавычек, поэтому для фильтра без кавычек проверка точная."""
        r = self._report(self._path(report))
        t = r["tables"].get(int(n)) if r else None
        if not t or not t.get("file"):
            raise ValueError(tr("файл таблицы не указан в отчете"))
        f = self._path(report).parent / t["file"]
        filt = (filt or "").casefold()
        quick = '"' not in filt
        offset = max(0, int(offset or 0))
        rows, total, matched = [], 0, 0
        with open(f, encoding=cq.FILE_ENCODING, newline="") as fh:
            head = cq.parse_line(fh.readline().rstrip("\r\n"))
            for line in fh:
                total += 1
                if not filt and len(rows) == TABLE_ROWS and t.get("rows") is not None:
                    total = matched = t["rows"]
                    break
                if filt and quick and filt not in line.casefold():
                    continue
                if not filt and matched < offset:      # пропускаемые строки без разбора
                    matched += 1
                    continue
                vals = [None if v == cq.NUL else v for v in cq.parse_line(line.rstrip("\r\n"))]
                if filt and not any(v is not None and filt in v.casefold() for v in vals):
                    continue
                matched += 1
                if offset < matched and len(rows) < TABLE_ROWS:
                    rows.append(vals)
        return {"file": str(f), "columns": head, "rows": rows, "total": total, "matched": matched,
                "key": t["key"], "ignored": t["ignored"]}

    def table_diff(self, report, n, base=None):
        """Чем таблица n запуска отличается от base (по умолчанию - от опорного): строки итога таблицы
        (как в сокращенном отчете режима 2) и примеры строк, не больше cq.EXAMPLE_ROWS каждого вида.
        Сравнение то же, что в режиме 2, в этом процессе; CSV только читаются, файлы сравнения не пишутся.
        A - base, B - этот запуск."""
        _, g = self._gui()
        ref = base or g.get("reference")
        if not ref:
            raise ValueError(tr("нет опорного запуска"))
        n = int(n)
        ra, rb = cq.parse_report(self._path(ref), "A"), cq.parse_report(self._path(report), "B")
        if n not in ra["tables"] or n not in rb["tables"]:
            raise ValueError(tr("таблицы {n} нет в одном из запусков", n=n))
        body, differs, _, examples = cq.compare_table(n, ra, rb)

        def cells(row):
            return [None if c == cq.NUL else c for c in row]

        for e in examples:
            for k in ("a", "b", "row"):
                if k in e:
                    e[k] = cells(e[k])
        t = rb["tables"][n]
        return {"names": t["names"], "key": [x for x in t["P"][:t["klen"]] if x != cq.DUP_COL],
                # примеры показываются таблицей, затраты к строкам не относятся
                "lines": [s for _, s in body if s and not s.startswith(("Пример ", "Затраты до таблицы"))],
                "examples": examples,
                "limit": cq.EXAMPLE_ROWS, "differs": differs}

    def delete_run(self, report):
        p = self._path(report)
        r = self._report(p)
        files = [p]
        if r:
            files += [p.parent / t["file"] for t in r["tables"].values() if t.get("file")]
            reg = r["run"].get("Реестр")
            if reg:
                files.append((p.parent / reg).parent)
        stem = p.stem
        files += [x for x in p.parent.glob("*_compare_*.txt") if x.name.startswith(stem + "__") or f"__{stem}_compare_" in x.name]
        to_recycle_bin(files)
        _, g = self._gui()
        if g.get("reference") == report:
            self._set_gui(reference=None)
        return True

    # ---------------------------------------------------- сравнение (режим 2)

    def compare(self, a, b):
        """Сравнение отчетов a (база) и b (проверяемый): процесс CLI, итог - в файлах сравнения."""
        return self._start("compare", [a, b], f"{a} ↔ {b}")

    def compare_cached(self, a, b):
        """Готовый файл сравнения отчетов a и b (последний) или None. Отчеты запусков не меняются,
        поэтому сравнение той же пары повторять незачем (GUI.md §6.7)."""
        stem = f"{Path(b).stem}__{Path(a).stem}_compare_"
        files = [p for p in Path(self.folder).glob(glob.escape(stem) + "*.txt")
                 if COMPARE_RE.match(p.name) and not p.stem.endswith("_short")]
        return max(files, key=lambda p: p.name).name if files else None

    def compare_text(self, path):
        p = Path(path)
        short = p.with_name(p.stem + "_short.txt")
        return {"short": short.read_text(encoding="utf-8-sig") if short.exists() else "",
                "full": p.read_text(encoding="utf-8-sig") if p.exists() else ""}

    def compare_details(self, path, a, b, all_ops=False):
        """Экран сравнения (GUI.md §4.2): разбор полного файла сравнения режима 2 и отчетов A и B.
        Таблицы - заголовок и строки раздела; операторы - те же пары, что в разделе «Операторы»
        (cq.statement_changes по registry.csv обоих запусков), с началом текста, первым ожиданием B
        и файлами текста и плана оператора в каждом запуске (пути; нет файла - None). all_ops - все пары
        операторов без отбора значимых (не больше STMT_ALL_TOP, count - сколько всего); waits - колонки
        ожиданий обоих реестров для полос долей ожиданий."""
        p = self._path(path)
        sections = []
        for line in p.read_text(encoding="utf-8-sig").split("\n"):
            line = line.rstrip("\r")
            if line.startswith("# "):
                sections.append((line[2:].strip(), []))
            elif sections and line.strip():
                sections[-1][1].append(line)
        ra, rb = self._report(self._path(a)), self._report(self._path(b))
        out = {"head": [], "tables": [], "statements": None, "statement_notes": [],
               "time": [x["summary"].get("time") if x else None for x in (ra, rb)],
               "scripts": [(x["run"].get("SQL-файл") or "").split(",")[0] if x else "" for x in (ra, rb)],
               "notes": [(self._gui()[1].get("notes") or {}).get(x) for x in (a, b)],
               "why": comparable(ra, rb)[1] if ra and rb else None}     # несравнимы (GUI.md §5.13) - причина
        for title, lines in sections:
            m = re.fullmatch(r"Таблица (\d+): (.+)", title)
            if title == "Сравнение":
                out["head"] = lines
            elif m:
                out["tables"].append({"n": int(m.group(1)), "state": m.group(2), "lines": lines})
            elif title.startswith("Операторы"):
                out["statements"] = []
                for s in lines:
                    sm = STMT_RE.match(s)
                    if sm:
                        out["statements"].append({k: (int(v) if v and v.isdigit() else v) for k, v in sm.groupdict().items()})
                    else:
                        out["statement_notes"].append(s)
        if out["statements"] is not None and ra and rb and ra["run"].get("Реестр") and rb["run"].get("Реестр"):
            regs = []
            for x, rp, lbl in ((ra, self._path(a), "A"), (rb, self._path(b), "B")):
                rows, err = cq.read_registry({"run": x["run"], "dir": rp.parent, "label": lbl})
                regs.append((rows, (rp.parent / x["run"]["Реестр"]).parent))
            if regs[0][0] is not None and regs[1][0] is not None:
                changes = cq.statement_changes(regs[0][0], regs[1][0], significant=not all_ops)
                out["statements"] = statement_rows(changes[:STMT_ALL_TOP], regs[0][1], regs[1][1])
                out["all"], out["count"] = all_ops, len(changes)
                out["waits"] = [reg_waits(regs[0][0]), reg_waits(regs[1][0])]
        return out

    def compare_sessions(self, a, b):
        """Сравнение наблюдений a (база) и b (по имени папки в Sessions_profile): процесс CLI с двумя папками."""
        da, db = (self._path(Path(cq.SESSIONS_DIR) / Path(x).name) for x in (a, b))
        return self._start("compare", [str(da), str(db)], f"{da.name} ↔ {db.name}")

    def session_compare_details(self, a, b, all_ops=False):
        """Экран сравнения наблюдений (GUI.md §4.3): то же, что файл сравнения (cq.registry_compare),
        с началом текста, первым ожиданием B и файлами текста и плана оператора в каждом наблюдении.
        all_ops, count, waits - как у compare_details."""
        da, db = (self._path(Path(cq.SESSIONS_DIR) / Path(x).name) for x in (a, b))
        c = cq.registry_compare(da, db)
        changes = cq.statement_changes(c["rows"][0], c["rows"][1], c["pairs"], significant=False) if all_ops else c["changes"]
        statements = statement_rows(changes[:STMT_ALL_TOP], da, db, runs=True)
        g = self._gui()[1].get("notes") or {}
        return {"total": c["total"], "notes": [f for f, _ in c["notes"]], "objects": c["objects"],
                "statements": statements, "all": all_ops, "count": len(changes),
                "waits": [reg_waits(c["rows"][0]), reg_waits(c["rows"][1])], "names": [da.name, db.name],
                "heads": [registry_header(d / cq.REGISTRY_FILE) for d in (da, db)],
                "note_text": [g.get(da.name), g.get(db.name)]}

    # ---------------------------------------------------- внешний diff (GUI.md §5.5)

    def diff_info(self, kind, args):
        """Какие два файла и какой программой откроются: {"files": [A, B], "tool": имя или None}."""
        a, b = self._diff_files(kind, args)
        _, g = self._gui()
        tool = find_diff_tool(g.get("diff_tool"))
        return {"files": [a.name, b.name], "tool": tool["name"] if tool else None}

    def diff_rows(self, a, b, n):
        """Только отличающиеся строки таблицы n двух запусков (A - a, B - b): два CSV в папке данных B рядом с CSV
        этой таблицы - <таблица B>__<запуск A>_diff_A.csv и ..._diff_B.csv (имена начинаются с таблицы B, поэтому
        оба файла стоят рядом с ней и друг с другом; повторное нажатие перезаписывает их). Строка «изменена» - в
        обоих файлах на одном месте, «только в A/B» - в своем; порядок - ключа сравнения. Затем папка с выделенным
        файлом B и через 300 мс поверх нее - программа сравнения (GUI.md §4.2)."""
        n = int(n)
        ra, rb = cq.parse_report(self._path(a), "A"), cq.parse_report(self._path(b), "B")
        if n not in ra["tables"] or n not in rb["tables"]:
            raise ValueError(tr("таблицы {n} нет в одном из запусков", n=n))
        _, _, error, examples = cq.compare_table(n, ra, rb, limit=None)
        if error or not examples:
            raise ValueError(tr("отличающихся строк нет: строки таблиц не сравнивались (другая структура или ошибка)")
                             if error or not rb["tables"][n].get("file") else tr("отличающихся строк нет"))
        tb = rb["tables"][n]
        src = self._path(b).parent / tb["file"]
        if not src.is_file():
            src = self._path(b).parent / Path(tb["file"]).name       # старый отчет: данные рядом с ним
        base = f"{src.stem}__{Path(a).stem}_diff"
        files = {side: src.parent / f"{base}_{side}.csv" for side in ("A", "B")}
        out = {"A": [], "B": []}
        for e in examples:
            if e["kind"] == "diff":
                out["A"].append(e["a"])
                out["B"].append(e["b"])
            else:
                out[e["kind"]].append(e["row"])
        head = cq.DELIM.join(cq.format_cell(cq.escape(x)) for x in tb["names"])
        for side, path in files.items():
            with open(path, "w", encoding=cq.FILE_ENCODING, newline="\n") as f:
                f.write(head + "\n")
                for row in out[side]:
                    f.write(cq.DELIM.join(cq.format_cell(c) for c in row) + "\n")
        self.show_in_folder(files["B"])
        _, g = self._gui()
        tool = find_diff_tool(g.get("diff_tool"))
        if tool:
            time.sleep(0.3)              # сравнение - поверх уже открытой папки
            subprocess.Popen(tool["cmd"] + [str(files["A"]), str(files["B"])], creationflags=0x08000000 if os.name == "nt" else 0)
        return {"tool": tool["name"] if tool else None, "a": len(out["A"]), "b": len(out["B"]),
                "files": [files["A"].name, files["B"].name]}

    def run_diff(self, kind, args):
        a, b = self._diff_files(kind, args)
        _, g = self._gui()
        tool = find_diff_tool(g.get("diff_tool"))
        if not tool:
            raise ValueError(tr("программа сравнения не найдена: укажите путь в настройках (клик по базе вверху панели)"))
        subprocess.Popen(tool["cmd"] + [str(a), str(b)], creationflags=0x08000000 if os.name == "nt" else 0)
        return True

    def _diff_files(self, kind, args):
        """Пары файлов для внешнего diff: reports [A, B] - отчеты; scripts [A, B] - SQL-файлы отчетов;
        table [A, B, N] - CSV таблицы N; script [имя.sql] - скрипт и SQL-файл опорного запуска; stmt [A, B] -
        тексты оператора из файлов реестров (во временные файлы)."""
        def report(name):
            r = self._report(self._path(name))
            if r is None:
                raise ValueError(tr("не удалось прочитать отчет: {name}", name=name))
            return r

        def sql_of(name):
            return self._path((report(name)["run"].get("SQL-файл") or "").split(",")[0].strip())

        if kind == "reports":
            return self._path(args[0]), self._path(args[1])
        if kind == "scripts":
            return sql_of(args[0]), sql_of(args[1])
        if kind == "table":
            out = []
            for name in args[:2]:
                t = report(name)["tables"].get(int(args[2]))
                if not t or not t.get("file"):
                    raise ValueError(tr("нет таблицы {n} в {name}", n=args[2], name=name))
                out.append(self._path(name).parent / t["file"])
            return out[0], out[1]
        if kind == "script":
            _, g = self._gui()
            if not g.get("reference"):
                raise ValueError(tr("нет опорного запуска"))
            return sql_of(g["reference"]), self._path(args[0])
        if kind == "stmt":
            # тексты оператора [A, B] (NNN - T.sql реестров): во временные файлы только текст, без двух
            # строк комментария (объект и строка, значения реестра) - иначе они различались бы всегда
            out = []
            for side, f in zip("AB", args[:2]):
                lines = self._path(f).read_text(encoding="utf-8-sig", errors="replace").split("\n")
                k = 0
                while k < 2 and k < len(lines) and lines[k].startswith("--"):
                    k += 1
                out.append(temp_file(f"{side} - {Path(f).name}", "\n".join(lines[k:])))
            return out[0], out[1]
        raise ValueError(tr("неизвестный вид сравнения: {kind}", kind=kind))

    # ---------------------------------------------------- игнорируемые колонки (GUI.md §5.6, §6.3)

    def ignore_info(self, script):
        """Для окна игнорируемых колонок: группы ignored_columns как в json, имена скриптов папки
        (для областей), таблицы и колонки последнего завершенного запуска скрипта."""
        raw = read_json()
        stem = Path(script).stem
        last = None
        for p in Path(self.folder).glob("*.txt"):
            m = REPORT_RE.match(p.name)
            if m and m.group("stem") == stem and "_compare_" not in p.name and (last is None or p.name > last.name):
                r = self._report(p)
                if r and not r["aborted"]:
                    last = p
        r = self._report(last) if last else None
        return {"groups": raw.get(ignored_key(raw)) or [], "stem": stem,
                "scripts": sorted(p.stem for p in Path(self.folder).glob("*.sql")),
                "tables": {str(n): t["names"] for n, t in r["tables"].items()} if r else {}}

    def save_ignored(self, groups):
        """Записывает ignored_columns (проверка - как у CLI); остальные ключи json не меняются."""
        if not isinstance(groups, list):
            raise ValueError(tr("ignored_columns должен быть списком"))
        for g in groups:
            ok = isinstance(g, dict) and isinstance(g.get("mask"), str) and isinstance(g.get("tables"), dict) and all(
                (t == "*" or str(t).isdigit()) and isinstance(c, list) and all(isinstance(x, str) for x in c)
                for t, c in g["tables"].items())
            if not ok:
                raise ValueError(tr("неверный элемент ignored_columns"))
        raw = read_json()
        raw[ignored_key(raw)] = groups
        write_json(raw)
        return True

    # ---------------------------------------------------- наблюдение за сессией

    # ---------------------------------------------------- запросы GUI к серверу
    # GUI сам читает только системные представления: список сессий (§5.9), «Текущие запросы» (§5.20),
    # «Тяжелые запросы» (§5.21), тексты и планы по кнопке; меняет только KILL и отмена запроса по подтверждению.
    # Запросы - в диалекте СУБД (cq.get_dialect), те же, что у CLI --show. Одно подключение на все
    # (APP "CompareQuery gui", в свои же списки не попадает), переиспользуется; при ошибке открывается заново.

    def _dialect(self):
        """Диалект СУБД активного подключения; после смены подключения (_close_db) - заново."""
        with self._db_lock:
            if self._db is None:
                self._db = cq.get_dialect(cq.read_settings())
            return self._db

    def _query(self, sql, *params, sets=1):
        """Строки результата (cq.fetch_sets): sets=1 - список строк, N - список наборов, -1 - последний набор."""
        with self._db_lock:
            db = self._dialect()
            try:
                if self._conn is None:
                    self._conn = db.connect(cq.APP_NAME + " gui", timeout=15, query_timeout=DB_TIMEOUT_S)
                cur = self._conn.cursor()
                try:
                    cur.execute(sql, *params)
                    return cq.fetch_sets(cur, sets)
                finally:
                    cur.close()
            except db.Error:
                self._close_db()
                raise

    def _close_db(self):
        self._db = None
        conn, self._conn = self._conn, None
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    def list_sessions(self):
        """Один легкий запрос списка пользовательских сессий (GUI.md §5.9)."""
        with self._db_lock:
            return self._dialect().sessions(self._query)

    def current_queries(self):
        """«Текущие запросы» (GUI.md §5.20): строки и итоги по серверу. Текст - только оператор."""
        with self._db_lock:
            return self._dialect().current(self._query)

    def _pause(self, seconds):
        """Пауза замера: на это время подключение свободно для других запросов GUI («Текущие запросы»)."""
        self._db_lock.release()
        try:
            time.sleep(seconds)
        finally:
            self._db_lock.acquire()

    @staticmethod
    def _part(out, name, fn):
        """Раздел экрана: результат fn() или {"err": текст} - ошибка одного раздела не мешает остальным."""
        try:
            out[name] = fn()
        except ValueError as e:
            out[name] = {"err": tr(str(e))}
        except Exception as e:
            out[name] = {"err": cq.err_text(e)}

    def databases(self):
        """Базы для выбора на экранах «Нагрузка сервера» и «База данных»."""
        with self._db_lock:
            return self._dialect().databases(self._query)

    def server_load(self, parts, db=None, interval=0, order=None, hours=0, top=100):
        """«Нагрузка сервера» (GUI.md §5.21): разделы parts из heavy, waits, io за одни и те же секунды. interval -
        разница двух снимков с паузой interval секунд (0 - накоплено с перезапуска или сброса статистики;
        ожидания PostgreSQL - всегда замер, WAITS_DEFAULT_S). Порядок: первый снимок тяжелых запросов, первый
        снимок ввода-вывода, замер ожиданий (он же пауза), вторые снимки. db - отбор по базе, где он есть
        (dialect.load_by_db). У MS SQL Server тяжелых запросов за интервал нет: hours - «за последние часы»."""
        parts, interval, db, out = set(parts), int(interval or 0), db or None, {}
        with self._db_lock:
            d = self._dialect()
            order = order or d.heavy_orders[0]
            if order not in d.heavy_orders:
                raise ValueError(tr("неизвестный показатель: {name}", name=order))
            done = []

            def middle(seconds):           # между снимками тяжелых запросов (или без них)
                done.append(True)
                spec = d.stats_spec["io"]
                io1 = {}
                if "io" in parts and seconds:
                    self._part(io1, "r", lambda: d.stats("io", self._query))
                if "waits" in parts:
                    self._part(out, "waits", lambda: self._waits(d, seconds, db))
                elif seconds:
                    self._pause(seconds)
                if "io" in parts:
                    def io():
                        if "err" in io1.get("r", {}):
                            return io1["r"]
                        res = d.stats("io", self._query)
                        rows = (cq.delta_rows(io1["r"]["rows"], res["rows"], spec["key"], spec["counters"]) if seconds
                                else [r for r in res["rows"] if any(r.get(c) for c in spec["counters"])])
                        if db and "io" in d.load_by_db:
                            rows = [r for r in rows if (r.get("db") or "").lower() == db.lower()]
                        return {"rows": rows, "note": tr(res["note"]) if res["note"] else None, "seconds": seconds}
                    self._part(out, "io", io)

            if "heavy" in parts:
                hint = interval if d.heavy_interval else 0
                self._part(out, "heavy", lambda: {"rows": d.heavy(self._query, order, hours, top, hint,
                                                                  middle if hint else None, db=db), "seconds": hint})
            if not done:
                middle(interval)
        return out

    def _waits(self, d, seconds, db):
        res = d.waits(self._query, seconds, self._pause, db=db)
        res.pop("note", None)            # пояснение строит интерфейс (перевод)
        return res

    def db_info(self, part, db):
        """«База данных» (GUI.md §5.28): раздел part (space, tables, functions, temp) базы db. Временные данные -
        всего сервера (tempdb у MS SQL Server)."""
        with self._db_lock:
            d = self._dialect()
            if part == "temp" or (part == "space" and not d.space_per_db):
                res = (d.temp if part == "temp" else d.space)(self._query)
            elif part in ("space", "tables", "functions"):
                if not db:
                    raise ValueError(tr("база не выбрана"))
                fn = {"space": d.space, "tables": d.tables,
                      "functions": lambda q: d.stats("functions", q)}[part]
                try:
                    res = d.in_db(self._query, db, fn)
                except ValueError as e:
                    raise ValueError(tr(str(e)))
            else:
                raise ValueError(tr("неизвестный раздел: {name}", name=part))
        if res.get("note"):
            res["note"] = "; ".join(tr(x) for x in res["note"].split("; "))
        return res

    def table_indexes(self, db, table_id):
        """Индексы таблицы (строка раздела «Таблицы» раскрывается)."""
        with self._db_lock:
            d = self._dialect()
            return d.in_db(self._query, db, lambda q: d.indexes(q, table_id))

    def table_columns(self, db, table_id):
        """Столбцы таблицы (вторая подтаблица строки раздела «Таблицы»)."""
        with self._db_lock:
            d = self._dialect()
            return d.in_db(self._query, db, lambda q: d.columns(q, table_id))

    def table_triggers(self, db, table_id):
        """Триггеры таблицы (подтаблица строки раздела «Таблицы»)."""
        with self._db_lock:
            d = self._dialect()
            res = d.in_db(self._query, db, lambda q: d.triggers(q, table_id))
        if res.get("note"):
            res["note"] = tr(res["note"])
        return res

    def table_sql(self, db, table_id):
        """SQL создания таблицы по каталогу (кнопка у строки раздела «Таблицы»)."""
        with self._db_lock:
            d = self._dialect()
            try:
                return d.in_db(self._query, db, lambda q: d.table_sql(q, table_id))
            except ValueError as e:
                raise ValueError(tr(str(e)))

    def temp_tables(self):
        """Самые большие временные таблицы tempdb (MS SQL Server, по кнопке)."""
        with self._db_lock:
            return self._dialect().temp_tables(self._query)

    def open_plan(self, plan_handle, start, end, name):
        """План оператора (как у CLI) - во временный файл (.sqlplan) и открыть."""
        with self._db_lock:
            db = self._dialect()
            plan = db.plan(self._query, bytes.fromhex(plan_handle), start, end)
        if not plan:
            raise ValueError(tr("плана уже нет в кэше сервера"))
        os.startfile(str(temp_file(f"{name}{db.plan_ext}", plan)))
        return True

    def input_buffer(self, spid):
        """Исходный запрос сессии - что прислал клиент (вызов процедуры с параметрами, батч)."""
        with self._db_lock:
            return (self._dialect().input_buffer(self._query, int(spid)) or "").strip()

    def read_text(self, path):
        """Текстовый файл внутри рабочей папки (текст оператора реестра) - для окна текста."""
        p = self._path(path)
        plan = next((x for x in (p.with_suffix(".sqlplan"), p.with_suffix(".txt")) if x.is_file()), None)
        return {"text": p.read_text(encoding="utf-8-sig", errors="replace"),
                "plan": str(plan) if plan else None}

    def open_text(self, name, text):
        """Текст запроса - во временный .sql и открыть программой по умолчанию."""
        os.startfile(str(temp_file(f"{name}.sql", text)))
        return True

    def estimate_plan(self, text, db=None, name="plan"):
        """Оценочный план оператора (PostgreSQL: EXPLAIN без выполнения, на отдельном подключении только для
        чтения к базе db; None - база подключения) - во временный .txt и открыть."""
        with self._db_lock:
            d = self._dialect()
        if not d.can_estimate:
            raise ValueError(tr("оценочного плана у этой СУБД нет"))
        try:
            plan = d.estimate_plan(text, db or None)
        except ValueError as e:
            raise ValueError(tr(str(e)))
        os.startfile(str(temp_file(f"{name}_estimate.txt", plan)))
        return True

    def cancel_query(self, spid):
        """Отменить текущий запрос сессии (PostgreSQL: pg_cancel_backend; сессия остается) - по подтверждению."""
        with self._db_lock:
            d = self._dialect()
            if not d.can_cancel:
                raise ValueError(tr("отменить запрос у этой СУБД нельзя, только закрыть сессию"))
            try:
                d.cancel(self._query, spid)
            except ValueError as e:
                raise ValueError(tr(str(e)))
        return True

    def kill_session(self, spid):
        """KILL сессии - единственное изменение на сервере из GUI, только по подтверждению пользователя."""
        with self._db_lock:
            try:
                self._dialect().kill(self._query, spid)
            except ValueError as e:
                raise ValueError(tr(str(e)))
        return True

    def start_session(self, spid):
        return self._start("session", ["--session", str(int(spid))], f"Сессия {int(spid)}")

    def delete_session(self, name):
        """Наблюдение - его папка в Sessions_profile - в корзину (GUI.md §6.5)."""
        to_recycle_bin([self._path(Path(cq.SESSIONS_DIR) / Path(name).name)])
        if self._gui()[1].get("session_reference") == Path(name).name:
            self._set_gui(session_reference=None)
        return True

    def notify(self, title, text):
        """Уведомление Windows (GUI.md §5.17) через PowerShell и WinRT ToastNotificationManager
        (Windows 8+); без окна, ошибки не важны."""
        def x(s):
            return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                    .replace('"', "&quot;").replace("'", "''"))
        ps = ("[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;"
              "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null;"
              "$x = New-Object Windows.Data.Xml.Dom.XmlDocument;"
              # ToastText02 и New-Object: шаблон и синтаксис есть и в Windows 8.1 (PowerShell 4)
              f"$x.LoadXml('<toast><visual><binding template=\"ToastText02\"><text id=\"1\">{x(title)}</text>"
              f"<text id=\"2\">{x(text)}</text></binding></visual></toast>');"
              "$t = New-Object Windows.UI.Notifications.ToastNotification $x;"
              "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("
              "'{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($t)")
        import base64
        enc = base64.b64encode(ps.encode("utf-16-le")).decode()
        subprocess.Popen(["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", enc],
                         creationflags=0x08000000, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)
        return True

    def session_details(self, name, log_tail=0):
        """Наблюдение по имени папки в Sessions_profile; log_tail - из журнала только последние строки (идущее)."""
        d = self._path(Path(cq.SESSIONS_DIR) / Path(name).name)
        h = registry_header(d / cq.REGISTRY_FILE)
        return {"folder": str(d), "header": h, "registry": read_csv_rows(d / cq.REGISTRY_TABLE)[1],
                "log": read_csv_rows(d / cq.REGISTRY_LOG, log_tail)[1], "slow": slow_info(h),
                "note": (self._gui()[1].get("notes") or {}).get(d.name)}

    # ---------------------------------------------------- внешние действия

    def open_path(self, path):
        os.startfile(str(Path(path)))
        return True

    def open_url(self, url):
        """Страница в браузере по умолчанию (только http/https)."""
        if not re.match(r"https?://", str(url)):
            raise ValueError(tr("ожидается адрес http(s)"))
        os.startfile(str(url))
        return True

    def open_help(self):
        """README на языке интерфейса: README.<язык>.md, если есть, иначе README.md (русский)."""
        _, g = self._gui()
        root = HERE if (HERE / "README.md").exists() else HERE.parent      # программа в src, документация в корне
        p = root / f"README.{g.get('lang')}.md"
        os.startfile(str(p if g.get("lang") not in (None, "ru") and p.exists() else root / "README.md"))
        return True

    def show_in_folder(self, path):
        subprocess.Popen(["explorer", "/select,", str(Path(path))])
        return True

    # ---------------------------------------------------- закрытие

    def running(self):
        return [p.info() for p in self._procs.values() if p.code is None]

    def close_app(self):
        """Остановить процессы (не дольше ~2 с ждать) и закрыть окно (GUI.md §6.6)."""
        for p in self._procs.values():
            p.stop()
        end = time.time() + 2
        while time.time() < end and any(p.code is None for p in self._procs.values()):
            time.sleep(0.05)
        self._close_db()
        self._close_ok = True
        if self._window is not None:
            threading.Thread(target=self._window.destroy, daemon=True).start()
        return True


# ============================================================ запуск

def quiet_dpi_warning(record):
    """Windows 8.1: GetDpiForWindow есть только с Windows 10 (1607). pywebview тогда берет масштаб 1
    (окно работает) и пишет предупреждение при каждом перемещении и изменении размера окна."""
    return "GetDpiForWindow" not in record.getMessage()


def window_size(webview):
    """Размер окна по умолчанию: 1920x1080 минус 10% (1728x972), на экране меньше - 90% экрана."""
    try:
        s = webview.screens[0]
        sw, sh = s.width, s.height
    except Exception:                    # старый pywebview: размер экрана из Windows
        sw, sh = ctypes.windll.user32.GetSystemMetrics(0), ctypes.windll.user32.GetSystemMetrics(1)
    return min(1728, int(sw * 0.9)), min(972, int(sh * 0.9))


def run_window(api):
    import webview
    logging.getLogger("pywebview").addFilter(quiet_dpi_warning)
    w, h = window_size(webview)
    window = webview.create_window("CompareQuery", url=str(WEB / "index.html"), js_api=api, width=w, height=h,
                                   min_size=(min(1100, w), min(700, h)), background_color="#F7F8FC")
    api._window = window

    def on_closing():
        if api._close_ok or not api.running():
            return True
        window.evaluate_js("window.cqAskClose && window.cqAskClose()")
        return False
    window.events.closing += on_closing
    webview.start(http_server=True)


def run_dev(api, port=DEV_PORT):
    """Режим отладки: интерфейс в браузере, API через POST /api/<метод> с JSON-списком аргументов."""
    from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(WEB), **k)

        def log_message(self, *a):
            pass

        def do_GET(self):
            # метка режима для JS (window.CQ_DEV): api() идет через fetch только здесь. Раньше JS угадывал режим
            # по тому, появился ли window.pywebview за 300 мс: окно, открывшееся медленнее, слало POST серверу
            # pywebview и показывало «Unexpected token '<' ... is not valid JSON» (его страница ошибки).
            if self.path.split("?")[0] not in ("/", "/index.html"):
                return super().do_GET()
            html = (WEB / "index.html").read_text(encoding="utf-8")
            data = html.replace("<script", "<script>window.CQ_DEV = true;</script>\n<script", 1).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            name = self.path.rsplit("/", 1)[-1]
            try:
                args = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"[]")
                if name.startswith("_") or not callable(getattr(api, name, None)):
                    raise ValueError(f"нет метода {name}")
                body, code = json.dumps(getattr(api, name)(*args), ensure_ascii=False, default=str), 200
            except Exception as e:
                body, code = json.dumps({"error": cq.err_text(e)}, ensure_ascii=False), 500
            data = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"CompareQuery GUI (отладка): http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


def main():
    api = Api()
    if "--dev" in sys.argv:
        run_dev(api)
    else:
        try:
            run_window(api)
        except ImportError:
            print("Не установлен pywebview: pip install pywebview", file=sys.stderr)
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
