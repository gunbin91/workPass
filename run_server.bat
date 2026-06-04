@echo off
title QR 출석체크 서버 실행기
cd /d "%~dp0"

echo =========================================
echo 🚀 라이브러리 설치 상태 확인 중...
echo =========================================

:: node_modules 폴더나 multer 라이브러리가 있는지 체크
if not exist "node_modules\multer" (
    echo [정보] 필수 라이브러리가 없습니다. 자동 설치를 시작합니다...
    call npm install
    if %errorlevel% neq 0 (
        echo [오류] 라이브러리 설치에 실패했습니다. 인터넷 연결을 확인하세요.
        pause
        exit /b
    )
    echo [완료] 설치가 완료되었습니다.
) else (
    echo [확인] 모든 라이브러리가 준비되었습니다.
)

echo.
echo =========================================
echo 🚀 QR 자동 출석체크 [웹 서버] 실행
echo =========================================
node server.js
pause
