#!/usr/bin/env node
// 工作区加载/保存性能测量（只读：需要把真实数据目录的副本指给后端，绝不直接指向真实目录）
//
// 用法：
//   1) 克隆数据目录：cp -Rc "$HOME/Library/Application Support/ai-workstation" /tmp/aibro-perf/data
//   2) 起后端（克隆数据）：
//        AI_WORKSTATION_DATA_DIR=/tmp/aibro-perf/data AI_WORKSTATION_ASSET_DIR=<repo>/app \
//        AI_WORKSTATION_PORT=48232 <repo>/"AI Bro.app"/Contents/Resources/python/bin/python3 -B <repo>/app/server.py
//   3) node scripts/measure-workspace-load.cjs <repo>/app 48232
//
// 输出：状态体积、加载耗时、迁移改写条数、保存耗时、二次加载耗时。
// 判据：迁移后状态体积应下降一个数量级；二次加载应明显快于首次。
const path = require('path');
const Core = require(path.join(process.argv[2] || path.join(__dirname, '..', 'app'), 'workstation-core.js'));
const PORT = process.argv[3] || '48232';
const BASE = `http://127.0.0.1:${PORT}`;
const mb = n => (n / 1024 / 1024).toFixed(2) + ' MB';

(async () => {
  const t0 = Date.now();
  const state = await (await fetch(BASE + '/__state', { cache: 'no-store' })).json();
  const firstLoad = Date.now() - t0;
  console.log(`① 首次加载: ${mb(JSON.stringify(state).length)} · ${firstLoad}ms · revision=${state._revision}`);

  const t1 = Date.now();
  const migrated = Core.migrateAttachmentSnapshots(state);
  console.log(`② 迁移: 改写 ${migrated} 条 · ${Date.now() - t1}ms`);

  const body = JSON.stringify(state);
  const t2 = Date.now();
  const post = await fetch(BASE + '/__state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  await post.json();
  console.log(`③ 保存回写: HTTP ${post.status} · ${mb(body.length)} · ${Date.now() - t2}ms`);

  await new Promise(r => setTimeout(r, 400));
  const t3 = Date.now();
  const again = await (await fetch(BASE + '/__state', { cache: 'no-store' })).json();
  console.log(`④ 二次加载: ${mb(JSON.stringify(again).length)} · ${Date.now() - t3}ms`);
  console.log(`   agentRuns 保留: ${(again.agentRuns || []).length} 条`);
})();
