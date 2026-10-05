# 事故处置情境编排与演练（本地 Web 应用）

供**培训师**编排事故处置情境、供**学员**按现场状态进行处置选择的本地 Web 应用。

- 技术栈：Node.js + Express + SQLite（`better-sqlite3`）+ 原生浏览器界面（无需前端构建）
- 培训师定义：至多 **8 个布尔现场状态**、**情境节点**、带**状态条件 / 状态变更**的**选项**，并指定**起点**与**结局**
- 学员视角：展示当前情境描述、**可选项**、当前**现场状态**与**走过的路径**
- 发布前自动从初态枚举所有可达的（节点 × 状态组合）：
  - 非结局节点**不能无路可走**；
  - **不能存在可无限循环而不抵达结局的路径**；
  - 不满足则给出**可复现路径**（含每一步的状态快照，以及具体的循环段）并**拒绝发布**。
- 每次发布**冻结完整内容**为新版本：进行中的会话继续沿原版本完成，新会话使用最新版
- 每步选择必须携带**当前步号**；步号过期/重复、条件不满足、选项不存在等情况一律返回**原因和现状**，且不推进会话
- **培训师复盘分叉**：可凭「源会话码 + 分歧步号 + 所见源当前步号」，从任意历史局面创建**可继续选择的分支**；分支沿用源会话绑定的冻结版本，保留分歧步之前的路径与该步现场状态，原会话与其它分支不变；已结束会话也可从其此前的非结局步分叉（结局步不得分叉），分支还可再次分叉
- **选项评分**：培训师可为每个处置选项填写 **-10 至 10 的整数分值**与**评分说明**（留空按 0 分）；规则随版本冻结。学员每次有效选择后立即看到**本步得分、说明与累计分**；过期/重复/条件不符的选择不计分；分叉继承分歧前得分；历史会话按其绑定版本计算，旧版本无评分字段时各步按 0 分处理
- **共识演练（房间投票）**：培训师选定**已发布的冻结版本**开启房间，取得**主持凭证**与**学员加入码**（后续发布新版本不改变本场规则）；学员凭加入码取得各自**成员凭证**，对当前步的可选处置**投票**，结算前可改票、**每人每步只计最后一票**；主持人携**所见步号**结算，**票数最多**的选项推进**同一条共享会话路径**，**同票按冻结版本的选项编排顺序**决定，**无人投票不得结算**；投票/结算/推进全部防并发重复，过期步号、无效凭证、条件不符或已结束一律返回**原因及当前步号**且不改变票数、路径与得分；房间会话**不能经单人选择入口绕过投票**；页面展示**本步票数、已结算路径与累计分**，未结算时学员看不到他人的选票
- **限时模式（可选）**：开房时可勾选限时并填写**每步时长（30～3600 秒，整数）**，省略该设置的旧用法**完全保持原样**。限时房间在**每步开始时持久记录截止时间**，页面显示**截止时间与每秒刷新的剩余时间**；**截止前**可改票或由主持人**提前结算**，**到点后**拒绝本步一切新票/改票——**有票**则沿用既有多数决、同票顺序、路径推进与计分规则**自动结算**（`kind=auto`），并**从实际推进时刻**为下一步计满时长；**零票**时不推进、停在本步并**标记待重开**，主持人可凭**主持凭证 + 所见步号**把本步**重开完整时长**。即使**无人访问或服务重启**，启动时与运行中定时扫描也会**补办到期结算/暂停**；自动结算、投票、手动结算与重开相遇时由事务与唯一约束保证**不会重复推进**，失败一律返回原因和当前步号，且不改票数、路径、得分
- **盲投模式（可选）**：开房时可用**布尔值** `blind` 选择盲投（`true`/`false`）；**未指定**该字段及**存量房间维持现有公开投票规则**，传**非布尔值**（`null`、字符串、数字等）返回 `400 BLIND_INVALID` 且**不建房**。盲投房间在**当前步结算前**，无论**围观者、学员还是主持人都只看到已投人数**，不显示各选项票数或逐人选项（快照中各选项 `votes=null`、主持视图 `votes=null`）；学员凭**成员凭证仍可查看、修改自己的票**（`myVote`），主持人仍可查看**成员名单**（`members`，不含各自选项）。主持人**提前结算**或到点**自动结算**后，公布该步**各选项票数与获胜处置**（`settlements` / 已结算路径），但**始终不公开姓名与选项的对应关系**（留痕与响应均不含姓名）。**零票到点暂停及重开期间继续保密**，**已结算步的结果保持可见**；截止、同票顺序、路径推进与计分规则沿用现状。**盲投选择创建后不可更改**。盲投可与限时模式叠加使用
- **处置覆盖报告**：培训师可针对任一**已发布冻结版本**查看覆盖情况——以该版本从初态可达的「**节点 × 进入时现场状态 × 可选选项**」组合为覆盖项，给出**总数 / 已覆盖 / 未覆盖**与逐项明细，可一键**只看未覆盖项**，方便找到学员还没练到的处置
- **训练任务**：培训师选定**已发布冻结版本、截止时间、每人最多尝试次数、及格分与学员名单**建立训练任务（非法配置**整次拒绝**），获得**管理凭证**及各学员的**独立参与凭证**；学员凭个人凭证**开始或续做**单人演练——**有未结束尝试时重复开始返回原会话**（不多建会话、不多扣次数），**结束后才消耗下一次**，**截止后不能开新尝试但可续做旧会话**；任务会话沿**冻结版本**的选项条件、步号与计分规则推进，**只能凭本人凭证查看和操作**（普通会话列表与入口一律拒绝任务会话）；培训师凭管理凭证查看**各人尝试记录、最高已结束总分与是否达到及格分**（无已结束尝试时成绩为空）
- 草稿中的**无效引用**（不存在的状态/目标节点）与**矛盾条件**（同一状态同时要求是和否）在保存时即被拒绝；**非整数或越界分值**同样在保存时拒绝

---

## 一、一键启动（Docker Compose，推荐）

前置要求：已安装 Docker 与 Docker Compose 插件。

```bash
cd <本项目目录>
docker compose up -d --build
```

启动后访问：

> **http://localhost:8080**

健康检查地址：<http://localhost:8080/api/health>

停止 / 查看日志：

```bash
docker compose down          # 停止
docker compose logs -f       # 跟踪日志
docker compose up -d --build # 重新构建并启动
```

首次启动会自动：

1. 在 `./data/app.db` 创建 SQLite 数据库与全部表结构；
2. 写入一个**已发布的内置示例情境**「车间可燃气体泄漏初期处置」，可直接用于体验学员演练流程。

数据持久化在宿主机 `./data` 目录，删除容器不会丢数据；备份该目录即可备份全部情境与会话。

### 修改访问端口

默认占用宿主机 **8080**。改用其它端口（例如 9000）有两种方式：

```bash
# 方式一：临时环境变量
APP_PORT=9000 docker compose up -d

# 方式二：在项目根目录新建 .env 文件，写入
# APP_PORT=9000
```

随后访问 <http://localhost:9000>。

---

## 二、本地 Node 直接启动（不使用 Docker）

要求 Node.js ≥ 20（`better-sqlite3` 会在 `npm install` 时本地编译，需要 python3 / make / g++ 工具链）。

```bash
npm install
npm start
```

访问 **http://localhost:8080**。

---

## 三、配置项

| 配置 / 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 监听端口 |
| `DB_PATH` | Docker 内 `/app/data/app.db`；本地运行时 `./data/app.db` | SQLite 数据库文件路径，所在目录会自动创建 |
| `APP_PORT`（仅 Compose） | `8080` | 宿主机映射端口，改它即可，无需改 Dockerfile |
| `TZ` | `Asia/Shanghai` | 容器时区（影响时间显示） |

数据库表：`scenarios`（情境及草稿）、`versions`（每次发布冻结的完整内容）、`sessions`（学员会话：步号、状态位掩码、已走路径、绑定版本，复盘分叉溯源列 `parent_code` / `fork_step_no` / `root_code`，房间会话标记列 `room_code`，训练任务列 `task_id` / `task_trainee_id` / `attempt_no`——非空即为任务的计次尝试会话）、`rooms`（共识演练房间：加入码、主持凭证、绑定冻结版本与共享会话，限时模式列 `step_duration`，NULL 为旧用法；盲投列 `blind_vote`，1=盲投、0=公开，存量房间默认 0）、`room_members`（房间成员及成员凭证）、`room_votes`（按「房间 × 步号 × 成员」记票，每人每步只计最后一票）、`room_steps`（限时房间每步一条计时记录：持久化截止时间 `deadline_ms`、状态 `open`/`awaiting_reopen`、重开次数）、`room_settlements`（每步结算留痕：获胜选项与各选项票数，`kind` 为 `manual`/`auto`；任何房间都不留存姓名↔选项对应）、`tasks`（训练任务：管理凭证 `admin_token`、绑定冻结版本、截止时间 `deadline_ms`、每人最多尝试次数 `max_attempts`、及格分 `pass_score`）、`task_trainees`（任务学员名单：姓名任务内唯一，个人参与凭证 `token` 全局唯一）。另有唯一部分索引 `idx_sessions_task_active`（`sessions(task_id, task_trainee_id) WHERE status='active'`）保证同一学员在同一任务下至多一条进行中的尝试会话。

---

## 四、使用说明

### 培训师（页面顶部“培训师编排”页）

1. **新建情境**：系统生成一个可直接编辑的最小模板。
2. 右侧维护**现场状态**（1–8 个布尔量，各自指定初始值）。
3. 中间维护**节点**：标题、情境描述；勾选“结局节点”标记结局；在顶部“起点”下拉中指定起点（至少一个结局）。
4. 非结局节点下添加**选项**：
   - **显示条件**：列出对状态的“要求为是/否”，全部满足时该选项才可选；
   - **状态变更**：选择后把若干状态“置为是/否”；
   - **跳转**：选择后进入的目标节点；
   - **评分**：填写 **-10 至 10 的整数分值**与**评分说明**。
     - 分值留空（或显式 0）视为 **0 分**；正确、关键的处置可给正分，违章/危险动作给负分；
     - 保存草稿时若分值不是整数或超出 -10..10（如 `3.5`、`11`、`"5"`）会返回 `OPTION_SCORE_INVALID` 并拒绝保存；评分说明为可选文本（≤ 500 字，超长返回 `OPTION_SCORE_NOTE_TOO_LONG`）；
     - 分值与说明随**发布版本冻结**：之后改分只影响新版本会话，进行中的会话仍按其绑定版本计分；
     - 学员在**选择前看不到分值与说明**（避免提前“照分作答”），仅在每次**有效选择后**展示本步得分、评分说明与当前累计分；过期/重复/条件不符的选择不推进、不计分。
5. 常用操作：
   - **保存草稿**：先做结构校验（无效引用、矛盾条件等直接拒绝，不写库），同时返回一份发布预检报告；
   - **发布前检查**：只检查不保存，查看死路/无限循环的可复现路径；
   - **发布新版本**：完整检查通过后，把当前草稿冻结为 `v+1`。已有进行中的会话不受影响，新会话走新版本。
6. 删除仍被选项条件/变更引用的状态时，界面会拦截并提示引用位置。
7. **处置覆盖报告**（“我的情境”卡片上的「📊 处置覆盖报告」，或编辑器顶部同名按钮）：
   - 先在右上角选择要查看的**冻结版本**（默认最新发布版）；
   - 顶部展示**覆盖项总数、已覆盖数、未覆盖数**，以及纳入统计的会话数/演练家族数；
   - 明细表逐行给出**进入时现场状态、所在节点、可选选项（处置动作）与覆盖家族数**（未覆盖项红色高亮，并列出贡献覆盖的家族根会话码）；
   - 勾选「**只看未覆盖项**」可快速聚焦学员还没练到的处置组合；
   - 统计严格以该冻结版本为准：版本不存在、冻结内容或任一会话路径损坏时页面明确报错，且不展示部分统计。

### 处置覆盖报告的统计口径

- **覆盖项**：对所选冻结版本，复用发布前的状态空间枚举，从「起点 + 初始状态」出发，取每个**可达的非结局局面**（节点 + 进入时现场状态）下**条件满足、确实可选的每个选项**，组成一个覆盖项；结局局面没有可选项，不计入。
- **只按已完成选择统计**：覆盖来自会话 `path` 中已提交成功的步骤；**进行中会话只计已完成步骤**，其当前停留、尚未提交的局面不计。
- **按演练家族去重**：同一 `root_code` 家族（原始会话与其全部多级分支）对同一覆盖项**至多贡献一次**。分支从源会话继承的路径前缀因此**不会被重复累计**；家族内任一会话（含多级分支的分支）练到过即算该家族覆盖，明细中的“覆盖家族数”是去重后的家族数，不是会话数。
- **版本隔离**：只统计 `scenario_id + version` 完全匹配本冻结版本的会话；更旧/更新版本的会话**不混入**，发布新版本不改变历史版本的报告。
- **全有或全无**：冻结版本 JSON 无法解析、结构损坏（无效引用等）、不再满足发布时的可达性不变量（死路/可无限循环），或任一会话的已存路径与该版本冻结规则严格重放不一致（步号、节点、选项、条件、状态掩码、结局状态对不上）时，返回 `VERSION_CONTENT_CORRUPT` / `SESSION_PATH_CORRUPT` 等明确错误，**不返回部分统计**。

### 学员（“学员演练”页）

1. 在“可演练情境”中选择已发布情境，可填写姓名后**开始新演练**（自动绑定最新发布版）；
2. 阅读当前情境，在右侧查看**现场状态**，从卡片中选择处置动作；
3. 条件不满足的选项会以 🔒 灰显并说明缺哪个条件；即使强行提交，服务端也会拒绝并返回原因与现状；
4. 右侧“已走路径”逐步记录：第几步、在哪个节点、选了什么、到达哪里、当时状态，以及**该步得分徽章与评分说明**；
5. 每次**有效选择**后页面顶部提示**本步得分、评分说明与当前累计分**，会话栏常驻显示累计分；到达结局后横幅给出总分；
6. 可凭 **10 位会话码** 或下方列表随时“继续”未完成的演练；到达结局后会话结束。
   - 过期步号、重复提交、条件不满足、选项不存在等无效选择一律**不推进、不计分**（返回原因与现状，成绩维持原值）；
   - 成绩完全按会话**绑定版本**的冻结规则与已完成路径计算：改分重发新版本不影响老会话；早于评分功能的旧版本没有分值字段时，各步一律按 0 分处理。

### 培训师复盘分叉（会话页右侧）

演练结束（或进行中）后，培训师可从某个**历史局面**另开一条分支，演练“当时如果换个选择会怎样”：

1. 凭 **10 位会话码** 打开源会话（已结局的会话也可以，从会话列表点「🌿 分叉」会直接定位到分叉面板）；
2. 在右侧「🌿 复盘分叉」卡片选择**分歧步号**（下拉列出第 0 步到当前步各自所在节点，**结局步禁选**），可填一个分支备注名；
3. 点「从此步创建分支」：系统生成一个**新会话码**，其
   - **冻结版本沿用源会话**（不跟随最新发布版，保证历史局面可精确复现）；
   - 保留**分歧步之前已完成的路径**与**该步现场状态**（第 0 步即该版本初态，路径为空）；
   - **继承截至分歧步已完成路径的得分**（响应中的 `inheritedScore`，即新会话的初始累计分），第 0 步分叉继承 0 分；
   - 当前步号 = 分歧步号，状态为「进行中」，可直接在该局面继续选择；
4. 后续选择**只推进分支、只计分支自己的得分**：源会话与其它分支的成绩和路径都不受影响，各自步号与版本绑定校验照旧（步号过期仍返回 `STEP_STALE`）；
5. **分支可以再次分叉**：打开任一分支，重复上述操作即可形成多级家族树；每次分叉都继承当时已完成路径的得分；
6. 「来源与分支对照」卡片以树状展示同一家族的**原始会话与全部分支**：每个节点标明来源会话、分歧步、当前节点/步数、状态、**会话总分**，并可展开各自的**完整后续路径**（每步带**逐步得分徽章与评分说明**）供横向对照；点击会话码即可跳转。

创建时以下情况会**说明原因、不创建分支**，且只要能定位到源会话就一并返回其**当前步号**（`sourceCurrent.stepNo`）：

| 情况 | HTTP / 错误码 |
| --- | --- |
| 所见源当前步号与服务端不一致（源会话已被推进/页面过期） | `409 STEP_STALE` |
| 分歧步号越界（`<0` 或 `> 源当前步号`） | `409 FORK_STEP_OUT_OF_RANGE` |
| 分歧点是结局步 | `409 FORK_AT_END_STEP` |
| 源会话不存在 | `404 SESSION_NOT_FOUND` |
| 源绑定的冻结版本内容缺失 | `500 VERSION_MISSING`（同样返回源当前步号） |
| 缺少/非法的 `forkStepNo`、`observedStepNo` | `400` |

### 共识演练（“共识演练”页，多人投票）

培训师开启一个**房间**，全班学员对**同一条会话路径**逐步投票、按多数决推进：

1. **开启房间（培训师）**：在“共识演练”页选择已发布情境与**冻结版本**（默认最新发布版），可勾选 **限时模式** 并填写**每步时长（30～3600 秒）**，还可勾选 **🔒 盲投模式**，点「开启房间」：
   - 系统返回 **10 位学员加入码**（即房间码）与 **主持凭证**（`host_…`，仅此处完整展示，请妥善保存）；
   - 房间**绑定所选冻结版本**：之后再发布新版本，本场规则、选项与分值一律不变；
   - 房间同时创建一条**共享会话**（会话列表中标注 🗳️ 房间），全班的结算结果都推进这一条路径；
   - **不勾选限时**即旧用法：无倒计时、仅主持人手动结算；勾选后每步统一倒计时（详见下文「限时模式」）；
   - **不勾选盲投**即公开投票旧用法：结算前页面实时展示各选项聚合票数（主持人可见逐人明细）；勾选 **🔒 盲投模式** 后进入保密规则（详见下文「盲投模式」），盲投可与限时叠加。
2. **学员加入**：凭加入码（可填姓名）加入，取得各自的**成员凭证**（`mem_…`，页面会自动保存在本机）；凭证即选票，勿外传。
3. **投票 / 改票**：学员对**当前步**的可选处置投票；条件不满足的选项 🔒 灰显且服务端同样拒绝；**结算前可改票，每人每步只计最后一票**。公开投票房间页面实时展示**本步各选项的聚合票数**与（限时房间）**截止时间、剩余时间**，但**未结算时学员看不到他人的选票**（主持人可见逐人明细）；**盲投房间**结算前**任何人（含主持人）都只看到已投人数**，学员凭自己的成员凭证仍能看到并修改**自己那一票**（详见下文「盲投模式」）。
4. **结算（主持人）**：主持人携**所见步号**结算：
   - **票数最多**的选项胜出并推进共享会话；**同票**按冻结版本中该节点**选项的编排顺序**取先者；
   - **无人投票不得结算**；所见步号过期（他人已结算）会拒绝并返回当前步号；
   - 限时房间在**截止前**点结算即**提前结算**；到点后系统会自动处理，主持人无需也不能重复结算；
   - 每步结算留痕（各选项票数、投票人数、结算方式 manual/auto），在“已结算路径”中随逐步得分一并展示，累计分实时更新。
5. **结束**：共享会话到达结局即本场结束，之后投票与结算都会被拒绝（返回原因及当前步号）；已结束房间仍可进入观摩路径与票数。
6. **边界规则**：
   - 房间的共享会话**不能经单人选择入口推进**（`POST /api/sessions/:code/move` 对房间会话返回 `409 ROOM_SOLO_MOVE_FORBIDDEN`），只能走“投票 + 结算”；
   - 房间会话仍可被**复盘分叉**：从任意历史非结局步分叉出的分支是普通单人会话，可继续单人选择，不影响房间；
   - 过期步号、无效凭证、条件不符、已结束等失败一律**不改变票数、路径与得分**，响应中携带原因及当前步号（`current.stepNo`）。

#### 限时模式细则

- **开房**：请求带 `stepDuration`（30～3600 的整数秒）即为限时房间；省略、`null` 或不传为旧用法。房间快照中 `timed=true`、`stepDurationSeconds` 为每步秒数，`timer` 给出本步计时信息。
- **每步开始即持久化截止时间**：第 0 步开房时写入；之后每一步在**实际推进时刻**（手动提前结算 / 到点自动结算）写入 `deadline_ms = 实际推进时刻 + stepDuration`，到达结局的步不计时。
- **页面显示**：房间顶部计时条展示每步时长、**截止时间**（服务器持久值）与**每秒倒数的剩余时间**（按响应头 `Date` 校准本地时钟）；剩余 ≤10 秒红色闪烁，到点零票暂停时黄色提示。
- **截止前**：学员可投票/改票；主持人可点「立即结算本步」**提前结算**（留痕 `kind=manual`）。
- **到点后**：本步拒绝一切新票与改票（`STEP_DEADLINE_PASSED`；若有票已自动推进，则对旧步投票得到 `STEP_STALE`）：
  - **有票**：系统按既有投票自动多数决推进，同票仍按选项编排顺序，计分规则不变（留痕 `kind=auto`，已结算路径标注「⏱️ 到点自动结算」），**下一步从实际自动结算时刻重新计满时长**；
  - **零票**：不推进，停在本步，`timer.phase=awaiting_reopen`；此时投票返回 `409 STEP_AWAITING_REOPEN`、直接结算同样被拒。
- **主持人重开**：零票暂停后，主持人凭主持凭证与**所见步号**调用重开（页面主持台「⏱️ 重开本步」），系统从**重开时刻**起再给**完整的一步时长**，截止时间刷新并持久化；不推进、不改路径与得分。本步重开次数累计返回（`reopenedCount`）。
- **无人访问 / 重启补办**：到期处理纯由持久化的 `deadline_ms` 驱动——服务启动时先扫描补办一次，运行中每 2 秒扫描一次；到点发生在服务离线期间，重启后也会立即自动结算（下一步时长从补办时刻起算）或暂停。
- **不重复推进**：投票 / 手动结算内部都会先在同一事务内补办到期；自动结算与手动/并发结算相遇时，`room_settlements` 的（房间, 步号）唯一约束保证同一步只结算一次，后者得到 `409 STEP_STALE` 且票数、路径、得分不变。

#### 盲投模式细则

- **开房**：请求带布尔值 `blind: true` 即开盲投房；省略该字段或 `blind: false` 为公开投票旧用法；**存量房间一律为公开投票**。只接受 JSON 布尔值，传 `null` / 字符串 / 数字（含 `0` / `1`）等非布尔值一律 `400 BLIND_INVALID` 且**不建房**。盲投**创建后不可更改**（无任何修改入口），可与限时模式叠加。
- **结算前可见性（当前步）**：
  - **围观者 / 学员 / 主持人**都只能看到**已投人数**（`totalVotes`）；快照中当前步各选项 `votes` 一律为 `null`，不显示各选项票数；
  - 即使出示有效主持凭证，当前步逐人投票明细字段 `votes` 也为 `null`（不暴露逐人选项）；
  - 学员凭**有效成员凭证**仍可查看、修改自己的票：`myVote` 照常返回自己的 `optionId`，投票 / 改票接口与步号校验完全沿用现状；
  - 主持人仍可查看**成员名单** `members`（仅姓名与加入时间，**不含各自选项**）；
  - 房间页面顶部以 **🔒 盲投阶段**提示条明确标注当前处于盲投：只公开已投人数、结算后才公布票数；选项卡片上的票数位置显示 🔒。
- **结算后公布**：主持人**提前结算**或限时房**到点自动结算**后，立即公布该步**各选项票数、获胜处置与本步得分/累计分**（结算响应 `settled.tallies`，快照 `settlements` 与“已结算路径”）；**始终不公开姓名与选项的对应关系**——结算响应、`settlements` 留痕与数据库 `room_settlements.tallies` 中都只有 `optionId / optionLabel / votes`，从不含姓名或成员凭证。
- **暂停 / 重开期间继续保密**：盲投 + 限时房到点**零票暂停**（`timer.phase=awaiting_reopen`）及主持人**重开**后，当前步依旧只显示已投人数（为 0）与成员名单，不显示任何选项票数；已结算的历史步结果（票数、获胜处置）在后续步快照中**保持可见**。
- **沿用现状的部分**：截止时间与到点处理、同票按冻结版本选项编排顺序、共享路径推进、计分、凭证校验、步号校验（`STEP_STALE` 等）、无人投票不得结算、房间会话不得绕过投票等规则全部不变。

### 训练任务（“训练任务”页，计次的单人演练）

培训师把一次考核/作业配置为一个**训练任务**：学员各自凭**个人参与凭证**在**截止时间**前完成最多 **N** 次单人演练，培训师凭**管理凭证**统一查看成绩。

1. **建立任务（培训师）**：在“训练任务”页选择已发布情境与**冻结版本**（默认最新发布版），填写**截止时间**、**每人最多尝试次数**（正整数）、**及格分**（整数）与**学员名单**（每行一个姓名），点「建立训练任务」：
   - 系统返回**任务编号**、**管理凭证**（`adm_…`）与每名学员的**独立参与凭证**（`ptk_…`，页面可点击复制，请分别发给本人）；
   - 任务**绑定所选冻结版本**：之后再发布新版本，本任务的选项条件、步号与计分规则一律不变；
   - **非法配置整次拒绝**（不写库）：截止时间未晚于当前时间（`TASK_DEADLINE_INVALID`）、次数非正整数（`TASK_MAX_ATTEMPTS_INVALID`）、及格分非整数（`TASK_PASS_SCORE_INVALID`）、名单为空/含空姓名（`TASK_TRAINEES_INVALID`）、姓名重复（`TASK_TRAINEE_DUPLICATE`）。
2. **学员参与**：凭「任务编号 + 本人参与凭证」点「开始 / 续做」：
   - **有未结束尝试时重复开始返回原会话**（不新建会话、不消耗次数；断线重进、多人误点都安全）；
   - 当前尝试**结束后**再开始才消耗下一次次数；**次数耗尽**返回 `409 TASK_ATTEMPTS_EXHAUSTED`；
   - **截止后不能开新尝试**（`409 TASK_DEADLINE_PASSED`），但**未结束的旧会话仍可续做到底**；
   - 演练过程与普通单人演练一致：沿任务**冻结版本**的选项条件、步号与计分规则推进，每步可见本步得分与累计分；到达结局后页面提示本次总分与**是否达到及格分**；
   - 任务会话**只能凭本人参与凭证查看和操作**：普通会话列表不出现任务会话；普通会话入口（查询/推进/分叉/对照）对任务会话一律拒绝（`401 TASK_TOKEN_INVALID` / `409 TASK_SESSION_FORK_FORBIDDEN`）。
3. **管理成绩（培训师）**：凭「任务编号 + 管理凭证」进入管理视图（每 4 秒自动刷新）：
   - 汇总：学员人数、已开始人数、**已及格人数**、尝试总次数；
   - 逐人：参与凭证（便于补发）、已用次数、当前状态、**每次尝试记录**（状态/步数/得分/时间）、**最高已结束总分**与**是否达到及格分**；
   - **成绩口径**：只统计**已结束**的尝试；进行中的尝试不计入；**无已结束尝试时成绩为空**（`bestScore=null`、`passed=null`）。

---

## 五、发布检查规则（核心）

系统把每个可达局面表示为 `(节点, 状态组合)`，从 `(起点, 初始状态)` 出发做完整状态空间枚举（至多 8 个布尔状态，组合数 ≤ 256 × 节点数）：

1. **无路可走（死路）**：某个可达的非结局局面下没有任何条件满足的选项 → 拒绝发布，并给出从初态到该局面的逐步路径。
2. **可无限循环**：采用“安全局面”收缩判定 —— 结局是安全的；一个非结局局面，当且仅当它存在可选边**且所有**可选边都通向安全局面时才安全。收缩后仍不安全的可达局面即可能被学员无限走下去而永不抵达结局 → 拒绝发布，报告中给出：
   - 从初态到达该局面的**可复现路径**；
   - 从该局面出发的**具体循环段**（重复执行其中的选择即可永不抵达结局）。
3. **不可达节点**只作为警告，不阻止发布。

结构问题（独立于发布检查，**保存草稿时**即拒绝）：状态数量不在 1–8、id 非法/重复、标题为空、起点不存在、无结局、选项目标节点不存在、条件/变更引用不存在的状态、同一选项对同一状态同时要求“是”和“否”、结局节点携带选项等。

### 会话推进规则

每步请求必须带 `stepNo`（当前步号，从 0 开始）：

- `stepNo` 与服务端当前步号不一致（过期页面、重复提交、并发双击）→ `409 STEP_STALE`，返回现状，不推进；
- 条件不满足 → `409 CONDITION_NOT_MET`，逐条列出哪个状态需要是/否，返回现状，不推进；
- 选项不属于当前节点 → `400 OPTION_NOT_FOUND`；会话已结束 → `409 SESSION_ENDED`。

**计分规则**：只有成功推进的有效选择计分（取该选项在**会话绑定冻结版本**中的 `score`，无该字段时按 0），累加到 `totalScore`，并在响应中通过 `lastMove` 返回本步得分与说明；任何上述失败都不改变成绩，返回现状中的 `totalScore` 为当前累计分。历史会话（含分支）的成绩始终由“绑定版本规则 + 已完成路径”实时计算，版本重发、改分均不影响已冻结的旧会话。

---

## 六、主要 HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/published` | 已发布情境列表（学员） |
| POST | `/api/sessions` | `{scenarioId, traineeName?}` 开始新会话（绑定最新版） |
| GET | `/api/sessions/:code` | 查询会话现状（可选项/状态/路径） |
| POST | `/api/sessions/:code/move` | `{optionId, stepNo}` 执行一步；失败返回原因与现状 |
| POST | `/api/sessions/:code/fork` | `{forkStepNo, observedStepNo, traineeName?}` 培训师复盘分叉，返回新分支会话快照（201） |
| GET | `/api/sessions/:code/lineage` | 来源与分支对照树（同一家族的原始会话与全部分支，含各自路径） |
| GET | `/api/sessions` | 最近会话列表（含 `parent_code` / `fork_step_no` / `root_code` 溯源字段，以及实时计算的 `total_score` 总分） |
| GET | `/api/scenarios` | 培训师情境列表 |
| POST | `/api/scenarios` | 新建（首版草稿，结构校验） |
| GET | `/api/scenarios/:id` | 草稿 + 版本清单 |
| PUT | `/api/scenarios/:id/draft` | 保存草稿（无效引用/矛盾条件拒绝） |
| POST | `/api/scenarios/:id/analyze` | 发布前检查（可带未保存草稿） |
| POST | `/api/scenarios/:id/publish` | 发布冻结新版本（检查不过返回 422 与可复现路径） |
| GET | `/api/scenarios/:id/versions/:version/coverage` | **处置覆盖报告**（可加 `?uncovered=1` 只列未覆盖项；计数始终基于全量） |
| POST | `/api/rooms` | `{scenarioId, version?, stepDuration?, blind?}` 开启共识演练房间（绑定冻结版本）；`stepDuration` 为 30..3600 整数秒时开限时房，省略/`null` 为不限时旧用法；`blind` 仅接受布尔值，`true` 开盲投房、省略/`false` 为公开投票旧用法，非布尔值返回 `400 BLIND_INVALID` 且不建房；返回加入码与主持凭证（201） |
| GET | `/api/rooms` | 最近房间列表（不含凭证与投票明细；每行含 `step_duration`，非空为限时房；含 `blind_vote`，1 为盲投房） |
| GET | `/api/rooms/:code` | 房间现状：当前步、可选处置与聚合票数、已结算路径、累计分、**限时计时信息 `timer`**、**盲投标记 `blind`**；盲投房当前步各选项 `votes=null`、主持视图 `votes=null`（仅给 `totalVotes` 与 `members`）；`?memberToken=` 附 `myVote`，`?hostToken=` 在公开房附逐人投票明细 |
| POST | `/api/rooms/:code/join` | `{name?}` 学员加入，返回成员凭证（201） |
| POST | `/api/rooms/:code/vote` | `{memberToken, optionId, stepNo}` 投票/改票（每人每步只计最后一票）；限时房到点后拒绝本步投票 |
| POST | `/api/rooms/:code/settle` | `{hostToken, observedStepNo}` 主持人结算：多数决推进共享会话，同票按编排顺序；限时房截止前为提前结算，到点由系统自动结算（响应 `settled.kind=auto`） |
| POST | `/api/rooms/:code/reopen` | `{hostToken, observedStepNo}` **仅限时房间**：本步到点零票暂停后重开完整时长，不推进；返回新截止时间 |
| POST | `/api/tasks` | `{scenarioId, version?, deadline, maxAttempts, passScore, trainees}` 建立训练任务（绑定冻结版本；非法配置整次拒绝）；返回任务编号、管理凭证与各学员参与凭证（201） |
| GET | `/api/tasks` | 最近任务列表（仅元信息；不含任何凭证与成绩） |
| GET | `/api/tasks/:id` | 任务公开元信息（截止/次数/及格分/学员数；不含凭证与成绩） |
| POST | `/api/tasks/:id/start` | `{token}` 学员开始或续做：有未结束尝试返回原会话（200，`resumed=true`，不扣次数）；否则新建一次尝试（201）；次数耗尽/已截止/凭证无效明确反馈 |
| GET | `/api/tasks/:id/my` | `?token=` 学员视角：我的尝试记录与进行中的会话快照 |
| POST | `/api/tasks/:id/move` | `{token, optionId, stepNo}` 在本人进行中的任务会话里执行一步（沿用冻结版本规则） |
| GET | `/api/tasks/:id/manage` | `?token=管理凭证` 成绩报告：各人尝试记录、最高已结束总分、是否达到及格分（无已结束尝试成绩为空） |

### 评分相关字段（随版本冻结，旧版本/旧会话自动按 0 分兜底）

- **草稿 / 冻结版本中的选项**新增：`score`（-10..10 整数；缺省/`null` 视为 0）、`scoreNote`（评分说明文本，可空）。保存草稿时非整数、越界或说明类型/长度不合法都会被拒绝（错误码 `OPTION_SCORE_INVALID` / `OPTION_SCORE_NOTE_INVALID` / `OPTION_SCORE_NOTE_TOO_LONG`，HTTP 400，且不写库）。
- **会话快照**（开始会话、查询、分叉、会话家族树的每个节点）新增：
  - 顶层 `totalScore`：当前会话已完成路径的累计分（按其绑定版本实时计算）；
  - `path[]` 每步新增 `score`（该步得分）与 `scoreNote`（该选项的评分说明，可能为空串）。
  - 学员选择前的 `availableOptions` / `unavailableOptions` **不包含**分值与说明。
- **`POST /api/sessions/:code/move` 成功响应**额外携带 `lastMove`：`{ step, optionId, optionLabel, score, scoreNote, totalScore }`，即本步得分、说明与得分后的累计分。校验失败（`STEP_STALE` / `CONDITION_NOT_MET` / `OPTION_NOT_FOUND` / `SESSION_ENDED` 等）不推进、不产生 `lastMove`，响应中的现状 `current.totalScore` 维持原值。
- **`POST /api/sessions/:code/fork` 成功响应**额外携带 `inheritedScore`：分支继承的、截至分歧步已完成路径的得分（等于该分支此刻的 `totalScore`；第 0 步分叉为 0）。
- **GET `/api/sessions`** 每行新增 `total_score`（沿用列表的下划线命名）。
- 以上均为**增量字段**，既有的错误码、HTTP 状态码、`current` / `sourceCurrent` 回传结构、会话查询/推进/分叉/对照接口的字段约定保持兼容。

### 评分相关 HTTP 调用示例

```bash
# 保存带分值的草稿：score 为 -10..10 整数，缺省按 0；非整数/越界返回 400
curl -s -X PUT localhost:8080/api/scenarios/<id>/draft \
  -H 'Content-Type: application/json' \
  -d '{"title":"…","states":[…],"startNodeId":"n1","nodes":[
        {"id":"n1","title":"起","narrative":"","isEnd":false,"options":[
          {"id":"o1","label":"先断电","conditions":[],"changes":[],
           "toNodeId":"n2","score":3,"scoreNote":"第一时间消除点火源"}]}],
        {"id":"n2","title":"结局","narrative":"","isEnd":true,"options":[]}]}'
# -> { "ok":true, "publishReport":{ ... } }

# 非法分值（3.5 非整数）被拒绝
# 400 { "error":"草稿校验失败，未保存",
#       "errors":[{"code":"OPTION_SCORE_INVALID","message":"选项「先断电」的分值非法：3.5（必须是 -10..10 的整数；留空视为 0）", ...}] }

# 有效选择后返回本步得分 / 说明 / 累计分
curl -s -X POST localhost:8080/api/sessions/1a2b3c4d5e/move \
  -H 'Content-Type: application/json' -d '{"optionId":"o1","stepNo":0}'
# -> { "ok":true, "stepNo":1, "totalScore":3,
#      "lastMove":{"step":1,"optionId":"o1","optionLabel":"先断电",
#                  "score":3,"scoreNote":"第一时间消除点火源","totalScore":3},
#      "path":[{"step":1, ..., "score":3, "scoreNote":"第一时间消除点火源"}], ... }

# 分叉：inheritedScore 为继承的已完成路径得分
curl -s -X POST localhost:8080/api/sessions/1a2b3c4d5e/fork \
  -H 'Content-Type: application/json' -d '{"forkStepNo":1,"observedStepNo":2}'
# -> { "ok":true, ..., "totalScore":3, "inheritedScore":3 }
```

### 复盘分叉 HTTP 调用示例

以下示例基于内置示例情境（会话码请按实际返回替换）。

```bash
# 0) 开始一个源会话并走两步（stepNo 严格携带当前步号）
curl -s localhost:8080/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"scenarioId":"<scenarioId>","traineeName":"张三"}'
# -> { "code": "1a2b3c4d5e", "version": 1, "stepNo": 0, ... }

curl -s localhost:8080/api/sessions/1a2b3c4d5e/move \
  -H 'Content-Type: application/json' -d '{"optionId":"o_cut_power","stepNo":0}'
curl -s localhost:8080/api/sessions/1a2b3c4d5e/move \
  -H 'Content-Type: application/json' -d '{"optionId":"o_evac","stepNo":1}'
# 此时源会话当前步号 = 2

# 1) 从源会话的“第 1 步”历史局面分叉：
#    forkStepNo     = 分歧步号（要回到的历史步）
#    observedStepNo = 培训师“所见的源当前步号”（乐观锁，防止基于过期局面分叉）
curl -s -X POST localhost:8080/api/sessions/1a2b3c4d5e/fork \
  -H 'Content-Type: application/json' \
  -d '{"forkStepNo":1,"observedStepNo":2,"traineeName":"复盘-换一种处置"}'
# 201 ->
# { "code":"f0e1d2c3b4", "forkStepNo":1, "forkedFrom":"1a2b3c4d5e",
#   "version":1,                       # 沿用源绑定的冻结版本
#   "stepNo":1, "status":"active",     # 位于第 1 步局面，可继续选择
#   "currentNode":{"id":"n_scene",...},
#   "path":[ {第 1 步: 断电→查明泄漏点, ...} ],   # 保留分歧步之前的路径
#   "lineage":{"rootCode":"1a2b3c4d5e","parentCode":"1a2b3c4d5e",
#              "forkStepNo":1,"isBranch":true} }

# 2) 在分支上继续选择（步号从分歧步号 1 开始；只推进分支）
curl -s localhost:8080/api/sessions/f0e1d2c3b4/move \
  -H 'Content-Type: application/json' -d '{"optionId":"o_tighten","stepNo":1}'

# 3) 分支再次分叉（从该已结局分支的第 0 步初态另走）
curl -s -X POST localhost:8080/api/sessions/f0e1d2c3b4/fork \
  -H 'Content-Type: application/json' -d '{"forkStepNo":0,"observedStepNo":2}'

# 4) 查看来源与分支对照树（任一家族成员码均可，返回同一棵树）
curl -s localhost:8080/api/sessions/1a2b3c4d5e/lineage
# -> { "rootCode":"1a2b3c4d5e", "tree":{ code, lineage, path, status, stepNo,
#                                        currentNode, children:[ ...分支... ] } }
```

典型失败响应（**不创建分支**；能定位源会话时回传其当前步号）：

```bash
# 源步号已变化（页面上看到的是第 2 步，实际源已走到第 4 步）
curl -s -X POST localhost:8080/api/sessions/1a2b3c4d5e/fork \
  -H 'Content-Type: application/json' -d '{"forkStepNo":2,"observedStepNo":2}'
# 409 { "errorCode":"STEP_STALE",
#       "error":"源会话步号已变化：你看到的是第 2 步，源会话当前为第 4 步，未创建分支…",
#       "sourceCurrent":{"code":"1a2b3c4d5e","stepNo":4},   # ← 源当前真实步号
#       "current":{ ...源会话最新现状快照... } }

# 分歧点越界
curl -s -X POST localhost:8080/api/sessions/1a2b3c4d5e/fork \
  -H 'Content-Type: application/json' -d '{"forkStepNo":99,"observedStepNo":4}'
# 409 { "errorCode":"FORK_STEP_OUT_OF_RANGE", "sourceCurrent":{"stepNo":4}, ... }

# 结局步不得分叉（已结束会话可改用其之前的非结局步）
curl -s -X POST localhost:8080/api/sessions/1a2b3c4d5e/fork \
  -H 'Content-Type: application/json' -d '{"forkStepNo":4,"observedStepNo":4}'
# 409 { "errorCode":"FORK_AT_END_STEP", "sourceCurrent":{"stepNo":4}, ... }

# 源会话不存在
# 404 { "errorCode":"SESSION_NOT_FOUND", ... }   （无法定位源，故无 sourceCurrent）
```

---

## 六之二、处置覆盖报告接口

`GET /api/scenarios/:id/versions/:version/coverage`

- `:version` 必须是已发布（已冻结）的版本号（≥1）；可加查询参数 `?uncovered=1`（或 `true`/`yes`），此时 `items` 只包含未覆盖项，但 `totals` 仍按全量覆盖项统计。
- 统计口径见上文「处置覆盖报告的统计口径」：只统计绑定该版本的会话、按家族去重、进行中只计已完成步骤、其它版本不混入、损坏即整体失败。

返回结构（节选）：

```json
{
  "ok": true,
  "scenarioId": "sc_…",
  "scenarioTitle": "示例：车间可燃气体泄漏初期处置",
  "version": 1,
  "versionPublishedAt": "2026-10-04 02:53:17",
  "totals": {
    "total": 8,            // 覆盖项总数（可达局面 × 可选项）
    "covered": 3,          // 已被至少一个家族覆盖的数量
    "uncovered": 5,        // 未覆盖数量
    "sessionsConsidered": 4,   // 绑定该版本的会话数（含进行中、零步）
    "familiesConsidered": 2,   // 演练家族数（按 root_code 去重）
    "familiesWithCoverage": 2
  },
  "items": [
    {
      "nodeId": "n_scene",
      "nodeTitle": "查明泄漏点",
      "entryStates": [ {"id":"power","name":"厂区电源已切断","value":true}, … ],
      "option": {
        "id": "o_evac", "label": "组织全员撤离至安全区并清点人数",
        "conditions": [], "changes": [ … ],
        "toNodeId": "n_command", "toNodeTitle": "安全区建立指挥点",
        "score": 4, "scoreNote": "…"
      },
      "covered": true,
      "coveredFamilies": 1,       // 覆盖该项的家族数（同家族原始/多级分支只算 1）
      "familyCodes": ["9dcaff3c20"]  // 贡献覆盖的家族根会话码
    }
  ]
}
```

调用示例：

```bash
# 查看 v1 的完整覆盖报告
curl -s localhost:8080/api/scenarios/sc_14f5505a2f47a3a3/versions/1/coverage | jq '.totals'
# -> { total: 8, covered: 0, uncovered: 8, sessionsConsidered: 0, … }

# 只取未覆盖项（totals 仍是全量计数），便于脚本驱动补练
curl -s 'localhost:8080/api/scenarios/sc_14f5505a2f47a3a3/versions/1/coverage?uncovered=1' \
  | jq '.items[] | {node: .nodeTitle, states: [.entryStates[] | select(.value).name], action: .option.label}'

# 用 Node 取报告（等价的 HTTP 调用）
node -e 'fetch("http://localhost:8080/api/scenarios/sc_14f5505a2f47a3a3/versions/1/coverage")
  .then(r=>r.json()).then(r=>console.log(`${r.totals.covered}/${r.totals.total} 已覆盖，未覆盖 ${r.totals.uncovered} 项`))'
```

错误响应（**不返回任何 items/部分统计**）：

| 情况 | HTTP / errorCode |
| --- | --- |
| 版本号不是 ≥1 的整数 | `400 VERSION_INVALID` |
| 情境不存在 | `404 SCENARIO_NOT_FOUND` |
| 该版本未发布/不存在 | `404 VERSION_NOT_FOUND` |
| 冻结内容无法解析、结构损坏或不再满足发布不变量（死路/可无限循环） | `500 VERSION_CONTENT_CORRUPT` |
| 某绑定会话的路径与冻结规则重放不一致（步号/节点/选项/条件/状态/结局对不上） | `500 SESSION_PATH_CORRUPT`（`detail.sessionCode` 指出损坏会话） |

---

## 六之三、共识演练房间接口

房间操作全部通过 HTTP API 完成；凭证（主持凭证 / 成员凭证）放在请求体或查询参数中。
所有失败响应都形如 `{ "error", "errorCode", "current" }`：`current` 为房间现状快照
（含 `current.stepNo` 当前步号），且任何失败都不改变票数、路径与得分。

房间快照主要字段：`code`（加入码）、`version`（绑定冻结版本）、`status`、`stepNo`、
`totalScore`、`currentNode`、`states`、`options`（可选处置，各带 `votes` 聚合票数）、
`unavailableOptions`（条件不满足的处置）、`memberCount`、`totalVotes`、`path`（已结算路径，
含每步得分）、`settlements`（每步结算留痕：各选项票数、投票人数与 `kind`：`manual` 主持人结算 /
`auto` 到点自动结算）；带成员凭证时附 `myVote`，带主持凭证时附 `votes`（逐人明细）与 `members`。
**未结算前学员视图不含他人选票。**

盲投模式增量字段（公开投票房同样返回 `blind:false`，完全兼容）：

- 开房请求新增 **可选** `blind`：仅接受 JSON 布尔值；省略 / `false` = 公开投票旧用法，`true` = 盲投；
  非布尔值（`null` / 字符串 / 数字 / 数组 / 对象）返回 `400 BLIND_INVALID`，**不建房**。盲投创建后不可更改。
- 开房响应新增 `blind`（布尔）；房间快照新增顶层 `blind`，`GET /api/rooms` 列表每行新增 `blind_vote`（0/1）。
- 盲投房**当前步结算前**（含限时房零票暂停 / 重开期间）：
  - 顶层 `blind=true`；`options[]` / `unavailableOptions[]` 的 `votes` 一律为 **`null`**（不显示各选项票数），
    只通过 `totalVotes` 公开**已投人数**；
  - 围观视图不返回 `votes` / `members`；持主持凭证时 `votes` 为 **`null`**（不暴露逐人选项），
    但 `members`（成员名单，仅姓名/加入时间）照常返回；
  - 持成员凭证时 `myVote` 照常返回自己的 `optionId`，投票 / 改票 / 步号校验与公开房完全一致。
- 结算（手动 / 自动）后：该步票数进入 `settlements[].tallies` 与已结算路径并**保持可见**；
  `settled.tallies` / `settlements` 只含 `optionId / optionLabel / votes`，**任何情况下都不含姓名或凭证**；
  房间进入下一步后，下一步仍是盲投（`blind=true`、当前步 `votes=null`）。

限时模式增量字段（旧用法房间同样返回，固定为非限时取值，完全兼容）：

- 开房请求新增 **可选** `stepDuration`：30～3600 的整数秒；省略 / `null` / 不传 = 不限时旧用法。
  非法（越界、非整数、字符串等）返回 `400 STEP_DURATION_INVALID`，不开房。
- 开房响应新增 `timed`（布尔）与 `stepDurationSeconds`（不限时为 `null`）。
- 房间快照新增：
  - 顶层 `timed`、`stepDurationSeconds`（不限时为 `false` / `null`）；
  - `timer`：`{ timed, phase, deadlineMs, deadlineAt(ISO), openedAtMs, remainingMs, reopenedCount, stepDurationSeconds }`
    - `phase`：`open`（计时中，含不限时旧用法）/ `awaiting_reopen`（限时房到点零票，暂停待重开）/ `ended`（已到结局）；
    - `deadlineMs` 为**服务器持久化**的本步截止时刻（epoch 毫秒），`remainingMs = max(0, deadlineMs-当前时刻)`；
      客户端应以此为准显示倒计时（可结合响应头 `Date` 校准本机时钟），不要自行推算截止时间；
    - 不限时房间 `deadlineMs / deadlineAt / remainingMs` 均为 `null`。
- `GET /api/rooms` 列表每行新增 `step_duration`（不限时为 `null`）。
- 既有请求字段与响应字段（`stepNo`、`observedStepNo`、`myVote`、`settled`、`current` 等）
  及全部旧错误码**保持可用不变**。

```bash
# 0) 培训师开启房间：绑定已发布冻结版本（version 缺省为当前最新发布版）
#    不传 stepDuration = 不限时旧用法；传 30..3600 整数秒 = 限时房间
curl -s -X POST localhost:8080/api/rooms \
  -H 'Content-Type: application/json' \
  -d '{"scenarioId":"sc_14f5505a2f47a3a3","version":1}'
# 201 -> { "ok":true, "code":"7d24ee9bb0", "joinCode":"7d24ee9bb0",
#          "hostToken":"host_10b2a174…",   # 主持凭证，仅此处完整返回，妥善保存
#          "version":1, "sessionCode":"dff651d1c6",
#          "timed":false, "stepDurationSeconds":null, ... }
#    此后即使发布 v2，本房间仍按 v1 的冻结规则与分值进行

# 0b) 开启限时房间：每步 120 秒（30..3600；非法值 400 STEP_DURATION_INVALID）
curl -s -X POST localhost:8080/api/rooms \
  -H 'Content-Type: application/json' \
  -d '{"scenarioId":"sc_14f5505a2f47a3a3","version":1,"stepDuration":120}'
# 201 -> { "ok":true, "code":"a1b2c3d4e5", "joinCode":"a1b2c3d4e5",
#          "hostToken":"host_9f8e7d…", "version":1,
#          "timed":true, "stepDurationSeconds":120, ... }
#    第 0 步截止时间此刻已持久化（实际时刻 + 120s）

# 0c) 开启盲投房间（可与限时叠加：再加 "stepDuration":120）
curl -s -X POST localhost:8080/api/rooms \
  -H 'Content-Type: application/json' \
  -d '{"scenarioId":"sc_14f5505a2f47a3a3","version":1,"blind":true}'
# 201 -> { "ok":true, "code":"c9f8e7d6c5", "joinCode":"c9f8e7d6c5",
#          "hostToken":"host_1a2b…", "version":1,
#          "timed":false, "stepDurationSeconds":null, "blind":true, ... }

# 0d) blind 只接受布尔值：字符串 / null / 数字一律 400 且不建房
curl -s -X POST localhost:8080/api/rooms \
  -H 'Content-Type: application/json' \
  -d '{"scenarioId":"sc_14f5505a2f47a3a3","version":1,"blind":"true"}'
# 400 { "error":"盲投参数非法：\"true\"（blind 必须是布尔值 true/false；省略该字段为公开投票的旧用法）",
#       "errorCode":"BLIND_INVALID" }

# 盲投房当前步：围观/学员/主持都只拿到已投人数，options[].votes 全为 null
curl -s localhost:8080/api/rooms/c9f8e7d6c5
# -> { "blind":true, "stepNo":0, "totalVotes":2,
#      "options":[{"id":"o_cut_power","votes":null,…},{"id":"o_rush_in","votes":null,…}],
#      ... 无 votes / members 字段 }
curl -s 'localhost:8080/api/rooms/c9f8e7d6c5?memberToken=mem_ee54ed…'
# -> { ..., "myVote":{"optionId":"o_cut_power"},            # 学员凭凭证只看得到自己的票
#      "totalVotes":2, "options":[{"id":"o_cut_power","votes":null}, ...] }
curl -s 'localhost:8080/api/rooms/c9f8e7d6c5?hostToken=host_1a2b…'
# -> { ..., "isHost":true, "votes":null,                     # 主持也看不到逐人选项与各选项票数
#      "members":[{"name":"张三","joinedAt":"…"}],            # 但成员名单照常可见（不含选项）
#      "totalVotes":2, "options":[{"id":"o_cut_power","votes":null}, ...] }

# 结算后公布该步各选项票数与获胜处置；始终不含姓名
curl -s -X POST localhost:8080/api/rooms/c9f8e7d6c5/settle \
  -H 'Content-Type: application/json' \
  -d '{"hostToken":"host_1a2b…","observedStepNo":0}'
# -> { "ok":true, "settled":{ "stepNo":0, "optionId":"o_cut_power",
#        "tallies":[{"optionId":"o_cut_power","optionLabel":"立即切断厂区总电源…","votes":2},
#                   {"optionId":"o_rush_in","optionLabel":"…","votes":0}],
#        "voterCount":2, "kind":"manual", ... },               # 无任何姓名字段
#      "current":{ "stepNo":1, "blind":true,                   # 下一步仍盲投
#                  "settlements":[{"stepNo":0,"tallies":[…]}], # 已结算步结果保持可见
#                  "options":[{"id":"…","votes":null}, ...] } }

# 1) 学员凭加入码加入，取得成员凭证
curl -s -X POST localhost:8080/api/rooms/7d24ee9bb0/join \
  -H 'Content-Type: application/json' -d '{"name":"张三"}'
# 201 -> { "ok":true, "memberToken":"mem_ee54ed…", "room":{ ...房间快照... } }

# 2) 学员对当前步投票（stepNo 必须等于当前步号）；结算前可改票，只计最后一票
curl -s -X POST localhost:8080/api/rooms/7d24ee9bb0/vote \
  -H 'Content-Type: application/json' \
  -d '{"memberToken":"mem_ee54ed…","optionId":"o_cut_power","stepNo":0}'
# -> { "ok":true, "myVote":{"optionId":"o_cut_power"},
#      "current":{ "stepNo":0, "totalVotes":1,
#                  "options":[{"id":"o_cut_power","votes":1,...}, ...], ... } }

# 3) 任何人可查看房间现状（聚合票数；成员凭证附 myVote；主持凭证附逐人明细）
curl -s 'localhost:8080/api/rooms/a1b2c3d4e5?memberToken=mem_ee54ed…'
# 限时房间快照额外含：
# { ..., "timed":true, "stepDurationSeconds":120,
#   "timer":{ "timed":true, "phase":"open",
#             "deadlineMs":1781134800000,                    # 服务器持久化的本步截止时刻
#             "deadlineAt":"2026-10-04T10:20:00.000Z",
#             "openedAtMs":1781134680000,
#             "remainingMs":95432,                           # 剩余毫秒（每次请求按当时计算）
#             "reopenedCount":0, "stepDurationSeconds":120 },
#   "settlements":[ { "stepNo":0, ..., "kind":"manual" } ] } # auto = 到点自动结算
curl -s 'localhost:8080/api/rooms/a1b2c3d4e5?hostToken=host_9f8e7d…'   # 主持人可见 votes 明细

# 4) 主持人携所见步号结算：多数决推进；同票按冻结版本的选项编排顺序
#    限时房间在截止前调用 = 提前结算（kind=manual）；若该步刚好已到点，服务端先自动
#    补办（有票自动推进），本请求对旧步号得到 STEP_STALE，绝不会重复推进。
curl -s -X POST localhost:8080/api/rooms/a1b2c3d4e5/settle \
  -H 'Content-Type: application/json' \
  -d '{"hostToken":"host_9f8e7d…","observedStepNo":0}'
# -> { "ok":true, "autoSettled":false,
#      "settled":{ "stepNo":0, "optionId":"o_cut_power", "kind":"manual",
#                  "tallies":[…], "voterCount":2, "score":3, "totalScore":3 },
#      "current":{ "stepNo":1, "timer":{ "phase":"open",
#                  "deadlineMs":…, "remainingMs":119990, … }, … } }   # 下一步从实际推进时刻计满
#    上例若 1:1 同票：o_cut_power 在冻结版本中编排在前，故胜出

# 5) 房间列表（限时房间带 step_duration）
curl -s localhost:8080/api/rooms
# -> [ { "code":"a1b2c3d4e5", "scenario_title":"…", "version":1,
#        "step_duration":120, "status":"active", "step_no":1, "member_count":3, … },
#      { "code":"7d24ee9bb0", "step_duration":null, … } ]

# 6) 限时房间：到点后的行为（无需任何人操作，系统自动补办；也可直接观察快照变化）
#    a) 到点时本步有票 → 自动多数决推进（kind=auto），下一步从实际自动结算时刻重新计满
curl -s 'localhost:8080/api/rooms/a1b2c3d4e5?hostToken=host_9f8e7d…'
# -> { "stepNo":2, "settlements":[ { "stepNo":1, "kind":"auto", "optionId":"o_evac",
#                                   "tallies":[…], "voterCount":2 }, … ],
#      "timer":{ "phase":"open", "remainingMs":120000, … } }
#    b) 到点后再对该步投新票/改票 → 拒绝（已自动推进则步号过期），不改票
# 409 { "errorCode":"STEP_STALE", "error":"…当前已进行到第 2 步…未计票",
#       "current":{ "stepNo":2, "timer":{ "phase":"open", … } } }
#    c) 到点时零票 → 停在本步、标记待重开
curl -s 'localhost:8080/api/rooms/a1b2c3d4e5'
# -> { "stepNo":2, "totalVotes":0,
#      "timer":{ "phase":"awaiting_reopen", "remainingMs":0, "deadlineMs":…, … } }
# 409 { "errorCode":"STEP_AWAITING_REOPEN", "error":"第 2 步限时结束且无人投票，已暂停等待主持人重开…",
#       "current":{ "stepNo":2, "timer":{ "phase":"awaiting_reopen", … } } }

# 7) 主持人重开（凭主持凭证 + 所见步号；只适用于 awaiting_reopen 的限时房）
curl -s -X POST localhost:8080/api/rooms/a1b2c3d4e5/reopen \
  -H 'Content-Type: application/json' \
  -d '{"hostToken":"host_9f8e7d…","observedStepNo":2}'
# 200 -> { "ok":true,
#          "reopened":{ "stepNo":2, "stepDurationSeconds":120,
#                       "deadlineMs":1781135200000,                         # 重开时刻 + 120s
#                       "deadlineAt":"2026-10-04T10:26:40.000Z",
#                       "reopenedCount":1 },
#          "current":{ "stepNo":2, "timer":{ "phase":"open",
#                       "remainingMs":119995, … }, … } }                   # 不推进，步号不变
```

限时模式相关错误码（均为 `409`，除 `STEP_DURATION_INVALID` 为开房时 `400`、`ROOM_NOT_TIMED` 为 `400`）：

| 情况 | errorCode |
| --- | --- |
| `stepDuration` 不是 30..3600 的整数秒（开房时） | `400 STEP_DURATION_INVALID` |
| `blind` 不是布尔值（开房时；`null`/字符串/数字等，且不建房） | `400 BLIND_INVALID` |
| 到点后对本步投新票/改票（自动推进前的极短窗口） | `409 STEP_DEADLINE_PASSED` |
| 到点有票已自动推进，仍对旧步号投票/结算 | `409 STEP_STALE`（`current.stepNo` 为新步号） |
| 到点零票已暂停：仍投票或要求直接结算 | `409 STEP_AWAITING_REOPEN` |
| 对计时中的步/非暂停步调用重开 | `409 STEP_NOT_PAUSED` |
| 对非限时（旧用法）房间调用重开 | `400 ROOM_NOT_TIMED` |
| 重开时所见步号与服务端不一致 | `409 STEP_STALE` |

典型失败响应（均不改变票数、路径与得分，并返回当前步号）：

```bash
# 过期步号（房间已被结算推进到第 1 步，还按第 0 步投票/结算）
# 409 { "errorCode":"STEP_STALE", "error":"步号不匹配：…当前已进行到第 1 步…",
#       "current":{ "stepNo":1, ... } }

# 无效凭证
# 401 { "errorCode":"MEMBER_TOKEN_INVALID", "current":{ "stepNo":1, ... } }   # 投票
# 401 { "errorCode":"HOST_TOKEN_INVALID",   "current":{ "stepNo":1, ... } }   # 结算

# 条件不符的选项 / 当前步不存在的选项
# 409 { "errorCode":"CONDITION_NOT_MET", ... }   /   400 { "errorCode":"OPTION_NOT_FOUND", ... }

# 无人投票不得结算
# 409 { "errorCode":"NO_VOTES", "error":"当前步还没有任何投票，不能结算", ... }

# 已结束（到达结局后）
# 409 { "errorCode":"ROOM_ENDED", "current":{ "stepNo":4, ... } }

# 房间会话走单人选择入口（绕过投票）——对房间绑定的共享会话调用 /api/sessions/:code/move
# 409 { "errorCode":"ROOM_SOLO_MOVE_FORBIDDEN",
#       "error":"该会话属于共识演练房间 …，须由成员投票、主持人结算推进…" }
```

并发与兼容说明：

- 投票按「房间 × 步号 × 成员」唯一约束 UPSERT，改票与并发重复投票天然幂等，只计最后一票；
- 结算在事务内按当前步号乐观校验并留痕（「房间 × 步号」唯一），并发结算只有一个成功，
  其余得到 `STEP_STALE`；推进共享会话复用与单人完全一致的条件/状态/结局规则；
- **限时房间**：投票/手动结算事务内先补办到期步；自动结算、手动结算、并发结算与重开相遇时，
  同一步的结算留痕唯一约束保证只推进一次（败者事务回滚，得到 `STEP_STALE`/`STEP_AWAITING_REOPEN`，
  票数、路径、得分均不变）；截止时间在每步开始（开房 / 实际推进 / 主持人重开）时持久化，
  服务**启动时 + 每 2 秒**按持久截止时间扫描补办，无人访问或重启期间到期也不漏办；
- **旧用法完全兼容**：省略 `stepDuration` 的开房请求、既有加入/投票/结算请求字段与响应字段
  （含错误响应中的 `current.stepNo`）一律保持原样；房间快照仅**新增** `timed` / `stepDurationSeconds`
  / `timer` 字段，列表仅新增 `step_duration`，老库自动加列迁移、老房间与老留痕（`kind` 默认 `manual`）不受影响；
- **盲投为纯增量扩展**：开房请求仅**新增可选**布尔字段 `blind`（省略/`false` 为公开投票旧用法），
  房间快照仅**新增** `blind`、列表仅新增 `blind_vote`；公开投票房的 `votes`（含主持逐人明细）、
  各选项数字 `votes` 等字段与类型完全不变。老库自动加列 `rooms.blind_vote DEFAULT 0`，
  **存量房间一律为公开投票**；盲投房仅把“当前步结算前”的选项 `votes` 置为 `null`、主持 `votes` 置为 `null`，
  结算后 `settlements` / 已结算路径的结构与公开房一致（且任何房间都不含姓名↔选项对应）。
  盲投房的开房、加入、投票、结算请求/响应约定与凭证、步号校验完全沿用既有接口；盲投设置创建后不可更改；
- 既有单人会话与复盘分叉接口的**路径、方法及请求响应约定不变**，仅作增量扩展：
  会话快照新增 `roomCode`（非空表示房间共享会话）、`GET /api/sessions` 每行新增 `room_code`；
  房间会话可正常查询与分叉（分叉出的分支是普通会话），但不能经 `/move` 推进。

---

## 六之四、训练任务接口

任务操作全部通过 HTTP API 完成。凭证：**管理凭证**（`adm_…`，建任务时返回一次，管理视图可回显）与
**个人参与凭证**（`ptk_…`，每学员一个）。学员凭证放在请求体 `token` 或查询参数 `token` /
`x-task-token` 请求头；管理凭证放在查询参数 `token` 或 `x-admin-token` 请求头。

- **建立任务**：`POST /api/tasks` `{scenarioId, version?, deadline, maxAttempts, passScore, trainees}`
  - `version` 缺省为当前最新发布版；任务**绑定该冻结版本**，后续发布新版本不改变本任务规则；
  - `deadline`：epoch 毫秒（数字）或 ISO-8601 时间串，**必须晚于当前时间**；
  - `maxAttempts`：**正整数**；`passScore`：**整数**（按各人最高已结束总分判定及格）；
  - `trainees`：**非空**姓名数组，姓名去空白后非空、≤100 字且**不重复**；
  - 任何一项非法都**整次拒绝**（400，不写库）；成功返回 `201` 与任务编号、管理凭证、各学员参与凭证。
- **开始 / 续做**：`POST /api/tasks/:id/start` `{token}`
  - 有未结束尝试：返回**原会话**（`200`，`resumed=true`）——不新建会话、不消耗次数，**截止后也可续做**；
  - 无未结束尝试：消耗一次并新建尝试会话（`201`）；次数耗尽 `409 TASK_ATTEMPTS_EXHAUSTED`，
    已过截止 `409 TASK_DEADLINE_PASSED`，凭证无效 `401 TASK_TOKEN_INVALID`；
  - 检查与新建在同一事务内完成，并有「同一人至多一条进行中会话」唯一索引兜底：
    **并发/重复开始绝不多建会话、不多扣次数**。
- **演练推进**：`POST /api/tasks/:id/move` `{token, optionId, stepNo}`
  - 只能推进本人**进行中**的那次尝试（无进行中尝试 `409 TASK_NO_ACTIVE_ATTEMPT`）；
  - 选项条件、步号（`STEP_STALE`）、计分规则与普通单人演练完全一致，响应同单人 `/move`（含 `lastMove`）。
- **权限边界**：任务会话（`taskId` 非空）**不出现在** `GET /api/sessions` 普通列表；
  普通会话入口对任务会话一律要求本人凭证——`GET /api/sessions/:code`（`?token=`）、
  `POST /api/sessions/:code/move`（请求体 `token`）无凭证/错凭证 `401 TASK_TOKEN_INVALID`；
  任务会话**不得复盘分叉**（`409 TASK_SESSION_FORK_FORBIDDEN`），家族对照同样须凭证。
- **成绩报告**：`GET /api/tasks/:id/manage?token=管理凭证`
  - 逐人返回：参与凭证（便于补发）、已用/剩余次数、当前进行中次数、**每次尝试记录**
    （状态/步数/总分/起止时间）、**最高已结束总分 `bestScore`** 与**是否及格 `passed`**；
  - **无已结束尝试时成绩为空**：`bestScore=null`、`passed=null`；进行中的尝试不计入及格判定。

```bash
# 0) 培训师建立任务（deadline 为 epoch 毫秒或 ISO 串；须晚于当前时间）
curl -s -X POST localhost:8080/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"scenarioId":"sc_14f5505a2f47a3a3","version":1,
       "deadline":1791200000000,"maxAttempts":2,"passScore":5,
       "trainees":["张三","李四"]}'
# 201 -> { "ok":true, "taskId":"a1b2c3d4e5",
#          "adminToken":"adm_9f8e…",                 # 管理凭证，妥善保存
#          "version":1, "deadlineMs":1791200000000, "expired":false,
#          "maxAttempts":2, "passScore":5,
#          "trainees":[ {"name":"张三","token":"ptk_111…"},
#                       {"name":"李四","token":"ptk_222…"} ] }

# 非法配置整次拒绝（不写库），例如截止时间早于当前：
# 400 { "error":"截止时间必须晚于当前时间…", "errorCode":"TASK_DEADLINE_INVALID" }
# 姓名重复：400 TASK_TRAINEE_DUPLICATE；次数非正整数：400 TASK_MAX_ATTEMPTS_INVALID

# 1) 学员凭「任务编号 + 本人参与凭证」开始（第一次消耗 1 次）
curl -s -X POST localhost:8080/api/tasks/a1b2c3d4e5/start \
  -H 'Content-Type: application/json' -d '{"token":"ptk_111…"}'
# 201 -> { "ok":true, "resumed":false, "attemptNo":1, "attemptsUsed":1, "attemptsLeft":1,
#          "task":{…}, "session":{ "code":"ff00ee…", "taskId":"a1b2c3d4e5", "stepNo":0, … } }

# 2) 有未结束尝试时重复开始：返回原会话，不新建、不扣次数
curl -s -X POST localhost:8080/api/tasks/a1b2c3d4e5/start \
  -H 'Content-Type: application/json' -d '{"token":"ptk_111…"}'
# 200 -> { "ok":true, "resumed":true, "attemptNo":1, "attemptsUsed":1,
#          "session":{ "code":"ff00ee…", … } }        # 同一条会话

# 3) 在推进中执行一步（步号/条件/计分规则与普通演练一致）
curl -s -X POST localhost:8080/api/tasks/a1b2c3d4e5/move \
  -H 'Content-Type: application/json' \
  -d '{"token":"ptk_111…","optionId":"o_cut_power","stepNo":0}'
# -> { "ok":true, "stepNo":1, "totalScore":3,
#      "lastMove":{"step":1,"optionId":"o_cut_power","score":3,"totalScore":3,…}, … }

# 4) 学员查看自己的尝试记录与进行中的会话
curl -s 'localhost:8080/api/tasks/a1b2c3d4e5/my?token=ptk_111…'
# -> { "ok":true, "attemptsUsed":1, "attemptsLeft":1,
#      "attempts":[ {"attemptNo":1,"status":"active","stepNo":1,"totalScore":3,…} ],
#      "active":{ …会话快照… } }

# 5) 本次尝试结束后再开始 → 消耗下一次；次数耗尽 / 已过截止：
# 409 { "errorCode":"TASK_ATTEMPTS_EXHAUSTED", … }   （你的 2 次尝试次数已用完）
# 409 { "errorCode":"TASK_DEADLINE_PASSED",  … }     （截止后不能开新尝试，可续做旧会话）

# 6) 培训师凭管理凭证查看成绩
curl -s 'localhost:8080/api/tasks/a1b2c3d4e5/manage?token=adm_9f8e…'
# -> { "ok":true, "task":{…},
#      "summary":{"traineeCount":2,"startedCount":2,"passedCount":1,"attemptsTotal":3},
#      "trainees":[
#        { "name":"张三", "token":"ptk_111…", "attemptsUsed":2, "attemptsLeft":0,
#          "activeAttemptNo":null, "bestScore":10, "passed":true,
#          "attempts":[ {"attemptNo":1,"status":"ended","stepNo":4,"totalScore":10,…},
#                       {"attemptNo":2,"status":"ended","stepNo":1,"totalScore":-10,…} ] },
#        { "name":"李四", "token":"ptk_222…", "attemptsUsed":0, "attemptsLeft":2,
#          "activeAttemptNo":null, "bestScore":null, "passed":null,   # 无已结束尝试→成绩为空
#          "attempts":[] } ] }

# 7) 权限边界：任务会话在普通入口一律需本人凭证
curl -s localhost:8080/api/sessions/ff00ee…
# 401 { "errorCode":"TASK_TOKEN_INVALID", "error":"该会话属于训练任务，只能凭本人参与凭证查看…" }
curl -s 'localhost:8080/api/sessions/ff00ee…?token=ptk_111…'   # 本人凭证可查（200）
curl -s -X POST localhost:8080/api/sessions/ff00ee…/fork \
  -H 'Content-Type: application/json' -d '{"forkStepNo":0,"observedStepNo":1}'
# 409 { "errorCode":"TASK_SESSION_FORK_FORBIDDEN", … }           # 计次尝试不得分叉
```

错误码一览（除注明外均为 `409`；配置类为 `400`，凭证类为 `401`）：

| 情况 | errorCode |
| --- | --- |
| 截止时间非法/未晚于当前（建任务，`400`） | `TASK_DEADLINE_INVALID` |
| 每人最多尝试次数非正整数（`400`） | `TASK_MAX_ATTEMPTS_INVALID` |
| 及格分非整数（`400`） | `TASK_PASS_SCORE_INVALID` |
| 名单为空/含空姓名或超长（`400`） | `TASK_TRAINEES_INVALID` |
| 名单姓名重复（`400`） | `TASK_TRAINEE_DUPLICATE` |
| 任务不存在（`404`） | `TASK_NOT_FOUND` |
| 参与凭证无效（`401`） | `TASK_TOKEN_INVALID` |
| 管理凭证无效（`401`） | `TASK_ADMIN_TOKEN_INVALID` |
| 次数耗尽 | `TASK_ATTEMPTS_EXHAUSTED` |
| 截止后开新尝试（续做旧会话不受限） | `TASK_DEADLINE_PASSED` |
| 无进行中尝试时推进 | `TASK_NO_ACTIVE_ATTEMPT` |
| 任务会话走普通入口无凭证（`401`） | `TASK_TOKEN_INVALID` |
| 任务会话尝试复盘分叉 | `TASK_SESSION_FORK_FORBIDDEN` |

兼容说明：

- **既有普通演练用法完全不变**：`POST /api/sessions` 开始的普通会话无需任何凭证，照常出现在
  `GET /api/sessions` 列表、照常推进与分叉；变化仅两点——列表不再包含任务会话（任务会话只能经
  任务入口凭凭证访问），以及普通入口对任务会话强制验凭证（普通会话 `task_id` 为 NULL，不受影响）；
- 会话快照新增 `taskId` / `attemptNo`（非任务会话为 `null`），为纯增量字段；
- 老库自动建表（`tasks` / `task_trainees`）与加列迁移（`sessions.task_id` / `task_trainee_id` /
  `attempt_no`），并创建「同一人至多一条进行中尝试」的唯一部分索引。

---

## 七、目录结构

```
.
├── Dockerfile
├── docker-compose.yml
├── package.json / package-lock.json
├── server/
│   ├── server.js      # Express 路由（编排 / 发布 / 会话 / 复盘分叉 / 处置覆盖报告 / 共识演练房间 / 训练任务接口），限时房到期补办调度；普通会话入口对任务会话强制验凭证
│   ├── db.js          # SQLite 连接、建表（含老库加列迁移：rooms.step_duration / rooms.blind_vote / room_steps / room_settlements.kind / sessions.task_* 与任务表）、id 生成
│   ├── scenario.js    # 草稿校验 + 状态空间可达性/死路/循环分析
│   ├── session.js     # 会话快照、“带步号的一步”推进（房间会话拒绝单人入口、任务会话须本人凭证）、forkSession 分叉、loadLineage 对照树
│   ├── room.js        # 共识演练房间：开启（可选限时/盲投）/加入/投票改票/主持结算/到点自动结算/零票暂停与重开/到期补办 sweep/盲投脱敏房间快照
│   ├── task.js        # 训练任务：建任务（整次校验）/开始或续做（原会话返回、计次、截止控制）/任务内推进/学员视角/管理成绩报告
│   ├── coverage.js    # 处置覆盖报告：覆盖项枚举 + 按家族去重的已完成路径回放（损坏整体报错）
│   └── seed.js        # 内置示例情境（首启写入）
├── scripts/
│   ├── test-timed-room.js  # 限时房间端到端验证（临时库：开房校验/提前结算/到点自动结算/零票重开/旧用法兼容/防重复推进）
│   ├── test-blind-room.js  # 盲投房间端到端验证（临时库：blind 布尔校验不建房/结算前三视图脱敏/学员 myVote/主持成员名单/结算公布票数无姓名/盲投×限时暂停重开/公开房兼容）
│   └── test-task.js        # 训练任务端到端验证（临时库+真实 HTTP：非法配置整次拒绝/开始续做计次/截止控制/权限边界/并发不重复建会话/管理成绩/冻结版本与旧用法兼容）
├── public/
│   ├── index.html     # 单页界面（学员演练 / 共识演练 / 训练任务 / 培训师编排四个页签，编排内含处置覆盖报告视图）
│   ├── styles.css
│   └── app.js         # 含复盘分叉面板、来源/分支对照树、处置覆盖报告视图、共识演练房间视图（投票/主持台/限时倒计时/重开/盲投阶段提示与脱敏/轮询）与训练任务视图（建任务/参与/管理成绩）
└── data/              # 运行后生成：SQLite 数据库（持久化卷）
```

