// 初次設定的資料起點。
//
// 兩個選擇的理由：
//   示範資料（demo）讓第一次打開系統的人立刻看懂「這個系統長什麼樣」，
//   但要明確標成 DEMO，且畫面上要能一鍵清空，否則會被誤當成真資料。
//   空白資料則適合已經知道怎麼用、不想刪資料的人。

export const SCHEMA_VERSION = 1;

function todayISO() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

// 示範資料：個案編號一律 DEMO 開頭，成員名稱一律 DEMO-X，
// 讓人在匯出或篩選時一眼看出這些不是真資料。
export function buildDemoState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    refDate: todayISO(),
    members: [
      { id: 'DEMO-A', code: 'DEMO-A', name: 'DEMO-A（同學）', role: '示範成員' },
      { id: 'DEMO-B', code: 'DEMO-B', name: 'DEMO-B（同學）', role: '示範成員' },
      { id: 'DEMO-C', code: 'DEMO-C', name: 'DEMO-C（同學）', role: '示範成員' }
    ],
    optBone: [
      {
        id: 'DEMO-01',
        name: 'DEMO-001',
        owner: 'DEMO-A',
        group: '示範組',
        status: '收案中',
        baselineDate: todayISO(),
        fup1Date: '',
        fup1Done: false
      },
      {
        id: 'DEMO-02',
        name: 'DEMO-002',
        owner: 'DEMO-B',
        group: '示範組',
        status: '待收案',
        baselineDate: '',
        fup1Date: '',
        fup1Done: false
      }
    ],
    music40: [],
    customStudies: []
  };
}

export function buildEmptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    refDate: todayISO(),
    members: [],
    optBone: [],
    music40: [],
    customStudies: []
  };
}

export function buildInitialState({ withSampleData } = {}) {
  return withSampleData === false ? buildEmptyState() : buildDemoState();
}
