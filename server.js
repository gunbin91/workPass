const express = require('express');
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 4000;
const SESSIONS_DIR = path.join(__dirname, 'sessions');

// Render 서버인지 확인하는 변수
const isServer = process.env.RENDER === 'true';

// 세션 디렉토리 없으면 생성
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR);
}

// ============================================
// 🔄 Render 환경변수에서 세션 복원
// ============================================
Object.keys(process.env).forEach(key => {
  if (key.startsWith('SESSION_DATA_')) {
    // 키가 "SESSION_DATA_GUNBIN" 이라면 username은 "GUNBIN"이 됨
    const username = key.replace('SESSION_DATA_', '');
    const sessionFilePath = path.join(SESSIONS_DIR, `${username}.json`);
    try {
      // 환경변수에 저장된 값을 파일로 저장
      fs.writeFileSync(sessionFilePath, process.env[key], 'utf-8');
      console.log(`✅ [환경변수 복원] ${username}.json 파일 생성 완료`);
    } catch (e) {
      console.error(`❌ [환경변수 복원 실패] ${username}:`, e.message);
    }
  }
});

// 📍 현재 PC 기준 고정 위치 정보
const FIXED_LOCATION = {
  latitude: 37.4784,
  longitude: 126.8982
};

// 📱 아이폰 13 기기 정보
const iPhone = devices['iPhone 13'];

let isRunning = false;

// 사용자별 세션 파일 경로 가져오기
function getAuthPath(username) {
  return path.join(SESSIONS_DIR, `${username}.json`);
}

// 봇 실행 핵심 함수
async function runBot(username, forceLogin = false) {
  if (isRunning) return { success: false, message: '⚠️ 이미 다른 작업이 진행 중입니다. 잠시 후 다시 시도해주세요.' };
  isRunning = true;
  
  const authFile = getAuthPath(username);
  let browser;
  try {
    const shouldBeHeadless = isServer ? true : !forceLogin;

    browser = await chromium.launch({ 
      headless: shouldBeHeadless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });
    
    let contextOptions = {
      ...iPhone,
      geolocation: FIXED_LOCATION,
      permissions: ['geolocation'],
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul'
    };
    
    if (fs.existsSync(authFile)) {
      try {
        const fileContent = fs.readFileSync(authFile, 'utf-8');
        if (fileContent.trim() !== '') {
           contextOptions.storageState = authFile;
        }
      } catch(e) {}
    }

    const context = await browser.newContext(contextOptions);
    await context.addInitScript("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})");
    const page = await context.newPage();

    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/api/trpc/attendance.scan') || url.includes('/api/trpc/qr.getCurrent')) {
        try {
          const body = await response.text();
          console.log(`\n[${username} API 응답] ${response.status()} | ${url}`);
          console.log(`[데이터] ${body.substring(0, 200)}`);
        } catch (e) {}
      }
    });

    await page.goto('https://qrattend-ffrof5pm.manus.space/');
    let token = null;
    let isLoggedin = false;

    const checkToken = async () => {
      try {
        const response = await page.request.get('https://qrattend-ffrof5pm.manus.space/api/trpc/qr.getCurrent?batch=1&input=%7B%7D');
        const data = await response.json();
        const extractedToken = data[0]?.result?.data?.json?.token || data[0]?.result?.data?.token;
        if (extractedToken) {
          token = extractedToken;
          return true;
        }
      } catch (e) {}
      return false;
    };

    await page.waitForTimeout(2000);
    isLoggedin = await checkToken();

    if (!isLoggedin) {
      if (!forceLogin) {
        return { success: false, message: `⚠️ 세션이 없습니다. [로그인] 버튼을 누르거나 파일을 업로드해주세요.` };
      }
      
      try {
        const loginBtn = page.locator('button:has-text("로그인")');
        if (await loginBtn.count() > 0) await loginBtn.first().click();
      } catch (e) {}

      const maxAttempts = isServer ? 10 : 100;
      for (let i = 0; i < maxAttempts; i++) {
        await page.waitForTimeout(3000);
        if (page.url().includes('qrattend-ffrof5pm.manus.space')) {
           isLoggedin = await checkToken();
           if (isLoggedin) {
             await page.waitForTimeout(2000);
             await context.storageState({ path: authFile });
             break;
           }
        }
      }
    }
    
    if (forceLogin) {
      return isLoggedin 
        ? { success: true, message: `✅ 로그인이 완료되고 세션이 저장되었습니다!` }
        : { success: false, message: '⚠️ 로그인 실패 (시간 초과 또는 오류)' };
    }

    if (!token) return { success: false, message: '❌ 출석체크 토큰 획득 실패' };

    const scanUrl = `https://qrattend-ffrof5pm.manus.space/scan?token=${token}`;
    let apiResultMessage = "🎉 출석체크 요청 완료";
    let apiSuccess = true;

    const responsePromise = page.waitForResponse(r => r.url().includes('/api/trpc/attendance.scan'), { timeout: 10000 })
      .then(async (r) => {
        const data = await r.json();
        if (data[0]?.result?.data?.json?.message || data[0]?.result?.data?.message) {
          apiResultMessage = data[0].result.data.json?.message || data[0].result.data.message;
          apiSuccess = true;
        } else if (data[0]?.error?.json?.message || data[0]?.error?.message) {
          apiResultMessage = data[0].error.json?.message || data[0].error.message;
          apiSuccess = false;
        }
      }).catch(() => {});

    await page.goto(scanUrl);
    await responsePromise;

    return { success: apiSuccess, message: apiResultMessage };

  } catch (error) {
    console.error(`[작업 실패 - ${username}]:`, error.message);
    return { success: false, message: `❌ 오류: ${error.message}` };
  } finally {
    if (browser) await browser.close();
    isRunning = false;
  }
}

async function checkSessionStatus(username) {
  const authFile = getAuthPath(username);
  if (!fs.existsSync(authFile)) return { isLoggedin: false, message: '저장된 세션 없음 (파일 없음)' };
  
  try {
    const fileContent = fs.readFileSync(authFile, 'utf-8');
    if (fileContent.trim() === '') return { isLoggedin: false, message: '빈 세션 (로그인 필요)' };
    JSON.parse(fileContent); // JSON 형식 검증
  } catch(e) {
    return { isLoggedin: false, message: '⚠️ 유효하지 않은 파일 형식 (JSON 오류)' };
  }

  let browser;
  try {
    browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    
    const context = await browser.newContext({ storageState: authFile });
    const page = await context.newPage();
    const response = await page.request.get('https://qrattend-ffrof5pm.manus.space/api/trpc/qr.getCurrent?batch=1&input=%7B%7D', { timeout: 15000 });
    const data = await response.json();
    const isLoggedin = !!(data[0]?.result?.data?.json?.token || data[0]?.result?.data?.token);
    
    return { 
      isLoggedin, 
      message: isLoggedin ? '✅ 세션 유효함 (출첵 가능)' : '⚠️ 세션 만료됨 (재로그인 또는 업로드 필요)' 
    };
  } catch (e) {
    console.error(`[상태 확인 실패 - ${username}]:`, e.message);
    // 에러 메시지가 너무 길면 잘라서 전송
    const shortError = e.message.length > 60 ? e.message.substring(0, 60) + '...' : e.message;
    return { isLoggedin: false, message: `❌ 오류: ${shortError}` };
  } finally {
    if (browser) await browser.close();
  }
}

// 근태 기록 가져오기 함수
async function fetchRecords(username) {
  const authFile = getAuthPath(username);
  if (!fs.existsSync(authFile)) return { success: false, message: '저장된 세션이 없습니다.' };

  let browser;
  try {
    browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    
    const context = await browser.newContext({ storageState: authFile });
    const page = await context.newPage();
    
    // 이달의 시작일과 종료일 계산
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    
    // YYYY-MM-DD 형식 포맷팅
    const formatDate = (d) => {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}T00:00:00.000Z`; // UTC 기준으로 요청하는 것 같음
    };

    const startStr = formatDate(firstDay);
    const endStr = formatDate(lastDay);

    // URI 인코딩된 tRPC 요청 (attendance.myRange)
    // input = {"0":{"json":{"start":"2024-05-31T15:00:00.000Z","end":"2024-06-30T14:59:59.999Z"}}}
    // 로컬 타임존 이슈를 피하기 위해 간단히 이번달 데이터를 범위로 요청
    const inputObj = {
      "0": {
        "json": {
          "from": startStr,
          "to": endStr
        }
      }
    };
    const encodedInput = encodeURIComponent(JSON.stringify(inputObj));
    const url = `https://qrattend-ffrof5pm.manus.space/api/trpc/attendance.myRange?batch=1&input=${encodedInput}`;

    const response = await page.request.get(url, { timeout: 15000 });
    const data = await response.json();
    
    // 에러 체크
    if (data[0]?.error) {
       console.error(`[기록 API 에러 - ${username}]:`, JSON.stringify(data[0].error, null, 2));
       const apiErrorMsg = data[0].error.json?.message || data[0].error.message || '알 수 없는 API 에러';
       return { success: false, message: `데이터 요청 실패: ${apiErrorMsg}` };
    }

    const records = data[0]?.result?.data?.json || data[0]?.result?.data || [];
    
    return { success: true, data: records };
    
  } catch (e) {
    console.error(`[기록 조회 실패 - ${username}]:`, e.message);
    return { success: false, message: '기록 조회 중 오류가 발생했습니다.' };
  } finally {
    if (browser) await browser.close();
  }
}

// ============================================
// 📁 파일 업로드 설정 (Multer)
// ============================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SESSIONS_DIR),
  filename: (req, file, cb) => {
    const username = req.body.username || 'unknown';
    cb(null, `${username}.json`);
  }
});
const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname) !== '.json') {
      return cb(new Error('❌ .json 파일만 업로드 가능합니다.'));
    }
    cb(null, true);
  }
});

// ============================================
// 🌐 웹 서버 엔드포인트
// ============================================

app.get('/', async (req, res) => {
  const username = req.query.user;
  const users = fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));

  if (!username) {
    return res.send(`
      <html>
      <head>
        <title>QR 출석체크 - 메인</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=0">
        <style>
          * { box-sizing: border-box; }
          body { font-family: 'Malgun Gothic', sans-serif; padding: 15px; margin: 0; background: #f0f2f5; text-align: center; color: #333; }
          .container { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 100%; max-width: 450px; text-align: left; display: inline-block; }
          h1 { color: #0081f2; text-align: center; margin-top: 0; font-size: 22px; }
          .card { border: 1px solid #e2e8f0; padding: 15px; border-radius: 10px; margin-bottom: 20px; background: #fafafa; }
          .input-group { display: flex; gap: 8px; }
          input[type="text"] { padding: 12px; border: 1px solid #ddd; border-radius: 6px; width: 100%; font-size: 16px; }
          button { border: none; padding: 12px 20px; border-radius: 6px; font-weight: bold; cursor: pointer; transition: 0.2s; white-space: nowrap; font-size: 15px; }
          .btn-blue { background: #3b82f6; color: white; }
          .btn-blue:hover { background: #2563eb; }
          .user-list-title { margin: 20px 0 10px; font-weight: bold; display: flex; justify-content: space-between; align-items: center; }
          .user-item { 
            padding: 15px; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 10px; 
            display: flex; justify-content: space-between; align-items: center; background: white;
            cursor: pointer; transition: 0.2s; word-break: break-all;
          }
          .user-item:hover { border-color: #3b82f6; background: #f0f9ff; transform: translateX(5px); }
          .user-name { font-size: 16px; font-weight: bold; }
          .badge { font-size: 12px; padding: 4px 8px; border-radius: 10px; background: #e2e8f0; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🚀 출석체크 서버</h1>
          
          <div class="card">
            <h3 style="margin-top:0; font-size:15px; color:#666;">사용자 등록 (이름만 입력)</h3>
            <div class="input-group">
              <input type="text" id="newUsername" placeholder="예: 홍길동">
              <button class="btn-blue" onclick="signup()">등록</button>
            </div>
          </div>

          <div class="user-list-title">
            <span>👥 등록된 사용자 목록</span>
            <span class="badge">${users.length}명</span>
          </div>
          
          <div class="user-list">
            ${users.length === 0 ? '<p style="text-align:center; color:#999; padding: 20px;">등록된 사용자가 없습니다.</p>' : users.map(u => `
              <div class="user-item" onclick="location.href='/?user=${encodeURIComponent(u)}'">
                <span class="user-name">${u}</span>
                <span style="color:#0081f2; font-size:14px;">접속하기 ➔</span>
              </div>
            `).join('')}
          </div>
        </div>
        <script>
          async function signup() {
            const name = document.getElementById('newUsername').value.trim();
            if(!name) return alert('이름을 입력해주세요.');
            const res = await fetch('/api/signup?name=' + encodeURIComponent(name));
            const data = await res.json();
            alert(data.message);
            if(data.success) location.reload();
          }
        </script>
      </body>
      </html>
    `);
  }

  res.send(`
    <html>
    <head>
      <title>${username}님의 관리실</title>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=0">
      <style>
        * { box-sizing: border-box; }
        body { font-family: 'Malgun Gothic', sans-serif; padding: 15px; margin: 0; background: #f0f2f5; text-align: center; }
        .container { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 100%; max-width: 500px; display: inline-block; text-align: left; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid #eee; padding-bottom: 15px; }
        .user-name { font-size: 18px; font-weight: bold; color: #0081f2; word-break: break-all; margin-right: 10px; }
        .btn-back { font-size: 13px; color: #666; text-decoration: none; border: 1px solid #ddd; padding: 6px 12px; border-radius: 4px; background: white; white-space: nowrap; }
        .status-box { margin-bottom: 20px; padding: 15px; border-radius: 8px; font-size: 14px; background: #f8fafc; border: 1px solid #e2e8f0; text-align: center; word-break: keep-all; }
        button { border: none; padding: 16px; border-radius: 10px; font-size: 15px; font-weight: bold; cursor: pointer; transition: 0.2s; width: 100%; margin-bottom: 12px; }
        .btn-checkin { background: #22c55e; color: white; }
        .btn-checkin:hover { background: #16a34a; transform: translateY(-2px); }
        .btn-refresh { background: #3b82f6; color: white; }
        .btn-refresh:hover { background: #2563eb; transform: translateY(-2px); }
        .upload-card { border: 1px dashed #cbd5e1; padding: 15px; border-radius: 8px; background: #f8fafc; margin-bottom: 12px; }
        .upload-card label { font-size: 13px; font-weight: bold; color: #475569; display: block; margin-bottom: 8px; }
        input[type="file"] { width: 100%; padding: 8px; background: white; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 10px; font-size: 13px; box-sizing: border-box; }
        .btn-upload { background: #64748b; color: white; padding: 10px; font-size: 14px; margin-bottom: 0; }
        .btn-upload:hover { background: #475569; }
        #result { margin-top: 20px; padding: 15px; border-radius: 8px; font-weight: bold; display: none; white-space: pre-wrap; word-break: break-all; font-size: 14px; }
        .loading-dots:after { content: '...'; animation: dots 1.5s steps(5, end) infinite; }
        @keyframes dots { 0%, 20% { color: rgba(0,0,0,0); text-shadow: .25em 0 0 rgba(0,0,0,0), .5em 0 0 rgba(0,0,0,0); } 40% { color: #555; text-shadow: .25em 0 0 rgba(0,0,0,0), .5em 0 0 rgba(0,0,0,0); } 60% { text-shadow: .25em 0 0 #555, .5em 0 0 rgba(0,0,0,0); } 80%, 100% { text-shadow: .25em 0 0 #555, .5em 0 0 #555; } }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="user-info">
            <span class="user-name">👤 ${username}</span>
          </div>
          <a href="/" class="btn-back">⬅ 목록으로</a>
        </div>
        
        <div id="status" class="status-box">현재 세션 상태: <span class="loading-dots">확인 중</span></div>
        
        <button class="btn-checkin" onclick="runAction('/api/checkin')">✅ 출석체크 실행</button>
        <button class="btn-records" onclick="viewRecords()" style="background: #8b5cf6; color: white;">출근기록확인</button>
        
        ${isServer ? '' : '<button class="btn-refresh" onclick="runAction(\'/api/login\')">🌐 (로컬 전용) 브라우저 띄워 로그인</button>'}
        
        <div class="upload-card" style="display:none;">
          <label>📁 외부에서 만든 세션(.json) 덮어쓰기</label>
          <form action="/api/upload" method="post" enctype="multipart/form-data" style="margin:0;">
            <input type="hidden" name="username" value="${username}">
            <input type="file" name="sessionFile" accept=".json" required>
            <button type="submit" class="btn-upload">파일 업로드 적용</button>
          </form>
        </div>
        
        <div style="display:none; font-size: 12px; color: #888; text-align: center; margin-top: 15px;">
          서버(Render)에서는 브라우저 띄우기가 불가능하므로,<br>로컬에서 갱신한 파일을 <b>[수동 업로드]</b> 해주셔야 합니다.
        </div>
        
        <div id="result"></div>
        <div id="records-container" style="display:none; margin-top:20px; border-top:1px solid #eee; padding-top:15px;">
           <h3 style="margin-top:0; color:#333; font-size:16px;">📅 근태 기록 내역</h3>
           <div id="records-list" style="font-size:13px; text-align:left;"></div>
        </div>
      </div>
      <script>
        const currentUser = "${username}";
        window.onload = async () => {
          try {
            const res = await fetch('/api/status?name=' + encodeURIComponent(currentUser));
            const data = await res.json();
            const statusEl = document.getElementById('status');
            statusEl.innerHTML = '현재 세션 상태: ' + data.message;
            statusEl.style.color = data.isLoggedin ? '#166534' : '#991b1b';
            statusEl.style.background = data.isLoggedin ? '#f0fdf4' : '#fef2f2';
            statusEl.style.borderColor = data.isLoggedin ? '#bbf7d0' : '#fecaca';
            
            // 세션 체크 완료
          } catch(e) { document.getElementById('status').innerHTML = '세션 상태 확인 실패'; }
        };
        async function runAction(endpoint) {
          const resultDiv = document.getElementById('result');
          const recordsDiv = document.getElementById('records-container');
          recordsDiv.style.display = 'none';
          resultDiv.style.display = 'block';
          resultDiv.style.background = '#f8fafc';
          resultDiv.style.color = '#333';
          resultDiv.innerHTML = '진행 중... 잠시만 기다려주세요 ⏳';
          try {
            const res = await fetch(endpoint + '?name=' + encodeURIComponent(currentUser));
            const data = await res.json();
            resultDiv.innerHTML = data.message;
            resultDiv.style.background = data.success ? '#dcfce3' : '#fee2e2';
            resultDiv.style.color = data.success ? '#166534' : '#991b1b';
            if(endpoint === '/api/login' && data.success) {
               setTimeout(() => location.reload(), 1500);
            }
          } catch(e) { resultDiv.innerHTML = '서버 통신 오류가 발생했습니다.'; }
        }

        async function viewRecords() {
          const resultDiv = document.getElementById('result');
          const recordsContainer = document.getElementById('records-container');
          const recordsList = document.getElementById('records-list');
          
          resultDiv.style.display = 'block';
          resultDiv.style.background = '#f8fafc';
          resultDiv.style.color = '#333';
          resultDiv.innerHTML = '데이터를 불러오는 중... ⏳';
          recordsContainer.style.display = 'none';

          try {
            const res = await fetch('/api/records?name=' + encodeURIComponent(currentUser));
            const data = await res.json();
            
            if (!data.success) {
               resultDiv.innerHTML = data.message;
               resultDiv.style.background = '#fee2e2';
               resultDiv.style.color = '#991b1b';
               return;
            }

            resultDiv.style.display = 'none';
            recordsContainer.style.display = 'block';
            
            if (!data.data || data.data.length === 0) {
               recordsList.innerHTML = '<p style="text-align:center; color:#888;">이번달 기록이 없습니다.</p>';
               return;
            }

            let html = '<div style="display:flex; flex-direction:column; gap:8px;">';
            data.data.forEach(record => {
               const workDate = record.workDate || '날짜 알수없음';
               
               // 시간 포맷팅 헬퍼 (밀리초 타임스탬프)
               const formatTime = (ts) => {
                 if (!ts) return '—';
                 const d = new Date(ts);
                 const h = String(d.getHours()).padStart(2, '0');
                 const m = String(d.getMinutes()).padStart(2, '0');
                 return \`\${h}:\${m}\`;
               };
               
               const checkIn = formatTime(record.checkInTime);
               const checkOut = formatTime(record.checkOutTime);
               
               // 근무 시간 계산
               let duration = '—';
               if (record.checkInTime && record.checkOutTime) {
                 const diffMins = Math.floor((record.checkOutTime - record.checkInTime) / 60000);
                 const h = Math.floor(diffMins / 60);
                 const m = diffMins % 60;
                 duration = \`\${h}h \${m}m\`;
               }

               // 상태 번역 및 뱃지 색상
               let statusText = record.status;
               let statusBg = '#f1f5f9';
               let statusColor = '#475569';
               
               if (record.status === 'present') {
                 statusText = '정상 출근';
                 statusBg = '#dcfce3';
                 statusColor = '#166534';
               } else if (record.status === 'late') {
                 statusText = '지각';
                 statusBg = '#fee2e2';
                 statusColor = '#991b1b';
               } else if (record.status === 'absent') {
                 statusText = '결근';
                 statusBg = '#fef08a';
                 statusColor = '#9a3412';
               }

               html += \`
                 <div style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">
                   <div style="flex: 1;">
                     <div style="font-weight: bold; color: #1e293b; margin-bottom: 6px; font-size: 14px;">📅 \${workDate}</div>
                     <div style="display: flex; gap: 16px; font-size: 12px; color: #64748b;">
                       <div style="display: flex; flex-direction: column;">
                         <span style="font-size: 10px; color: #94a3b8;">출근</span>
                         <span style="font-weight: 600; color: #334155;">\${checkIn}</span>
                       </div>
                       <div style="display: flex; flex-direction: column;">
                         <span style="font-size: 10px; color: #94a3b8;">퇴근</span>
                         <span style="font-weight: 600; color: #334155;">\${checkOut}</span>
                       </div>
                       <div style="display: flex; flex-direction: column;">
                         <span style="font-size: 10px; color: #94a3b8;">근무시간</span>
                         <span style="font-weight: 600; color: #0f172a;">\${duration}</span>
                       </div>
                     </div>
                   </div>
                   <div>
                     <span style="background: \${statusBg}; color: \${statusColor}; padding: 6px 10px; border-radius: 20px; font-size: 12px; font-weight: 700; white-space: nowrap;">\${statusText}</span>
                   </div>
                 </div>
               \`;
            });
            html += '</div>';
            recordsList.innerHTML = html;

          } catch(e) {
            resultDiv.innerHTML = '기록을 가져오는 중 서버 통신 오류가 발생했습니다.';
            resultDiv.style.background = '#fee2e2';
            resultDiv.style.color = '#991b1b';
          }
        }
      </script>
    </body>
    </html>
  `);
});

// 파일 업로드 처리
app.post('/api/upload', upload.single('sessionFile'), (req, res) => {
  const username = req.body.username;
  res.send(`
    <script>
      alert('✅ ${username}님의 세션 파일이 성공적으로 덮어씌워졌습니다.');
      location.href = '/?user=' + encodeURIComponent('${username}');
    </script>
  `);
});

app.get('/api/signup', (req, res) => {
  const name = req.query.name;
  if (!name) return res.json({ success: false, message: '이름을 입력하세요.' });
  const filePath = getAuthPath(name);
  if (fs.existsSync(filePath)) return res.json({ success: false, message: '이미 존재하는 이름입니다.' });
  fs.writeFileSync(filePath, ''); 
  res.json({ success: true, message: `${name}님 등록 완료! 목록에서 선택 후 접속해주세요.` });
});

app.get('/api/status', async (req, res) => {
  res.json(await checkSessionStatus(req.query.name));
});

app.get('/api/checkin', async (req, res) => {
  res.json(await runBot(req.query.name, false));
});

app.get('/api/records', async (req, res) => {
  res.json(await fetchRecords(req.query.name));
});

app.get('/api/login', async (req, res) => {
  res.json(await runBot(req.query.name, true));
});

app.listen(PORT, () => {
  console.log(`🚀 멀티 유저 출석체크 서버 실행: http://localhost:${PORT}`);
});
