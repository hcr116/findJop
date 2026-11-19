/**
 * 初始化搜索配置（开发用）。
 * 用 Node 写库，避开 PowerShell 的中文编码坑。
 */
import { openDb, listSearches, deleteSearch, addSearch } from './db.mjs';

const db = openDb();

console.log('=== 现有配置（先清掉） ===');
for (const s of listSearches(db)) {
  console.log(`  删除 #${s.id}  keyword=${JSON.stringify(s.keyword)}`);
  deleteSearch(db, s.id);
}

const seeds = [
  {
    name: '战斗策划-上海',
    keyword: '战斗策划',
    city_code: '101020100',
    city_name: '上海',
    max_pages: 2,
    fetch_detail: 1,
    exclude_words: '外包,驻场,销售',
  },
  {
    name: '游戏策划-上海',
    keyword: '游戏策划',
    city_code: '101020100',
    city_name: '上海',
    max_pages: 2,
    fetch_detail: 1,
    exclude_words: '外包,驻场,销售',
  },
];

for (const s of seeds) {
  const id = addSearch(db, s);
  console.log(`✓ 添加 #${id}  ${s.name}  关键词=${s.keyword}`);
}

console.log('\n=== 结果 ===');
for (const s of listSearches(db)) {
  console.log(`  #${s.id} ${s.name} | keyword=${s.keyword} | city=${s.city_name}(${s.city_code}) | ${s.max_pages}页 | 抓JD=${s.fetch_detail} | 排除=${s.exclude_words}`);
}
