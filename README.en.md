# CompareQuery

The script runs a SQL query on MS SQL Server, saves every result table to a file and writes a report. The second mode compares two such reports: for example, the query result before and after a change to the database, a procedure or the query itself. It also measures performance — time, CPU, reads and a per-statement profile of the query or of another session — which makes it a tool for optimization.

**Русская версия: [README.md](README.md)**

The reports, data files and console output of `CompareQuery.py` are in Russian: they are data that the comparison mode and the GUI parse. This document quotes them as they are, with an English explanation.

## Requirements

The program is in the `src` folder (`src\CompareQuery.py`, `src\CompareQueryGUI.py`, `src\gui`), the documentation and the `CompareQueryGUI.exe` launcher are in the root. In the examples below `CompareQuery.py` means `src\CompareQuery.py`. The settings file `CompareQuery.json` is next to the script, that is, in `src`.

- Python 3.10 or newer.
- The pyodbc module: `pip install pyodbc`.
- An ODBC driver for SQL Server, preferably "ODBC Driver 17/18 for SQL Server".
- The `VIEW SERVER STATE` permission for the login, to get time, CPU and read counters (see "Control connection"). Without it the query still runs and can be compared, but the report has no counters.

Mode 2 (comparison) needs neither pyodbc nor a server.

## Quick start

1. Write a test script `query.sql`: `SELECT`s over the tables whose result must stay the same.
2. Run `python CompareQuery.py query.sql --repeat 2` and move the item from `# Предложение для настроек` (settings suggestion) into `ignored_columns`. To make the mask match copies of the script too, widen it: `query*`. Delete the results of this run.
3. Run the script once or with `--repeat N`: this is the baseline.
4. Make a copy of the script (`query_v2.sql`) and change it or the database.
5. Run the copy, preferably the same way as the baseline. With `--profile` you can see where the time goes.
6. Compare: `python CompareQuery.py <baseline>.txt <new>.txt`.
7. Look at `..._compare_..._short.txt`, and if needed at the full report, the data and the statement registry. Delete a run you do not need: the report `<name>_<time>.txt`, the files `<name>_<time>_N.csv` and the folder `<name>_<time>_profile` in the `<name>` subfolder, and the comparison files `..._compare_<time>.txt` and `_short.txt`. Keep a good run as a baseline, main or intermediate.
8. The next iteration starts at step 4.

## First run and settings

The settings are in `CompareQuery.json` next to the script, not in the current folder. If the file does not exist, the script creates it with an example and says so. In mode 1 it then exits: fill in the settings first.

```json
{
  "connection_string": "Driver={ODBC Driver 18 for SQL Server};Server=localhost;Database=master;TrustServerCertificate=yes",
  "login": "sa",
  "password": "",
  "ignored_columns": [
    { "mask": "Report*", "tables": { "*": ["CreatedAt"], "2": ["id", "guid"] } }
  ]
}
```

- `connection_string`: an ODBC connection string without login and password. The driver in the example is taken from the installed ones. If the string has no `APP`, the script adds the program name: `CompareQuery` for the work connection and `CompareQuery control` for the control one. This lets the administrator see whose sessions they are.
- `login`, `password`: appended to the string as `UID=...;PWD={...}`. The password may contain any characters. If `login` is empty, Windows authentication is used: `Trusted_Connection=yes` is appended unless the string already has `Trusted_Connection`, `Authentication`, `UID` or `PWD` (then it is used as is). If the string already contains `UID` or `PWD` and `login` is set, it is an error.
- `ignored_columns`: ignored columns. A group applies if `mask` matches the SQL file name without folder and extension (`*` and `?`, case-insensitive). In `tables` the key is the number of a result table or `*` for all tables, the value is a list of columns. If several groups match, their columns are combined. Columns that the table does not have are skipped. The old format with `"columns"` is not accepted: the script explains how to convert it.

An ignored column:

- goes to the end of the key selection order (see "Key"): rows are sorted by it only if the key is not unique without it;
- **is excluded from the comparison completely**: rows that differ only in ignored columns are considered equal. The table hash is computed without them.

This is for columns that differ from run to run: `id` from `identity`, creation time, `newid()`. The table number is the running number in the report. If a table appears in or disappears from the query, the numbers shift and the setting has to be fixed.

JSON keys and column names are case-insensitive.

**The password is stored in plain text.** Do not put `CompareQuery.json` under version control. The connection string and the password are never printed anywhere.

## Mode 1: running a query

```
python CompareQuery.py query.sql
python CompareQuery.py query.sql --rollback
python CompareQuery.py query.sql --repeat 5
python CompareQuery.py query.sql --profile
```

- Without `--rollback` the query runs without a transaction (autocommit): the script opens nothing and holds no locks beyond what the query itself does. Data changes made by the query are kept.
- With `--rollback` all batches run in one transaction, and `rollback` is done at the end. This suits queries that change data when the database must not change. It is the only mode of the script that noticeably affects other users: the open transaction holds locks until the end of the pass and prevents the transaction log from being truncated, so the log grows. Use it for short queries.
- `--repeat N` runs the query N times, N is at least 2. Each pass uses new connections, so `#temp` tables and `SET` options do not carry over between passes. With `--rollback` the rollback is done after each pass. Without `--rollback` the data changes of every pass are kept, and the script does not warn about it. See "Repeats".
- `--profile` builds a statement registry by time, see "Statement registry".

The SQL file must have the `.sql` extension. The encoding is detected automatically: BOM, then UTF-8, then cp1251. A line consisting only of `GO` (spaces and a comment allowed) separates batches. `GO 5` is not supported. All batches of a pass run on one connection, so `#temp` tables are available in the following batches.

### What is created

Only the report is created next to the SQL file. Everything else goes into a subfolder named after the SQL file without extension (`query` for `query.sql`), shared by all runs of that file. There is one timestamp for the whole run: `<script name>_<time>` is the run name, all its file names start with it, and the table number comes after it.

| File | Contents |
|---|---|
| `query_20261110_153000.txt` | The report. The console shows the same text without the `Производительность` (performance) section. |
| `query/query_20261110_153000_1.csv`, `query/query_20261110_153000_2.csv` | One file per result table, numbered continuously across all batches. With `--repeat` only the data of the last pass is saved. |
| `query/query_20261110_153000_profile/` | Only with `--profile`: the statement registry, statement texts and plans. |
| `query/query_20261110_153000_message.txt` | The run log: progress lines and SQL messages (`PRINT`, `RAISERROR`, errors, see below) with server time — the same as seen in the console. The run result in the window shows it. |

**Time is server time**: in the report (`Дата выполнения`, run date), in file names, in the statement registry and log, for SQL messages, in `--session`. The server clock is measured once on connection (`SYSDATETIME()` in the same query as `@@SPID` — no extra query) and then advanced by the computer clock. If the computer clock differs from the server by more than a minute (for example, a different time zone), the report has a `Часы компьютера` (computer clock) line. The exception is comparison files (mode 2): there is no server there, so the computer time is used.

**SQL messages** are printed to the console as the query runs, with server time:

```
[10:15:32.123] Начало расчета
[10:15:40.871] Шаг 1 готов: 30000 строк
```

Shown are `PRINT`, `RAISERROR` with text and user messages (number 50000 and above), and errors. Informational service messages of the server ("Changed database context", "Null value is eliminated by an aggregate" and the like) are not shown. The time is when the message reached the script. The server buffers `PRINT` output and sends it together with results, so for a message to arrive immediately the script needs `RAISERROR('text', 0, 1) WITH NOWAIT`. The full list of server messages, including service ones, is in the report, section `Производительность`. Messages of service batches (`-- ignore in test`) are not printed. The shown messages together with the progress lines are saved to `<run>_message.txt` in the data subfolder (the `Журнал:` line of the report); errors are marked `Ошибка:`, other messages `SQL:`.

In the report the paths to data files and the registry are relative to the report folder, so the report can be moved together with its subfolder. Reports made before the subfolder appeared are compared too: their data files are looked up next to the report, as before.

Existing files are never overwritten: if the name is taken, `_2` is appended.

The report consists of sections:

- `# Запуск` (run): the SQL file and its sha1, server and database, date, mode, number of passes (with `--repeat`), the registry path (with `--profile`), the run log path (`Журнал:`).
- `# Сводка` (summary): time, client wait, CPU, logical and physical reads, writes for the whole run, total run time (by the script clock, with all overhead), the total number of rows and the rows in each table. With `--repeat` also the time of each pass and non-deterministic tables.
- `# Таблица N` (table N): file, number of rows, cost up to the table, table hash, column hashes, ignored columns (if any), an approximate `create table`, the key.
- `# Производительность` (performance): the time of each driver call (execute, fetching each table, nextset), the `rowcount` of statements without a result, the script processing time, all server messages (`PRINT`, warnings, service messages) as they are. With `--repeat` — for the last pass. File only: this section is not printed to the console, it can be very long.
- `# Предложение для настроек` (settings suggestion): only with `--repeat 2`, see "Repeats".

**Cost up to the table** (`Затраты до таблицы`) is the time, client wait, CPU, logical and physical reads of the work session from the end of fetching the previous table (for the first table — from the start of the first batch) to the end of fetching this one. It includes statements without a result executed between the two tables.

A query that returned no tables is a normal case: the report says `таблиц нет` (no tables).

### Control connection

Time, CPU and reads are measured from a second, control connection:

1. The work connection is opened, and the script learns its session number (`@@SPID`). Then the control connection is opened.
2. Before each batch the control connection reads the counters of the work session (`sys.dm_exec_sessions`) and its client wait (`sys.dm_exec_session_wait_stats`).
3. When a table has been fetched completely, the control connection reads the counters of the current request of the work session (`sys.dm_exec_requests`). The difference from the previous measurement is the cost up to the table.
4. After the batch the control connection reads the counters once more.
5. At the end of the pass both connections are closed.

The measurements come from another session and change nothing in the work one. The script does not enable `SET STATISTICS IO/TIME`: on queries with scalar functions `SET STATISTICS TIME` multiplies the CPU of the query itself.

**Time** is the time between measurements by the script clock minus the client wait: how long the server waited for the client to take the result rows (`ASYNC_NETWORK_IO`). That wait includes the network transfer of results and the script's own work with the rows, so they do not count towards the time. Locks, disk reads, the CPU queue and other server waits do count: this is the real cost of the query. The client wait is shown separately. `sys.dm_exec_session_wait_stats` exists since SQL Server 2016; on an older server the report says `Ожидание клиента: нет данных` (client wait: no data), and the time includes it.

For the control connection to see the work session, the `VIEW SERVER STATE` permission is needed (even for the same login). If it is missing or the control connection could not be opened, the run continues without counters: the summary says `Счетчики сервера: нет данных (reason)` (server counters: no data), and there are no `Затраты до таблицы` lines.

### Repeats (`--repeat N`)

The first pass is a warm-up (data and plan cache). The counters in the report are the median of passes from the second to the last. With two passes these are simply the values of the second pass. The summary has a `Время по прогонам: ...` (time by pass) line for all passes, including the first.

If a table has a different number of rows or a different hash (without ignored columns) in different passes, it is listed in the `Недетерминированные таблицы: ...` (non-deterministic tables) line. Such a table cannot be compared between runs meaningfully without an `ignored_columns` setting or a change to the query.

With `--repeat 2` (exactly two passes) the report ends with a `# Предложение для настроек` section: a ready item for `ignored_columns` that lists every column whose hash differs between the passes. The mask is the SQL file name (`[` is escaped as `[[]`). The current settings are not taken into account: a column that is already ignored but differs is listed too. Tables with a different number of rows are not included in the item; they get a separate line, since ignoring columns will not help them. If the run was aborted, there is no such section.

```
# Предложение для настроек
Колонки, хэш которых различается между прогонами 1 и 2 (текущие настройки не учитываются).
Элемент для ignored_columns в CompareQuery.json:
{"mask": "query", "tables": {"1": ["CreatedAt"], "3": ["id", "ts"]}}
Таблица 2: число строк различается (10 и 11), игнорирование колонок не поможет
```

### Statement registry (`--profile`)

Shows which statements of the query run longest and what their time goes into, so you look at their plans first.

While the query runs, the control connection reads the current statement of the work session and its counters from `sys.dm_exec_requests` every 100 ms (a sample). The increase of time, CPU and reads between two samples is attributed to the statement of the second sample. The interval time without CPU is a wait; it is attributed to the wait type the request had at the moment of the sample (see below). The result is a statistical picture: statements that run less than half a second in total are imprecise, while the top statements of a long query are accurate.

Functions do not get into the registry. If a sample landed inside a function, its increase is attributed to the last statement outside functions in the same batch: that statement called the function. If there was no such statement yet, the increase goes to the next one. After a sample inside a function the next one is taken after 30 ms instead of 100. Inline functions are part of the query anyway.

Sampling is as light as possible: two small queries for one session — the row of its request and, separately, a check whether anyone is waiting for that session. Statement texts, object names and plans are requested in a separate thread on a separate connection: such queries can take long, and samples do not wait for them. A sample whose text has not arrived yet waits in a queue and is counted later, the order is preserved.

If the server answered the sample query (the session request row with time and counters) in more than 80 ms (`SAMPLE_SLOW_MS`), it is a delay: the sample was late, and the interval time went to one statement less precisely. The `registry.txt` header has a `Задержки выборки (ответ дольше 80 мс): N, всего M мс` (sampling delays) line — the number of such answers and their total duration. Helper queries (who waits for the session, texts and plans) and waiting for the connection while it takes the counters are not included: they do not affect the samples. In `--profile` the answer time also includes waiting while the control connection takes the counters after a table (they share one connection).

The `query/query_<time>_profile` folder:

- `registry.txt` — the header: the number of samples, how many of them were inside functions, how much time was attributed to statements out of the time by session counters.
- `registry.csv` — the table of statements by descending time: number, the columns below, logical and physical reads, the number of samples, the number of runs, the object (procedure, trigger or SQL file), the line in the object, the statement text hash, file names, the start of the statement text.
  - `Запусков` (runs) — how many times the statement started executing again: a return to it after another statement (a loop, a repeated procedure call) or a new request with it. It tells whether the statement ran long once or many short times. Samples inside functions do not interrupt an execution (as in the log), so the "caller — function statement" flicker does not increase the counter. It is a lower bound: repeats with no other statement caught by a sample in between are not visible. With `--repeat` — the median of the passes.
  - `Хэш` (hash) — a checksum of the statement text ignoring spaces and case. Mode 2 uses it to find the same statement in another run: the line number shifts with any edit of the procedure, but the statement text does not. It also distinguishes different statements on one line.
  - `Начало текста` (text start) — the first 100 characters (`REGISTRY_TEXT_LEN`) as they are, except line breaks and control characters that would break a CSV line: they are replaced with spaces (`\r\n` with one). Tabs stay tabs, so the fragment can be copied and found by search in the source text if it does not cross a line break.
- `log.csv` — the execution log, see below.
- `NNN - T.sql` — the text of statement number NNN, where T is its time in ms (for example, `001 - 15155.sql`). The first two lines are comments: the object and line, then the registry values: `--Время мс: 15155; CPU мс: 9180; ...` — the same values as in the registry columns, except empty ones, the share and the client wait.
- `NNN - T.sqlplan` — the statement plan from the plan cache, for the first 30 statements. Opens in SSMS. This is a plan without actual values (estimated row counts); an actual plan cannot be obtained this way without changing database settings.

Registry columns:

| Column | Meaning |
|---|---|
| `Время мс`, `Время %` | execution time without client wait; share of the run time by session counters |
| `CPU мс` | CPU; parallel plans can have more than the time |
| `Ожидание блокировок мс` | lock waits (`LCK_M_*`) held by other sessions |
| `Блокировал сам мс` | time when at least one other session was waiting for a lock of this session. How many and whether there are chains does not matter |
| `Ожидание ресурсов мс` | other server waits: disk, memory, CPU, parallelism and so on |
| `Ожидание ресурсов 1/2/3 место` | the three longest types from the previous column: `PAGEIOLATCH_* (1234 мс)` |
| `Выделено памяти МБ` | the largest memory grant of the query (`granted_query_memory`) seen in samples |
| `Ожидание клиента мс` | `ASYNC_NETWORK_IO`: the server waited for the client to take the rows. Not included in the time |

The wait type comes from the sample: the current one (`wait_type`); if the request waits for CPU (`runnable`) — `SOS_SCHEDULER_YIELD`; if it is running — the last completed one (`last_wait_type`). The subtypes `PAGEIOLATCH_*`, `PAGELATCH_*` and `LATCH_*` are combined: they mean the same thing. All of this is approximate, with the precision of the sampling interval: if within 100 ms the request waited for different things, the whole wait of the interval goes to one type. "Blocked others" is counted in whole intervals.

Locks held by a `--rollback` transaction after a statement has ended are visible too, but are attributed to the statement running at that moment. There are no samples between batches.

A statement is identified by object, line and text hash. If it runs several times (in a loop, with several calls of the procedure, `GO N`), the values of all executions are summed into one registry row.

With `--repeat` the registry values are the median of passes from the second to the last. The line of statements of the SQL file is the line in the file itself, for procedures — the line from the start of the procedure text, as in SQL Server error messages.

**The `log.csv` log** has the same columns, but a row is not a statement for the whole run — it is one continuous execution of a statement: from the first sample where it appeared to the sample where another statement started or the request ended. Samples inside functions do not interrupt an execution. A sample whose statement text is 2 characters or shorter is treated as broken (the server returned the statement bounds at the moment the statement changed) and is handled like a sample inside a function: it goes to the previous statement and the next poll follows immediately. In `--session` a request that started before the monitoring gives zero time in its first sample: its earlier costs belong to unknown statements, not to the statement of the first log row. Rows go in order of appearance, old rows do not change. The same statement (for example, in a loop) appears many times. Instead of the number, the first column is the server time when the execution started (with the precision of the sampling interval; for the first statement of a batch — the batch start time). The log has no `Время %`, `Хэш`, `Текст`, `План` and `Запусков` columns (a log row is one run): the NNN file numbers change with the order of statements, while the log is only appended (in `--session` — during monitoring), so the `--profile` and `--session` logs are the same. A log statement is found in the registry by object and line, if in doubt — by the start of the text. With `--repeat` the log has all passes from the second.

What the registry does not give: the number of executions of a statement and the time of a procedure including nested calls. A sample sees only the innermost statement, so a procedure is credited with the time of its own statements.

### Server load

The script creates and changes nothing on the server: no objects, settings or files. The plan and buffer caches are not cleared. All it does beyond your query is read system views:

| What | When | Load |
|---|---|---|
| session and request counters | before each batch, after each table and batch | one row from `sys.dm_exec_sessions`/`requests` |
| current statement | `--profile`, `--session`: 10 times a second (up to 33 inside functions) | two queries: one row from `sys.dm_exec_requests` for the session and a check whether anyone waits for it |
| statement texts and objects | `--profile`, `--session`: once per module, in a separate thread and connection | `sys.dm_exec_sql_text`, object name and type |
| plans | `--profile`: at the end, for 30 statements; `--session`: on file updates, for new statements among the top 30, in a separate thread | `sys.dm_exec_text_query_plan` |
| session alive | `--session`: once a second | one row from `sys.dm_exec_sessions` |

Deliberately not used: Extended Events (a server object and a cost on every function call), `sys.dm_exec_query_statistics_xml` (known server failures under frequent polling), `sys.dm_exec_query_stats` (reads the whole plan cache, data mixed with other queries), `SET STATISTICS IO/TIME`.

The load is set by the query itself, `--repeat` (the query runs N times) and `--rollback` (see above).

### Service batches (`--ignore in test`)

If the first non-empty line of a batch is the comment `--ignore in test` (case and spaces after `--` do not matter), the batch runs as usual (with `--rollback` it is rolled back with the rest), but nothing from it gets into the report:

- its tables are read and discarded, the table numbering skips them: the tables of other batches get the same numbers as in the query without service batches, so such runs are compared with ordinary ones;
- its time, CPU and reads are not included in the summary or in "cost up to the table";
- its statements (and procedures called from it) do not get into the `--profile` registry and log;
- its server messages and driver call times do not get into the `Производительность` section; there is only a `Батч N: --ignore in test, в отчет не попадает` line.

The `# Запуск` section has an `Игнорируемые батчи (--ignore in test): N` line. Such batches can be anywhere: at the start (test data preparation), in the middle or at the end. An error in a service batch aborts the run, as in an ordinary one.

```
-- ignore in test
insert into #params values (1, '2026-01-01')
GO
exec dbo.CalcSalary
```

### Errors during execution

If the server returned an error or Ctrl+C was pressed, the tables already fetched are processed and saved, the report gets `ЗАПУСК ПРЕРВАН: <error text>` (run aborted), and the exit code is 2. A table that was not fetched completely is not saved. With `--repeat` the following passes do not run. If not the last pass was aborted, there is no data: it is saved only in the last one. Mode 2 does not accept such reports.

Ctrl+C takes effect when the driver returns control, that is, not in the middle of a long `execute` (the `stop` command from another program cancels a long statement too, see "Running from another program"). After an aborted run without `--rollback`, a transaction opened by the script is rolled back (`IF @@TRANCOUNT > 0 ROLLBACK`). A second Ctrl+C while tables are being processed aborts the script without a report.

## Mode 3: monitoring a session (`--session N`)

```
python CompareQuery.py --session 87
```

Builds a statement registry of someone else's session number N (visible in SSMS, Activity Monitor, `sp_who2`): the same as `--profile`, but the query is run by someone else, not the script. The script executes nothing in that session, it only reads system views from its two connections (samples and, separately, texts and plans). The `VIEW SERVER STATE` permission is needed. A statement plan appears in the folder on one of the following file updates: it is requested in a separate thread.

The result is the `Sessions_profile\Session_<time>_N` folder in the current folder (or in `OUTPUT_DIR`; the time is the start of monitoring by the server clock) with the same files as `--profile`: `registry.txt`, `registry.csv`, `log.csv`, `NNN - T.sql`, `NNN - T.sqlplan`. The time in the header is the sum over samples, and the share is computed from it. The header also has `Исходный запрос` (input buffer) — the last batch the client sent (often a procedure call with parameters), in one line; it is updated on every file write.

- The registry files are updated every 10 seconds (`SESSION_FLUSH_S`): the order of statements, numbers and times in file names and plans change along the way. Each file is written through a temporary one and replaced as a whole, so the script can be closed at any moment: the disk keeps the last complete state, not older than 10 seconds.
- There are no extra writes: an unchanged file is not touched; a file whose name only changed (number or time, same text — usually plans and texts of statements that are not running now) is renamed; only new and changed files are rewritten (`registry.csv`, `registry.txt`, texts of running statements — their comment shows the growing time). A plan is fetched from the server once.
- `log.csv` is appended as soon as a statement execution ends, without waiting 10 seconds.
- If a file is open in another program (Excel locks an open file), it is skipped until the next time, with one message. Log rows wait in memory meanwhile.
- In the console the lines are up to 79 characters: the server time when the statement first appeared in a sample, the object and line, the start of the text (30 characters), the current wait (if the request waits for another session — with its number: `LCK_M_U ждет 112`, waits for 112). While the same statement runs, the line is updated in place and only when something in it changed (for example, the wait); another statement or request starts a new line, so the console shows how the procedure went. While the session runs nothing — `нет запроса` (no request).

```
10:12:34 dbo.CalcSalary:154 update s set Amount = r.Rate * s.H LCK_M_U
```

Exit:

- any key (in the Windows console), Ctrl+C or the `stop` command (see "Running from another program"). If files are being written at that moment, the write is finished. Then the files are written one last time (disk only, no server queries) and the script ends;
- session N ended (or its number was taken by another session: the connection time is checked);
- a connection error: exit code 2, the data up to that moment is saved.

While the session is idle between requests, there are no samples. Comparing two reports (mode 2) is not provided for `--session`: there is no run report, only the registry folder.

## Mode 2: comparing two runs

```
python CompareQuery.py query_20261110_153000.txt query_20261111_090000.txt
```

The arguments are two mode 1 reports: the first is A (usually the baseline), the second is B (usually the run being checked). The data files are found by the paths from the reports, relative to the report folder. Two files are created next to report B:

- `<reportB>__<reportA>_compare_<time>.txt` — the full report;
- `<reportB>__<reportA>_compare_<time>_short.txt` — the short report, the same text is printed to the console.

The name starts with report B, so when sorted by name the comparison comes right after the run being checked.

How the short report differs from the full one:

- the header has only the names of the two reports, without the sha1 of SQL files, server and mode;
- no warning about different SQL files and no reminder about case-insensitive comparison;
- the key is shown as a list of columns. If the keys of the two runs differ, they are shown separately for A and B;
- no line about matching hashes (the `идентична` (identical) heading says so) and no warnings about different types within one family;
- the `Строк только в A/B` (rows only in A/B) and `Сопоставлено строк` (rows matched) lines are omitted if they are 0;
- the statements section has at most 10 lines.

The cost is shown in the header for the whole run and for each table: `Затраты до таблицы: время A=1500 B=1100 мс (-27%), CPU A=120 B=100 мс (-17%), чтений A=4500 B=4400 (-2%)`. The time is without client wait, as in the run report. Reads here are logical: physical reads depend on what was in the cache and are not suitable for comparison. Reports made before the time appeared show `время нет данных` (time: no data).

Tables are matched by number. For each table:

1. **Structure**: the number, names and order of columns. If the structure differs, rows are not compared, but the number of rows and the hashes of common columns are. Different types of one family (number, string, date, bytes) only give a warning.
2. **Keys**. They are compatible if one key is the beginning of the other (for example, `(acsId)` and `(acsId, proId)`): then the files are read as streams, without loading into memory. Otherwise (the data changed so that another key was selected, or the `ignored_columns` settings differ) the tables are compared in memory, see below.
3. **Hashes**: if the number of rows, the table hash and the hashes of all columns match, the table is identical, and the data is not read.
4. **Row by row comparison** of both sorted files. The report shows how many rows are only in A and only in B, how many were matched and how many of them differ, which columns differ, and examples.

**In-memory comparison** with different keys: both tables are loaded completely, sorted by a common key and compared the same way. The common key is the key of A if it is unique in both runs, otherwise the key of B, otherwise the union of both keys (it is unique in both runs). Ignored columns and `#dup` are not part of the common key. The report shows the lines `ключи различаются, таблицы сравниваются в памяти` (keys differ, tables are compared in memory) and `Сопоставление в памяти по (...)` (matching in memory by). For example, A selected the key `(acsId)`, while B, where `hhId` of one row changed, selected `(id, hhId)`. Then matching goes by `acsId`, and the change is visible as a difference in `hhId`, not as an "only in A" and "only in B" pair. Such a table needs about twice the memory of its processing in mode 1: both sides are held.

**Values are compared case-insensitively**: `Abc` and `ABC` are considered equal. The data files store values as they are.

**Ignored columns** are taken from the reports, not from the current settings: columns ignored in at least one of the two runs do not take part in the comparison. They are listed in the table's `Игнорируемые колонки` (ignored columns) line. If the settings of the two runs differ, the same line says so. If the key reached ignored columns (rows are not unique without them), rows are matched by the other columns taking the number of repeats into account.

If the key of a table is shorter in one run than in the other, rows are matched by the shorter key. Rows of the longer side that matched by the short key and were left without a pair are shown as a separate counter: "extra duplicates by the short key".

If a data file is not found, its header does not match the report columns, or the file was changed (row order broken, a different number of rows), the report says so. A broken order is a comparison error, exit code 2.

### Comparing statement registries

If both runs used `--profile`, the header is followed by a `# Операторы: значимые изменения времени` (statements: significant time changes) section:

```
# Операторы: значимые изменения времени (от 20% и 1000 мс)
dbo.CalcSalary, стр. 154: 9230 -> 2210 мс (-76%), CPU 5230 -> 1210, чтений 1200000 -> 3000
dbo.LoadRates, стр. 40 (текст изменен): 500 -> 2900 мс (+480%), CPU 300 -> 1900, чтений 900 -> 52000
```

- Statements are matched by object and text hash, not by line number: lines shift with any edit of the procedure. Identical statements of one object are matched in order; unchanged statements that swapped places are found too.
- A renamed copy of a procedure or script (`PrintNewPD` → `PrintNewPDTest`, `q.sql` → `q_Test.sql`) is recognized by identical statements: if object A and a differently named object B share at least 3 statements (the hash occurs once in each run) and that is more than half of such statements of object A, they are treated as one object. The report has a line `Объект A … сопоставлен с объектом B … (N одинаковых операторов)` (object A … matched with object B …).
- A statement with changed text (a hint, a column, a join added) is looked for in its own gap: statements of the same object matched by hash are anchors, and a statement between two neighbouring anchors in A is matched with a statement between the same anchors in B. So shifted lines (lines inserted above) do not matter, and a statement cannot "jump" over an unchanged one. In the gap a pair is first taken by the first 20 characters of the text (ignoring spaces and case) if that gives a unique pair, then a pair on the same line. Statements are not matched "in order": on real registries that glued different statements together. Such pairs are marked `(текст изменен)` (text changed), the rest `(нет в A)` or `(нет в B)` (not in A / B). If the statement line in A differs, it is in the mark: `(текст изменен, в A стр. 38)`. A mistake is possible only when several statements with the same text start were rewritten in one gap — then there is no pair rather than a wrong one. Only statements caught by sampling get into the registry, so a fast statement may be in only one of the runs.
- Only statements from the top 20% by time are considered, but at least 5, in A or in B.
- A significant change is at least 20% and at least 1000 ms of time. Both speedups and slowdowns are shown, by descending change.

If only one run has a registry or the registry file is not found, the section says so. The statement table is taken from `registry.csv`, and for registries made before it appeared — from `registry.txt`.

### Comparing two observations (two registries)

```
python CompareQuery.py Sessions_profile\Session_A Sessions_profile\Session_B
```

If both arguments are registry folders (`--session` observations or `--profile` registries) or their `registry.txt`, only statements are compared, without tables. A report cannot be mixed with a folder. Files `<B>__<A>_compare_<time>.txt` and `_short.txt` are written next to folder B. Execution order is not used: joining mid-process, loops and reordering do not affect matching (it is the same as above and goes by lines of the procedure text).
- **Late join.** From `log.csv` the earliest statement seen by the later observation and present in both is taken. Statements of the other observation that ran only before its first execution and are absent from the later one are not counted: line `Наблюдение B началось позже: не учитываются операторы A (N), …` (observation B started later), the list is in the full report. In a loop the first execution is used, so rather less is excluded than more. The first statement of each observation is marked: its start may have passed before joining. Without `log.csv` the start is not aligned, the report says so.
- **Loops.** Significant changes show the run count and time per run: `запусков 100 -> 60 (на запуск 40 -> 41 мс)` — time dropped because of the iteration count, not the statement. The run count is a lower bound.
- **Objects.** Time per object (a renamed copy under B's name): all in the full report, significant changes in the short one. This works even when the algorithm inside the object differs and statements do not match.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success; in mode 2 the results are identical |
| 1 | mode 2: differences found |
| 2 | error (including an aborted run) |

## Running from another program

For a graphical shell (design — `GUI.md`) that runs the script as a background process without a console window:

- the `stop` line on stdin acts like Ctrl+C (in mode 3 — like pressing a key). stdin is read only if it is not a console; on Windows — only a pipe, a file or `NUL` give no commands;
- `--parent-pid PID`: the same if the program with process PID closed (for example, the GUI crashed). The process is opened once at script start, so a new process with the same number is not mistaken for it. If there is no process PID already at start, it is an error, code 2.

The report gives the reason for the stop: `ЗАПУСК ПРЕРВАН: остановлено командой stop` (stopped by the stop command) or `ЗАПУСК ПРЕРВАН: закрылась программа, запустившая скрипт (PID N)` (the program that started the script closed). Unlike Ctrl+C, such a stop does not wait for the end of a long statement: the current statement is cancelled on the server (`SQLCancel`, like the cancel button in SSMS), and the run is aborted immediately. Processing of already fetched tables and writing the report are finished.

After any aborted run without `--rollback` the script executes `IF @@TRANCOUNT > 0 ROLLBACK`: the server does not roll back a transaction opened by the script itself (`BEGIN TRAN`) when a statement is interrupted by an error or a cancel, and its locks would otherwise be held until disconnection. Statements completed before the abort without a transaction stay executed (autocommit).

```
python CompareQuery.py query.sql --repeat 3 --parent-pid 1234 --events
```

### Progress (`--events`)

With `--events` the script writes one JSON line per event to stdout and does not print the report text to stdout (it is in the file). Messages for people still go to stderr. Events add no new queries to the server: they contain only what the script learns anyway. Every event has the fields `event` and `time` (the computer clock with milliseconds — convenient for durations). The server time at the same moment is given by the `clock` event: the difference `server_time - time` converts any `time` to server time. With `--events` SQL messages are not printed to stderr: they arrive as `message` events.

| Event | When | Fields |
|---|---|---|
| `start` | start | `mode` (`run`, `session`, `compare`); for `run`: `sql`, `repeat`, `profile`, `rollback`, `batches`; for `session`: `session`, `folder`; for `compare`: `a`, `b` |
| `pass` | start of a pass | `k`, `of` |
| `clock` | the server clock is measured (first connection) | `server_time` |
| `message` | an SQL message (`PRINT`, `RAISERROR`, error; service messages do not arrive) | `pass`, `server_time`, `text` (without the driver prefix), `error` |
| `slow` | `--profile`, `--session`: the sample query answered in more than 80 ms | `count`, `ms` (how many delays and their sum since the start of the pass or monitoring); in mode 1 also `pass` |
| `batch` | start of a batch | `pass`, `k`, `of`, `ignored` (service batch), `line` (first line in the SQL file) |
| `table` | a table is fetched | `pass`, `n`, `rows` |
| `counters` | the cost of the pass since its start: at the start of a batch, after each table, at the end of a batch; with `--profile` also once a second from the sample | `pass`, `time_ms`, `cpu_ms`, `logical_reads`, `physical_reads`, `client_ms` (`null` if there is no client wait) |
| `statement` | `--profile` and `--session`: another statement started | `object`, `line`, `text` (start of the text in one line), `wait`, `blocked_by`; in mode 1 also `pass` |
| `wait` | the wait of the same statement changed | `wait` (`null` — no wait), `blocked_by`; in mode 1 also `pass` |
| `idle` | no request | in mode 1 `pass` |
| `aborted` | the pass was aborted | `pass`, `reason` |
| `flush` | `--session`: registry files were rewritten | `folder` |
| `stopped` | `--session`: monitoring ended | `reason` |
| `report` | a report or comparison file was written | `path` |
| `done` | the last event | `code` (exit code), `error` (error text or `null`) |

`blocked_by` is the number of the session the request waits for (`blocking_session_id`), if it is positive and not its own session (a parallel plan has its own one there). The counters with `--profile` between measurements are computed as for the control connection: the session counters before the batch plus the request counters from the sample; the client wait in them is as of the last measurement.

```
{"event": "statement", "time": "2026-11-11T09:13:41.207", "object": "dbo.CalcSalary", "line": 154, "text": "update s set Amount = r.Rate * s.Hours from #sal s ...", "wait": "LCK_M_U", "blocked_by": 112, "pass": 2}
```

## Graphical interface

`CompareQueryGUI.py` is a window over the same files and the same script: scripts of the working folder, runs, comparison with a baseline, session monitoring. Principles and screens — `GUI.md` (in Russian).

```
pip install pywebview
python src\CompareQueryGUI.py
```

Or `CompareQueryGUI.exe` in the root (the program is in the `src` subfolder, the current folder is the root next to the exe): it finds Python 3.10+, installs missing packages (pywebview, pyodbc) in a console window with the installation log if needed, and starts the interface without a console. No Python — an error message. To rebuild the exe — `src\launcher\build.cmd` (the exe goes to the root) (the C# compiler of .NET Framework, part of Windows).

- WebView2 is required (part of Windows 10/11; on Windows 8.1 it is installed separately, the last version for it is 109). The interface files are in the `src\gui` folder.
- The time of day in the window is server time, as in the files. Running time (how long a run, a statement or a wait has been going) is counted by the computer clock.
- The run log shows SQL messages together with progress (`SQL` tag, errors in red). The "Sampling delays" plate (`--profile`, monitoring) turns red if the delays add up to more than 5 s or more than 1% of the query time (and does not turn red if they are below 0.05% of the query time): the attribution of time to statements is less precise then.
- Wide tables scroll sideways with a bar that sticks to the bottom of the window while the table is on screen (and with Shift+wheel). CSV contents open immediately even for large files: they are read 500 rows at a time, then "show more". Columns are dragged by the header and hidden (the "Columns" icon), clicking a header sorts; the order and visibility are remembered per kind of table and are the same for all runs (registry, log, CSV of table N of a script, current and heavy queries, the session list, comparison statements). Any table can be collapsed with the icon at the right of its header; that is remembered per kind of table too. In the registry the statement shows the number of its runs `×N`.
- The SQL editor highlights syntax (keywords, strings, comments, variables, temporary tables, numbers). The "Suggest ignored columns" switch in the run parameters: two passes (the first is a warm-up), after the run the ignored columns window opens with the columns that differ between passes; parameters of such a run are not remembered.
- Row actions are icons at the start of the row (statement text, plan, monitor the session and so on), the same in the right-click menu. A log longer than 100 rows is collapsed by default. The default window size is 1728×972, on a smaller screen — 90% of the screen.
- Ignored columns are edited in a window (the filter icon of a script in the panel and in the editor, "Ignore …" on the comparison screen): the resulting list for the script with the source of each column, adding with the scope "this script only" / "all scripts of the group" / "all scripts", auto-detection by a double pass. The window writes `ignored_columns` to `CompareQuery.json` in the same form the CLI reads.
- Comparison screen: verdicts on data and on time, differing tables with row examples, identical ones as a list, significant statement changes as a table (with the wait and the start of the text from the registry). The full text of the mode 2 report is a collapsed card at the bottom.
- External diff (the buttons "Compare with baseline", "Open in diff", "Compare scripts", "Compare CSV"): the program from the settings (click the database at the top of the panel), otherwise from `git config diff.tool`, otherwise TortoiseGitMerge, TortoiseMerge, WinMerge, `code --diff`. The button tooltip says which files open in which program.
- The run result has a time chart across the lineage: runs linked by comparison files (comparable ones); clicking a point opens the run.
- Notes can be added to runs and to monitorings (under the result title, shown in the tree).
- A running run shows a rough estimate under the pass time, from the latest similar run (same script, same number of passes, same profile): "≈ 63% · ≈ 01:20 left".
- In row difference examples long values (over 20 characters) are shown on two lines — old above new, letter under letter.
- A Windows notification when a run or monitoring ends, if it took longer than 30 s and the window is inactive (turned off in the settings: click the database at the top of the panel). Clicking the notification does not open the result.
- Settings (click the database at the top of the panel): a list of saved connections "server — database — login" and "+ new connection"; selecting one fills the fields below, the icons add it as a new one and remove it from the list, "Test" logs in and runs a light query with the entered values (server, database, login, version). "Save" makes the selected connection active — `CompareQuery.py` uses it (the top-level keys `connection_string`, `login`, `password`), the list is stored in the `"GUI"` section. The active connection cannot be removed from the list.
- While no connection has been set up (the active one is the example — `localhost`, `master`, `sa` — and the list has no others), a hint "First set up database connections" pops up next to the connection button at the top of the panel — at start and when pressing "New script", "Monitor a session", "Current queries", "Heavy queries"; the same text is in the middle of the window.
- On the "New monitoring" screen the "Database" filter of the active sessions table defaults to the connection database; filters that do not fit wrap to the next line. The tiles above the table (active sessions, free space, own tiles with your SQL) are hidden for now.
- The interface language is Russian or English (the button in the "Help" row, the choice is remembered). Reports, CSV files and the output of `CompareQuery.py` stay in Russian: they are data that the comparison and the GUI parse.
- In monitoring the statement registry is above the log; the ring next to its heading fills over 10 s until the next file update and resets when the files arrive.
- In the run result, a table that differs from the baseline has a "Differences" button that expands the comparison summary of the table and row examples: which rows changed (was → now) and which are missing in the baseline or in this run. The comparison is the same as in mode 2, over the two CSV files, without the server and without writing files.
- The GUI runs runs, monitorings and comparisons as `CompareQuery.py` processes with `--events --parent-pid`, so the results are the same as from the console, and closing the window stops the processes (the current statement on the server is cancelled).
- The GUI itself accesses the server only with light reads of system views (DMV), through one connection of its own (`APP=CompareQuery gui`):
  - the session list on the "New monitoring" screen — on opening and on demand;
  - **"Current queries"** (menu): every 4 s while the window is visible (a minimized one does not query the server) — user sessions with a request and those blocking others (idle ones with their last query); CompareQuery runs are shown, only its service connections are hidden, server summary plates (sessions, running, waiting for locks, waiting for memory, CPU queue, longest request). The "Input buffer" column is the client's original call (e.g. `exec` of a procedure with parameters), fetched from the server once per new request (SQL Server 2014 SP2+). The ring counts down to the refresh, clicking it pauses. Row actions: query text, plan, input buffer (what the client sent: a procedure call with parameters), monitor the session, KILL;
  - **"Heavy queries"** (menu): on opening and on demand — statements from the plan cache statistics (`sys.dm_exec_query_stats`), sorted by the chosen metric (CPU, time, reads — total or per execution, max time, writes, executions), with a filter by how recently they ran. The numbers are accumulated since the plan was cached;
  - texts and plans — on demand (a plan opens as a `.sqlplan` file from a temporary folder, usually in SSMS).
- The only change the GUI makes on the server is `KILL` of a session on the "Current queries" screen, with confirmation (after "yes" 10 s without asking, each press extends it). The `ALTER ANY CONNECTION` permission is needed.
- The GUI keeps its state (working folder, baseline run, run options, collapsed groups, notes, saved connections, language) in the `"GUI"` section of `CompareQuery.json`; it does not touch other keys.
- Deleting a run moves it to the Windows Recycle Bin (report, CSV files, registry folder, comparison files); a monitoring — its folder in `Sessions_profile`.
- `python src\CompareQueryGUI.py --dev` — the same interface in a browser at http://127.0.0.1:8766 (for debugging, without a window).

Not yet: resizing columns with the mouse and opening the result by clicking a notification.

## Data file format

One database row is exactly one file line. This way the files of two runs can be compared with any diff tool.

- UTF-8 with BOM, line break `\n`, delimiter `;`.
- The first line: column names. Then data rows sorted by the key.
- NULL is an empty cell, an empty string is `""`. A value with `;` or `"` or with a space at the start or end is quoted, `"` inside is doubled.
- Invisible characters are shown explicitly: `\n`, `\r`, `\t`, `\\`, the rest as `\xNN`, `\uNNNN`. This includes the non-breaking space and zero-width characters.
- Numbers are written without an exponent and trailing zeros, so `int`, `bigint`, `decimal` and `bit` with the same value are written the same way. Dates in ISO: `2026-01-31 10:00:00.5`. `datetimeoffset` is converted to UTC with the `Z` suffix. Binary data is written as `0x...`.
- A value longer than 200 characters is truncated: `<first 200 characters>... len <length> <crc32>`. Differences beyond 200 characters are visible only by length and hash. xml, sql_variant and UDT values are always written this way.

This is not quite CSV: Excel opens the file, but line breaks in it are escaped.

## Key

The key is needed to sort rows and to match them between runs. The script orders the columns by priority and takes the shortest prefix of that order that is unique in the data. The priority:

1. The `id` column.
2. Columns ending in `id` (`userId`, `order_id`).
3. Columns containing `period`, then `num`, `name`, `fromDate`.
4. Other columns in table order.
5. Ignored columns from `ignored_columns`, in the same order.

In steps 2 and 3 matches at a word boundary come first (`userId`, `period_start`), then any (`PAID`, `username`). If even all columns together are not unique (full duplicate rows), a virtual duplicate number `#dup` is added to the key.

Then extra columns are removed from the found prefix. The last column of the prefix is required: without it the prefix is not unique. It is set aside into the key, and the search for the shortest unique prefix is repeated among the columns before it, together with those already set aside. This goes on until the columns set aside are unique by themselves. Example: the prefix is `(id, accId, proId, hhId, acsId)`, and `acsId` alone is unique — the key is `(acsId)`. If the key is `(accId, proId, acsId)`, it is found in three repeats.

- No column can be removed from such a key. It may not be the shortest possible one, but with the same data the result is always the same, and columns with higher priority are preferred in it.
- The key columns come in priority order, followed by the other columns in the original order.
- If the key reached ignored columns, extra columns are not removed: it already has all non-ignored ones.
- Each repeat is a check of the columns set aside and a binary search over the columns before the last one. For a one-column key it is one extra check. The time is shown in the report in the `ключ` (key) line of the `Производительность` section.

The row order is textual: `10` comes before `9`. This is enough for comparison: with compatible keys both files are sorted the same way, with different ones they are re-sorted in memory.

## Constants at the top of the script

| Constant | Default | Meaning |
|---|---|---|
| `OUTPUT_DIR` | `""` | folder for results; empty — next to the SQL file (in mode 2 next to report B) |
| `TEMP_DIR` | `None` | folder for temporary files; `None` — the system one |
| `MAX_CELL_LEN` | `200` | threshold for truncating long values |
| `FETCH_BLOCK` | `10000` | rows per `fetchmany` |
| `QUERY_TIMEOUT` | `0` | query timeout in seconds; 0 — no limit |
| `WORKER_MODE` | `"process"` | table processing in a separate process (`"thread"` — in a thread, SQL measurements are less precise) |
| `RTRIM_STRINGS` | `False` | remove trailing spaces from strings |
| `FLOAT_TOLERANCE` | `0` | tolerance when comparing `float` columns in mode 2; 0 — exact comparison |
| `APP_NAME` | `"CompareQuery"` | program name in the connection if the connection string has no `APP` |
| `PROFILE_INTERVAL_MS` | `100` | `--profile`: sampling interval |
| `PROFILE_FAST_MS` | `30` | `--profile`: next sample after a sample inside a function |
| `PROFILE_PLAN_TOP` | `30` | `--profile`, `--session`: for how many statements to save the plan |
| `SAMPLE_SLOW_MS` | `80` | `--profile`, `--session`: an answer to the session request query slower than this is a delay |
| `SESSION_FLUSH_S` | `10` | `--session`: how often (seconds) the registry files are rewritten |
| `SESSION_INPUT_LEN` | `1000` | `--session`: how many characters of the session input buffer to write to the `registry.txt` header |
| `REGISTRY_TEXT_LEN` | `100` | `--profile`, `--session`: how many characters of the statement text to show in `registry.csv` and `log.csv` |
| `SIGNIFICANT_PCT`, `SIGNIFICANT_MS` | `20`, `1000` | mode 2: threshold of a significant change of statement time |
| `TOP_SHARE`, `TOP_MIN` | `0.2`, `5` | mode 2: statements from the top 20% by time are compared, at least 5 |
| `SHORT_CHANGES_MAX` | `10` | mode 2: statement lines in the short report |
| `EXAMPLE_ROWS` | `20` | GUI, "Differences" plate: how many row examples of each kind to show (changed, only in baseline, only in this run) |
| `KEY_EXACT_NAMES`, `KEY_SUFFIXES`, `KEY_SUBSTRINGS` | | key selection rules |
| `DELIM`, `DATA_EXT`, `FILE_ENCODING`, `DT_FORMAT` | | file format |

## Limitations

- **Time depends on server load.** It includes locks by other sessions, the CPU queue and disk reads, and these depend on other queries. If the time changed with the same CPU and reads, the cause is waits: the registry (`--profile`) shows which ones. Result transfer and the script's work are not included in the time (see "Control connection").
- **Boundaries between tables are approximate.** The server does not wait for the client to finish reading a table: the next statements may start before the control connection takes its measurement. So part of the cost of the next statement sometimes falls into the previous table. The total for the run does not change.
- **Types in `create table` are approximate.** The driver does not distinguish `varchar` from `nvarchar` and `int` from `bigint`. The comparison does not depend on types.
- **`real`** arrives with a tail (`0.10000000149...`) and does not match `float` or `decimal` of the same value.
- **`datetime2(7)` and `time(7)`** are read with microsecond precision, the last digit is lost.
- **Unstable queries** (`getdate()`, `newid()`, `top` without `order by`) produce differences on every run. Use `ignored_columns`; `--repeat` helps find such tables, and `--repeat 2` suggests a settings item right away.
- **`GO` is searched line by line.** A `GO` line inside a multi-line `/* */` comment or a string literal also splits the batch.
- **Memory and disk.** One table is held in memory at the sorting stage: about a gigabyte per million rows of 20 columns. While a table is processed, its data is in a temporary file.

## What to check on a real server

The script was tested without SQL Server, on a simulation of the driver and system views. The behaviour of the server and the driver in these points comes from the documentation and needs checking:

- `datetimeoffset`, `xml`, `sql_variant` and UDT (geography, geometry, hierarchyid) are read through pyodbc converters. Check that values of these types are read and get the right type in `create table`.
- For `nvarchar(N)` and `varbinary(N)` the driver reports the declared size. The size in `create table` and skipping the length check for short columns depend on it.
- An error in the middle of a multi-result batch (`RAISERROR`, division by zero) gives `ЗАПУСК ПРЕРВАН`, and the tables already fetched are saved.
- **Counters.** CPU in the summary is close to the query CPU in SSMS (`SET STATISTICS TIME ON`, on a query without scalar functions), and the sum of table costs is not more than CPU in the summary. If the table costs are doubled, the session counters inside a batch already include the current request — report it, this can be fixed.
- **Time and waits.** The time in the summary is close to the query time in SSMS with result output turned off (Query Options → Results → Discard results after execution). In the registry, for long statements time ≈ CPU + client wait + lock wait + resource wait (parallel plans may have more CPU). If the server is older than 2016, the summary says `Ожидание клиента: нет данных`.
- **`--profile` and functions.** The registry has no functions, and the `registry.txt` header has "из них внутри функций" (of them inside functions) above zero on a query that calls a scalar function on many rows. Statement lines match the lines in procedures.
- **`--session`.** The status line follows what Activity Monitor shows; files are updated every 10 seconds; after exiting by a key `registry.txt` says `Состояние: завершено (нажата клавиша)` (state: finished, key pressed). If `registry.csv` is opened in Excel during monitoring, one message appears, and after closing the file is updated again.
- **`--profile` and plans.** The `.sqlplan` files open in SSMS and show the plan of the right statement.
- **SQL messages.** In a script `PRINT 'a'`, `RAISERROR('b', 0, 1) WITH NOWAIT`, then `WAITFOR DELAY '00:00:10'` and `select 1`: the line `b` appears in the console immediately, not after 10 seconds (this is expected from the ODBC documentation: each message is a separate result, the script takes it via `nextset`); `Changed database context` after `USE` is not printed; the message time matches the server time (`SELECT SYSDATETIME()`).
- **GUI: "Current queries" and "Heavy queries".** The "Current" query answers in tens of milliseconds (seen by the refresh rate); a session with `BEGIN TRAN` and `UPDATE` without `COMMIT` in another SSMS window is shown as blocking with its last query, and the one waiting for it — with "Waits for session". "Input buffer" shows a procedure call with parameters. "Heavy queries" answer in seconds even on a large cache; a plan opens in SSMS. KILL of a test session (your own, in SSMS) works, and without the `ALTER ANY CONNECTION` permission there is a clear error.
- **Stopping from another program.** A run with a long statement (for example, `WAITFOR DELAY '00:01'`) and `--events`; the `stop` line on stdin aborts it within a second, the report says "остановлено командой stop". If the script had `BEGIN TRAN` without `--rollback`, after the stop `sys.dm_tran_session_transactions` has no open transaction of that session. While stdin is open, the run does not hang on table processing. In `--session` the number of the blocking session is shown for `LCK_M_*`.
