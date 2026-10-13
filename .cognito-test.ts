/* Cognito 登入一次性驗證：npx tsx .cognito-test.ts <帳號> <密碼> */
import { cognitoLogin } from './readmo';

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.log('用法：npx tsx .cognito-test.ts <Readmoo帳號Email> <密碼>');
  process.exit(1);
}

cognitoLogin(email, password, (m) => console.log(m))
  .then((token) => {
    console.log('✓ 登入成功，AccessToken 前 20 字：', token.slice(0, 20) + '…');
    console.log('✓ 全長：', token.length, '字元');
    console.log('\n若看到這行，代表帳密→Bearer token 已打通，可以接自動上傳。');
  })
  .catch((e) => {
    console.error('✗ 登入失敗：', String(e?.message || e));
    console.error('可能原因：帳密錯誤／帳號格式不對（有些帳號是 Readmoo ID 而非 Email）／該帳號有啟用雙重驗證');
    process.exit(1);
  });
