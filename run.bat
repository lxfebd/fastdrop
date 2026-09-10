@echo off
REM FastDrop launcher: builds the Rust engine on demand, then starts the Electron app.
setlocal
cd /d %~dp0

REM --- Rust side: the download engine runs as a separate process so heavy
REM --- downloads don't block the UI thread. The packaged app ships its own copy
REM --- under resources\, so this only matters for dev runs via run.bat.
set "ENG=engine-rs\target\release\fastdrop-engine.exe"
if not exist "%ENG%" (
    where cargo >nul 2>nul
    if errorlevel 1 (
        echo Rust toolchain not found -- building the download engine requires it.
        echo Install Rust from https://rustup.rs, then re-run.
        pause
        exit /b 1
    )
    echo Building the Rust download engine (first time only) ...
    pushd engine-rs
    set CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse
    cargo build --release
    if errorlevel 1 (
        echo Rust build failed.
        pause
        exit /b 1
    )
    popd
)

REM --- Electron side ---
if not exist "app\node_modules" (
    echo Installing frontend dependencies (first run) ...
    pushd app
    call npm install
    if errorlevel 1 (
        echo npm install failed.
        pause
        exit /b 1
    )
    popd
)

pushd app
call npm run dist:dir
if errorlevel 1 (
    echo Package failed.
    pause
    exit /b 1
)
popd

start "" "%~dp0app\release\win-unpacked\fastdrop.exe"
