@echo off
REM R0b EV Test Execution Script for Windows
REM Purpose: Set up PostgreSQL environment and execute all TestR0b* tests
REM Date: 2026-11-10

setlocal enabledelayedexpansion

echo ==========================================
echo R0b EV Test Execution (Windows)
echo ==========================================
echo.

REM Configuration
set PG_USER=work
set PG_PASSWORD=work
set PG_DB=work_test
set PG_PORT=5432
set CONTAINER_NAME=work-test-pg

REM Check if Docker is available
where docker >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Docker is not installed or not in PATH
    echo [INFO] Please install Docker Desktop or use an alternative PostgreSQL setup
    exit /b 1
)

REM Stop and remove existing container if it exists
docker ps -a --format "{{.Names}}" | findstr "^%CONTAINER_NAME%$" >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo [WARN] Removing existing container %CONTAINER_NAME%...
    docker stop %CONTAINER_NAME% >nul 2>nul
    docker rm %CONTAINER_NAME% >nul 2>nul
)

REM Start PostgreSQL container
echo [INFO] Starting PostgreSQL 16 container...
docker run -d ^
    --name %CONTAINER_NAME% ^
    -e POSTGRES_USER=%PG_USER% ^
    -e POSTGRES_PASSWORD=%PG_PASSWORD% ^
    -e POSTGRES_DB=%PG_DB% ^
    -p %PG_PORT%:5432 ^
    postgres:16 >nul 2>nul

if %ERRORLEVEL% neq 0 (
    echo [ERROR] Failed to start PostgreSQL container
    exit /b 1
)

echo [INFO] PostgreSQL container started

REM Wait for PostgreSQL to be ready
echo [INFO] Waiting for PostgreSQL to be ready...
timeout /t 5 /nobreak >nul

REM Verify connection
echo [INFO] Verifying PostgreSQL connection...
docker exec %CONTAINER_NAME% psql -U %PG_USER% -d %PG_DB% -c "SELECT 1" >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Failed to connect to PostgreSQL
    docker logs %CONTAINER_NAME%
    exit /b 1
)

echo [INFO] PostgreSQL is ready

REM Set environment variable for Go tests
set WORK_TEST_PG_URL=postgres://%PG_USER%:%PG_PASSWORD%@localhost:%PG_PORT%/%PG_DB%?sslmode=disable
echo [INFO] Set WORK_TEST_PG_URL=%WORK_TEST_PG_URL%

REM Navigate to work directory
cd /d "%~dp0\.."
echo [INFO] Working directory: %CD%

REM Run code quality checks first
echo [INFO] Running code quality checks...
echo.

echo [INFO] 1. Go build...
go build ./internal/migrate/... 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR]    X Build failed
    exit /b 1
)
echo [INFO]    ✓ Build passed

echo [INFO] 2. Go vet...
go vet ./internal/migrate/... 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR]    X Vet failed
    exit /b 1
)
echo [INFO]    ✓ Vet passed

echo [INFO] 3. Go fmt...
gofmt -l ./internal/migrate/r0b_*.go >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR]    X Format check failed
    exit /b 1
)
echo [INFO]    ✓ Format check passed

echo.
echo [INFO] All code quality checks passed!
echo.

REM List all TestR0b* tests
echo [INFO] Listing all TestR0b* tests...
for /f %%i in ('go test ./internal/migrate -run "TestR0b" -list ".*" 2^>nul ^| findstr /r "^TestR0b" ^| find /c /v ""') do set TEST_COUNT=%%i
echo [INFO] Found %TEST_COUNT% TestR0b* functions
echo.

REM Execute tests
echo [INFO] Executing TestR0b* tests...
echo [INFO] This may take several minutes...
echo.

REM Create results file with timestamp
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set datetime=%%I
set RESULTS_FILE=ev-test-results-%datetime:~0,8%-%datetime:~8,6%.log
echo [INFO] Results will be saved to: %RESULTS_FILE%
echo.

REM Run tests with verbose output
go test ./internal/migrate -run "TestR0b" -v > "%RESULTS_FILE%" 2>&1
if %ERRORLEVEL% equ 0 (
    echo [INFO] Tests completed successfully
) else (
    echo [ERROR] Tests failed
)

echo.
echo ========================================== 
echo [INFO] Test Execution Summary
echo ========================================== 
echo.

REM Parse results
if exist "%RESULTS_FILE%" (
    findstr /r "^--- PASS:" "%RESULTS_FILE%" | find /c /v "" > temp_pass.txt
    set /p PASS_COUNT=<temp_pass.txt
    del temp_pass.txt
    
    findstr /r "^--- FAIL:" "%RESULTS_FILE%" | find /c /v "" > temp_fail.txt
    set /p FAIL_COUNT=<temp_fail.txt
    del temp_fail.txt
    
    findstr /r "^--- SKIP:" "%RESULTS_FILE%" | find /c /v "" > temp_skip.txt
    set /p SKIP_COUNT=<temp_skip.txt
    del temp_skip.txt
    
    echo [INFO] PASS: %PASS_COUNT%
    echo [INFO] FAIL: %FAIL_COUNT%
    echo [INFO] SKIP: %SKIP_COUNT%
    echo.
    
    if %FAIL_COUNT% gtr 0 (
        echo [ERROR] Some tests failed. Check %RESULTS_FILE% for details.
        echo.
        echo [INFO] Failed tests:
        findstr /r "^--- FAIL:" "%RESULTS_FILE%"
    ) else if %SKIP_COUNT% gtr 0 (
        echo [WARN] Some tests were skipped. Check %RESULTS_FILE% for details.
    ) else (
        echo [INFO] All tests passed!
    )
) else (
    echo [ERROR] Results file not found
)

echo.
echo ========================================== 
echo [INFO] Next Steps
echo ========================================== 
echo.
echo [INFO] 1. Review test results in: %RESULTS_FILE%
echo [INFO] 2. Analyze any failures and fix issues
echo [INFO] 3. Prepare C26 review materials with this evidence
echo [INFO] 4. To stop PostgreSQL container:
echo [INFO]    docker stop %CONTAINER_NAME%
echo [INFO] 5. To remove PostgreSQL container:
echo [INFO]    docker rm %CONTAINER_NAME%
echo.

REM Keep container running for manual inspection
echo [INFO] PostgreSQL container is still running for manual inspection
echo [INFO] Connection string: %WORK_TEST_PG_URL%
echo.

endlocal
