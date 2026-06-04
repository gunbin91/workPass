const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const AUTH_FILE = path.join(__dirname, 'auth.json');

(async () => {
  console.log('🚀 브라우저 자동화 출석체크 봇 시작...');
  
  let browser;
  try {
    // 봇 구동 시 브라우저를 숨기고 싶다면 headless: true 로 변경하세요.
    browser = await chromium.launch({ headless: false });
    
    let contextOptions = {};
    
    // 이전에 저장된 로그인 세션(auth.json)이 있다면 불러옵니다.
    if (fs.existsSync(AUTH_FILE)) {
      console.log('💾 저장된 로그인 세션(auth.json)을 불러옵니다.');
      contextOptions.storageState = AUTH_FILE;
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    // 1. 사이트 접속
    await page.goto('https://qrattend-ffrof5pm.manus.space/');
    
    console.log('📌 로그인 상태 및 API 토큰을 확인합니다...');
    
    let token = null;
    let isLoggedin = false;

    // 2. 내부 API로 토큰 추출 시도
    const checkToken = async () => {
      try {
        const response = await page.request.get('https://qrattend-ffrof5pm.manus.space/api/trpc/qr.getCurrent?batch=1&input=%7B%7D');
        const data = await response.json();
        const extractedToken = data[0]?.result?.data?.json?.token || data[0]?.result?.data?.token;
        
        // 에러 메시지가 있는지 확인
        const isUnauthorized = data[0]?.error?.json?.code === -32001; 
        
        if (extractedToken) {
          token = extractedToken;
          isLoggedin = true;
          return true;
        } else if (isUnauthorized) {
          return false;
        }
      } catch (e) {
        return false;
      }
      return false;
    };

    // 토큰 발급 확인 루프
    isLoggedin = await checkToken();

    if (!isLoggedin) {
      console.log('⚠️ 로그인이 필요합니다. 열려있는 브라우저 창에서 로그인을 진행해주세요.');
      console.log('로그인이 완료될 때까지 대기합니다... (최대 5분)');
      
      // 사용자가 직접 브라우저에서 로그인할 때까지 3초마다 체크
      for (let i = 0; i < 100; i++) {
        await page.waitForTimeout(3000);
        isLoggedin = await checkToken();
        if (isLoggedin) {
          console.log('✅ 로그인 성공 감지!');
          // 로그인 성공 후 세션을 파일로 저장하여 다음 실행 시 재사용
          await context.storageState({ path: AUTH_FILE });
          console.log('💾 로그인 세션을 auth.json에 저장했습니다.');
          break;
        }
      }
    }

    if (!token) {
      console.error('❌ 토큰 획득에 실패했습니다. 프로그램을 종료합니다.');
      return;
    }

    console.log(`✅ 최신 출석체크 토큰 획득: ${token}`);

    // 3. 스캔 URL로 직접 이동하여 프론트엔드의 출석체크 로직 트리거
    const scanUrl = `https://qrattend-ffrof5pm.manus.space/scan?token=${token}`;
    console.log(`🌐 출석체크 URL 접속 중: ${scanUrl}`);
    await page.goto(scanUrl);

    // 4. 프론트엔드에서 서버로 요청이 성공할 때까지 대기 (넉넉하게 5초)
    await page.waitForTimeout(5000); 
    console.log('🎉 정상적으로 출석체크가 완료되었습니다!');

  } catch (error) {
    console.error('❌ 오류 발생:', error);
  } finally {
    // 로직 완료 후 브라우저 종료
    if (browser) {
      await browser.close();
    }
  }
})();
