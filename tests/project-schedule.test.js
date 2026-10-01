'use strict';
/* 项目排期：本地日历边界、日期分类、夏令时与计划文档转义。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const ProjectSchedule = require('../app/project-schedule.js');
const P = ProjectSchedule._pure;
const scheduleModule = require.resolve('../app/project-schedule.js');

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime();
const ids = tasks => tasks.map(task => task.id);

test('日期解析：纯日期按本地午夜解析，ISO 保留时刻，零时间戳有效', () => {
  assert.equal(P.timestamp('2026-09-27'), at(2026, 9, 27));
  assert.equal(P.timestamp('2026-09-28'), at(2026, 9, 28));
  assert.equal(P.timestamp('2024-02-29'), at(2024, 2, 29), '闰年日期有效');
  const iso = '2026-09-27T18:30:00+08:00';
  assert.equal(P.timestamp(iso), Date.parse(iso));
  assert.equal(P.timestamp(at(2026, 9, 23, 9)), at(2026, 9, 23, 9));
  assert.equal(P.timestamp(0), 0, 'Unix epoch 不等同于没有日期');
});

test('无效日期不能通过 Date 自动滚动成为另一天', () => {
  for (const value of ['2026-02-30', '2026-02-29', '2026-04-31', '2026-13-01', 'not-a-date', NaN, Infinity]) {
    assert.equal(P.timestamp(value), null, `应拒绝 ${String(value)}`);
  }
  for (const value of [undefined, null, '']) assert.equal(P.timestamp(value), null);
});

test('一天从本地午夜开始：数字、纯日期和 ISO 使用同一日历日', () => {
  const afternoon = at(2026, 9, 23, 15, 30);
  assert.equal(P.startOfDay(afternoon), at(2026, 9, 23));
  assert.equal(P.startOfDay(new Date(afternoon).toISOString()), at(2026, 9, 23));
  assert.equal(P.startOfDay('2026-09-23'), at(2026, 9, 23));
});

test('一周从周一开始：周日归到它所在那一周，下一周周一独立', () => {
  const wed = at(2026, 9, 23, 15, 30);
  assert.equal(P.startOfWeek(wed), at(2026, 9, 21));
  assert.equal(P.startOfWeek(at(2026, 9, 27, 23, 59)), at(2026, 9, 21));
  assert.equal(P.startOfWeek('2026-09-27'), at(2026, 9, 21), '纯日期周日属于本周期');
  assert.equal(P.startOfWeek('2026-09-28'), at(2026, 9, 28), '下一周周一归到自己');
  assert.equal(P.startOfWeek(at(2026, 9, 21, 8)), at(2026, 9, 21));
});

test('本地日历加天数：归一到午夜并正确跨月、跨年', () => {
  assert.equal(P.addLocalDays(at(2026, 9, 30, 15, 30), 1), at(2026, 10, 1));
  assert.equal(P.addLocalDays(at(2026, 1, 1), -1), at(2025, 12, 31));
  assert.equal(P.addLocalDays('2026-09-27', 1), at(2026, 9, 28));
});

test('一周七天：标签为周一到周日，日期连续且今天被标记', () => {
  const wed = at(2026, 9, 23, 15, 30);
  const days = P.daysOfWeek(wed, wed);
  assert.equal(days.length, 7);
  assert.deepEqual(days.map(day => day.label), ['周一', '周二', '周三', '周四', '周五', '周六', '周日']);
  assert.deepEqual(days.map(day => day.ts), Array.from({ length: 7 }, (_, i) => at(2026, 9, 21 + i)));
  assert.deepEqual(days.map(day => [day.month, day.day]), Array.from({ length: 7 }, (_, i) => [9, 21 + i]));
  assert.deepEqual(days.filter(day => day.isToday).map(day => day.label), ['周三']);
  assert.deepEqual(P.daysOfWeek(wed, at(2026, 9, 25)).filter(day => day.isToday).map(day => day.label), ['周五']);
  assert.equal(P.daysOfWeek(wed, at(2026, 9, 28)).filter(day => day.isToday).length, 0);
});

test('范围文案：同月与跨月两种写法', () => {
  assert.equal(P.formatRange(at(2026, 9, 23)), '9 月 21 日 – 27 日');
  assert.equal(P.formatRange(at(2026, 10, 1)), '9 月 28 日 – 10 月 4 日');
});

test('同日任务按解析后的时刻排序：兼容数字、ISO 与纯日期', () => {
  const days = P.daysOfWeek(at(2026, 9, 23));
  const tasks = [
    { id: 'late-iso', title: '周三晚', dueAt: new Date(at(2026, 9, 23, 18)).toISOString() },
    { id: 'early-number', title: '周三早', dueAt: at(2026, 9, 23, 9) },
    { id: 'date-only', title: '纯日期', dueAt: '2026-09-23' },
    { id: 'middle-iso', title: '周三中午', dueAt: new Date(at(2026, 9, 23, 12)).toISOString() },
    { id: 'friday', dueAt: '2026-09-25' }
  ];
  const { byDay, unscheduled, invalid } = P.bucketTasks(tasks, days);
  assert.deepEqual(ids(byDay[2]), ['date-only', 'early-number', 'middle-iso', 'late-iso']);
  assert.deepEqual(ids(byDay[4]), ['friday']);
  assert.deepEqual(byDay[0], []);
  assert.deepEqual(unscheduled, []);
  assert.deepEqual(invalid, []);
});

test('没有日期和非空无效日期分别保留，不能静默丢任务', () => {
  const days = P.daysOfWeek(at(2026, 9, 23));
  const tasks = [
    { id: 'missing', title: '无字段' },
    { id: 'null', title: '空值', dueAt: null },
    { id: 'empty', title: '空字符串', dueAt: '' },
    { id: 'bad-calendar', title: '不存在的日期', dueAt: '2026-02-30' },
    { id: 'bad-text', title: '无法解析', dueAt: 'not-a-date' },
    { id: 'scheduled', dueAt: '2026-09-23' },
    { id: 'other-week', dueAt: '2026-10-02' }
  ];
  const { byDay, unscheduled, invalid } = P.bucketTasks(tasks, days);
  assert.deepEqual(ids(unscheduled).sort(), ['empty', 'missing', 'null']);
  assert.deepEqual(ids(invalid).sort(), ['bad-calendar', 'bad-text']);
  assert.deepEqual(ids(byDay.flat()), ['scheduled']);
  const displayed = [...byDay.flat(), ...unscheduled, ...invalid];
  assert.equal(displayed.length, 6);
  assert.equal(new Set(ids(displayed)).size, 6, '每个任务只进入一个分类');
});

test('本周过滤只保留有效的本周日期，周日含入、下周一排除', () => {
  const days = P.daysOfWeek(at(2026, 9, 23));
  const tasks = [
    { id: 'monday', dueAt: '2026-09-21' },
    { id: 'in', dueAt: at(2026, 9, 24) },
    { id: 'sunday-date', dueAt: '2026-09-27' },
    { id: 'sunday-last', dueAt: new Date(at(2026, 9, 28) - 1).toISOString() },
    { id: 'before', dueAt: at(2026, 9, 21) - 1 },
    { id: 'following-monday', dueAt: '2026-09-28' },
    { id: 'following-midnight', dueAt: at(2026, 9, 28) },
    { id: 'none', dueAt: null },
    { id: 'empty', dueAt: '' },
    { id: 'invalid', dueAt: '2026-02-30' },
    null
  ];
  assert.deepEqual(ids(P.tasksInWeek(tasks, days)), ['monday', 'in', 'sunday-date', 'sunday-last']);
  assert.deepEqual(P.tasksInWeek([], days), []);
});

test('Unix epoch 0 有日期，进入对应当天并计入所在周', () => {
  const task = { id: 'epoch', dueAt: 0 };
  const days = P.daysOfWeek(0, 0);
  assert.deepEqual(ids(P.tasksInWeek([task], days)), ['epoch']);
  const { byDay, unscheduled, invalid } = P.bucketTasks([task], days);
  const index = days.findIndex(day => day.ts === P.startOfDay(0));
  assert.ok(index >= 0);
  assert.deepEqual(ids(byDay[index]), ['epoch']);
  assert.deepEqual(unscheduled, []);
  assert.deepEqual(invalid, []);
});

for (const transition of [
  { name: '春季', monday: '2026-03-02', sunday: '2026-03-08', nextMonday: '2026-03-09', dayDeltaHours: 23, range: '3 月 2 日 – 8 日' },
  { name: '秋季', monday: '2026-10-26', sunday: '2026-11-01', nextMonday: '2026-11-02', dayDeltaHours: 25, range: '10 月 26 日 – 11 月 1 日' }
]) {
  test(`America/New_York ${transition.name}夏令时：每天保持本地午夜，周末截止边界正确`, () => {
    // 隔离进程的 TZ，避免修改测试进程时区及影响并行测试。
    const script = `
      const assert = require('node:assert/strict');
      const P = require(${JSON.stringify(scheduleModule)})._pure;
      const transition = ${JSON.stringify(transition)};
      const monday = P.timestamp(transition.monday);
      const sunday = P.timestamp(transition.sunday);
      const nextMonday = P.timestamp(transition.nextMonday);
      const days = P.daysOfWeek(sunday, sunday);
      assert.equal(P.startOfWeek(sunday), monday);
      assert.equal(P.startOfWeek(nextMonday), nextMonday);
      assert.equal(days.length, 7);
      assert.deepEqual(days.map(day => new Date(day.ts).getDay()), [1, 2, 3, 4, 5, 6, 0]);
      for (let i = 0; i < 7; i += 1) {
        const expected = new Date(monday);
        expected.setDate(expected.getDate() + i);
        assert.equal(days[i].ts, expected.getTime());
        assert.equal(new Date(days[i].ts).getHours(), 0);
      }
      assert.equal(days[6].ts, sunday);
      assert.deepEqual(days.filter(day => day.isToday).map(day => day.label), ['周日']);
      assert.equal(P.formatRange(sunday), transition.range);
      assert.equal(P.addLocalDays(sunday, 1), nextMonday);
      assert.equal(P.addLocalDays(nextMonday, -7), monday);
      assert.equal((P.addLocalDays(sunday, 1) - sunday) / 3600000, transition.dayDeltaHours);
      const tasks = [
        { id: 'sunday-date', dueAt: transition.sunday },
        { id: 'sunday-last', dueAt: nextMonday - 1 },
        { id: 'next-monday', dueAt: transition.nextMonday }
      ];
      assert.deepEqual(P.tasksInWeek(tasks, days).map(task => task.id), ['sunday-date', 'sunday-last']);
      const buckets = P.bucketTasks(tasks, days);
      assert.deepEqual(buckets.byDay[6].map(task => task.id), ['sunday-date', 'sunday-last']);
      assert.equal(buckets.byDay.flat().length, 2);
      assert.deepEqual(buckets.unscheduled, []);
      assert.deepEqual(buckets.invalid, []);
    `;
    execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ: 'America/New_York' },
      encoding: 'utf8',
      timeout: 10000
    });
  });
}

test('状态色调与标签：四种状态对应正确，缺失和未知状态按待开始处理', () => {
  for (const [status, tone, label] of [
    ['todo', 'todo', '待开始'],
    ['in_progress', 'progress', '进行中'],
    ['done', 'done', '已完成'],
    ['blocked', 'blocked', '受阻']
  ]) {
    assert.equal(P.taskTone({ status }), tone);
    assert.equal(P.statusLabel({ status }), label);
  }
  for (const task of [{}, { status: 'unknown' }]) {
    assert.equal(P.taskTone(task), 'todo');
    assert.equal(P.statusLabel(task), '待开始');
  }
});

test('时间显示：纯日期不显示时间，数字与 ISO 时刻一致，无效值不显示 NaN', () => {
  assert.equal(P.dueLabel({ dueAt: '2026-09-25' }), '');
  assert.equal(P.dueLabel({ dueAt: at(2026, 9, 25) }), '');
  assert.equal(P.dueLabel({ dueAt: at(2026, 9, 25, 9, 5) }), '09:05');
  assert.equal(P.dueLabel({ dueAt: new Date(at(2026, 9, 25, 9, 5)).toISOString() }), '09:05');
  assert.equal(P.dueLabel({ dueAt: '2026-02-30' }), '');
  assert.equal(P.dueLabel({ dueAt: 'not-a-date' }), '');
  assert.equal(P.dueLabel({}), '');
});

test('计划文档：用户内容转义，details 默认折叠，空计划显示空态', () => {
  const html = P.planMarkup({ plan: '# 计划\n</textarea><script>alert("x" & \'y\')</script>' });
  assert.doesNotMatch(html, /<script/i, '不得把计划内容当 HTML');
  assert.match(html, /&lt;\/textarea&gt;&lt;script&gt;/);
  assert.match(html, /&quot;x&quot; &amp; &#39;y&#39;/);
  assert.match(html, /project-plan-panel/);
  assert.match(html, /项目计划/);
  const detailsTag = html.match(/<details\b[^>]*>/)?.[0];
  assert.ok(detailsTag, '保留可折叠计划容器');
  assert.doesNotMatch(detailsTag, /\sopen(?:\s|=|>)/i, '默认折叠');
  assert.match(P.planMarkup({}), /尚未填写/);
});
