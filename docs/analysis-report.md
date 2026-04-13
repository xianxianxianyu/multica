# Multica 平台架构深度分析报告

> 分析视角：Harness Engineering · Context Engineering · 业务可运营性
> 颗粒度：框架图 → Pipeline 流程图 → UML 类/函数级

---

## 术语表

| 术语 | 定义 |
|---|---|
| **Harness（执行线束）** | Agent 从任务入队到结果回写的完整执行编排基础设施，包含任务队列、Daemon、ExecEnv、Agent Backend 四层 |
| **ExecEnv（执行环境）** | Daemon 为每个任务创建的隔离工作目录，内含上下文注入文件、Skill 文件、环境变量 |
| **Skill（技能）** | Agent 可用的知识模块，由 `SKILL.md` 主文件 + 支持文件组成，写入 Provider 原生路径 |
| **Runtime（运行时）** | Agent 的执行载体，`local` 模式由本地 Daemon 轮询领取任务，`cloud` 模式为云端执行 |
| **Meta Skill** | 写入 `CLAUDE.md` / `AGENTS.md` 的运行时配置文件，是 Agent 发现环境的入口 |
| **PAT（Personal Access Token）** | `mul_` 前缀的个人访问令牌，通过 SHA-256 hash 查找数据库记录认证 |
| **Event Bus** | 进程内同步事件总线（`events.Bus`），类型优先 + 全局 handler，单个 panic 不影响其他 |
| **WS Hub** | 按 workspace 分房间的 WebSocket 连接管理器，支持 `BroadcastToWorkspace`、`SendToUser`、`Broadcast` 三级分发 |
| **多态指派（Polymorphic Assignee）** | Issue 的 `assignee_type` + `assignee_id` 组合，可以是 `member` 或 `agent` |
| **Token Usage（令牌用量）** | 按 (runtime, date, provider, model) 维度记录的 input/output/cache token 消耗 |

---

# 第一部分：框架层 — 宏观架构

## 1.1 系统全局架构

```mermaid
graph TB
    subgraph "用户端"
        WEB["Web<br/>Next.js App Router"]
        DESK["Desktop<br/>Electron (electron-vite)"]
    end

    subgraph "共享包 (pnpm workspaces)"
        CORE["packages/core<br/>无 react-dom · 纯逻辑<br/>Zustand stores · API client · WS"]
        VIEWS["packages/views<br/>零 next/* · 零 react-router<br/>共享业务页面/组件"]
        UI["packages/ui<br/>零 @multica/core<br/>原子级 UI 组件 (shadcn)"]
    end

    subgraph "Go 后端"
        ROUTER["Chi Router<br/>30+ 路由组"]
        HANDLER["Handler Layer<br/>issue/comment/agent/skill/daemon/chat"]
        SVC["Service Layer<br/>TaskService"]
        MW["Middleware<br/>Auth (JWT+PAT) · Workspace (RBAC)"]
        BUS["Event Bus<br/>进程内同步 pub/sub"]
        HUB["WS Hub<br/>workspace 分房间"]
        DAEMON["Daemon<br/>HTTP 轮询领任务<br/>ExecEnv 隔离 · 5种 Agent Backend"]
    end

    subgraph "数据层"
        PG["PostgreSQL<br/>pgvector/pg17"]
        MIG["sqlc 生成<br/>类型安全查询"]
    end

    WEB --> VIEWS --> CORE --> ROUTER
    DESK --> VIEWS
    ROUTER --> MW --> HANDLER --> SVC
    HANDLER --> BUS --> HUB
    SVC --> PG
    DAEMON -->|"ClaimTask · ReportMessages · CompleteTask"| ROUTER
    HUB -->|"WS: 30+ event types"| WEB
    HUB --> DESK
```

> 上图展示了从用户端到数据层的完整架构：前端通过共享包（core + views + ui）构建，后端 Go 服务通过 Chi 路由 + 中间件 + Handler + Service 四层处理请求，Daemon 作为独立的本地进程通过 HTTP 轮询与后端交互。Event Bus 解耦 Handler 和 WS 广播。

## 1.2 三条分析线索的定位

```mermaid
graph LR
    subgraph "线索一: Harness"
        H1["任务队列编排<br/>TaskService"]
        H2["Daemon 主循环<br/>Poll + Execute"]
        H3["Agent Backend<br/>统一接口"]
        H4["ExecEnv 隔离<br/>Prepare / Reuse"]
    end

    subgraph "线索二: Context"
        C1["四层注入<br/>Prompt → Meta → Issue → Skill"]
        C2["Skill 系统<br/>DB → Load → Write"]
        C3["消息流控制<br/>批量上报 · 截断 · 脱敏"]
    end

    subgraph "线索三: 业务"
        B1["多租户<br/>workspace_id 隔离"]
        B2["RBAC<br/>owner/admin/member"]
        B3["Token 分析<br/>5种图表 + 明细"]
        B4["多态指派<br/>member + agent"]
    end

    H1 --> H2 --> H3 --> H4
    C1 --> C2 --> C3
    B1 --> B2 --> B3
    B4 --> H1

    H4 -.->|"环境文件即上下文"| C1
    H3 -.->|"Backend 输出即消息"| C3
    C2 -.->|"Skill 关联需管理"| B2
```

> 三条线索的交汇点是 **Agent**：Harness 解决 Agent "怎么跑"，Context 解决 "跑什么信息"，业务管理解决 "跑得怎么样"。

---

# 第二部分：Pipeline 层 — 数据流转

## 2.1 [Harness] 任务完整生命周期

```mermaid
sequenceDiagram
    participant U as 用户 / Agent
    participant H as HTTP Handler
    participant TS as TaskService
    participant DB as PostgreSQL
    participant D as Daemon
    participant EE as ExecEnv
    participant AB as Agent Backend
    participant BUS as Event Bus
    participant WS as WS Hub

    rect rgb(230, 245, 255)
        Note over U,DB: 阶段1: 触发与入队
        U->>H: 操作 Issue (assign/@mention/chat)
        H->>DB: 保存 Issue/Comment
        H->>TS: EnqueueTaskForIssue / EnqueueTaskForMention / EnqueueChatTask
        TS->>DB: CreateAgentTask (status=queued)
        TS->>BUS: Publish(task:dispatch)
        BUS->>WS: BroadcastToWorkspace
    end

    rect rgb(255, 245, 230)
        Note over D,DB: 阶段2: 领取与环境准备
        D->>H: POST /claim (HTTP 轮询)
        H->>TS: ClaimTaskForRuntime(runtimeID)
        TS->>DB: ClaimAgentTask (queued→dispatched, max_concurrent检查)
        TS-->>H: task + agentID + issueID
        H->>DB: GetAgent + LoadAgentSkills + GetLastTaskSession
        H-->>D: Task{ID, Agent{Name,Instructions,Skills}, PriorSessionID, PriorWorkDir, Repos, ChatMessage}
        D->>EE: Prepare() 或 Reuse(priorWorkDir)
        EE->>EE: writeContextFiles() + InjectRuntimeConfig()
        EE-->>D: Environment{RootDir, WorkDir, CodexHome}
    end

    rect rgb(230, 255, 230)
        Note over D,AB: 阶段3: 执行
        D->>D: BuildPrompt(task)
        D->>AB: agent.New(provider) → backend.Execute(prompt, ExecOptions)
        AB-->>D: Session{Messages channel, Result channel}
        D->>H: ReportTaskMessages (500ms batch)
        H->>DB: CreateTaskMessage
        H->>BUS: Publish(task:message)
        BUS->>WS: BroadcastToWorkspace
    end

    rect rgb(255, 230, 245)
        Note over D,WS: 阶段4: 结果回写
        AB-->>D: Result{Status, Output, SessionID, Usage}
        D->>H: CompleteTask / FailTask
        H->>TS: CompleteTask(taskID, result, sessionID, workDir)
        TS->>DB: CompleteAgentTask (running→completed)
        TS->>DB: CreateComment (agent 输出 → Issue 评论, 仅分配触发)
        TS->>DB: CreateChatMessage (仅 chat 任务)
        TS->>DB: UpdateChatSession(sessionID, workDir)
        TS->>BUS: Publish(task:completed)
        BUS->>WS: BroadcastToWorkspace
    end
```

> 核心设计决策：
> - **入队时不存上下文快照**（`service/task.go:33-35` 注释），Agent 运行时通过 `multica` CLI 自主拉取最新数据
> - **并发控制**通过 `CountRunningTasks` vs `MaxConcurrentTasks` 实现（`service/task.go:177`）
> - **Session 恢复**通过 `GetLastTaskSession` 查询 (agent, issue) 对的上次 session，传递 `PriorSessionID` + `PriorWorkDir`

## 2.2 [Context] 四层上下文注入 Pipeline

```mermaid
flowchart TB
    subgraph "Layer 0: 环境变量 (操作系统级)"
        E0["MULTICA_TOKEN<br/>MULTICA_SERVER_URL<br/>MULTICA_DAEMON_PORT<br/>MULTICA_WORKSPACE_ID<br/>MULTICA_AGENT_NAME<br/>MULTICA_AGENT_ID<br/>MULTICA_TASK_ID<br/>PATH (注入 CLI 路径)<br/>CODEX_HOME (仅 Codex)"]
    end

    subgraph "Layer 1: Prompt Seed (stdin 级)"
        P1["BuildPrompt(task)<br/>daemon/prompt.go"]
        P1_ISSUE["Issue 任务:<br/>'Start by running multica issue get {id}'"]
        P1_CHAT["Chat 任务:<br/>'User message: {content}'"]
        P1 --> P1_ISSUE
        P1 --> P1_CHAT
    end

    subgraph "Layer 2: Meta Skill (Agent CLI 原生入口文件)"
        P2["InjectRuntimeConfig()<br/>execenv/runtime_config.go"]
        P2_CLAUDE["CLAUDE.md (Claude)"]
        P2_AGENTS["AGENTS.md (Codex/OpenCode/OpenClaw)"]
        P2 --> P2_CLAUDE
        P2 --> P2_AGENTS
        P2_CONTENT["内容组成:<br/>① Agent Identity (agent.instructions)<br/>② Available Commands (CLI 命令列表)<br/>③ Repositories (仓库 URL 表)<br/>④ Workflow (分配/评论/Chat 三种模式)<br/>⑤ Skills 列表<br/>⑥ Mentions 格式<br/>⑦ Attachments 用法"]
    end

    subgraph "Layer 3: Issue Context (文件级)"
        P3["writeContextFiles()<br/>execenv/context.go"]
        P3_FILE[".agent_context/issue_context.md<br/>Issue ID + Trigger Type + Quick Start"]
        P3 --> P3_FILE
    end

    subgraph "Layer 4: Skill Files (知识级)"
        P4["writeSkillFiles()<br/>execenv/context.go"]
        P4_CLAUDE["Claude: .claude/skills/{name}/SKILL.md"]
        P4_CODEX["Codex: {codexHome}/skills/{name}/SKILL.md"]
        P4_OPENCODE["OpenCode: .config/opencode/skills/{name}/SKILL.md"]
        P4_DEFAULT["Default: .agent_context/skills/{name}/SKILL.md"]
        P4 --> P4_CLAUDE
        P4 --> P4_CODEX
        P4 --> P4_OPENCODE
        P4 --> P4_DEFAULT
    end

    E0 --> P1 --> P2 --> P3 --> P4
```

> 上下文注入的层次从操作系统环境变量到知识文件逐层细化。Layer 2 的 Meta Skill 是最关键的一层——它是 Agent CLI 的原生入口文件（Claude 读 `CLAUDE.md`，Codex 读 `AGENTS.md`），决定了 Agent 如何"发现"自己能做什么。

## 2.3 [业务] 多租户请求隔离 Pipeline

```mermaid
sequenceDiagram
    participant Client as 前端 / Daemon
    participant Auth as Auth Middleware
    participant WS_MW as Workspace Middleware
    participant Handler as Handler
    participant DB as PostgreSQL

    Client->>Auth: HTTP Request + Bearer Token
    Auth->>Auth: 解析 JWT 或 PAT (mul_ 前缀)
    Auth->>Auth: 注入 X-User-ID header

    Auth->>WS_MW: 请求传递
    WS_MW->>WS_MW: resolveWorkspaceID()<br/>优先 query param, 其次 X-Workspace-ID header
    WS_MW->>DB: GetMemberByUserAndWorkspace(userID, workspaceID)
    DB-->>WS_MW: Member{Role, ...}

    alt 角色检查失败
        WS_MW-->>Client: 403 Forbidden
    end

    WS_MW->>WS_MW: SetMemberContext(ctx, wsID, member)
    WS_MW->>Handler: ctx 包含 workspaceID + member
    Handler->>DB: 所有查询自动带 workspace_id 过滤
```

> 多租户隔离的核心机制：每个请求通过中间件链 `Auth → Workspace` 注入 `workspaceID` 和 `member`，所有后续数据库查询通过 `workspace_id` 外键实现行级隔离。

## 2.4 [通信协议] WS 事件分发 Pipeline

```mermaid
flowchart LR
    subgraph "事件源"
        H["Handler 操作<br/>(CRUD Issue/Comment/etc.)"]
    end

    subgraph "Event Bus"
        BUS["Bus.Publish(Event)"]
        S1["SubscriberListener<br/>写入 issue_subscriber"]
        S2["ActivityListener<br/>写入 activity_log"]
        S3["NotificationListener<br/>创建 inbox_item"]
        S4["WSBroadcastListener<br/>序列化 JSON"]
    end

    subgraph "WS Hub"
        HUB["Hub.Run() event loop"]
        ROOM["rooms[workspaceID]<br/>map[*Client]bool"]
    end

    subgraph "前端"
        RS["useRealtimeSync()"]
        QC["TanStack Query Cache"]
    end

    H --> BUS
    BUS --> S1
    BUS --> S2
    BUS --> S3
    BUS --> S4
    S4 --> HUB --> ROOM --> RS --> QC
```

> Event Bus 是 Handler 和实时通信之间的解耦层。同一事件被 4 类 listener 并行处理：订阅管理、活动日志、通知分发、WS 广播。前端 `useRealtimeSync()` 接收 WS 事件后仅做 Query Cache 失效（不做直接数据写入），保证 TanStack Query 作为唯一的服务端状态源。

---

# 第三部分：模块层 — 组件职责与接口

## 3.1 [Harness] 核心类关系

```mermaid
classDiagram
    class Daemon {
        -cfg Config
        -client Client
        -repoCache Cache
        -workspaces map~string~workspaceState
        -runtimeIndex map~string~Runtime
        +New(cfg, logger) Daemon
        +Run(ctx) error
        -pollLoop(ctx)
        -runTask(ctx, task, provider, logger) TaskResult, error
        -handleResult(ctx, task, result)
        -loadWatchedWorkspaces(ctx) error
        -configWatchLoop(ctx)
        -handleUpdate(ctx)
    }

    class Client {
        +Token() string
        +ClaimTask(ctx, runtimeID) Task
        +StartTask(ctx, taskID) error
        +CompleteTask(ctx, taskID, result, sessionID, workDir) error
        +FailTask(ctx, taskID, errMsg) error
        +ReportTaskMessages(ctx, taskID, messages) error
        +ReportUsage(ctx, taskID, usage) error
    }

    class TaskService {
        +Queries db.Queries
        +Hub realtime.Hub
        +Bus events.Bus
        +EnqueueTaskForIssue(ctx, issue, commentID) AgentTaskQueue
        +EnqueueTaskForMention(ctx, issue, agentID, commentID) AgentTaskQueue
        +EnqueueChatTask(ctx, chatSession) AgentTaskQueue
        +ClaimTask(ctx, agentID) AgentTaskQueue
        +ClaimTaskForRuntime(ctx, runtimeID) AgentTaskQueue
        +StartTask(ctx, taskID) AgentTaskQueue
        +CompleteTask(ctx, taskID, result, sessionID, workDir) AgentTaskQueue
        +FailTask(ctx, taskID, errMsg) AgentTaskQueue
        +CancelTask(ctx, taskID) AgentTaskQueue
        +ReconcileAgentStatus(ctx, agentID)
        +LoadAgentSkills(ctx, agentID) AgentSkillData
    }

    class ExecEnv {
        +RootDir string
        +WorkDir string
        +CodexHome string
        +Prepare(params, logger) Environment, error
        +Reuse(workDir, provider, task, logger) Environment
        +Cleanup(removeAll bool) error
    }

    Daemon --> Client : HTTP 调用
    Daemon --> ExecEnv : 创建/复用环境
    Client ..> TaskService : 间接调用(通过 Handler)
    TaskService --> "db.Queries" : 数据库操作
```

> `Daemon` 是 Harness 的编排核心：通过 `Client` 与后端 HTTP 通信，通过 `ExecEnv` 管理隔离环境。`TaskService` 是服务端的任务管理中枢，封装了入队、领取、完成、失败等所有状态转换逻辑。

## 3.2 [Harness] Agent Backend 统一接口

```mermaid
classDiagram
    class Backend {
        <<interface>>
        +Execute(ctx, prompt, opts) Session, error
    }

    class ExecOptions {
        +Cwd string
        +Model string
        +SystemPrompt string
        +MaxTurns int
        +Timeout time.Duration
        +ResumeSessionID string
    }

    class Session {
        +Messages channel Message
        +Result channel Result
    }

    class Message {
        +Type MessageType
        +Content string
        +Tool string
        +CallID string
        +Input map~string~any
        +Output string
    }

    class Result {
        +Status string
        +Output string
        +Error string
        +DurationMs int64
        +SessionID string
        +Usage map~string~TokenUsage
    }

    class TokenUsage {
        +InputTokens int64
        +OutputTokens int64
        +CacheReadTokens int64
        +CacheWriteTokens int64
    }

    class ClaudeBackend {
        -cfg Config
        +Execute(ctx, prompt, opts) Session, error
    }

    class CodexBackend {
        -cfg Config
        +Execute(ctx, prompt, opts) Session, error
    }

    class OpenCodeBackend {
        -cfg Config
        +Execute(ctx, prompt, opts) Session, error
    }

    class OpenClawBackend {
        -cfg Config
        +Execute(ctx, prompt, opts) Session, error
    }

    class HermesBackend {
        -cfg Config
        +Execute(ctx, prompt, opts) Session, error
    }

    class Config {
        +ExecutablePath string
        +Env map~string~string
        +Logger slog.Logger
    }

    Backend <|.. ClaudeBackend : implements
    Backend <|.. CodexBackend : implements
    Backend <|.. OpenCodeBackend : implements
    Backend <|.. OpenClawBackend : implements
    Backend <|.. HermesBackend : implements
    Backend --> ExecOptions : receives
    Backend --> Session : returns
    Session --> Message : streams
    Session --> Result : final
    Result --> TokenUsage : per model
    ClaudeBackend --> Config
```

> `Backend` 接口是 Harness 对不同 Agent CLI 的抽象。五种后端共享同一个接口，新增 Agent 类型只需实现 `Execute` 方法。`Session` 的双通道设计（Messages 流式 + Result 最终）解耦了实时展示和最终结果。

## 3.3 [Context] 上下文构建函数关系

```mermaid
classDiagram
    class TaskContextForEnv {
        +IssueID string
        +TriggerCommentID string
        +AgentName string
        +AgentInstructions string
        +AgentSkills []SkillContextForEnv
        +Repos []RepoContextForEnv
        +ChatSessionID string
    }

    class SkillContextForEnv {
        +Name string
        +Content string
        +Files []SkillFileContextForEnv
    }

    class SkillFileContextForEnv {
        +Path string
        +Content string
    }

    class PrepareParams {
        +WorkspacesRoot string
        +WorkspaceID string
        +TaskID string
        +AgentName string
        +Provider string
        +Task TaskContextForEnv
    }

    class Environment {
        +RootDir string
        +WorkDir string
        +CodexHome string
        -logger slog.Logger
        +Cleanup(removeAll bool) error
    }

    class ExecEnvFunctions {
        <<package>>
        +Prepare(PrepareParams, logger) Environment error
        +Reuse(workDir, provider, task, logger) Environment
        +InjectRuntimeConfig(workDir, provider, ctx) error
    }

    class ContextFunctions {
        <<package>>
        -writeContextFiles(workDir, provider, ctx) error
        -resolveSkillsDir(workDir, provider) string error
        -writeSkillFiles(skillsDir, skills) error
        -renderIssueContext(provider, ctx) string
        -sanitizeSkillName(name) string
    }

    class RuntimeConfigFunctions {
        <<package>>
        -buildMetaSkillContent(provider, ctx) string
    }

    TaskContextForEnv --> SkillContextForEnv
    SkillContextForEnv --> SkillFileContextForEnv
    PrepareParams --> TaskContextForEnv
    ExecEnvFunctions --> PrepareParams : input
    ExecEnvFunctions --> Environment : output
    ExecEnvFunctions --> ContextFunctions : calls
    ExecEnvFunctions --> RuntimeConfigFunctions : calls
```

> 上下文构建的核心数据流：`TaskContextForEnv` 携带所有上下文原材料，`Prepare()` 编排整个注入过程（`writeContextFiles` 写文件 → `InjectRuntimeConfig` 写 Meta Skill），最终产生 `Environment`。`Reuse()` 路径复用已有 workdir 并刷新上下文文件。

## 3.4 [业务] 多租户中间件类关系

```mermaid
classDiagram
    class WorkspaceMiddleware {
        -resolveWorkspaceID(r) string
        -buildMiddleware(queries, resolve, roles) Handler
        +RequireWorkspaceMember(queries) Handler
        +RequireWorkspaceRole(queries, roles) Handler
        +RequireWorkspaceMemberFromURL(queries, param) Handler
        +RequireWorkspaceRoleFromURL(queries, param, roles) Handler
        +SetMemberContext(ctx, wsID, member) Context
        +MemberFromContext(ctx) Member bool
        +WorkspaceIDFromContext(ctx) string
    }

    class AuthMiddleware {
        +RequireAuth(queries) Handler
        -resolveUser(r) userID error
    }

    class Handler {
        +Handler(queries, taskService, hub, bus, ...)
        +CreateIssue(w, r)
        +ListIssues(w, r)
        +CreateComment(w, r)
        +CreateAgent(w, r)
        +ClaimTaskByRuntime(w, r)
        +ReportTaskMessages(w, r)
        +CompleteTask(w, r)
        +resolveActor(r, userID, wsID) actorType actorID
    }

    class Bus {
        -listeners map~string~[]Handler
        -globalHandlers []Handler
        +Subscribe(eventType, handler)
        +SubscribeAll(handler)
        +Publish(event)
    }

    class Hub {
        -rooms map~string~map~Client~bool
        -broadcast channel
        +Run()
        +BroadcastToWorkspace(wsID, message)
        +SendToUser(userID, message, excludeWorkspace)
        +Broadcast(message)
    }

    class Client {
        -hub Hub
        -conn websocket.Conn
        -send channel
        +userID string
        +workspaceID string
        +readPump()
        +writePump()
    }

    AuthMiddleware --> WorkspaceMiddleware : 顺序执行
    WorkspaceMiddleware --> Handler : 注入 ctx
    Handler --> Bus : Publish events
    Bus --> Hub : 全局 listener 转发
    Hub --> Client : per-workspace 广播
```

> 请求处理链：`Auth → Workspace → Handler → Bus → Hub → Client`。`WorkspaceMiddleware` 的四种变体对应不同的 ID 解析方式（query param vs URL param）和角色要求。`Handler.resolveActor` 通过 `X-Agent-ID` header 区分人和 Agent 的操作身份。

## 3.5 [业务] 前端实时同步机制

```mermaid
classDiagram
    class UseRealtimeSync {
        +useRealtimeSync(ws, stores, onToast) void
        -refreshMap Record~string~Function
        -debouncedRefresh(prefix, fn) void
        -timers Map~string~Timeout
    }

    class WSEventHandlers {
        +onAny(msg) 通用刷新(防抖100ms)
        +on(issue:updated) 精确更新 Issue cache
        +on(issue:created) 追加到列表 cache
        +on(issue:deleted) 从列表 cache 移除
        +on(inbox:new) 追加 Inbox item
        +on(comment:*) 失效 timeline cache
        +on(activity:created) 失效 timeline cache
        +on(workspace:deleted) 清理存储+切换 workspace
        +on(member:removed) 自身被移除则切换
        +on(member:added) 刷新 workspace 列表
    }

    class QueryCacheStrategy {
        +issueKeys.all(wsId) 列表
        +issueKeys.timeline(issueId) 时间线
        +issueKeys.reactions(issueId) 反应
        +workspaceKeys.agents(wsId) Agent 列表
        +workspaceKeys.members(wsId) 成员列表
        +projectKeys.all(wsId) 项目列表
        +inboxKeys.all(wsId) 收件箱
    }

    UseRealtimeSync --> WSEventHandlers : 注册
    WSEventHandlers --> QueryCacheStrategy : 失效/更新
```

> 前端实时同步的核心模式：**WS 事件作为失效信号，不做直接数据写入**。`onAny` 对通用事件按 prefix 防抖 100ms 批量失效；特定事件（issue CRUD、comment、activity）有精确的 cache 更新逻辑。Reconnect 后全量 refetch 恢复。

---

# 第四部分：函数级深入分析

## 4.1 [Harness] Daemon.runTask — 执行编排核心

**文件**: `server/internal/daemon/daemon.go:875-988`

```mermaid
flowchart TB
    START["runTask(ctx, task, provider, taskLog)"]
    START --> LOOKUP["查找 AgentEntry<br/>cfg.Agents[provider]"]
    LOOKUP --> CTX["构建 TaskContextForEnv<br/>IssueID + AgentName + Instructions<br/>+ Skills + Repos + ChatSessionID"]

    CTX --> REUSE_CHECK{"PriorWorkDir != ''?"}
    REUSE_CHECK -->|Yes| TRY_REUSE["execenv.Reuse(priorWorkDir)<br/>刷新 context files"]
    REUSE_CHECK -->|No| PREPARE["execenv.Prepare(PrepareParams)<br/>创建隔离目录树"]
    TRY_REUSE -->|"nil (目录不存在)"| PREPARE
    TRY_REUSE -->|"env (复用成功)"| INJECT

    PREPARE --> INJECT["InjectRuntimeConfig(env.WorkDir)<br/>写入 CLAUDE.md / AGENTS.md"]
    INJECT --> PROMPT["BuildPrompt(task)<br/>极简引导 prompt"]
    PROMPT --> ENV_MAP["构建 agentEnv map<br/>MULTICA_TOKEN/SERVER_URL/...<br/>PATH 注入 CLI 路径<br/>CODEX_HOME (仅 Codex)"]
    ENV_MAP --> BACKEND["agent.New(provider, Config)<br/>创建 Backend 实例"]
    BACKEND --> EXEC["backend.Execute(ctx, prompt, ExecOptions)<br/>Cwd=WorkDir · ResumeSessionID"]
    EXEC --> DRAIN["启动消息 drain goroutine<br/>500ms batch + 8192 chars 截断"]
    DRAIN --> WAIT["等待 Result channel"]

    WAIT --> RESULT["处理 Result"]
    RESULT --> COMPLETE{"Status == completed?"}
    COMPLETE -->|Yes| OK["client.CompleteTask<br/>result + sessionID + workDir"]
    COMPLETE -->|"blocked/failed"| FAIL["client.FailTask<br/>error message"]
```

> `runTask` 是 Harness 的编排核心函数。关键决策点：
> 1. **环境复用优先**：先尝试 `Reuse(priorWorkDir)`，失败才走 `Prepare()`
> 2. **环境不清理**：注释明确说明 workdir 保留用于未来同 (agent, issue) 对的任务复用
> 3. **PATH 注入**：将 `multica` CLI 所在目录 prepend 到 PATH，确保 Agent 子进程能调用

## 4.2 [Harness] TaskService.ClaimTaskForRuntime — 任务领取与并发控制

**文件**: `server/internal/service/task.go:204-228`

```mermaid
flowchart TB
    START["ClaimTaskForRuntime(ctx, runtimeID)"]
    START --> LIST["ListPendingTasksByRuntime(runtimeID)<br/>获取该 runtime 下所有 pending 任务"]
    LIST --> LOOP["遍历 candidates<br/>triedAgents 去重"]

    LOOP --> AGENT_CHECK{"已跳过该 agent?"}
    AGENT_CHECK -->|Yes| NEXT["continue"]
    AGENT_CHECK -->|No| CLAIM["ClaimTask(ctx, agentID)"]

    CLAIM --> AGENT_LOAD["GetAgent(agentID)"]
    AGENT_LOAD --> COUNT["CountRunningTasks(agentID)"]
    COUNT --> CAPACITY{"running >= maxConcurrent?"}
    CAPACITY -->|Yes| NEXT2["return nil, nil (无容量)"]
    CAPACITY -->|No| DB_CLAIM["ClaimAgentTask(agentID)<br/>SQL: queued → dispatched<br/>ORDER BY priority DESC, created_at ASC"]

    DB_CLAIM --> STATUS["updateAgentStatus(agentID, 'working')"]
    STATUS --> BROADCAST["broadcastTaskDispatch(task)"]
    BROADCAST --> CHECK_RT{"task.RuntimeID == runtimeID?"}
    CHECK_RT -->|Yes| RETURN["return task"]
    CHECK_RT -->|No| LOOP

    NEXT --> LOOP
    NEXT2 --> LOOP
```

> 并发控制的关键设计：`ClaimTaskForRuntime` 遍历该 runtime 下所有 pending 任务，对每个 candidate 的 agent 检查 `CountRunningTasks` 是否达到 `MaxConcurrentTasks`。只有未达上限的 agent 才能领取任务。`triedAgents` map 确保同一 agent 不会被重复检查。

## 4.3 [Context] buildMetaSkillContent — 上下文注入的核心构建函数

**文件**: `server/internal/daemon/execenv/runtime_config.go:33-178`

```mermaid
flowchart TB
    START["buildMetaSkillContent(provider, ctx)"]
    START --> HEADER["写入标题<br/>'# Multica Agent Runtime'"]

    HEADER --> ID_CHECK{"ctx.AgentInstructions != ''?"}
    ID_CHECK -->|Yes| IDENTITY["## Agent Identity<br/>写入 agent.instructions"]
    ID_CHECK -->|No| CMDS
    IDENTITY --> CMDS["## Available Commands<br/>Read: issue get/list/comment list<br/>workspace get/members<br/>agent list · repo checkout<br/>issue runs/run-messages<br/>attachment download<br/>Write: issue create/assign/comment<br/>status/update · comment delete"]

    CMDS --> REPOS_CHECK{"len(ctx.Repos) > 0?"}
    REPOS_CHECK -->|Yes| REPOS["## Repositories<br/>Markdown 表格: URL | Description"]
    REPOS_CHECK -->|No| WORKFLOW
    REPOS --> WORKFLOW

    WORKFLOW --> MODE{"触发模式?"}
    MODE -->|ChatSessionID != ''| CHAT_MODE["Chat 模式<br/>对话式回应<br/>可调用 CLI 查数据<br/>需要时 checkout repo"]
    MODE -->|TriggerCommentID != ''| COMMENT_MODE["评论触发<br/>1. issue get<br/>2. comment list<br/>3. 找到触发评论<br/>4. comment add --parent<br/>5. 不改 status"]
    MODE -->|默认| ASSIGN_MODE["分配触发<br/>1. issue get<br/>2. status → in_progress<br/>3. checkout repo<br/>4. 实现 → commit → push → PR<br/>5. comment add PR link<br/>6. status → in_review"]

    CHAT_MODE --> SKILLS_CHECK
    COMMENT_MODE --> SKILLS_CHECK
    ASSIGN_MODE --> SKILLS_CHECK

    SKILLS_CHECK{"len(ctx.AgentSkills) > 0?"}
    SKILLS_CHECK -->|Yes| SKILLS["## Skills<br/>列出技能名称"]
    SKILLS_CHECK -->|No| MENTIONS
    SKILLS --> MENTIONS["## Mentions<br/>issue: [MUL-123](mention://issue/id)<br/>member: [@Name](mention://member/id)<br/>agent: [@Name](mention://agent/id)"]

    MENTIONS --> ATTACH["## Attachments<br/>multica attachment download"]

    ATTACH --> IMPORTANT["## Important<br/>必须用 multica CLI<br/>禁止 curl/wget<br/>缺功能则 comment 反馈"]
    IMPORTANT --> OUTPUT["## Output<br/>简洁自然，说结果不说过程"]
```

> `buildMetaSkillContent` 是上下文工程的"心脏"：根据三种触发模式（分配、评论、Chat）生成不同的工作流指引。这个函数决定了 Agent 在拿到任务后遵循什么流程。

## 4.4 [业务] Daemon.ClaimTaskByRuntime — 服务端领取响应组装

**文件**: `server/internal/handler/daemon.go:224-309`

```mermaid
flowchart TB
    START["ClaimTaskByRuntime(w, r)"]
    START --> CLAIM["TaskService.ClaimTaskForRuntime(runtimeID)"]
    CLAIM --> NIL_CHECK{"task == nil?"}
    NIL_CHECK -->|Yes| EMPTY["返回 {task: null}"]
    NIL_CHECK -->|No| AGENT["GetAgent(task.AgentID)<br/>LoadAgentSkills(task.AgentID)"]

    AGENT --> ISSUE_CHECK{"task.IssueID.Valid?"}
    ISSUE_CHECK -->|Yes| ISSUE_BRANCH["GetIssue → workspaceID<br/>GetWorkspace → Repos JSON<br/>GetLastTaskSession → priorSessionID + priorWorkDir"]
    ISSUE_CHECK -->|No| CHAT_CHECK

    ISSUE_BRANCH --> BUILD_RESP

    CHAT_CHECK{"task.ChatSessionID.Valid?"}
    CHAT_CHECK -->|Yes| CHAT_BRANCH["GetChatSession → workspaceID<br/>GetWorkspace → Repos JSON<br/>cs.SessionID → priorSessionID<br/>cs.WorkDir → priorWorkDir<br/>ListChatMessages → 最后一条 user message"]
    CHAT_CHECK -->|No| BUILD_RESP

    CHAT_BRANCH --> BUILD_RESP["组装响应:<br/>Task{ID, AgentID, IssueID, WorkspaceID}<br/>Agent{Name, Instructions, Skills}<br/>Repos[]<br/>PriorSessionID, PriorWorkDir<br/>ChatSessionID, ChatMessage"]
    BUILD_RESP --> RETURN["返回 {task: resp}"]
```

> 服务端领取响应的组装逻辑是 Context 工程的数据源头：从 `Agent` 表加载 instructions 和 skills，从 `Workspace` 表加载 repos，从 `agent_task_queue` 表恢复 session 信息，从 `chat_message` 表加载最新用户消息。这些数据随后被 Daemon 传递给 ExecEnv 进行文件注入。

## 4.5 [通信协议] 消息 drain 与批量上报

**文件**: `server/internal/daemon/daemon.go:990-1118`

```mermaid
flowchart TB
    START["session.Messages channel"]
    START --> SWITCH{"msg.Type?"}

    SWITCH -->|ToolUse| TU["记录 callID→tool 映射<br/>toolCount++<br/>截断 output (8192 chars)<br/>flush pending text/thinking<br/>加入 batch"]
    SWITCH -->|ToolResult| TR["从 callID 映射找 tool 名<br/>截断 output (8192 chars)<br/>flush pending<br/>加入 batch"]
    SWITCH -->|Text| TX["累积到 pendingText<br/>等待 flush"]
    SWITCH -->|Thinking| TH["累积到 pendingThinking<br/>等待 flush"]
    SWITCH -->|Status| ST["log 状态变更"]
    SWITCH -->|Error| ER["flush pending<br/>加入 batch (type=error)"]

    TX --> TICKER
    TH --> TICKER

    subgraph "批量刷新机制"
        TICKER["500ms Ticker"]
        FLUSH["flush()"]
        LOCK["mu.Lock()"]
        WRITE_THINKING["写入 pendingThinking → batch<br/>(type=thinking)"]
        WRITE_TEXT["写入 pendingText → batch<br/>(type=text)"]
        SEND["client.ReportTaskMessages(ctx, taskID, batch)<br/>5s timeout"]
        LOCK --> WRITE_THINKING --> WRITE_TEXT --> SEND
        TICKER --> FLUSH --> LOCK
    end

    SEND --> PERSIST["Handler.ReportTaskMessages<br/>遍历 batch → DB: CreateTaskMessage<br/>Bus.Publish(task:message)<br/>Hub.BroadcastToWorkspace"]
```

> 消息 drain 的关键设计：
> 1. **累积 + 定时刷新**：text/thinking 消息累积后每 500ms 刷新一次，避免高频小消息
> 2. **截断**：工具输出超过 8192 字符截断，防止 DB 存储膨胀
> 3. **顺序保证**：通过 `seq` 原子计数器保证消息顺序
> 4. **超时隔离**：`ReportTaskMessages` 用独立 5s timeout context，不阻塞主流程

---

# 第五部分：三条线索的交叉分析与能力矩阵

## 5.1 已有能力矩阵

```mermaid
quadrantChart
    title Multica 能力矩阵：实现完整度 × 业务价值
    x-axis "实现完整度" --> "高"
    y-axis "业务价值" --> "高"
    quadrant-1 "核心优势区"
    quadrant-2 "战略投入区"
    quadrant-3 "低优先级"
    quadrant-4 "快速补齐区"

    "多后端统一接口": [0.85, 0.7]
    "四层上下文注入": [0.8, 0.75]
    "Skill 知识系统": [0.7, 0.65]
    "多租户隔离": [0.85, 0.8]
    "三级 RBAC": [0.75, 0.7]
    "多态指派": [0.8, 0.85]
    "Session 恢复": [0.7, 0.6]
    "Token 用量分析": [0.65, 0.55]
    "消息脱敏过滤": [0.8, 0.5]
    "WS 实时同步": [0.85, 0.65]
```

## 5.2 关键空白与建设路径

| 维度 | 已有 | 缺失 | 建设路径 |
|---|---|---|---|
| **Harness** | 任务队列 + 并发控制 + 5种 Backend | 无优先级调度、无依赖链、无自动重试、无容器隔离 | 短期: 任务优先级 + 重试策略; 中期: DAG 依赖编排; 长期: 容器沙箱 |
| **Context** | 四层注入 + Skill + Session 恢复 | 无 RAG/向量检索、无长期记忆、无上下文预算管理 | 短期: Token 预算管理; 中期: pgvector 向量索引 + embedding pipeline; 长期: Agent 长期知识库 |
| **业务** | RBAC + Token 分析 + 多态指派 | 无 Billing/配额、无全局仪表盘、无 Agent 效能报告、无审计 UI | 短期: Workspace 聚合仪表盘 (API 已就绪) + Agent 效能报告; 中期: Billing engine; 长期: 审计合规 |

## 5.3 数据资产盘点

| 数据表 | 已利用 | 未暴露 |
|---|---|---|
| `agent_task_queue` | 任务 CRUD + 状态流转 | 成功率/平均耗时/趋势分析 |
| `task_message` | 实时展示 + Issue Timeline | 工具调用频率/Agent 行为分析 |
| `runtime_usage` | Runtime 级 Token 图表 | Workspace 级成本聚合、Issue 级成本归因 |
| `activity_log` | Issue Timeline 展示 | 独立审计 UI、用户活跃度分析 |
| `workspace.repos` | Agent 注入可用仓库列表 | 仓库活跃度、Agent 代码贡献统计 |
| `chat_session` + `chat_message` | Chat 交互 | 会话质量分析、Agent 响应时间 |
| `agent.instructions` | Meta Skill 注入 | 指令模板市场、最佳实践推荐 |

---

# 附录：关键文件索引

## Harness 层

| 文件 | 职责 |
|---|---|
| `server/internal/daemon/daemon.go` | Daemon 主循环、任务编排、消息 drain |
| `server/internal/daemon/types.go` | Task/Agent/Skill/TaskResult 类型定义 |
| `server/internal/daemon/prompt.go` | BuildPrompt — 极简引导 prompt |
| `server/internal/daemon/execenv/execenv.go` | Prepare/Reuse/Cleanup — 环境生命周期 |
| `server/internal/daemon/execenv/context.go` | writeContextFiles — 上下文文件写入 |
| `server/internal/daemon/execenv/runtime_config.go` | InjectRuntimeConfig — Meta Skill 生成 |
| `server/pkg/agent/agent.go` | Backend 接口 + Message/Result/TokenUsage 类型 |
| `server/pkg/agent/claude.go` | Claude Code 后端 |
| `server/pkg/agent/codex.go` | Codex 后端 |
| `server/internal/service/task.go` | TaskService — 服务端任务管理中枢 |
| `server/internal/handler/daemon.go` | Daemon API (heartbeat/claim/messages/usage) |

## Context 层

| 文件 | 职责 |
|---|---|
| `server/internal/daemon/execenv/runtime_config.go` | buildMetaSkillContent — Agent 环境说明 |
| `server/internal/daemon/execenv/context.go` | renderIssueContext + writeSkillFiles |
| `server/internal/handler/skill.go` | Skill CRUD + ClawHub/skills.sh 导入 |
| `server/pkg/redact/redact.go` | 敏感信息过滤 |
| `server/internal/mention/expand.go` | Issue 标识符链接扩展 |

## 业务/通信层

| 文件 | 职责 |
|---|---|
| `server/internal/middleware/workspace.go` | 多租户中间件 (Member + Role) |
| `server/internal/middleware/auth.go` | 认证中间件 (JWT + PAT) |
| `server/internal/events/bus.go` | 进程内 Event Bus |
| `server/internal/realtime/hub.go` | WS Hub — workspace 分房间 |
| `server/pkg/protocol/events.go` | 30+ WS 事件类型常量 |
| `packages/core/realtime/use-realtime-sync.ts` | 前端 WS→Cache 失效同步 |
| `packages/core/workspace/store.ts` | Workspace 切换 + TanStack Query 缓存隔离 |
| `packages/core/workspace/queries.ts` | workspaceKeys — 缓存 key 定义 |
| `packages/views/settings/components/` | Settings 页面 (6 标签) |
| `packages/views/agents/components/` | Agent 管理 (4 标签) |
| `packages/views/runtimes/components/` | Runtime 管理 + Token 分析 |
