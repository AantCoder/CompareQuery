"""CompareQuery: все, что зависит от MS SQL Server (драйвер pyodbc, строка подключения ODBC, батчи GO,
системные представления sys.dm_*). Ядро (CompareQuery.py) обращается к серверу только через класс MSSQL.

Почему запросы именно такие и какие варианты отброшены - CLAUDE.md, §6-§9 и §12; запросы GUI - GUI.md §5.9,
§5.20, §5.21.
"""

import collections
import datetime as dt
import queue
import re
import struct
import threading
import time
import zlib

import CompareQuery as cq


# ============================================================ строка подключения

def sql_server_drivers():
    """Установленные ODBC-драйверы SQL Server: 'ODBC Driver N for SQL Server' от новейшего, затем прочие
    (SQL Server Native Client), старый 'SQL Server' последним. Драйверы других СУБД не берутся."""
    try:
        import pyodbc
        drivers = pyodbc.drivers()
    except Exception:
        return []

    def order(d):
        m = re.fullmatch(r"ODBC Driver (\d+) for SQL Server", d, re.I)
        return (0, -int(m.group(1)), d) if m else (2 if d.lower() == "sql server" else 1, 0, d)
    return sorted((d for d in drivers if "sql server" in d.lower()), key=order)


def default_driver():
    """Новейший 'ODBC Driver N for SQL Server', иначе 'SQL Server'."""
    best = next((d for d in sql_server_drivers() if re.fullmatch(r"ODBC Driver \d+ for SQL Server", d, re.I)), None)
    return best or "SQL Server"


def conn_parts(cs):
    """(сервер, база) для подписей GUI."""
    def value(key):
        m = re.search(r"(?:^|;)\s*" + key + r"\s*=\s*([^;]*)", cs or "", re.I)
        return m.group(1).strip().strip("{}") if m else ""
    return value("server"), value("database")


def sample_connection_string():
    """Строка подключения для примера настроек."""
    return f"Driver={{{default_driver()}}};Server=localhost;Database=master;TrustServerCertificate=yes"


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
        raise cq.ScriptError("строка подключения уже содержит UID или PWD, а в настройках задан login: "
                             "оставьте что-то одно")
    uid = brace(login) if set(login) & set(";{}=") or login != login.strip() else login
    return f"{cs}UID={uid};PWD={brace(pwd)}"


# ============================================================ SQL-файл: батчи GO

GO_RE = re.compile(r"^[ \t]*go(?:[ \t]+(\d+))?[ \t]*(?:--.*|/\*.*\*/[ \t]*)?$", re.I)


def split_batches(text):
    """Строка, состоящая только из GO, разделяет батчи. GO N не поддерживается.
    Возвращает [(номер первой строки батча в файле, текст батча)]."""
    batches, cur, start = [], [], 1
    for lineno, line in enumerate(text.split("\n"), 1):
        m = GO_RE.match(line.rstrip("\r"))
        if m:
            if m.group(1) is not None:
                raise cq.ScriptError(f"строка {lineno}: 'GO {m.group(1)}' не поддерживается")
            batches.append((start, "\n".join(cur)))
            cur, start = [], lineno + 1
        else:
            cur.append(line)
    batches.append((start, "\n".join(cur)))
    return [(s, b) for s, b in batches if b.strip()]


# ============================================================ конвертеры pyodbc

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
    return cq.XmlStr(text)


def conv_variant(raw):
    return None if raw is None else cq.VariantBytes(raw)


def conv_udt(raw):
    return None if raw is None else cq.UdtBytes(raw)


OUTPUT_CONVERTERS = [(-155, conv_datetimeoffset), (-152, conv_xml), (-151, conv_udt), (-150, conv_variant)]


# ============================================================ сообщения сервера

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
    cols = ", ".join(f"[{cq.escape(name).replace(']', ']]')}] {sql_type(k, d)}"
                     for name, k, d in zip(names, kinds, dinfo))
    return f"create table #t{n}({cols})"


# ============================================================ счетчики рабочей сессии

FUNC_TYPES = {"FN", "IF", "TF", "FS", "FT"}   # функции: их выборки относятся к вызывающему оператору
PLAN_SQL = "SELECT query_plan FROM sys.dm_exec_text_query_plan(?, ?, ?)"


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
        self.base = self.last = cq.CTL_ZERO
        self.req = cq.ZERO
        try:                              # sys.dm_exec_session_wait_stats есть с SQL Server 2016
            self.query(self.WAIT_STATS_PROBE)
            self.client_ok = True
        except Exception:
            self.client_ok = False
        self.sql = self.COUNTERS_SQL.format(client=self.CLIENT_SQL if self.client_ok else "NULL")
        # счетчики, которых нет (ядро пишет "нет данных"), пометки о точности и статистика прогона - нет
        self.absent = {} if self.client_ok else {
            "client": "нет sys.dm_exec_session_wait_stats, SQL Server до 2016; время его включает"}
        self.extra = None

    def begin(self, cur, profile, rollback, explain=None):
        """Начало прогона (у PostgreSQL - статистика функций и auto_explain); здесь ничего."""

    def before_close(self, conn):
        """Перед откатом и закрытием рабочего подключения; здесь ничего."""

    def after_close(self):
        """После закрытия рабочего подключения; здесь ничего."""

    @staticmethod
    def notes():
        return []

    def query(self, sql, *params):
        return self.timed_query(sql, *params)[0]

    def timed_query(self, sql, *params):
        """(строки, длительность ответа сервера в мс). Время ожидания подключения, занятого другим
        потоком (счетчики главного потока), в длительность не входит."""
        with self.lock:
            t = cq.perf()
            cur = self.conn.cursor()
            try:
                cur.execute(sql, *params)
                rows = [tuple(r) for r in cur.fetchall()] if cur.description is not None else []
            finally:
                cur.close()
            return rows, (cq.perf() - t) / 1e6

    def read(self):
        rows = self.query(self.sql, self.spid)
        if not rows:
            raise cq.ControlError("контрольное подключение не видит рабочую сессию, нужно право VIEW SERVER STATE")
        row = rows[0]
        return row, (cq.perf() // 1_000_000, int(row[8] or 0))

    def batch_start(self):
        """Перед батчем рабочая сессия простаивает, ее счетчики полные."""
        row, stamp = self.read()
        self.base = self.last = cq.vmax(cq.to_counters(row[:4]) + stamp, self.last)
        self.req = cq.ZERO
        return self.last

    def now(self):
        row, stamp = self.read()
        if row[4] is not None:
            self.req = cq.to_counters(row[4:8])
            v = cq.vadd(self.base[:4], self.req)
        else:    # запрос уже завершился
            v = cq.vmax(cq.to_counters(row[:4]), cq.vadd(self.base[:4], self.req))
        self.last = cq.vmax(v + stamp, self.last)
        return self.last

    def live(self, s, t):
        """Счетчики прогона по выборке s (момент t, perf) без запроса к серверу - по формуле now():
        счетчики сессии перед батчем + счетчики запроса из выборки. Ожидание клиента - на момент
        последнего замера."""
        v = cq.vadd(self.base[:3], s[5][:3]) + (self.base[3], t // 1_000_000, self.last[5])
        return cq.vmax(v, self.last)


# ============================================================ тексты, объекты, планы (свой поток)

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
            self.error = self.error or cq.err_text(e)
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
            self.error = self.error or cq.err_text(e)
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


# ============================================================ выборка текущего оператора

STMT_MIN_LEN = 2    # текст оператора не длиннее - границы испорчены, выборка считается как внутри функции
WAIT_GROUPS = ("PAGEIOLATCH_", "PAGELATCH_", "LATCH_")   # подтипы (_SH, _EX, ...) объединяются в X_*


def describe(texts, objects, s, batch_start, sql_name, adhoc_label):
    """Оператор выборки: словарь с ключом (объект, строка, хэш текста) или None, если это функция
    или границы оператора испорчены: в sys.dm_exec_requests смещения начала и конца читаются без
    блокировки и в момент смены оператора бывают несогласованными (конец раньше начала, текст из
    одной буквы). Такая выборка, как и выборка внутри функции, относится к предыдущему оператору,
    а следующий опрос идет сразу."""
    handle, start, end = s[1], s[2], s[3]
    t = texts.get(handle)
    if t is None:
        label = "(текст недоступен)"
        return {"key": (label, 0, ""), "label": label, "line": 0, "hash": "", "text": "", "start": start, "end": end}
    dbid, objid, text = t
    text = text or ""
    obj = objects.get((dbid, objid)) if objid is not None else None
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
    ex = cq.new_extra()
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
        self.builder = cq.StatsBuilder(self, batch_start, sql_name, adhoc_label, on_segment)
        self.on_poll = None              # --profile --events: вызывается после каждой выборки (в потоке)
        self.event_fields = {}           # --events: общие поля событий (номер прогона)

    def run(self):
        delay = cq.PROFILE_INTERVAL_MS
        try:
            while not self.stop_event.wait(delay / 1000):
                s, delay = self.poll()
                if self.on_poll is not None:
                    self.on_poll(s)
        except Exception as e:
            self.error = cq.err_text(e)
        self.finish()

    def describe(self, s, batch_start, sql_name, adhoc_label):
        return describe(self.texts, self.objects, s, batch_start, sql_name, adhoc_label)

    @staticmethod
    def interval_extra(d, state):
        return interval_extra(d, state)

    def timed_query(self, sql):
        """Запрос строки запроса сессии: от его ответа зависит точность времени. Вспомогательные запросы
        (кто ждет сессию; тексты и планы у Lookup) задержками не считаются."""
        rows, d = self.control.timed_query(sql, self.control.spid)
        if d > cq.SAMPLE_SLOW_MS:
            self.slow += 1
            self.slow_ms += round(d)
            cq.Events.emit("slow", count=self.slow, ms=self.slow_ms, **self.event_fields)
        return rows

    def poll(self):
        """Одна выборка: (выборка или None, если запроса нет; задержка до следующей, мс).

        Выборка: (запрос, sql_handle, start, end, plan_handle, (cpu, logical, physical, elapsed),
        (wait_type, last_wait_type, status, выделено памяти в страницах, блокирует другие сессии,
        какую сессию ждет или None), время сервера)."""
        rows = self.timed_query(self.REQUEST_SQL)
        if not rows or rows[0][2] is None:
            self.push(None)
            return None, cq.PROFILE_INTERVAL_MS
        r = rows[0]
        if self.ignoring or (r[0], r[1]) in self.ignored_requests:   # батч --ignore in test
            self.ignored_requests.add((r[0], r[1]))
            self.push(None)
            return None, cq.PROFILE_INTERVAL_MS
        blocking = 1 if self.control.query(self.BLOCKING_SQL, self.control.spid) else 0
        handle = bytes(r[2])
        plan = bytes(r[5]) if r[5] is not None else None
        # blocking_session_id: 0 - никого не ждет, < 0 - владелец неизвестен; у параллельного плана
        # (CXPACKET и т. п.) в нем своя же сессия
        by = r[15]
        by = int(by) if by and by > 0 and by != self.control.spid else None
        s = ((r[0], r[1]), handle, r[3] or 0, r[4], plan, cq.to_counters(r[6:10]),
             tuple(r[10:14]) + (blocking, by), r[14])
        self.lookup.want_text(handle)
        self.push(s)
        # внутри функции или с испорченными границами оператора - следующий опрос сразу
        again = self.ready(handle) and self.builder.statement(s) is None
        return s, cq.PROFILE_FAST_MS if again else cq.PROFILE_INTERVAL_MS

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

    def finish(self, wait_s=None):
        """Конец выборок: дождаться текстов (не дольше wait_s, по умолчанию LOOKUP_WAIT_S) и передать все выборки."""
        end = cq.perf() + (cq.LOOKUP_WAIT_S if wait_s is None else wait_s) * 10**9
        while self.waiting and self.lookup.busy() and cq.perf() < end:
            time.sleep(0.02)
        self.drain(force=True)
        self.builder.idle()

    def stop(self):
        self.stop_event.set()
        self.join()


# ============================================================ запросы просмотра сервера (GUI, --show)

# Служебные подключения CompareQuery (контрольное, наблюдение, GUI, --show) в списках сессий не показываются.
# Рабочее подключение прогона (APP=CompareQuery) показывается: тестовые запросы бывают тяжелыми.
SERVICE_APPS = "(" + ", ".join(f"'{cq.APP_NAME} {x}'" for x in ("control", "session", "gui", "show")) + ")"

SESSIONS_SQL = (
    "SELECT s.session_id, DB_NAME(s.database_id), s.program_name, s.host_name, s.login_name, "
    "r.total_elapsed_time, OBJECT_SCHEMA_NAME(t.objectid, t.dbid) + '.' + OBJECT_NAME(t.objectid, t.dbid) "
    "FROM sys.dm_exec_sessions s "
    "LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id "
    "OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t "
    "WHERE s.is_user_process = 1 AND s.session_id <> @@SPID "
    "AND ISNULL(s.program_name, '') NOT IN " + SERVICE_APPS)
SESSIONS_COLS = ("spid", "db", "program", "host", "login", "elapsed", "proc")

# «Текущие запросы» (GUI.md §5.20): пользовательские сессии с запросом и те, кто блокирует других
# (в том числе простаивающие с открытой транзакцией). Только DMV по активным запросам и текст оператора;
# план и исходный запрос - по кнопке. Второй набор - итоги по серверу.
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

# «Тяжелые запросы» (GUI.md §5.21): статистика кэша планов. Один проход по sys.dm_exec_query_stats
# с сортировкой TOP N (без полной сортировки); текст - только для N строк (TOP во вложенном запросе),
# планы - по кнопке. Итоги накоплены с момента компиляции плана.
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

# --show tables: использование индексов текущей базы по таблицам (счетчики с перезапуска сервера или подключения
# базы); строк - из sys.partitions (метаданные, без чтения таблицы)
TABLES_SQL = (
    "SELECT s.name + '.' + o.name, SUM(u.user_seeks), SUM(u.user_scans), SUM(u.user_lookups), SUM(u.user_updates), "
    "(SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)), "
    "MAX(u.last_user_seek), MAX(u.last_user_scan), MAX(u.last_user_lookup), MAX(u.last_user_update) "
    "FROM sys.dm_db_index_usage_stats u JOIN sys.objects o ON o.object_id = u.object_id "
    "JOIN sys.schemas s ON s.schema_id = o.schema_id "
    "WHERE u.database_id = DB_ID() AND o.type = 'U' GROUP BY s.name, o.name, o.object_id")
# --show functions: процедуры и функции текущей базы, план которых в кэше (sys.dm_exec_function_stats - с 2016)
MODULES_SQL = (
    "SELECT OBJECT_SCHEMA_NAME(object_id, database_id) + '.' + OBJECT_NAME(object_id, database_id), type_desc, "
    "SUM(execution_count), SUM(total_worker_time) / 1000, SUM(total_elapsed_time) / 1000, SUM(total_logical_reads) "
    "FROM sys.{view} WHERE database_id = DB_ID() GROUP BY object_id, database_id, type_desc")
# --show io: файлы всех баз (счетчики с перезапуска сервера)
IO_SQL = (
    "SELECT DB_NAME(f.database_id), mf.name, mf.type_desc, f.num_of_reads, f.num_of_bytes_read / 1048576, "
    "f.io_stall_read_ms, f.num_of_writes, f.num_of_bytes_written / 1048576, f.io_stall_write_ms, "
    "f.io_stall_read_ms + f.io_stall_write_ms, mf.physical_name "
    "FROM sys.dm_io_virtual_file_stats(NULL, NULL) f "
    "JOIN sys.master_files mf ON mf.database_id = f.database_id AND mf.file_id = f.file_id")
STATS_SPEC = {      # колонки строки, ключ для разницы снимков, накопительные счетчики, сортировка
    "tables": {"cols": ("table", "seeks", "scans", "lookups", "updates", "rows", "last_read", "last_update", "reads"),
               "key": ("table",), "counters": ("reads", "seeks", "scans", "lookups", "updates"), "order": "reads",
               "since": "С перезапуска сервера или подключения базы (sys.dm_db_index_usage_stats; что сейчас - --interval S)"},
    "functions": {"cols": ("object", "type", "execs", "cpu", "time", "reads"), "key": ("object", "type"),
                  "counters": ("execs", "cpu", "time", "reads"), "order": "time",
                  "since": "С попадания плана в кэш, только объекты с планом в кэше (что сейчас - --interval S)"},
    "io": {"cols": ("db", "file", "type", "reads", "read_mb", "read_ms", "writes", "write_mb", "write_ms", "stall", "path"),
           "key": ("db", "file"), "counters": ("reads", "read_mb", "read_ms", "writes", "write_mb", "write_ms", "stall"),
           "order": "stall", "since": "С перезапуска сервера (sys.dm_io_virtual_file_stats; что сейчас - --interval S)"},
}
# --show waits: ожидания всего сервера - разница двух снимков sys.dm_os_wait_stats (без выборок по сессиям)
WAITS_SQL = "SELECT wait_type, waiting_tasks_count, wait_time_ms, signal_wait_time_ms FROM sys.dm_os_wait_stats WHERE wait_time_ms > 0"
# фоновые ожидания, которые ждут работы, а не мешают ей (по списку Paul Randal, "Wait statistics, or please tell me
# where it hurts")
IDLE_WAITS = set((
    "BROKER_EVENTHANDLER BROKER_RECEIVE_WAITFOR BROKER_TASK_STOP BROKER_TO_FLUSH BROKER_TRANSMITTER CHECKPOINT_QUEUE "
    "CHKPT CLR_AUTO_EVENT CLR_MANUAL_EVENT CLR_SEMAPHORE DBMIRROR_DBM_EVENT DBMIRROR_EVENTS_QUEUE DBMIRROR_WORKER_QUEUE "
    "DBMIRRORING_CMD DIRTY_PAGE_POLL DISPATCHER_QUEUE_SEMAPHORE EXECSYNC FSAGENT FT_IFTS_SCHEDULER_IDLE_WAIT FT_IFTSHC_MUTEX "
    "HADR_CLUSAPI_CALL HADR_FILESTREAM_IOMGR_IOCOMPLETION HADR_LOGCAPTURE_WAIT HADR_NOTIFICATION_DEQUEUE HADR_TIMER_TASK "
    "HADR_WORK_QUEUE KSOURCE_WAKEUP LAZYWRITER_SLEEP LOGMGR_QUEUE MEMORY_ALLOCATION_EXT ONDEMAND_TASK_QUEUE "
    "PARALLEL_REDO_DRAIN_WORKER PARALLEL_REDO_LOG_CACHE PARALLEL_REDO_TRAN_LIST PARALLEL_REDO_WORKER_SYNC "
    "PARALLEL_REDO_WORKER_WAIT_WORK PREEMPTIVE_OS_FLUSHFILEBUFFERS PREEMPTIVE_XE_GETTARGETSTATE PVS_PREALLOCATE "
    "PWAIT_ALL_COMPONENTS_INITIALIZED PWAIT_DIRECTLOGCONSUMER_GETNEXT PWAIT_EXTENSIBILITY_CLEANUP_TASK "
    "QDS_PERSIST_TASK_MAIN_LOOP_SLEEP QDS_ASYNC_QUEUE QDS_CLEANUP_STALE_QUERIES_TASK_MAIN_LOOP_SLEEP QDS_SHUTDOWN_QUEUE "
    "REDO_THREAD_PENDING_WORK REQUEST_FOR_DEADLOCK_SEARCH RESOURCE_QUEUE SERVER_IDLE_CHECK SLEEP_BPOOL_FLUSH "
    "SLEEP_DBSTARTUP SLEEP_DCOMSTARTUP SLEEP_MASTERDBREADY SLEEP_MASTERMDREADY SLEEP_MASTERUPGRADED SLEEP_MSDBSTARTUP "
    "SLEEP_SYSTEMTASK SLEEP_TASK SLEEP_TEMPDBSTARTUP SNI_HTTP_ACCEPT SOS_WORK_DISPATCHER SP_SERVER_DIAGNOSTICS_SLEEP "
    "SQLTRACE_BUFFER_FLUSH SQLTRACE_INCREMENTAL_FLUSH_SLEEP SQLTRACE_WAIT_ENTRIES UCS_SESSION_REGISTRATION "
    "VDI_CLIENT_OTHER WAIT_FOR_RESULTS WAITFOR WAITFOR_TASKSHUTDOWN WAIT_XTP_RECOVERY WAIT_XTP_HOST_WAIT "
    "WAIT_XTP_OFFLINE_CKPT_NEW_LOG WAIT_XTP_CKPT_CLOSE XE_DISPATCHER_JOIN XE_DISPATCHER_WAIT XE_TIMER_EVENT").split())

# Колонки --show: (ключ строки, заголовок, в консоли). В CSV - все.
SHOW_COLUMNS = {
    "sessions": [("spid", "Сессия", True), ("db", "База", True), ("login", "Логин", True), ("host", "Компьютер", True),
                 ("program", "Программа", True), ("elapsed", "Запрос идет мс", True), ("proc", "Процедура", True)],
    "current": [("spid", "Сессия", True), ("db", "База", True), ("login", "Логин", True), ("host", "Компьютер", False),
                ("program", "Программа", False), ("session_status", "Сессия: состояние", False),
                ("status", "Состояние", True), ("command", "Команда", False), ("elapsed", "Время мс", True),
                ("cpu", "CPU мс", True), ("reads", "Логических чтений", True), ("physical", "Физических чтений", False),
                ("writes", "Записей", False), ("memory", "Память МБ", False), ("wait", "Ожидание", True),
                ("wait_ms", "Ожидание мс", False), ("blocked_by", "Ждет сессию", True), ("blocks", "Блокирует сессий", True),
                ("trans", "Транзакций", False), ("percent", "Выполнено %", False), ("idle_s", "Простой с", False),
                ("object", "Объект", True), ("line", "Строка", True), ("statement", "Оператор", True),
                ("last_text", "Последний запрос", False), ("input", "Исходный запрос", False),
                ("plan_handle", "plan_handle", False), ("start", "Начало оператора", False), ("end", "Конец оператора", False)],
    "heavy": [("execs", "Выполнений", True), ("cpu", "CPU мс", True), ("time", "Время мс", True),
              ("max_time", "Макс. время мс", False), ("reads", "Логических чтений", True),
              ("physical", "Физических чтений", False), ("writes", "Записей", False), ("rows", "Строк", False),
              ("last", "Последнее выполнение", False), ("created", "План создан", False), ("db", "База", True),
              ("object", "Объект", True), ("line", "Строка", True), ("statement", "Оператор", True),
              ("plan_handle", "plan_handle", False), ("start", "Начало оператора", False), ("end", "Конец оператора", False)],
    "tables": [("table", "Таблица", True), ("reads", "Обращений на чтение", True), ("seeks", "Seek", True),
               ("scans", "Scan", True), ("lookups", "Lookup", True), ("updates", "Изменений", True), ("rows", "Строк", True),
               ("last_read", "Последнее чтение", False), ("last_update", "Последнее изменение", False)],
    "functions": [("object", "Объект", True), ("type", "Тип", True), ("execs", "Выполнений", True), ("cpu", "CPU мс", True),
                  ("time", "Время мс", True), ("reads", "Логических чтений", True)],
    "io": [("db", "База", True), ("file", "Файл", True), ("type", "Тип", True), ("reads", "Чтений", True),
           ("read_mb", "Прочитано МБ", False), ("read_ms", "Ожидание чтения мс", True), ("writes", "Записей", True),
           ("write_mb", "Записано МБ", False), ("write_ms", "Ожидание записи мс", True), ("stall", "Ожидание всего мс", False),
           ("path", "Путь", False)],
    "waits": [("wait", "Ожидание", True), ("time", "Время мс", True), ("share", "Доля %", True),
              ("tasks", "Ожиданий", True), ("signal", "Из них сигнал мс", False)],
    "space": [("file", "Файл", True), ("filegroup", "Файловая группа", False), ("type", "Тип", True),
              ("size_mb", "Размер МБ", True), ("used_mb", "Занято МБ", True), ("free_mb", "Свободно в файле МБ", True),
              ("growth_mb", "Прирост МБ", False), ("growth_pct", "Прирост %", False),
              ("max_mb", "Предел МБ (пусто - без предела)", False), ("avail_mb", "Можно занять еще МБ", True),
              ("disk", "Диск", True), ("disk_free_mb", "Свободно на диске МБ", True), ("disk_total_mb", "Размер диска МБ", False),
              ("path", "Путь", False)],
    "temp": [("spid", "Сессия", True), ("db", "База", True), ("login", "Логин", True), ("program", "Программа", False),
             ("status", "Состояние", False), ("elapsed", "Запрос идет мс", False),
             ("user_mb", "Пользовательские МБ", True), ("internal_mb", "Внутренние МБ", True),
             ("total_mb", "Всего МБ", True), ("text", "Запрос", True)],
}


# GUI «База данных» (GUI.md §5.28): каталог и DMV выбранной базы (USE на подключении GUI - остальные его
# запросы от текущей базы не зависят), без чтения данных таблиц.
DATABASES_SQL = "SELECT name FROM sys.databases WHERE state = 0 AND HAS_DBACCESS(name) = 1 ORDER BY name"
SPACE_FILES_SQL = (
    "SELECT f.file_id, f.name, ds.name, f.type_desc, f.size / 128.0, FILEPROPERTY(f.name, 'SpaceUsed') / 128.0, "
    "f.growth, f.is_percent_growth, f.max_size, f.physical_name "
    "FROM sys.database_files f LEFT JOIN sys.data_spaces ds ON ds.data_space_id = f.data_space_id "
    "ORDER BY f.type, f.file_id")
SPACE_DISKS_SQL = ("SELECT f.file_id, v.volume_mount_point, v.total_bytes / 1048576.0, v.available_bytes / 1048576.0 "
                   "FROM sys.database_files f CROSS APPLY sys.dm_os_volume_stats(DB_ID(), f.file_id) v")
# размеры таблиц (как в Dev\Размер базы.sql): страницы единиц размещения; строки - у кучи или кластерного индекса
TABLE_SIZES_SQL = (
    "SELECT t.object_id, s.name + '.' + t.name, SUM(u.total_pages) / 128.0, SUM(u.used_pages) / 128.0, "
    "SUM(CASE WHEN p.index_id < 2 THEN u.used_pages ELSE 0 END) / 128.0, "
    "SUM(CASE WHEN p.index_id > 1 THEN u.used_pages ELSE 0 END) / 128.0, "
    "SUM(CASE WHEN p.index_id < 2 AND u.type = 1 THEN p.rows ELSE 0 END), "
    "COUNT(DISTINCT CASE WHEN p.index_id < 2 THEN p.partition_number END), "
    "MAX(CASE WHEN p.index_id = 0 THEN 1 ELSE 0 END), MIN(ds.name), MAX(ds.name) "
    "FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id "
    "JOIN sys.partitions p ON p.object_id = t.object_id "
    "JOIN sys.allocation_units u ON u.container_id = p.partition_id "
    "LEFT JOIN sys.data_spaces ds ON ds.data_space_id = u.data_space_id "
    "GROUP BY t.object_id, s.name, t.name")
TABLE_USAGE_SQL = (
    "SELECT object_id, SUM(user_seeks), SUM(user_scans), SUM(user_lookups), SUM(user_updates), "
    "MAX(last_user_seek), MAX(last_user_scan), MAX(last_user_lookup), MAX(last_user_update) "
    "FROM sys.dm_db_index_usage_stats WHERE database_id = DB_ID() GROUP BY object_id")
INDEXES_SQL = (
    "SELECT i.index_id, i.name, i.type_desc, i.is_unique, i.is_primary_key, i.filter_definition, "
    "(SELECT SUM(u.used_pages) FROM sys.partitions p JOIN sys.allocation_units u ON u.container_id = p.partition_id "
    "  WHERE p.object_id = i.object_id AND p.index_id = i.index_id) / 128.0, "
    "us.user_seeks, us.user_scans, us.user_lookups, us.user_updates, "
    "us.last_user_seek, us.last_user_scan, us.last_user_lookup, us.last_user_update "
    "FROM sys.indexes i LEFT JOIN sys.dm_db_index_usage_stats us "
    "  ON us.database_id = DB_ID() AND us.object_id = i.object_id AND us.index_id = i.index_id "
    "WHERE i.object_id = ? ORDER BY i.index_id")
# столбцы индексов таблицы: ключ по порядку и включенные (INCLUDE); столбцы секционирования (key_ordinal 0) - нет,
# кроме columnstore: у него столбцы без ключа и не «включенные» (идут как ключ)
INDEX_COLUMNS_SQL = (
    "SELECT ic.index_id, c.name, ic.is_descending_key, ic.is_included_column "
    "FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id "
    "JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id "
    "WHERE ic.object_id = ? AND (ic.key_ordinal > 0 OR ic.is_included_column = 1 OR i.type IN (5, 6)) "
    "ORDER BY ic.index_id, ic.key_ordinal, ic.index_column_id")
# столбцы таблицы: объявленный тип (размер значения средствами каталога не узнать - только по данным)
COLUMNS_SQL = (
    "SELECT c.name, ty.name, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, c.is_computed, c.is_sparse "
    "FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id "
    "WHERE c.object_id = ? ORDER BY c.column_id")
VAR_TYPES = {"varchar", "nvarchar", "varbinary", "sql_variant", "xml", "text", "ntext", "image", "geography", "geometry",
             "hierarchyid"}
# SQL создания таблицы (кнопка у строки «Таблиц»). Готового средства в T-SQL нет: SSMS пишет скрипт через SMO
# (.NET), поэтому скрипт собирается по каталогу, а части, которые сервер хранит текстом, берутся как есть:
# определения DEFAULT, CHECK, вычисляемых столбцов, условие индекса (sys.*.definition), триггеры (OBJECT_DEFINITION)
DDL_TABLE_SQL = (
    "SELECT s.name, t.name, ds.name, ds.type, lds.name, CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS nvarchar(128)), "
    "DB_NAME() FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id "
    "LEFT JOIN sys.indexes i ON i.object_id = t.object_id AND i.index_id < 2 "
    "LEFT JOIN sys.data_spaces ds ON ds.data_space_id = i.data_space_id "
    "LEFT JOIN sys.data_spaces lds ON lds.data_space_id = t.lob_data_space_id WHERE t.object_id = ?")
DDL_COLUMNS_SQL = (
    "SELECT c.name, ty.name, SCHEMA_NAME(ty.schema_id), ty.is_user_defined, c.max_length, c.precision, c.scale, "
    "c.is_nullable, c.collation_name, c.is_sparse, c.is_rowguidcol, cc.definition, cc.is_persisted, "
    "CAST(ic.seed_value AS nvarchar(40)), CAST(ic.increment_value AS nvarchar(40)), dc.name, dc.definition "
    "FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id "
    "LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id "
    "LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id "
    "LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id "
    "WHERE c.object_id = ? ORDER BY c.column_id")
DDL_INDEXES_SQL = (
    "SELECT i.index_id, i.name, i.type, i.type_desc, i.is_unique, i.is_primary_key, i.is_unique_constraint, "
    "i.filter_definition, i.is_disabled, i.fill_factor, ds.name, ds.type, "
    "(SELECT c.name FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id "
    "  WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.partition_ordinal = 1) "
    "FROM sys.indexes i LEFT JOIN sys.data_spaces ds ON ds.data_space_id = i.data_space_id "
    "WHERE i.object_id = ? AND i.is_hypothetical = 0 ORDER BY i.index_id")
DDL_CHECKS_SQL = "SELECT name, definition, is_disabled FROM sys.check_constraints WHERE parent_object_id = ? ORDER BY name"
DDL_FKS_SQL = (
    "SELECT fk.name, SCHEMA_NAME(rt.schema_id), rt.name, fk.delete_referential_action_desc, "
    "fk.update_referential_action_desc, fk.is_disabled, pc.name, rc.name "
    "FROM sys.foreign_keys fk JOIN sys.objects rt ON rt.object_id = fk.referenced_object_id "
    "JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id "
    "JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id "
    "JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id "
    "WHERE fk.parent_object_id = ? ORDER BY fk.name, fkc.constraint_column_id")
DDL_TRIGGERS_SQL = "SELECT name, OBJECT_DEFINITION(object_id), is_disabled FROM sys.triggers WHERE parent_id = ? ORDER BY name"
# расширенные свойства (MS_Description - комментарии SSMS) таблицы, столбцов и индексов
DDL_PROPS_SQL = (
    "SELECT ep.class, ep.minor_id, COALESCE(c.name, i.name), ep.name, CAST(ep.value AS nvarchar(max)) "
    "FROM sys.extended_properties ep "
    "LEFT JOIN sys.columns c ON ep.class = 1 AND c.object_id = ep.major_id AND c.column_id = ep.minor_id "
    "LEFT JOIN sys.indexes i ON ep.class = 7 AND i.object_id = ep.major_id AND i.index_id = ep.minor_id "
    "WHERE ep.major_id = ? AND ep.class IN (1, 7) ORDER BY ep.class, ep.minor_id, ep.name")


# триггеры таблицы (подтаблица «Таблиц»): события, вид, включен ли, текст
TRIGGERS_SQL = (
    "SELECT tr.object_id, tr.name, tr.is_disabled, tr.is_instead_of_trigger, "
    "STUFF((SELECT ', ' + te.type_desc FROM sys.trigger_events te WHERE te.object_id = tr.object_id "
    "  ORDER BY te.type FOR XML PATH('')), 1, 2, ''), OBJECT_DEFINITION(tr.object_id) "
    "FROM sys.triggers tr WHERE tr.parent_id = ? ORDER BY tr.name")
# статистика триггеров из кэша планов (как у процедур): с попадания плана в кэш, нужно VIEW SERVER STATE
TRIGGER_STATS_SQL = (
    "SELECT object_id, SUM(execution_count), SUM(total_worker_time) / 1000, SUM(total_elapsed_time) / 1000, "
    "MAX(max_elapsed_time) / 1000, SUM(total_logical_reads), MAX(last_execution_time), MIN(cached_time) "
    "FROM sys.dm_exec_trigger_stats WHERE database_id = DB_ID() AND object_id IN "
    "  (SELECT object_id FROM sys.triggers WHERE parent_id = ?) GROUP BY object_id")


def qn(name):
    """Имя в квадратных скобках."""
    return "[" + name.replace("]", "]]") + "]"


def nlit(text):
    """Строка Unicode для T-SQL."""
    return "N'" + text.replace("'", "''") + "'"


def type_text(typ, size, prec, scale):
    """Тип столбца как в объявлении: nvarchar(50), decimal(18,2), varbinary(max)."""
    if typ in ("varchar", "char", "varbinary", "binary"):
        return f"{typ}({'max' if size == -1 else size})"
    if typ in ("nvarchar", "nchar"):
        return f"{typ}({'max' if size == -1 else size // 2})"
    if typ in ("decimal", "numeric"):
        return f"{typ}({prec},{scale})"
    if typ in ("datetime2", "time", "datetimeoffset"):
        return f"{typ}({scale})"
    if typ == "float" and prec != 53:
        return f"float({prec})"
    return typ
# временные данные: занятое сессиями в tempdb (завершенные задачи сессии + идущие) и сводка по файлам tempdb
TEMP_SESSIONS_SQL = (
    "SELECT s.session_id, DB_NAME(es.database_id), es.login_name, es.program_name, r.status, "
    "DATEDIFF(MILLISECOND, r.start_time, GETDATE()), "
    "(s.user_objects_alloc_page_count - s.user_objects_dealloc_page_count + ISNULL(t.u, 0)) / 128.0, "
    "(s.internal_objects_alloc_page_count - s.internal_objects_dealloc_page_count + ISNULL(t.i, 0)) / 128.0, q.text "
    "FROM sys.dm_db_session_space_usage s JOIN sys.dm_exec_sessions es ON es.session_id = s.session_id "
    "LEFT JOIN (SELECT session_id, SUM(user_objects_alloc_page_count - user_objects_dealloc_page_count) u, "
    "  SUM(internal_objects_alloc_page_count - internal_objects_dealloc_page_count) i "
    "  FROM sys.dm_db_task_space_usage GROUP BY session_id) t ON t.session_id = s.session_id "
    "LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id "
    "OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) q "
    "WHERE es.is_user_process = 1")
TEMP_SPACE_SQL = ("SELECT SUM(total_page_count) / 128.0, SUM(unallocated_extent_page_count) / 128.0, "
                  "SUM(version_store_reserved_page_count) / 128.0, SUM(internal_object_reserved_page_count) / 128.0, "
                  "SUM(user_object_reserved_page_count) / 128.0 FROM tempdb.sys.dm_db_file_space_usage")
# самые большие временные таблицы tempdb (по кнопке; без dm_tran_locks - сессию у таблицы не узнать)
TEMP_TABLES_SQL = (
    "SET LOCK_TIMEOUT 3000; "
    "SELECT TOP 30 t.name, SUM(CASE WHEN a.type = 1 THEN p.rows ELSE 0 END), SUM(a.total_pages) / 128.0, t.create_date "
    "FROM tempdb.sys.tables t WITH (NOLOCK) JOIN tempdb.sys.partitions p WITH (NOLOCK) ON p.object_id = t.object_id "
    "JOIN tempdb.sys.allocation_units a WITH (NOLOCK) ON a.container_id = p.partition_id "
    "WHERE t.name LIKE '#%' GROUP BY t.object_id, t.name, t.create_date ORDER BY SUM(a.total_pages) DESC")
TEMP_NAME_RE = re.compile(r"_{3,}[0-9A-F]{12}$")      # #имя_____...00000000001A: без хвоста


def space_summary(rows):
    """Итог по видам файлов (данные, лог): размер, занято и сколько можно занять еще - свободное в файлах плюс
    свободное на каждом диске один раз (не больше, чем файлы на нем могут вырасти до своих пределов)."""
    out = []
    for typ in dict.fromkeys(r["type"] for r in rows):
        mine = [r for r in rows if r["type"] == typ]
        avail, disks = sum(r["free_mb"] or 0 for r in mine), {}
        for r in mine:
            if not r["grows"]:
                continue
            if r["disk"] is None:
                avail = None
                break
            d = disks.setdefault(r["disk"], [r["disk_free_mb"], 0.0])
            d[1] = None if r["room"] is None or d[1] is None else d[1] + r["room"]     # None - без предела
        if avail is not None:
            avail += sum(free if room is None else min(free, room) for free, room in disks.values())
        out.append({"type": typ, "size_mb": round(sum(r["size_mb"] for r in mine), 1),
                    "used_mb": round(sum(r["used_mb"] or 0 for r in mine), 1),
                    "avail_mb": round(avail, 1) if avail is not None else None})
    return out


def iso(v):
    return v.isoformat(sep=" ", timespec="seconds") if v is not None else None


def statement_of(text, start, end):
    """Оператор по смещениям (байты nvarchar, как у выборки) и номер его строки в тексте объекта или батча."""
    text = text or ""
    i0 = (start or 0) // 2
    i1 = len(text) if end is None or end < 0 else end // 2 + 1
    return text[i0:i1].strip(), text.count("\n", 0, i0) + 1


# ============================================================ диалект

class MSSQL:
    """MS SQL Server для ядра CompareQuery: подключения, батчи, типы, счетчики, выборка, запросы просмотра.
    Методы с аргументом query получают функцию query(sql, *params, sets=1) на уже открытом подключении."""

    name = "MS SQL Server"
    plan_ext = ".sqlplan"
    can_cancel = False           # отменить запрос чужой сессии нельзя, только закрыть ее (KILL)
    Control, Lookup, Sampler = Control, Lookup, Sampler
    SessionControl = Control         # --session: то же контрольное подключение (выборки, проверка жизни сессии)
    show_columns = SHOW_COLUMNS
    heavy_orders = tuple(HEAVY_ORDER)
    # --profile: строки шапки registry.txt о смысле колонок; колонки реестра, которых у СУБД нет
    registry_notes = ["Время: без ожидания клиента (ASYNC_NETWORK_IO: передача результатов и работа скрипта)"]
    session_notes = ["Время: без ожидания клиента (ASYNC_NETWORK_IO: передача результатов и обработка на клиенте)"]
    registry_blank = ()
    no_session = None                # --session поддерживается
    can_explain = False              # --explain - только PostgreSQL (здесь планы из кэша дает --profile)
    heavy_hours = True               # «Тяжелые запросы»: отбор по времени последнего выполнения
    heavy_interval = False           # разница двух снимков - два полных прохода по кэшу планов
    gui_absent = {"current": [], "heavy": []}      # колонки экранов GUI, которых у СУБД нет

    def __init__(self, settings):
        self.settings = settings
        self.input_mode = "dmf"      # исходный запрос: dmf, dbcc (до SQL Server 2014 SP2) или None (недоступен)
        self.inbuf, self.inbuf_ok = {}, True     # исходные запросы «Текущих запросов» по (сессия, начало запроса)

    # ---------------------------------------------------- подключение

    @staticmethod
    def driver():
        try:
            import pyodbc
        except ImportError:
            raise cq.ScriptError("не установлен модуль pyodbc: pip install pyodbc")
        return pyodbc

    @property
    def Error(self):
        return self.driver().Error

    def connect(self, app, autocommit=True, timeout=0, query_timeout=0):
        """Подключение с именем программы app; timeout - на вход, query_timeout - на запрос (с, 0 - без
        ограничения). Ошибка драйвера - как есть (Error): вызывающий решает, прервать ли запуск."""
        conn = self.driver().connect(build_conn_str(self.settings, app), autocommit=autocommit, timeout=timeout)
        if query_timeout:
            conn.timeout = query_timeout
        return conn

    def open_work(self, rollback):
        """Рабочее подключение прогона: конвертеры типов, которые pyodbc не понимает."""
        pyodbc = self.driver()
        pyodbc.native_uuid = True
        conn = self.connect(cq.APP_NAME, autocommit=not rollback, query_timeout=cq.QUERY_TIMEOUT)
        for code, fn in OUTPUT_CONVERTERS:
            conn.add_output_converter(code, fn)
        return conn

    def server_info(self, conn):
        pyodbc, info = self.driver(), {}
        for key, attr in (("server", "SQL_SERVER_NAME"), ("database", "SQL_DATABASE_NAME"),
                          ("dbms", "SQL_DBMS_NAME"), ("version", "SQL_DBMS_VER")):
            try:
                info[key] = conn.getinfo(getattr(pyodbc, attr))
            except Exception:
                pass
        return info

    @staticmethod
    def session_id(cur):
        """@@SPID подключения; тем же запросом - замер часов сервера (ServerTime)."""
        t = cq.perf()
        row = cur.execute("SELECT @@SPID, SYSDATETIME()").fetchone()
        cq.ServerTime.set(row[1], (t + cq.perf()) // 2)
        return int(row[0])

    @staticmethod
    def end_transaction(conn):
        """После прерванного оператора: транзакцию, которую открыл сам скрипт, сервер не откатывает до ее
        конца, и ее блокировки держались бы до отключения."""
        conn.execute("IF @@TRANCOUNT > 0 ROLLBACK")

    # ---------------------------------------------------- выполнение

    sample_connection_string = staticmethod(sample_connection_string)
    split_script = staticmethod(split_batches)

    @staticmethod
    def registry_extra(extras, median):
        """Дополнительные файлы папки реестра и строки шапки по статистике прогонов (Control.extra); здесь нет."""
        return {}, []

    @staticmethod
    def check_script(batches, rollback):
        """Проверка файла перед запуском: у MS SQL Server ограничений нет."""
    message = staticmethod(user_message)
    create_table = staticmethod(create_table)

    @staticmethod
    def column_info(desc):
        """Описание колонок для create table: (тип Python, размер, точность, масштаб, NULL)."""
        return [(getattr(d[1], "__name__", str(d[1])), d[3], d[4], d[5], bool(d[6])) for d in desc]

    @staticmethod
    def plan(query, plan_handle, start, end):
        """Кэшированный план оператора или None."""
        rows = query(PLAN_SQL, plan_handle, int(start or 0), int(end if end is not None else -1))
        return rows[0][0] if rows and rows[0][0] else None

    # ---------------------------------------------------- наблюдение за сессией

    @staticmethod
    def session_row(query, spid):
        """(начало сессии, компьютер, программа, логин) или None, если сессии нет."""
        rows = query("SELECT login_time, host_name, program_name, login_name "
                     "FROM sys.dm_exec_sessions WHERE session_id = ?", spid)
        return tuple(rows[0]) if rows else None

    def input_buffer(self, query, spid):
        """Исходный запрос сессии - последний батч, который прислал клиент (часто вызов процедуры
        с параметрами), одной строкой; None - получить не удалось. sys.dm_exec_input_buffer есть
        с SQL Server 2014 SP2, до него - DBCC INPUTBUFFER; нет и его (права) - больше не спрашивается."""
        while self.input_mode:
            try:
                if self.input_mode == "dmf":
                    rows = query("SELECT event_info FROM sys.dm_exec_input_buffer(?, NULL)", spid)
                else:
                    rows = [[r[2]] for r in query(f"DBCC INPUTBUFFER({int(spid)}) WITH NO_INFOMSGS")]
                break
            except Exception:
                self.input_mode = "dbcc" if self.input_mode == "dmf" else None
        else:
            return None
        return (rows[0][0] or "").replace("\x00", "") if rows else ""

    # ---------------------------------------------------- просмотр сервера (GUI, --show)

    @staticmethod
    def server_props(query):
        """Проверка подключения: сервер, база, логин, версия."""
        row = query("SELECT @@SERVERNAME, DB_NAME(), SUSER_SNAME(), CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)), "
                    "CAST(SERVERPROPERTY('Edition') AS nvarchar(128))")[0]
        return {"server": row[0], "database": row[1], "login": row[2], "version": row[3], "edition": row[4]}

    @staticmethod
    def sessions(query):
        """Пользовательские сессии (GUI.md §5.9), один легкий запрос."""
        out = [dict(zip(SESSIONS_COLS, r)) for r in query(SESSIONS_SQL)]
        out.sort(key=lambda x: ((x["db"] or "").lower(), (x["program"] or "").lower(), x["spid"]))
        return out

    def current(self, query):
        """«Текущие запросы» (GUI.md §5.20): строки и итоги по серверу. Текст - только оператор."""
        rows, total = query(CURRENT_SQL, sets=2)
        out = []
        for r in rows:
            x = dict(zip(CURRENT_COLS, r))
            x["statement"], x["line"] = statement_of(x.pop("text"), x["start"], x["end"])
            x["last_text"] = (x["last_text"] or "").strip()
            x["plan_handle"] = x["plan_handle"].hex() if x["plan_handle"] else None
            x["memory"] = round((x["memory"] or 0) * 8 / 1024, 1)        # страницы по 8 КБ -> МБ
            x["wait"] = (x["wait"] or "").strip()
            out.append(x)
        self.input_buffers(query, out)
        t = total[0] if total else [None] * 4
        return {"rows": out, "sessions": t[0], "runnable": t[1], "memory_waits": t[2],
                "server_time": t[3].isoformat(timespec="seconds") if t[3] else None}

    def input_buffers(self, query, rows):
        """Поле input строк «Текущих запросов»: исходный запрос сессии одной строкой. С сервера - только для
        запросов, которых еще нет в памяти (сменилось начало запроса сессии)."""
        cache = self.inbuf
        keys = {x["spid"]: (x["spid"], str(x["req_start"])) for x in rows}
        need = [spid for spid, k in keys.items() if k not in cache]
        if need and self.inbuf_ok:
            try:
                got = {r[0]: r[1] for r in query(INPUT_BUFFERS_SQL.format(ids=", ".join(str(int(n)) for n in need)))}
                for spid in need:
                    cache[keys[spid]] = " ".join((got.get(spid) or "").replace("\x00", "").split())[:1000]
            except Exception:
                self.inbuf_ok = False            # нет функции или права - больше не спрашивать
        for k in [k for k in cache if k not in keys.values()]:
            del cache[k]                         # в памяти - только текущие запросы
        for x in rows:
            x["input"] = cache.get(keys[x["spid"]], "")
            x.pop("req_start", None)

    @staticmethod
    def heavy(query, order="cpu", hours=0, top=100, interval=0, pause=None, db=None):
        """«Тяжелые запросы» (GUI.md §5.21): TOP операторов кэша планов по показателю order,
        выполнявшихся за последние hours часов (0 - за все время в кэше). Время - мс. db - только операторы
        этой базы среди TOP сервера: отбор по базе в самом запросе потребовал бы текста каждого плана кэша."""
        if order not in HEAVY_ORDER:
            raise ValueError(f"неизвестный показатель: {order}")
        if interval:
            raise ValueError("--interval для heavy в MS SQL Server нет: разница требует двух полных проходов по кэшу "
                             "планов (sys.dm_exec_query_stats); за последние часы - --hours N")
        top = max(10, min(500, int(top)))
        hours = int(hours) if hours and int(hours) > 0 else 24 * 365 * 20
        out = []
        for r in query(HEAVY_SQL.format(order=HEAVY_ORDER[order]), top, hours):
            x = dict(zip(HEAVY_COLS, r))
            x["statement"], x["line"] = statement_of(x.pop("text"), x["start"], x["end"])
            x["plan_handle"] = x["plan_handle"].hex() if x["plan_handle"] else None
            for k in ("cpu", "time", "max_time"):
                x[k] = round((x[k] or 0) / 1000)                       # мкс -> мс
            for k in ("last", "created"):
                x[k] = x[k].isoformat(sep=" ", timespec="seconds") if x[k] else None
            if not db or (x["db"] or "").lower() == db.lower():
                out.append(x)
        return out

    # ---------------------------------------------------- --show tables, functions, io, waits

    stats_spec = STATS_SPEC

    @staticmethod
    def stats(kind, query):
        """Накопительные счетчики --show tables/functions/io: {"rows": [...], "note": пояснение или None}."""
        note = None
        if kind == "tables":
            rows = []
            for name, seeks, scans, lookups, updates, nrows, ls, lc, ll, lu in query(TABLES_SQL):
                last = max([x for x in (ls, lc, ll) if x is not None], default=None)
                rows.append((name, seeks, scans, lookups, updates, nrows, last, lu,
                             (seeks or 0) + (scans or 0) + (lookups or 0)))
        elif kind == "functions":
            rows = query(MODULES_SQL.format(view="dm_exec_procedure_stats"))
            try:
                rows += query(MODULES_SQL.format(view="dm_exec_function_stats"))
            except Exception:
                note = "функций нет: sys.dm_exec_function_stats - с SQL Server 2016"
        elif kind == "io":
            rows = query(IO_SQL)
        else:
            raise ValueError(f"неизвестный вид: {kind}")
        rows = [dict(zip(STATS_SPEC[kind]["cols"], r)) for r in rows]
        for r in rows:
            for k in ("last_read", "last_update"):
                if r.get(k) is not None:
                    r[k] = r[k].isoformat(sep=" ", timespec="seconds")
        return {"rows": rows, "note": note}

    @staticmethod
    def waits(query, seconds, pause, db=None):
        """--show waits: ожидания всего сервера за seconds секунд - разница двух снимков sys.dm_os_wait_stats,
        без фоновых ожиданий (IDLE_WAITS). Точное время, но без разбивки по сессиям и базам (db не учитывается).
        seconds 0 - накопленные с перезапуска сервера (GUI)."""
        cols = ("wait", "tasks", "time", "signal")
        after = [dict(zip(cols, r)) for r in query(WAITS_SQL)]
        if seconds:
            before = after
            pause(seconds)
            after = cq.delta_rows(before, [dict(zip(cols, r)) for r in query(WAITS_SQL)], ("wait",), cols[1:])
        rows = [r for r in after if r["wait"] not in IDLE_WAITS]
        total = sum(r["time"] for r in rows)
        for r in rows:
            r["share"] = round(100 * r["time"] / total, 1) if total else 0
        rows.sort(key=lambda r: -r["time"])
        note = (f"За {seconds} с: ожидания всего сервера (sys.dm_os_wait_stats, разница двух снимков), без фоновых; "
                f"всего {total} мс" if seconds else
                f"С перезапуска сервера: ожидания всего сервера (sys.dm_os_wait_stats), без фоновых; всего {total} мс")
        return {"rows": rows, "note": note, "seconds": seconds, "total": total}

    # ---------------------------------------------------- GUI: «Нагрузка сервера», «База данных» (GUI.md §5.21, §5.28)

    load_by_db = ("heavy", "io")     # разделы «Нагрузки», где есть отбор по базе (ожидания - всего сервера)
    waits_total = True               # есть накопленные с перезапуска ожидания (без замера)
    has_temp_tables = True           # кнопка «Временные таблицы» (tempdb)
    space_per_db = True              # «Место» - файлы выбранной базы

    @staticmethod
    def databases(query):
        return [r[0] for r in query(DATABASES_SQL)]

    @staticmethod
    def in_db(query, db, fn):
        """fn(query) в базе db: USE на подключении GUI (его остальные запросы от текущей базы не зависят)."""
        if not query("SELECT DB_ID(?)", db)[0][0]:
            raise ValueError("нет такой базы")
        use = "USE [" + db.replace("]", "]]") + "]; "
        return fn(lambda sql, *params, sets=1: query(use + sql, *params, sets=sets))

    @staticmethod
    def space(query):
        """Файлы текущей базы: размер, занято, прирост, предел и свободное место на дисках с ними; «можно
        занять еще» - с учетом свободного в файле, прироста, предела и диска (как в Dev\\Размер базы.sql)."""
        files, note = query(SPACE_FILES_SQL), None
        try:                     # диски: нужно VIEW SERVER STATE
            disks = {r[0]: r[1:] for r in query(SPACE_DISKS_SQL)}
        except Exception:
            disks, note = {}, "диски: нет данных (нужно право VIEW SERVER STATE)"
        rows = []
        for fid, name, fg, typ, size, used, growth, pct, max_size, path in files:
            size = float(size or 0)
            used = float(used) if used is not None else None
            mount, total, free = disks.get(fid, (None, None, None))
            free = float(free) if free is not None else None
            max_mb = None if max_size == -1 else max_size / 128           # None - без предела
            if not growth:
                limit = size
            elif free is None:   # диск неизвестен
                limit = None
            else:
                limit = size + free if max_mb is None else min(max_mb, size + free)
            rows.append({"file": name, "filegroup": fg, "type": typ, "size_mb": round(size, 1),
                         "used_mb": round(used, 1) if used is not None else None,
                         "free_mb": round(size - used, 1) if used is not None else None,
                         "growth_mb": round(growth / 128, 1) if growth and not pct else None,
                         "growth_pct": growth if growth and pct else None, "grows": bool(growth),
                         "max_mb": round(max_mb, 1) if max_mb is not None else None,
                         "avail_mb": round(max(limit - used, 0), 1) if limit is not None and used is not None else None,
                         "disk": mount, "disk_free_mb": round(free, 1) if free is not None else None,
                         "disk_total_mb": round(float(total), 1) if total is not None else None, "path": path,
                         "room": None if not growth else (None if max_mb is None else max(max_mb - size, 0))})
        summary = space_summary(rows)
        for r in rows:
            del r["room"]
        return {"rows": rows, "summary": summary, "note": note}

    @staticmethod
    def tables(query):
        """Таблицы текущей базы: размеры (единицы размещения) и обращения (sys.dm_db_index_usage_stats, с
        перезапуска сервера или подключения базы)."""
        usage = {r[0]: r[1:] for r in query(TABLE_USAGE_SQL)}
        rows = []
        for oid, name, total, used, data, idx, nrows, parts, heap, fg1, fg2 in query(TABLE_SIZES_SQL):
            seeks, scans, lookups, updates, ls, lc, ll, lu = usage.get(oid, (None,) * 8)
            last = max([x for x in (ls, lc, ll) if x is not None], default=None)
            rows.append({"id": oid, "table": name, "filegroup": fg1 if fg1 == fg2 else f"{fg1}, {fg2}",
                         "rows": nrows, "total_mb": round(float(total or 0), 1), "used_mb": round(float(used or 0), 1),
                         "data_mb": round(float(data or 0), 1), "index_mb": round(float(idx or 0), 1),
                         "partitions": parts, "heap": bool(heap),
                         # байт на строку: занятые страницы данных и индексов на строку (оценка роста таблицы)
                         "row_bytes": round(float(used or 0) * 1048576 / nrows) if nrows else None,
                         "data_row_bytes": round(float(data or 0) * 1048576 / nrows) if nrows else None, "seeks": seeks, "scans": scans, "lookups": lookups,
                         "reads": None if seeks is None else (seeks or 0) + (scans or 0) + (lookups or 0),
                         "updates": updates, "last_read": iso(last), "last_update": iso(lu)})
        return {"rows": rows, "note": None}

    @staticmethod
    def indexes(query, table_id):
        cols = {}
        for iid, col, desc, incl in query(INDEX_COLUMNS_SQL, int(table_id)):
            k = cols.setdefault(iid, {"keys": [], "include": []})
            k["include" if incl else "keys"].append(col + (" DESC" if desc and not incl else ""))
        rows = []
        for (iid, name, typ, uniq, pk, flt, mb, seeks, scans, lookups, updates,
             ls, lc, ll, lu) in query(INDEXES_SQL, int(table_id)):
            last = max([x for x in (ls, lc, ll) if x is not None], default=None)
            rows.append({"name": name, "type": typ, "unique": bool(uniq), "primary": bool(pk),
                         "keys": cols.get(iid, {}).get("keys", []), "include": cols.get(iid, {}).get("include", []),
                         "filter": flt, "clustered": typ.startswith("CLUSTERED"),
                         "mb": round(float(mb or 0), 1), "seeks": seeks, "scans": scans, "lookups": lookups,
                         "reads": None if seeks is None else (seeks or 0) + (scans or 0) + (lookups or 0),
                         "updates": updates, "last_read": iso(last), "last_update": iso(lu),
                         # кандидат в лишние: некластерный, не уникальный, не читался, но меняется
                         "unused": typ == "NONCLUSTERED" and not uniq and not pk and not (seeks or scans or lookups)})
        return rows

    @staticmethod
    def columns(query, table_id):
        """Столбцы таблицы: тип и сколько байт занимает значение (у типов переменной длины - не больше)."""
        rows = []
        for name, typ, size, prec, scale, nullable, ident, comp, sparse in query(COLUMNS_SQL, int(table_id)):
            var = typ in VAR_TYPES or size == -1
            rows.append({"column": name, "type": type_text(typ, size, prec, scale), "nullable": bool(nullable), "bytes": None if size == -1 else size,
                         "var": var, "identity": bool(ident), "computed": bool(comp), "sparse": bool(sparse)})
        return rows

    @staticmethod
    def triggers(query, table_id):
        """Триггеры таблицы и их статистика выполнения (sys.dm_exec_trigger_stats - пока план в кэше)."""
        note, stats = None, {}
        try:
            stats = {r[0]: r[1:] for r in query(TRIGGER_STATS_SQL, int(table_id))}
        except Exception:
            note = "статистики выполнения нет: нужно право VIEW SERVER STATE"
        rows = []
        for oid, name, disabled, instead, events, text in query(TRIGGERS_SQL, int(table_id)):
            execs, cpu, time_, max_t, reads, last, cached = stats.get(oid, (None,) * 7)
            rows.append({"name": name, "enabled": "D" if disabled else "O", "timing": "INSTEAD OF" if instead else "AFTER",
                         "events": events, "level": "statement", "execs": execs, "cpu": cpu, "time": time_,
                         "max_time": max_t, "reads": reads, "last": iso(last), "cached": iso(cached),
                         "text": text.strip() if text else None})
        return {"rows": rows, "note": note}

    @staticmethod
    def table_sql(query, table_id):
        """SQL создания таблицы по каталогу: столбцы, ограничения, индексы, внешние ключи, триггеры и
        расширенные свойства (комментарии); батчи разделены GO."""
        oid = int(table_id)
        head = query(DDL_TABLE_SQL, oid)
        if not head:
            raise ValueError("таблица не найдена")
        schema, table, ds, ds_type, lob_ds, db_coll, db = head[0]
        full = qn(schema) + "." + qn(table)
        cols = {}
        for iid, col, desc, incl in query(INDEX_COLUMNS_SQL, oid):
            k = cols.setdefault(iid, {"keys": [], "include": []})
            k["include" if incl else "keys"].append(qn(col) + ("" if incl else " DESC" if desc else " ASC"))

        def place(name, kind, part):          # ON [файловая группа] или ON [схема секционирования]([столбец])
            return f" ON {qn(name)}" + (f"({qn(part)})" if kind == "PS" and part else "") if name else ""

        lines = []
        for (name, typ, tschema, user_type, size, prec, scale, nullable, coll, sparse, guid, comp, persisted,
             seed, inc, df_name, df_def) in query(DDL_COLUMNS_SQL, oid):
            if comp is not None:
                s = f"{qn(name)} AS {comp}" + (" PERSISTED" + ("" if nullable else " NOT NULL") if persisted else "")
            else:
                s = f"{qn(name)} " + (f"{qn(tschema)}.{qn(typ)}" if user_type else type_text(typ, size, prec, scale))
                if coll and coll != db_coll:
                    s += f" COLLATE {coll}"
                if sparse:
                    s += " SPARSE"
                if seed is not None:
                    s += f" IDENTITY({seed},{inc})"
                if guid:
                    s += " ROWGUIDCOL"
                s += " NULL" if nullable else " NOT NULL"
                if df_name:
                    s += f" CONSTRAINT {qn(df_name)} DEFAULT {df_def}"
            lines.append(s)
        after, table_part = [], None
        for (iid, name, itype, type_desc, uniq, pk, uq, flt, disabled, fill, ids, ids_type,
             part) in query(DDL_INDEXES_SQL, oid):
            if iid < 2:
                table_part = part           # столбец секционирования таблицы (куча или кластерный индекс)
            if itype == 0:
                continue
            c = cols.get(iid, {"keys": [], "include": []})
            with_ = f" WITH (FILLFACTOR = {fill})" if fill not in (0, 100) else ""
            kind = "CLUSTERED" if itype == 1 else "NONCLUSTERED"
            if pk or uq:
                lines.append(f"CONSTRAINT {qn(name)} {'PRIMARY KEY' if pk else 'UNIQUE'} {kind} ({', '.join(c['keys'])})"
                             + with_ + place(ids, ids_type, part))
            elif itype in (1, 2):
                after.append(f"CREATE {'UNIQUE ' if uniq else ''}{kind} INDEX {qn(name)} ON {full} ({', '.join(c['keys'])})"
                             + (f" INCLUDE ({', '.join(x for x in c['include'])})" if c["include"] else "")
                             + (f" WHERE {flt}" if flt else "") + with_ + place(ids, ids_type, part))
            elif itype in (5, 6):
                names = [x.rsplit(" ", 1)[0] if x.endswith((" ASC", " DESC")) else x for x in c["keys"] + c["include"]]
                after.append(f"CREATE {'CLUSTERED' if itype == 5 else 'NONCLUSTERED'} COLUMNSTORE INDEX {qn(name)} ON {full}"
                             + (f" ({', '.join(names)})" if itype == 6 else "") + (f" WHERE {flt}" if flt else "")
                             + place(ids, ids_type, part))
            else:
                after.append(f"-- индекс {qn(name)} ({type_desc}) не воспроизводится: его вид здесь не поддержан")
                continue
            if disabled:
                after.append(f"ALTER INDEX {qn(name)} ON {full} DISABLE")
        for name, definition, disabled in query(DDL_CHECKS_SQL, oid):
            lines.append(f"CONSTRAINT {qn(name)} CHECK {definition}")
            if disabled:
                after.append(f"ALTER TABLE {full} NOCHECK CONSTRAINT {qn(name)}")
        fks = {}
        for name, rschema, rtable, on_del, on_upd, disabled, pcol, rcol in query(DDL_FKS_SQL, oid):
            fk = fks.setdefault(name, {"ref": qn(rschema) + "." + qn(rtable), "del": on_del, "upd": on_upd,
                                       "disabled": disabled, "cols": [], "rcols": []})
            fk["cols"].append(qn(pcol))
            fk["rcols"].append(qn(rcol))
        for name, fk in fks.items():
            after.append(f"ALTER TABLE {full} ADD CONSTRAINT {qn(name)} FOREIGN KEY ({', '.join(fk['cols'])}) "
                         f"REFERENCES {fk['ref']} ({', '.join(fk['rcols'])})"
                         + (f" ON DELETE {fk['del'].replace('_', ' ')}" if fk["del"] != "NO_ACTION" else "")
                         + (f" ON UPDATE {fk['upd'].replace('_', ' ')}" if fk["upd"] != "NO_ACTION" else ""))
            if fk["disabled"]:
                after.append(f"ALTER TABLE {full} NOCHECK CONSTRAINT {qn(name)}")
        for name, definition, disabled in query(DDL_TRIGGERS_SQL, oid):
            after.append(definition.strip() if definition else f"-- триггер {qn(name)}: текст недоступен (зашифрован или нет прав)")
            if disabled:
                after.append(f"DISABLE TRIGGER {qn(name)} ON {full}")
        for cls, minor, sub, prop, value in query(DDL_PROPS_SQL, oid):
            if value is None or (minor and not sub):
                continue
            level2 = (f", @level2type = N'{'COLUMN' if cls == 1 else 'INDEX'}', @level2name = {nlit(sub)}" if minor else "")
            after.append(f"EXEC sys.sp_addextendedproperty @name = {nlit(prop)}, @value = {nlit(value)}, "
                         f"@level0type = N'SCHEMA', @level0name = {nlit(schema)}, "
                         f"@level1type = N'TABLE', @level1name = {nlit(table)}" + level2)
        create = (f"CREATE TABLE {full} (\n    " + ",\n    ".join(lines) + "\n)" + place(ds, ds_type, table_part)
                  + (f" TEXTIMAGE_ON {qn(lob_ds)}" if lob_ds and lob_ds != ds and ds_type != "PS" else ""))
        return (f"-- {full} (база {db}): собрано по каталогу сервера; права, статистики, сжатие, функции и схемы "
                "секционирования не входят\n" + "".join(x + "\nGO\n\n" for x in [create] + after))

    @staticmethod
    def temp(query):
        """Временные данные: занятое сессиями в tempdb и сводка по файлам tempdb (весь сервер)."""
        rows, seen = [], set()
        for spid, db, login, program, status, elapsed, user_mb, internal_mb, text in query(TEMP_SESSIONS_SQL):
            user_mb, internal_mb = max(float(user_mb or 0), 0), max(float(internal_mb or 0), 0)
            if spid in seen or user_mb + internal_mb <= 0:
                continue
            seen.add(spid)
            rows.append({"spid": spid, "db": db, "login": login, "program": program, "status": status,
                         "elapsed": elapsed, "user_mb": round(user_mb, 1), "internal_mb": round(internal_mb, 1),
                         "total_mb": round(user_mb + internal_mb, 1), "text": (text or "").strip()})
        rows.sort(key=lambda r: -r["total_mb"])
        total, free, version, internal, user = query(TEMP_SPACE_SQL)[0]
        num = lambda v: round(float(v), 1) if v is not None else None
        return {"rows": rows, "summary": {"total_mb": num(total), "free_mb": num(free), "version_mb": num(version),
                                          "internal_mb": num(internal), "user_mb": num(user)}, "note": None}

    @staticmethod
    def temp_tables(query):
        return [{"name": TEMP_NAME_RE.sub("", name), "internal_name": name, "rows": nrows,
                 "mb": round(float(mb or 0), 1), "created": iso(created)}
                for name, nrows, mb, created in query(TEMP_TABLES_SQL)]

    can_estimate = False             # оценочный план по кнопке - только PostgreSQL (здесь план - из кэша)

    @staticmethod
    def check_kill(spid, own=None):
        """Номер сессии, которую можно закрыть: не системная (до 50) и не своя."""
        spid = int(spid)
        if spid <= 50:
            raise ValueError("системная сессия")
        if own is not None and spid == own:
            raise ValueError("это подключение самой программы")
        return spid

    def kill(self, query, spid, own=None):
        """KILL - закрыть сессию (ее открытая транзакция откатывается). Только по подтверждению пользователя."""
        query(f"KILL {self.check_kill(spid, own)}")    # KILL не принимает параметры
