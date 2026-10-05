'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

let db;

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema();
  return db;
}

function initSchema() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS scenarios (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    draft           TEXT,                 -- JSON：当前草稿；NULL 表示尚未保存草稿
    current_version INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS versions (
    scenario_id     TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    version         INTEGER NOT NULL,
    content         TEXT NOT NULL,       -- 冻结的完整 JSON
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (scenario_id, version)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    code            TEXT PRIMARY KEY,
    scenario_id     TEXT NOT NULL,
    version         INTEGER NOT NULL,     -- 创建会话时冻结的版本
    current_node_id TEXT NOT NULL,
    state_mask      INTEGER NOT NULL,
    step_no         INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'active',  -- active / ended
    path            TEXT NOT NULL DEFAULT '[]',       -- [{step, fromNodeId, optionId, toNodeId, stateMask}]
    trainee_name    TEXT,
    parent_code     TEXT REFERENCES sessions(code) ON DELETE RESTRICT, -- 复盘分叉的源会话；NULL 为原始会话
    fork_step_no    INTEGER,              -- 分叉时的分歧步号（NULL 表示非分支）
    root_code       TEXT,                 -- 家族根会话码（原始会话即自身 code，分支沿用源的 root）
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (scenario_id, version) REFERENCES versions(scenario_id, version) ON DELETE RESTRICT
  );

  CREATE INDEX IF NOT EXISTS idx_versions_scenario ON versions(scenario_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_scenario ON sessions(scenario_id);
  -- 注：idx_sessions_root 在下方迁移补列之后再创建（老库此时尚无 root_code 列）

  -- 共识演练房间：一个房间绑定一条共享会话（同一条会话路径），
  -- 房间本身只记录冻结版本绑定与凭证，当前步号/状态一律以绑定会话为准。
  -- step_duration 非空时为限时房间：每步统一倒计时（秒，30..3600），
  -- NULL 表示旧用法（不限时，仅主持人手动结算）。
  -- blind_vote=1 时为盲投房间：当前步结算前对所有人（含主持人）隐藏各选项票数
  -- 与逐人选项，只公开已投人数；学员凭成员凭证仍可查看/修改自己的票。
  -- 创建后不可更改；0 / NULL 为公开投票（旧用法），存量房间一律公开。
  CREATE TABLE IF NOT EXISTS rooms (
    code            TEXT PRIMARY KEY,        -- 房间码，即学员加入码
    host_token      TEXT NOT NULL UNIQUE,    -- 主持凭证（结算时出示）
    scenario_id     TEXT NOT NULL,
    version         INTEGER NOT NULL,        -- 开启时选定的已发布冻结版本；后续发布不影响本场
    session_code    TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
    step_duration   INTEGER,                 -- 限时模式每步时长（秒）；NULL=不限时（旧用法）
    blind_vote      INTEGER NOT NULL DEFAULT 0, -- 1=盲投（结算前仅公开已投人数）；0=公开投票（旧用法）
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 限时房间每步一条计时记录（每步开始时持久写入截止时间）；
  -- 不限时房间不写此表。同一 (房间, 步号) 仅一行：零票暂停后由主持人在原步重开（刷新截止时间）。
  -- status: open（计时中/可投票）/ awaiting_reopen（到点零票，停在本步待主持人重开）
  CREATE TABLE IF NOT EXISTS room_steps (
    room_code       TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    step_no         INTEGER NOT NULL,        -- 对应的当前步号（重开不换步号）
    deadline_ms     INTEGER,                 -- 本步截止时间（epoch 毫秒）；重开后刷新
    opened_at_ms    INTEGER NOT NULL,        -- 本步（重新）开始计时的实际时刻（epoch 毫秒）
    status          TEXT NOT NULL DEFAULT 'open',
    reopened_count  INTEGER NOT NULL DEFAULT 0, -- 本步被主持人重开的次数
    PRIMARY KEY (room_code, step_no)
  );

  CREATE TABLE IF NOT EXISTS room_members (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code       TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    member_token    TEXT NOT NULL UNIQUE,    -- 成员凭证（投票时出示）
    name            TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 投票：主键 (房间, 步号, 成员) 保证“每人每步只计最后一票”（改票即 UPSERT）
  CREATE TABLE IF NOT EXISTS room_votes (
    room_code       TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    step_no         INTEGER NOT NULL,
    member_token    TEXT NOT NULL,
    option_id       TEXT NOT NULL,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (room_code, step_no, member_token)
  );

  -- 结算留痕：主键 (房间, 步号) 防并发重复结算；tallies 为该步各可选项票数快照。
  -- kind: manual（主持人结算）/ auto（到点后系统按既有投票自动多数决）。
  -- 零票暂停后的“重开”不推进、不写入此表（同一步号之后仍要结算），重开次数记在 room_steps。
  CREATE TABLE IF NOT EXISTS room_settlements (
    room_code       TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    step_no         INTEGER NOT NULL,        -- 被结算的步号（推进前的当前步）
    option_id       TEXT NOT NULL,           -- 获胜选项
    tallies         TEXT NOT NULL,           -- JSON: [{optionId, optionLabel, votes}]
    voter_count     INTEGER NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'manual',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (room_code, step_no)
  );

  CREATE INDEX IF NOT EXISTS idx_room_members_room ON room_members(room_code);
  CREATE INDEX IF NOT EXISTS idx_room_votes_room ON room_votes(room_code, step_no);
  CREATE INDEX IF NOT EXISTS idx_room_steps_open ON room_steps(room_code, status, deadline_ms);

  -- 训练任务：培训师选定已发布冻结版本 + 截止时间 + 每人最多尝试次数 + 及格分 + 学员名单。
  -- 建立后获得管理凭证（admin_token），每名学员获得独立参与凭证（task_trainees.token）。
  -- 任务绑定 (scenario_id, version) 冻结版本：后续发布新版本不改变本任务规则。
  CREATE TABLE IF NOT EXISTS tasks (
    id              TEXT PRIMARY KEY,        -- 任务编号（10 位）
    admin_token     TEXT NOT NULL UNIQUE,    -- 管理凭证（查看成绩时出示）
    scenario_id     TEXT NOT NULL,
    version         INTEGER NOT NULL,        -- 建立时选定的已发布冻结版本
    deadline_ms     INTEGER NOT NULL,        -- 截止时间（epoch 毫秒）：之后不能开新尝试，可续做旧会话
    max_attempts    INTEGER NOT NULL,        -- 每人最多尝试次数（正整数）
    pass_score      INTEGER NOT NULL,        -- 及格分（整数；按最高已结束总分判定）
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (scenario_id, version) REFERENCES versions(scenario_id, version) ON DELETE RESTRICT
  );

  -- 任务学员名单：姓名在任务内唯一；token 为各学员的独立参与凭证（全局唯一）
  CREATE TABLE IF NOT EXISTS task_trainees (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    token           TEXT NOT NULL UNIQUE,    -- 个人参与凭证（开始/续做/查看/选择时出示）
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (task_id, name)
  );

  CREATE INDEX IF NOT EXISTS idx_task_trainees_task ON task_trainees(task_id);
  `);

  // 老库迁移：补入复盘分叉所需的溯源列
  const cols = db.prepare('PRAGMA table_info(sessions)').all();
  const addColumn = (name, ddl) => {
    if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${ddl}`);
  };
  addColumn('parent_code', 'parent_code TEXT');
  addColumn('fork_step_no', 'fork_step_no INTEGER');
  addColumn('root_code', 'root_code TEXT');
  // 共识演练：房间绑定的共享会话打上 room_code 标记，单人选择入口据此拒绝绕过投票
  addColumn('room_code', 'room_code TEXT');
  // 限时模式：房间每步时长（秒）；NULL 为旧用法（不限时）。结算留痕补充结算方式。
  const roomCols = db.prepare('PRAGMA table_info(rooms)').all();
  if (!roomCols.some((c) => c.name === 'step_duration')) {
    db.exec('ALTER TABLE rooms ADD COLUMN step_duration INTEGER');
  }
  // 盲投模式：1=盲投（结算前只公开已投人数）；缺列的老库补列，存量房间默认 0=公开投票。
  if (!roomCols.some((c) => c.name === 'blind_vote')) {
    db.exec('ALTER TABLE rooms ADD COLUMN blind_vote INTEGER NOT NULL DEFAULT 0');
  }
  const settleCols = db.prepare('PRAGMA table_info(room_settlements)').all();
  if (!settleCols.some((c) => c.name === 'kind')) {
    db.exec(`ALTER TABLE room_settlements ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual'`);
  }
  // 训练任务：会话可属于某个任务的某次尝试（task_id 非空即为任务会话）。
  // 任务会话只能凭学员个人参与凭证查看/操作，且不计入普通会话列表。
  addColumn('task_id', 'task_id TEXT');
  addColumn('task_trainee_id', 'task_trainee_id INTEGER');
  addColumn('attempt_no', 'attempt_no INTEGER');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_room_steps_open ON room_steps(room_code, status, deadline_ms)`);
  // 存量会话（含建表后尚未回填 root_code 的库）：无溯源信息即为原始会话，根是自身
  db.exec(`UPDATE sessions SET root_code = code WHERE root_code IS NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_root ON sessions(root_code)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_room ON sessions(room_code)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id, task_trainee_id)`);
  // 硬约束：同一学员在同一任务下至多一条“进行中”的尝试会话。
  // 并发/重复开始在事务内会先查到这条进行中会话并直接返回它；极端交错下由本唯一索引兜底，
  // 绝不多建会话、不多扣次数。（普通会话 task_id 为 NULL，不受唯一约束影响。）
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_task_active
             ON sessions(task_id, task_trainee_id) WHERE status = 'active'`);
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function newSessionCode() {
  return crypto.randomBytes(5).toString('hex'); // 10 位
}

module.exports = { open, get db() { return db; }, newId, newSessionCode };
