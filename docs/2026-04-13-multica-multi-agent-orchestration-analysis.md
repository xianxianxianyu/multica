# Multica 的多 Agent 编排是怎么跑起来的

副标题：从概念映射、Agent 视角、Task 全周期三个层面拆解这套系统

## Plan

这篇分析按三个问题展开：

1. 从 `RAG`、`agent loop`、`skills`、`MCP` 四个通用概念出发，映射 Multica 里分别对应哪些模块、调用点和运行机制。
2. 以 agent 为主角，分析 `Agents as Teammates`、`Unified Runtimes`、`Multi-Workspace` 如何在一个统一框架下协同工作，以及 `harness engineering` 和 `context engineering` 在哪里落地。
3. 沿着一次真实执行链路，从 prompt 进入 agent 开始，一直跟到任务排队、认领、执行、消息流、完成/失败、状态收敛，解释完整的任务生命周期管理。

下面进入正文。

---

## 先给结论：Multica 本质上不是“在后端里写了一个 Agent”

如果只看 README，很容易把 Multica 理解成一个“有多个 agent 的任务管理工具”。但从代码实现看，它更准确的定位其实是：

**一个面向 coding agent 的控制平面（control plane）+ 执行编排层（orchestration layer）+ 本地运行时 harness。**

这里最重要的一点是：真正“思考”和“动手”的，不是 Go 后端本身，而是被 daemon 拉起的 Claude Code、Codex、OpenCode、OpenClaw 这些外部 agent CLI。Multica 做的事情，是把这些原本散落在终端里的 agent 行为，纳入一个有身份、有权限、有队列、有上下文、有状态同步的系统里。

所以这套架构的核心不是“自己发明一个 Agent 框架”，而是：

- 服务端维护任务状态机、工作区隔离、权限、事件流和可观测性。
- daemon 负责运行时发现、任务认领、执行环境准备、provider 适配、消息回传。
- 外部 agent CLI 负责真正的推理与工具调用。
- 前端把这些状态实时投影成团队协作界面。

换句话说，Multica 做的是 **managed agents infrastructure**，而不是 “LLM inside app server”。

---

## 一、从 RAG、agent loop、skills、MCP 的角度看，这个项目是怎么运行的

### 1. RAG：它不是经典向量检索，而是“运行时按需取数”

先说一个很关键的判断：**Multica 当前并没有把经典意义上的 embedding-based RAG 做成主干能力。**

仓库里虽然写了 PostgreSQL + pgvector，但在任务执行主链路上，你几乎看不到“先把 issue/comment/repo context 做 embedding，再向量召回后拼 prompt”这种路径。相反，这个系统在最近的实现上，明显在往另一种方向收敛：

**不做大上下文快照，而是让 agent 在运行时通过 `multica` CLI 主动拉取最新上下文。**

证据很直接：

- `server/internal/service/task.go` 里 `EnqueueTaskForIssue` 的注释明确写着：**不再存 context snapshot，agent 在运行时自己通过 multica CLI 拉数据**。
- `server/internal/daemon/prompt.go` 里的 prompt 极短，只告诉 agent “你的 issue ID 是什么，先跑 `multica issue get ... --output json`”。
- `server/internal/daemon/execenv/runtime_config.go` 会把一整套 runtime meta instructions 写进 `CLAUDE.md` 或 `AGENTS.md`，明确告诉 agent 应该用哪些 CLI 命令读取 issue、comments、workspace、members、repos、历史 run、attachments。
- `server/internal/daemon/execenv/context.go` 生成的 `issue_context.md` 也只是 lightweight assignment info，而不是完整上下文快照。

这意味着 Multica 的“RAG”更像：

- retrieval 不是查向量库，而是查平台 API/CLI；
- augmentation 不是一次性塞进 prompt，而是通过工具调用逐步补全；
- grounding 依赖的是平台里的结构化状态，而不是 prompt 预拼装。

我会把它称为 **tool-based RAG** 或 **just-in-time retrieval**。它的优点很明显：

- 上下文总是最新的，不容易出现“队列里排了 10 分钟，prompt 里还是旧状态”的问题。
- 不需要在 enqueue 时复制大量 issue/comment 数据。
- 同一套 agent loop 可以同时服务 issue task 和 chat task。
- workspace、member、repo、history 等信息天然保持结构化，而不是坍缩成一大段 prompt 文本。

但它也有代价：

- 依赖 agent 是否遵守 harness 规定，真的去调用 `multica` CLI。
- 上下文获取从“预计算”变成了“执行期工具调用”，延迟更敏感。
- 当前没有看到显式的语义检索/召回层，所以对海量知识库场景并不是典型 RAG 系统。

换句话说，**Multica 不是把 RAG 做成了知识检索系统，而是把 RAG 做成了任务执行时的结构化上下文访问模式。**

### 2. Agent Loop：真正的 loop 在 provider CLI 里，Multica 包了一层编排 loop

Multica 的 agent loop 分成两层：

第一层是 **平台级 loop**：

- issue/comment/chat 触发任务入队；
- daemon 轮询 runtime；
- server 按规则 claim task；
- daemon 启动 provider backend；
- provider 流式吐出文本、thinking、tool events；
- daemon 回传消息、usage、最终结果；
- server 完成状态转换并广播事件。

第二层是 **provider-native loop**：

- Claude Code 自己的回合循环；
- Codex `app-server --listen stdio://` 里的 thread/turn loop；
- OpenCode/OpenClaw 的事件流循环。

这也是为什么 `server/pkg/agent/agent.go` 会定义一个非常薄的统一接口：

- `Backend.Execute(ctx, prompt, opts) -> Session`
- `Session.Messages`
- `Session.Result`

它没有试图统一 provider 的内部推理机制，而是统一了 **运行时协议**：

- 文本消息怎么流出来；
- tool use / tool result 怎么规范化；
- 最终结果、session ID、usage 怎么收口。

然后在 `server/internal/daemon/daemon.go` 里，daemon 把这些 provider-native 事件再接进自己的平台 loop。

这是一种很典型的 orchestrator 设计：**不重写 agent loop，只包裹 agent loop。**

### 3. Skills：不是 prompt 片段，而是工作区级、可装配、可分发的能力单元

Skills 是 Multica 里非常“系统化”的一层。

它不是简单给 agent 填一个 `skills: ["review", "deploy"]` 字段，而是完整拆成了三层数据模型：

- `skill`：工作区内的技能实体；
- `skill_file`：技能的附属文件；
- `agent_skill`：agent 和 skill 的多对多关联。

也就是说，一个 skill 不只是名字和描述，它可以带：

- 主体 `SKILL.md`
- supporting files
- 模板、示例、规则文件等辅助内容

当 task 被 claim 时：

1. `server/internal/handler/daemon.go` 会把 agent 的 `instructions` 和 skills 一起塞进 task claim response。
2. `server/internal/service/task.go` 的 `LoadAgentSkills` 会把技能正文和附属文件全部从数据库取出来。
3. `server/internal/daemon/execenv/context.go` / `execenv.go` 会把这些 skill 写入 provider-native 的发现路径：
   - Claude: `.claude/skills/...`
   - Codex: `CODEX_HOME/skills/...`
   - OpenCode: `.config/opencode/skills/...`
   - 其他 provider: `.agent_context/skills/...`

这个设计很重要，因为它说明 Multica 把 skill 定义成了 **可部署上下文包**，而不是“临时拼到 prompt 里的几行文本”。

这件事和下文会讲到的 harness engineering 直接相关：它把“能力复用”从提示词技巧提升到了运行时装配层。

### 4. MCP：这里更像“兼容和利用 provider 原生能力”，而不是自建 MCP 编排中台

如果你是带着 MCP 这个词进来看 Multica，很容易产生一个误判：觉得它会有一套显式的 MCP server registry、tool broker、跨 provider MCP routing。

**当前代码里看不到这样一套一等公民的 MCP 中台。**

更准确地说，Multica 对 MCP 的态度是：

- 尽量适配并利用 provider CLI 的原生 tool / protocol 能力；
- 在必要处保证 provider 运行在受控环境里；
- 但不把“项目级 MCP 编排器”做成主架构核心。

两个很有代表性的信号：

- Claude backend 启动参数里有 `--strict-mcp-config`，说明它愿意依托 Claude 原生的 MCP/tool 机制运行。
- Codex backend 走的是 `codex app-server --listen stdio://` 的 JSON-RPC 会话模型，本质上是 provider 自己的执行协议，而不是 Multica 自己定义的 MCP 层。

所以如果一定要从 MCP 视角去理解，可以说：

- **provider 内部**：MCP/tool calling 是 agent CLI 的原生能力。
- **Multica 外部**：它通过 execenv、环境变量、repo checkout、本地 daemon HTTP endpoint、`multica` CLI，把一组平台能力暴露成 agent 可消费的工具表面。

这是一种更偏 harness 的思路，而不是“把 MCP 做成统一控制总线”。

换句话说，**MCP 在 Multica 里目前更像运行时能力边界，而不是系统的中心抽象。**

---

## 二、以 Agent 为主角：Agents as Teammates、Unified Runtimes、Multi-Workspace 是怎么在一个大框架里协同运行的

### 1. Agents as Teammates：Agent 在这个系统里不是“模型配置”，而是“协作者对象”

Multica 最有意思的地方，是它把 agent 建模成了团队协作里的正式 actor。

你看数据模型和事件流就会发现：

- issue 的 assignee 是多态的，可以是 member，也可以是 agent；
- comment 的 author 也可以是 agent；
- WebSocket 事件里有 `actor_type` / `actor_id`；
- chat session 直接绑定 agent；
- agent 自己有 `instructions`、`skills`、`visibility`、`status`、`max_concurrent_tasks`、`runtime_id`。

这意味着在系统视角里，agent 不是“某条自动化规则”，而是：

- 有身份；
- 有能力；
- 有权限边界；
- 有工作状态；
- 有运行位置；
- 能被指派任务；
- 能在任务流里发声。

这就是 README 里 “Agents as Teammates” 背后的真正实现含义。

### 2. Unified Runtimes：把不同 provider 和不同机器统一到一个 runtime 抽象下面

`Unified Runtimes` 的关键不在 UI，而在数据和执行边界的解耦。

Multica 没有把 agent 直接绑死在 “Claude/Codex/OpenCode” 上，而是中间插入了 `agent_runtime` 这一层：

- runtime 属于某个 workspace；
- runtime 有 `provider`、`runtime_mode`、`status`、`daemon_id`、`owner_id`、`metadata`；
- agent 只引用 `runtime_id`；
- task queue 也冗余存了 `runtime_id`，这样 daemon 可以按 runtime 维度 claim。

这样一来，系统内部其实完成了两层解耦：

1. **agent 身份** 和 **实际执行环境** 解耦；
2. **provider 差异** 和 **平台任务状态机** 解耦。

daemon 启动时会自动探测本机有哪些 agent CLI，可用的就注册成 runtime。对 server 来说，这些 runtime 只是：

- 归属哪个 workspace；
- 对应哪个 provider；
- 在线还是离线；
- 最近心跳如何；
- usage/activity/ping/update 状态如何。

而对执行面来说，真正的 provider 差异被压进了 `server/pkg/agent/*` 这组 backend adapter 里。

这就是为什么 Multica 能同时支持 Claude、Codex、OpenCode、OpenClaw，但主业务层并没有被 provider-specific 分支污染。

### 3. Multi-Workspace：它不是前端切换器，而是从权限、连接、缓存到执行目录的全链路隔离

`Multi-Workspace` 在这个项目里做得非常彻底。

隔离体现在至少五个层面：

1. **HTTP 权限隔离**
   - 所有 workspace-scoped API 都走 `X-Workspace-ID` 或 URL 参数，再由 middleware 校验 membership。

2. **WebSocket 房间隔离**
   - realtime hub 按 `workspace_id` 建 room，只给该 workspace 的成员广播事件。

3. **运行时注册隔离**
   - daemon 会为每个 watched workspace 注册各自的 runtimes。

4. **repo cache 隔离**
   - bare clone cache 目录是按 `workspaceID` 分层管理的。

5. **执行环境隔离**
   - task env 根目录也是 `{WorkspacesRoot}/{workspaceID}/{taskShortID}` 这样的结构。

再加上 CLI profile 机制，不同 profile 甚至还能把 daemon 状态、health port、workspace root 都再隔离一层。

所以这里的 Multi-Workspace 不是“页面上能切 workspace”，而是 **控制面、事件面、执行面、文件系统面都按 workspace 划边界**。

### 4. 模块、通信、边界：这套系统为什么没有乱

如果把整个系统压成一张图，大概是这样：

- Browser
  - REST 调用 server
  - WebSocket 订阅 workspace room
- Go server
  - handlers 处理 issue/comment/agent/chat/runtime/skill/workspace
  - TaskService 维护任务状态机
  - Bus 发布域事件
  - Realtime Hub 把事件广播给正确 workspace
- Daemon
  - 向 server 注册 runtime、发 heartbeat、claim task、回报结果
  - 拉起 provider CLI
  - 准备执行环境
  - 提供本地 `/repo/checkout` 能力给 agent CLI 调用
- Agent CLI
  - 在准备好的 workdir 内运行
  - 通过 `multica` CLI 获取上下文、更新 issue、发评论、checkout repo

有意思的是，agent 并不直接调用 daemon 的内部函数，而是通过两层“工具表面”与系统交互：

- 调平台资源：`multica` CLI -> server API
- 调本地 repo checkout：`multica repo checkout` -> daemon local health server

这是一种非常工程化的解耦方式：**agent 永远只面对工具，不面对系统内部对象。**

### 5. Harness Engineering：Multica 真正厉害的地方在 harness，而不在 prompt

如果把这套系统最核心的工程思想浓缩成一句话，那就是：

**它不是在堆 prompt，而是在搭 execution harness。**

具体体现在：

- daemon 会准备隔离执行目录；
- 会注入 provider 对应的 `CLAUDE.md` 或 `AGENTS.md`；
- 会把技能写入 provider-native 发现路径；
- 会把 `MULTICA_TOKEN`、`MULTICA_WORKSPACE_ID`、`MULTICA_AGENT_ID`、`MULTICA_TASK_ID`、`MULTICA_DAEMON_PORT` 等环境变量注入进去；
- 会为 Codex 生成 per-task `CODEX_HOME`，既继承全局 auth/session，又保证 task 级隔离；
- 会把 `multica` CLI 所需的 PATH 补进去；
- 会通过 local daemon HTTP endpoint 暴露 repo checkout 能力；
- 会统一采集文本、thinking、tool use、tool result、usage、session ID。

这些东西加起来，才是 agent 能稳定作为“队友”工作的前提。

换句话说，Multica 的创新点不在于“让模型更聪明”，而在于 **让现成 agent 更可控、更可编排、更可协作。**

### 6. Context Engineering：少往 prompt 塞，更多把上下文做成可导航环境

和很多 agent 系统喜欢“大 prompt 一把梭”不同，Multica 的 context engineering 很克制。

它做了三件事：

1. **把 prompt 压到极短**
   - prompt 只负责告诉 agent “你是谁、任务 ID 是什么、先去哪拿上下文”。

2. **把上下文外置到环境**
   - `issue_context.md`
   - `CLAUDE.md` / `AGENTS.md`
   - provider-native skills 目录
   - workspace repo 列表
   - CLI 命令约定

3. **把历史连续性存进 session/workdir**
   - issue task 用 `(agent, issue)` 维度复用 `session_id` 和 `work_dir`
   - chat task 直接把 `session_id` / `work_dir` 存在 `chat_session`

所以它的上下文策略不是“把所有东西一次性喂给模型”，而是：

**先给最小引导，再给可查询环境，再让 session 延续记忆。**

这就是一个很典型的 “context-by-reference, not context-by-copy” 的系统。

顺带一提，这里也能看到一个很真实的工程取舍：workspace 有 `context` 字段，前端也能编辑，但在当前任务执行主链路里，它并没有像 issue/chat/session/skills 那样被强注入进 agent runtime。这说明这个系统在 context engineering 上更重视“执行期可获取的结构化事实”，而不是“平台预写的背景叙述”。

---

## 三、从 prompt 进去之后，agent 架构怎么运行？完整的任务生命周期又是怎么跑的？

这一部分我们直接顺着一次任务的真实链路走。

### 阶段 1：任务被触发

任务入口主要有三类：

- **issue assignment**
  - 新建 issue 或修改 assignee 时，如果 assignee 是一个 ready 的 agent，就 enqueue。
- **comment trigger**
  - 成员评论 issue 时，系统会根据 thread、mention、assignee 等规则决定是否为当前 assignee 再排一个 task。
- **chat trigger**
  - 用户给 agent 发 chat message 时，先写入 `chat_message`，再 enqueue 一个 chat task。

这里有几个很关键的设计：

- 对 issue comment trigger，会避免 agent 自己回复自己形成死循环。
- 对 @mention，会给被 mention 的 agent 单独排队，而不是只依赖 assignee。
- 对 pending task，有 coalescing/dedup 约束，避免同一个 issue/agent 被快速刷爆。

所以从一开始，Multica 就不是“有变化就无脑起新任务”，而是先做一层任务门控。

### 阶段 2：任务进入 server 侧状态机

任务在数据库里会经历：

- `queued`
- `dispatched`
- `running`
- `completed` / `failed` / `cancelled`

这些状态的推进主要由 `TaskService` 和 SQL 层共同保证：

- enqueue 时写入 `agent_task_queue`
- claim 时原子更新到 `dispatched`
- start 时更新到 `running`
- complete/fail/cancel 时进入终态

这里最值得注意的是 claim 逻辑：

- 它不是简单取最早一条；
- 会检查 agent 当前运行数，不超过 `max_concurrent_tasks`；
- 会对同一 `(agent, issue)` 做串行化；
- chat task 则按 `chat_session_id` 串行化。

这说明 Multica 的任务队列不是“全局先进先出”，而是 **带 agent 并发约束和 target-level serialization 的工作队列**。

### 阶段 3：daemon 认领任务

daemon 的 `pollLoop` 会不断扫描当前已注册 runtime：

1. 看自己还有没有并发槽位。
2. 调 server 的 claim API 去认领任务。
3. 一旦认领成功，异步起一个 goroutine 处理这个 task。

server 在 claim response 里，不只是返回 task 基础信息，还会把执行真正需要的动态上下文一起打包回来：

- agent name
- agent instructions
- structured skills
- workspace repos
- prior session ID
- prior workdir
- trigger comment ID
- chat message

这一步很关键，因为它定义了 server 和 daemon 的责任边界：

- server 是 authoritative state source；
- daemon 是 execution orchestrator；
- daemon 不自己拼业务上下文，而是从 server claim response 获取经过权限控制后的执行材料。

### 阶段 4：daemon 准备 execution environment

daemon 拿到 task 后，会做四件事情：

1. 标记 task `start`
2. 建立 cancellation watcher
3. 准备/复用 workdir
4. 注入 runtime config 和环境变量

这里最有意思的是 workdir 策略：

- 如果同一个 `(agent, issue)` 之前有 `PriorWorkDir`，就优先复用；
- 否则新建 `{workspacesRoot}/{workspaceID}/{taskShortID}/workdir`；
- 对 chat task，则复用 `chat_session` 持有的 `session_id` / `work_dir`。

然后 daemon 会写入：

- `.agent_context/issue_context.md`
- `CLAUDE.md` 或 `AGENTS.md`
- skills 目录
- Codex 的 per-task `CODEX_HOME`

也会注入：

- `MULTICA_TOKEN`
- `MULTICA_SERVER_URL`
- `MULTICA_DAEMON_PORT`
- `MULTICA_WORKSPACE_ID`
- `MULTICA_AGENT_NAME`
- `MULTICA_AGENT_ID`
- `MULTICA_TASK_ID`

到这一步，agent 其实已经不只是拿到一个 prompt，而是进入了一个 **带规则、带工具、带身份、带访问令牌、带 repo checkout 能力的执行沙箱**。

### 阶段 5：prompt 进入 provider backend

真正送进 agent CLI 的 prompt 反而非常短：

- issue task：告诉它 issue ID，并要求先跑 `multica issue get ... --output json`
- chat task：把 user message 直接放进去

这一步之后，provider backend 接管：

- Claude backend 用 `claude -p --output-format stream-json ...`
- Codex backend 用 `codex app-server --listen stdio://`，通过 JSON-RPC 跑 `initialize -> thread/start -> turn/start`
- OpenCode/OpenClaw 各自解析自己的 JSON event stream

虽然 provider 各不相同，但 daemon 只看到统一的 `Session.Messages` 和 `Session.Result`。

这就是这套架构最漂亮的地方之一：

**prompt 进入的是 provider-native agent loop，但 provider 的差异在 daemon 看来已经被 Backend interface 抹平了。**

### 阶段 6：执行中的消息流与可观测性

agent 运行时，daemon 会持续读取 message stream，并把它们重新组织成平台可消费的执行轨迹：

- `text`
- `thinking`
- `tool_use`
- `tool_result`
- `error`

它会做几件实用的工程处理：

- 文本/thinking 批量聚合后再发送，避免刷爆网络和数据库；
- tool result 输出截断，避免超长 payload；
- callID 和 tool name 做映射，保证 tool_result 能正确回填 tool 名称；
- 把这些消息既写入 `task_message`，又通过 WS 事件 `task:message` 广播给前端。

这就是为什么前端可以做出实时的 agent live card / transcript，而不只是“任务完成后看一段结果文本”。

同时，daemon 还会：

- 独立上报 task usage；
- 周期性扫描 runtime usage；
- 对 runtime 做 heartbeat；
- 支持 runtime ping / CLI update；
- 在 server 侧由 sweeper 清理 stale runtimes 和 stale tasks。

所以这套系统的任务生命周期不是只有“开始和结束”，中间还有一条完整的 observability 管道。

### 阶段 7：任务完成、失败或取消

当 provider backend 返回结果后，daemon 会把结果收敛成三类：

- `completed`
- `blocked`
- `timeout/failed/aborted`

接着：

- `completed` -> 调 complete API
- `blocked` -> 视为 fail，并把阻塞说明回传
- 中途发现 task 已被 server 取消 -> 直接丢弃结果，不再上报

server 侧在 complete/fail 时又会做一层业务收尾：

- 保存最终 result
- 保存 `session_id` 和 `work_dir`
- issue task 在适当条件下自动生成 agent comment
- chat task 生成 assistant message，并更新 `chat_session`
- broadcast `task:completed` / `task:failed` / `chat:done`
- reconcile agent status

所以“任务完成”在 Multica 里不是单点动作，而是：

**provider 返回结果 -> daemon 归一化 -> server 落库 -> 协作对象更新 -> WebSocket 广播 -> 前端状态同步**

### 阶段 8：异常恢复和生命周期兜底

一个成熟的多 agent 编排系统，不能只考虑 happy path。Multica 在这方面做了两个重要兜底：

1. **runtime sweeper**
   - heartbeat 超时的 runtime 会被标记 offline；
   - 属于这些 runtime 的 orphaned tasks 会被 fail。

2. **task sweeper**
   - `dispatched` 太久没转 `running` 的 task 会被清理；
   - `running` 太久没结束的 task 也会被 fail。

这说明它已经从“能跑”走到“能收敛”：

- daemon 崩了怎么办？
- runtime 掉线怎么办？
- provider 卡死怎么办？
- server 重启后遗留半截状态怎么办？

这些都不是靠人工运维，而是靠状态机和 sweeper 自动回收。

---

## 最后的整体判断

如果把 Multica 放到多 agent 系统的谱系里，我会这样定义它：

它不是一个强调“模型内部智能增强”的框架，而是一个强调 **外部编排、执行 harness、上下文装配、协作可观测性** 的系统。

它最强的地方不是：

- 自己发明了新的推理范式；
- 做了最复杂的 planner；
- 做了最重的 RAG。

它最强的地方是：

- 把 agent 变成了团队里的正式 actor；
- 把不同 provider 统一成了可管理 runtime；
- 把 task 做成了有状态机、有消息流、有恢复机制的完整生命周期对象；
- 把 context engineering 从“写 prompt”升级成了“准备环境”；
- 把 harness engineering 做成了系统主干。

所以如果你对“多 agent 编排”感兴趣，Multica 最值得学的不是某个 prompt 技巧，而是这套分层：

- **server 管状态与权限**
- **daemon 管执行与环境**
- **provider CLI 管推理与工具调用**
- **frontend 管观测与协作投影**

这四层拼起来，agent 才真的从终端里的单机助手，变成了团队系统里的可调度、可观测、可协作的 teammate。

---

## 附：我认为最值得顺着读的代码入口

如果你准备继续深挖，我建议按下面顺序读：

1. `server/internal/service/task.go`
   - 先理解状态机和任务收尾逻辑。
2. `server/internal/handler/daemon.go`
   - 再看 daemon 和 server 怎么交换 claim/start/complete/fail。
3. `server/internal/daemon/daemon.go`
   - 然后看真正的执行编排主循环。
4. `server/internal/daemon/execenv/*`
   - 理解 harness 和 context injection。
5. `server/pkg/agent/*`
   - 最后看 provider 适配层如何把 Claude/Codex/OpenCode/OpenClaw 统一起来。

这样读，会最容易抓到这套系统真正的骨架。
