'use strict';

// 首次启动时写入一个内置示例情境（已通过可达性分析），方便直接体验。
const { newId } = require('./db');

const SAMPLE = {
  title: '示例：车间可燃气体泄漏初期处置',
  states: [
    { id: 'power', name: '厂区电源已切断', initial: false },
    { id: 'evac', name: '人员已全部撤离并清点', initial: false },
    { id: 'reported', name: '已向119/指挥中心报告', initial: false },
  ],
  startNodeId: 'n_start',
  nodes: [
    {
      id: 'n_start',
      title: '警报响起',
      narrative: '凌晨，车间可燃气体报警器连续报警，巡检员报告有刺激性异味，现场情况不明。',
      isEnd: false,
      options: [
        {
          id: 'o_cut_power',
          label: '立即切断厂区总电源，再安排侦查',
          conditions: [],
          changes: [{ stateId: 'power', value: true }],
          toNodeId: 'n_scene',
          score: 3,
          scoreNote: '第一时间消除点火源，是可燃气体泄漏初期处置的关键动作。',
        },
        {
          id: 'o_rush_in',
          label: '来不及断电，直接直奔泄漏点查看',
          conditions: [],
          changes: [],
          toNodeId: 'n_shock',
          score: -10,
          scoreNote: '未断电进入泄漏区，非防爆电器产生火花即可引发爆燃，属于严重违章。',
        },
      ],
    },
    {
      id: 'n_scene',
      title: '查明泄漏点',
      narrative: '电源已断，侦查组确认：泵区法兰松动导致介质泄漏，现场可燃气浓度持续升高。',
      isEnd: false,
      options: [
        {
          id: 'o_evac',
          label: '组织全员撤离至安全区并清点人数',
          conditions: [],
          changes: [{ stateId: 'evac', value: true }],
          toNodeId: 'n_command',
          score: 4,
          scoreNote: '先救人、先撤人，撤离并清点人数为后续处置建立安全前提。',
        },
        {
          id: 'o_tighten',
          label: '人员不撤离，带压尝试紧固法兰',
          conditions: [],
          changes: [],
          toNodeId: 'n_poison',
          score: -9,
          scoreNote: '带压紧固且不撤离，一旦介质大量泄漏将造成多人中毒，风险极高。',
        },
      ],
    },
    {
      id: 'n_command',
      title: '安全区建立指挥点',
      narrative: '人员已全部撤离并清点完毕。下一步需要决定信息上报与救援配合方式。',
      isEnd: false,
      options: [
        {
          id: 'o_report',
          label: '立即拨打119并向应急指挥中心报告介质与处置情况',
          conditions: [],
          changes: [{ stateId: 'reported', value: true }],
          toNodeId: 'n_rescue',
          score: 3,
          scoreNote: '及时上报介质名称与现场处置情况，为专业力量到场赢得初期窗口。',
        },
        {
          id: 'o_wait_silent',
          label: '先不报，等专业队伍来了再说',
          conditions: [],
          changes: [],
          toNodeId: 'n_delay',
          score: -8,
          scoreNote: '迟报瞒报会错过初期处置窗口，导致事态升级，责任后果严重。',
        },
      ],
    },
    {
      id: 'n_rescue',
      title: '消防队到场',
      narrative: '消防队与专业堵漏队伍到场，需要你在安全区配合处置。',
      isEnd: false,
      options: [
        {
          id: 'o_meet',
          label: '在安全区接应，说明介质名称、电源切断与人员清点情况',
          conditions: [],
          changes: [],
          toNodeId: 'n_success',
          score: 0,
          scoreNote: '信息交接完整，配合专业队伍安全完成堵漏。',
        },
        {
          id: 'o_return',
          label: '冒险返回装置区取回重要台账',
          conditions: [],
          changes: [],
          toNodeId: 'n_return',
          score: -7,
          scoreNote: '任何物品都不值得以生命为代价返回险区，还会迫使救援人员二次进入。',
        },
      ],
    },
    { id: 'n_shock', title: '结局：爆燃伤亡', narrative: '未切断电源，非防爆电器动作产生火花，现场发生爆燃，处置人员重伤。处置失败。', isEnd: true, options: [] },
    { id: 'n_poison', title: '结局：中毒', narrative: '人员未撤离，紧固过程中介质大量泄漏，多人中毒倒地。处置失败。', isEnd: true, options: [] },
    { id: 'n_delay', title: '结局：贻误战机', narrative: '未及时报告，专业力量到场时已错过初期处置窗口，事态升级。处置失败。', isEnd: true, options: [] },
    { id: 'n_return', title: '结局：返回遇险', narrative: '返回装置区时吸入过量介质倒地，迫使救援人员再次进入险区。处置失败。', isEnd: true, options: [] },
    { id: 'n_success', title: '结局：处置成功', narrative: '断电、撤离、报告及时，专业队伍安全完成堵漏，无人员伤亡，事故得到控制。处置成功。', isEnd: true, options: [] },
  ],
};

function seed(db) {
  const row = db.prepare('SELECT COUNT(*) AS c FROM scenarios').get();
  if (row.c > 0) return;
  const id = newId('sc');
  const content = JSON.stringify(SAMPLE);
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO scenarios (id, title, draft, current_version) VALUES (?, ?, ?, 1)`).run(id, SAMPLE.title, content);
    db.prepare(`INSERT INTO versions (scenario_id, version, content) VALUES (?, 1, ?)`).run(id, content);
  });
  tx();
}

module.exports = { seed, SAMPLE };
