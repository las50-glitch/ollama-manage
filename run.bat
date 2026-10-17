@echo off
rem Запуск панели управления Ollama в Windows (аналог run.sh для Linux/macOS).
rem
rem   run.bat                       - запуск на 127.0.0.1:5000
rem   set PANEL_PORT=8080 & run.bat - другой порт
rem
rem Скрипт сам создаёт виртуальное окружение (venv) и ставит зависимости,
rem если их ещё нет. Требуется Python 3.10+ в PATH (проверка: python --version).

setlocal
rem UTF-8 в консоли: иначе кириллица в выводе панели превращается в мусор.
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

set "PROJECT_DIR=%~dp0"
set "VENV_DIR=%PROJECT_DIR%venv"
set "VENV_PY=%VENV_DIR%\Scripts\python.exe"

rem При запуске двойным щелчком окно закрывается сразу после завершения
rem скрипта, поэтому при ошибке ждём нажатия клавиши. Признак двойного щелчка -
rem "/c" в командной строке родительского процесса.
set "PAUSE_ON_ERROR="
echo "%cmdcmdline%" | find /i "/c" >nul && set "PAUSE_ON_ERROR=1"

cd /d "%PROJECT_DIR%" || goto :failed

if not exist "%VENV_PY%" call :create_venv
if errorlevel 1 goto :failed

rem venv мог остаться от прошлой версии панели: проверяем зависимости.
"%VENV_PY%" -c "import flask, requests" >nul 2>nul
if errorlevel 1 call :install_deps
if errorlevel 1 goto :failed

if "%PANEL_HOST%"=="" set "PANEL_HOST=127.0.0.1"
if "%PANEL_PORT%"=="" set "PANEL_PORT=5000"
echo ^>^> Панель управления Ollama: http://%PANEL_HOST%:%PANEL_PORT%
echo ^>^> Остановить панель: Ctrl+C в этом окне

"%VENV_PY%" "%PROJECT_DIR%app.py" %*
if errorlevel 1 goto :failed

endlocal & exit /b 0


rem ---------------------------------------------------------------------
rem Создание виртуального окружения и установка зависимостей.
rem ---------------------------------------------------------------------
:create_venv
echo ^>^> Создаю виртуальное окружение: %VENV_DIR%

rem Предпочитаем лаунчер "py -3": он сам находит подходящий Python 3.
set "PY_LAUNCHER=python"
where py >nul 2>nul && set "PY_LAUNCHER=py -3"

%PY_LAUNCHER% -m venv "%VENV_DIR%"
if errorlevel 1 (
  echo ^>^> Не удалось создать venv. Проверьте, что Python 3.10+ установлен
  echo     и добавлен в PATH: python --version
  exit /b 1
)

call :install_deps
exit /b %errorlevel%


rem ---------------------------------------------------------------------
rem Установка зависимостей панели в виртуальное окружение.
rem ---------------------------------------------------------------------
:install_deps
echo ^>^> Ставлю зависимости из requirements.txt
"%VENV_PY%" -m pip install --upgrade pip
if errorlevel 1 exit /b 1

"%VENV_PY%" -m pip install -r "%PROJECT_DIR%requirements.txt"
if errorlevel 1 exit /b 1

exit /b 0


rem ---------------------------------------------------------------------
rem Сообщение об ошибке.
rem ---------------------------------------------------------------------
:failed
echo.
echo ^>^> Не удалось запустить панель. Проверьте, что:
echo    * установлен Python 3.10+ (python --version);
echo    * порт %PANEL_PORT% свободен;
echo    * Ollama установлена и запущена (ollama --version).
if defined PAUSE_ON_ERROR pause
endlocal & exit /b 1
