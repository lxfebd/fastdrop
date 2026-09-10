@echo off
REM FastDrop launcher: installs PySide6 and builds the Rust engine on demand.
setlocal
cd /d %~dp0

where python >nul 2>nul
if errorlevel 1 (
    echo Python not found on PATH. Install it from https://python.org and re-run.
    pause
    exit /b 1
)

REM --- Python side: PySide6 ---
python -c "import PySide6" >nul 2>nul
if errorlevel 1 (
    echo First run: installing Python dependencies ...
    python -m pip install --upgrade pip
    python -m pip install -r requirements.txt
    if errorlevel 1 (
        echo Dependency install failed. Run manually:  python -m pip install -r requirements.txt
        pause
        exit /b 1
    )
)

REM --- Rust side: the download engine runs as a separate process so heavy
REM --- downloads don't hold the GIL and make the UI stutter. Missing binary
REM --- is not fatal -- the app silently falls back to the built-in Python
REM --- engine, which is just slower.
set "ENG=engine-rs\target\release\fastdrop-engine.exe"
if not exist "%ENG%" (
    where cargo >nul 2>nul
    if errorlevel 1 (
        echo Rust toolchain not found -- falling back to the Python engine.
        echo Install Rust from https://rustup.rs, then re-run to build the fast engine.
    ) else (
        echo Building the Rust download engine (first time only) ...
        pushd engine-rs
        set CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse
        cargo build --release
        if errorlevel 1 (
            echo Rust build failed -- falling back to the Python engine.
        )
        popd
    )
)

python fastdrop\main.py %*
pause
