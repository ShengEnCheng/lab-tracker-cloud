// 共用資料的格式檢查。
//
// 這個函式收到的是「使用者送來的任意 JSON」——可能來自網頁表單、
// 匯入檔案、或直接打 API 的程式。所以每一個欄位都要先確認型別再用，
// 不能假設它一定是陣列或物件。
//
// 為什麼這件事很重要：這裡若丟出例外，api/data.js 與 api/import.js 的
// catch 會回 503「服務暫時無法使用」——使用者看到的訊息是「伺服器壞了」，
// 而實際上只是「他的資料格式不對」，他會去重試、去問維護者，卻永遠不會
// 想到是自己送出的內容有問題。所以型別錯誤一律變成「回傳的錯誤清單」，
// 讓上層回 422 並逐項說明。

const DATE_FIELDS = /Date$/;

function checkRows(rows, label, errors) {
  // 先確認是陣列。不是陣列的情況上面已經記錄過了，這裡直接跳過。
  if (!Array.isArray(rows)) return;

  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`${label} 第 ${index + 1} 筆格式錯誤`);
      return;
    }
    if (!String(row.id || '').trim()) {
      errors.push(`${label} 第 ${index + 1} 筆缺少個案編號`);
    }
    for (const [key, value] of Object.entries(row)) {
      if (DATE_FIELDS.test(key) && value && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
        errors.push(`${label} 第 ${index + 1} 筆 ${key} 日期格式錯誤`);
      }
    }
  });
}

function checkStudies(studies, errors) {
  if (!Array.isArray(studies)) return;

  studies.forEach((study, index) => {
    if (!study || typeof study !== 'object' || Array.isArray(study)) {
      errors.push(`自訂研究案第 ${index + 1} 筆格式錯誤`);
      return;
    }
    if (!String(study.code || '').trim()) {
      errors.push(`自訂研究案第 ${index + 1} 筆缺少研究案代碼`);
    }
    if (!Array.isArray(study.milestones)) {
      errors.push(`自訂研究案第 ${index + 1} 筆 milestones 格式錯誤`);
    }
    if (!Array.isArray(study.subjects)) {
      errors.push(`自訂研究案第 ${index + 1} 筆 subjects 格式錯誤`);
    }
  });
}

/**
 * 檢查共用資料的結構。
 *
 * @param {*} data 使用者送來的資料（型別未知，什麼都可能）
 * @returns {string[]} 錯誤清單；空陣列代表通過
 */
export function validateLabData(data) {
  const errors = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    errors.push('資料必須是 JSON 物件');
    // 連物件都不是，後面的檢查都沒有意義，但也不能就此丟例外。
    return errors;
  }

  if (!Array.isArray(data.optBone)) errors.push('缺少 optBone 陣列');
  if (!Array.isArray(data.music40)) errors.push('缺少 music40 陣列');
  if (data.members !== undefined && !Array.isArray(data.members)) errors.push('members 必須是陣列');
  if (data.customStudies !== undefined && !Array.isArray(data.customStudies)) {
    errors.push('customStudies 必須是陣列');
  }

  checkRows(data.optBone, 'OPT_Bone', errors);
  checkRows(data.music40, 'music40', errors);
  checkStudies(data.customStudies, errors);

  return errors;
}
