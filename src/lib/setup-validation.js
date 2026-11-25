// 研究室設定與首次安裝的輸入驗證。
//
// 這些規則刻意寫成純函式，讓伺服器端（api/setup.js）與測試共用同一套判斷，
// 不會出現「前端說可以、後端說不行」的不一致。

export const MIN_PASSWORD_LENGTH = 8;

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function isValidEmail(value) {
  const email = normalizeEmail(value);
  // 刻意不用完整的 RFC 5322：實務上只要「有一個 @、兩邊都有東西、網域有小數點」就夠，
  // 太嚴的規則反而會擋掉合法但少見的位址。
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

export function normalizeOrganizationCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 16);
}

export function normalizeOrganizationName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

// 回傳 { ok, errors: {field: message}, value }
export function validateSetupInput(body) {
  const errors = {};

  const organizationName = normalizeOrganizationName(body?.organizationName);
  if (!organizationName) errors.organizationName = '請填寫研究室名稱。';

  const organizationCode = normalizeOrganizationCode(body?.organizationCode);
  if (organizationCode && !/^[A-Z0-9][A-Z0-9-]*$/.test(organizationCode)) {
    errors.organizationCode = '研究室代碼只能用英文字母、數字與減號。';
  }

  const adminEmail = normalizeEmail(body?.adminEmail);
  if (!adminEmail) errors.adminEmail = '請填寫管理者的登入 Email。';
  else if (!isValidEmail(adminEmail)) errors.adminEmail = 'Email 格式看起來不對，請再確認一次。';

  const adminName = String(body?.adminName || '').trim().slice(0, 60);
  if (!adminName) errors.adminName = '請填寫管理者的姓名。';

  const password = String(body?.adminPassword || '');
  if (!password) errors.adminPassword = '請設定密碼。';
  else if (password.length < MIN_PASSWORD_LENGTH) {
    errors.adminPassword = `密碼至少需要 ${MIN_PASSWORD_LENGTH} 個字元。`;
  } else if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    errors.adminPassword = '密碼要同時包含英文字母與數字，這樣比較不容易被猜到。';
  }

  const contactEmail = normalizeEmail(body?.contactEmail);
  if (contactEmail && !isValidEmail(contactEmail)) errors.contactEmail = '聯絡信箱格式看起來不對。';

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: {
      organizationName,
      organizationCode,
      contactEmail,
      adminEmail,
      adminName,
      adminPassword: password,
      withSampleData: body?.withSampleData !== false
    }
  };
}
