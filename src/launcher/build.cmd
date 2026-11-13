@echo off
rem Builds CompareQueryGUI.exe in the project root (two levels up: src\launcher -> root) from
rem CompareQueryGUI.cs with the C# compiler of .NET Framework 4 (part of Windows 8.1/10/11, nothing to install).
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
"%CSC%" /nologo /codepage:65001 /target:winexe /optimize+ /out:"%~dp0..\..\CompareQueryGUI.exe" "%~dp0CompareQueryGUI.cs"
