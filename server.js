const express = require('express');
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;
const SESSIONS_DIR = path.join(__dirname, 'sessions');

// 세션 디렉토리 없으면 생성
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR);
}

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
    browser = await chromium.launch({ 
      headless: !forceLogin,
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled']
    });
    
    let contextOptions = {
      ...iPhone,
      geolocation: FIXED_LOCATION,
      permissions: ['geolocation'],
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul'
    };
    
    if (fs.existsSync(authFile)) {
      contextOptions.storageState = authFile;
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
        return { success: false, message: `⚠️ 세션이 만료되었습니다. 로그인을 다시 해주세요.` };
      }
      
      try {
        const loginBtn = page.locator('button:has-text("로그인")');
        if (await loginBtn.count() > 0) await loginBtn.first().click();
      } catch (e) {}

      for (let i = 0; i < 100; i++) {
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
        ? { success: true, message: `✅ 로그인이 완료되었습니다!` }
        : { success: false, message: '⚠️ 로그인 실패' };
    }

    if (!token) return { success: false, message: '❌ 토큰 획득 실패' };

    const scanUrl = `https://qrattend-ffrof5pm.manus.space/scan?token=${token}`;
    let apiResultMessage = "🎉 출석체크 요청 완료";
    let apiSuccess = true;

    const responsePromise = page.waitForResponse(r => r.url().includes('/api/trpc/attendance.scan'), { timeout: 8000 })
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
    return { success: false, message: `❌ 오류: ${error.message}` };
  } finally {
    if (browser) await browser.close();
    isRunning = false;
  }
}

async function checkSessionStatus(username) {
  const authFile = getAuthPath(username);
  if (!fs.existsSync(authFile)) return { isLoggedin: false, message: '저장된 세션 없음' };
  
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: authFile });
    const page = await context.newPage();
    const response = await page.request.get('https://qrattend-ffrof5pm.manus.space/api/trpc/qr.getCurrent?batch=1&input=%7B%7D');
    const data = await response.json();
    const isLoggedin = !!(data[0]?.result?.data?.json?.token || data[0]?.result?.data?.token);
    
    return { 
      isLoggedin, 
      message: isLoggedin ? '✅ 세션 유효함 (출첵 가능)' : '⚠️ 세션 만료됨 (로그인 필요)' 
    };
  } catch (e) {
    return { isLoggedin: false, message: '❌ 상태 확인 오류' };
  } finally {
    if (browser) await browser.close();
  }
}

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
        <title>QR 출석체크 - 사용자 선택</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: 'Malgun Gothic', sans-serif; padding: 20px; background: #f0f2f5; text-align: center; }
          .container { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); display: inline-block; width: 100%; max-width: 450px; }
          h1 { color: #0081f2; margin-bottom: 30px; }
          .card { border: 1px solid #e2e8f0; padding: 20px; border-radius: 10px; margin-bottom: 20px; background: #fafafa; }
          input { padding: 12px; border: 1px solid #ddd; border-radius: 6px; width: 65%; margin-right: 5px; }
          button { border: none; padding: 12px 20px; border-radius: 6px; font-weight: bold; cursor: pointer; transition: 0.2s; }
          .btn-blue { background: #3b82f6; color: white; }
          .user-list { text-align: left; }
          .user-item { 
            padding: 15px; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 10px; 
            display: flex; justify-content: space-between; align-items: center; background: white;
            cursor: pointer; transition: 0.2s;
          }
          .user-item:hover { border-color: #3b82f6; background: #f0f9ff; }
          .user-name { font-size: 18px; font-weight: bold; color: #333; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>👤 사용자 선택</h1>
          <div class="card">
            <h3 style="margin-top:0; font-size:15px; color:#666;">새로운 사용자 등록</h3>
            <input type="text" id="newUsername" placeholder="이름 입력">
            <button class="btn-blue" onclick="signup()">등록</button>
          </div>
          <div class="user-list">
            ${users.length === 0 ? '<p style="text-align:center; color:#999;">등록된 사용자가 없습니다.</p>' : users.map(u => `
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
      <title>${username}님의 출석체크</title>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: 'Malgun Gothic', sans-serif; padding: 20px; background: #f0f2f5; text-align: center; }
        .container { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); display: inline-block; width: 100%; max-width: 500px; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid #eee; padding-bottom: 15px; }
        .user-info { text-align: left; }
        .user-name { font-size: 20px; font-weight: bold; color: #0081f2; }
        .btn-back { font-size: 12px; color: #666; text-decoration: none; border: 1px solid #ddd; padding: 5px 10px; border-radius: 4px; background: white; }
        .status-box { margin-bottom: 25px; padding: 15px; border-radius: 8px; font-size: 14px; background: #f8fafc; border: 1px solid #e2e8f0; }
        button { border: none; padding: 16px; border-radius: 10px; font-size: 16px; font-weight: bold; cursor: pointer; transition: 0.2s; width: 100%; margin-bottom: 12px; }
        .btn-checkin { background: #22c55e; color: white; }
        .btn-checkin:hover { background: #16a34a; transform: translateY(-2px); }
        .btn-login { background: #3b82f6; color: white; }
        .btn-login:hover { background: #2563eb; transform: translateY(-2px); }
        #result { margin-top: 20px; padding: 15px; border-radius: 8px; font-weight: bold; display: none; }
        .loading-dots:after { content: '...'; animation: dots 1.5s steps(5, end) infinite; }
        @keyframes dots { 0%, 20% { color: rgba(0,0,0,0); text-shadow: .25em 0 0 rgba(0,0,0,0), .5em 0 0 rgba(0,0,0,0); } 40% { color: #555; text-shadow: .25em 0 0 rgba(0,0,0,0), .5em 0 0 rgba(0,0,0,0); } 60% { text-shadow: .25em 0 0 #555, .5em 0 0 rgba(0,0,0,0); } 80%, 100% { text-shadow: .25em 0 0 #555, .5em 0 0 #555; } }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="user-info">
            <span style="font-size:12px; color:#666">현재 접속 사용자</span><br>
            <span class="user-name">👤 ${username}</span>
          </div>
          <a href="/" class="btn-back">사용자 변경</a>
        </div>
        <div id="status" class="status-box">현재 세션 상태: <span class="loading-dots">확인 중</span></div>
        <button class="btn-checkin" onclick="runAction('/api/checkin')">✅ 자동 출석체크 실행</button>
        <button class="btn-login" onclick="runAction('/api/login')">🔑 브라우저 띄워 로그인 (세션 갱신)</button>
        <div id="result"></div>
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
          } catch(e) { document.getElementById('status').innerHTML = '세션 상태 확인 실패'; }
        };
        async function runAction(endpoint) {
          const resultDiv = document.getElementById('result');
          resultDiv.style.display = 'block';
          resultDiv.style.background = '#f8fafc';
          resultDiv.style.color = '#333';
          resultDiv.innerHTML = '진행 중... ⏳';
          try {
            const res = await fetch(endpoint + '?name=' + encodeURIComponent(currentUser));
            const data = await res.json();
            resultDiv.innerHTML = data.message;
            resultDiv.style.background = data.success ? '#dcfce3' : '#fee2e2';
            resultDiv.style.color = data.success ? '#166534' : '#991b1b';
            if(data.success && endpoint === '/api/login') location.reload();
          } catch(e) { resultDiv.innerHTML = '서버 통신 오류'; }
        }
      </script>
    </body>
    </html>
  `);
});

app.get('/api/signup', (req, res) => {
  const name = req.query.name;
  if (!name) return res.json({ success: false, message: '이름을 입력하세요.' });
  const filePath = getAuthPath(name);
  if (fs.existsSync(filePath)) return res.json({ success: false, message: '이미 존재하는 이름입니다.' });
  fs.writeFileSync(filePath, JSON.stringify({ cookies: [], origins: [] }));
  res.json({ success: true, message: `${name}님 등록 완료! 목록에서 선택 후 로그인해주세요.` });
});

app.get('/api/status', async (req, res) => {
  res.json(await checkSessionStatus(req.query.name));
});

app.get('/api/checkin', async (req, res) => {
  res.json(await runBot(req.query.name, false));
});

app.get('/api/login', async (req, res) => {
  res.json(await runBot(req.query.name, true));
});

app.listen(PORT, () => {
  console.log(`🚀 멀티 유저 출석체크 서버 실행: http://localhost:${PORT}`);
});
