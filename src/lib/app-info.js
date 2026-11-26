// 應用程式名稱與版號的唯一來源。
//
// 版號只放在這裡，不在任何其他地方寫死。其他檔案要版號就 import 這個模組
// ——寫死的話研究室更新到新版後，設定頁仍顯示舊版號，
// 維護者就無法從畫面判斷對方真正在跑哪一版。
//
// package.json 的 version 必須與這裡一致，由 scripts/check-project.mjs 檢查
// （它會掃過所有程式檔，發現任何地方寫死 x.y.z 就讓檢查失敗）。

export const APP_NAME = 'lab-tracker-cloud';
export const APP_DISPLAY_NAME = '研究室追蹤系統';
export const APP_VERSION = '1.2.3';
export const SCHEMA_VERSION = 1;
