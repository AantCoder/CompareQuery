#!/usr/bin/env python3
"""CompareQuery GUI: оболочка над CompareQuery.py (принципы и экраны - GUI.md).

Запуск:   python CompareQueryGUI.py          окно (pip install pywebview)
Отладка:  python CompareQueryGUI.py --dev    тот же интерфейс в браузере: http://127.0.0.1:8766

GUI читает файлы запусков и CompareQuery.json и запускает CompareQuery.py отдельными процессами
(--events --parent-pid). Сам он обращается к серверу только легкими чтениями DMV: список сессий
(GUI.md §5.9), «Текущие запросы» (§5.20), «Тяжелые запросы» (§5.21), тексты и планы по кнопке;
единственное изменение - KILL сессии по подтверждению пользователя. Свое состояние хранит в разделе
"GUI" CompareQuery.json.
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
# Служебные подключения CompareQuery (контрольное, наблюдение, сам GUI) в списках сессий не показываются.
# Рабочее подключение прогона (APP=CompareQuery) показывается: тестовые запросы бывают тяжелыми.
SERVICE_APPS = "(" + ", ".join(f"'{cq.APP_NAME} {x}'" for x in ("control", "session", "gui")) + ")"
SESSIONS_SQL = (
    "SELECT s.session_id, DB_NAME(s.database_id), s.program_name, s.host_name, s.login_name, "
    "r.total_elapsed_time, OBJECT_SCHEMA_NAME(t.objectid, t.dbid) + '.' + OBJECT_NAME(t.objectid, t.dbid) "
    "FROM sys.dm_exec_sessions s "
    "LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id "
    "OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t "
    "WHERE s.is_user_process = 1 AND s.session_id <> @@SPID "
    "AND ISNULL(s.program_name, '') NOT IN " + SERVICE_APPS)

# «Текущие запросы» (GUI.md §5.20), раз в 3 с: пользовательские сессии с запросом и те, кто блокирует
# других (в том числе простаивающие с открытой транзакцией). Только DMV по активным запросам и текст
# оператора; план и исходный запрос - по кнопке. Второй набор - итоги по серверу.
CURRENT_SQL = (
    "SET NOCOUNT ON; "
    "SELECT s.session_id, DB_NAME(COALESCE(r.database_id, s.database_id)), s.login_name, s.host_name, s.program_name, "
    "s.status, r.status, r.command, r.total_elapsed_time, r.cpu_time, r.logical_reads, r.reads, r.writes, "
    "r.granted_query_memory, r.wait_type, r.wait_time, r.blocking_session_id, r.open_transaction_count, "
    "r.percent_complete, r.plan_handle, r.statement_start_offset, r.statement_end_offset, b.blocked, "
    "t.dbid, t.objectid, OBJECT_SCHEMA_NAME(t.objectid, t.dbid) + '.' + OBJECT_NAME(t.objectid, t.dbid), t.text, "
    "DATEDIFF(SECOND, s.last_request_start_time, GETDATE()), lt.text, COALESCE(r.start_time, s.last_request_start_time) "
    "FROM sys.dm_exec_sessions s "
    "LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id "
    "LEFT JOIN (SELECT blocking_session_id, COUNT(*) blocked FROM sys.dm_exec_requests "
    "  WHERE blocking_session_id > 0 AND blocking_session_id <> session_id GROUP BY blocking_session_id) b "
    "  ON b.blocking_session_id = s.session_id "
    "OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t "
    # у простаивающей блокирующей сессии - ее последний запрос (кто оставил открытую транзакцию)
    "LEFT JOIN sys.dm_exec_connections c ON c.session_id = s.session_id AND r.session_id IS NULL "
    "OUTER APPLY sys.dm_exec_sql_text(c.most_recent_sql_handle) lt "
    "WHERE s.is_user_process = 1 AND s.session_id <> @@SPID "
    "AND ISNULL(s.program_name, '') NOT IN " + SERVICE_APPS + " "
    "AND (r.session_id IS NOT NULL OR b.blocked IS NOT NULL); "
    "SELECT (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1), "
    "(SELECT SUM(runnable_tasks_count) FROM sys.dm_os_schedulers WHERE status = 'VISIBLE ONLINE'), "
    "(SELECT COUNT(*) FROM sys.dm_exec_query_memory_grants WHERE grant_time IS NULL), SYSDATETIME()")
CURRENT_COLS = ("spid", "db", "login", "host", "program", "session_status", "status", "command", "elapsed", "cpu",
                "reads", "physical", "writes", "memory", "wait", "wait_ms", "blocked_by", "trans", "percent",
                "plan_handle", "start", "end", "blocks", "dbid", "objectid", "object", "text", "idle_s", "last_text",
                "req_start")
# исходный запрос сессий (первоначальный вызов клиента) - только для новых запросов: ключ (сессия, начало
# запроса), один запрос на все новые сессии, без функции (до SQL Server 2014 SP2) - не спрашивается
INPUT_BUFFERS_SQL = ("SELECT s.session_id, ib.event_info FROM sys.dm_exec_sessions s "
                     "CROSS APPLY sys.dm_exec_input_buffer(s.session_id, NULL) ib WHERE s.session_id IN ({ids})")

# «Тяжелые запросы» (GUI.md §5.21), по кнопке: статистика кэша планов. Один проход по
# sys.dm_exec_query_stats с сортировкой TOP N (без полной сортировки); текст - только для N строк
# (TOP во вложенном запросе), планы - по кнопке. Итоги накоплены с момента компиляции плана.
HEAVY_ORDER = {
    "cpu": "total_worker_time", "cpu_avg": "total_worker_time / NULLIF(execution_count, 0)",
    "time": "total_elapsed_time", "time_avg": "total_elapsed_time / NULLIF(execution_count, 0)",
    "reads": "total_logical_reads", "reads_avg": "total_logical_reads / NULLIF(execution_count, 0)",
    "writes": "total_logical_writes", "execs": "execution_count", "max_time": "max_elapsed_time",
}
HEAVY_SQL = (
    "SELECT x.plan_handle, x.statement_start_offset, x.statement_end_offset, x.execution_count, "
    "x.total_worker_time, x.total_elapsed_time, x.max_elapsed_time, x.total_logical_reads, "
    "x.total_physical_reads, x.total_logical_writes, x.total_rows, x.last_execution_time, x.creation_time, "
    "DB_NAME(t.dbid), OBJECT_SCHEMA_NAME(t.objectid, t.dbid) + '.' + OBJECT_NAME(t.objectid, t.dbid), t.text "
    "FROM (SELECT TOP (?) * FROM sys.dm_exec_query_stats "
    "  WHERE last_execution_time >= DATEADD(HOUR, -?, GETDATE()) ORDER BY {order} DESC) x "
    "OUTER APPLY sys.dm_exec_sql_text(x.sql_handle) t ORDER BY {order} DESC")
HEAVY_COLS = ("plan_handle", "start", "end", "execs", "cpu", "time", "max_time", "reads", "physical", "writes",
              "rows", "last", "created", "db", "object", "text")
DB_TIMEOUT_S = 20             # GUI: таймаут запроса к серверу, с

# Плашки «Новое наблюдение» (GUI.md §5.9): запросы выполняющихся в базе и дольше 5 минут; свободное
# место в файлах базы (данные, лог) и на дисках с ними. Все - системные представления, без чтения данных.
TILE_SESSIONS_SQL = (
    "SELECT COUNT(*), SUM(CASE WHEN r.total_elapsed_time >= 300000 THEN 1 ELSE 0 END) "
    "FROM sys.dm_exec_requests r JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id "
    "WHERE s.is_user_process = 1 AND r.session_id <> @@SPID AND r.database_id = DB_ID(?) "
    "AND ISNULL(s.program_name, '') NOT IN " + SERVICE_APPS)
TILE_SPACE_SQL = ("SELECT type, SUM(CAST(size - FILEPROPERTY(name, 'SpaceUsed') AS bigint)) * 8 / 1024 "
                  "FROM sys.database_files WHERE type IN (0, 1) GROUP BY type")
TILE_DISKS_SQL = ("SELECT f.type, v.volume_mount_point, v.available_bytes / 1048576, "
                  "CASE WHEN f.growth > 0 AND (f.max_size = -1 OR f.size < f.max_size) THEN 1 ELSE 0 END "
                  "FROM sys.database_files f CROSS APPLY sys.dm_os_volume_stats(DB_ID(), f.file_id) v "
                  "WHERE f.type IN (0, 1)")


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
    m = re.search(r"(?:^|;)\s*" + key + r"\s*=\s*([^;]*)", cs or "", re.I)
    return m.group(1).strip().strip("{}") if m else ""


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


def read_csv_rows(path):
    """registry.csv / log.csv: заголовок и строки-словари."""
    try:
        with open(path, encoding="utf-8-sig", newline="") as f:
            rows = list(csv.reader(f, delimiter=";"))
    except OSError:
        return [], []
    if not rows:
        return [], []
    head = rows[0]
    return head, [dict(zip(head, r)) for r in rows[1:]]


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


def statement_of(text, start, end):
    """Оператор по смещениям (байты nvarchar, как у CLI) и номер его строки в тексте объекта или батча."""
    text = text or ""
    i0 = (start or 0) // 2
    i1 = len(text) if end is None or end < 0 else end // 2 + 1
    return text[i0:i1].strip(), text.count("\n", 0, i0) + 1


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
        self._events = []          # (номер, id процесса, событие)
        self._procs = {}
        self._next = 1
        self._window = None
        self._close_ok = False
        self._cache = {}           # путь отчета -> (mtime, разобранный отчет)
        self._conn = None          # подключение GUI к серверу (_query)
        self._inbuf, self._inbuf_ok = {}, True     # исходные запросы сессий («Текущие запросы»)
        self._db_lock = threading.RLock()
        raw = read_json()
        g = raw.get("GUI") if isinstance(raw.get("GUI"), dict) else {}
        folder = g.get("folder")
        self.folder = folder if folder and Path(folder).is_dir() else str(Path.cwd())
        set_lang(g.get("lang"))

    # ---------------------------------------------------- служебное

    def push(self, pid, ev):
        with self._lock:
            self._events.append((len(self._events) + 1, pid, ev))

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
                "tiles": [{"id": x.get("id"), "name": x.get("name"), "sql": x.get("sql")}
                          for x in (g.get("tiles") or []) if isinstance(x, dict)],
                "no_connection": no_connection(raw, g),
                "procs": [p.info() for p in self._procs.values()]}

    def poll(self, since):
        """События процессов с номером больше since."""
        with self._lock:
            return {"seq": len(self._events), "events": [{"seq": n, "proc": pid, "ev": ev}
                                                         for n, pid, ev in self._events[since:]],
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
        """Список для окна настроек: подписи «сервер — база — логин», без паролей."""
        _, _, items, active = self._connections()
        return {"active": active, "items": [
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
        import pyodbc
        if password is None:
            _, _, items, _ = self._connections()
            password = next((c.get("password") or "" for c in items if c["id"] == conn_id), "")
        cs = cq.build_conn_str({"connection_string": connection_string.strip(), "login": login.strip(),
                                "password": password}, cq.APP_NAME + " gui")
        t = time.time()
        conn = pyodbc.connect(cs, autocommit=True, timeout=10)
        try:
            row = conn.cursor().execute(
                "SELECT @@SERVERNAME, DB_NAME(), SUSER_SNAME(), CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)), "
                "CAST(SERVERPROPERTY('Edition') AS nvarchar(128))").fetchone()
        finally:
            conn.close()
        return {"server": row[0], "database": row[1], "login": row[2], "version": row[3], "edition": row[4],
                "ms": round((time.time() - t) * 1000)}

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

    def start_run(self, name, repeat, profile, rollback):
        args = [name]
        if repeat and int(repeat) >= 2:
            args += ["--repeat", str(int(repeat))]
        if profile:
            args.append("--profile")
        if rollback:
            args.append("--rollback")
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

    def compare_details(self, path, a, b):
        """Экран сравнения (GUI.md §4.2): разбор полного файла сравнения режима 2 и отчетов A и B.
        Таблицы - заголовок и строки раздела; операторы - те же пары, что в разделе «Операторы»
        (cq.statement_changes по registry.csv обоих запусков), с началом текста, первым ожиданием B
        и файлами текста и плана оператора в каждом запуске (пути; нет файла - None)."""
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
                def files(r, d):
                    row = r["row"] if r else {}
                    return [str(d / row[k]) if row.get(k) else None for k in ("Текст", "План")]
                out["statements"] = []
                for ar, br, note in cq.statement_changes(regs[0][0], regs[1][0]):
                    r = br or ar
                    m = STMT_RE.match(cq.statement_text(ar, br, note))
                    st = {k: (int(v) if v and v.isdigit() else v) for k, v in m.groupdict().items()} if m else \
                        {"label": r["label"], "line": r["line"], "note": note, "a": 0, "b": 0, "pct": ""}
                    st["text"] = r["head"]
                    st["wait"] = (br["row"].get("Ожидание ресурсов 1 место") if br else "") or ""
                    st["files_a"], st["files_b"] = files(ar, regs[0][1]), files(br, regs[1][1])
                    out["statements"].append(st)
        return out

    def compare_sessions(self, a, b):
        """Сравнение наблюдений a (база) и b (по имени папки в Sessions_profile): процесс CLI с двумя папками."""
        da, db = (self._path(Path(cq.SESSIONS_DIR) / Path(x).name) for x in (a, b))
        return self._start("compare", [str(da), str(db)], f"{da.name} ↔ {db.name}")

    def session_compare_details(self, a, b):
        """Экран сравнения наблюдений (GUI.md §4.3): то же, что файл сравнения (cq.registry_compare),
        с началом текста, первым ожиданием B и файлами текста и плана оператора в каждом наблюдении."""
        da, db = (self._path(Path(cq.SESSIONS_DIR) / Path(x).name) for x in (a, b))
        c = cq.registry_compare(da, db)

        def files(r, d):
            row = r["row"] if r else {}
            return [str(d / row[k]) if row.get(k) else None for k in ("Текст", "План")]
        statements = []
        for ar, br, note in c["changes"]:
            r = br or ar
            m = STMT_RE.match(cq.statement_text(ar, br, note))
            st = {k: (int(v) if v and v.isdigit() else v) for k, v in m.groupdict().items()} if m else                 {"label": r["label"], "line": r["line"], "note": note, "a": 0, "b": 0, "pct": ""}
            st["text"] = r["head"]
            st["wait"] = (br["row"].get("Ожидание ресурсов 1 место") if br else "") or ""
            st["files_a"], st["files_b"] = files(ar, da), files(br, db)
            st["runs_a"], st["runs_b"] = (ar["runs"] if ar else 0), (br["runs"] if br else 0)
            statements.append(st)
        g = self._gui()[1].get("notes") or {}
        return {"total": c["total"], "notes": [f for f, _ in c["notes"]], "objects": c["objects"],
                "statements": statements, "names": [da.name, db.name],
                "heads": [registry_header(d / cq.REGISTRY_FILE) for d in (da, db)],
                "note_text": [g.get(da.name), g.get(db.name)]}

    # ---------------------------------------------------- внешний diff (GUI.md §5.5)

    def diff_info(self, kind, args):
        """Какие два файла и какой программой откроются: {"files": [A, B], "tool": имя или None}."""
        a, b = self._diff_files(kind, args)
        _, g = self._gui()
        tool = find_diff_tool(g.get("diff_tool"))
        return {"files": [a.name, b.name], "tool": tool["name"] if tool else None}

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
        table [A, B, N] - CSV таблицы N; script [имя.sql] - скрипт и SQL-файл опорного запуска."""
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
    # GUI сам читает только DMV: список сессий (§5.9), «Текущие запросы» (§5.20), «Тяжелые запросы» (§5.21),
    # тексты и планы по кнопке; меняет только KILL по явному подтверждению. Одно подключение на все
    # (APP "CompareQuery gui", в свои же списки не попадает), переиспользуется; при ошибке открывается заново.

    def _query(self, sql, *params, sets=1):
        """Строки sets первых наборов (sets=1 - список строк, иначе список наборов)."""
        import pyodbc
        with self._db_lock:
            try:
                if self._conn is None:
                    conn_str = cq.build_conn_str(cq.read_settings(), cq.APP_NAME + " gui")
                    self._conn = pyodbc.connect(conn_str, autocommit=True, timeout=15)
                    self._conn.timeout = DB_TIMEOUT_S
                cur = self._conn.cursor()
                try:
                    cur.execute(sql, *params)
                    if sets == -1:                 # строки последнего набора с колонками
                        last = []
                        while True:
                            if cur.description is not None:
                                last = [list(r) for r in cur.fetchall()]
                            if not cur.nextset():
                                return last
                    out = []
                    while len(out) < sets:
                        while cur.description is None:     # наборы без строк (SET и т. п.) пропускаются
                            if not cur.nextset():
                                return out[0] if sets == 1 and out else out
                        out.append([list(r) for r in cur.fetchall()])
                        if len(out) < sets and not cur.nextset():
                            break
                    return out[0] if sets == 1 else out
                finally:
                    cur.close()
            except pyodbc.Error:
                self._close_db()
                raise

    def _close_db(self):
        conn, self._conn = self._conn, None
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    def list_sessions(self):
        """Один легкий запрос списка пользовательских сессий (GUI.md §5.9)."""
        rows = self._query(SESSIONS_SQL)
        keys = ("spid", "db", "program", "host", "login", "elapsed", "proc")
        out = [dict(zip(keys, r)) for r in rows]
        out.sort(key=lambda x: ((x["db"] or "").lower(), (x["program"] or "").lower(), x["spid"]))
        return out

    # ---------------------------------------------------- плашки экрана «Новое наблюдение» (GUI.md §5.9)
    # Две свои (активные сессии; свободное место) и пользовательские ("GUI".tiles: [{id, name, sql}]).
    # Все - в контексте выбранной базы; пользовательский скрипт выполняется как есть, с SET LOCK_TIMEOUT,
    # чтобы не ждать за чужими блокировками. Из него берется последняя таблица: первая ячейка первой
    # строки - крупно, первая ячейка второй строки - мелко.

    def tile(self, db, kind, tile_id=None):
        """Значение плашки kind (sessions, space, user) для базы db."""
        if not db:
            raise ValueError(tr("база не выбрана"))
        if not self._query("SELECT DB_ID(?)", db)[0][0]:
            raise ValueError(tr("нет базы {name}", name=db))
        use = "USE [" + db.replace("]", "]]") + "]; "
        if kind == "sessions":
            r = self._query(TILE_SESSIONS_SQL, db)[0]
            return {"active": r[0] or 0, "long": r[1] or 0}
        if kind == "space":
            files = self._query(use + TILE_SPACE_SQL)
            out = {"data_mb": None, "log_mb": None, "data_disk": None, "log_disk": None}
            for typ, free_mb in files:
                out["data_mb" if typ == 0 else "log_mb"] = free_mb
            try:                     # диски: нужно VIEW SERVER STATE
                rows = self._query(use + TILE_DISKS_SQL)
            except Exception:
                rows = []
            for typ, key in ((0, "data_disk"), (1, "log_disk")):
                # диски, где файлы этого вида могут расти (автоприрост, не уперлись в предел);
                # таких нет - все диски с файлами; свободное место - сумма по разным дискам
                mine = [r for r in rows if r[0] == typ]
                grow = [r for r in mine if r[3]] or mine
                vols = {}
                for _, mount, free_mb, _ in grow:
                    vols[mount] = free_mb
                if vols:
                    out[key] = {"mounts": sorted(vols), "free_mb": sum(vols.values())}
            return out
        if kind == "user":
            t = next((x for x in (self._gui()[1].get("tiles") or []) if x.get("id") == tile_id), None)
            if not t:
                raise ValueError(tr("плашка не найдена"))
            rows = self._query("SET LOCK_TIMEOUT 3000; " + use + "\n" + t.get("sql", ""), sets=-1)
            def cell(i):
                v = rows[i][0] if len(rows) > i and rows[i] else None
                return v if v is None or isinstance(v, (int, float)) else str(v)
            return {"main": cell(0), "sub": cell(1)}
        raise ValueError(tr("неизвестная плашка: {name}", name=kind))

    def save_tile(self, tile_id, name, sql):
        """Пользовательская плашка: tile_id None - новая. Возвращает id."""
        name, sql = (name or "").strip(), (sql or "").strip()
        if not name or not sql:
            raise ValueError(tr("нужны название и скрипт"))
        _, g = self._gui()
        tiles = [x for x in (g.get("tiles") or []) if isinstance(x, dict)]
        t = next((x for x in tiles if x.get("id") == tile_id), None)
        if t is None:
            t = {"id": new_conn_id().replace("c", "t", 1)}
            tiles.append(t)
        t["name"], t["sql"] = name, sql
        self._set_gui(tiles=tiles)
        return t["id"]

    def delete_tile(self, tile_id):
        _, g = self._gui()
        self._set_gui(tiles=[x for x in (g.get("tiles") or []) if isinstance(x, dict) and x.get("id") != tile_id])
        return True

    def current_queries(self):
        """«Текущие запросы» (GUI.md §5.20): строки и итоги по серверу. Текст - только оператор."""
        rows, total = self._query(CURRENT_SQL, sets=2)
        out = []
        for r in rows:
            x = dict(zip(CURRENT_COLS, r))
            x["statement"], x["line"] = statement_of(x.pop("text"), x["start"], x["end"])
            x["last_text"] = (x["last_text"] or "").strip()
            x["plan_handle"] = x["plan_handle"].hex() if x["plan_handle"] else None
            x["memory"] = round((x["memory"] or 0) * 8 / 1024, 1)        # страницы по 8 КБ -> МБ
            x["wait"] = (x["wait"] or "").strip()
            out.append(x)
        self._input_buffers(out)
        t = total[0] if total else [None] * 4
        return {"rows": out, "sessions": t[0], "runnable": t[1], "memory_waits": t[2],
                "server_time": t[3].isoformat(timespec="seconds") if t[3] else None}

    def _input_buffers(self, rows):
        """Поле input строк «Текущих запросов»: исходный запрос сессии одной строкой. С сервера - только для
        запросов, которых еще нет в памяти (сменилось начало запроса сессии)."""
        cache = self._inbuf
        keys = {x["spid"]: (x["spid"], str(x["req_start"])) for x in rows}
        need = [spid for spid, k in keys.items() if k not in cache]
        if need and self._inbuf_ok:
            try:
                got = {r[0]: r[1] for r in self._query(INPUT_BUFFERS_SQL.format(ids=", ".join(str(int(n)) for n in need)))}
                for spid in need:
                    cache[keys[spid]] = " ".join((got.get(spid) or "").replace("\x00", "").split())[:1000]
            except Exception:
                self._inbuf_ok = False           # нет функции или права - больше не спрашивать
        for k in [k for k in cache if k not in keys.values()]:
            del cache[k]                         # в памяти - только текущие запросы
        for x in rows:
            x["input"] = cache.get(keys[x["spid"]], "")
            x.pop("req_start", None)

    def heavy_queries(self, order="cpu", hours=0, top=100):
        """«Тяжелые запросы» (GUI.md §5.21): TOP операторов кэша планов по показателю order,
        выполнявшихся за последние hours часов (0 - за все время в кэше). Время - мс."""
        if order not in HEAVY_ORDER:
            raise ValueError(tr("неизвестный показатель: {name}", name=order))
        top = max(10, min(500, int(top)))
        hours = int(hours) if hours and int(hours) > 0 else 24 * 365 * 20
        rows = self._query(HEAVY_SQL.format(order=HEAVY_ORDER[order]), top, hours)
        out = []
        for r in rows:
            x = dict(zip(HEAVY_COLS, r))
            x["statement"], x["line"] = statement_of(x.pop("text"), x["start"], x["end"])
            x["plan_handle"] = x["plan_handle"].hex() if x["plan_handle"] else None
            for k in ("cpu", "time", "max_time"):
                x[k] = round((x[k] or 0) / 1000)                       # мкс -> мс
            for k in ("last", "created"):
                x[k] = x[k].isoformat(sep=" ", timespec="seconds") if x[k] else None
            out.append(x)
        return out

    def open_plan(self, plan_handle, start, end, name):
        """План оператора (sys.dm_exec_text_query_plan, как у CLI) - во временный .sqlplan и открыть."""
        rows = self._query("SELECT query_plan FROM sys.dm_exec_text_query_plan(?, ?, ?)",
                           bytes.fromhex(plan_handle), int(start or 0), int(end if end is not None else -1))
        if not rows or not rows[0][0]:
            raise ValueError(tr("плана уже нет в кэше сервера"))
        os.startfile(str(temp_file(f"{name}.sqlplan", rows[0][0])))
        return True

    def input_buffer(self, spid):
        """Исходный запрос сессии - что прислал клиент (вызов процедуры с параметрами, батч)."""
        spid = int(spid)
        try:
            rows = self._query("SELECT event_info FROM sys.dm_exec_input_buffer(?, NULL)", spid)
        except Exception:                       # до SQL Server 2014 SP2 функции нет
            rows = [[r[2]] for r in self._query(f"DBCC INPUTBUFFER({spid}) WITH NO_INFOMSGS")]
        return (rows[0][0] or "").replace("\x00", "").strip() if rows else ""

    def read_text(self, path):
        """Текстовый файл внутри рабочей папки (текст оператора реестра) - для окна текста."""
        p = self._path(path)
        plan = p.with_suffix(".sqlplan")
        return {"text": p.read_text(encoding="utf-8-sig", errors="replace"),
                "plan": str(plan) if plan.is_file() else None}

    def open_text(self, name, text):
        """Текст запроса - во временный .sql и открыть программой по умолчанию."""
        os.startfile(str(temp_file(f"{name}.sql", text)))
        return True

    def kill_session(self, spid):
        """KILL сессии - единственное изменение на сервере из GUI, только по подтверждению пользователя."""
        spid = int(spid)
        if spid <= 50:
            raise ValueError(tr("системная сессия"))
        self._query(f"KILL {spid}")
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

    def session_details(self, name):
        """Наблюдение по имени папки в Sessions_profile."""
        d = self._path(Path(cq.SESSIONS_DIR) / Path(name).name)
        h = registry_header(d / cq.REGISTRY_FILE)
        return {"folder": str(d), "header": h, "registry": read_csv_rows(d / cq.REGISTRY_TABLE)[1],
                "log": read_csv_rows(d / cq.REGISTRY_LOG)[1], "slow": slow_info(h),
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
