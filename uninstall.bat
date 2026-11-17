@echo off
setlocal
pushd "%~dp0"
where python >nul 2>nul
if not errorlevel 1 goto :run_python
where py >nul 2>nul
if not errorlevel 1 goto :run_py
echo [ERROR] Python 3 not found in PATH.
popd
pause
exit /b 1

:run_python
python "install.py" --action uninstall --restart-app --pause %*
set "EXIT_CODE=%errorlevel%"
popd
exit /b %EXIT_CODE%

:run_py
py -3 "install.py" --action uninstall --restart-app --pause %*
set "EXIT_CODE=%errorlevel%"
popd
exit /b %EXIT_CODE%
