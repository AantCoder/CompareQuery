// CompareQueryGUI.exe - запуск CompareQueryGUI.py без консоли (README, «Графический интерфейс»).
// Своего окна нет: либо сообщение об ошибке, либо консоль установки пакетов, либо просто запуск.
//   1. Ищет Python 3.10+: py.exe -3, python.exe из PATH (кроме заглушки Microsoft Store), реестр PythonCore.
//      Нет - сообщение об ошибке.
//   2. Проверяет пакеты (pywebview, pyodbc, psycopg) без их импорта. Нет - консоль «Установка необходимых пакетов
//      python: ...» с логом pip; после ее закрытия проверяет еще раз: ошибка или запуск.
//   3. Запускает pythonw.exe src\CompareQueryGUI.py (папка exe - текущая), аргументы передаются дальше.
// Сборка: src\launcher\build.cmd (компилятор C# из .NET Framework 4, есть в Windows 8.1/10/11), exe - в корне.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
using Microsoft.Win32;

static class Launcher
{
    const string Title = "CompareQuery";
    // модуль для проверки -> пакет pip
    static readonly string[,] Packages = { { "webview", "pywebview" }, { "pyodbc", "pyodbc" }, { "psycopg", "psycopg[binary]" } };

    [STAThread]
    static int Main(string[] args)
    {
        // программа - в подпапке src рядом с exe (или, как раньше, рядом с exe); текущая папка - папка exe
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string script = Path.Combine(dir, "src", "CompareQueryGUI.py");
        if (!File.Exists(script)) script = Path.Combine(dir, "CompareQueryGUI.py");
        if (!File.Exists(script))
            return Fail("Не найден файл\n" + Path.Combine(dir, "src", "CompareQueryGUI.py") + "\n\nCompareQueryGUI.exe должен лежать рядом с папкой src программы.");
        string python = FindPython();
        if (python == null)
            return Fail("Не найден Python 3.10 или новее.\n\nУстановите Python с python.org (при установке отметьте «Add python.exe to PATH») и запустите CompareQueryGUI.exe снова.");
        List<string> missing = Missing(python);
        if (missing == null)
            return Fail("Не удалось проверить пакеты Python:\n" + python);
        if (missing.Count > 0)
        {
            Install(python, missing);
            List<string> left = Missing(python);
            if (left == null || left.Count > 0)
                return Fail("Не удалось установить пакеты Python: " + string.Join(", ", (left ?? missing).ToArray()) +
                            ".\n\nУстановите их вручную в командной строке:\n\"" + python + "\" -m pip install " + string.Join(" ", (left ?? missing).ToArray()));
        }
        string pythonw = Path.Combine(Path.GetDirectoryName(python), "pythonw.exe");
        var psi = new ProcessStartInfo(File.Exists(pythonw) ? pythonw : python, Quote(script) + Rest(args));
        psi.WorkingDirectory = dir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        Process.Start(psi);
        return 0;
    }

    static int Fail(string text)
    {
        MessageBox.Show(text, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
        return 1;
    }

    // Python 3.10+: первый подходящий из py.exe, PATH, реестра. Возвращает путь к python.exe или null.
    static string FindPython()
    {
        var seen = new List<string>();
#if TEST
        seen.Add(Environment.GetEnvironmentVariable("CQ_TEST_PYTHON"));   // только тестовая сборка
#endif
        string viaPy = Run("py.exe", "-3 -c \"import sys; print(sys.executable)\"");
        if (viaPy != null) seen.Add(viaPy.Trim());
        foreach (string d in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            if (d.Trim() == "" || d.IndexOf("\\WindowsApps", StringComparison.OrdinalIgnoreCase) >= 0) continue;   // заглушка Store
            try { seen.Add(Path.Combine(d.Trim().Trim('"'), "python.exe")); } catch (ArgumentException) { }
        }
        foreach (RegistryHive hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
            foreach (RegistryView view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
            {
                try
                {
                    using (RegistryKey core = RegistryKey.OpenBaseKey(hive, view).OpenSubKey(@"Software\Python\PythonCore"))
                    {
                        if (core == null) continue;
                        string[] versions = core.GetSubKeyNames();
                        Array.Sort(versions);
                        Array.Reverse(versions);           // сначала новые
                        foreach (string v in versions)
                            using (RegistryKey ip = core.OpenSubKey(v + @"\InstallPath"))
                                if (ip != null && ip.GetValue("") != null)
                                    seen.Add(Path.Combine(ip.GetValue("").ToString(), "python.exe"));
                    }
                }
                catch (Exception) { }
            }
        foreach (string p in seen)
        {
            if (!File.Exists(p)) continue;
            string ok = Run(p, "-c \"import sys; print(sys.version_info >= (3, 10))\"");
            if (ok != null && ok.Trim() == "True") return p;
        }
        return null;
    }

    // Пакеты pip, которых нет (проверка find_spec - без импорта); null - Python не ответил.
    static List<string> Missing(string python)
    {
        var mods = new List<string>();
        for (int i = 0; i < Packages.GetLength(0); i++) mods.Add("'" + Packages[i, 0] + "'");
        string res = Run(python, "-c \"import importlib.util as u; print(' '.join(m for m in (" + string.Join(", ", mods.ToArray()) +
                                 ",) if u.find_spec(m) is None))\"");
        if (res == null) return null;
        var missing = new List<string>();
        foreach (string m in res.Split(new[] { ' ', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            for (int i = 0; i < Packages.GetLength(0); i++)
                if (Packages[i, 0] == m) missing.Add(Packages[i, 1]);
        return missing;
    }

    // Консоль установки: заголовок, перечень пакетов, лог pip; окно ждет нажатия клавиши или закрытия.
    static void Install(string python, List<string> packages)
    {
        string list = string.Join(" ", packages.ToArray());
        string cmd = "title CompareQuery - установка пакетов Python & echo Установка необходимых пакетов python: " +
                     string.Join(", ", packages.ToArray()) + " & echo. & \"" + python + "\" -m pip install --disable-pip-version-check " + list +
                     " & echo. & pause";
        var psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "cmd.exe"), "/s /c \"" + cmd + "\"");
        psi.UseShellExecute = false;
        psi.CreateNoWindow = false;          // своя консоль: лаунчер - оконное приложение без консоли
        using (Process p = Process.Start(psi)) p.WaitForExit();
    }

    // Запуск без окна; вывод stdout или null (не запустился, код возврата не 0 или дольше 60 с).
    static string Run(string file, string arguments)
    {
        try
        {
            var psi = new ProcessStartInfo(file, arguments);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            using (Process p = Process.Start(psi))
            {
                p.ErrorDataReceived += (s, e) => { };
                p.BeginErrorReadLine();
                string output = p.StandardOutput.ReadToEnd();
                if (!p.WaitForExit(60000)) { try { p.Kill(); } catch (Exception) { } return null; }
                return p.ExitCode == 0 ? output : null;
            }
        }
        catch (Exception) { return null; }
    }

    static string Quote(string s) { return "\"" + s.Replace("\"", "\\\"") + "\""; }

    static string Rest(string[] args)
    {
        string s = "";
        foreach (string a in args) s += " " + Quote(a);
        return s;
    }
}
