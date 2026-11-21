"""CompareQuery: все, что зависит от PostgreSQL (драйвер psycopg 3, строка подключения libpq, операторы через
";", типы, системные представления pg_stat_*). Ядро (CompareQuery.py) обращается к серверу только через класс
PostgreSQL - так же, как к MS SQL Server через cq_mssql.MSSQL.

Почему так - CLAUDE.md, §18.
"""

import collections
import datetime as dt
import re
import statistics
import threading
import time
import urllib.parse
import zlib

import CompareQuery as cq


# ============================================================ строка подключения

def parse_conninfo(cs):
    """Параметры строки подключения libpq: 'host=... dbname=...' или URI postgresql://... (без проверки)."""
    cs = (cs or "").strip()
    if re.match(r"postgres(?:ql)?://", cs, re.I):
        u = urllib.parse.urlsplit(cs)
        out = {k: v[-1] for k, v in urllib.parse.parse_qs(u.query).items()}
        if u.hostname:
            out["host"] = u.hostname
        if u.port:
            out["port"] = str(u.port)
        if u.username:
            out["user"] = urllib.parse.unquote(u.username)
        if u.password:
            out["password"] = "*"
        if u.path.strip("/"):
            out["dbname"] = urllib.parse.unquote(u.path.strip("/"))
        return out
    out = {}
    for m in re.finditer(r"(\w+)\s*=\s*('(?:[^'\\]|\\.)*'|\S*)", cs):
        v = m.group(2)
        out[m.group(1).lower()] = v[1:-1].replace("\\'", "'").replace("\\\\", "\\") if v.startswith("'") else v
    return out


def conn_parts(cs):
    """(сервер, база) для подписей GUI."""
    p = parse_conninfo(cs)
    return p.get("host") or p.get("hostaddr") or "localhost", p.get("dbname") or p.get("user") or ""


def sample_connection_string():
    return "host=localhost port=5432 dbname=postgres sslmode=prefer"


# ============================================================ SQL-файл: операторы через ";"

DOLLAR_RE = re.compile(r"\$([A-Za-z_\x80-\U0010ffff][A-Za-z0-9_\x80-\U0010ffff]*)?\$")
WORD_RE = re.compile(r"[A-Za-z_\x80-\U0010ffff][A-Za-z0-9_$\x80-\U0010ffff]*")


def split_statements(text):
    """Операторы SQL-файла, разделенные ";" вне строк ('...', E'...', "..."), комментариев (--, вложенные /* */)
    и тел в долларовых кавычках ($$...$$, $tag$...$tag$); в CREATE FUNCTION/PROCEDURE ... BEGIN ATOMIC ... END
    ";" внутри тела оператор не делит. Возвращает [(номер строки начала оператора, текст)]: текст - с первого
    непустого символа (комментарий над оператором - его часть, так работает "-- ignore in test"). Пустые операторы
    и одни комментарии пропускаются. Команды psql (\\i, \\set и т. п.) не поддерживаются."""
    out, n = [], len(text)
    i = start = 0
    code = False             # в операторе есть что-то, кроме комментариев
    words = []               # первые слова оператора (верхний регистр) - для CREATE FUNCTION
    atomic = 0               # глубина BEGIN ATOMIC ... END
    prev = ""

    def line_at(k):
        return text.count("\n", 0, k) + 1

    def flush(end):
        chunk = text[start:end]
        p = len(chunk) - len(chunk.lstrip())
        if code:
            out.append((line_at(start + p), chunk[p:].rstrip()))

    while i < n:
        c = text[i]
        if c == "-" and text.startswith("--", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "/" and text.startswith("/*", i):
            depth, k = 1, i + 2
            while k < n and depth:
                if text.startswith("/*", k):
                    depth, k = depth + 1, k + 2
                elif text.startswith("*/", k):
                    depth, k = depth - 1, k + 2
                else:
                    k += 1
            if depth:
                raise cq.ScriptError(f"строка {line_at(i)}: не закрыт комментарий /*")
            i = k
            continue
        if c.isspace():
            i += 1
            continue
        code = True
        if c == "'":
            esc = i > 0 and text[i - 1] in "eE" and not (i > 1 and (text[i - 2].isalnum() or text[i - 2] in "_$"))
            k = i + 1
            while True:
                if k >= n:
                    raise cq.ScriptError(f"строка {line_at(i)}: не закрыта строка '")
                if esc and text[k] == "\\":
                    k += 2
                    continue
                if text[k] == "'":
                    if text.startswith("''", k):
                        k += 2
                        continue
                    break
                k += 1
            i = k + 1
            continue
        if c == '"':
            k = i + 1
            while True:
                k = text.find('"', k)
                if k < 0:
                    raise cq.ScriptError(f'строка {line_at(i)}: не закрыт идентификатор "')
                if text.startswith('""', k):
                    k += 2
                    continue
                break
            i = k + 1
            continue
        if c == "$" and not (i > 0 and (text[i - 1].isalnum() or text[i - 1] in "_$")):
            m = DOLLAR_RE.match(text, i)
            if m:
                k = text.find(m.group(0), m.end())
                if k < 0:
                    raise cq.ScriptError(f"строка {line_at(i)}: не закрыта строка {m.group(0)}")
                i = k + len(m.group(0))
                continue
        if c == "\\" and not text[text.rfind("\n", 0, i) + 1:i].strip():
            raise cq.ScriptError(f"строка {line_at(i)}: команды psql (\\...) не поддерживаются")
        m = WORD_RE.match(text, i)
        if m:
            w = m.group(0).upper()
            if len(words) < 4:
                words.append(w)
            if atomic:
                atomic += 1 if w in ("BEGIN", "CASE") else -1 if w == "END" else 0
            elif w == "ATOMIC" and prev == "BEGIN" and words[0] == "CREATE" and \
                    ("FUNCTION" in words or "PROCEDURE" in words):
                atomic = 1
            prev = w
            i = m.end()
            continue
        if c == ";" and not atomic:
            flush(i)
            start, code, words, prev = i + 1, False, [], ""
        i += 1
    flush(n)
    return out


LEAD_RE = re.compile(r"(?:\s+|--[^\n]*|/\*.*?\*/)*", re.S)


def first_words(stmt, k=2):
    """Первые k слов оператора в верхнем регистре (комментарии в начале пропускаются)."""
    return [w.upper() for w in WORD_RE.findall(stmt[LEAD_RE.match(stmt).end():])[:k]]


def check_script(batches, rollback):
    """С --rollback весь прогон - одна транзакция, которую скрипт откатывает: COMMIT или ROLLBACK в самом
    файле закончили бы ее раньше (и COMMIT сохранил бы изменения). Такие файлы не выполняются."""
    if not rollback:
        return
    for line, stmt in batches:
        w = first_words(stmt)
        if w and (w[0] in ("BEGIN", "START", "COMMIT", "END", "ABORT")
                  or (w[0] == "ROLLBACK" and w[1:] != ["TO"]) or w == ["PREPARE", "TRANSACTION"]):
            raise cq.ScriptError(f"строка {line}: {w[0]} - управление транзакцией в файле; с --rollback "
                                 f"транзакцией управляет скрипт (уберите оператор или запустите без --rollback)")


# ============================================================ типы значений

# Типы, которые читаются в значения Python и дальше идут как у MS SQL Server (канонический текст ядра);
# все остальные (json, массивы, interval, inet, money, timetz, диапазоны, перечисления...) - текстом сервера.
KEEP_TYPES = {"int2", "int4", "int8", "oid", "float4", "float8", "numeric", "bool", "text", "varchar", "bpchar",
              "name", '"char"', "date", "time", "timestamp", "timestamptz", "uuid", "bytea"}


def configure_loaders(conn):
    """Загрузчики типов подключения: KEEP_TYPES - значениями Python, остальное (и все массивы) - текстом.
    'infinity'/'-infinity' в date и timestamp psycopg не читает (в Python нет бесконечной даты): они становятся
    наибольшей/наименьшей датой Python (9999-12-31... / 0001-01-01) - так же, как их обычно хранят в MS SQL Server."""
    import psycopg
    from psycopg.types.string import TextLoader
    from psycopg.types import datetime as pdt

    for t in psycopg.adapters.types:
        if t.name not in KEEP_TYPES:
            conn.adapters.register_loader(t.oid, TextLoader)
        if getattr(t, "array_oid", 0):
            conn.adapters.register_loader(t.array_oid, TextLoader)

    def infinite(base, top, bottom):
        class Loader(base):
            def load(self, data):
                b = bytes(data)
                if b == b"infinity":
                    return top
                if b == b"-infinity":
                    return bottom
                return super().load(data)
        return Loader

    utc = dt.timezone.utc
    conn.adapters.register_loader("date", infinite(pdt.DateLoader, dt.date.max, dt.date.min))
    conn.adapters.register_loader("timestamp", infinite(pdt.TimestampLoader, dt.datetime.max, dt.datetime.min))
    conn.adapters.register_loader("timestamptz", infinite(pdt.TimestamptzLoader, dt.datetime.max.replace(tzinfo=utc),
                                                          dt.datetime.min.replace(tzinfo=utc)))


# Имена типов, которых psycopg не знает (перечисления, домены, свои составные типы, void...): читаются при открытии
# рабочего подключения, до первого оператора (позже запрос на нем стал бы «последним оператором» для Control).
# Строчные типы таблиц и их массивы не читаются: их столько же, сколько таблиц.
TYPE_NAMES_SQL = (
    "SELECT t.oid, format_type(t.oid, NULL) FROM pg_type t "
    "LEFT JOIN pg_class c ON c.oid = t.typrelid "
    "LEFT JOIN pg_type e ON e.oid = t.typelem AND t.typcategory = 'A' "
    "LEFT JOIN pg_class ec ON ec.oid = e.typrelid "
    "WHERE coalesce(c.relkind, 'c') = 'c' AND coalesce(ec.relkind, 'c') = 'c'")


def create_table(n, names, kinds, dinfo):
    """Описание таблицы в синтаксисе PostgreSQL (типы - как их показывает сервер; NULL сервер не сообщает)."""
    cols = ", ".join(f'"{cq.escape(name).replace(chr(34), chr(34) * 2)}" {d[0]}' for name, d in zip(names, dinfo))
    return f"create temp table t{n}({cols})"


# ============================================================ подключение: курсор в виде pyodbc

PLAN_MSG_RE = re.compile(r"duration: ([\d.]+) ms  plan:\n", re.S)      # сообщение auto_explain (log_format text)

class Connection:
    """Подключение psycopg с курсором того же вида, что у pyodbc (ядро работает с ним одинаково): параметры
    execute(sql, *params) - "%s"; сообщения сервера (NOTICE, WARNING) копятся в cursor.messages."""

    def __init__(self, raw):
        self.raw = raw
        self.active = None           # курсор, в который идут сообщения сервера
        self.plan_sink = None        # --explain: планы auto_explain (context, текст) - сюда, а не в сообщения
        raw.add_notice_handler(self.notice)

    def notice(self, d):
        text = d.message_primary or ""
        if self.plan_sink is not None and PLAN_MSG_RE.match(text):
            self.plan_sink(d.context, text)
            return
        cur = self.active
        if cur is not None:
            sev = d.severity_nonlocalized or d.severity or ""
            cur.messages.append((f"[{d.sqlstate or ''}] ({sev})", d.message_primary or ""))

    def cursor(self):
        return Cursor(self)

    def execute(self, sql, *params):
        return self.cursor().execute(sql, *params)

    def rollback(self):
        self.raw.rollback()

    def commit(self):
        self.raw.commit()

    def close(self):
        self.raw.close()


class Cursor:
    """Курсор psycopg в виде pyodbc. Результат оператора целиком приходит в память клиента (libpq хранит его
    компактно, текстом), значения Python создаются блоками при fetchmany - сервер не ждет обработки строк."""

    def __init__(self, conn):
        self.conn, self.cur = conn, conn.raw.cursor()
        self.messages = []

    def execute(self, sql, *params):
        self.messages = []
        self.conn.active = self
        self.cur.execute(sql, params or None)
        return self

    @property
    def description(self):
        return self.cur.description

    @property
    def rowcount(self):
        return self.cur.rowcount

    def fetchmany(self, n):
        return self.cur.fetchmany(n)

    def fetchall(self):
        return self.cur.fetchall()

    def fetchone(self):
        return self.cur.fetchone()

    def nextset(self):
        """Как у pyodbc: сообщения относятся к текущему результату, со следующим - новый список."""
        self.messages = []
        return bool(self.cur.nextset())

    def cancel(self):
        """Отмена текущего оператора из другого потока (отдельный канал libpq с ключом отмены)."""
        self.conn.raw.cancel_safe()

    def close(self):
        if self.conn.active is self:
            self.conn.active = None
        self.cur.close()


# ============================================================ счетчики рабочей сессии

def pgss_schema(query):
    """Схема расширения pg_stat_statements или None (его может не быть, оно бывает в любой схеме)."""
    rows = query("SELECT extnamespace::regnamespace::text FROM pg_extension WHERE extname = 'pg_stat_statements'")
    return rows[0][0] if rows else None


READS_ZERO = (0, 0, 0, 0)     # pg_stat_statements: вызовов, логических чтений, физических чтений, записей
FUNC_SQL = ("SELECT funcid::regprocedure::text, calls, total_time, self_time FROM {view}")
TABLE_SQL = ("SELECT schemaname || '.' || relname, seq_scan, seq_tup_read, coalesce(idx_scan, 0), "
             "coalesce(idx_tup_fetch, 0), n_tup_ins, n_tup_upd, n_tup_del FROM {view}")
FUNC_COLUMNS = ["Функция", "Вызовов", "Время мс", "Собственное время мс"]
TABLE_COLUMNS = ["Таблица", "Seq scan", "Строк seq scan", "Index scan", "Строк index scan",
                 "Вставлено", "Изменено", "Удалено"]
FUNC_FILE, TABLE_FILE = "functions.csv", "tables.csv"
EXIT_WAIT_S = 5               # после закрытия рабочего подключения: ждать конца его процесса (он сбрасывает статистику)


class Control:
    """Контрольное подключение PostgreSQL: время и чтения каждого оператора рабочей сессии.

    Рабочее подключение выполняет операторы по одному, и к замеру (после execute) оператор уже закончен:
    pg_stat_activity рабочей сессии хранит его начало (query_start), конец (state_change) и query_id.
    Время - сумма state_change - query_start по операторам (часы сервера; передача результата клиенту
    входит: результат целиком приходит клиенту до конца оператора). Чтения - разница строки
    pg_stat_statements этого query_id до и после оператора; если calls выросло не на 1, тот же запрос
    в это время выполняли и другие сессии (пометка в сводке). CPU и ожидания клиента по сессии в PostgreSQL нет.

    Вектор - как у MS SQL Server (CTL_ZERO): (CPU, логические чтения, физические чтения, записи, время мс,
    ожидание клиента); отсутствующие счетчики - 0 и в absent. Законченные операторы для выборки (--profile)
    копятся в done.

    --profile: track_functions = 'all' на рабочем подключении (если есть право), счетчики функций и таблиц
    за прогон (extra): с --rollback - из pg_stat_xact_* своей транзакции, без него - разница общей статистики
    сервера до и после прогона."""

    STATE_SQL = ("SELECT state, query_start::timestamp, "
                 "round(extract(epoch FROM state_change - query_start) * 1000000)::bigint, {qid}, query "
                 "FROM pg_stat_activity WHERE pid = %s")
    # логические чтения - все обращения к буферам (как в MS SQL Server, физические в них входят)
    PGSS_SQL = ("SELECT queryid, calls, shared_blks_hit + shared_blks_read + local_blks_hit + local_blks_read, "
                "shared_blks_read + local_blks_read, "
                "shared_blks_written + local_blks_written + temp_blks_written "
                "FROM {schema}.pg_stat_statements(false) WHERE userid = %s AND dbid = %s{top}")

    def __init__(self, conn, spid):
        self.conn, self.spid = conn, spid
        self.lock = threading.Lock()      # подключение общее с потоком выборки (--profile)
        self.version = conn.raw.info.server_version
        self.state_sql = self.STATE_SQL.format(qid="query_id" if self.version >= 140000 else "NULL")
        self.time_us, self.reads = 0, (0, 0, 0)
        self.last = cq.CTL_ZERO
        self.seen = None                  # начало последнего учтенного оператора
        self.done = collections.deque()   # законченные операторы: (начало, мкс, текст, (логические, физические) или None)
        self.failed = False               # замер не удался: законченных операторов больше не будет
        self.mixed = self.unknown = 0
        self.extra = None
        self.plans = []                   # --explain: планы auto_explain текущего оператора (context, мс, текст)
        self.absent = {"cpu": "в PostgreSQL нет счетчика CPU по сессии",
                       "client": "в PostgreSQL нет счетчика ожидания клиента по сессии; время включает передачу результата"}
        rows = self.query("SELECT usesysid, datid FROM pg_stat_activity WHERE pid = %s", spid)
        if not rows:
            raise cq.ControlError("контрольное подключение не видит рабочую сессию в pg_stat_activity")
        self.ids = rows[0]
        self.pgss_sql, self.pgss = None, {}
        why = self.open_pgss()
        if why:
            self.absent["reads"] = why

    def query(self, sql, *params):
        return self.timed_query(sql, *params)[0]

    def timed_query(self, sql, *params):
        """(строки, длительность ответа сервера в мс); ожидание подключения, занятого другим потоком, не входит."""
        with self.lock:
            t = cq.perf()
            cur = self.conn.cursor()
            try:
                cur.execute(sql, *params)
                rows = [tuple(r) for r in cur.fetchall()] if cur.description is not None else []
            finally:
                cur.close()
            return rows, (cq.perf() - t) / 1e6

    def open_pgss(self):
        """Снимок pg_stat_statements рабочего пользователя и базы (без текстов запросов: они читаются с диска).
        Причина, по которой чтений не будет, или None."""
        if self.version < 140000:
            return "нет query_id в pg_stat_activity (PostgreSQL до 14)"
        schema = pgss_schema(self.query)
        if schema is None:
            return "нет расширения pg_stat_statements"
        if self.query("SELECT current_setting('compute_query_id')")[0][0] == "off":
            return "compute_query_id = off"
        err = None
        for top in (" AND toplevel", ""):     # toplevel - с версии расширения 1.9; без него строки и так верхние
            sql = self.PGSS_SQL.format(schema=schema, top=top)
            try:
                rows = self.query(sql, *self.ids)
            except Exception as e:
                err = err or cq.err_text(e)
                continue
            self.pgss_sql = sql + " AND queryid = %s"
            self.pgss = {r[0]: cq.to_counters(r[1:]) for r in rows}
            return None
        return f"pg_stat_statements недоступно: {err}"

    def read(self):
        rows = self.query(self.state_sql, self.spid)
        if not rows:
            raise cq.ControlError("рабочая сессия пропала из pg_stat_activity")
        return rows[0]

    def batch_start(self):
        """Перед оператором: последний оператор сессии (служебный или уже учтенный) не считается."""
        self.plans = []                   # планы служебных операторов не нужны
        row = self.read()
        if row[0] != "active":
            self.seen = row[1]
        return self.last

    def now(self):
        try:
            self.statement(self.read())
        except Exception:
            self.failed = True
            raise
        v = (0,) + self.reads + (self.time_us // 1000, 0)
        self.last = cq.vmax(v, self.last)
        return self.last

    def statement(self, row):
        """Учесть законченный оператор (строка STATE_SQL), если он еще не учтен."""
        state, start, us, qid, text = row
        if state == "active" or start is None or start == self.seen:
            return
        self.seen = start
        us = max(int(us or 0), 0)
        reads = None
        if "reads" not in self.absent:
            rows = self.query(self.pgss_sql, *self.ids, qid) if qid is not None else []
            if not rows:
                self.unknown += 1        # запроса нет в pg_stat_statements (например, track_utility = off)
            else:
                after = cq.to_counters(rows[0][1:])
                before = self.pgss.get(qid, READS_ZERO)
                if after[0] < before[0]:
                    before = READS_ZERO  # строку вытеснили, и она создана заново
                self.pgss[qid] = after
                d = cq.vsub(after, before)
                if d[0] != 1:
                    self.mixed += 1
                self.reads = cq.vadd(self.reads, d[1:])
                reads = d[1:3]
        self.time_us += us
        plan = self.take_plans(text or "")
        self.done.append((start, us, text or "", reads, plan))

    def sampled(self, r):
        """Строка выборки (Sampler.SAMPLE_SQL): здесь ничего, законченные операторы учитывает now() после execute."""

    def live(self, s, t):
        """Счетчики прогона по выборке s без запроса к серверу: время учтенных операторов + текущего."""
        v = self.last[:4] + (self.last[4] + s[5][3], 0)
        return cq.vmax(v, self.last)

    def notes(self):
        out = []
        if self.mixed:
            out.append(f"Чтения: {self.mixed} опер. в это же время выполняли и другие сессии (pg_stat_statements "
                       f"общий для всех сессий), их чтения завышены")
        if self.unknown:
            out.append(f"Чтения: у {self.unknown} опер. нет строки в pg_stat_statements, в сумму они не вошли")
        return out

    # ---------------------------------------------------- --profile: функции и таблицы

    def begin(self, cur, profile, rollback, explain=None):
        """Начало прогона (--profile): track_functions на рабочем подключении и, без --rollback, снимок общей
        статистики функций и таблиц; --explain - auto_explain на рабочем подключении. Ошибки не прерывают
        запуск, а остаются пометкой в реестре."""
        self.rollback = rollback
        if not profile:
            return
        x = self.extra = {"functions": None, "tables": None, "source": "xact" if rollback else "total", "why": {}}
        cur.execute("SELECT current_setting('track_functions')")
        track = cur.fetchone()[0]
        if track != "all":
            err = self.work_try(cur, "SET track_functions = 'all'")
            if err is None:
                track = "all"
            elif track == "none":
                x["why"]["functions"] = f"track_functions = none, включить не удалось: {err}"
        x["track"] = track
        if explain is not None:
            self.explain_on(cur, explain)
        if not rollback:
            self.base = {"functions": self.stats(self.query, FUNC_SQL, "pg_stat_user_functions", "functions"),
                         "tables": self.stats(self.query, TABLE_SQL, "pg_stat_user_tables", "tables")}

    def explain_on(self, cur, min_ms):
        """auto_explain только на рабочем подключении: LOAD (на диск сервера ничего не ставится) и настройки;
        фактические планы операторов, в том числе внутри функций, приходят сообщениями NOTICE (в журнал сервера
        не пишутся: log_min_messages по умолчанию warning). Нужны права суперпользователя."""
        x = self.extra
        x["explain_ms"] = min_ms
        err = self.work_try(cur, "LOAD 'auto_explain'", *[f"SET auto_explain.{k} = {v}" for k, v in (
            ("log_min_duration", int(min_ms)), ("log_analyze", "on"), ("log_buffers", "on"), ("log_timing", "on"),
            ("log_nested_statements", "on"), ("log_format", "text"), ("log_level", "notice"))])
        if err is None:
            x["plans"] = "auto_explain"
            x["nested"] = {}
            cur.conn.plan_sink = self.on_plan
        else:
            x["why"]["plans"] = err

    def on_plan(self, context, text):
        """План auto_explain (поток выполнения оператора): копится до конца оператора верхнего уровня."""
        m = PLAN_MSG_RE.match(text)
        self.plans.append((context, float(m.group(1)), text[m.end():].rstrip()))

    def take_plans(self, text):
        """Конец оператора верхнего уровня: план самого оператора (без context; самый долгий) - в итог оператора,
        планы операторов внутри функций - в extra["nested"]. Служебный батч --ignore in test не учитывается."""
        plans, self.plans = self.plans, []
        if not plans or cq.is_ignored_batch(text):
            return None
        top = None
        for context, ms, plan in plans:
            if not context:
                if top is None or ms >= top[0]:
                    top = (ms, plan)
                continue
            label, line, stmt = plan_place(context, plan)
            h = f"{zlib.crc32(' '.join(stmt.split()).casefold().encode('utf-8', 'surrogatepass')):08x}"
            lr, pr = plan_reads(plan)
            e = self.extra["nested"].setdefault((label, line, h), {
                "label": label, "line": line, "hash": h, "text": stmt, "calls": 0, "ms": 0.0, "max": 0.0,
                "lr": 0, "pr": 0, "plan": None})
            e["calls"] += 1
            e["ms"] += ms
            e["lr"] += lr
            e["pr"] += pr
            if e["plan"] is None or ms >= e["max"]:
                e["max"], e["plan"] = ms, plan
        return top[1] if top else None

    def work_try(self, cur, *sqls):
        """Операторы на рабочем подключении, которые могут не пройти (права). В --rollback ошибка прервала бы
        транзакцию, поэтому они идут под точкой сохранения. Текст ошибки или None."""
        try:
            if self.rollback:
                cur.execute("SAVEPOINT compare_query")
            for sql in sqls:
                cur.execute(sql)
            if self.rollback:
                cur.execute("RELEASE SAVEPOINT compare_query")
            return None
        except Exception as e:
            if self.rollback:
                cur.execute("ROLLBACK TO SAVEPOINT compare_query")
            return cq.err_text(e)

    def stats(self, query, sql, view, what):
        """{имя: счетчики} представления статистики функций или таблиц; None - не получилось или не считается
        (причина в extra)."""
        if what in self.extra["why"]:
            return None
        try:
            return {r[0]: tuple(r[1:]) for r in query(sql.format(view=view))}
        except Exception as e:
            self.extra["why"].setdefault(what, cq.err_text(e))
            return None

    def before_close(self, conn):
        """--profile --rollback: счетчики функций и таблиц своей транзакции (pg_stat_xact_*), до отката."""
        x = self.extra
        if x is None or not self.rollback:
            return

        def query(sql):
            cur = conn.execute(sql)
            return cur.fetchall()
        x["functions"] = self.stats(query, FUNC_SQL, "pg_stat_xact_user_functions", "functions")
        x["tables"] = self.stats(query, TABLE_SQL, "pg_stat_xact_user_tables", "tables")
        if x["tables"] is not None:
            x["tables"] = {k: v for k, v in x["tables"].items() if any(v)}

    def after_close(self):
        """--profile без --rollback: разница общей статистики сервера. Процесс рабочей сессии сбрасывает свою
        статистику при завершении, до того как пропасть из pg_stat_activity, поэтому сначала ждем его конца."""
        x = self.extra
        if x is None or self.rollback:
            return
        end = time.monotonic() + EXIT_WAIT_S
        while self.query("SELECT 1 FROM pg_stat_activity WHERE pid = %s", self.spid) and time.monotonic() < end:
            time.sleep(0.02)
        for what, sql, view in (("functions", FUNC_SQL, "pg_stat_user_functions"),
                                ("tables", TABLE_SQL, "pg_stat_user_tables")):
            before, after = self.base[what], self.stats(self.query, sql, view, what)
            if before is None or after is None:
                continue
            d = {k: tuple(a - b for a, b in zip(v, before.get(k, (0,) * len(v)))) for k, v in after.items()}
            x[what] = {k: v for k, v in d.items() if any(v)}


class SessionControl(Control):
    """--session: подключение наблюдения за чужой сессией spid (выборки, проверка жизни сессии, чтения).

    Конец оператора видит выборка (Sampler.poll -> sampled): строка сессии уже не active, а query_start еще
    не учтен - оператор закончился, его время state_change - query_start точное, чтения - разница строки
    pg_stat_statements его query_id (как у Control, с той же пометкой, если calls выросло не на 1).
    Оператор, который начался и закончился между выборками, виден, только если после него сессия
    простаивала (его строка осталась в pg_stat_activity до выборки)."""

    def __init__(self, conn, spid):
        try:
            super().__init__(conn, spid)
        except cq.ControlError:
            raise cq.ScriptError(f"сессия {spid} не найдена")
        row = self.read()
        if row[4] == "<insufficient privilege>":
            raise cq.ScriptError(f"нет права видеть запросы сессии {spid}: нужна роль pg_read_all_stats "
                                 f"(входит в pg_monitor) или подключение тем же пользователем")
        self.absent = {k: v for k, v in self.absent.items() if k == "reads"}   # CPU и клиент - из выборок
        if row[0] != "active":
            self.seen = row[1]             # последний оператор до наблюдения не считается

    def sampled(self, r):
        """Строка выборки (state, query_start, ..., текст, ..., мкс, query_id): закончившийся оператор - в done."""
        if r is not None:
            self.statement((r[0], r[1], r[8], r[9], r[6]))

    def notes(self):
        out = []
        if self.mixed:
            out.append(f"Чтения: у {self.mixed} опер. тот же запрос (query_id) выполнялся еще раз между выборками "
                       f"(этой сессией или другими), их чтения завышены")
        if self.unknown:
            out.append(f"Чтения: у {self.unknown} опер. нет строки в pg_stat_statements, чтений у них нет")
        return out


def stats_table(columns, rows, ms_cols):
    """CSV счетчиков функций или таблиц: rows - {имя: значения}, по убыванию второго значения;
    ms_cols - номера значений-миллисекунд (с одним знаком после точки)."""
    lines = [cq.DELIM.join(columns)]
    for name, v in sorted(rows.items(), key=lambda x: (-x[1][1], x[0])):
        cells = [name] + [f"{x:.1f}" if i in ms_cols else str(round(x)) for i, x in enumerate(v)]
        lines.append(cq.DELIM.join(cq.format_cell(cq.escape(c)) for c in cells))
    return "\n".join(lines) + "\n"


def registry_extra(extras, median):
    """Файлы functions.csv и tables.csv папки реестра и строки шапки registry.txt по Control.extra прогонов
    (с --repeat - медианы)."""
    xs = [x for x in extras if x is not None]
    if not xs:
        return {}, []
    files, lines = {}, []
    src = ("только операторы скрипта: счетчики своей транзакции (--rollback)" if xs[-1]["source"] == "xact" else
           "разница общей статистики сервера до и после прогона: в нее входит работа других сессий с теми же "
           "функциями и таблицами")
    for what, name, columns, ms_cols, title in (
            ("functions", FUNC_FILE, FUNC_COLUMNS, {1, 2}, "Функции (вызовов, время с вложенными и собственное)"),
            ("tables", TABLE_FILE, TABLE_COLUMNS, set(), "Таблицы (просмотров и строк, изменений)")):
        got = [x[what] for x in xs]
        if any(g is None for g in got):
            why = next((x["why"][what] for x in xs if what in x["why"]), "нет данных")
            lines.append(f"{title}: нет данных ({why})")
            continue
        keys = {k for g in got for k in g}
        n = len(columns) - 1
        rows = {k: tuple(statistics.median([g.get(k, (0,) * n)[i] for g in got]) for i in range(n)) for k in keys}
        files[name] = (name, stats_table(columns, rows, ms_cols))
        note = f", track_functions = {xs[-1]['track']}" if what == "functions" else ""
        lines.append(f"{title}: {name} ({src}{note}{'; медиана прогонов' if median else ''})")
    if xs[-1].get("plans") == "auto_explain":
        nested_files(xs, files, lines)
    return files, lines


# ============================================================ --explain: планы auto_explain

# операторы, у которых есть план (EXPLAIN ANALYZE в отдельном прогоне); CREATE TABLE AS и SELECT INTO тоже
# объясняются, но CREATE без AS - ошибка, поэтому CREATE идет как есть
EXPLAIN_WORDS = {"SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "VALUES", "TABLE", "WITH"}
PLPGSQL_CTX_RE = re.compile(r"PL/pgSQL function (.+?) line (\d+)")
SQLFN_CTX_RE = re.compile(r'SQL function "(.+?)" statement (\d+)')
BUFFERS_RE = re.compile(r"^\s*Buffers: (.*)$", re.M)
NESTED_FILE = "nested.csv"
NESTED_COLUMNS = ["№", "Время мс", "Вызовов", "Макс. время мс", "Логических чтений", "Физических чтений",
                  "Объект", "Строка", "Хэш", "План", "Начало текста"]


def plan_place(context, plan):
    """(функция, строка в ее теле, текст оператора) плана auto_explain оператора внутри функции. context - стек
    сервера, первая строка - самая внутренняя: 'SQL statement "..."' и 'PL/pgSQL function f(integer) line 4 at ...'
    (строка считается от начала тела функции, после $$), у SQL-функции - 'SQL function "f" statement 1'."""
    found = [m for m in (PLPGSQL_CTX_RE.search(context), SQLFN_CTX_RE.search(context)) if m]
    if found:
        m = min(found, key=lambda x: x.start())
        label, line = m.group(1), int(m.group(2))
    else:
        label, line = context.split("\n")[0][:60], 0
    text = ""
    if plan.startswith("Query Text: "):       # текст оператора - до первой строки плана (узел с "(cost=")
        out = []
        for i, s in enumerate(plan[len("Query Text: "):].split("\n")):
            if i and "(cost=" in s:
                break
            out.append(s)
        text = "\n".join(out).strip()
    return label, line, text


def plan_reads(plan):
    """(логические, физические) чтения по первой строке Buffers плана - верхнего узла, с дочерними."""
    m = BUFFERS_RE.search(plan)
    hit = read = 0
    if m:
        for part in m.group(1).split(","):
            words = part.split()
            if words and words[0] in ("shared", "local"):
                for kv in words[1:]:
                    k, _, v = kv.partition("=")
                    if k == "hit":
                        hit += int(v)
                    elif k == "read":
                        read += int(v)
    return hit + read, read


def nested_files(xs, files, lines):
    """nested.csv - операторы внутри функций по планам auto_explain (с --repeat - медианы прогонов) и планы
    верхних PROFILE_PLAN_TOP из них ("nNNN - T.txt"). Время оператора - с вложенными вызовами."""
    got = [x.get("nested") or {} for x in xs]
    rows = []
    for key in {k for g in got for k in g}:
        es = [g.get(key) for g in got]
        row = dict([e for e in es if e][-1])
        for k in ("calls", "ms", "max", "lr", "pr"):
            row[k] = statistics.median([e[k] if e else 0 for e in es])
        rows.append(row)
    rows.sort(key=lambda r: (-r["ms"], r["label"], r["line"]))
    out = [cq.DELIM.join(NESTED_COLUMNS)]
    for i, r in enumerate(rows, 1):
        plan = ""
        if i <= cq.PROFILE_PLAN_TOP and r["plan"]:
            plan = f"n{i:03d} - {round(r['ms'])}.txt"
            files[plan] = (("nested plan", r["label"], r["line"], r["hash"]), r["plan"] + "\n")
        out.append(cq.csv_line([str(i), f"{r['ms']:.1f}", str(round(r["calls"])), f"{r['max']:.1f}",
                                str(round(r["lr"])), str(round(r["pr"])), r["label"], str(r["line"]), r["hash"], plan],
                               r["text"]))
    files[NESTED_FILE] = (NESTED_FILE, "\n".join(out) + "\n")
    lines.append(f"Операторы внутри функций: {NESTED_FILE} ({len(rows)}; по планам auto_explain, время - с вложенными "
                 f"вызовами, строка - в теле функции{'; медиана прогонов' if len(xs) > 1 else ''})")


# ============================================================ выборка: ожидания текущего оператора

def interval_extra(d, state):
    """Ожидания интервала между выборками: время без "CPU" (в выборке оператор не ждал) относится к ожиданию
    выборки: Lock - блокировки, Client - клиент, прочее - тип:событие. state None - оператор не попал ни в одну
    выборку: ожидания неизвестны."""
    ex = cq.new_extra()
    if state is None:
        return ex
    wtype, wevent, _, _, blocking, _ = state
    if blocking:
        ex["blocking"] = d[3]
    w = max(d[3] - d[0], 0)
    if not w:
        return ex
    if wtype == "Lock":
        ex["locks"] = w
    elif wtype == "Client":
        ex["client"] = w
    else:
        ex["waits"][f"{wtype}:{wevent}" if wtype else "(неизвестно)"] = w
    return ex


def parallel_wait(wtype, wevent, workers):
    """Ожидание выборки с учетом процессов-помощников параллельного плана (workers - их ожидания через ","):
    пока ведущий процесс ждет помощников (IPC:ExecuteGather и т. п.), выборка относится к самому частому
    состоянию помощников (CPU - не ждали)."""
    if wtype != "IPC" or not workers:
        return wtype, wevent
    top = collections.Counter(workers.split(",")).most_common(1)[0][0]
    if top == "CPU":
        return None, None
    t, _, e = top.partition(":")
    return t, e


class Sampler(threading.Thread):
    """Раз в PROFILE_INTERVAL_MS читает строку рабочей сессии в pg_stat_activity (состояние, ожидание,
    кто ее блокирует) и передает выборку в StatsBuilder: время оператора раскладывается по ожиданиям.
    Счетчиков CPU и чтений по ходу оператора в PostgreSQL нет: "CPU" - время выборок без ожидания, а точные
    время и чтения оператора приходят от Control, когда оператор закончился (done), - последней выборкой
    этого оператора. Так в реестр попадают и операторы короче интервала выборки (без разбивки по ожиданиям).

    Выборка в том же виде, что у MS SQL Server: ((pid, начало), текст, 0, None, None,
    (CPU, логические, физические, время мс), (wait_event_type, wait_event, state, 0, блокирует других,
    кем заблокирована), время сервера)."""

    # последняя колонка - ожидания процессов-помощников параллельного плана (CPU - помощник не ждет), с PostgreSQL 13:
    # подзапрос читает тот же снимок pg_stat_activity, что и основной запрос (снимок один на транзакцию)
    SAMPLE_SQL = ("SELECT state, query_start::timestamp, wait_event_type, wait_event, clock_timestamp()::timestamp, "
                  "round(extract(epoch FROM clock_timestamp() - query_start) * 1000)::bigint, query, "
                  "CASE WHEN wait_event_type = 'Lock' THEN (pg_blocking_pids(pid))[1] END, "
                  "round(extract(epoch FROM state_change - query_start) * 1000000)::bigint, {qid}, {workers} "
                  "FROM pg_stat_activity a WHERE pid = %s")
    WORKERS_SQL = ("CASE WHEN state = 'active' THEN (SELECT string_agg(coalesce(w.wait_event_type || ':' || w.wait_event, "
                   "'CPU'), ',') FROM pg_stat_activity w WHERE w.leader_pid = a.pid AND w.pid <> a.pid) END")
    # ждет ли кто-то блокировку этой сессии: pg_blocking_pids - только у сессий, которые ждут блокировку
    BLOCKING_SQL = ("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> %s "
                    "AND CASE WHEN wait_event_type = 'Lock' THEN %s = ANY(pg_blocking_pids(pid)) END LIMIT 1")

    def __init__(self, control, lookup, batch_start, sql_name, adhoc_label, on_segment):
        super().__init__(daemon=True)
        self.control, self.lookup = control, lookup
        self.sample_sql = self.SAMPLE_SQL.format(qid="query_id" if control.version >= 140000 else "NULL",
                                                 workers=self.WORKERS_SQL if control.version >= 130000 else "NULL")
        self.any_text = sql_name is None    # --session: SQL-файла нет, оператор - любой запрос сессии
        self.stop_event = threading.Event()
        self.error = None
        self.ignoring = False            # выполняется батч --ignore in test: выборки не учитываются
        self.ignored_requests = set()
        self.slow = self.slow_ms = 0
        self.open = None                 # последняя выборка оператора, который еще не закончился
        self.closed = None               # начало последнего оператора, итог которого пришел от Control
        self.req = None
        self.cpu = self.elapsed = 0
        self.matched = {}                # текст pg_stat_activity -> оператор SQL-файла или None
        self.builder = cq.StatsBuilder(self, batch_start, sql_name, adhoc_label, on_segment)
        self.on_poll = None
        self.event_fields = {}

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

    def match(self, text):
        """Оператор SQL-файла по тексту из pg_stat_activity (он обрезан по track_activity_query_size) или None."""
        if self.any_text:
            return text
        if text not in self.matched:
            starts = self.builder.batch_start
            found = text if text in starts else None
            if found is None and text:
                cands = [t for t in starts if t.startswith(text)]
                found = cands[0] if len(cands) == 1 else None
            self.matched[text] = found
        return self.matched[text]

    def describe(self, s, batch_start, sql_name, adhoc_label):
        text = self.match(s[1]) or s[1] or ""
        if text in batch_start:
            label, line = sql_name, batch_start[text]
        else:
            label, line = adhoc_label, 1
        h = f"{zlib.crc32(' '.join(text.split()).casefold().encode('utf-8', 'surrogatepass')):08x}"
        return {"key": (label, line, h), "label": label, "line": line, "hash": h, "text": text, "start": 0, "end": None}

    @staticmethod
    def interval_extra(d, state):
        return interval_extra(d, state)

    def timed_query(self, sql):
        rows, d = self.control.timed_query(sql, self.control.spid)
        if d > cq.SAMPLE_SLOW_MS:
            self.slow += 1
            self.slow_ms += round(d)
            cq.Events.emit("slow", count=self.slow, ms=self.slow_ms, **self.event_fields)
        return rows

    def poll(self):
        """Одна выборка: (выборка или None, если оператора нет; задержка до следующей, мс)."""
        rows = self.timed_query(self.sample_sql)
        r = rows[0] if rows else None
        self.control.sampled(r)   # --session: оператор, закончившийся к этой выборке, - в done
        self.take_done()       # операторы, закончившиеся до этой выборки (Control добавляет их до следующего)
        if r is None or r[0] != "active" or r[1] is None or self.match(r[6] or "") is None \
                or (self.closed is not None and r[1] <= self.closed):
            # оператора нет, он не из SQL-файла (служебный запрос скрипта) или уже закончился: его итог
            # пришел от Control между этой выборкой и take_done
            self.no_request()
            return None, cq.PROFILE_INTERVAL_MS
        state, start, wtype, wevent, now, elapsed, text, by = r[:8]
        wtype, wevent = parallel_wait(wtype, wevent, r[10])
        req = (self.control.spid, start)
        if self.ignoring or req in self.ignored_requests:    # батч --ignore in test
            self.ignored_requests.add(req)
            self.no_request()
            return None, cq.PROFILE_INTERVAL_MS
        blocking = 1 if self.control.query(self.BLOCKING_SQL, self.control.spid, self.control.spid) else 0
        if req != self.req:
            self.req, self.cpu, self.elapsed = req, 0, 0
        elapsed = max(int(elapsed or 0), self.elapsed)
        if not wtype:
            self.cpu += elapsed - self.elapsed
        self.elapsed = elapsed
        s = (req, text, 0, None, None, (self.cpu, 0, 0, elapsed),
             (wtype, wevent, state, 0, blocking, int(by) if by else None), now)
        if self.open is not None and self.open[0] != req:
            self.end_open()    # конец предыдущего оператора без записи Control (замер не удался)
        self.open = s
        self.builder.feed(s)
        return s, cq.PROFILE_INTERVAL_MS

    def no_request(self):
        """Оператора нет. Если выборки шли по оператору, который закончился, его итог еще придет от Control
        (замер после execute): до этого выборка "нет запроса" не передается."""
        if self.open is not None and not self.control.failed:
            return
        self.end_open()

    def end_open(self):
        self.open = None
        self.builder.idle()

    def take_done(self):
        """Законченные операторы от Control: последняя выборка оператора с точными временем и чтениями."""
        while self.control.done:
            start, us, text, reads, plan = self.control.done.popleft()
            self.closed = start
            req = (self.control.spid, start)
            if req in self.ignored_requests or cq.is_ignored_batch(text) or self.match(text) is None:
                if self.open is not None and self.open[0] == req:
                    self.end_open()
                continue
            ms = round(us / 1000)
            o = self.open
            if o is not None and o[0] == req:
                state = o[6]           # хвост после последней выборки - к ее ожиданию
                cpu = o[5][0] + (0 if state[0] else max(ms - o[5][3], 0))
            else:
                if o is not None:
                    self.end_open()
                cpu, state = 0, None   # оператор целиком между выборками: ожидания неизвестны
            lr, pr = reads or (0, 0)
            # план оператора (--explain) - в поле plan_handle: у PostgreSQL это сам текст плана (PostgreSQL.plan)
            end = start + dt.timedelta(microseconds=us)
            self.builder.feed((req, text, 0, None, plan, (cpu, lr, pr, ms), state, end))
            self.end_open()

    def now(self, s):
        """Текущий оператор выборки s для событий --events: {key, label, line, text, wait, blocked_by}."""
        if s is None:
            return {"key": ("нет запроса",), "label": None, "line": 0, "text": "", "wait": "", "blocked_by": None}
        st = self.builder.statement(s)
        wait = f"{s[6][0]}:{s[6][1]}" if s[6][0] else ""
        return {"key": (s[0], st["key"]), "label": st["label"], "line": st["line"], "text": st["text"],
                "wait": wait, "blocked_by": s[6][5]}

    def finish(self, wait_s=None):
        self.take_done()
        if self.open is not None:
            self.end_open()
        self.builder.idle()

    def stop(self):
        self.stop_event.set()
        self.join()


# ============================================================ запросы просмотра сервера (GUI, --show)

SERVICE_APPS = tuple(f"{cq.APP_NAME} {x}" for x in ("control", "session", "gui", "show"))
GUI_TIMEOUT_S = 20            # отдельные подключения GUI (оценочный план): таймаут запроса, с
SESSIONS_COLS = ("spid", "db", "program", "host", "login", "elapsed", "proc")
SESSIONS_SQL = (
    "SELECT pid, datname, application_name, coalesce(client_hostname, host(client_addr)), usename, "
    "CASE WHEN state = 'active' THEN round(extract(epoch FROM clock_timestamp() - query_start) * 1000)::bigint END, "
    "NULL FROM pg_stat_activity "
    "WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() AND coalesce(application_name, '') <> ALL(%s)")

# «Текущие запросы»: все клиентские сессии одним чтением pg_stat_activity (общая память сервера, без блокировок);
# кто кого блокирует - pg_blocking_pids только у ждущих блокировку (функция ненадолго берет менеджер блокировок,
# поэтому не для всех сессий). В список - сессии с запросом или в транзакции и те, кто блокирует других.
CURRENT_SQL = (
    "SELECT pid, datname, usename, coalesce(client_hostname, host(client_addr)), application_name, state, "
    "round(extract(epoch FROM clock_timestamp() - query_start) * 1000)::bigint, "
    "wait_event_type, wait_event, "
    "CASE WHEN wait_event_type = 'Lock' THEN array_to_string(pg_blocking_pids(pid), ',') END, "
    "xact_start IS NOT NULL, round(extract(epoch FROM clock_timestamp() - state_change))::bigint, query, "
    "backend_type, query_id "
    "FROM pg_stat_activity "
    "WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() AND coalesce(application_name, '') <> ALL(%s)")
CURRENT_SQL_OLD = CURRENT_SQL.replace(", query_id ", ", NULL ")      # query_id - с PostgreSQL 14

# «Тяжелые запросы» - pg_stat_statements, если расширение есть. Времени последнего выполнения в нем нет, поэтому
# --hours не поддерживается. Выражения сортировки подставляются только из словаря. Чтение с текстами запросов
# читает файл текстов сервера целиком - только по кнопке.
HEAVY_ORDER = {
    "time": "{t}", "time_avg": "{t} / nullif(calls, 0)",
    "reads": "shared_blks_hit + shared_blks_read", "reads_avg": "(shared_blks_hit + shared_blks_read) / nullif(calls, 0)",
    "writes": "shared_blks_written", "execs": "calls", "max_time": "{m}",
}
HEAVY_SQL = (
    "SELECT calls, round({t})::bigint, round({m})::bigint, shared_blks_hit + shared_blks_read, shared_blks_read, "
    "shared_blks_written, rows, d.datname, query "
    "FROM {schema}.pg_stat_statements s LEFT JOIN pg_database d ON d.oid = s.dbid {where}"
    "ORDER BY {order} DESC NULLS LAST LIMIT %s")
HEAVY_COLS = ("execs", "time", "max_time", "reads", "physical", "writes", "rows", "db", "statement")
# --show heavy --interval: снимок без текстов (pg_stat_statements(false) не читает файл текстов), тексты - для первых
HEAVY_DELTA_SQL = ("SELECT userid, dbid, queryid, {top}, calls, round({t})::bigint, shared_blks_hit + shared_blks_read, "
                   "shared_blks_read, shared_blks_written, rows FROM {schema}.pg_stat_statements(false)")
HEAVY_DELTA_COLS = ("userid", "dbid", "queryid", "top", "execs", "time", "reads", "physical", "writes", "rows")
HEAVY_TEXT_SQL = ("SELECT s.userid, s.dbid, s.queryid, d.datname, s.query FROM {schema}.pg_stat_statements s "
                  "LEFT JOIN pg_database d ON d.oid = s.dbid WHERE s.queryid = ANY(%s::bigint[])")

# --show tables, functions, io: накопительные счетчики текущей базы (tables, functions) и сервера (io); размер
# таблицы - оценка по pg_class.relpages (pg_relation_size встал бы в очередь за AccessExclusiveLock)
TABLES_SQL = (
    "SELECT t.schemaname || '.' || t.relname, coalesce(t.seq_tup_read, 0) + coalesce(t.idx_tup_fetch, 0), "
    "t.seq_scan, t.seq_tup_read, coalesce(t.idx_scan, 0), coalesce(t.idx_tup_fetch, 0), "
    "t.n_tup_ins, t.n_tup_upd, t.n_tup_del, "
    "coalesce(io.heap_blks_read, 0) + coalesce(io.idx_blks_read, 0), coalesce(io.heap_blks_hit, 0) + coalesce(io.idx_blks_hit, 0), "
    "t.n_live_tup, t.n_dead_tup, round(c.relpages::numeric * current_setting('block_size')::int / 1048576, 1), "
    "greatest(t.last_vacuum, t.last_autovacuum)::timestamp(0), greatest(t.last_analyze, t.last_autoanalyze)::timestamp(0) "
    "FROM pg_stat_user_tables t JOIN pg_statio_user_tables io ON io.relid = t.relid JOIN pg_class c ON c.oid = t.relid")
FUNCS_SQL = "SELECT funcid::regprocedure::text, calls, round(total_time)::bigint, round(self_time)::bigint FROM pg_stat_user_functions"
IO_SQL = ("SELECT backend_type, object, context, reads, round(read_time)::bigint, writes, round(write_time)::bigint, "
          "extends, hits, evictions, fsyncs FROM pg_stat_io")
# GUI «База данных» (GUI.md §5.28): только каталог и статистика, без функций размеров отношений
DATABASES_SQL = ("SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate "
                 "AND has_database_privilege(datname, 'CONNECT') ORDER BY datname")
SPACE_DB_SQL = ("SELECT d.datname, t.spcname, CASE WHEN has_database_privilege(d.oid, 'CONNECT') "
                "OR pg_has_role('pg_read_all_stats', 'MEMBER') THEN pg_database_size(d.oid) / 1048576.0 END "
                "FROM pg_database d JOIN pg_tablespace t ON t.oid = d.dattablespace WHERE NOT d.datistemplate "
                "ORDER BY 3 DESC NULLS LAST")
# свои табличные пространства (pg_default - те же базы, pg_global - каталог сервера)
SPACE_TS_SQL = ("SELECT spcname, pg_tablespace_size(oid) / 1048576.0, NULL FROM pg_tablespace "
                "WHERE spcname NOT IN ('pg_default', 'pg_global') ORDER BY 2 DESC")
SPACE_WAL_SQL = "SELECT 'pg_wal', sum(size) / 1048576.0, count(*) FROM pg_ls_waldir()"
# слот держит WAL от restart_lsn (неактивный слот - WAL копится, пока не кончится место)
SPACE_SLOTS_SQL = ("SELECT slot_name, CASE WHEN pg_is_in_recovery() THEN NULL "
                   "ELSE pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) / 1048576.0 END, active "
                   "FROM pg_replication_slots")
TABLE_SIZES_SQL = (
    "SELECT c.oid, n.nspname || '.' || c.relname, "
    "(c.relpages + coalesce(tc.relpages, 0) + coalesce(ix.pages, 0))::numeric * b.bs / 1048576, "
    "c.relpages::numeric * b.bs / 1048576, coalesce(ix.pages, 0)::numeric * b.bs / 1048576, "
    "coalesce(tc.relpages, 0)::numeric * b.bs / 1048576, "
    "t.n_live_tup, t.n_dead_tup, t.seq_scan, t.seq_tup_read, t.idx_scan, t.idx_tup_fetch, "
    "t.n_tup_ins, t.n_tup_upd, t.n_tup_del, "
    "greatest(t.last_vacuum, t.last_autovacuum)::timestamp(0), "
    "greatest(t.last_analyze, t.last_autoanalyze)::timestamp(0), sp.spcname "
    "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
    "LEFT JOIN pg_stat_user_tables t ON t.relid = c.oid "
    "LEFT JOIN pg_class tc ON tc.oid = c.reltoastrelid "
    "LEFT JOIN (SELECT i.indrelid, sum(ic.relpages) pages FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid "
    "  GROUP BY i.indrelid) ix ON ix.indrelid = c.oid "
    "LEFT JOIN pg_tablespace sp ON sp.oid = c.reltablespace "
    "CROSS JOIN (SELECT current_setting('block_size')::int bs) b "
    "WHERE c.relkind IN ('r', 'p', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema') "
    "AND n.nspname !~ '^pg_(toast|temp)'")
# индексы таблицы: столбцы (pg_get_indexdef по номеру - столбец или выражение; первые indnkeyatts - ключ, дальше
# INCLUDE; DESC - indoption), условие частичного индекса и корреляция первого столбца ключа (pg_stats: 1 или -1 - строки таблицы
# лежат в порядке индекса; только при праве чтения столбца и после ANALYZE)
INDEXES_SQL = (
    "SELECT c.relname, am.amname, x.indisunique, x.indisprimary, "
    "c.relpages::numeric * current_setting('block_size')::int / 1048576, s.idx_scan, s.idx_tup_read, s.idx_tup_fetch, "
    "x.indnkeyatts, (SELECT string_agg(pg_get_indexdef(x.indexrelid, k, true) "
    "  || CASE WHEN k <= x.indnkeyatts AND x.indoption[k - 1] & 1 = 1 THEN ' DESC' ELSE '' END, chr(1) ORDER BY k) "
    "  FROM generate_series(1, x.indnatts) k), pg_get_expr(x.indpred, x.indrelid), x.indisclustered, "
    "(SELECT st.correlation FROM pg_attribute a JOIN pg_stats st ON st.attname = a.attname "
    "  AND st.schemaname = tn.nspname AND st.tablename = t.relname "
    "  WHERE a.attrelid = x.indrelid AND a.attnum = x.indkey[0] ORDER BY st.inherited LIMIT 1) "
    "FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid JOIN pg_am am ON am.oid = c.relam "
    "JOIN pg_class t ON t.oid = x.indrelid JOIN pg_namespace tn ON tn.oid = t.relnamespace "
    "LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = x.indexrelid WHERE x.indrelid = %s ORDER BY c.relname")
# столбцы таблицы: средний размер значения, доля NULL и число различных значений - статистика ANALYZE (pg_stats,
# только столбцы с правом чтения); n_distinct < 0 - доля от числа строк
COLUMNS_SQL = (
    "SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attlen, st.avg_width, st.null_frac, "
    "st.n_distinct, t.reltuples "
    "FROM pg_attribute a JOIN pg_class t ON t.oid = a.attrelid JOIN pg_namespace n ON n.oid = t.relnamespace "
    "LEFT JOIN LATERAL (SELECT s.avg_width, s.null_frac, s.n_distinct FROM pg_stats s WHERE s.schemaname = n.nspname "
    "  AND s.tablename = t.relname AND s.attname = a.attname ORDER BY s.inherited LIMIT 1) st ON true "
    "WHERE a.attrelid = %s AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum")
# SQL создания таблицы (кнопка у строки «Таблиц»). pg_dump - внешняя программа, функции pg_get_tabledef в
# PostgreSQL нет, поэтому скрипт собирается по каталогу из того, что сервер сам выводит текстом: format_type,
# pg_get_expr (DEFAULT, вычисляемые, границы секций), pg_get_constraintdef, pg_get_indexdef, pg_get_triggerdef,
# pg_get_partkeydef, pg_get_viewdef; имена - quote_ident/format('%I')
DDL_TABLE_SQL = (
    "SELECT format('%%I.%%I', n.nspname, c.relname), c.relkind, c.relpersistence, c.relispartition, "
    "(SELECT format('%%I.%%I', pn.nspname, p.relname) FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent "
    "  JOIN pg_namespace pn ON pn.oid = p.relnamespace WHERE i.inhrelid = c.oid AND c.relispartition), "
    "CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound, c.oid) END, "
    "CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END, "
    "(SELECT string_agg(format('%%I.%%I', pn.nspname, p.relname), ', ' ORDER BY i.inhseqno) FROM pg_inherits i "
    "  JOIN pg_class p ON p.oid = i.inhparent JOIN pg_namespace pn ON pn.oid = p.relnamespace "
    "  WHERE i.inhrelid = c.oid AND NOT c.relispartition), "
    "(SELECT quote_ident(spcname) FROM pg_tablespace WHERE oid = c.reltablespace), array_to_string(c.reloptions, ', '), "
    "obj_description(c.oid, 'pg_class'), CASE WHEN c.relkind = 'm' THEN pg_get_viewdef(c.oid, true) END, current_database() "
    "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = %s")
DDL_COLUMNS_SQL = (
    "SELECT quote_ident(a.attname), format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid), "
    "a.attidentity, a.attgenerated, "
    "(SELECT format('%%I.%%I', cn.nspname, co.collname) FROM pg_collation co JOIN pg_namespace cn ON cn.oid = co.collnamespace "
    "  WHERE co.oid = a.attcollation AND a.attcollation <> t.typcollation), "
    "col_description(a.attrelid, a.attnum), a.attislocal "
    "FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid "
    "LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum "
    "WHERE a.attrelid = %s AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum")
# ограничения своей таблицы (не унаследованные); NOT NULL (у PostgreSQL 18 - тоже ограничение) - в столбце
DDL_CONSTRAINTS_SQL = (
    "SELECT quote_ident(conname), contype, pg_get_constraintdef(oid, true), obj_description(oid, 'pg_constraint') "
    "FROM pg_constraint WHERE conrelid = %s AND contype IN ('p', 'u', 'c', 'x', 'f') AND conislocal "
    "ORDER BY position(contype IN 'pucxf'), conname")
# индексы, кроме созданных ограничениями и индексов секций (их создает индекс секционированной таблицы)
DDL_INDEXES_SQL = (
    "SELECT pg_get_indexdef(x.indexrelid), obj_description(x.indexrelid, 'pg_class'), format('%%I.%%I', n.nspname, c.relname) "
    "FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace "
    "WHERE x.indrelid = %s AND NOT c.relispartition AND NOT EXISTS (SELECT 1 FROM pg_constraint k "
    "  WHERE k.conindid = x.indexrelid AND k.conrelid = x.indrelid AND k.contype IN ('p', 'u', 'x')) ORDER BY c.relname")
DDL_TRIGGERS_SQL = ("SELECT pg_get_triggerdef(oid, true), quote_ident(tgname), tgenabled FROM pg_trigger "
                    "WHERE tgrelid = %s AND NOT tgisinternal AND tgparentid = 0 ORDER BY tgname")
# триггеры таблицы (подтаблица «Таблиц»): tgtype - биты вида и событий, статистика - функции триггера
# (pg_stat_user_functions, только при track_functions; функция может служить нескольким таблицам)
TRIGGERS_SQL = (
    "SELECT t.tgname, t.tgenabled, t.tgtype, p.oid::regprocedure::text, pg_get_triggerdef(t.oid, true), "
    "pg_get_functiondef(t.tgfoid), f.calls, f.total_time, f.self_time, current_setting('track_functions') "
    "FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid LEFT JOIN pg_stat_user_functions f ON f.funcid = t.tgfoid "
    "WHERE t.tgrelid = %s AND NOT t.tgisinternal ORDER BY t.tgname")
TMP_FILES_SQL = "SELECT name, size FROM pg_ls_tmpdir()"
TMP_ACT_SQL = ("SELECT pid, datname, usename, application_name, state, "
               "round(extract(epoch FROM clock_timestamp() - query_start) * 1000)::bigint, query "
               "FROM pg_stat_activity WHERE pid = ANY(%s)")
TMP_DB_SQL = ("SELECT datname, temp_files, temp_bytes / 1048576.0, stats_reset::timestamp(0) FROM pg_stat_database "
              "WHERE datname IS NOT NULL AND temp_files > 0 ORDER BY temp_bytes DESC")


def num1(v):
    return round(float(v), 1) if v is not None else None


SINCE = "С последнего сброса статистики сервера (накопительные счетчики; что сейчас - --interval S)"
STATS_SPEC = {      # колонки строки, ключ для разницы снимков, накопительные счетчики, сортировка
    "tables": {"cols": ("table", "reads", "seq_scan", "seq_rows", "idx_scan", "idx_rows", "ins", "upd", "del",
                        "blks_read", "blks_hit", "live", "dead", "mb", "vacuum", "analyze"),
               "key": ("table",), "counters": ("reads", "seq_scan", "seq_rows", "idx_scan", "idx_rows", "ins", "upd", "del",
                                               "blks_read", "blks_hit"), "order": "reads", "since": SINCE},
    "functions": {"cols": ("function", "calls", "time", "self_time"), "key": ("function",),
                  "counters": ("calls", "time", "self_time"), "order": "time", "since": SINCE},
    "io": {"cols": ("backend", "object", "context", "reads", "read_ms", "writes", "write_ms", "extends", "hits",
                    "evictions", "fsyncs"), "key": ("backend", "object", "context"),
           "counters": ("reads", "read_ms", "writes", "write_ms", "extends", "hits", "evictions", "fsyncs"),
           "order": "reads", "since": SINCE},
}
# --show waits: активные клиентские сессии (и процессы-помощники параллельных планов) раз в WAIT_SAMPLE_MS
WAITS_SQL = ("SELECT pid, coalesce(wait_event_type || ':' || wait_event, 'CPU'), datname, query FROM pg_stat_activity "
             "WHERE state = 'active' AND backend_type IN ('client backend', 'parallel worker') AND pid <> pg_backend_pid() "
             "AND coalesce(application_name, '') <> ALL(%s)")
WAIT_SAMPLE_MS = 100

SHOW_COLUMNS = {
    "sessions": [("spid", "Сессия", True), ("db", "База", True), ("login", "Логин", True), ("host", "Компьютер", True),
                 ("program", "Программа", True), ("elapsed", "Запрос идет мс", True)],
    "current": [("spid", "Сессия", True), ("db", "База", True), ("login", "Логин", True), ("host", "Компьютер", False),
                ("program", "Программа", False), ("status", "Состояние", True), ("elapsed", "Время мс", True),
                ("wait", "Ожидание", True), ("blocked_by", "Ждет сессию", True), ("blocks", "Блокирует сессий", True),
                ("trans", "Транзакций", False), ("idle_s", "Простой с", False), ("query_id", "query_id", False),
                ("statement", "Запрос", True)],
    "heavy": [("execs", "Выполнений", True), ("time", "Время мс", True), ("max_time", "Макс. время мс", False),
              ("reads", "Логических чтений", True), ("physical", "Физических чтений", False),
              ("writes", "Записей", False), ("rows", "Строк", False), ("db", "База", True),
              ("statement", "Запрос", True)],
    "tables": [("table", "Таблица", True), ("reads", "Строк прочитано", True), ("seq_scan", "Seq scan", True),
               ("seq_rows", "Строк seq scan", False), ("idx_scan", "Index scan", True), ("idx_rows", "Строк index scan", False),
               ("ins", "Вставлено", True), ("upd", "Изменено", True), ("del", "Удалено", True),
               ("blks_read", "Блоков с диска", False), ("blks_hit", "Блоков из кэша", False), ("live", "Живых строк", False),
               ("dead", "Мертвых строк", True), ("mb", "МБ (оценка)", False), ("vacuum", "Последний vacuum", False),
               ("analyze", "Последний analyze", False)],
    "functions": [("function", "Функция", True), ("calls", "Вызовов", True), ("time", "Время мс", True),
                  ("self_time", "Собственное время мс", True)],
    "io": [("backend", "Процесс", True), ("object", "Объект", True), ("context", "Контекст", True),
           ("reads", "Чтений", True), ("read_ms", "Чтение мс", True), ("writes", "Записей", True),
           ("write_ms", "Запись мс", True), ("extends", "Расширений", False), ("hits", "Из кэша", True),
           ("evictions", "Вытеснений", False), ("fsyncs", "fsync", False)],
    "waits": [("wait", "Ожидание", True), ("time", "Время мс (оценка)", True), ("share", "Доля %", True),
              ("sessions", "Сессий", True), ("samples", "Выборок", False), ("db", "База", False),
              ("statement", "Пример запроса", True)],
    "space": [("name", "Объект", True), ("kind", "Вид", True),
              ("place", "Табличное пространство", True), ("size_mb", "Размер МБ", True),
              ("extra", "WAL: файлов, слот: активен", True)],
    "temp": [("spid", "Сессия", True), ("db", "База", True), ("login", "Логин", True), ("program", "Программа", False),
             ("status", "Состояние", False), ("elapsed", "Запрос идет мс", False), ("files", "Временных файлов", True),
             ("total_mb", "Всего МБ", True), ("text", "Запрос", True)],
}


# ============================================================ диалект

PARALLEL_NOTE = ("Параллельный план: пока оператор ждет процессы-помощники (IPC), выборка относится к их самому "
                 "частому ожиданию (CPU, если они не ждали)")


class PostgreSQL:
    """PostgreSQL для ядра CompareQuery: те же методы, что у cq_mssql.MSSQL. Методы с аргументом query получают
    функцию query(sql, *params, sets=1) уже открытого подключения; параметры в SQL - %s."""

    name = "PostgreSQL"
    plan_ext = ".txt"
    can_cancel = True                # pg_cancel_backend: отменить запрос, сессия остается
    Control, Sampler, SessionControl = Control, Sampler, SessionControl
    Lookup = None                    # текст оператора есть в самой выборке (pg_stat_activity.query)
    no_session = None                # --session поддерживается
    can_explain = True
    can_estimate = True              # оценочный план по кнопке GUI (estimate_plan)
    heavy_hours = False              # в pg_stat_statements нет времени последнего выполнения
    heavy_interval = True            # вместо него - разница двух снимков (heavy_delta)
    # колонки экранов GUI, которых у СУБД нет: счетчики запроса и исходный запрос (он же query), время в кэше
    gui_absent = {"current": ["cpu", "reads", "writes", "memory", "input"],
                  "heavy": ["cpu", "cpu_avg", "last", "created"]}
    registry_notes = [
        "Время: по часам сервера (pg_stat_activity), без ожидания клиента (Client: ClientWrite - передача результата)",
        "CPU: оценка - время выборок, в которых оператор не ждал (в PostgreSQL нет счетчика CPU по сессии)",
        "Оператор короче интервала выборки: время и чтения точные, ожидания неизвестны (CPU 0, ожиданий 0)",
        PARALLEL_NOTE,
    ]
    session_notes = [                # --session: строки шапки registry.txt
        "Операторы: запросы, которые прислал клиент (pg_stat_activity.query), без операторов внутри функций",
        "Время: по часам сервера (pg_stat_activity), без ожидания клиента (Client: ClientWrite - передача "
        "результата)",
        "CPU: оценка - время выборок, в которых оператор не ждал (в PostgreSQL нет счетчика CPU по сессии)",
        "Конец оператора попал в выборку (после него сессия простаивала): время точное, чтения - по "
        "pg_stat_statements; не попал (следующий оператор начался до выборки): время - до последней выборки, "
        "чтений нет",
        "Оператор короче интервала выборки виден, только если после него сессия простаивала (ожидания у него "
        "неизвестны)",
        PARALLEL_NOTE,
    ]
    registry_blank = ("Выделено памяти МБ",)
    registry_extra = staticmethod(registry_extra)
    show_columns = SHOW_COLUMNS
    heavy_orders = tuple(HEAVY_ORDER)
    LOCK_TIMEOUT_MS = 3000           # служебные подключения: не ждать за чужими блокировками (каталог, размеры)

    def __init__(self, settings):
        self.settings = settings
        self.version = None          # server_version_num последнего подключения
        self.type_names = {}         # oid -> имя типа, которого psycopg не знает (open_work)

    sample_connection_string = staticmethod(sample_connection_string)
    split_script = staticmethod(split_statements)
    check_script = staticmethod(check_script)
    create_table = staticmethod(create_table)

    # ---------------------------------------------------- подключение

    @staticmethod
    def driver():
        try:
            import psycopg
        except ImportError:
            raise cq.ScriptError('не установлен модуль psycopg: pip install "psycopg[binary]"')
        return psycopg

    @property
    def Error(self):
        return self.driver().Error

    def connect(self, app, autocommit=True, timeout=0, query_timeout=0, dbname=None):
        """Подключение с именем программы app (application_name, если его нет в строке); логин и пароль из настроек -
        отдельными параметрами. timeout - на вход, query_timeout - на запрос (с); dbname - другая база вместо базы
        строки подключения. Служебные подключения (не рабочее) не ждут чужих блокировок дольше LOCK_TIMEOUT_MS.
        Ошибка драйвера - как есть (Error)."""
        psycopg = self.driver()
        s = self.settings
        info = parse_conninfo(s["connection_string"])
        kw = {"autocommit": autocommit, "prepare_threshold": None}
        if dbname:
            kw["dbname"] = dbname
        if "application_name" not in info:
            kw["application_name"] = app
        if s.get("login"):
            if "user" in info or "password" in info:
                raise cq.ScriptError("строка подключения уже содержит user или password, а в настройках задан login: "
                                     "оставьте что-то одно")
            kw["user"] = s["login"]
            kw["password"] = s.get("password") or None
        if timeout:
            kw["connect_timeout"] = int(timeout)
        raw = psycopg.connect(s["connection_string"], **kw)
        try:
            configure_loaders(raw)
            self.version = raw.info.server_version
            sets = []
            if query_timeout:
                sets.append(f"SET statement_timeout = {int(query_timeout) * 1000}")
            if app != cq.APP_NAME:
                sets.append(f"SET lock_timeout = {self.LOCK_TIMEOUT_MS}")
            for x in sets:
                raw.execute(x)
            if not autocommit and sets:
                raw.commit()
        except Exception:
            raw.close()
            raise
        return Connection(raw)

    def open_work(self, rollback):
        conn = self.connect(cq.APP_NAME, autocommit=not rollback, query_timeout=cq.QUERY_TIMEOUT)
        known = self.driver().adapters.types
        try:
            self.type_names = {oid: name for oid, name in conn.execute(TYPE_NAMES_SQL).fetchall()
                               if known.get(oid) is None}
            if rollback:
                conn.rollback()      # транзакция прогона начнется с первого оператора
        except Exception:
            conn.close()
            raise
        return conn

    @staticmethod
    def server_info(conn):
        i = conn.raw.info
        return {"server": i.host or "localhost", "database": i.dbname, "dbms": "PostgreSQL",
                "version": i.parameter_status("server_version") or str(i.server_version)}

    @staticmethod
    def session_id(cur):
        """pg_backend_pid() подключения; тем же запросом - часы сервера (время сессии сервера, ServerTime)."""
        t = cq.perf()
        row = cur.execute("SELECT pg_backend_pid(), clock_timestamp()::timestamp").fetchone()
        cq.ServerTime.set(row[1], (t + cq.perf()) // 2)
        return int(row[0])

    @staticmethod
    def end_transaction(conn):
        """После прерванного оператора без --rollback: транзакция, открытая самим файлом (BEGIN), после ошибки
        стоит прерванной и держит блокировки до ROLLBACK."""
        import psycopg
        if conn.raw.info.transaction_status != psycopg.pq.TransactionStatus.IDLE:
            conn.raw.execute("ROLLBACK")

    @staticmethod
    def message(kind, text):
        """Сообщение сервера (NOTICE, WARNING, INFO...) для показа: (текст, ошибка). Ошибки в PostgreSQL приходят
        исключением, не сообщением."""
        m = re.search(r"\((\w+)\)", kind or "")
        sev = m.group(1) if m else ""
        return (text if sev in ("NOTICE", "INFO", "LOG", "") else f"{sev}: {text}"), False

    def column_info(self, desc):
        """Описание колонок: (тип, как его показывает сервер; размер varchar/char; точность; масштаб; NULL - нет).
        Тип, которого psycopg не знает, он показывает номером - тогда имя из type_names (open_work)."""
        out = []
        for d in desc:
            name = d.type_display
            if name == str(d.type_code):
                name = self.type_names.get(d.type_code, name)
            out.append((name, d.display_size, d.precision, d.scale, d.null_ok))
        return out

    @staticmethod
    def plan(query, plan_handle, start, end):
        """План оператора реестра: у PostgreSQL в plan_handle уже текст плана auto_explain (или None)."""
        return plan_handle if isinstance(plan_handle, str) else None

    def explain_pass(self, batches, extras, rollback, min_ms):
        """--explain после прогонов: ({строка оператора: план}, строки шапки реестра, пометка для отчета).
        Если auto_explain сработал, планы уже в реестре. Иначе с --rollback - отдельный прогон: операторы
        с планом (EXPLAIN_WORDS) - как EXPLAIN (ANALYZE, BUFFERS), остальные (DDL, служебные батчи) - как есть,
        в одной транзакции с откатом. Без --rollback отдельного прогона нет: изменения данных выполнились бы
        второй раз."""
        xs = [x for x in extras if x is not None]
        if xs and xs[-1].get("plans") == "auto_explain":
            return {}, [f"Планы: auto_explain, фактические (операторы от {xs[-1]['explain_ms']} мс; замер планов "
                        f"увеличивает время)"], "auto_explain, время завышено замером планов"
        why = xs[-1]["why"].get("plans", "?") if xs else "нет контрольного подключения"
        if not rollback:
            line = (f"Планы: нет данных (auto_explain недоступен: {why}; отдельный прогон EXPLAIN ANALYZE - только "
                    f"с --rollback, иначе изменения данных выполнились бы второй раз)")
            return {}, [line], "нет данных"
        cq.log("Прогон планов (EXPLAIN ANALYZE)...")
        plans, err, conn = {}, None, None
        try:
            conn = self.open_work(True)
            cur = conn.cursor()
            cq.Stop.set_cancel(cur.cancel)
            for line, text in batches:
                cq.Stop.check()
                w = first_words(text, 1)
                if w and w[0] in EXPLAIN_WORDS and not cq.is_ignored_batch(text):
                    cur.execute("EXPLAIN (ANALYZE, BUFFERS) " + text)
                    plans[line] = "\n".join(r[0] for r in cur.fetchall()) + "\n"
                else:
                    cur.execute(text)
        except Exception as e:
            err = cq.err_text(e)
            cq.log(f"Прогон планов прерван: {err}")
        finally:
            cq.Stop.set_cancel(None)
            if conn is not None:
                try:
                    conn.rollback()
                    conn.close()
                except Exception:
                    pass
        lines = [f"Планы: отдельный прогон EXPLAIN ANALYZE после измеряемых (auto_explain недоступен: {why}), "
                 f"только операторы верхнего уровня"] + ([f"Прогон планов прерван: {err}"] if err else [])
        return plans, lines, "отдельный прогон EXPLAIN ANALYZE"

    # ---------------------------------------------------- наблюдение за сессией

    @staticmethod
    def session_row(query, spid):
        rows = query("SELECT backend_start, coalesce(client_hostname, host(client_addr)), application_name, usename "
                     "FROM pg_stat_activity WHERE pid = %s", spid)
        return tuple(rows[0]) if rows else None

    @staticmethod
    def input_buffer(query, spid):
        """Запрос сессии - то, что прислал клиент (pg_stat_activity.query: текст верхнего уровня, обрезан
        по track_activity_query_size)."""
        rows = query("SELECT query FROM pg_stat_activity WHERE pid = %s", spid)
        return (rows[0][0] or "") if rows else ""

    # ---------------------------------------------------- GUI: оценочный план

    def read_only(self, dbname, fn):
        """fn(query) на отдельном подключении только для чтения (default_transaction_read_only) к базе dbname
        (None - база строки подключения): подключение в PostgreSQL - к одной базе."""
        conn = self.connect(cq.APP_NAME + " gui", timeout=15, query_timeout=GUI_TIMEOUT_S, dbname=dbname)
        try:
            conn.execute("SET default_transaction_read_only = on")
            return fn(cq.conn_query(conn))
        finally:
            conn.close()

    def estimate_plan(self, text, dbname=None):
        """Оценочный план оператора по кнопке GUI: EXPLAIN без ANALYZE - оператор не выполняется, сервер только
        строит план (блокировки AccessShare на время планирования). С PostgreSQL 16 - GENERIC_PLAN: план текста
        с параметрами $1, $2... без их значений (тексты pg_stat_statements и запросов программ). Один оператор
        из EXPLAIN_WORDS; подключение только для чтения."""
        stmts = split_statements(text or "")
        if len(stmts) != 1:
            raise ValueError("для плана нужен ровно один оператор")
        stmt = stmts[0][1]
        w = first_words(stmt, 1)
        if not w or w[0] not in EXPLAIN_WORDS:
            raise ValueError("план есть только у SELECT, INSERT, UPDATE, DELETE, MERGE, VALUES, TABLE и WITH")

        def explain(query):
            opt = "(GENERIC_PLAN) " if (self.version or 0) >= 160000 else ""
            return "\n".join(r[0] for r in query("EXPLAIN " + opt + stmt)) + "\n"
        return self.read_only(dbname, explain)

    # ---------------------------------------------------- просмотр сервера (GUI, --show)

    @staticmethod
    def server_props(query):
        row = query("SELECT coalesce(host(inet_server_addr()), 'localhost'), current_database(), current_user, "
                    "current_setting('server_version'), split_part(version(), ' on ', 1)")[0]
        return {"server": row[0], "database": row[1], "login": row[2], "version": row[3], "edition": row[4]}

    @staticmethod
    def sessions(query):
        out = [dict(zip(SESSIONS_COLS, r)) for r in query(SESSIONS_SQL, list(SERVICE_APPS))]
        out.sort(key=lambda x: ((x["db"] or "").lower(), (x["program"] or "").lower(), x["spid"]))
        return out

    def current(self, query):
        sql = CURRENT_SQL if (self.version or 0) >= 140000 else CURRENT_SQL_OLD
        rows = query(sql, list(SERVICE_APPS))
        blocks = {}
        for r in rows:
            for b in (r[9] or "").split(","):
                if b.strip():
                    blocks[int(b)] = blocks.get(int(b), 0) + 1
        out = []
        for (pid, db, login, host, app, state, elapsed, wtype, wevent, by, trans, idle, text, btype, qid) in rows:
            if state == "idle" and pid not in blocks:
                continue
            first = (by or "").split(",")[0].strip()
            idle_tx = (state or "").startswith("idle in transaction")
            out.append({
                "spid": pid, "db": db, "login": login, "host": host, "program": app, "session_status": state,
                "status": state, "command": None, "elapsed": elapsed if state == "active" else None,
                "cpu": None, "reads": None, "physical": None, "writes": None, "memory": None,
                "wait": f"{wtype}:{wevent}" if wtype else "", "wait_ms": None,
                "blocked_by": int(first) if first else None, "trans": 1 if trans else None, "percent": None,
                "plan_handle": None, "start": None, "end": None, "blocks": blocks.get(pid),
                "dbid": None, "objectid": None, "object": None,
                "statement": "" if idle_tx else " ".join((text or "").split()), "line": 1,
                "text": "" if idle_tx else (text or "").strip(),     # с переводами строк: для окна текста и плана
                "idle_s": idle if idle_tx else None, "last_text": (text or "").strip() if idle_tx else "",
                "input": "", "query_id": qid})
        total = query("SELECT count(*), NULL, NULL, clock_timestamp()::timestamp FROM pg_stat_activity "
                      "WHERE backend_type = 'client backend'")[0]
        return {"rows": out, "sessions": total[0], "runnable": None, "memory_waits": None,
                "server_time": total[3].isoformat(timespec="seconds") if total[3] else None}

    def heavy(self, query, order="time", hours=0, top=100, interval=0, pause=None, db=None):
        """«Тяжелые запросы»: TOP pg_stat_statements по показателю order; interval - разница двух снимков
        с паузой interval секунд (pause - функция паузы ядра); db - только запросы этой базы."""
        if order not in HEAVY_ORDER:
            raise ValueError(f"неизвестный показатель: {order}")
        if hours:
            raise ValueError("в PostgreSQL у pg_stat_statements нет времени последнего выполнения: --hours не поддерживается")
        rows = query("SELECT extnamespace::regnamespace::text FROM pg_extension WHERE extname = 'pg_stat_statements'")
        if not rows:
            raise ValueError("на сервере нет расширения pg_stat_statements: тяжелые запросы недоступны")
        new = (self.version or 0) >= 130000            # с PostgreSQL 13 время выполнения и планирования раздельно
        t = "total_exec_time + total_plan_time" if new else "total_time"
        m = "max_exec_time" if new else "max_time"
        top = max(10, min(500, int(top)))
        if interval:
            return self.heavy_delta(query, rows[0][0], t, order, top, interval, pause, db)
        order_sql = HEAVY_ORDER[order].format(t=t, m=m)
        out = []
        where, params = ("WHERE d.datname = %s ", [db, top]) if db else ("", [top])
        for r in query(HEAVY_SQL.format(t=t, m=m, schema=rows[0][0], order=order_sql, where=where), *params):
            x = dict(zip(HEAVY_COLS, r))
            x.update({"statement": " ".join((x["statement"] or "").split()), "text": (x["statement"] or "").strip(),
                      "line": 1, "cpu": None,
                      "plan_handle": None, "start": None, "end": None, "last": None, "created": None, "object": None})
            out.append(x)
        return out

    @staticmethod
    def heavy_delta(query, schema, t, order, top, interval, pause, db=None):
        """--show heavy --interval: два снимка pg_stat_statements без текстов (общая память сервера, файл текстов
        не читается) и их разница по (userid, dbid, queryid, toplevel); тексты - одним чтением для первых top."""
        if order == "max_time":
            raise ValueError("наибольшее время за интервал не считается: в pg_stat_statements оно за все время")
        sql, err = None, None
        for top_col in ("toplevel", "true"):     # toplevel - с версии расширения 1.9
            try:
                before = query(HEAVY_DELTA_SQL.format(schema=schema, t=t, top=top_col))
                sql = HEAVY_DELTA_SQL.format(schema=schema, t=t, top=top_col)
                break
            except Exception as e:
                err = err or e
        if sql is None:
            raise ValueError(f"pg_stat_statements недоступно: {cq.err_text(err)}")
        cq.log(f"Первый снимок есть, второй - через {interval} с...")
        pause(interval)
        snap = lambda rs: [dict(zip(HEAVY_DELTA_COLS, r)) for r in rs if r[2] is not None]   # queryid NULL - нет прав
        rows = cq.delta_rows(snap(before), snap(query(sql)), HEAVY_DELTA_COLS[:4], HEAVY_DELTA_COLS[4:])
        if db:
            oid = query("SELECT oid FROM pg_database WHERE datname = %s", db)
            rows = [r for r in rows if oid and r["dbid"] == oid[0][0]]
        avg = lambda r, k: r[k] / r["execs"] if r["execs"] else 0
        sort = {"time_avg": lambda r: avg(r, "time"), "reads_avg": lambda r: avg(r, "reads")}.get(order, lambda r: r[order])
        rows = sorted(rows, key=sort, reverse=True)[:top]
        texts = {}
        if rows:
            for u, d, q, db, text in query(HEAVY_TEXT_SQL.format(schema=schema), [r["queryid"] for r in rows]):
                texts[(u, d, q)] = (db, text)
        for r in rows:
            db, text = texts.get((r["userid"], r["dbid"], r["queryid"]), (None, ""))
            r.update({"max_time": None, "db": db, "statement": " ".join((text or "").split()), "text": (text or "").strip(),
                      "line": 1, "cpu": None,
                      "plan_handle": None, "start": None, "end": None, "last": None, "created": None, "object": None})
        return rows

    # ---------------------------------------------------- --show tables, functions, io, waits

    stats_spec = STATS_SPEC

    def stats(self, kind, query):
        """Накопительные счетчики --show tables/functions/io: {"rows": [...], "note": пояснение или None}."""
        note = None
        if kind == "tables":
            rows = query(TABLES_SQL)
        elif kind == "functions":
            rows = query(FUNCS_SQL)
            track = query("SELECT current_setting('track_functions')")[0][0]
            if track != "all":
                note = f"track_functions = {track}: " + ("вызовы функций сервер не считает (видна только прежняя статистика)"
                                                         if track == "none" else
                                                         "считаются только функции на PL/pgSQL и других языках, не SQL и C")
        elif kind == "io":
            if (self.version or 0) < 160000:
                raise ValueError("pg_stat_io - с PostgreSQL 16")
            rows = query(IO_SQL)
            if query("SELECT current_setting('track_io_timing')")[0][0] != "on":
                note = "track_io_timing = off: времени чтений и записей нет"
                rows = [tuple(r[:4]) + (None,) + tuple(r[5:6]) + (None,) + tuple(r[7:]) for r in rows]
        else:
            raise ValueError(f"неизвестный вид: {kind}")
        return {"rows": [dict(zip(STATS_SPEC[kind]["cols"], r)) for r in rows], "note": note}

    @staticmethod
    def waits(query, seconds, pause, db=None):
        """--show waits: seconds секунд раз в WAIT_SAMPLE_MS - активные клиентские сессии из pg_stat_activity
        (как ASH: накопительных счетчиков ожиданий в PostgreSQL нет). Выборка, в которой сессия ждала событие, -
        WAIT_SAMPLE_MS этого ожидания; без ожидания - CPU (или ожидание, которого сервер не отмечает).
        seconds 0 - WAITS_DEFAULT_S; db - только сессии этой базы."""
        seconds = seconds or cq.WAITS_DEFAULT_S
        stats, n, total = {}, 0, 0
        end = time.monotonic() + seconds
        while True:
            for pid, wait, sdb, text in query(WAITS_SQL, list(SERVICE_APPS)):
                if db and sdb != db:
                    continue
                e = stats.setdefault(wait, {"samples": 0, "pids": set(), "dbs": collections.Counter(),
                                            "texts": collections.Counter()})
                e["samples"] += 1
                e["pids"].add(pid)
                e["dbs"][sdb] += 1
                e["texts"][" ".join((text or "").split())] += 1
                total += 1
            n += 1
            left = end - time.monotonic()
            if left <= 0:
                break
            pause(min(WAIT_SAMPLE_MS / 1000, left))
        rows = [{"wait": w, "time": e["samples"] * WAIT_SAMPLE_MS, "share": round(100 * e["samples"] / total, 1),
                 "sessions": len(e["pids"]), "samples": e["samples"], "db": e["dbs"].most_common(1)[0][0],
                 "statement": e["texts"].most_common(1)[0][0]} for w, e in stats.items()]
        rows.sort(key=lambda r: -r["time"])
        note = (f"За {seconds} с: выборок {n} (раз в {WAIT_SAMPLE_MS} мс), в среднем активных сессий "
                f"{total / n:.1f}; время - оценка: выборок x {WAIT_SAMPLE_MS} мс")
        return {"rows": rows, "note": note, "seconds": seconds, "total": total * WAIT_SAMPLE_MS, "samples": n,
                "active": round(total / n, 1)}

    # ---------------------------------------------------- GUI: «Нагрузка сервера», «База данных» (GUI.md §5.21, §5.28)

    load_by_db = ("heavy", "waits")  # разделы «Нагрузки», где есть отбор по базе (pg_stat_io - без баз)
    waits_total = False              # накопленных ожиданий нет: всегда замер
    has_temp_tables = False
    space_per_db = False             # «Место» - базы и WAL всего сервера

    @staticmethod
    def databases(query):
        return [r[0] for r in query(DATABASES_SQL)]

    def in_db(self, query, db, fn):
        """fn(query) в базе db: своя база - подключение GUI, другая - отдельное подключение только для чтения
        (подключение PostgreSQL - к одной базе)."""
        if not db or db == query("SELECT current_database()")[0][0]:
            return fn(query)
        if not query("SELECT 1 FROM pg_database WHERE datname = %s", db):
            raise ValueError("нет такой базы")
        return self.read_only(db, fn)

    @staticmethod
    def space(query):
        """Место: размеры баз и табличных пространств, WAL и слоты репликации, которые держат WAL. Свободное
        место на диске средствами SQL не узнать."""
        rows, notes = [], []
        for name, place, mb in query(SPACE_DB_SQL):
            rows.append({"name": name, "kind": "db", "place": place, "size_mb": num1(mb)})
        for sql, kind, why in ((SPACE_TS_SQL, "tablespace", "табличные пространства: нет данных"),
                               (SPACE_WAL_SQL, "wal", "WAL: нет данных (нужна роль pg_monitor)"),
                               (SPACE_SLOTS_SQL, "slot", "слоты репликации: нет данных")):
            try:
                for name, mb, extra in query(sql):
                    rows.append({"name": name, "kind": kind, "size_mb": num1(mb), "extra": extra})
            except Exception:
                notes.append(why)
        return {"rows": rows, "summary": None, "note": "; ".join(notes) or None}

    @staticmethod
    def tables(query):
        """Таблицы текущей базы: размеры - оценка по pg_class.relpages (обновляется VACUUM и ANALYZE; функции
        размеров встали бы в очередь за AccessExclusiveLock), обращения - pg_stat_user_tables."""
        rows = []
        for (oid, name, total, heap, idx, toast, live, dead, seq, seq_rows, iscan, irows, ins, upd, dele,
             vac, ana, place) in query(TABLE_SIZES_SQL):
            rows.append({"id": oid, "table": name, "filegroup": place, "rows": live, "dead": dead,
                         # байт на строку: оценка размеров (relpages) на живую строку - оценка роста таблицы
                         "row_bytes": round(float(total) * 1048576 / live) if live and total is not None else None,
                         "data_row_bytes": round(float(heap) * 1048576 / live) if live and heap is not None else None,
                         "total_mb": num1(total), "data_mb": num1(heap), "index_mb": num1(idx), "toast_mb": num1(toast),
                         "seq_scan": seq, "seq_rows": seq_rows, "idx_scan": iscan, "idx_rows": irows,
                         "reads": None if seq_rows is None else (seq_rows or 0) + (irows or 0),
                         "ins": ins, "upd": upd, "del": dele,
                         "vacuum": vac.isoformat(sep=" ") if vac else None,
                         "analyze": ana.isoformat(sep=" ") if ana else None})
        return {"rows": rows, "note": None}

    @staticmethod
    def indexes(query, table_id):
        rows = []
        for (name, am, uniq, pk, mb, scans, tread, tfetch, nkeys, cols, pred, clustered,
             corr) in query(INDEXES_SQL, int(table_id)):
            cols = (cols or "").split(chr(1))
            rows.append({"name": name, "type": am, "unique": uniq, "primary": pk, "mb": num1(mb), "reads": scans,
                         "tup_read": tread, "tup_fetch": tfetch, "unused": not uniq and not pk and not scans,
                         "keys": cols[:nkeys], "include": cols[nkeys:], "filter": pred, "clustered": clustered,
                         "correlation": None if corr is None else round(float(corr), 2)})
        return rows

    @staticmethod
    def triggers(query, table_id):
        """Триггеры таблицы: вид и события (tgtype), включен ли (tgenabled), SQL функции и триггера и
        статистика функции триггера."""
        rows, track = [], None
        for name, enabled, tgtype, func, trigdef, funcdef, calls, total, self_t, track in query(TRIGGERS_SQL, int(table_id)):
            events = [e for bit, e in ((4, "INSERT"), (16, "UPDATE"), (8, "DELETE"), (32, "TRUNCATE")) if tgtype & bit]
            rows.append({"name": name, "enabled": enabled,
                         "timing": "BEFORE" if tgtype & 2 else "INSTEAD OF" if tgtype & 64 else "AFTER",
                         "events": ", ".join(events), "level": "row" if tgtype & 1 else "statement", "function": func,
                         "execs": calls, "time": num1(total), "self_time": num1(self_t),
                         "text": f"-- функция триггера\n{funcdef.rstrip()};\n\n-- триггер\n{trigdef};"})
        note = {"none": "track_functions = none: вызовы функций сервер не считает (видна только прежняя статистика)",
                "pl": "track_functions = pl: считаются только функции на PL/pgSQL и других языках, не SQL и C"}.get(track)
        return {"rows": rows, "note": note if rows else None}

    @staticmethod
    def table_sql(query, table_id):
        """SQL создания таблицы по каталогу: столбцы, ограничения, индексы, триггеры и комментарии
        (COMMENT ON); операторы разделены «;» и пустой строкой."""
        oid = int(table_id)
        head = query(DDL_TABLE_SQL, oid)
        if not head:
            raise ValueError("таблица не найдена")
        (full, kind, persistence, is_part, parent, bound, partkey, inherits, space, options, comment, view,
         db) = head[0]

        def lit(text):               # строка SQL (standard_conforming_strings = on - по умолчанию с 9.1)
            return "'" + text.replace("'", "''") + "'"

        out, notes = [], []
        if kind == "m":
            out.append(f"CREATE MATERIALIZED VIEW {full}" + (f" WITH ({options})" if options else "")
                       + (f" TABLESPACE {space}" if space else "") + f" AS\n{view.rstrip().rstrip(';')}")
        else:
            lines = []
            for name, typ, notnull, expr, ident, generated, coll, col_comment, local in query(DDL_COLUMNS_SQL, oid):
                if col_comment:
                    notes.append(f"COMMENT ON COLUMN {full}.{name} IS {lit(col_comment)}")
                if not local or is_part:
                    continue           # столбец родителя: его создает INHERITS / PARTITION OF
                s = f"{name} {typ}" + (f" COLLATE {coll}" if coll else "")
                if generated in ("s", "v"):
                    s += f" GENERATED ALWAYS AS ({expr}) {'STORED' if generated == 's' else 'VIRTUAL'}"
                elif ident in ("a", "d"):
                    s += f" GENERATED {'ALWAYS' if ident == 'a' else 'BY DEFAULT'} AS IDENTITY"
                elif expr is not None:
                    s += f" DEFAULT {expr}"
                if notnull and ident not in ("a", "d"):
                    s += " NOT NULL"
                lines.append(s)
            fks = []
            for name, ctype, definition, con_comment in query(DDL_CONSTRAINTS_SQL, oid):
                (fks if ctype == "f" else lines).append(f"CONSTRAINT {name} {definition}")
                if con_comment:
                    notes.append(f"COMMENT ON CONSTRAINT {name} ON {full} IS {lit(con_comment)}")
            unlogged = " UNLOGGED" if persistence == "u" else ""
            if is_part:
                s = f"CREATE{unlogged} TABLE {full} PARTITION OF {parent}" + (
                    " (\n    " + ",\n    ".join(lines) + "\n)" if lines else "") + f" {bound}"
            else:
                s = f"CREATE{unlogged} TABLE {full} (\n    " + ",\n    ".join(lines) + "\n)" + (
                    f" INHERITS ({inherits})" if inherits else "")
            s += (f" PARTITION BY {partkey}" if partkey else "") + (f" WITH ({options})" if options else "") + (
                f" TABLESPACE {space}" if space else "")
            out.append(s)
            out += [f"ALTER TABLE {full} ADD {x}" for x in fks]
        for definition, idx_comment, idx_name in query(DDL_INDEXES_SQL, oid):
            out.append(definition)
            if idx_comment:
                notes.append(f"COMMENT ON INDEX {idx_name} IS {lit(idx_comment)}")
        for definition, name, enabled in query(DDL_TRIGGERS_SQL, oid):
            out.append(definition)
            if enabled == "D":
                out.append(f"ALTER TABLE {full} DISABLE TRIGGER {name}")
        if comment:
            out.append(f"COMMENT ON {'MATERIALIZED VIEW' if kind == 'm' else 'TABLE'} {full} IS {lit(comment)}")
        return (f"-- {full} (база {db}): собрано по каталогу сервера; права, владелец, последовательности и "
                "статистики не входят\n" + "".join(x + ";\n\n" for x in out + notes))

    @staticmethod
    def columns(query, table_id):
        """Столбцы таблицы: тип, средний размер значения и заполненность по статистике ANALYZE."""
        rows = []
        for name, typ, notnull, attlen, width, nulls, distinct, tuples in query(COLUMNS_SQL, int(table_id)):
            if distinct is not None and distinct < 0:
                distinct = round(-float(distinct) * float(tuples)) if tuples and tuples > 0 else None
            rows.append({"column": name, "type": typ, "nullable": not notnull,
                         "bytes": width if width is not None else (attlen if attlen > 0 else None),
                         "var": attlen < 0, "null_pct": None if nulls is None else round(float(nulls) * 100, 1),
                         "distinct": None if distinct is None else round(float(distinct))})
        return rows

    @staticmethod
    def temp(query):
        """Временные данные: временные файлы сессий (pg_ls_tmpdir, нужна роль pg_monitor; только табличное
        пространство по умолчанию) и временные файлы баз с последнего сброса статистики (pg_stat_database)."""
        rows, note = [], None
        try:
            files = query(TMP_FILES_SQL)
        except Exception:
            files, note = [], "временные файлы сессий: нет данных (нужна роль pg_monitor)"
        by_pid = {}
        for name, size in files:
            m = re.match(r"pgsql_tmp(\d+)", name or "")
            if m:
                e = by_pid.setdefault(int(m.group(1)), [0, 0])
                e[0] += 1
                e[1] += size or 0
        if by_pid:
            for pid, db, login, program, status, elapsed, text in query(TMP_ACT_SQL, list(by_pid)):
                cnt, size = by_pid.pop(pid)
                rows.append({"spid": pid, "db": db, "login": login, "program": program, "status": status,
                             "elapsed": elapsed, "files": cnt, "total_mb": round(size / 1048576, 1),
                             "text": (text or "").strip()})
            for pid, (cnt, size) in by_pid.items():      # процесса уже нет
                rows.append({"spid": pid, "files": cnt, "total_mb": round(size / 1048576, 1), "text": ""})
        rows.sort(key=lambda r: -r["total_mb"])
        dbs = [{"db": db, "files": n, "mb": num1(mb), "since": since.isoformat(sep=" ") if since else None}
               for db, n, mb, since in query(TMP_DB_SQL)]
        return {"rows": rows, "dbs": dbs, "summary": None, "note": note}

    @staticmethod
    def check_kill(spid, own=None):
        spid = int(spid)
        if spid <= 0:
            raise ValueError("неверный номер сессии")
        if own is not None and spid == own:
            raise ValueError("это подключение самой программы")
        return spid

    def kill(self, query, spid, own=None):
        """pg_terminate_backend - закрыть сессию (ее открытая транзакция откатывается)."""
        if not query("SELECT pg_terminate_backend(%s)", self.check_kill(spid, own))[0][0]:
            raise ValueError("сессия не закрыта (нет такой сессии или нет прав)")

    def cancel(self, query, spid, own=None):
        """pg_cancel_backend - отменить текущий запрос сессии, сама сессия остается."""
        if not query("SELECT pg_cancel_backend(%s)", self.check_kill(spid, own))[0][0]:
            raise ValueError("запрос не отменен (нет такой сессии или нет прав)")
