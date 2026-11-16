#!/usr/bin/env python3
"""CompareQuery: выполнение SQL-запроса на MS SQL Server и сравнение результатов запусков.

Режим 1, выполнение:  python CompareQuery.py query.sql [--rollback] [--repeat N] [--profile]
Режим 2, сравнение:   python CompareQuery.py query_A.txt query_B.txt
Режим 3, наблюдение:  python CompareQuery.py --session N

Батч, первая строка которого "-- ignore in test", выполняется, но в отчеты не попадает.
Пользователю - README.md, устройство и принятые решения - CLAUDE.md (оба рядом со скриптом).
"""

import argparse
import collections
import datetime as dt
import decimal
import fnmatch
import hashlib
import json
import math
import os
import pickle
import queue
import re
import signal
import statistics
import struct
import sys
import tempfile
import threading
import time
import traceback
import uuid
import zlib
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from pathlib import Path

try:
    import msvcrt            # выход из --session по любой клавише (Windows)
except ImportError:
    msvcrt = None

# ============================================================ настройки скрипта

KEY_EXACT_NAMES = ["id"]
KEY_SUFFIXES = ["id"]
KEY_SUBSTRINGS = ["period", "num", "name", "fromDate"]   # порядок важен
MAX_CELL_LEN = 200            # порог обработки "200"
DELIM = ";"
DATA_EXT = ".csv"
FILE_ENCODING = "utf-8-sig"
DT_FORMAT = "%Y%m%d_%H%M%S"
OUTPUT_DIR = ""               # пусто: рядом с SQL-файлом (в режиме 2 рядом с отчетом B)
TEMP_DIR = None               # None: системный
FETCH_BLOCK = 10000
QUERY_TIMEOUT = 0             # секунды, 0: без ограничения
WORKER_MODE = "process"       # "process" | "thread"
RTRIM_STRINGS = False
FLOAT_TOLERANCE = 0           # 0: выключено
APP_NAME = "CompareQuery"     # имя программы в подключении, если в строке подключения нет APP
PROFILE_INTERVAL_MS = 100     # --profile: интервал опроса рабочей сессии
PROFILE_FAST_MS = 30          # --profile: следующий опрос, если выборка попала внутрь функции
PROFILE_PLAN_TOP = 30         # --profile: для скольких операторов (по времени) сохранять план
SAMPLE_SLOW_MS = 80           # --profile, --session: ответ на запрос строки запроса сессии дольше этого - задержка
REGISTRY_TEXT_LEN = 100       # --profile: символов начала текста оператора в registry.csv
SESSION_FLUSH_S = 10          # --session: файлы реестра перезаписываются раз в столько секунд
SESSION_INPUT_LEN = 1000      # --session: символов исходного запроса сессии в шапке registry.txt
SIGNIFICANT_PCT = 20          # режим 2: значимое изменение времени оператора, процентов
SIGNIFICANT_MS = 1000         # режим 2: и не меньше, мс
TOP_SHARE = 0.2               # режим 2: сравниваются операторы из верхних 20% по времени
TOP_MIN = 5                   # режим 2: но не меньше 5
SHORT_CHANGES_MAX = 10        # режим 2: строк изменений операторов в сокращенном отчете
EXAMPLE_ROWS = 20             # режим 2: примеров отличающихся строк каждого вида (показывает GUI)
REPORT_FORMAT_VERSION = 2

# ============================================================ служебные константы

NUL = "\x01"                  # NULL внутри обработки; в каноническом тексте не встречается
MASK64 = (1 << 64) - 1
DUP_COL = "#dup"
SQL_EXT = ".sql"
REPORT_EXT = ".txt"
SESSIONS_DIR = "Sessions_profile"   # --session: общая папка наблюдений (в текущей папке или OUTPUT_DIR)
WRITE_CHUNK = 10000           # строк за одну запись в файл данных
LOOKUP_WAIT_S = 30            # --profile: сколько ждать в конце недополученные тексты операторов
SETTINGS_PATH = Path(__file__).resolve().with_suffix(".json")

HELP = """Выполнение SQL-запроса (MS SQL Server) и сравнение результатов запусков.

Режим 1, выполнение:
  CompareQuery.py <файл.sql> [--rollback] [--repeat N] [--profile]
  Без --rollback запрос выполняется без транзакции (autocommit).
  С --rollback все батчи выполняются в одной транзакции, в конце rollback.
  --repeat N: выполнить N раз (N >= 2), первый прогон - прогрев, счетчики - медиана остальных.
  --profile: реестр операторов по времени в отдельной папке.
  Батч, первая строка которого "-- ignore in test", выполняется, но в отчет не попадает
  (подготовка тестовых данных).
  По ходу выполнения выводятся сообщения SQL (PRINT, RAISERROR, ошибки) с временем сервера.

Режим 2, сравнение двух отчетов режима 1:
  CompareQuery.py <отчетA.txt> <отчетB.txt>

Режим 3, наблюдение за чужой сессией (реестр как у --profile, обновляется раз в 10 с):
  CompareQuery.py --session N
  Папка реестра: Sessions_profile\\Session_<время>_N. Выход: любая клавиша, Ctrl+C или завершение сессии N.

Время в отчетах, именах файлов, реестрах и сообщениях SQL - по часам сервера.

Запуск из другой программы (GUI), без консоли:
  строка "stop" в stdin действует как Ctrl+C (в режиме 3 - как клавиша);
  --parent-pid PID: то же, если закрылся процесс PID;
  --events: ход выполнения строками JSON в stdout (события - в README), отчет в stdout не выводится.

Коды возврата: 0 успех (в режиме 2 результаты идентичны), 1 найдены различия, 2 ошибка.
"""


class ScriptError(Exception):
    """Ожидаемая ошибка: текст в stderr, код возврата 2."""


class DataError(Exception):
    """Файл данных не соответствует отчету (режим 2)."""


class StopRequested(Exception):
    """Остановка извне (команда stop или закрылась программа --parent-pid): действует как Ctrl+C."""


def log(msg):
    print(msg, file=sys.stderr, flush=True)
    Journal.add(str(msg))


class Journal:
    """Журнал хода запуска (режим 1): строки log() и сообщения SQL с временем сервера - то же, что видно
    по ходу выполнения. В конце пишется файлом <запуск>_message.txt рядом с CSV (его показывает GUI)."""

    on = False
    entries = []                         # (perf(), метка "" / "SQL" / "Ошибка", текст)

    @classmethod
    def add(cls, text, tag=""):
        if cls.on:
            cls.entries.append((perf(), tag, text))

    @staticmethod
    def text(entries):
        """Время - сервера, пересчитывается при записи: первые строки (до первого подключения) пишутся
        раньше, чем измерены часы сервера."""
        out = []
        for stamp, tag, text in entries:
            head = f"[{clock_text(ServerTime.at(stamp))}] " + (f"{tag}: " if tag else "")
            lines = text.splitlines() or [""]
            out += [head + lines[0]] + [" " * len(head) + x for x in lines[1:]]
        return "\n".join(out) + "\n"


def perf():
    return time.perf_counter_ns()


def ms(ns):
    return f"{ns / 1e6:.3f}"


def one_line(s):
    return re.sub(r"\s*[\r\n]+\s*", " ", str(s)).strip()


def remove_quiet(path):
    try:
        os.remove(path)
    except OSError:
        pass


class Stop:
    """Остановка скрипта другой программой (GUI), у фонового процесса нет клавиатуры:
    - строка "stop" в stdin (читается, только если stdin не консоль);
    - закрылась программа --parent-pid (ее процесс открывается один раз при старте, поэтому
      новый процесс с тем же номером не спутается).
    Запрос только запоминается. Режим 1 проверяет его между вызовами драйвера (check) - там же,
    где срабатывает Ctrl+C, режим 3 - в цикле ожидания. Обработка таблиц и запись отчета не прерываются."""

    reason = None
    lock = threading.Lock()
    cancel = None       # режим 1: отмена текущего оператора рабочего подключения (cursor.cancel)

    @classmethod
    def request(cls, reason):
        with cls.lock:
            if cls.reason is not None:  # действует первая причина
                return
            cls.reason = reason
            if cls.cancel is not None:  # под блокировкой: курсор не закроют, пока идет отмена
                log("Отмена оператора на сервере...")
                try:
                    cls.cancel()
                except Exception as e:
                    log(f"Отмена оператора не удалась: {err_text(e)}")

    @classmethod
    def set_cancel(cls, fn):
        """Режим 1: fn отменяет текущий оператор (SQLCancel из другого потока: сервер прекращает
        оператор сразу, драйвер возвращает ошибку "Operation canceled"); None - отменять нечего."""
        with cls.lock:
            cls.cancel = fn

    @classmethod
    def check(cls):
        if cls.reason is not None:
            raise StopRequested(cls.reason)

    @classmethod
    def stdin_enabled(cls):
        return sys.stdin is not None and not sys.stdin.isatty()

    @classmethod
    def start(cls, parent_pid):
        if parent_pid is not None:
            wait = cls.parent_waiter(parent_pid)
            threading.Thread(target=wait, name="parent-pid", daemon=True).start()
        if cls.stdin_enabled():
            threading.Thread(target=cls.read_stdin, name="stdin", daemon=True).start()

    @classmethod
    def stdin_waiter(cls):
        """Функция "сколько байт можно прочитать без ожидания" или None (вне Windows - читать сразу).

        На Windows поток не должен висеть в чтении канала: пока идет синхронное чтение, другие
        операции с тем же каналом ждут его, и процесс-исполнитель (ProcessPoolExecutor) при старте
        зависает на проверке stdin. Поэтому канал проверяется PeekNamedPipe раз в 0,2 с, а читается
        только то, что уже пришло. stdin не канал (файл, NUL) - команд нет."""
        if os.name != "nt" or msvcrt is None:
            return None
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.PeekNamedPipe.argtypes = (wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p,
                                      ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p)
        k32.PeekNamedPipe.restype = wintypes.BOOL
        handle = msvcrt.get_osfhandle(0)

        def available():
            n = wintypes.DWORD()
            if not k32.PeekNamedPipe(handle, None, 0, None, ctypes.byref(n), None):
                return -1       # канал закрыт или это не канал
            return n.value
        return available

    @classmethod
    def read_stdin(cls):
        # os.read, а не sys.stdin: поток, ждущий в буферизованном sys.stdin, может сорвать
        # завершение интерпретатора (блокировка буфера stdin при выходе).
        try:
            available = cls.stdin_waiter()
        except OSError:
            return
        buf = b""
        while True:
            try:
                if available is None:
                    chunk = os.read(0, 1024)
                else:
                    n = available()
                    if n < 0:
                        return
                    if n == 0:
                        time.sleep(0.2)
                        continue
                    chunk = os.read(0, n)
            except OSError:
                return
            if not chunk:
                return          # stdin закрыт: команд больше не будет
            buf += chunk
            *lines, buf = buf.split(b"\n")
            if any(x.strip().lower() == b"stop" for x in lines):
                cls.request("остановлено командой stop")

    @classmethod
    def parent_waiter(cls, pid):
        """Функция потока, которая ждет завершения процесса pid. Процесс проверяется сразу."""
        reason = f"закрылась программа, запустившая скрипт (PID {pid})"
        if os.name == "nt":
            import ctypes
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.OpenProcess.restype = ctypes.c_void_p
            k32.OpenProcess.argtypes = (ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32)
            k32.WaitForSingleObject.restype = ctypes.c_uint32
            k32.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
            handle = k32.OpenProcess(0x00100000, 0, pid)      # SYNCHRONIZE
            if not handle:
                raise ScriptError(f"--parent-pid: нет процесса {pid}")

            def wait():
                k32.WaitForSingleObject(handle, 0xFFFFFFFF)   # INFINITE
                cls.request(reason)
            return wait
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            raise ScriptError(f"--parent-pid: нет процесса {pid}")

        def poll():
            while True:
                time.sleep(1)
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    cls.request(reason)
                    return
        return poll


def unique_path(path):
    """Существующие файлы не перезаписываются: при коллизии добавляется _2, _3..."""
    if not path.exists():
        return path
    k = 2
    while True:
        p = path.with_name(f"{path.stem}_{k}{path.suffix}")
        if not p.exists():
            return p
        k += 1


def write_report(path, text, console=None):
    """Текст в файл; console - что вывести в stdout (с --events stdout занят событиями)."""
    with open(path, "w", encoding=FILE_ENCODING, newline="\n") as f:
        f.write(text)
    Events.emit("report", path=str(path))
    if console and not Events.on:
        sys.stdout.write(console)
        sys.stdout.flush()


class Events:
    """--events: ход выполнения для другой программы (GUI) - по строке JSON на событие в stdout.
    Новых запросов к серверу события не добавляют: только то, что скрипт и так узнает.
    Если stdout закрылся (программа-читатель закрылась), события молча выключаются."""

    on = False
    lock = threading.Lock()

    @classmethod
    def emit(cls, event, **fields):
        if not cls.on:
            return
        line = json.dumps(dict(event=event, time=dt.datetime.now().isoformat(timespec="milliseconds"), **fields),
                          ensure_ascii=False, default=str)
        with cls.lock:
            try:
                sys.stdout.write(line + "\n")
                sys.stdout.flush()
            except (OSError, ValueError):
                cls.on = False


class ServerTime:
    """Часы сервера: один замер SYSDATETIME() при первом подключении, дальше - прошедшее время по perf().
    Время суток в отчетах, именах файлов, реестрах и сообщениях - серверное: часовой пояс и часы
    сервера могут отличаться от компьютера. Пока замера нет (сервер не ответил) - часы компьютера."""

    base = stamp = None

    @classmethod
    def set(cls, server_dt, stamp):
        if cls.base is None and isinstance(server_dt, dt.datetime):
            cls.base, cls.stamp = server_dt.replace(tzinfo=None), stamp
            Events.emit("clock", server_time=cls.now().isoformat(timespec="milliseconds"))

    @classmethod
    def at(cls, stamp):
        """Время сервера в момент stamp (значение perf())."""
        if cls.base is None:
            return dt.datetime.now() - dt.timedelta(microseconds=(perf() - stamp) // 1000)
        return cls.base + dt.timedelta(microseconds=(stamp - cls.stamp) // 1000)

    @classmethod
    def now(cls):
        return cls.at(perf())


def query_spid(cur):
    """@@SPID рабочего подключения; тем же запросом - замер часов сервера (ServerTime)."""
    t = perf()
    row = cur.execute("SELECT @@SPID, SYSDATETIME()").fetchone()
    ServerTime.set(row[1], (t + perf()) // 2)
    return int(row[0])


def clock_text(t):
    """Время суток с миллисекундами: чч:мм:сс.ммм."""
    return t.strftime("%H:%M:%S.%f")[:-3]


MESSAGE_KIND_RE = re.compile(r"\[(\w*)\]\s*\((-?\d+)\)")
MESSAGE_SOURCE_RE = re.compile(r"^(?:\[[^\]]*\])+")


def user_message(kind, text):
    """Сообщение сервера для показа по ходу выполнения: (текст, ошибка) или None для служебного.

    kind у pyodbc - "[SQLSTATE] (номер)". Показываются PRINT (номер 0), RAISERROR с текстом
    и пользовательские сообщения (номер от 50000), ошибки (SQLSTATE не классов 00 и 01).
    Служебные информационные ("Changed database context" 5701, "Null value is eliminated" 8153
    и т. п.) - нет. Префикс драйвера "[Microsoft][ODBC ...][SQL Server]" убирается."""
    text = MESSAGE_SOURCE_RE.sub("", str(text)).strip()
    m = MESSAGE_KIND_RE.search(str(kind))
    if not m:
        return text, False
    error = m.group(1)[:2] not in ("00", "01")
    number = int(m.group(2))
    if not error and number != 0 and number < 50000:
        return None
    return text, error


def show_message(kind, text, **fields):
    """Сообщение SQL по ходу выполнения: в консоль с временем сервера (с --events - событием message)."""
    shown = user_message(kind, text)
    if shown is None:
        return
    text, error = shown
    t = ServerTime.now()
    Journal.add(text, "Ошибка" if error else "SQL")
    if Events.on:
        Events.emit("message", server_time=t.isoformat(timespec="milliseconds"), text=text, error=error, **fields)
        return
    head = f"[{clock_text(t)}] " + ("Ошибка: " if error else "")
    lines = text.splitlines() or [""]
    log("\n".join([head + lines[0]] + [" " * len(head) + x for x in lines[1:]]))


def event_text(text):
    """Начало текста оператора для события: одной строкой, не длиннее REGISTRY_TEXT_LEN."""
    return " ".join((text or "").split())[:REGISTRY_TEXT_LEN]


class NowEvents:
    """--events: текущий оператор (statement / idle) и его ожидание (wait), только при изменении.
    fields - общие поля событий (номер прогона)."""

    def __init__(self, **fields):
        self.fields = fields
        self.key = self.wait = None

    def update(self, now):
        if now is None or not Events.on:
            return
        wait = (now["wait"] or None, now["blocked_by"])
        if now["key"] != self.key:
            self.key, self.wait = now["key"], wait
            if now["label"] is None:
                Events.emit("idle", **self.fields)
            else:
                Events.emit("statement", object=now["label"], line=now["line"], text=event_text(now["text"]),
                            wait=wait[0], blocked_by=wait[1], **self.fields)
        elif wait != self.wait:
            self.wait = wait
            Events.emit("wait", wait=wait[0], blocked_by=wait[1], **self.fields)


# ============================================================ файл настроек

def default_driver():
    """Новейший 'ODBC Driver N for SQL Server', иначе 'SQL Server'."""
    try:
        import pyodbc
        drivers = pyodbc.drivers()
    except Exception:
        drivers = []
    best = None
    for d in drivers:
        m = re.fullmatch(r"ODBC Driver (\d+) for SQL Server", d, re.I)
        if m and (best is None or int(m.group(1)) > best[0]):
            best = (int(m.group(1)), d)
    return best[1] if best else "SQL Server"


def ensure_settings_file():
    """Создает файл настроек с примером, если его нет. Возвращает True, если создал."""
    if SETTINGS_PATH.exists():
        return False
    sample = {
        "connection_string": f"Driver={{{default_driver()}}};Server=localhost;Database=master;TrustServerCertificate=yes",
        "login": "sa",
        "password": "",
        "ignored_columns": [{"mask": "ExampleExclude", "tables": {"*": ["id"], "2": ["CreatedAt"]}}],
    }
    SETTINGS_PATH.write_text(json.dumps(sample, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    log(f"Создан файл настроек с примером: {SETTINGS_PATH}")
    return True


def lower_keys(d):
    return {str(k).lower(): v for k, v in d.items()}


def read_settings():
    try:
        raw = json.loads(SETTINGS_PATH.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as e:
        raise ScriptError(f"не удалось прочитать файл настроек {SETTINGS_PATH.name}: {e}")
    if not isinstance(raw, dict):
        raise ScriptError(f"{SETTINGS_PATH.name}: ожидается JSON-объект")
    s = lower_keys(raw)
    cs, login, pwd = s.get("connection_string"), s.get("login") or "", s.get("password") or ""
    if not isinstance(cs, str) or not cs.strip():
        raise ScriptError(f"{SETTINGS_PATH.name}: не задан connection_string")
    if not isinstance(login, str) or not isinstance(pwd, str):
        raise ScriptError(f"{SETTINGS_PATH.name}: login и password должны быть строками")
    groups = s.get("ignored_columns") or []
    if not isinstance(groups, list):
        raise ScriptError(f"{SETTINGS_PATH.name}: ignored_columns должен быть списком")
    parsed = []
    form = '{"mask": "...", "tables": {"*": ["..."], "2": ["..."]}}'
    for g in groups:
        g = lower_keys(g) if isinstance(g, dict) else {}
        if "columns" in g:
            raise ScriptError(f'{SETTINGS_PATH.name}: в ignored_columns устаревший "columns", '
                              f'нужно указать колонки по таблицам: {form}')
        mask, tables = g.get("mask"), g.get("tables")
        ok = isinstance(mask, str) and isinstance(tables, dict) and all(
            (str(t).strip() == "*" or str(t).strip().isdigit())
            and isinstance(cols, list) and all(isinstance(c, str) for c in cols)
            for t, cols in tables.items())
        if not ok:
            raise ScriptError(f'{SETTINGS_PATH.name}: элемент ignored_columns должен иметь вид {form} '
                              f'(номер таблицы или "*" для всех таблиц)')
        by_table = {}
        for t, cols in tables.items():
            t = str(t).strip()
            by_table.setdefault(t if t == "*" else str(int(t)), []).extend(cols)
        parsed.append((mask, by_table))
    return {"connection_string": cs.strip(), "login": login, "password": pwd, "ignored_columns": parsed}


def conn_str_keys(cs):
    """Имена ключей строки подключения (нижний регистр), с учетом значений в {...}."""
    keys, i, n = [], 0, len(cs)
    while i < n:
        eq = cs.find("=", i)
        if eq < 0:
            break
        key = cs[i:eq].strip().lower()
        i = eq + 1
        while i < n and cs[i] == " ":
            i += 1
        if i < n and cs[i] == "{":
            i += 1
            while i < n:
                if cs[i] == "}":
                    if i + 1 < n and cs[i + 1] == "}":
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
        semi = cs.find(";", i)
        i = n if semi < 0 else semi + 1
        if key:
            keys.append(key)
    return keys


def brace(value):
    return "{" + value.replace("}", "}}") + "}"


def build_conn_str(settings, app):
    """Строка подключения с логином и именем программы (APP, если его нет в строке)."""
    cs, login, pwd = settings["connection_string"], settings["login"], settings["password"]
    keys = conn_str_keys(cs)
    if not cs.endswith(";"):
        cs += ";"
    if "app" not in keys:
        cs += f"APP={app};"
    if not login:
        # пустой логин - вход Windows: без Trusted_Connection драйвер входит пустым логином SQL и получает отказ
        if not {"uid", "pwd", "trusted_connection", "authentication"} & set(keys):
            cs += "Trusted_Connection=yes;"
        return cs
    if "uid" in keys or "pwd" in keys:
        raise ScriptError("строка подключения уже содержит UID или PWD, а в настройках задан login: "
                          "оставьте что-то одно")
    uid = brace(login) if set(login) & set(";{}=") or login != login.strip() else login
    return f"{cs}UID={uid};PWD={brace(pwd)}"


def ignored_columns(groups, stem):
    """Игнорируемые колонки групп, маска которых подходит к имени SQL-файла: {"*" или номер: [имена]}."""
    out = {}
    for mask, tables in groups:
        if fnmatch.fnmatchcase(stem.lower(), mask.lower()):
            for t, cols in tables.items():
                out.setdefault(t, []).extend(cols)
    return out


def fnmatch_escape(name):
    """Маска, совпадающая только с этим именем: спецсимволы *, ?, [ берутся в скобки."""
    return "".join(f"[{c}]" if c in "*?[" else c for c in name)


def ignored_for_table(ignored, n):
    """Игнорируемые колонки таблицы n (нижний регистр): общие ("*") и заданные для номера."""
    return sorted({c.lower() for c in ignored.get("*", []) + ignored.get(str(n), [])})


# ============================================================ SQL-файл

GO_RE = re.compile(r"^[ \t]*go(?:[ \t]+(\d+))?[ \t]*(?:--.*|/\*.*\*/[ \t]*)?$", re.I)


def read_sql(path):
    data = path.read_bytes()
    if data.startswith(b"\xef\xbb\xbf"):
        text = data[3:].decode("utf-8")
    elif data.startswith((b"\xff\xfe", b"\xfe\xff")):
        text = data.decode("utf-16")
    else:
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            text = data.decode("cp1251")
    return text, hashlib.sha1(data).hexdigest()


def split_batches(text):
    """Строка, состоящая только из GO, разделяет батчи. GO N не поддерживается.
    Возвращает [(номер первой строки батча в файле, текст батча)]."""
    batches, cur, start = [], [], 1
    for lineno, line in enumerate(text.split("\n"), 1):
        m = GO_RE.match(line.rstrip("\r"))
        if m:
            if m.group(1) is not None:
                raise ScriptError(f"строка {lineno}: 'GO {m.group(1)}' не поддерживается")
            batches.append((start, "\n".join(cur)))
            cur, start = [], lineno + 1
        else:
            cur.append(line)
    batches.append((start, "\n".join(cur)))
    return [(s, b) for s, b in batches if b.strip()]


IGNORE_RE = re.compile(r"[ \t]*--[ \t]*ignore in test\b", re.I)


def is_ignored_batch(text):
    """Первая непустая строка батча - комментарий --ignore in test."""
    first = next((line for line in text.split("\n") if line.strip()), "")
    return bool(IGNORE_RE.match(first))


# ============================================================ конвертеры pyodbc

class XmlStr(str):
    """Значение xml."""


class VariantBytes(bytes):
    """Значение sql_variant."""


class UdtBytes(bytes):
    """Значение UDT (geography, geometry, hierarchyid)."""


def conv_datetimeoffset(raw):
    if raw is None:
        return None
    y, mo, d, h, mi, s, frac, tzh, tzm = struct.unpack("<6hI2h", raw)
    tz = dt.timezone(dt.timedelta(hours=tzh, minutes=tzm))
    return dt.datetime(y, mo, d, h, mi, s, frac // 1000, tz)


def conv_xml(raw):
    if raw is None:
        return None
    if raw.startswith(b"\xff\xfe"):
        text = raw[2:].decode("utf-16-le", "replace")
    elif raw.startswith(b"\xef\xbb\xbf"):
        text = raw[3:].decode("utf-8", "replace")
    elif b"\x00" in raw and len(raw) % 2 == 0:
        text = raw.decode("utf-16-le", "replace")
    else:
        text = raw.decode("utf-8", "replace")
    return XmlStr(text)


def conv_variant(raw):
    return None if raw is None else VariantBytes(raw)


def conv_udt(raw):
    return None if raw is None else UdtBytes(raw)


OUTPUT_CONVERTERS = [(-155, conv_datetimeoffset), (-152, conv_xml), (-151, conv_udt), (-150, conv_variant)]


# ============================================================ типы значений и обработка "200"

KNOWN_KINDS = {"bool", "int", "float", "decimal", "str", "bytes",
               "date", "time", "datetime", "datetimeoffset", "uuid"}


def kind_of(v):
    """Вид колонки по первому не-NULL значению."""
    t = type(v)
    if t is bool:
        return "bool"
    if t is int:
        return "int"
    if t is float:
        return "float"
    if t is decimal.Decimal:
        return "decimal"
    if t is str:
        return "str"
    if t is XmlStr:
        return "xml"
    if t is VariantBytes:
        return "sql_variant"
    if t is UdtBytes:
        return "udt"
    if t is bytes or t is bytearray:
        return "bytes"
    if t is dt.datetime:
        return "datetime" if v.tzinfo is None else "datetimeoffset"
    if t is dt.date:
        return "date"
    if t is dt.time:
        return "time"
    if t is uuid.UUID:
        return "uuid"
    return "unknown"


def marker(v):
    """<первые 200 символов>... len <N> <crc32>"""
    if isinstance(v, (bytes, bytearray)):
        s, n, h = "0x" + v.hex(), len(v), zlib.crc32(v)
    else:
        s = str(v)
        n, h = len(s), zlib.crc32(s.encode("utf-8", "surrogatepass"))
    return f"{s[:MAX_CELL_LEN]}... len {n} {h:08x}"


def check_str(v):
    return v if v is None or len(v) <= MAX_CELL_LEN else marker(v)


def check_bytes(v):
    return v if v is None or 2 * len(v) + 2 <= MAX_CELL_LEN else marker(v)


def check_unknown(v):
    return None if v is None else marker(v)


def stage1_check(kind, internal_size):
    """Функция обработки "200" для колонки или None, если проверка не нужна."""
    size = internal_size or 0
    if kind == "str":
        return None if 0 < size <= MAX_CELL_LEN else check_str
    if kind == "bytes":
        return None if 0 < size and 2 * size + 2 <= MAX_CELL_LEN else check_bytes
    if kind in KNOWN_KINDS:
        return None
    return check_unknown


# ============================================================ канонический текст

_ESC = {"\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def escape(s):
    """Делает видимыми непечатные символы; строка БД всегда занимает одну строку файла."""
    if s.isprintable() and "\\" not in s:
        return s
    out = []
    for ch in s:
        e = _ESC.get(ch)
        if e is not None:
            out.append(e)
        elif ch.isprintable():
            out.append(ch)
        else:
            o = ord(ch)
            out.append(f"\\x{o:02x}" if o < 0x100 else f"\\u{o:04x}" if o < 0x10000 else f"\\U{o:08x}")
    return "".join(out)


def num_text(s):
    """Десятичное число без экспоненты и хвостовых нулей, -0 дает 0."""
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return "0" if s == "-0" else s


def frac_text(s):
    """Отбрасывает хвостовые нули дробной части секунд."""
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


def canon_str(v):
    return escape(v.rstrip(" ") if RTRIM_STRINGS else v)


def canon_dto(v):
    u = v.astimezone(dt.timezone.utc).replace(tzinfo=None)
    return frac_text(u.isoformat(" ")) + "Z"


CANON = {
    "bool": lambda v: "1" if v else "0",
    "int": str,
    "decimal": lambda v: num_text(format(v, "f")),
    "float": lambda v: num_text(format(decimal.Decimal(repr(v)), "f")),
    "str": canon_str,
    "bytes": lambda v: v if type(v) is str else "0x" + v.hex(),   # str здесь: маркер "200"
    "date": lambda v: v.isoformat(),
    "time": lambda v: frac_text(v.isoformat()),
    "datetime": lambda v: frac_text(v.isoformat(" ")),
    "datetimeoffset": canon_dto,
    "uuid": str,
}
# Виды, у которых канонический текст не меняется от casefold (свертку регистра можно пропустить).
NO_FOLD = {None, "bool", "int", "decimal", "float", "bytes", "date", "time", "datetime", "uuid"}


def format_cell(c):
    """Ячейка файла данных: NULL пусто, пустая строка "", кавычки по необходимости."""
    if c == NUL:
        return ""
    if not c:
        return '""'
    if DELIM in c or '"' in c or c[0] == " " or c[-1] == " ":
        return '"' + c.replace('"', '""') + '"'
    return c


def parse_line(line):
    """Обратное к format_cell для строки файла данных. Возвращает канонические тексты."""
    if '"' not in line:
        return [c if c else NUL for c in line.split(DELIM)]
    cells, i, n, dl = [], 0, len(line), len(DELIM)
    while True:
        if i < n and line[i] == '"':
            parts, j = [], i + 1
            while True:
                q = line.find('"', j)
                if q < 0:
                    raise ValueError("незакрытая кавычка")
                parts.append(line[j:q])
                if line[q + 1:q + 2] == '"':
                    parts.append('"')
                    j = q + 2
                    continue
                i = q + 1
                break
            cells.append("".join(parts))
            if i == n:
                return cells
            if line[i:i + dl] != DELIM:
                raise ValueError("после закрывающей кавычки нет разделителя")
            i += dl
        else:
            j = line.find(DELIM, i)
            c = line[i:] if j < 0 else line[i:j]
            cells.append(c if c else NUL)
            if j < 0:
                return cells
            i = j + dl


# ============================================================ имена колонок, ключ

def make_names(desc):
    """Пустые имена получают column_<N>, дубли (без учета регистра) суффиксы _2, _3."""
    names, seen = [], set()
    for i, d in enumerate(desc, 1):
        base = d[0] or f"column_{i}"
        name, k = base, 1
        while name.lower() in seen:
            k += 1
            name = f"{base}_{k}"
        seen.add(name.lower())
        names.append(name)
    return names


KEY_STEPS = ([("exact", t) for t in KEY_EXACT_NAMES] + [("suffix", t) for t in KEY_SUFFIXES]
             + [("sub", t) for t in KEY_SUBSTRINGS])


def term_match(name, term, how, strict):
    ln, lt = name.lower(), term.lower()
    if how == "exact":
        return ln == lt
    if not strict or len(ln) != len(name):
        return ln.endswith(lt) if how == "suffix" else lt in ln
    i = ln.find(lt)
    while i >= 0:
        end_ok = how != "suffix" or i + len(lt) == len(ln)
        border = i == 0 or name[i - 1] == "_" or (name[i].isupper() and not name[i - 1].isupper())
        if end_ok and border:
            return True
        i = ln.find(lt, i + 1)
    return False


def key_order(names, ignored_lower):
    """Последовательность P (индексы колонок): кандидаты, остальные, затем то же для игнорируемых."""
    taken, cand = set(), []
    for strict in (True, False):
        for how, term in KEY_STEPS:
            for i, name in enumerate(names):
                if i not in taken and term_match(name, term, how, strict):
                    taken.add(i)
                    cand.append(i)
    rest = [i for i in range(len(names)) if i not in taken]
    ign = [names[i].lower() in ignored_lower for i in range(len(names))]
    return ([i for i in cand if not ign[i]] + [i for i in rest if not ign[i]]
            + [i for i in cand if ign[i]] + [i for i in rest if ign[i]])


def is_unique(fold, idx, nrows):
    if len(idx) == 1:
        return len(set(fold[idx[0]])) == nrows
    return len(set(zip(*[fold[i] for i in idx]))) == nrows


def find_key_len(fold, pidx, nrows):
    """Минимальная длина уникального префикса P. Возвращает (k, есть_полные_дубли)."""
    if nrows <= 1 or is_unique(fold, pidx[:1], nrows):
        return 1, False
    if not is_unique(fold, pidx, nrows):
        return len(pidx), True
    lo, hi = 2, len(pidx)
    while lo < hi:
        mid = (lo + hi) // 2
        if is_unique(fold, pidx[:mid], nrows):
            hi = mid
        else:
            lo = mid + 1
    return lo, False


def minimal_key(fold, pidx, k, nrows):
    """Ключ без лишних колонок из уникального префикса P[:k].

    Последняя колонка уникального префикса обязательна: без нее префикс не уникален. Она переходит
    в найденные, и поиск повторяется по колонкам перед ней, пока найденные сами не станут уникальны.
    Колонки результата идут в порядке P, поэтому игнорируемые остаются в конце.
    """
    found, rest = [pidx[k - 1]], pidx[:k - 1]
    while rest and not is_unique(fold, found, nrows):
        lo, hi = 1, len(rest)          # found + rest уникально
        while lo < hi:
            mid = (lo + hi) // 2
            if is_unique(fold, found + rest[:mid], nrows):
                hi = mid
            else:
                lo = mid + 1
        found.append(rest[lo - 1])
        rest = rest[:lo - 1]
    found = set(found)
    return [i for i in pidx if i in found]


# ============================================================ create table

PY_TYPE_KIND = {"str": "str", "int": "int", "bool": "bool", "float": "float", "Decimal": "decimal",
                "date": "date", "time": "time", "datetime": "datetime", "bytes": "bytes",
                "bytearray": "bytes", "UUID": "uuid"}
SIMPLE_SQL_TYPE = {"int": "bigint", "bool": "bit", "float": "float", "date": "date", "time": "time",
                   "datetime": "datetime2(7)", "datetimeoffset": "datetimeoffset",
                   "uuid": "uniqueidentifier", "xml": "xml", "sql_variant": "sql_variant",
                   "udt": "varbinary(max)"}


def sql_type(kind, d):
    type_name, size, prec, scale, null_ok = d
    if kind is None or kind == "unknown":
        kind = PY_TYPE_KIND.get(type_name, "str")
    if kind == "str":
        t = "nvarchar(max)" if not size or size > 4000 else f"nvarchar({size})"
    elif kind == "bytes":
        t = "varbinary(max)" if not size or size > 8000 else f"varbinary({size})"
    elif kind == "decimal":
        t = f"decimal({prec if prec and 1 <= prec <= 38 else 38},{scale or 0})"
    else:
        t = SIMPLE_SQL_TYPE[kind]
    return t + (" NULL" if null_ok else " NOT NULL")


def create_table(n, names, kinds, dinfo):
    cols = ", ".join(f"[{escape(name).replace(']', ']]')}] {sql_type(k, d)}"
                     for name, k, d in zip(names, kinds, dinfo))
    return f"create table #t{n}({cols})"


# ============================================================ этап 2: обработка таблицы (исполнитель)

def worker_init():
    # Ctrl+C обрабатывает главный процесс; исполнитель дорабатывает начатую таблицу.
    signal.signal(signal.SIGINT, signal.SIG_IGN)


def process_table(task):
    """Читает временный файл, нормализует, считает хэши, подбирает ключ, сортирует, пишет файл данных."""
    times = {}
    t = perf()
    names, kinds = task["names"], task["kinds"]
    ncols = len(names)
    cols = [[] for _ in range(ncols)]
    try:
        with open(task["temp"], "rb") as f:
            while True:
                try:
                    block = pickle.load(f)
                except EOFError:
                    break
                for col, part in zip(cols, block):
                    col.extend(part)
    finally:
        remove_quiet(task["temp"])
    nrows = len(cols[0])

    ign = set(task["ignored"])
    canon, fold, col_hash = [], [], []
    for j in range(ncols):
        conv = CANON.get(kinds[j], escape)
        raw, cols[j] = cols[j], None
        c = [NUL if v is None else conv(v) for v in raw]
        del raw
        fc = c if kinds[j] in NO_FOLD else [s.casefold() for s in c]
        canon.append(c)
        fold.append(fc)
        col_hash.append(sum(map(zlib.crc32, map(str.encode, fc))) & MASK64)
    # Хэш таблицы без игнорируемых колонок: строки, отличающиеся только в них, считаются одинаковыми.
    kept = [fold[j] for j in range(ncols) if names[j].lower() not in ign]
    table_hash = sum(map(zlib.crc32, map(str.encode, map("\x00".join, zip(*kept))))) & MASK64 if kept else 0
    del kept
    times["normalize"] = perf() - t
    result = {
        "rows": nrows,
        "table_hash": f"{table_hash:016x}",
        "col_hashes": {name: f"{h:016x}" for name, h in zip(names, col_hash)},
        "ignored": [x for x in names if x.lower() in ign],
        "times": times,
    }
    if task["out"] is None:   # промежуточный прогон --repeat: нужны только хэши
        return result

    t = perf()
    pidx = key_order(names, ign)
    k, dup = find_key_len(fold, pidx, nrows)
    # Колонки минимального ключа вперед, остальные в прежнем порядке. Если ключ дошел до игнорируемых
    # колонок, в нем и так все неигнорируемые: убирать их ради игнорируемых нельзя.
    if not dup and names[pidx[k - 1]].lower() not in ign:
        key = minimal_key(fold, pidx, k, nrows)
        pidx = key + [i for i in pidx if i not in key]
        k = len(key)
    times["key"] = perf() - t

    t = perf()
    if dup:   # ключ: все колонки + #dup; порядок среди полных дублей детерминирован оригинальным текстом
        kcols = [fold[i] for i in pidx] + [canon[i] for i in pidx]
    else:
        kcols = [fold[i] for i in pidx[:k]]
    keys = kcols[0] if len(kcols) == 1 else list(zip(*kcols))
    order = sorted(range(nrows), key=keys.__getitem__)
    del keys, kcols, fold
    times["sort"] = perf() - t

    t = perf()
    write_data(task["out"], names, canon, order)
    times["write"] = perf() - t

    p_names = [names[i] for i in pidx] + ([DUP_COL] if dup else [])
    result.update({
        "file": task["file"],
        "create": create_table(task["n"], names, kinds, task["desc"]),
        "klen": len(p_names) if dup else k,
        "P": p_names,
    })
    return result


def write_data(path, names, canon, order):
    with open(path, "w", encoding=FILE_ENCODING, newline="\n") as f:
        f.write(DELIM.join(format_cell(escape(name)) for name in names) + "\n")
        fmt = []
        for j in range(len(canon)):
            c, canon[j] = canon[j], None
            fmt.append([format_cell(c[i]) for i in order])
        for s in range(0, len(order), WRITE_CHUNK):
            part = zip(*(col[s:s + WRITE_CHUNK] for col in fmt))
            f.write("".join(DELIM.join(row) + "\n" for row in part))


def make_executor():
    if WORKER_MODE == "thread":
        return ThreadPoolExecutor(max_workers=1)
    return ProcessPoolExecutor(max_workers=1, initializer=worker_init)


# ============================================================ режим 1: выполнение

def err_text(e):
    if isinstance(e, KeyboardInterrupt):
        return "прервано пользователем (Ctrl+C)"
    args = getattr(e, "args", ())
    if len(args) >= 2 and isinstance(args[1], str):
        return one_line(args[1])
    return one_line(e) or type(e).__name__


def run_mode1(sql_arg, rollback, repeat, profile):
    t_run = perf()
    sql_path = Path(sql_arg)
    if sql_path.suffix.lower() != SQL_EXT:
        raise ScriptError(f"ожидается файл с расширением {SQL_EXT}: {sql_arg}")
    if ensure_settings_file():
        log("Заполните настройки подключения и запустите скрипт снова.")
        return 2
    settings = read_settings()
    if not sql_path.is_file():
        raise ScriptError(f"файл не найден: {sql_arg}")
    sql_text, sha1 = read_sql(sql_path)
    batches = split_batches(sql_text)
    conn_str = build_conn_str(settings, APP_NAME)
    ctl_conn_str = build_conn_str(settings, APP_NAME + " control")
    ignored = ignored_columns(settings["ignored_columns"], sql_path.stem)
    out_dir = Path(OUTPUT_DIR) if OUTPUT_DIR else sql_path.resolve().parent
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        import pyodbc
    except ImportError:
        raise ScriptError("не установлен модуль pyodbc: pip install pyodbc")
    Journal.on = True
    run = Mode1Run(pyodbc, sql_path, sha1, batches, conn_str, ctl_conn_str, ignored, out_dir,
                   rollback, repeat, profile)
    Events.emit("start", mode="run", sql=str(sql_path.resolve()), repeat=repeat, profile=profile,
                rollback=rollback, batches=len(batches))
    return run.execute(t_run)


# ============================================================ счетчики сервера

ZERO = (0, 0, 0, 0)
CTL_ZERO = (0, 0, 0, 0, 0, 0)
FUNC_TYPES = {"FN", "IF", "TF", "FS", "FT"}   # функции: их выборки относятся к вызывающему оператору
PLAN_SQL = "SELECT query_plan FROM sys.dm_exec_text_query_plan(?, ?, ?)"


def vadd(a, b):
    return tuple(x + y for x, y in zip(a, b))


def vsub(a, b):
    return tuple(x - y for x, y in zip(a, b))


def vmax(a, b):
    return tuple(max(x, y) for x, y in zip(a, b))


def to_counters(values):
    return tuple(int(v or 0) for v in values)


def median_vec(vs):
    return tuple(round(statistics.median(x)) for x in zip(*vs))


def run_time(c):
    """Время по счетчикам контрольного подключения: часы скрипта минус ожидание клиента."""
    return max(c[4] - c[5], 0)


def cost_text(c, client_ok):
    client = f"ожидание клиента {c[5]} мс" if client_ok else "ожидание клиента нет данных"
    return (f"время {run_time(c)} мс, {client}, CPU {c[0]} мс, логических чтений {c[1]}, "
            f"физических чтений {c[2]}")


class ControlError(Exception):
    """Контрольное подключение не видит рабочую сессию."""


class Control:
    """Контрольное подключение: читает счетчики рабочей сессии и на нее не влияет.

    Счетчики (CTL_ZERO): CPU (мс), логические чтения, физические чтения, записи, часы скрипта (мс),
    ожидание клиента (мс, ASYNC_NETWORK_IO). Счетчики сессии обновляются в конце батча, поэтому внутри
    батча значение = счетчики сессии перед батчем + счетчики запроса. Время = часы - ожидание клиента.
    """

    COUNTERS_SQL = ("SELECT s.cpu_time, s.logical_reads, s.reads, s.writes, "
                    "r.cpu_time, r.logical_reads, r.reads, r.writes, {client} "
                    "FROM sys.dm_exec_sessions s "
                    "LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id "
                    "WHERE s.session_id = ?")
    CLIENT_SQL = ("(SELECT SUM(w.wait_time_ms) FROM sys.dm_exec_session_wait_stats w "
                  "WHERE w.session_id = s.session_id AND w.wait_type = 'ASYNC_NETWORK_IO')")
    WAIT_STATS_PROBE = "SELECT TOP 0 wait_time_ms FROM sys.dm_exec_session_wait_stats"

    def __init__(self, conn, spid):
        self.conn, self.spid = conn, spid
        self.lock = threading.Lock()      # подключение общее с потоком выборки (--profile)
        self.base = self.last = CTL_ZERO
        self.req = ZERO
        try:                              # sys.dm_exec_session_wait_stats есть с SQL Server 2016
            self.query(self.WAIT_STATS_PROBE)
            self.client_ok = True
        except Exception:
            self.client_ok = False
        self.sql = self.COUNTERS_SQL.format(client=self.CLIENT_SQL if self.client_ok else "NULL")

    def query(self, sql, *params):
        return self.timed_query(sql, *params)[0]

    def timed_query(self, sql, *params):
        """(строки, длительность ответа сервера в мс). Время ожидания подключения, занятого другим
        потоком (счетчики главного потока), в длительность не входит."""
        with self.lock:
            t = perf()
            cur = self.conn.cursor()
            try:
                cur.execute(sql, *params)
                rows = [tuple(r) for r in cur.fetchall()] if cur.description is not None else []
            finally:
                cur.close()
            return rows, (perf() - t) / 1e6

    def read(self):
        rows = self.query(self.sql, self.spid)
        if not rows:
            raise ControlError("контрольное подключение не видит рабочую сессию, нужно право VIEW SERVER STATE")
        row = rows[0]
        return row, (perf() // 1_000_000, int(row[8] or 0))

    def batch_start(self):
        """Перед батчем рабочая сессия простаивает, ее счетчики полные."""
        row, stamp = self.read()
        self.base = self.last = vmax(to_counters(row[:4]) + stamp, self.last)
        self.req = ZERO
        return self.last

    def now(self):
        row, stamp = self.read()
        if row[4] is not None:
            self.req = to_counters(row[4:8])
            v = vadd(self.base[:4], self.req)
        else:    # запрос уже завершился
            v = vmax(to_counters(row[:4]), vadd(self.base[:4], self.req))
        self.last = vmax(v + stamp, self.last)
        return self.last


class Lookup(threading.Thread):
    """Тексты операторов, имена и типы объектов, планы. Свое подключение и свой поток, чтобы эти
    запросы (ответ сервера на них бывает долгим) не задерживали выборки. Каждый запрос ставится
    в очередь один раз; результат появляется в словарях texts, objects, plans (None - получить
    не удалось). Текст попадает в texts только вместе с объектом: "есть в texts" значит "готов"."""

    TEXT_SQL = "SELECT dbid, objectid, text FROM sys.dm_exec_sql_text(?)"
    NAME_SQL = "SELECT DB_NAME(?), OBJECT_SCHEMA_NAME(?, ?), OBJECT_NAME(?, ?)"
    TYPE_SQL = ("SET NOCOUNT ON; DECLARE @sql nvarchar(max) = N'SELECT type FROM ' + QUOTENAME(?) "
                "+ N'.sys.objects WHERE object_id = @id'; EXEC sp_executesql @sql, N'@id int', @id = ?")

    def __init__(self, conn):
        super().__init__(daemon=True)
        self.conn = conn
        self.texts = {}      # sql_handle -> (dbid, objectid, text) или None
        self.objects = {}    # (dbid, objectid) -> (имя, тип)
        self.plans = {}      # (plan_handle, start, end) -> текст плана или None
        self.asked = set()
        self.queue = queue.Queue()
        self.error = None
        self.start()

    def want_text(self, handle):
        if handle not in self.asked:
            self.asked.add(handle)
            self.queue.put(("text", handle))

    def want_plan(self, key):
        if key not in self.asked:
            self.asked.add(key)
            self.queue.put(("plan", key))

    def busy(self):
        return self.queue.unfinished_tasks > 0

    def query(self, sql, *params):
        cur = self.conn.cursor()
        try:
            cur.execute(sql, *params)
            return [tuple(r) for r in cur.fetchall()] if cur.description is not None else []
        finally:
            cur.close()

    def run(self):
        while True:
            item = self.queue.get()
            try:
                if item is None:
                    return
                kind, key = item
                if kind == "text":
                    self.texts[key] = self.get_text(key)
                else:
                    self.plans[key] = self.get_plan(key)
            finally:
                self.queue.task_done()

    def get_text(self, handle):
        try:
            rows = self.query(self.TEXT_SQL, handle)
            t = rows[0] if rows else None
            if t is not None and t[1] is not None and (t[0], t[1]) not in self.objects:
                self.objects[(t[0], t[1])] = self.object_info(t[0], t[1])
            return t
        except Exception as e:
            self.error = self.error or err_text(e)
            return None

    def object_info(self, dbid, objid):
        db, schema, name = self.query(self.NAME_SQL, dbid, objid, dbid, objid, dbid)[0]
        typ = None
        if db:
            try:
                rows = self.query(self.TYPE_SQL, db, objid)
                typ = str(rows[0][0]).strip() if rows else None
            except Exception:
                pass
        return (f"{schema}.{name}" if name else f"объект {objid} (база {db or dbid})"), typ

    def get_plan(self, key):
        try:
            rows = self.query(PLAN_SQL, *key)
            return rows[0][0] if rows and rows[0][0] else None
        except Exception as e:
            self.error = self.error or err_text(e)
            return None

    def stop(self):
        """Останавливает поток и закрывает подключение. Если поток завис в запросе к серверу,
        подключение остается до выхода из скрипта."""
        self.queue.put(None)
        self.join(5)
        if not self.is_alive():
            try:
                self.conn.close()
            except Exception:
                pass


class Sampler(threading.Thread):
    """Раз в PROFILE_INTERVAL_MS читает текущий оператор, счетчики и ожидание запроса сессии
    control.spid и передает выборку в StatsBuilder. --profile: в отдельном потоке (run);
    --session: опрос вызывается из главного цикла (poll).

    Выборка - два легких запроса по одной сессии: строка ее запроса и проверка, ждет ли кто-то эту
    сессию. Тексты и объекты получает Lookup в своем потоке; выборки, текст которых еще не готов,
    ждут в очереди и передаются в StatsBuilder по порядку. Ответ сервера на запрос строки запроса
    (REQUEST_SQL) дольше SAMPLE_SLOW_MS - задержка: slow - сколько их, slow_ms - их суммарная длительность."""

    REQUEST_SQL = ("SELECT r.request_id, r.start_time, r.sql_handle, r.statement_start_offset, "
                   "r.statement_end_offset, r.plan_handle, r.cpu_time, r.logical_reads, r.reads, "
                   "r.total_elapsed_time, r.wait_type, r.last_wait_type, r.status, r.granted_query_memory, "
                   "SYSDATETIME(), r.blocking_session_id FROM sys.dm_exec_requests r WHERE r.session_id = ?")
    BLOCKING_SQL = "SELECT TOP 1 1 FROM sys.dm_exec_requests WHERE blocking_session_id = ?"

    def __init__(self, control, lookup, batch_start, sql_name, adhoc_label, on_segment):
        super().__init__(daemon=True)
        self.control, self.lookup = control, lookup
        self.texts, self.objects = lookup.texts, lookup.objects
        self.stop_event = threading.Event()
        self.error = None
        self.ignoring = False            # выполняется батч --ignore in test: выборки не учитываются
        self.ignored_requests = set()
        self.waiting = collections.deque()   # выборки (None - запроса нет), ждущие текста
        self.slow = self.slow_ms = 0
        self.builder = StatsBuilder(self, batch_start, sql_name, adhoc_label, on_segment)
        self.on_poll = None              # --profile --events: вызывается после каждой выборки (в потоке)
        self.event_fields = {}           # --events: общие поля событий (номер прогона)

    def run(self):
        delay = PROFILE_INTERVAL_MS
        try:
            while not self.stop_event.wait(delay / 1000):
                s, delay = self.poll()
                if self.on_poll is not None:
                    self.on_poll(s)
        except Exception as e:
            self.error = err_text(e)
        self.finish()

    def timed_query(self, sql):
        """Запрос строки запроса сессии: от его ответа зависит точность времени. Вспомогательные запросы
        (кто ждет сессию; тексты и планы у Lookup) задержками не считаются."""
        rows, d = self.control.timed_query(sql, self.control.spid)
        if d > SAMPLE_SLOW_MS:
            self.slow += 1
            self.slow_ms += round(d)
            Events.emit("slow", count=self.slow, ms=self.slow_ms, **self.event_fields)
        return rows

    def poll(self):
        """Одна выборка: (выборка или None, если запроса нет; задержка до следующей, мс).

        Выборка: (запрос, sql_handle, start, end, plan_handle, (cpu, logical, physical, elapsed),
        (wait_type, last_wait_type, status, выделено памяти в страницах, блокирует другие сессии,
        какую сессию ждет или None), время сервера)."""
        rows = self.timed_query(self.REQUEST_SQL)
        if not rows or rows[0][2] is None:
            self.push(None)
            return None, PROFILE_INTERVAL_MS
        r = rows[0]
        if self.ignoring or (r[0], r[1]) in self.ignored_requests:   # батч --ignore in test
            self.ignored_requests.add((r[0], r[1]))
            self.push(None)
            return None, PROFILE_INTERVAL_MS
        blocking = 1 if self.control.query(self.BLOCKING_SQL, self.control.spid) else 0
        handle = bytes(r[2])
        plan = bytes(r[5]) if r[5] is not None else None
        # blocking_session_id: 0 - никого не ждет, < 0 - владелец неизвестен; у параллельного плана
        # (CXPACKET и т. п.) в нем своя же сессия
        by = r[15]
        by = int(by) if by and by > 0 and by != self.control.spid else None
        s = ((r[0], r[1]), handle, r[3] or 0, r[4], plan, to_counters(r[6:10]),
             tuple(r[10:14]) + (blocking, by), r[14])
        self.lookup.want_text(handle)
        self.push(s)
        # внутри функции или с испорченными границами оператора - следующий опрос сразу
        again = self.ready(handle) and self.builder.statement(s) is None
        return s, PROFILE_FAST_MS if again else PROFILE_INTERVAL_MS

    def ready(self, handle):
        return handle in self.texts

    def now(self, s):
        """Текущий оператор выборки s (для функции - вызывающий) для строки состояния и событий:
        {key, label, line, text, wait, blocked_by}; label None - запроса нет; None - текст еще не получен."""
        if s is None:
            return {"key": ("нет запроса",), "label": None, "line": 0, "text": "", "wait": "", "blocked_by": None}
        if not self.ready(s[1]):
            return None
        st = self.builder.statement(s) or self.builder.current()
        if st:
            key, label, line, text = (s[0], st["key"]), st["label"], st["line"], st["text"]
        else:   # функция, вызывающий оператор еще не встретился
            t = self.texts.get(s[1])
            obj = self.objects.get((t[0], t[1])) if t else None
            label, line, text = f"{obj[0] if obj else '?'} (функция)", 0, ""
            key = (s[0], label)
        return {"key": key, "label": label, "line": line, "text": text,
                "wait": (s[6][0] or "").strip(), "blocked_by": s[6][5]}

    def push(self, item):
        self.waiting.append(item)
        self.drain()

    def drain(self, force=False):
        """Передает в StatsBuilder выборки, текст которых готов; force - все (без текста будет
        "(текст недоступен)")."""
        while self.waiting:
            item = self.waiting[0]
            if item is not None and not force and not self.ready(item[1]):
                return
            self.waiting.popleft()
            if item is None:
                self.builder.idle()
            else:
                self.builder.feed(item)

    def finish(self, wait_s=LOOKUP_WAIT_S):
        """Конец выборок: дождаться текстов (не дольше wait_s) и передать все выборки."""
        end = perf() + wait_s * 10**9
        while self.waiting and self.lookup.busy() and perf() < end:
            time.sleep(0.02)
        self.drain(force=True)
        self.builder.idle()

    def stop(self):
        self.stop_event.set()
        self.join()


STMT_MIN_LEN = 2    # текст оператора не длиннее - границы испорчены, выборка считается как внутри функции


def describe(sampler, s, batch_start, sql_name, adhoc_label):
    """Оператор выборки: словарь с ключом (объект, строка, хэш текста) или None, если это функция
    или границы оператора испорчены: в sys.dm_exec_requests смещения начала и конца читаются без
    блокировки и в момент смены оператора бывают несогласованными (конец раньше начала, текст из
    одной буквы). Такая выборка, как и выборка внутри функции, относится к предыдущему оператору,
    а следующий опрос идет сразу."""
    handle, start, end = s[1], s[2], s[3]
    t = sampler.texts.get(handle)
    if t is None:
        label = "(текст недоступен)"
        return {"key": (label, 0, ""), "label": label, "line": 0, "hash": "", "text": "", "start": start, "end": end}
    dbid, objid, text = t
    text = text or ""
    obj = sampler.objects.get((dbid, objid)) if objid is not None else None
    if obj is not None and obj[1] in FUNC_TYPES:
        return None
    i0 = start // 2
    i1 = len(text) if end is None or end < 0 else end // 2 + 1
    stmt = text[i0:i1].strip()
    if len(stmt) <= STMT_MIN_LEN:
        return None     # границы оператора испорчены (сервер отдал их в момент смены оператора)
    line = text.count("\n", 0, i0) + 1
    if obj is not None:
        label = obj[0]
    elif text in batch_start:
        label, line = sql_name, batch_start[text] + line - 1
    else:
        label = adhoc_label
    h = f"{zlib.crc32(' '.join(stmt.split()).casefold().encode('utf-8', 'surrogatepass')):08x}"
    return {"key": (label, line, h), "label": label, "line": line, "hash": h, "text": stmt,
            "start": start, "end": end}


WAIT_GROUPS = ("PAGEIOLATCH_", "PAGELATCH_", "LATCH_")   # подтипы (_SH, _EX, ...) объединяются в X_*


def new_extra():
    """Ожидания интервала или оператора, мс; mem - наибольшее выделение памяти, страниц по 8 КБ."""
    return {"client": 0, "locks": 0, "blocking": 0, "mem": 0, "waits": {}}


def add_extra(a, b):
    for k in ("client", "locks", "blocking"):
        a[k] += b[k]
    a["mem"] = max(a["mem"], b["mem"])
    for k, v in b["waits"].items():
        a["waits"][k] = a["waits"].get(k, 0) + v


def wait_name(wait_type, last_wait_type, status):
    """Тип ожидания выборки: текущий; без него у ожидающего процессор - SOS_SCHEDULER_YIELD;
    у выполняющегося - последний завершенный."""
    wt = (wait_type or "").strip()
    if not wt:
        wt = "SOS_SCHEDULER_YIELD" if (status or "").strip().lower() == "runnable" else (last_wait_type or "").strip()
    for g in WAIT_GROUPS:
        if wt.startswith(g):
            return g + "*"
    return wt


def interval_extra(d, state):
    """Ожидания интервала между выборками: время интервала без CPU относится к типу ожидания выборки."""
    wait_type, last_wait_type, status, mem, blocking = state[:5]
    ex = new_extra()
    ex["mem"] = int(mem or 0)
    if blocking:
        ex["blocking"] = d[3]
    w = max(d[3] - d[0], 0)
    if not w:
        return ex
    wt = wait_name(wait_type, last_wait_type, status)
    if wt == "ASYNC_NETWORK_IO":
        ex["client"] = w
    elif wt.startswith("LCK_M_"):
        ex["locks"] = w
    else:
        ex["waits"][wt or "(неизвестно)"] = w
    return ex


def stat_entry(st):
    return dict(st, cost=ZERO, samples=0, runs=0, extra=new_extra())


def add_interval(e, d, ex):
    e["cost"] = vadd(e["cost"], d)
    add_extra(e["extra"], ex)
    e["samples"] += 1


class StatsBuilder:
    """Распределяет приращения счетчиков и ожиданий по операторам, по одной выборке.

    Приращение между двумя выборками одного запроса относится к оператору второй выборки.
    Выборка внутри функции относится к последнему оператору вне функций этого запроса, а если такого
    еще не было, то к следующему. stats - итог по операторам. Отрезок - непрерывное выполнение
    одного оператора; когда он закончился (начался другой оператор или запрос), он передается
    в on_segment с временем сервера начала.

    Запусков (runs) - сколько отрезков у оператора: возврат к оператору после другого оператора
    (цикл или повторный вызов процедуры) или новый запрос с тем же оператором. Выборки внутри функций
    отрезок не прерывают, поэтому мерцание "вызывающий - оператор функции" счетчик не накручивает.
    Это нижняя оценка: повторы между двумя выборками без другого оператора не видны.
    """

    def __init__(self, sampler, batch_start, sql_name, adhoc_label, on_segment):
        self.sampler = sampler
        self.batch_start, self.sql_name, self.adhoc_label = batch_start, sql_name, adhoc_label
        self.on_segment = on_segment
        self.cache, self.stats = {}, {}
        self.samples = self.func = 0
        self.lost = ZERO
        self.prev = self.last = self.seg = None
        self.since = None       # --session: время сервера начала наблюдения
        self.reset_pending()

    def reset_pending(self):
        self.pending, self.pending_ex, self.pending_t0 = ZERO, new_extra(), None

    def statement(self, s):
        ck = s[1:4]
        if ck not in self.cache:
            self.cache[ck] = describe(self.sampler, s, self.batch_start, self.sql_name, self.adhoc_label)
        return self.cache[ck]

    def feed(self, s):
        self.samples += 1
        if self.prev is not None and s[0] == self.prev[0]:
            d, t0 = vmax(vsub(s[5], self.prev[5]), ZERO), self.prev[7]
        else:    # новый запрос (батч): счетчики с его начала
            self.idle()
            d, t0 = s[5], s[0][1]
            if self.since is not None and isinstance(t0, dt.datetime) and t0 < self.since:
                # --session: запрос начался до наблюдения. Его счетчики к первой выборке - все, что он
                # потратил раньше, на любых операторах; оператору первой выборки они не относятся
                # (иначе в первой строке журнала - время от начала запроса).
                d, t0 = ZERO, s[7]
        self.prev = s
        ex = interval_extra(d, s[6])
        st = self.statement(s)
        if st is None:
            self.func += 1
            if self.last is None:
                self.pending = vadd(self.pending, d)
                add_extra(self.pending_ex, ex)
                self.pending_t0 = self.pending_t0 or t0
                return
            e = self.stats[self.last]
        else:
            e = self.stats.setdefault(st["key"], stat_entry(st))
            e["plan_handle"] = s[4]
            d = vadd(d, self.pending)
            add_extra(ex, self.pending_ex)
            t0 = self.pending_t0 or t0
            self.reset_pending()
            if self.seg is None or self.seg["key"] != st["key"]:
                self.close_segment()
                self.seg = dict(stat_entry(st), start_time=t0)
                e["runs"] += 1
            self.last = st["key"]
        add_interval(e, d, ex)
        add_interval(self.seg, d, ex)

    def close_segment(self):
        if self.seg is not None:
            seg, self.seg = self.seg, None
            self.on_segment(seg)

    def idle(self):
        """Запрос закончился (или его нет): отрезок закрывается, функции без оператора теряются."""
        self.close_segment()
        self.lost = vadd(self.lost, self.pending)
        self.reset_pending()
        self.prev = self.last = None

    def current(self):
        """Оператор последней выборки (для функции - вызывающий) или None."""
        return self.stats.get(self.last) if self.last is not None else None

    def summary(self):
        sp = self.sampler
        return {"samples": self.samples, "func": self.func, "lost": self.lost, "error": sp.error,
                "lookup_error": sp.lookup.error, "slow": sp.slow, "slow_ms": sp.slow_ms}


def sampling_lines(slow, slow_ms, lookup_errors, note=""):
    """Строки шапки registry.txt о задержках выборки и ошибках получения текстов и планов."""
    lines = [f"Задержки выборки (ответ дольше {SAMPLE_SLOW_MS} мс): {slow}, всего {slow_ms} мс{note}"]
    lines += [f"Ошибка получения текста или плана: {e}" for e in sorted(set(lookup_errors))]
    return lines


# ============================================================ режим 1: прогон

class Pass:
    """Один прогон запроса: рабочее и контрольное подключения, прием таблиц, счетчики."""

    def __init__(self, run, k):
        self.run = run
        self.k = k
        self.final = k == run.repeat     # данные сохраняются только в последнем прогоне
        self.server = {}
        self.connect_ns = 0
        self.sql_ns = 0                  # сумма execute, nextset, fetchmany
        self.perf_lines = []             # хронология вызовов драйвера
        self.messages = []               # (метка шага, текст сообщения сервера)
        self.last_msgs = []
        self.futures = []                # (n, future)
        self.results = {}
        self.table_no = 0
        self.partial = None              # номер таблицы, прием которой не завершен
        self.aborted = None
        self.control = None
        self.counters_error = None       # почему нет счетчиков сервера
        self.client_ok = False           # есть ожидание клиента (sys.dm_exec_session_wait_stats)
        self.first = self.mark = None    # счетчики в начале прогона и в конце предыдущей таблицы
        self.total = None                # затраты прогона
        self.table_cost = {}             # n -> затраты с конца предыдущей таблицы
        self.table_rows = {}             # n -> получено строк
        self.sampler = None
        self.stmts = self.prof = None    # --profile
        self.segments = []               # --profile: отрезки выполнения операторов по порядку
        self.now_events = NowEvents(**{"pass": k})   # --profile --events
        self.next_live = 0               # --profile --events: когда следующие счетчики из выборки

    def query(self):
        run, pyodbc = self.run, self.run.pyodbc
        pyodbc.native_uuid = True
        log(f"Подключение ({'rollback' if run.rollback else 'autocommit'})...")
        t = perf()
        try:
            conn = pyodbc.connect(run.conn_str, autocommit=not run.rollback)
        except pyodbc.Error as e:
            raise ScriptError(f"ошибка подключения: {err_text(e)}")
        self.connect_ns = perf() - t
        ctl = None
        try:
            if QUERY_TIMEOUT:
                conn.timeout = QUERY_TIMEOUT
            for code, fn in OUTPUT_CONVERTERS:
                conn.add_output_converter(code, fn)
            self.server = server_info(conn, pyodbc)
            cur = conn.cursor()
            ctl = self.open_control(cur)
            try:
                Stop.set_cancel(cur.cancel)
                self.run_batches(cur)
            except (Exception, KeyboardInterrupt) as e:
                # после остановки извне ошибка драйвера - это отмена оператора, причина - остановка
                self.aborted = Stop.reason or err_text(e)
                if self.partial is not None:
                    self.aborted += f" (таблица {self.partial} получена не полностью и не сохранена)"
                self.grab(cur, "при ошибке")
                log(f"Запуск прерван: {self.aborted}")
                Events.emit("aborted", reason=self.aborted, **{"pass": self.k})
            finally:
                Stop.set_cancel(None)
                self.stop_sampler()
        finally:
            if run.rollback:
                try:
                    conn.rollback()
                except Exception as e:
                    log(f"Ошибка rollback: {err_text(e)}")
            elif self.aborted:
                # прерванный оператор (ошибка, отмена) сервер не откатывает до конца транзакции:
                # если скрипт сам открыл транзакцию, ее блокировки держались бы до отключения
                try:
                    conn.execute("IF @@TRANCOUNT > 0 ROLLBACK")
                except Exception as e:
                    log(f"Ошибка отката открытой транзакции: {err_text(e)}")
            try:
                conn.close()
            except Exception:
                pass
            if ctl is not None:
                if self.final and self.stmts is not None:
                    run.fetch_plans(self.control)
                try:
                    ctl.close()
                except Exception:
                    pass

    def open_control(self, cur):
        """Контрольное подключение. Если оно не работает, запуск идет дальше без счетчиков."""
        pyodbc, ctl = self.run.pyodbc, None
        try:
            spid = query_spid(cur)
            Events.emit("spid", spid=spid)
            ctl = pyodbc.connect(self.run.ctl_conn_str, autocommit=True)
            self.control = Control(ctl, spid)
            self.client_ok = self.control.client_ok
            self.control.batch_start()
        except (pyodbc.Error, ControlError) as e:
            self.counters_error = err_text(e)
            self.control = None
            log(f"Счетчики сервера недоступны: {self.counters_error}")
            if ctl is not None:
                try:
                    ctl.close()
                except Exception:
                    pass
            return None
        if self.run.profile:
            try:   # тексты и объекты операторов - на отдельном подключении, чтобы не задерживать выборки
                lookup = Lookup(pyodbc.connect(self.run.ctl_conn_str, autocommit=True))
            except pyodbc.Error as e:
                log(f"Профилирование недоступно: {err_text(e)}")
                return ctl
            batch_start = {text: start for start, text in self.run.batches}
            self.sampler = Sampler(self.control, lookup, batch_start, self.run.sql_path.name,
                                   "(динамический SQL)", self.segments.append)
            self.sampler.event_fields = {"pass": self.k}
            if Events.on:
                self.sampler.on_poll = self.on_sample
            self.sampler.start()
        return ctl

    def measure(self, what):
        """Счетчики рабочей сессии (what: "batch_start" или "now"); None, если их нет."""
        if self.control is None or self.counters_error:
            return None
        try:
            return getattr(self.control, what)()
        except Exception as e:
            self.counters_error = f"ошибка контрольного подключения: {err_text(e)}"
            log(f"Счетчики сервера недоступны: {self.counters_error}")
            return None

    def emit_counters(self, v):
        """--events: счетчики прогона на момент v (вектор контрольного подключения)."""
        if v is None or self.first is None:
            return
        d = vsub(v, self.first)
        Events.emit("counters", time_ms=run_time(d), cpu_ms=d[0], logical_reads=d[1], physical_reads=d[2],
                    client_ms=d[5] if self.client_ok else None, **{"pass": self.k})

    def on_sample(self, s):
        """Поток выборки (--profile --events): текущий оператор и раз в секунду счетчики прогона -
        по формуле Control.now (счетчики сессии перед батчем + счетчики запроса из выборки), без
        лишних запросов. Ожидание клиента - на момент последнего замера контрольного подключения."""
        self.now_events.update(self.sampler.now(s))
        t = perf()
        c = self.control
        if s is None or t < self.next_live or c is None or self.counters_error:
            return
        self.next_live = t + 10**9
        v = vadd(c.base[:3], s[5][:3]) + (c.base[3], t // 1_000_000, c.last[5])
        self.emit_counters(vmax(v, c.last))

    def stop_sampler(self):
        if self.sampler is None:
            return
        self.sampler.stop()
        self.sampler.lookup.stop()
        if self.sampler.error:
            log(f"Профилирование остановлено: {self.sampler.error}")
        self.stmts, self.prof = self.sampler.builder.stats, self.sampler.builder.summary()

    def run_batches(self, cur):
        batches = self.run.batches
        for k, (_, batch) in enumerate(batches, 1):
            Stop.check()
            ignored = is_ignored_batch(batch)
            log(f"Батч {k} из {len(batches)}{' (--ignore in test)' if ignored else ''}...")
            Events.emit("batch", k=k, of=len(batches), ignored=ignored, line=batches[k - 1][0], **{"pass": self.k})
            start = self.measure("batch_start")
            if self.first is None:
                self.first = self.mark = start
            self.emit_counters(start)
            if ignored:
                self.run_ignored(cur, k, batch, start)
                continue
            self.perf_lines.append(f"Батч {k}:")
            self.timed("  execute", cur.execute, batch)
            self.grab(cur, f"батч {k}, после execute")
            while True:
                after = "nextset"
                if cur.description is not None:
                    after = f"таблицы {self.receive_table(cur)}"
                else:
                    rc = cur.rowcount
                    if rc is not None and rc >= 0:
                        self.perf_lines.append(f"  rowcount: {rc}")
                has_next = self.timed("  nextset", cur.nextset)
                self.grab(cur, f"батч {k}, после {after}")
                if not has_next:
                    break
            end = self.measure("now")
            if end is not None and self.first is not None:
                self.total = vsub(end, self.first)
            self.emit_counters(end)

    def run_ignored(self, cur, k, batch, start):
        """Батч --ignore in test: выполняется (и откатывается с --rollback), но его таблицы, сообщения,
        затраты и выборки в отчет не попадают. Затраты вычитаются сдвигом начальных замеров."""
        self.perf_lines.append(f"Батч {k}: --ignore in test, в отчет не попадает")
        if self.sampler is not None:
            self.sampler.ignoring = True
        try:
            cur.execute(batch)
            Stop.check()
            while True:
                if cur.description is not None:
                    while cur.fetchmany(FETCH_BLOCK):
                        Stop.check()
                if not cur.nextset():
                    break
                Stop.check()
        finally:
            if self.sampler is not None:
                self.sampler.ignoring = False
            self.last_msgs = []
        end = self.measure("now")
        if start is not None and end is not None:
            d = vsub(end, start)
            self.first, self.mark = vadd(self.first, d), vadd(self.mark, d)

    def timed(self, label, fn, *args):
        t = perf()
        try:
            res = fn(*args)
        finally:
            d = perf() - t
            self.sql_ns += d
            self.perf_lines.append(f"{label}: {ms(d)} мс")
        Stop.check()
        return res

    def grab(self, cur, label, incremental=False):
        """Сохраняет новые сообщения сервера (cursor.messages) с меткой шага (все - для отчета)
        и показывает сообщения SQL (show_message) - в момент, когда драйвер их вернул."""
        try:
            raw = [m if isinstance(m, tuple) and len(m) > 1 else ("", str(m)) for m in (cur.messages or [])]
        except Exception:
            return
        msgs = [m[1] for m in raw]
        start = 0
        last = self.last_msgs
        if incremental and last and msgs[:len(last)] == last:   # список не очищался между fetchmany
            start = len(last)
        self.messages.extend((label, text) for text in msgs[start:])
        self.last_msgs = msgs
        for kind, text in raw[start:]:
            show_message(kind, text, **{"pass": self.k})

    def receive_table(self, cur):
        """Этап 1: прием таблицы во временный файл; затем постановка в очередь исполнителю."""
        run = self.run
        self.table_no += 1
        n = self.table_no
        self.partial = n
        desc = cur.description
        names = make_names(desc)
        dinfo = [(getattr(d[1], "__name__", str(d[1])), d[3], d[4], d[5], bool(d[6])) for d in desc]
        ncols = len(desc)
        kinds = [None] * ncols
        checks = [None] * ncols
        pending = list(range(ncols))          # колонки, вид которых еще не известен (только NULL)
        fd, tmp = tempfile.mkstemp(prefix="CompareQuery_", suffix=".tmp", dir=TEMP_DIR)
        run.temps.append(tmp)
        rows = calls = fetch_ns = 0
        with os.fdopen(fd, "wb") as f:
            while True:
                t = perf()
                try:
                    block = cur.fetchmany(FETCH_BLOCK)
                finally:
                    d = perf() - t
                    fetch_ns += d
                    self.sql_ns += d
                    calls += 1
                self.grab(cur, f"таблица {n}, при получении", incremental=True)
                if not block:
                    break
                Stop.check()
                cols = list(zip(*block))
                if pending:
                    rest = []
                    for j in pending:
                        v = next((x for x in cols[j] if x is not None), None)
                        if v is None:
                            rest.append(j)
                        else:
                            kinds[j] = kind_of(v)
                            checks[j] = stage1_check(kinds[j], dinfo[j][1])
                    pending = rest
                for j, fn in enumerate(checks):
                    if fn is not None:
                        cols[j] = tuple(map(fn, cols[j]))
                pickle.dump(cols, f, pickle.HIGHEST_PROTOCOL)
                rows += len(block)
                if len(block) < FETCH_BLOCK:
                    break
        now = self.measure("now")     # таблица получена, запрос еще идет
        if now is not None and self.mark is not None:
            self.table_cost[n] = vsub(now, self.mark)
            self.mark = now
        self.emit_counters(now)
        self.partial = None
        self.table_rows[n] = rows
        out = rel = None
        if self.final:
            run.data_dir.mkdir(parents=True, exist_ok=True)
            out = unique_path(run.data_dir / f"{run.run_id()}_{n}{DATA_EXT}")
            rel = f"{run.data_dir.name}/{out.name}"
            out = str(out)
        task = {"n": n, "temp": tmp, "out": out, "file": rel, "names": names, "kinds": kinds, "desc": dinfo,
                "ignored": ignored_for_table(run.ignored, n)}
        self.futures.append((n, run.executor.submit(process_table, task)))
        self.perf_lines.append(f"  таблица {n}: получение {ms(fetch_ns)} мс "
                               f"(вызовов fetchmany: {calls}), строк: {rows}")
        log(f"Таблица {n}: получено строк: {rows}")
        Events.emit("table", n=n, rows=rows, **{"pass": self.k})
        return n

    def collect(self):
        results = {}
        if self.futures:
            log("Ожидание обработки таблиц...")
        for n, fut in self.futures:
            try:
                results[n] = fut.result()
            except Exception as e:
                results[n] = e
                if not self.aborted:
                    self.aborted = f"ошибка обработки таблицы {n}: {one_line(e)}"
        return results


# ============================================================ режим 1: запуск и отчет

REGISTRY_FILE, REGISTRY_TABLE, REGISTRY_LOG = "registry.txt", "registry.csv", "log.csv"
REGISTRY_COLUMNS = ["№", "Время мс", "Время %", "CPU мс", "Ожидание блокировок мс",
                    "Блокировал сам мс", "Ожидание ресурсов мс", "Ожидание ресурсов 1 место",
                    "Ожидание ресурсов 2 место", "Ожидание ресурсов 3 место", "Выделено памяти МБ",
                    "Ожидание клиента мс", "Логических чтений", "Физических чтений", "Выборок",
                    "Запусков", "Объект", "Строка", "Хэш", "Текст", "План", "Начало текста"]
# Журнал: без номера, доли, хэша и имен файлов (номера файлов меняются, а журнал только дописывается)
# и без числа запусков (строка журнала - один запуск). Оператор журнала находится в реестре по объекту
# и строке (и началу текста).
LOG_COLUMNS = ["Время сервера"] + [c for c in REGISTRY_COLUMNS
                                   if c not in ("№", "Время %", "Хэш", "Текст", "План", "Запусков")]
SQL_COMMENT_SKIP = {"Время %", "Ожидание клиента мс"}    # не пишутся в комментарий NNN.sql
# Начало текста: заменяются пробелами только переводы строк и управляющие символы, ломающие строку
# CSV; табуляция и прочее остаются как в исходном тексте, чтобы кусок находился поиском.
HEAD_BREAKS_RE = re.compile("\r\n|[\x00-\x08\x0a-\x1f\x7f\x85  ]")


def with_time(e):
    """Оператор или отрезок с временем: время выполнения без ожидания клиента."""
    return dict(e, time=max(e["cost"][3] - e["extra"]["client"], 0))


def registry_values(r, base):
    """Значения оператора для таблицы реестра и комментария в NNN.sql: {колонка: текст}.
    base - время, от которого считается доля; None - доля не показывается (журнал)."""
    c, ex = r["cost"], r["extra"]
    top = sorted(ex["waits"].items(), key=lambda x: (-x[1], x[0]))[:3]
    places = [f"{t} ({w} мс)" for t, w in top] + [""] * (3 - len(top))
    return {
        "Время мс": str(r["time"]),
        "Время %": "" if base is None else f"{100 * r['time'] / base:.1f}" if base else "0.0",
        "CPU мс": str(c[0]),
        "Ожидание блокировок мс": str(ex["locks"]),
        "Блокировал сам мс": str(ex["blocking"]),
        "Ожидание ресурсов мс": str(sum(ex["waits"].values())),
        "Ожидание ресурсов 1 место": places[0],
        "Ожидание ресурсов 2 место": places[1],
        "Ожидание ресурсов 3 место": places[2],
        "Выделено памяти МБ": f"{ex['mem'] * 8 / 1024:.1f}" if ex["mem"] else "0",
        "Ожидание клиента мс": str(ex["client"]),
        "Логических чтений": str(c[1]),
        "Физических чтений": str(c[2]),
        "Выборок": str(r["samples"]),
        "Запусков": str(r.get("runs", "")),
    }


def csv_line(cells, text):
    """Строка registry.csv или log.csv; последняя колонка - начало текста оператора."""
    return DELIM.join([format_cell(escape(x)) if x else "" for x in cells] + [head_cell(text)])


def head_cell(text):
    """Первые REGISTRY_TEXT_LEN символов текста без экранирования: переводы строк - пробелы."""
    s = HEAD_BREAKS_RE.sub(" ", text)[:REGISTRY_TEXT_LEN]
    if not s:
        return ""
    if DELIM in s or '"' in s or "\t" in s or s[0] == " " or s[-1] == " ":
        return '"' + s.replace('"', '""') + '"'
    return s


def registry_files(rows, base):
    """registry.csv, тексты и планы операторов: {имя файла: (идентификатор, текст)}.
    Имена файлов оператора: "NNN - <время мс>.sql" и ".sqlplan". Идентификатор связывает файл
    с оператором, чтобы при сдвиге номера файл переименовывался, а не писался заново.
    rows - операторы по убыванию времени, у каждого есть time."""
    files = {}
    lines = [DELIM.join(REGISTRY_COLUMNS)]
    for i, r in enumerate(rows, 1):
        name = f"{i:03d} - {r['time']}"
        v = registry_values(r, base)
        sql = f"{name}.sql"
        files[sql] = (("sql", r["key"]),
                      f"-- {r['label']}, строка {r['line']}\n--"
                      + "; ".join(f"{k}: {x}" for k, x in v.items() if k not in SQL_COMMENT_SKIP and x)
                      + f"\n{r['text']}\n")
        plan = ""
        if r.get("plan"):
            plan = f"{name}.sqlplan"
            files[plan] = (("plan", r["key"]), r["plan"])
        lines.append(csv_line([str(i)] + list(v.values()) + [r["label"], str(r["line"]), r["hash"], sql, plan],
                              r["text"]))
    files[REGISTRY_TABLE] = (REGISTRY_TABLE, "\n".join(lines) + "\n")
    return files


def log_line(seg):
    """Строка журнала: отрезок выполнения оператора, первая колонка - время сервера начала."""
    r = with_time(seg)
    t = seg["start_time"]
    v = registry_values(r, None)
    v["Время сервера"] = t.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3] if isinstance(t, dt.datetime) else str(t or "")
    v["Объект"], v["Строка"] = r["label"], str(r["line"])
    return csv_line([v[c] for c in LOG_COLUMNS[:-1]], r["text"])


class RegistryFolder:
    """Файлы папки реестра.

    Файл с тем же текстом под новым именем переименовывается, неизменившийся не трогается,
    измененный пишется через временный файл и замену (прерванная запись не портит файл).
    Файл, занятый другой программой (например, открытый в Excel), пропускается до следующей записи.
    """

    def __init__(self, folder, warn=log):
        self.folder, self.warn = folder, warn
        self.files = {}          # идентификатор -> (имя, текст), как сейчас на диске
        self.busy = set()

    def put(self, name, text):
        enc = "utf-8" if name.endswith(".sqlplan") else FILE_ENCODING
        path = self.folder / name
        tmp = path.with_name(name + ".tmp")
        try:
            with open(tmp, "w", encoding=enc, newline="\n") as f:
                f.write(text)
            os.replace(tmp, path)
        except OSError as e:
            remove_quiet(tmp)
            if name not in self.busy:
                self.busy.add(name)
                self.warn(f"Файл {name} не обновлен (открыт в другой программе?): {e}")
            return False
        self.busy.discard(name)
        return True

    def sync(self, files):
        """files: {имя: (идентификатор, текст)}. Файлы, которых больше нет, удаляются."""
        want = {ident: (name, text) for name, (ident, text) in files.items()}
        old_names = {n for n, _ in self.files.values()}
        for ident in [i for i in self.files if i not in want]:
            del self.files[ident]
        # Переименование файлов с тем же текстом, когда новое имя свободно.
        moves = [i for i, (n, t) in want.items() if i in self.files and self.files[i] != (n, t)
                 and self.files[i][1] == t]
        moved = True
        while moves and moved:
            moved = False
            taken = {n for n, _ in self.files.values()}
            for i in list(moves):
                if want[i][0] in taken:
                    continue
                moves.remove(i)
                moved = True
                try:
                    os.replace(self.folder / self.files[i][0], self.folder / want[i][0])
                except OSError:
                    continue      # останется старое имя, ниже файл будет записан заново
                taken.discard(self.files[i][0])
                taken.add(want[i][0])
                self.files[i] = want[i]
        # Новые, измененные и те, что не удалось переименовать (обмен именами), пишутся.
        for i, (name, text) in want.items():
            if self.files.get(i) != (name, text) and self.put(name, text):
                self.files[i] = (name, text)
        for n in old_names - {n for n, _ in self.files.values()}:
            remove_quiet(self.folder / n)


class LogWriter:
    """log.csv: строки только дописываются. Если файл занят, строки ждут следующей записи."""

    def __init__(self, path, warn=log):
        self.path, self.warn = path, warn
        self.pending = [DELIM.join(LOG_COLUMNS)]
        self.busy = False
        self.write()

    def add(self, seg):
        self.pending.append(log_line(seg))
        self.write()

    def add_many(self, segs):
        self.pending += [log_line(s) for s in segs]
        self.write()

    def write(self):
        if not self.pending:
            return
        try:
            with open(self.path, "a", encoding=FILE_ENCODING, newline="\n") as f:
                f.write("\n".join(self.pending) + "\n")
        except OSError as e:
            if not self.busy:
                self.busy = True
                self.warn(f"Файл {self.path.name} не дописан (открыт в другой программе?): {e}")
            return
        self.pending = []
        self.busy = False


class Mode1Run:
    def __init__(self, pyodbc, sql_path, sha1, batches, conn_str, ctl_conn_str, ignored, out_dir,
                 rollback, repeat, profile):
        self.pyodbc = pyodbc
        self.sql_path = sql_path
        self.sha1 = sha1
        self.batches = batches           # [(первая строка в файле, текст)]
        self.conn_str = conn_str
        self.ctl_conn_str = ctl_conn_str
        self.ignored = ignored
        self.out_dir = out_dir
        self.data_dir = out_dir / sql_path.stem   # файлы данных и папки реестра; отчет остается в out_dir
        self.rollback = rollback
        self.repeat = repeat
        self.profile = profile
        self.started = dt.datetime.now()     # часы компьютера: только для пометки о расхождении с сервером
        self.t_start = perf()
        self.name = None                     # run_id()
        self.passes = []
        self.temps = []
        self.executor = None
        self.stmt_rows = None            # --profile: операторы с медианами, по убыванию времени

    def execute(self, t_run):
        try:
            self.executor = make_executor()
            for k in range(1, self.repeat + 1):
                if self.repeat > 1:
                    log(f"Прогон {k} из {self.repeat}...")
                Events.emit("pass", k=k, of=self.repeat)
                p = Pass(self, k)
                self.passes.append(p)
                p.query()
                p.results = p.collect()
                if p.aborted:
                    break
        except KeyboardInterrupt:
            if self.executor is not None:
                self.executor.shutdown(wait=False, cancel_futures=True)
                self.executor = None
            raise
        finally:
            if self.executor is not None:
                self.executor.shutdown(wait=True)
            for p in self.temps:
                remove_quiet(p)
        registry = self.write_registry() if self.profile else None
        journal = self.write_journal()
        text, console = self.report(t_run, registry, journal)
        path = unique_path(self.out_dir / f"{self.run_id()}{REPORT_EXT}")
        write_report(path, text, console)
        log(f"Отчет: {path}")
        return 2 if self.passes[-1].aborted else 0

    def run_id(self):
        """Имя запуска <скрипт>_<время сервера в начале>: общее начало имен отчета, CSV и папки реестра.
        Определяется при первой записи, когда часы сервера уже известны (первое подключение)."""
        if self.name is None:
            self.name = f"{self.sql_path.stem}_{ServerTime.at(self.t_start).strftime(DT_FORMAT)}"
        return self.name

    # ---------------------------------------------------- счетчики по прогонам

    def measured(self):
        """Прогоны, по которым считаются счетчики: все, кроме первого (прогрев), если прогонов несколько."""
        return self.passes[1:] if len(self.passes) > 1 else self.passes

    def median_note(self):
        m = self.measured()
        if len(m) == 1:
            return f"прогон {m[0].k}, прогон 1 - прогрев"
        return f"медиана прогонов {m[0].k}-{m[-1].k}, прогон 1 - прогрев"

    def median_cost(self, get):
        """Медиана затрат по прогонам или None, если хотя бы в одном прогоне их нет."""
        vs = [None if p.counters_error else get(p) for p in self.measured()]
        return None if not vs or any(v is None for v in vs) else median_vec(vs)

    def nondeterministic(self):
        """Таблицы, у которых число строк или хэш различаются между прогонами."""
        def sig(r):
            return (r["rows"], r["table_hash"]) if isinstance(r, dict) else None
        final = self.passes[-1].results
        return [n for n in sorted({n for p in self.passes for n in p.results})
                if sig(final.get(n)) is None or any(sig(p.results.get(n)) != sig(final.get(n)) for p in self.passes)]

    # ---------------------------------------------------- реестр операторов (--profile)

    def statement_rows(self):
        ps = [p for p in self.measured() if p.stmts is not None]
        rows = []
        for key in {k for p in ps for k in p.stmts}:
            row = dict([p.stmts[key] for p in ps if key in p.stmts][-1])
            got = [p.stmts.get(key) for p in ps]

            def med(get):
                return round(statistics.median([get(x) if x else 0 for x in got]))
            row["cost"] = median_vec([x["cost"] if x else ZERO for x in got])
            row["samples"] = med(lambda x: x["samples"])
            row["runs"] = med(lambda x: x["runs"])
            ex = {k: med(lambda x, k=k: x["extra"][k]) for k in ("client", "locks", "blocking")}
            ex["mem"] = max(x["extra"]["mem"] if x else 0 for x in got)
            types = {t for x in got if x for t in x["extra"]["waits"]}
            ex["waits"] = {t: med(lambda x, t=t: x["extra"]["waits"].get(t, 0)) for t in types}
            row["extra"] = ex
            row["time"] = max(row["cost"][3] - ex["client"], 0)
            rows.append(row)
        rows.sort(key=lambda r: (-r["time"], -r["cost"][0], r["label"], r["line"]))
        return rows

    def fetch_plans(self, control):
        """Планы из кэша (без фактических значений) для верхних операторов, в конце последнего прогона."""
        self.stmt_rows = self.statement_rows()
        for row in self.stmt_rows[:PROFILE_PLAN_TOP]:
            if not row.get("plan_handle"):
                continue
            end = row["end"] if row["end"] is not None else -1
            try:
                rows = control.query(PLAN_SQL, row["plan_handle"], row["start"], end)
                row["plan"] = rows[0][0] if rows and rows[0][0] else None
            except Exception as e:
                log(f"План не получен ({row['label']}, строка {row['line']}): {err_text(e)}")

    def write_registry(self):
        """Папка реестра: registry.txt (шапка), registry.csv (операторы), log.csv (журнал отрезков выполнения),
        "NNN - T.sql" (текст оператора), "NNN - T.sqlplan" (план). Путь для отчета."""
        profs = [p.prof for p in self.measured() if p.prof is not None]
        if not profs:
            return None
        rows = self.stmt_rows if self.stmt_rows is not None else self.statement_rows()
        folder = unique_path(self.data_dir / f"{self.run_id()}_profile")
        folder.mkdir(parents=True)
        total = self.median_cost(lambda p: p.total)
        sampled = sum(r["time"] for r in rows)
        base = run_time(total) if total else sampled
        lines = ["# Реестр операторов",
                 f"SQL-файл: {self.sql_path.name}",
                 f"Интервал выборки: {PROFILE_INTERVAL_MS} мс"]
        if len(self.passes) > 1:
            lines.append("Значения: " + self.median_note())
        samples = round(statistics.median([x["samples"] for x in profs]))
        func = round(statistics.median([x["func"] for x in profs]))
        lines.append(f"Выборок: {samples}, из них внутри функций: {func} (отнесены к вызывающим операторам)")
        lines.append(f"Время по выборкам: {sampled} мс"
                     + (f" из {run_time(total)} мс по счетчикам сессии" if total else ""))
        lines.append("Время: без ожидания клиента (ASYNC_NETWORK_IO: передача результатов и работа скрипта)")
        for e in sorted({x["error"] for x in profs if x["error"]}):
            lines.append(f"Ошибка профилирования: {e}")
        note = f" (сумма по прогонам {self.measured()[0].k}-{self.measured()[-1].k})" if len(profs) > 1 else ""
        lines += sampling_lines(sum(x["slow"] for x in profs), sum(x["slow_ms"] for x in profs),
                                [x["lookup_error"] for x in profs if x["lookup_error"]], note)
        lines.append(f"Таблица операторов: {REGISTRY_TABLE}, журнал выполнения: {REGISTRY_LOG}")
        files = registry_files(rows, base)
        files[REGISTRY_FILE] = (REGISTRY_FILE, "\n".join(lines) + "\n")
        RegistryFolder(folder).sync(files)
        LogWriter(folder / REGISTRY_LOG).add_many([seg for p in self.measured() for seg in p.segments])
        log(f"Реестр операторов: {folder / 'registry.txt'}")
        return f"{self.data_dir.name}/{folder.name}/registry.txt"

    def write_journal(self):
        """Журнал хода запуска (Journal) файлом в подпапке данных. Путь для отчета или None."""
        if not Journal.entries:
            return None
        try:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            path = unique_path(self.data_dir / f"{self.run_id()}_message.txt")
            with open(path, "w", encoding=FILE_ENCODING, newline="\n") as f:
                f.write(Journal.text(Journal.entries))
        except OSError as e:
            log(f"Журнал не записан: {err_text(e)}")
            return None
        return f"{self.data_dir.name}/{path.name}"

    # ---------------------------------------------------- отчет

    def report(self, t_run, registry, journal=None):
        """Текст отчета: (для файла, для консоли). В консоль не идет раздел "Производительность"
        (вызовы драйвера и все сообщения сервера в сыром виде - их бывает очень много)."""
        last = self.passes[-1]
        s = last.server
        started = ServerTime.at(self.t_start)
        lines = [
            "# Запуск",
            f"Формат отчета: {REPORT_FORMAT_VERSION}",
            f"SQL-файл: {self.sql_path.name}, sha1 {self.sha1}",
            f"Сервер/база: {s.get('server', '?')} / {s.get('database', '?')}",
            f"Версия СУБД: {s.get('dbms', '?')} {s.get('version', '')}".rstrip(),
            f"Дата выполнения: {started:%Y-%m-%d %H:%M:%S}",
            f"Режим: {'rollback' if self.rollback else 'autocommit'}",
        ]
        if abs((started - self.started).total_seconds()) > 60:
            lines.insert(6, f"Часы компьютера: {self.started:%Y-%m-%d %H:%M:%S} (время в отчете и именах "
                            f"файлов - по часам сервера)")
        if self.repeat > 1:
            lines.append(f"Прогонов: {self.repeat}")
        ignored = [str(k) for k, (_, b) in enumerate(self.batches, 1) if is_ignored_batch(b)]
        if ignored:
            lines.append("Игнорируемые батчи (--ignore in test): " + ", ".join(ignored))
        if registry:
            lines.append(f"Реестр: {registry}")
        if journal:
            lines.append(f"Журнал: {journal}")
        if last.aborted:
            where = f"прогон {last.k}: " if self.repeat > 1 else ""
            lines.append(f"ЗАПУСК ПРЕРВАН: {where}{last.aborted}")
        if not last.results:
            lines.append("таблиц нет")
        total_ns = perf() - t_run
        lines.append("")
        lines.extend(self.summary_block(total_ns))
        for n in sorted(last.results):
            cost = self.median_cost(lambda p, n=n: p.table_cost.get(n))
            lines.append("")
            lines.extend(table_block(n, last.results[n], cost, last.client_ok))
        tail = []
        if self.repeat == 2 and len(self.passes) == 2 and not last.aborted:
            tail = [""] + self.ignore_suggestion()
        full = lines + [""] + self.perf_block(last, total_ns) + tail
        return "\n".join(full) + "\n", "\n".join(lines + tail) + "\n"

    def ignore_suggestion(self):
        """--repeat 2: элемент ignored_columns из колонок, хэш которых различается между прогонами."""
        r1, r2 = self.passes[0].results, self.passes[1].results
        tables, notes = {}, []
        for n in sorted(set(r1) | set(r2)):
            a, b = r1.get(n), r2.get(n)
            if not isinstance(a, dict) or not isinstance(b, dict):
                notes.append(f"Таблица {n}: нет данных одного из прогонов")
            elif a["rows"] != b["rows"]:
                notes.append(f"Таблица {n}: число строк различается ({a['rows']} и {b['rows']}), "
                             f"игнорирование колонок не поможет")
            else:
                diff = [x for x, h in b["col_hashes"].items() if a["col_hashes"].get(x) != h]
                if diff:
                    tables[str(n)] = diff
        lines = ["# Предложение для настроек",
                 "Колонки, хэш которых различается между прогонами 1 и 2 (текущие настройки не учитываются)."]
        if tables:
            entry = {"mask": fnmatch_escape(self.sql_path.stem), "tables": tables}
            lines += [f"Элемент для ignored_columns в {SETTINGS_PATH.name}:",
                      json.dumps(entry, ensure_ascii=False)]
        else:
            lines.append("Различающихся колонок нет.")
        return lines + notes

    def summary_block(self, total_ns):
        last = self.passes[-1]
        lines = ["# Сводка"]
        total = self.median_cost(lambda p: p.total)
        if total:
            lines.append(f"Время: {run_time(total)} мс")
            if last.client_ok:
                lines.append(f"Ожидание клиента: {total[5]} мс (передача результатов и работа скрипта, "
                             f"во время не входит)")
            else:
                lines.append("Ожидание клиента: нет данных (нет sys.dm_exec_session_wait_stats, "
                             "SQL Server до 2016), время его включает")
            lines += [f"CPU: {total[0]} мс", f"Логических чтений: {total[1]}",
                      f"Физических чтений: {total[2]}", f"Записей: {total[3]}"]
        else:
            reason = next((p.counters_error for p in self.passes if p.counters_error), None)
            lines.append("Счетчики сервера: нет данных" + (f" ({reason})" if reason else ""))
        if len(self.passes) > 1:
            if total:
                lines.append("Счетчики: " + self.median_note())
                times = [str(run_time(p.total)) if p.total and not p.counters_error else "?" for p in self.passes]
                lines.append(f"Время по прогонам: {', '.join(times)} мс")
            nd = [] if last.aborted else self.nondeterministic()
            if nd:
                lines.append("Недетерминированные таблицы: " + ", ".join(map(str, nd)))
        lines.append(f"Общее время запуска: {ms(total_ns)} мс")
        lines.append(f"Всего строк: {sum(last.table_rows.values())}")
        if last.table_rows:
            lines.append("Строк по таблицам:")
            lines += [f"  таблица {n}: {rows}" for n, rows in sorted(last.table_rows.items())]
        return lines

    def perf_block(self, last, total_ns):
        lines = ["# Производительность"]
        if self.repeat > 1:
            lines.append(f"Прогон: {last.k}")
        lines += [
            f"Общее время запуска: {ms(total_ns)} мс",
            f"Время SQL всего: {ms(last.sql_ns)} мс",
            f"Подключение: {ms(last.connect_ns)} мс",
        ]
        lines.extend(last.perf_lines)
        done = [(n, r) for n, r in sorted(last.results.items()) if isinstance(r, dict) and "klen" in r]
        if done:
            lines.append("Обработка скриптом:")
            for n, r in done:
                t = r["times"]
                lines.append(f"  таблица {n}: нормализация и хэши {ms(t['normalize'])} мс, "
                             f"ключ {ms(t['key'])} мс, сортировка {ms(t['sort'])} мс, "
                             f"запись {ms(t['write'])} мс")
        if not last.messages:
            lines.append("Сообщения сервера: нет")
        else:
            lines.append("Сообщения сервера:")
            prev = None
            for label, text in last.messages:
                if label != prev:
                    lines.append(f"  [{label}]")
                    prev = label
                for line in text.splitlines() or [""]:
                    lines.append("    " + line)
        return lines


def server_info(conn, pyodbc):
    info = {}
    for key, attr in (("server", "SQL_SERVER_NAME"), ("database", "SQL_DATABASE_NAME"),
                      ("dbms", "SQL_DBMS_NAME"), ("version", "SQL_DBMS_VER")):
        try:
            info[key] = conn.getinfo(getattr(pyodbc, attr))
        except Exception:
            pass
    return info


def table_block(n, res, cost, client_ok):
    if isinstance(res, BaseException):
        return [f"# Таблица {n}", f"ОШИБКА ОБРАБОТКИ: {one_line(res)}"]
    lines = [f"# Таблица {n}"]
    if "file" in res:
        lines.append(f"Файл: {res['file']}")
    lines.append(f"Количество строк: {res['rows']}")
    if cost:
        lines.append(f"Затраты до таблицы: {cost_text(cost, client_ok)}")
    lines.append(f"Хэш таблицы: {res['table_hash']}")
    if "file" not in res:      # прерванный промежуточный прогон: данные не сохранялись
        return lines
    lines.append("Хэш колонок: " + json.dumps(res["col_hashes"], ensure_ascii=False))
    if res["ignored"]:
        lines.append("Игнорируемые колонки: " + json.dumps(res["ignored"], ensure_ascii=False))
    lines += [
        res["create"],
        "Ключ определен как: (" + ", ".join(res["P"][:res["klen"]]) + ")",
        "Порядок ключа: " + json.dumps({"len": res["klen"], "cols": res["P"]}, ensure_ascii=False),
    ]
    return lines


# ============================================================ режим 3: наблюдение за сессией (--session)

STATUS_WIDTH = 79


def key_pressed():
    """Нажата ли клавиша (только Windows-консоль); нажатия сбрасываются."""
    if msvcrt is None:
        return False
    hit = False
    while msvcrt.kbhit():
        msvcrt.getwch()
        hit = True
    return hit


def status_text(since, label, line, text, wait):
    """Строка состояния не длиннее STATUS_WIDTH: время сервера начала, объект:строка, начало текста, ожидание."""
    head = f"{since:%H:%M:%S} "
    if label is None:
        return head + "нет запроса"
    tail = " " + " ".join(text.split())[:30] + (f" {wait}" if wait else "")
    loc, where = label, f":{line}" if line else ""
    room = STATUS_WIDTH - len(head) - len(tail) - len(where)
    if len(loc) > room:
        loc = loc[:max(room - 1, 0)] + "~"
    return (head + loc + where + tail)[:STATUS_WIDTH]


class SessionMonitor:
    """Наблюдение за сессией spid: то же, что --profile, но для чужой сессии и с записью на диск
    раз в SESSION_FLUSH_S секунд. log.csv дописывается сразу, как закончился отрезок выполнения."""

    SESSION_SQL = ("SELECT login_time, host_name, program_name, login_name "
                   "FROM sys.dm_exec_sessions WHERE session_id = ?")
    INPUT_SQL = "SELECT event_info FROM sys.dm_exec_input_buffer(?, NULL)"

    def __init__(self, control, lookup, spid, info, folder):
        self.input_mode = "dmf"   # исходный запрос: dmf, dbcc (до SQL Server 2014 SP2) или None (недоступен)
        self.input_text = None
        self.control, self.spid, self.folder = control, spid, folder
        self.status_key = None   # что показывает текущая строка состояния
        self.status_since = None # время сервера, когда оператор строки впервые попал в выборку
        self.status_shown = None # ее текст: строка пишется заново, только если текст изменился
        self.login_time = info[0]
        self.info = (f"Сессия: {spid}; логин: {info[3] or '?'}; компьютер: {info[1] or '?'}; "
                     f"программа: {info[2] or '?'}; подключена: {info[0]}")
        self.started = ServerTime.now()
        self.state = "идет наблюдение"
        self.files = RegistryFolder(folder, self.warn)
        self.log_file = LogWriter(folder / REGISTRY_LOG, self.warn)
        self.lookup = lookup
        self.sampler = Sampler(control, lookup, {}, None, "(батч)", self.log_file.add)
        self.builder = self.sampler.builder
        self.builder.since = self.started
        self.now_events = NowEvents()

    def warn(self, msg):
        self.end_status()
        log(msg)

    def end_status(self):
        """Строка состояния остается в консоли, следующая начнется с новой строки."""
        if self.status_key is not None:
            sys.stderr.write("\n")
            self.status_key = self.status_shown = None

    def alive(self):
        rows = self.control.query(self.SESSION_SQL, self.spid)
        return bool(rows) and rows[0][0] == self.login_time

    def input_buffer(self):
        """Исходный запрос сессии - последний батч, который прислал клиент (часто вызов процедуры
        с параметрами), одной строкой; None - получить не удалось. Один вызов по одной сессии, при
        каждой записи файлов. sys.dm_exec_input_buffer есть с SQL Server 2014 SP2, до него - DBCC INPUTBUFFER."""
        while self.input_mode:
            try:
                if self.input_mode == "dmf":
                    rows = self.control.query(self.INPUT_SQL, self.spid)
                else:
                    rows = [[r[2]] for r in self.control.query(f"DBCC INPUTBUFFER({int(self.spid)}) WITH NO_INFOMSGS")]
                break
            except Exception:
                self.input_mode = "dbcc" if self.input_mode == "dmf" else None
        else:
            return None
        text = " ".join((rows[0][0] or "").replace("\x00", "").split()) if rows else ""
        return text[:SESSION_INPUT_LEN] + ("..." if len(text) > SESSION_INPUT_LEN else "")

    def status(self, s):
        """Строка состояния. Пока выполняется тот же оператор того же запроса, строка обновляется
        на месте (меняется ожидание), иначе начинается новая. Время - сервера, когда оператор
        впервые попал в выборку."""
        now = self.sampler.now(s)
        if now is None:
            return      # текст оператора еще не получен: строка остается прежней
        self.now_events.update(now)
        key, label, no, text, wait = now["key"], now["label"], now["line"], now["text"], now["wait"]
        if wait and now["blocked_by"]:
            wait += f" ждет {now['blocked_by']}"
        if key != self.status_key:
            self.end_status()
            self.status_key, self.status_since = key, ServerTime.now()
        shown = status_text(self.status_since, label, no, text, wait)
        if shown != self.status_shown:      # без лишнего вывода: время на экране GUI считает сам
            self.status_shown = shown
            sys.stderr.write("\r" + shown.ljust(STATUS_WIDTH))
            sys.stderr.flush()

    def plan_key(self, r):
        return (r.get("plan_handle"), r["start"], r["end"] if r["end"] is not None else -1)

    def flush(self, fetch_plans, final=False):
        """Перезаписывает реестр; с fetch_plans заказывает недостающие планы верхних операторов
        (их получает поток Lookup, в файлы они попадут при одной из следующих записей)."""
        rows = sorted((with_time(e) for e in self.builder.stats.values()),
                      key=lambda r: (-r["time"], -r["cost"][0], r["label"], r["line"]))
        if fetch_plans:
            for r in rows[:PROFILE_PLAN_TOP]:
                k = self.plan_key(r)
                if k[0]:
                    self.lookup.want_plan(k)
        for r in rows:
            r["plan"] = self.lookup.plans.get(self.plan_key(r))
        sampled = sum(r["time"] for r in rows)
        s = self.builder.summary()
        if not final:      # финальная запись - без запросов к серверу; пусто - остается прежний
            self.input_text = self.input_buffer() or self.input_text
        lines = [f"# Реестр операторов сессии {self.spid}",
                 self.info,
                 f"Исходный запрос (последний на момент обновления): {self.input_text or 'нет данных'}",
                 f"Начало наблюдения: {self.started:%Y-%m-%d %H:%M:%S}",
                 f"Обновлено: {ServerTime.now():%Y-%m-%d %H:%M:%S}",
                 f"Состояние: {self.state}",
                 f"Интервал выборки: {PROFILE_INTERVAL_MS} мс, файлы обновляются раз в {SESSION_FLUSH_S} с",
                 f"Выборок: {s['samples']}, из них внутри функций: {s['func']} (отнесены к вызывающим операторам)",
                 f"Время по выборкам: {sampled} мс",
                 "Время: без ожидания клиента (ASYNC_NETWORK_IO: передача результатов и обработка на клиенте)"]
        lines += sampling_lines(s["slow"], s["slow_ms"], [s["lookup_error"]] if s["lookup_error"] else [])
        lines.append(f"Таблица операторов: {REGISTRY_TABLE}, журнал выполнения: {REGISTRY_LOG}")
        files = registry_files(rows, sampled)
        files[REGISTRY_FILE] = (REGISTRY_FILE, "\n".join(lines) + "\n")
        self.files.sync(files)
        self.log_file.write()    # строки, которые не удалось дописать раньше
        Events.emit("flush", folder=str(self.folder))

    def run(self):
        log(f"Наблюдение за сессией {self.spid}, реестр: {self.folder / REGISTRY_FILE}")
        Events.emit("start", mode="session", session=self.spid, folder=str(self.folder.resolve()))
        ways = ["любая клавиша" if msvcrt is not None else "Ctrl+C"]
        if Stop.stdin_enabled():
            ways.append("команда stop")
        log("Выход: " + ", ".join(ways))
        reason = error = None
        next_flush = perf() + SESSION_FLUSH_S * 10**9
        next_check = 0
        try:
            self.flush(False)
            while reason is None:
                if perf() >= next_check:
                    if not self.alive():
                        reason = "сессия завершилась"
                        break
                    next_check = perf() + 10**9
                s, delay = self.sampler.poll()
                self.status(s)
                if perf() >= next_flush:
                    self.flush(True)
                    next_flush = perf() + SESSION_FLUSH_S * 10**9
                end = perf() + delay * 10**6
                while reason is None and perf() < end:
                    if key_pressed():
                        reason = "нажата клавиша"
                    elif Stop.reason is not None:
                        reason = Stop.reason
                    else:
                        time.sleep(0.02)
        except KeyboardInterrupt:
            reason = "Ctrl+C"
        except Exception as e:
            reason = error = f"ошибка: {err_text(e)}"
        self.state = f"завершено ({reason})"
        try:
            self.sampler.finish(0)      # без ожидания сервера: что не успело - "(текст недоступен)"
            self.flush(False, final=True)
        except KeyboardInterrupt:
            pass
        self.end_status()
        log(f"Наблюдение завершено: {reason}. Реестр: {self.folder / REGISTRY_FILE}")
        Events.emit("stopped", reason=reason)
        return 2 if error else 0


def run_session(spid):
    if spid <= 0:
        raise ScriptError("--session: номер сессии должен быть положительным")
    if ensure_settings_file():
        log("Заполните настройки подключения и запустите скрипт снова.")
        return 2
    settings = read_settings()
    conn_str = build_conn_str(settings, APP_NAME + " session")
    try:
        import pyodbc
    except ImportError:
        raise ScriptError("не установлен модуль pyodbc: pip install pyodbc")
    try:
        conn = pyodbc.connect(conn_str, autocommit=True)
    except pyodbc.Error as e:
        raise ScriptError(f"ошибка подключения: {err_text(e)}")
    try:
        cur = conn.cursor()
        own = query_spid(cur)
        cur.close()
        if own == spid:
            raise ScriptError(f"сессия {spid} - это подключение самого скрипта")
        control = Control(conn, spid)
        rows = control.query(SessionMonitor.SESSION_SQL, spid)
        if not rows:
            raise ScriptError(f"сессия {spid} не найдена (или нет права VIEW SERVER STATE)")
        try:   # тексты, объекты и планы - на втором подключении, чтобы не задерживать выборки
            lookup = Lookup(pyodbc.connect(conn_str, autocommit=True))
        except pyodbc.Error as e:
            raise ScriptError(f"ошибка подключения: {err_text(e)}")
        out_dir = (Path(OUTPUT_DIR) if OUTPUT_DIR else Path.cwd()) / SESSIONS_DIR
        folder = unique_path(out_dir / f"Session_{ServerTime.now().strftime(DT_FORMAT)}_{spid}")
        folder.mkdir(parents=True)
        try:
            return SessionMonitor(control, lookup, spid, rows[0], folder).run()
        finally:
            lookup.stop()
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ============================================================ режим 2: разбор отчетов

def fields(lines):
    """Строки вида 'Ключ: значение' без отступа."""
    out = {}
    for line in lines:
        if line and not line[0].isspace() and ": " in line:
            k, v = line.split(": ", 1)
            out.setdefault(k, v)
    return out


def parse_report(path, label):
    if path.suffix.lower() == SQL_EXT:
        raise ScriptError(f"{path.name}: в режиме сравнения ожидается отчет, а не SQL-файл")
    try:
        text = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError) as e:
        raise ScriptError(f"не удалось прочитать {path}: {e}")
    sections = []
    for line in text.split("\n"):
        line = line.rstrip("\r")
        if line.startswith("# "):
            sections.append((line[2:].strip(), []))
        elif sections:
            sections[-1][1].append(line)
    if not sections or sections[0][0] != "Запуск":
        raise ScriptError(f"{path.name}: это не отчет выполнения (нет раздела «# Запуск»)")
    run = fields(sections[0][1])
    ver = run.get("Формат отчета")
    if ver is None:
        raise ScriptError(f"{path.name}: нет строки «Формат отчета»")
    if ver.strip() != str(REPORT_FORMAT_VERSION):
        raise ScriptError(f"{path.name}: неподдерживаемая версия формата отчета: {ver}")
    if "ЗАПУСК ПРЕРВАН" in run:
        raise ScriptError(f"{path.name}: запуск был прерван ({run['ЗАПУСК ПРЕРВАН']}), "
                          f"такие отчеты не сравниваются")
    tables, total = {}, None
    for title, lines in sections[1:]:
        m = re.fullmatch(r"Таблица (\d+)", title)
        if m:
            n = int(m.group(1))
            tables[n] = parse_table(path, n, lines)
        elif title == "Сводка":
            f = fields(lines)
            cpu, reads = int_value(f.get("CPU")), int_value(f.get("Логических чтений"))
            if cpu is not None and reads is not None:
                total = (int_value(f.get("Время")), cpu, reads)
    return {"path": path, "dir": path.resolve().parent, "label": label, "run": run,
            "tables": tables, "total": total}


def int_value(s):
    m = re.match(r"\s*(\d+)", s or "")
    return int(m.group(1)) if m else None


COST_RE = re.compile(r"(?:время (\d+) мс, ожидание клиента [^,]+, )?CPU (\d+) мс, логических чтений (\d+)")


def parse_cost(s):
    """(время или None в старых отчетах, CPU, логические чтения) или None."""
    m = COST_RE.match(s or "")
    if not m:
        return None
    return (int(m.group(1)) if m.group(1) else None, int(m.group(2)), int(m.group(3)))


def parse_table(path, n, lines):
    create = next((line for line in lines if line.lower().startswith("create table")), None)
    f = fields(lines)
    where = f"{path.name}, таблица {n}"
    try:
        col_hashes = json.loads(f["Хэш колонок"])
        key = json.loads(f["Порядок ключа"])
        ignored = json.loads(f.get("Игнорируемые колонки", "[]"))
        t = {"file": f["Файл"], "rows": int(f["Количество строк"]), "table_hash": f["Хэш таблицы"],
             "col_hashes": dict(col_hashes), "names": list(col_hashes),
             "klen": int(key["len"]), "P": [str(x) for x in key["cols"]],
             "cost": parse_cost(f.get("Затраты до таблицы")),
             "ignored": {str(x).lower() for x in ignored}}
    except (KeyError, ValueError, TypeError) as e:
        raise ScriptError(f"{where}: раздел отчета поврежден ({e})")
    if not t["names"] or not 1 <= t["klen"] <= len(t["P"]):
        raise ScriptError(f"{where}: раздел отчета поврежден (колонки или ключ)")
    t["warnings"] = []
    types = parse_create(create)
    if types is None:
        t["types"] = None
        t["warnings"].append("не удалось разобрать create table, типы не сравниваются")
    else:
        t["types"] = {x.lower(): types.get(escape(x).lower()) for x in t["names"]}
        missing = [x for x in t["names"] if t["types"][x.lower()] is None]
        if missing:
            t["warnings"].append("в create table нет типов колонок: " + ", ".join(missing))
    return t


CREATE_COL_RE = re.compile(
    r"\[((?:[^\]]|\]\])*)\]\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*\([^)]*\))?)(\s+NOT\s+NULL|\s+NULL)?", re.I)


def parse_create(line):
    """Толерантный разбор create table: {имя в нижнем регистре: 'тип NULL'} или None."""
    if not line:
        return None
    m = re.match(r"\s*create\s+table\s+\S+?\s*\((.*)\)\s*$", line, re.I)
    if not m:
        return None
    types = {}
    for name, typ, null in CREATE_COL_RE.findall(m.group(1)):
        types[name.replace("]]", "]").lower()] = re.sub(r"\s+", " ", (typ + null).strip()).lower()
    return types or None


TYPE_FAMILY = {}
for _family, _types in (("число", "bit tinyint smallint int bigint decimal numeric float real money smallmoney"),
                        ("строка", "char varchar nchar nvarchar text ntext"),
                        ("дата", "date time datetime datetime2 smalldatetime datetimeoffset"),
                        ("байты", "binary varbinary image")):
    for _t in _types.split():
        TYPE_FAMILY[_t] = _family


def type_base(t):
    m = re.match(r"[a-z0-9_]+", t or "")
    return m.group(0) if m else ""


def type_family(t):
    base = type_base(t)
    return TYPE_FAMILY.get(base, base)


# ============================================================ режим 2: потоковое сравнение

def disp(c):
    if c == NUL:
        return "<NULL>"
    return '""' if c == "" else c


def open_data(r, t):
    """Открывает файл данных и проверяет заголовок. Возвращает (файл, None) или (None, сообщение)."""
    p = r["dir"] / t["file"]
    if not p.is_file():
        return None, f"Файл данных {r['label']} не найден: {p.name}"
    f = open(p, encoding=FILE_ENCODING)   # \r\n тоже принимается: сырых \r в файле данных нет
    header = f.readline()
    if header.endswith("\n"):
        header = header[:-1]
    expected = DELIM.join(format_cell(escape(x)) for x in t["names"])
    if header != expected:
        f.close()
        return None, f"Заголовок файла данных {p.name} не совпадает с колонками из отчета {r['label']}"
    return f, None


def iter_side(f, fname, ncols, own_key, expected_rows):
    """Строки файла: (канонические тексты, свернутые тексты + #dup). Проверяет порядок ключа."""
    prev_key = prev_fold = None
    dup = count = 0
    for lineno, line in enumerate(f, 2):
        if line.endswith("\n"):
            line = line[:-1]
        try:
            cells = parse_line(line)
        except ValueError as e:
            raise DataError(f"{fname}, строка {lineno}: {e}")
        if len(cells) != ncols:
            raise DataError(f"{fname}, строка {lineno}: колонок {len(cells)} вместо {ncols}")
        fold = tuple(c.casefold() for c in cells)
        dup = dup + 1 if fold == prev_fold else 0
        prev_fold = fold
        full = fold + (dup,)
        key = tuple(full[i] for i in own_key)
        if prev_key is not None and key <= prev_key:
            raise DataError(f"{fname}, строка {lineno}: файл изменен или не отсортирован")
        prev_key = key
        count += 1
        yield cells, full
    if count != expected_rows:
        raise DataError(f"{fname}: строк в файле {count}, в отчете {expected_rows}: файл изменен")


def iter_groups(rows, kidx):
    key, grp = None, []
    for row in rows:
        k = tuple(row[1][i] for i in kidx)
        if grp and k != key:
            yield key, grp
            grp = []
        key = k
        grp.append(row)
    if grp:
        yield key, grp


def key_indices(p_names, k, names):
    idx = {x.lower(): i for i, x in enumerate(names)}
    out = []
    for pos, x in enumerate(p_names[:k]):
        if x == DUP_COL and pos == len(names):
            out.append(len(names))
        elif x.lower() in idx:
            out.append(idx[x.lower()])
        else:
            raise DataError(f"порядок ключа содержит неизвестную колонку: {x}")
    return out


def float_close(a, b):
    if a == NUL or b == NUL:
        return False
    try:
        return abs(decimal.Decimal(a) - decimal.Decimal(b)) <= decimal.Decimal(str(FLOAT_TOLERANCE))
    except decimal.InvalidOperation:
        return False


def key_core(key, ncols, ign_idx):
    """Колонки ключа без игнорируемых и #dup."""
    return [i for i in key if i < ncols and i not in ign_idx]


def common_key(key_a, key_b, rows_a, rows_b, ncols, ign_idx):
    """Ключ сопоставления при разных ключах A и B: ключ A или B, если он уникален в обоих запусках,
    иначе их объединение. Без игнорируемых колонок и #dup."""
    def unique(key, rows):
        return len({tuple(r[1][i] for i in key) for r in rows}) == len(rows)

    for key in (key_core(key_a, ncols, ign_idx), key_core(key_b, ncols, ign_idx)):
        if key and unique(key, rows_a) and unique(key, rows_b):
            return key
    return key_core(key_a + [i for i in key_b if i not in key_a], ncols, ign_idx)


class Merger:
    """Merge-join двух отсортированных последовательностей строк.

    m задан (ключи совместимы, файлы читаются потоком): группы строятся по общему префиксу ключа P[:m]
    без игнорируемых колонок и #dup. Они стоят в конце ключа, поэтому остаток тоже префикс.
    Внутри группы строки сопоставляются по неигнорируемым колонкам более длинного ключа.
    m = None (ключи различаются): группы и сопоставление по ключу common (см. common_key), строки
    обеих сторон заранее отсортированы по нему в памяти.
    Игнорируемые колонки не сравниваются.
    """

    def __init__(self, names, key_a, key_b, m, common, float_idx, ign_idx):
        self.names = names
        self.ncols = len(names)
        if m is None:
            self.key_m = self.key_match = common
            self.long = None
        else:
            self.key_m = key_core(key_a[:m], self.ncols, ign_idx)
            self.long = "A" if len(key_a) > len(key_b) else "B" if len(key_b) > len(key_a) else None
            self.key_match = key_core(key_b if self.long == "B" else key_a, self.ncols, ign_idx)
        in_key = set(self.key_m)
        self.cmp_cols = [j for j in range(self.ncols) if j not in in_key and j not in ign_idx]
        self.float_idx = float_idx
        self.matched = self.diff_rows = 0
        self.col_diffs = [0] * self.ncols
        self.only = {"A": 0, "B": 0}
        self.dup_groups = {"A": 0, "B": 0}
        self.dup_rows = {"A": 0, "B": 0}
        self.ex_diff = None
        self.ex_only = {"A": None, "B": None}
        # примеры для GUI в порядке ключа, не больше EXAMPLE_ROWS каждого вида:
        # {"kind": "diff", "a": ячейки, "b": ячейки, "cols": индексы отличий} или {"kind": "A"/"B", "row": ячейки}
        self.examples = []
        self.ex_count = {"diff": 0, "A": 0, "B": 0}

    def run(self, rows_a, rows_b):
        it_a, it_b = iter_groups(rows_a, self.key_m), iter_groups(rows_b, self.key_m)
        ga, gb = next(it_a, None), next(it_b, None)
        while ga is not None or gb is not None:
            if gb is None or (ga is not None and ga[0] < gb[0]):
                self.group_one_side("A", ga[1])
                ga = next(it_a, None)
            elif ga is None or gb[0] < ga[0]:
                self.group_one_side("B", gb[1])
                gb = next(it_b, None)
            else:
                self.match(ga[1], gb[1])
                ga, gb = next(it_a, None), next(it_b, None)

    def group_one_side(self, side, rows):
        self.note_dups(side, len(rows))
        self.unmatched(side, rows)

    def note_dups(self, side, size):
        if side == self.long and size > 1:
            self.dup_groups[side] += 1
            self.dup_rows[side] += size - 1

    def match(self, rows_a, rows_b):
        if len(rows_a) == 1 and len(rows_b) == 1:
            self.pair(rows_a[0], rows_b[0])
            return
        if self.long is not None:
            self.note_dups(self.long, len(rows_a if self.long == "A" else rows_b))
        # Пары по неигнорируемым колонкам длинного ключа, в порядке файлов.
        free = {}
        for r in rows_b:
            free.setdefault(tuple(r[1][i] for i in self.key_match), collections.deque()).append(r)
        left_a = []
        for r in rows_a:
            q = free.get(tuple(r[1][i] for i in self.key_match))
            if q:
                self.pair(r, q.popleft())
            else:
                left_a.append(r)
        self.unmatched("A", left_a)
        self.unmatched("B", [r for q in free.values() for r in q])

    def pair(self, ra, rb):
        self.matched += 1
        fa, fb = ra[1], rb[1]
        diffs = [j for j in self.cmp_cols
                 if fa[j] != fb[j] and not (j in self.float_idx and float_close(fa[j], fb[j]))]
        if not diffs:
            return
        self.diff_rows += 1
        for j in diffs:
            self.col_diffs[j] += 1
        if self.ex_count["diff"] < EXAMPLE_ROWS:
            self.ex_count["diff"] += 1
            self.examples.append({"kind": "diff", "a": list(ra[0]), "b": list(rb[0]), "cols": diffs})
        if self.ex_diff is None:
            changes = ", ".join(f"{self.names[j]}: {disp(ra[0][j])} -> {disp(rb[0][j])}" for j in diffs)
            self.ex_diff = (self.key_text(ra), changes)

    def unmatched(self, side, rows):
        if not rows:
            return
        self.only[side] += len(rows)
        for r in rows[:EXAMPLE_ROWS - self.ex_count[side]]:
            self.examples.append({"kind": side, "row": list(r[0])})
        self.ex_count[side] = min(EXAMPLE_ROWS, self.ex_count[side] + len(rows))
        if self.ex_only[side] is None:
            r = rows[0]
            self.ex_only[side] = (self.key_text(r),
                                  ", ".join(f"{name}={disp(c)}" for name, c in zip(self.names, r[0])))

    def key_text(self, row):
        return ", ".join(f"{self.names[i]}={disp(row[0][i])}" if i < self.ncols else f"{DUP_COL}={row[1][i]}"
                         for i in self.key_m)

    def lines(self, hash_diff):
        """Строки отчета парами (полный, сокращенный или None)."""
        out = []
        for side in ("A", "B"):
            tail = f"{side}: {self.only[side]}"
            if self.dup_rows[side]:
                tail += (f" (из них лишние дубликаты по короткому ключу: {self.dup_rows[side]}, "
                         f"групп: {self.dup_groups[side]})")
            out.append((f"Только в {tail}", f"Строк только в {tail}" if self.only[side] else None))
        tail = f"{self.matched}, из них отличаются в неключевых колонках: {self.diff_rows}"
        out.append((f"Сопоставлено: {tail}", f"Сопоставлено строк: {tail}" if self.matched else None))
        if self.matched:
            cols = [f"{self.names[j]} ({c} строк)" for j, c in enumerate(self.col_diffs) if c]
            out.append(both("Отличающиеся колонки: " + (", ".join(cols) or "нет")))
        else:
            out.append(both("Отличающиеся колонки (по хэшам): " + (", ".join(hash_diff) or "нет")))
        if self.ex_diff:
            out.append(both(f"Пример отличия (ключ: {self.ex_diff[0]}): {self.ex_diff[1]}"))
        for side in ("A", "B"):
            if self.ex_only[side]:
                out.append(both(f"Пример только в {side} (ключ: {self.ex_only[side][0]}): "
                                f"{self.ex_only[side][1]}"))
        return out

    def differs(self):
        return bool(self.only["A"] or self.only["B"] or self.diff_rows)


def compare_rows(ra, rb, ta, tb, m, float_cols, ignored, hash_diff, hashes_equal):
    """Сравнение строк: потоком или, если m = None, в памяти.
    Возвращает (строки отчета парами, отличается, ошибка, примеры строк - см. Merger.examples)."""
    fa = fb = None
    try:
        fa, err_a = open_data(ra, ta)
        fb, err_b = open_data(rb, tb)
        errs = [e for e in (err_a, err_b) if e]
        if errs:
            lines = [both(e) for e in errs] + [both("Строки не сравнивались, результат по хэшам")]
            if hash_diff:
                lines.append(both("Колонки с различающимися хэшами: " + ", ".join(hash_diff)))
            return lines, not hashes_equal, False, []
        names = ta["names"]
        float_idx = {j for j, x in enumerate(names) if x.lower() in float_cols}
        ign_idx = {j for j, x in enumerate(names) if x.lower() in ignored}
        key_a = key_indices(ta["P"], ta["klen"], names)
        key_b = key_indices(tb["P"], tb["klen"], names)
        side_a = iter_side(fa, ta["file"], len(names), key_a, ta["rows"])
        side_b = iter_side(fb, tb["file"], len(names), key_b, tb["rows"])
        lines, common = [], None
        if m is None:   # ключи различаются: обе таблицы целиком в память, сортировка по общему ключу
            side_a, side_b = list(side_a), list(side_b)
            common = common_key(key_a, key_b, side_a, side_b, len(names), ign_idx)
            side_a.sort(key=lambda r: tuple(r[1][i] for i in common))
            side_b.sort(key=lambda r: tuple(r[1][i] for i in common))
            lines.append(both("Сопоставление в памяти по (" + ", ".join(names[i] for i in common) + ")"))
        mg = Merger(names, key_a, key_b, m, common, float_idx, ign_idx)
        mg.run(side_a, side_b)
        return lines + mg.lines(hash_diff), mg.differs(), False, mg.examples
    except (DataError, OSError, UnicodeDecodeError) as e:
        return [both(f"ОШИБКА: {one_line(e)}")], True, True, []
    finally:
        for f in (fa, fb):
            if f is not None:
                f.close()


def both(s):
    """Строка, одинаковая в полном и сокращенном отчете сравнения."""
    return s, s


def pct_text(a, b):
    """Изменение B относительно A в процентах."""
    if a == b:
        return "0%"
    if a == 0:
        return "было 0"
    return f"{100 * (b - a) / a:+.0f}%"


def cost_line(label, a, b):
    """Затраты (время, CPU, логические чтения) двух запусков в одну строку или None, если их нет ни в одном."""
    if a is None and b is None:
        return None
    if a is None or b is None:
        return f"{label}: нет данных в {'A' if a is None else 'B'}"
    if a[0] is None or b[0] is None:
        t = f"время нет данных в {'A' if a[0] is None else 'B'}"
    else:
        t = f"время A={a[0]} B={b[0]} мс ({pct_text(a[0], b[0])})"
    return (f"{label}: {t}, CPU A={a[1]} B={b[1]} мс ({pct_text(a[1], b[1])}), "
            f"чтений A={a[2]} B={b[2]} ({pct_text(a[2], b[2])})")


def compare_table(n, ra, rb):
    """Сравнение одной таблицы. Возвращает (строки отчета парами, отличается, ошибка, примеры строк -
    см. Merger.examples; пусто, если строки не сравнивались)."""
    ta, tb = ra["tables"][n], rb["tables"][n]
    body, error, examples = [], False, []
    na, nb = ta["names"], tb["names"]
    la, lb = [x.lower() for x in na], [x.lower() for x in nb]
    struct_ok = la == lb
    differs = ta["rows"] != tb["rows"]
    body.append(both(f"Строк: A={ta['rows']}, B={tb['rows']}"))
    cost = cost_line("Затраты до таблицы", ta["cost"], tb["cost"])
    if cost:
        body.append(both(cost))
    ignored = ta["ignored"] | tb["ignored"]
    if ignored:
        shown = [x for x in na if x.lower() in ignored] + sorted(ignored - set(la))
        line = "Игнорируемые колонки: " + ", ".join(shown)
        if ta["ignored"] != tb["ignored"]:
            line += " (настройки A и B различаются)"
        body.append(both(line))

    # 1. Структура
    if not struct_ok:
        differs = True
        body.append(both(f"Структура различается (колонок A={len(na)}, B={len(nb)}), строки не сравниваются"))
        only_a = [x for x, low in zip(na, la) if low not in lb]
        only_b = [x for x, low in zip(nb, lb) if low not in la]
        moved = [f"{x} (A: {i + 1}, B: {lb.index(low) + 1})"
                 for i, (x, low) in enumerate(zip(na, la)) if low in lb and lb.index(low) != i]
        if only_a:
            body.append(both("Колонки только в A: " + ", ".join(only_a)))
        if only_b:
            body.append(both("Колонки только в B: " + ", ".join(only_b)))
        if moved:
            body.append(both("Колонки на разных позициях: " + ", ".join(moved)))
    for side, t in (("A", ta), ("B", tb)):
        for w in t["warnings"]:
            body.append(both(f"Предупреждение ({side}): {w}"))
    float_cols = set()
    for t in (ta["types"], tb["types"]):
        if t:
            float_cols |= {low for low, ty in t.items() if type_base(ty) in ("float", "real")}
    if ta["types"] is not None and tb["types"] is not None:
        for x, low in zip(na, la):
            a, b = ta["types"].get(low), tb["types"].get(low)
            if low not in lb or not a or not b or a == b:
                continue
            if type_family(a) == type_family(b):
                body.append((f"Предупреждение: тип колонки {x} различается в пределах семейства: A={a}, B={b}",
                             None))
            else:
                differs = True
                body.append(both(f"Тип колонки {x} различается: A={a}, B={b}"))

    # Хэши
    cha = {k.lower(): v for k, v in ta["col_hashes"].items()}
    chb = {k.lower(): v for k, v in tb["col_hashes"].items()}
    hash_diff = [x for x, low in zip(na, la) if low in chb and cha[low] != chb[low] and low not in ignored]
    # Хэш таблицы считается без игнорируемых колонок, поэтому сравним только при одинаковых настройках.
    hashes_equal = (struct_ok and ta["rows"] == tb["rows"] and not hash_diff
                    and ta["ignored"] == tb["ignored"] and ta["table_hash"] == tb["table_hash"])

    # 2. Совместимость ключей
    ka, kb = ta["klen"], tb["klen"]
    m = min(ka, kb)
    # Потоком можно, если у ключей общее начало P[:m] и игнорируемые колонки и #dup в нем только в конце.
    tail = [x == DUP_COL or x.lower() in ignored for x in ta["P"][:m]]
    stream = [x.lower() for x in ta["P"][:m]] == [x.lower() for x in tb["P"][:m]] and tail == sorted(tail)
    keys = f"Ключ: A=({', '.join(ta['P'][:ka])}), B=({', '.join(tb['P'][:kb])})"
    if not struct_ok:
        body.append((keys, None))
    elif stream:
        short = f"Ключ: {', '.join(ta['P'][:m])}" if ka == kb else keys
        body.append((keys + f"; сравнение по ({', '.join(ta['P'][:m])})", short))
    else:
        body.append(both(keys + "; ключи различаются, таблицы сравниваются в памяти"))
        m = None

    # 3. Быстрый путь, 4. потоковое сравнение
    if not struct_ok:
        if hash_diff:
            body.append(both("Хэши различаются у общих колонок: " + ", ".join(hash_diff)))
    elif hashes_equal and not (FLOAT_TOLERANCE > 0 and float_cols):
        body.append(("Хэши таблицы и колонок совпадают, данные не читались", None))
    else:
        lines, d, error, examples = compare_rows(ra, rb, ta, tb, m, float_cols, ignored, hash_diff, hashes_equal)
        body.extend(lines)
        differs = differs or d
    return body, differs, error, examples


# ============================================================ режим 2: реестры операторов

def read_registry(r):
    """Строки реестра операторов отчета r: (список или None, сообщение об ошибке или None)."""
    rel = r["run"].get("Реестр")
    if not rel:
        return None, None
    path = r["dir"] / rel
    table = path.with_name(REGISTRY_TABLE)   # таблица отдельно; в старых реестрах она внутри registry.txt
    try:
        lines = (table if table.is_file() else path).read_text(encoding="utf-8-sig").split("\n")
    except (OSError, UnicodeDecodeError):
        return None, f"Реестр {r['label']} не найден: {rel}"
    try:
        i = next(k for k, line in enumerate(lines) if line.startswith("№" + DELIM))
        header = parse_line(lines[i])
        rows = []
        for line in lines[i + 1:]:
            if line.strip():
                d = dict(zip(header, parse_line(line)))
                rows.append({"label": d["Объект"], "line": int(d["Строка"]), "hash": d["Хэш"],
                             "time": int(d["Время мс"]), "cpu": int(d["CPU мс"]),
                             "reads": int(d["Логических чтений"]), "head": d.get("Начало текста") or "",
                             "runs": int(d.get("Запусков") or 0), "row": d})
    except (StopIteration, KeyError, ValueError):
        return None, f"Реестр {r['label']} поврежден: {rel}"
    return rows, None


STMT_PREFIX_LEN = 20       # режим 2: начало текста, по которому различаются измененные операторы одного промежутка
OBJECT_MAP_MIN = 3         # режим 2: объект A считается переименованным в объект B, если у них столько одинаковых операторов


def object_map(rows_a, rows_b):
    """Переименованные объекты: {объект A (нижний регистр): (объект A, объект B, число одинаковых операторов)}.

    Копию процедуры (PrintNewPD -> PrintNewPDTest) или скрипта под другим именем узнают по операторам:
    хэш текста, который встречается ровно один раз в A и один раз в B, - один и тот же оператор.
    Объект A сопоставляется с объектом B с другим именем, если у них не меньше OBJECT_MAP_MIN таких
    операторов и это больше половины однозначных операторов объекта A - случайное совпадение одного
    короткого оператора в чужом объекте ничего не переименует."""
    ca = collections.Counter(r["hash"] for r in rows_a)
    cb = collections.Counter(r["hash"] for r in rows_b)
    b_of = {r["hash"]: r["label"] for r in rows_b if cb[r["hash"]] == 1}
    votes, total = collections.defaultdict(collections.Counter), collections.Counter()
    for r in rows_a:
        if ca[r["hash"]] == 1 and r["hash"] in b_of:
            total[r["label"].lower()] += 1
            votes[r["label"].lower()][b_of[r["hash"]]] += 1
    names = {r["label"].lower(): r["label"] for r in rows_a}
    out = {}
    for obj, v in votes.items():
        target, n = v.most_common(1)[0]
        if target.lower() != obj and n >= OBJECT_MAP_MIN and n * 2 > total[obj]:
            out[obj] = (names[obj], target, n)
    return out


def statement_pairs(rows_a, rows_b):
    """Пары операторов двух реестров: [(строка A или None, строка B или None, пометка)].

    0. Переименованные объекты (object_map) считаются одним объектом.
    1. Один и тот же оператор - тот же объект и хэш текста (одинаковые - по порядку строк); место в
       объекте не важно: переставленные неизмененные операторы тоже находятся.
    2. Измененный текст ищется только в своем промежутке: совпавшие по хэшу операторы объекта - опорные
       точки (те, что идут в одном порядке в A и B), и оператор между двумя соседними опорными в A
       сопоставляется с оператором между теми же опорными в B. Сдвиг строк (вставили строки выше)
       не мешает, а оператор не может "перепрыгнуть" через неизмененный. В промежутке по очереди:
       по началу текста (STMT_PREFIX_LEN символов без учета пробелов и регистра), если оно
       однозначно, затем оставшиеся на одной строке. "По порядку" не сопоставляется: на реальных
       реестрах это склеивало разные операторы (быстрые попадают в реестр не в каждом запуске).
    В реестр попадают только операторы, которые застала выборка, поэтому быстрые операторы бывают
    только в одном запуске и "поровну" выполняется не всегда."""
    renamed = object_map(rows_a, rows_b)

    def obj(r, side):
        o = r["label"].lower()
        return renamed[o][1].lower() if side == 0 and o in renamed else o

    def by_line(r):
        return r["line"]

    def keyed(rows, side):
        seen, out = collections.Counter(), {}
        for r in sorted(rows, key=by_line):
            k = (obj(r, side), r["hash"])
            out[k + (seen[k],)] = r
            seen[k] += 1
        return out

    def prefix(r):
        return " ".join(r["head"].split()).casefold()[:STMT_PREFIX_LEN]

    ka, kb = keyed(rows_a, 0), keyed(rows_b, 1)
    exact = [(ka[k], kb[k], "") for k in ka if k in kb]
    pairs = list(exact)
    objects = {}
    for side, keyed_rows, other in ((0, ka, kb), (1, kb, ka)):
        for k, r in keyed_rows.items():
            if k not in other:
                objects.setdefault(k[0], ([], []))[side].append(r)
    for o, (la, lb) in objects.items():
        # опорные точки: совпавшие операторы объекта, идущие в одном порядке в A и B
        anchors, last_b = [], -1
        for a, b, _ in sorted((x for x in exact if obj(x[1], 1) == o), key=lambda x: x[0]["line"]):
            if b["line"] > last_b:
                anchors.append((a["line"], b["line"]))
                last_b = b["line"]
        gaps = {}
        for side, rows in ((0, la), (1, lb)):
            for r in rows:
                g = sum(1 for x in anchors if x[side] < r["line"])
                gaps.setdefault(g, ([], []))[side].append(r)
        for ga, gb in gaps.values():
            ga.sort(key=by_line)
            gb.sort(key=by_line)
            found = []

            def free(x, side):
                return all(x is not p[side] for p in found)
            for a in ga:                       # по началу текста, только однозначно
                if not free(a, 0) or len(prefix(a)) < STMT_PREFIX_LEN:
                    continue
                same_a = [x for x in ga if prefix(x) == prefix(a) and free(x, 0)]
                same_b = [y for y in gb if prefix(y) == prefix(a) and free(y, 1)]
                if len(same_a) == 1 and len(same_b) == 1:
                    found.append((a, same_b[0]))
            for a in [x for x in ga if free(x, 0)]:                       # на одной строке
                b = next((b for b in gb if b["line"] == a["line"] and free(b, 1)), None)
                if b is not None:
                    found.append((a, b))
            pairs += [(a, b, " (текст изменен)") for a, b in found]
            used = {id(x) for pair in found for x in pair}
            pairs += [(a, None, " (нет в B)") for a in ga if id(a) not in used]
            pairs += [(None, b, " (нет в A)") for b in gb if id(b) not in used]
    return pairs


def statement_changes(rows_a, rows_b, pairs=None):
    """Значимые изменения времени операторов, которые входят в верхние TOP_SHARE (не меньше TOP_MIN)
    по времени в A или в B: [(строка A или None, строка B или None, пометка)] по убыванию разницы.
    pairs - уже готовые пары (сравнение реестров убирает из них операторы до начала наблюдения)."""
    def top(rows):
        n = max(TOP_MIN, math.ceil(TOP_SHARE * len(rows)))
        return {id(r) for r in sorted(rows, key=lambda r: -r["time"])[:n]}

    top_a, top_b = top(rows_a), top(rows_b)
    out = []
    for a, b, note in (statement_pairs(rows_a, rows_b) if pairs is None else pairs):
        if not ((a is not None and id(a) in top_a) or (b is not None and id(b) in top_b)):
            continue
        ta, tb = (a["time"] if a else 0), (b["time"] if b else 0)
        d = tb - ta
        if abs(d) < SIGNIFICANT_MS or (ta and abs(d) * 100 < SIGNIFICANT_PCT * ta):
            continue
        out.append((-abs(d), (a, b, note)))
    return [x for _, x in sorted(out, key=lambda x: x[0])]


def statement_text(a, b, note):
    """Строка раздела «Операторы» файла сравнения (ее разбирает и GUI)."""
    r = b or a
    ta, tb = (a["time"] if a else 0), (b["time"] if b else 0)
    if a and b and a["line"] != b["line"]:          # строки сдвинулись: строка A - в пометке
        note = f"{note[:-1]}, в A стр. {a['line']})" if note else f" (в A стр. {a['line']})"
    return (f"{r['label']}, стр. {r['line']}{note}: {ta} -> {tb} мс ({pct_text(ta, tb)}), "
            f"CPU {a['cpu'] if a else 0} -> {b['cpu'] if b else 0}, "
            f"чтений {a['reads'] if a else 0} -> {b['reads'] if b else 0}")


def statements_block(ra, rb):
    """Раздел сравнения реестров операторов (--profile в обоих запусках), строки парами."""
    rows_a, err_a = read_registry(ra)
    rows_b, err_b = read_registry(rb)
    if rows_a is None and rows_b is None and not (err_a or err_b):
        return []
    out = [both(""), both(f"# Операторы: значимые изменения времени (от {SIGNIFICANT_PCT}% и {SIGNIFICANT_MS} мс)")]
    errs = [e for e in (err_a, err_b) if e]
    if errs:
        return out + [both(e) for e in errs]
    if rows_a is None or rows_b is None:
        return out + [both(f"Реестр есть только в {'A' if rows_a is not None else 'B'}")]
    for name_a, name_b, n in object_map(rows_a, rows_b).values():
        out.append(both(f"Объект A {name_a} сопоставлен с объектом B {name_b} ({n} одинаковых операторов)"))
    changes = [statement_text(*x) for x in statement_changes(rows_a, rows_b)]
    if not changes:
        out.append(both("нет"))
    for i, s in enumerate(changes):
        out.append((s, s if i < SHORT_CHANGES_MAX else None))
    if len(changes) > SHORT_CHANGES_MAX:
        out.append((None, f"и еще {len(changes) - SHORT_CHANGES_MAX} в полном отчете"))
    return out


# ============================================================ режим 2: сравнение двух реестров (наблюдений)

def registry_dir(arg):
    """Папка реестра (--session или --profile), если arg - она или ее registry.txt; иначе None."""
    p = Path(arg)
    if p.is_dir() and (p / REGISTRY_FILE).is_file():
        return p
    if p.is_file() and p.name.lower() == REGISTRY_FILE:
        return p.parent
    return None


def read_seen(folder, rows):
    """Первое и последнее время сервера выполнения каждого оператора по log.csv:
    ({id(строки реестра): (первое, последнее)}, строка реестра первого отрезка журнала).
    Оператор журнала находится в реестре по объекту, строке и началу текста. Журнала нет - ({}, None)."""
    try:
        lines = (folder / REGISTRY_LOG).read_text(encoding="utf-8-sig").split("\n")
        header = parse_line(lines[0])
    except (OSError, UnicodeDecodeError, IndexError, ValueError):
        return {}, None
    by_key = collections.defaultdict(list)
    for r in rows:
        by_key[(r["label"].lower(), r["line"], r["head"].strip())].append(r)
    seen, first = {}, None
    for line in lines[1:]:
        if not line.strip():
            continue
        try:
            d = dict(zip(header, parse_line(line)))
            t, k = d["Время сервера"], (d["Объект"].lower(), int(d["Строка"]), (d.get("Начало текста") or "").strip())
        except (KeyError, ValueError):
            continue
        for r in by_key.get(k, ()):
            f, last = seen.get(id(r), (t, t))
            seen[id(r)] = (min(f, t), max(last, t))
            if first is None or t < first[0]:
                first = (t, r)
    return seen, first and first[1]


def before_start(pairs, seen, late, early):
    """Операторы стороны early, выполненные целиком до начала наблюдения стороны late.

    Сторона late подключилась позже, если первый оператор, который она застала, в стороне early
    начался не сразу. Все, что early выполнила только раньше этого места и чего нет в late, late не
    могла увидеть - это не изменение. Берется самый ранний общий оператор late, а в early - его первое
    выполнение: в цикле граница сдвигается раньше, то есть исключается меньше, а не больше.
    Возвращает (строка-граница или None, [исключенные строки early])."""
    common = [p for p in pairs if p[0] is not None and p[1] is not None
              and id(p[late]) in seen[late] and id(p[early]) in seen[early]]
    if not common:
        return None, []
    edge = min(common, key=lambda p: seen[late][id(p[late])][0])
    t = seen[early][id(edge[early])][0]
    out = [p[early] for p in pairs if p[late] is None and id(p[early]) in seen[early]
           and seen[early][id(p[early])][1] < t]
    return edge[early], out


def registry_head(folder):
    """Строки шапки registry.txt, нужные в сравнении: заголовок, исходный запрос, начало наблюдения."""
    try:
        lines = (folder / REGISTRY_FILE).read_text(encoding="utf-8-sig").split("\n")
    except (OSError, UnicodeDecodeError):
        return []
    keep = ("# ", "Исходный запрос", "Начало наблюдения", "Время по выборкам")
    return [x.strip().lstrip("# ") for x in lines if x.startswith(keep)][:4]


def objects_block(pairs, renamed):
    """Время по объектам: [{"name", "a", "b", "significant"}], сначала самые долгие. Объект A
    переименованной копии - под именем B. Устойчиво и при другом алгоритме внутри объекта: операторы
    не нужны."""
    ta, tb, names = collections.Counter(), collections.Counter(), {}
    for a, b, _ in pairs:
        for side, r, total in ((0, a, ta), (1, b, tb)):
            if r is None:
                continue
            o = r["label"].lower()
            if side == 0 and o in renamed:
                o = renamed[o][1].lower()
            if side == 1:
                names[o] = r["label"]
            else:
                names.setdefault(o, r["label"])
            total[o] += r["time"]
    out = []
    for o in sorted(names, key=lambda o: -max(ta[o], tb[o])):
        a, b = ta[o], tb[o]
        d = abs(b - a)
        out.append({"name": names[o], "a": a, "b": b,
                    "significant": d >= SIGNIFICANT_MS and not (a and d * 100 < SIGNIFICANT_PCT * a)})
    return out


def object_text(x):
    return f"{x['name']}: {x['a']} -> {x['b']} мс ({pct_text(x['a'], x['b'])})"


def runs_text(a, b):
    """Число запусков (возвратов к оператору): при цикле и позднем начале наблюдения оно разное,
    и сумма времени меняется без изменения самого оператора."""
    ra, rb = (a["runs"] if a else 0), (b["runs"] if b else 0)
    if not (ra or rb) or (ra == rb == 1):
        return ""
    per = [f"{r['time'] // r['runs']}" if r and r["runs"] else "-" for r in (a, b)]
    return f", запусков {ra} -> {rb} (на запуск {per[0]} -> {per[1]} мс)"


def registry_compare(dir_a, dir_b):
    """Сравнение двух реестров операторов (наблюдений --session или запусков --profile); его
    показывают и файл сравнения, и GUI. Возвращает словарь:
    rows - строки реестров A и B; notes - строки пояснений [(полная, сокращенная или None)];
    total - время общей части A и B; objects - objects_block; changes - statement_changes."""
    rows = []
    for d, lbl in ((dir_a, "A"), (dir_b, "B")):
        r, err = read_registry({"run": {"Реестр": REGISTRY_FILE}, "dir": d, "label": lbl})
        if r is None:
            raise ScriptError(err or f"Реестр {lbl} не найден: {d}")
        rows.append(r)
    notes = []
    renamed = object_map(rows[0], rows[1])
    for name_a, name_b, n in renamed.values():
        notes.append(both(f"Объект A {name_a} сопоставлен с объектом B {name_b} ({n} одинаковых операторов)"))
    pairs = statement_pairs(rows[0], rows[1])
    seen, firsts = zip(read_seen(dir_a, rows[0]), read_seen(dir_b, rows[1]))
    dropped = []
    if not (seen[0] and seen[1]):
        notes.append(both("Журнала выполнения (log.csv) нет: начало наблюдений не выравнивалось"))
    else:
        for late, early in ((1, 0), (0, 1)):
            edge, cut = before_start(pairs, seen, late, early)
            if cut:
                L, E = "AB"[late], "AB"[early]
                notes.append(both(f"Наблюдение {L} началось позже: не учитываются операторы {E} ({len(cut)}), "
                                  f"выполненные только до {edge['label']}, стр. {edge['line']}"))
                notes += [(f"  {r['label']}, стр. {r['line']}: {r['time']} мс", None) for r in cut]
                dropped += cut
    for lbl, r in zip("AB", firsts):
        if r is not None:
            notes.append(both(f"Первый оператор наблюдения {lbl}: {r['label']}, стр. {r['line']} - "
                              "его время может быть неполным (начало могло пройти до подключения)"))
    gone = {id(r) for r in dropped}
    pairs = [p for p in pairs if not any(r is not None and id(r) in gone for r in p[:2])]
    return {"rows": rows, "notes": notes,
            "total": [sum(r["time"] for r in rs if id(r) not in gone) for rs in rows],
            "objects": objects_block(pairs, renamed),
            "changes": statement_changes(rows[0], rows[1], pairs)}


def run_registry_compare(dir_a, dir_b):
    """Сравнение двух реестров без таблиц: файлы <B>__<A>_compare_<время>.txt и _short.txt рядом с папкой B."""
    Events.emit("start", mode="compare", a=str(dir_a.resolve()), b=str(dir_b.resolve()))
    started = dt.datetime.now()
    c = registry_compare(dir_a, dir_b)
    out = [both("# Сравнение реестров операторов")]
    for lbl, d in (("A", dir_a), ("B", dir_b)):
        out.append(both(f"{lbl}: {d.name}"))
        out += [(f"  {x}", None) for x in registry_head(d)]
    out += c["notes"]
    out.append(both(f"Время по выборкам (общая часть): {c['total'][0]} -> {c['total'][1]} мс ({pct_text(*c['total'])})"))

    # полный отчет - все объекты, сокращенный - только значимые изменения
    out += [both(""), both(f"# Объекты: время (в сокращенном - изменения от {SIGNIFICANT_PCT}% и {SIGNIFICANT_MS} мс)")]
    out += [(object_text(x), object_text(x) if x["significant"] else None) for x in c["objects"]]
    if not c["objects"]:
        out.append(both("нет"))
    elif not any(x["significant"] for x in c["objects"]):
        out.append((None, "нет"))

    out += [both(""), both(f"# Операторы: значимые изменения времени (от {SIGNIFICANT_PCT}% и {SIGNIFICANT_MS} мс)")]
    changes = [statement_text(*x) + runs_text(x[0], x[1]) for x in c["changes"]]
    if not changes:
        out.append(both("нет"))
    for i, s in enumerate(changes):
        out.append((s, s if i < SHORT_CHANGES_MAX else None))
    if len(changes) > SHORT_CHANGES_MAX:
        out.append((None, f"и еще {len(changes) - SHORT_CHANGES_MAX} в полном отчете"))

    full = "\n".join(f for f, _ in out if f is not None) + "\n"
    short = "\n".join(s for _, s in out if s is not None) + "\n"
    out_dir = Path(OUTPUT_DIR) if OUTPUT_DIR else dir_b.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{dir_b.name}__{dir_a.name}_compare_{started.strftime(DT_FORMAT)}"
    path = unique_path(out_dir / f"{stem}{REPORT_EXT}")
    write_report(path, full)
    path_short = unique_path(out_dir / f"{stem}_short{REPORT_EXT}")
    write_report(path_short, short, short)
    log(f"Полный отчет: {path}")
    log(f"Сокращенный отчет: {path_short}")
    return 0


def run_line(label, r):
    run = r["run"]
    return (f"{label}: {r['path'].name}; SQL-файл: {run.get('SQL-файл', '?')}; "
            f"дата: {run.get('Дата выполнения', '?')}; сервер/база: {run.get('Сервер/база', '?')}; "
            f"режим: {run.get('Режим', '?')}")


def run_mode2(arg_a, arg_b):
    ensure_settings_file()   # настройки в режиме 2 не нужны, но пример создается
    Events.emit("start", mode="compare", a=str(Path(arg_a).resolve()), b=str(Path(arg_b).resolve()))
    ra, rb = parse_report(Path(arg_a), "A"), parse_report(Path(arg_b), "B")
    started = dt.datetime.now()
    blocks, diff_tables, err_tables, only_a, only_b = [], [], [], [], []
    for n in sorted(set(ra["tables"]) | set(rb["tables"])):
        if n in ra["tables"] and n in rb["tables"]:
            log(f"Таблица {n}...")
            body, differs, error, _ = compare_table(n, ra, rb)
            title = f"# Таблица {n}: " + ("отличается" if differs else "идентична")
            if differs:
                diff_tables.append(n)
            if error:
                err_tables.append(n)
        else:
            side, t = ("A", ra["tables"][n]) if n in ra["tables"] else ("B", rb["tables"][n])
            (only_a if side == "A" else only_b).append(n)
            title = f"# Таблица {n}: есть только в {side}"
            body = [both(f"Строк: {t['rows']}"), both(f"Файл: {t['file']}")]
        blocks.append([both(title)] + body)

    identical = not (diff_tables or only_a or only_b or err_tables)
    head = [both("# Сравнение"),
            (run_line("A", ra), ra["path"].name),
            (run_line("B", rb), rb["path"].name),
            both("Итог: " + ("результаты идентичны" if identical else "результаты различаются"))]
    if diff_tables:
        head.append(both("Различаются таблицы: " + ", ".join(map(str, diff_tables))))
    if only_a:
        head.append(both("Таблицы только в A: " + ", ".join(map(str, only_a))))
    if only_b:
        head.append(both("Таблицы только в B: " + ", ".join(map(str, only_b))))
    if err_tables:
        head.append(both("Ошибки при сравнении: таблицы " + ", ".join(map(str, err_tables))))
    if not ra["tables"] and not rb["tables"]:
        head.append(both("таблиц нет"))
    sql_a, sql_b = ra["run"].get("SQL-файл"), rb["run"].get("SQL-файл")
    if sql_a != sql_b:
        head.append((f"Внимание: SQL-файлы различаются: A={sql_a}, B={sql_b}", None))
    cost = cost_line("Затраты всего", ra["total"], rb["total"])
    if cost:
        head.append(both(cost))
    tolerance = f"допуск float: {FLOAT_TOLERANCE}" if FLOAT_TOLERANCE > 0 else ""
    head.append(("Значения сравниваются без учета регистра" + (f"; {tolerance}" if tolerance else ""),
                 tolerance.capitalize() or None))

    pairs = head + statements_block(ra, rb)
    for b in blocks:
        pairs = pairs + [both("")] + b
    full = "\n".join(f for f, _ in pairs if f is not None) + "\n"
    short = "\n".join(s for _, s in pairs if s is not None) + "\n"
    # Имя начинается с B (обычно тестируемый запуск), чтобы при сортировке сравнение шло рядом с ним.
    out_dir = Path(OUTPUT_DIR) if OUTPUT_DIR else rb["dir"]
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{rb['path'].stem}__{ra['path'].stem}_compare_{started.strftime(DT_FORMAT)}"
    path = unique_path(out_dir / f"{stem}{REPORT_EXT}")
    write_report(path, full)
    path_short = unique_path(out_dir / f"{stem}_short{REPORT_EXT}")
    write_report(path_short, short, short)
    log(f"Полный отчет: {path}")
    log(f"Сокращенный отчет: {path_short}")
    if err_tables:
        return 2
    return 0 if identical else 1


# ============================================================ точка входа

def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    parser = argparse.ArgumentParser(prog=Path(__file__).name, description=HELP,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="*", metavar="файл",
                        help="SQL-файл (режим 1) или два отчета (режим 2)")
    parser.add_argument("--rollback", action="store_true",
                        help="режим 1: выполнить в транзакции и откатить ее в конце")
    parser.add_argument("--repeat", type=int, metavar="N",
                        help="режим 1: выполнить N раз (N >= 2), первый прогон - прогрев")
    parser.add_argument("--profile", action="store_true",
                        help="режим 1: реестр операторов по времени (выборка текущего оператора)")
    parser.add_argument("--session", type=int, metavar="N",
                        help="режим 3: наблюдать за сессией N (реестр операторов в папке "
                             "Sessions_profile/Session_<время>_N)")
    parser.add_argument("--parent-pid", type=int, metavar="PID",
                        help="запуск из другой программы: если процесс PID закрылся, "
                             "остановиться как по Ctrl+C")
    parser.add_argument("--events", action="store_true",
                        help="запуск из другой программы: ход выполнения - строками JSON в stdout "
                             "(отчет в stdout не выводится)")
    args = parser.parse_args(argv)
    Events.on = args.events
    code, error = dispatch(parser, args)
    Events.emit("done", code=code, error=error)
    return code


def dispatch(parser, args):
    """Выполняет режим по аргументам: (код возврата, текст ошибки или None)."""
    try:
        Stop.start(args.parent_pid)
        if args.session is not None:
            if args.files or args.rollback or args.repeat or args.profile:
                parser.print_help(sys.stderr)
                return 2, "неверные аргументы"
            return run_session(args.session), None
        if args.repeat is not None and args.repeat < 2:
            raise ScriptError("--repeat: N должно быть не меньше 2")
        if len(args.files) == 1:
            return run_mode1(args.files[0], args.rollback, args.repeat or 1, args.profile), None
        if len(args.files) == 2 and not (args.rollback or args.repeat or args.profile):
            dirs = [registry_dir(x) for x in args.files]
            if all(dirs):
                return run_registry_compare(*dirs), None
            if any(dirs):
                raise ScriptError("сравниваются два отчета или две папки реестров (наблюдения --session, "
                                  "запуски --profile), не отчет с папкой")
            return run_mode2(args.files[0], args.files[1]), None
        parser.print_help(sys.stderr)
        return 2, "неверные аргументы"
    except ScriptError as e:
        log(f"Ошибка: {e}")
        return 2, str(e)
    except KeyboardInterrupt:
        log("Прервано пользователем")
        return 2, "прервано пользователем"
    except Exception as e:
        log("Непредвиденная ошибка:\n" + traceback.format_exc())
        return 2, f"непредвиденная ошибка: {err_text(e)}"


if __name__ == "__main__":
    sys.exit(main())
