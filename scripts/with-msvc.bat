@echo off
REM Wrapper that sources vcvars64.bat then execs the rest of the command line.
REM Used to invoke cargo tauri build (and friends) from bash where the MSVC
REM env (LIB, INCLUDE, PATH) is otherwise not set.
set "PATH=%USERPROFILE%\.cargo\bin;C:\Program Files (x86)\Microsoft Visual Studio\Installer;%PATH%"
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >NUL
%*
exit /b %ERRORLEVEL%
