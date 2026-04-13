# Multica: AI-Native Task Management 的架构深度解析

> 本文从三个维度剖析 Multica 项目的多 Agent 编排架构：通用架构概念映射、Agent 为主角的设计哲学、以及 Task 全生命周期管理。

---

## 第一部分：架构概念解码 —— RAG、Agent Loop、Skills、MCP

### 1.1 RAG：Agentic Retrieval，而非管道检索

传统 RAG 系统的核心范式是：用户提问 → 向量检索 → 拼接上下文 → LLM 生成。Multica 完全没有采用这套范式。数据库层面没有 pgvector，没有 embedding 列，没有相似度搜索。项目的搜索能力基于 `pg_bigm` 的 bigram 全文索引（`server/migrations/032_issue_search_index.up.sql`），走的是传统 SQL `LIKE` 匹配路线。

但这不意味着 Multica 没有"检索增强生成"。它的 RAG 实现了一种更高级的模式：**Agentic RAG** —— 检索的发起者不是预定义的管道，而是 Agent 自身。

```
传统 RAG:  User Query → Retriever → Context → LLM → Response
Multica RAG: Agent → "我需要什么？" → CLI 调用 → 结构化数据 → 推理 → 下一步
```

**系统装配链路**是这样的：

1. **上下文注入阶段**（`server/internal/daemon/execenv/runtime_config.go`）：`InjectRuntimeConfig()` 函数根据 provider 类型（claude/codex/opencode 等）在工作目录写入 `CLAUDE.md` 或 `AGENTS.md`。这个文件告诉 Agent："你可以用 `multica issue get <id> --output json` 获取 issue 详情，用 `multica issue comment list` 获取评论，用 `multica workspace members` 查看成员列表。"

2. **运行时检索阶段**：Agent 在执行过程中，按需调用 `multica` CLI 命令获取结构化 JSON 数据。`BuildPrompt()`（`server/internal/daemon/prompt.go`）只给出最小化的启动指令 —— "先运行 `multica issue get {id}` 了解你的任务"，具体的上下文获取完全由 Agent 自主决策。

3. **Skills 作为结构化知识检索**：Skills 系统（`server/migrations/008_structured_skills.up.sql`）提供了另一种检索维度。每个 Skill 是一组结构化指令（`SKILL.md` + 支撑文件），在任务执行时通过 `LoadAgentSkills()` 加载并写入 Agent 的原生发现路径（如 Claude 的 `.claude/skills/`，Codex 的 `CODEX_HOME/skills/`）。

这种设计的哲学是：**让 Agent 自己决定需要什么信息，而不是替它决定**。这比传统 RAG 更灵活，因为 Agent 可以根据任务复杂度动态决定检索深度 —— 简单的评论回复只需读 issue 和评论，复杂的代码实现则要 checkout 仓库、阅读代码、理解上下文。

### 1.2 Agent Loop：信号量约束的并发执行引擎

Multica 的 Agent Loop 不是单 Agent 的 Think-Act-Observe 循环，而是一个**分布式任务调度系统**，核心在 Daemon 的 `pollLoop()`（`server/internal/daemon/daemon.go:684-769`）。

**外层循环 —— 任务调度**：

```
pollLoop:
  ├─ 用信号量 (sem) 控制最大并发数 (默认 20)
  ├─ 轮询所有已注册的 RuntimeID，round-robin + offset
  ├─ ClaimTask → 有任务则启动 goroutine 执行 handleTask
  └─ 无任务则 sleep(pollInterval, 默认 3s)
```

**内层循环 —— 单任务执行**：

```
handleTask:
  ├─ StartTask (status: running)
  ├─ 启动取消轮询 goroutine (每 5s 检查)
  └─ runTask:
       ├─ execenv.Prepare() / execenv.Reuse()
       ├─ InjectRuntimeConfig() (写入 CLAUDE.md)
       ├─ BuildPrompt() (最小化 prompt)
       ├─ agent.New(provider, config) → Backend
       ├─ backend.Execute(ctx, prompt, opts) → Session
       ├─ 流式读取 Session.Messages → 批量上报服务器
       └─ Session.Result → CompleteTask / FailTask
```

**Backend 接口**（`server/pkg/agent/agent.go`）是整个执行循环的抽象核心：

```go
type Backend interface {
    Execute(ctx context.Context, prompt string, opts ExecOptions) (*Session, error)
}
```

5 种后端实现，每种对应一种 Agent CLI：

| Backend | 通信协议 | 启动方式 |
|---------|---------|---------|
| Claude | NDJSON (stream-json) | `claude -p --output-format stream-json` |
| Codex | JSON-RPC 2.0 (stdio) | `codex app-server --listen stdio://` |
| Hermes | ACP JSON-RPC 2.0 (stdio) | `hermes acp` |
| OpenCode | NDJSON | `opencode run --format json` |
| OpenClaw | NDJSON | `openclaw agent --output-format stream-json` |

每种后端都是把 Agent CLI 作为子进程启动，通过 stdin/stdout 流式通信。`Session` 提供两个 channel：`Messages`（流式事件）和 `Result`（最终结果）。这种设计的关键洞察是：**Agent Loop 的 "Loop" 不在 Multica 内部，而在 Agent CLI 内部**。Multica 管的是任务调度的循环，Agent CLI 管的是 Think-Act-Observe 的推理循环。

**容错与清理**：
- Runtime Sweeper（`server/cmd/server/runtime_sweeper.go`）每 30s 扫描一次，3 次心跳失败（45s）标记 runtime 为 offline，同时 fail 掉孤儿任务
- Dispatched 任务 5 分钟超时，Running 任务 2.5 小时超时
- 取消检测：每 5s 轮询任务状态，cancelled 则通过 context cancel 终止 Agent

### 1.3 Skills：Agent 的可插拔知识模块

Skills 系统是 Multica 最重要的上下文工程工具之一。

**数据模型**（`server/migrations/008_structured_skills.up.sql`）：

```
skill (id, workspace_id, name, description, content, config JSONB, created_by)
  └─ skill_file (id, skill_id, path, content)  -- 支撑文件
  └─ agent_skill (agent_id, skill_id)           -- 多对多绑定
```

**生命周期**：

1. **创建**：通过 UI 或 API 创建 Skill，包含核心指令（content）和可选的支撑文件（skill_file）
2. **导入**：`ImportSkill` 支持从外部源导入（ClawHub、GitHub 仓库的 skills.sh）
3. **绑定**：通过 `SetAgentSkills` 将 Skill 关联到特定 Agent
4. **加载**：任务被 Claim 时，`LoadAgentSkills()`（`server/internal/service/task.go:400-416`）查询 Agent 的所有 Skills 及其文件
5. **注入**：`writeContextFiles()`（`server/internal/daemon/execenv/context.go`）将 Skills 写入 Agent 工作目录的原生发现路径

**注入路径的 Provider 适配**：

```
Claude:     {workDir}/.claude/skills/{name}/SKILL.md
OpenCode:   {workDir}/.config/opencode/skills/{name}/SKILL.md
Codex:      {CODEX_HOME}/skills/{name}/SKILL.md
Others:     {workDir}/.agent_context/skills/{name}/SKILL.md
```

这里的设计智慧是：**利用每种 Agent CLI 的原生 Skill 发现阶段，而不是构建自己的 Skill 加载器**。Claude Code 会自动扫描 `.claude/skills/` 目录，Codex 会扫描 `CODEX_HOME/skills/`。Multica 只负责把文件放到正确的位置。

**Meta Skill**：除了用户定义的 Skills，`buildMetaSkillContent()` 函数会生成一个"元技能"文件（CLAUDE.md 或 AGENTS.md）。这个文件不是传统意义上的 Skill，而是**运行时环境的完整说明书**，包含：Agent 身份指令、可用命令、工作流步骤、仓库列表、Mention 格式、附件处理、输出准则。

### 1.4 MCP：委托而非实现

MCP（Model Context Protocol）在 Multica 中的角色很特殊：Multica **没有实现 MCP Server**。

- Claude 后端传 `--strict-mcp-config` 标志（`server/pkg/agent/claude.go:340`）
- Hermes 后端在 session/new 时传 `"mcpServers": []any{}`（`server/pkg/agent/hermes.go:163`）

这说明 Multica 的设计选择是：**Agent 的工具调用能力通过 CLI 命令而非 MCP 协议提供**。`multica` CLI 就是 Agent 的"工具集"：

```bash
multica issue get <id>         # 读取 issue
multica issue status <id> X    # 更新状态
multica issue comment add ...  # 发表评论
multica repo checkout <url>    # 检出仓库
multica workspace members      # 查看成员
```

这种设计的优势是：
1. **不依赖特定协议**：MCP 是 Anthropic 的协议，Codex、OpenCode 等不一定支持。CLI 命令对所有 Agent 通用
2. **可审计性**：每次 CLI 调用都有日志，比 MCP 的实时通信更容易追踪
3. **安全性**：通过 `MULTICA_TOKEN` 环境变量认证，每个任务有独立的 token，权限边界清晰

---

## 第二部分：以 Agent 为主角 —— Teammates、Runtimes、Workspace

### 2.1 Agents as Teammates：多态身份系统

Multica 最独特的设计之一是 Agent 不只是工具，而是**团队中的平等成员**。这体现在数据模型的每一个角落。

**多态 Assignee 设计**：

```sql
-- issue 表
assignee_type ENUM('member', 'agent')
assignee_id   UUID  -- 指向 member.user_id 或 agent.id

-- 同样的模式贯穿整个系统:
comment.author_type / author_id
issue.creator_type / creator_id
activity_log.actor_type / actor_id
inbox_item.recipient_type / recipient_id
```

这意味着 Agent 可以：
- 被 **分配** Issue（作为 assignee）
- **创建** Issue（作为 creator）
- **发表** 评论（作为 author）
- **收到** 通知（作为 recipient）
- **产生** 活动日志（作为 actor）

**Agent Profile**（`server/migrations/001_init.up.sql` + 后续 migrations）：

| 属性 | 说明 |
|------|------|
| `name` | 显示名称 |
| `avatar_url` | 头像 |
| `description` | 简介 |
| `instructions` | 个性化系统指令（Agent 的"人格"） |
| `visibility` | workspace（全员可见）或 private（仅 owner/admin 可分配） |
| `status` | idle / working / blocked / error / offline |
| `runtime_mode` | local / cloud |
| `max_concurrent_tasks` | 最大并发任务数（默认 6） |
| `owner_id` | 归属者 |

**权限控制**（`server/internal/handler/agent.go` + `issue.go`）：

- `canAssignAgent()`：private Agent 只能被 owner 或 workspace admin/owner 分配；archived Agent 不能被分配
- `canManageAgent()`：只有 owner 或 workspace admin/owner 可以修改/归档 Agent
- `ListAgents`：workspace 内所有成员可见所有 Agent（包括 private），但分配受权限控制

**身份解析**（`server/internal/handler/handler.go` 的 `resolveActor` 方法）：

请求来源通过 `X-Agent-ID` 和 `X-Task-ID` 请求头区分是来自人类还是 Agent。Agent 通过 `MULTICA_TOKEN` 认证，权限与任务上下文绑定。这意味着 Agent 的每一个操作都是可追踪的 —— 你知道哪个 Agent 在什么时候做了什么。

### 2.2 Unified Runtimes：五虎将的统一抽象

**Runtime 数据模型**（`server/migrations/004_agent_runtime_loop.up.sql`）：

```
agent_runtime:
  id, workspace_id, runtime_mode(local/cloud), provider(claude/codex/...),
  status(online/offline), daemon_id, device_info, metadata JSONB,
  last_seen_at, UNIQUE(workspace_id, daemon_id, provider)
```

**注册流程**：

```
1. 用户运行 `multica daemon start`
2. Daemon 探测 PATH 上的可用 CLI (claude, codex, opencode, openclaw, hermes)
   └─ server/internal/daemon/config.go:73-111
3. 调用 POST /api/daemon/register
   └─ 报告 workspace_id, daemon_id, 运行时描述符数组
4. Server upsert agent_runtime 记录
5. 返回 runtime_id + workspace repos
6. Daemon 存储 runtime_id，开始 pollLoop
```

**统一的 Backend 接口屏蔽了底层协议差异**：

虽然五种 Agent CLI 使用完全不同的通信协议（NDJSON、JSON-RPC 2.0、ACP），但在 Multica 层面它们都呈现为统一的 `Session{Messages, Result}` 模型。消息类型也是统一的：`text`、`thinking`、`tool-use`、`tool-result`、`status`、`error`、`log`。

```
┌──────────────────────────────────────────────────┐
│                   Daemon                          │
│  pollLoop → handleTask → runTask → Backend.Execute│
└──────────┬───────────────────────────────────────┘
           │ Backend interface
     ┌─────┼─────┬──────────┬───────────┐
     │     │     │          │           │
  Claude  Codex OpenCode  OpenClaw   Hermes
  NDJSON  RPC   NDJSON    NDJSON     ACP/RPC
     │     │     │          │           │
  claude  codex opencode  openclaw   hermes
   CLI    CLI    CLI       CLI       CLI
```

**Daemon 的并发模型**（`server/internal/daemon/daemon.go`）：

Daemon 启动后运行多个后台 goroutine：
- `configWatchLoop`：每 5s 检查配置变更
- `workspaceSyncLoop`：每 30s 同步新 workspace
- `heartbeatLoop`：每 15s 发送心跳（Server 用这个检测 stale runtime）
- `usageScanLoop`：每 5min 扫描 Agent 日志文件获取 token 用量
- `serveHealth`：HTTP 健康检查（端口 19514）
- `pollLoop`：主循环，信号量控制并发（默认最大 20 个任务）

### 2.3 Multi-Workspace：三层隔离

**第一层 —— 数据库隔离**：

```sql
-- 所有 workspace 作用域实体都带 workspace_id + ON DELETE CASCADE
workspace (id, name, slug, settings, issue_prefix, context, repos)
  ├─ member (workspace_id, user_id, role)
  ├─ agent (workspace_id, owner_id, ...)
  ├─ issue (workspace_id, ...)
  ├─ comment (workspace_id, ...)
  ├─ inbox_item (workspace_id, ...)
  ├─ skill (workspace_id, ...)
  └─ agent_runtime (workspace_id, daemon_id, provider) UNIQUE
```

**第二层 —— 中间件隔离**（`server/internal/middleware/workspace.go`）：

```
每个 API 请求 → RequireWorkspaceMember 中间件
  ├─ 从 X-Workspace-ID header 或 ?workspace_id= 提取 workspace ID
  ├─ DB 查询验证用户是该 workspace 的成员
  └─ 注入 workspace_id 和 member 记录到 request context
```

所有数据查询（`GetIssueInWorkspace`、`ListIssues`、`ListAgents`）都强制过滤 `workspace_id`。`loadIssueForUser` 和 `loadAgentForUser` 辅助函数总是验证 workspace scope。

**第三层 —— 实时通信隔离**（`server/internal/realtime/hub.go`）：

WebSocket Hub 使用 room 概念，以 `workspaceID` 为 key。`BroadcastToWorkspace()` 只向同一 workspace room 内的连接发送消息。

**前端层面**：

- `WorkspaceStore`（Zustand）管理 workspace 切换，更新 API client 的 `X-Workspace-ID` header
- TanStack Query 的所有 query key 都包含 `wsId`，切换 workspace 自动触发重新获取
- 工作区感知的持久化存储（`packages/core/platform/workspace-storage.ts`）按 workspace ID 命名空间隔离

### 2.4 Harness Engineering：执行环境的精密装配

Harness Engineering 在 Multica 中由 `server/internal/daemon/execenv/` 包承担，它负责为每个任务创建一个隔离、完整、可复用的执行环境。

**目录结构**（每个任务独立）：

```
{workspacesRoot}/{workspaceID}/{shortTaskID}/
  workdir/       ← Agent 的工作目录（初始为空）
  output/        ← 调试用输出
  logs/          ← 日志
  codex-home/    ← Codex 专用（如适用）
```

**装配流程**：

```
runTask():
  1. 检查 PriorWorkDir → 有则 execenv.Reuse(), 无则 execenv.Prepare()
  2. execenv.InjectRuntimeConfig() → 写入 CLAUDE.md / AGENTS.md
  3. BuildPrompt() → 构建最小化 prompt
  4. 设置环境变量:
     ├─ MULTICA_TOKEN (认证)
     ├─ MULTICA_SERVER_URL (API 地址)
     ├─ MULTICA_WORKSPACE_ID (工作区)
     ├─ MULTICA_AGENT_NAME / ID (Agent 身份)
     ├─ MULTICA_TASK_ID (任务 ID)
     ├─ MULTICA_DAEMON_PORT (Daemon 端口)
     ├─ PATH (注入 multica CLI 所在目录)
     └─ CODEX_HOME (Codex 专用，如适用)
  5. agent.New(provider, config) → 创建 Backend
  6. backend.Execute(ctx, prompt, opts) → 启动 Agent CLI
```

**Session 复用**（`server/migrations/020`）：

这是 Harness Engineering 的一个精妙设计。同一个 (Agent, Issue) 对上的多个任务可以复用之前的：
- `prior_session_id`：Agent CLI 的 session ID，用于恢复对话上下文
- `prior_work_dir`：之前的工作目录，代码、文件、Git 状态都保留

这意味着：当用户在 Issue 上追加评论触发新任务时，Agent 不需要从零开始 —— 它继承之前的会话上下文和工作目录状态。

### 2.5 Context Engineering：从 Prompt 到 Meta Skill

Context Engineering 是 Multica 最体现工程艺术的部分。它的核心理念是：**Prompt 要极简，上下文要丰富，让 Agent 自主发现和利用信息**。

**Prompt 层（极简）**：

```go
// server/internal/daemon/prompt.go
func BuildPrompt(task Task) string {
    // Issue 任务：一句话告诉 Agent 去读 issue
    "Your assigned issue ID is: %s. Start by running `multica issue get %s --output json`"
    // Chat 任务：附上用户消息
    "User message:\n%s"
}
```

**Meta Skill 层（丰富）**：`buildMetaSkillContent()` 生成的 CLAUDE.md / AGENTS.md 包含：

```
1. Agent Identity        ← 个性化指令（instructions 字段）
2. Available Commands    ← 完整的 CLI 命令参考
3. Repositories          ← 可用的仓库列表及 checkout URL
4. Workflow Instructions ← 根据触发类型的不同工作流
5. Skills List           ← 已安装的 Skill 名称列表
6. Mentions Format       ← mention://issue/<id> 等格式
7. Attachments           ← 附件下载说明
8. Output Guidelines     ← "简洁、结果导向"
```

**三种工作流的上下文差异**：

| 触发类型 | 工作流 |
|---------|--------|
| **Assignment** | get issue → set in_progress → checkout repo → implement → PR → set in_review |
| **Comment** | get issue → list comments → 找到触发评论 → 回复 → 可选执行代码变更 |
| **Chat** | 交互式对话模式，使用 CLI 查询和执行操作 |

**Skills 发现机制**：每种 Provider 有自己的 Skill 发现阶段。Multica 不实现自己的加载器，只负责把 Skill 文件放到正确位置：

- Claude Code 自动扫描 `.claude/skills/*/SKILL.md`
- Codex 自动扫描 `CODEX_HOME/skills/*/SKILL.md`
- OpenCode 自动扫描 `.config/opencode/skills/*/SKILL.md`

Meta Skill 中只列出 Skill 名称（如 "- **code-review**"），Agent 自己通过原生机制发现完整内容。这种"点到为止"的设计避免了上下文膨胀 —— Skill 的完整内容只有在 Agent 实际需要时才被加载。

---

## 第三部分：Task 全生命周期 —— 从用户动作到 Agent 完成

### 3.1 完整生命周期追踪

让我们跟随一个完整的场景：**用户在 Issue #117 上 @mention 一个 Agent，要求修复一个 bug**。

#### Phase 1: 触发（Trigger）

```
用户在 Issue #117 添加评论: "@BackendBot 这个登录 redirect 有 bug，请修复"
```

**系统处理**（`server/internal/handler/comment.go`）：
1. 创建评论记录，`author_type = 'member'`
2. `mention.ExpandIssueIdentifiers()` 自动展开 "MUL-117" 等裸引用为 mention 链接
3. 发布 `comment:created` 事件到 EventBus
4. 检测到 `@BackendBot` mention → 调用 `enqueueMentionedAgentTasks()`

#### Phase 2: 入队（Enqueue）

**TaskService.EnqueueTaskForMention()**（`server/internal/service/task.go:80`）：

```
1. 验证 Agent 存在且未归档、有 Runtime 绑定
2. CreateAgentTask SQL:
   ├─ agent_id = BackendBot 的 ID
   ├─ runtime_id = BackendBot 绑定的 runtime ID
   ├─ issue_id = Issue #117 的 ID
   ├─ priority = 依据 issue priority 转换的整数
   ├─ trigger_comment_id = 触发评论的 ID
   └─ status = 'queued'
3. 发布 task:dispatch 事件
```

SQL 层使用 `FOR UPDATE SKIP LOCKED` 确保并发安全：
```sql
-- ClaimAgentTask 使用行级锁 + SKIP LOCKED
SELECT ... FROM agent_task_queue
WHERE agent_id = $1 AND status = 'queued'
ORDER BY priority DESC, created_at ASC
FOR UPDATE SKIP LOCKED
LIMIT 1
```

#### Phase 3: 认领（Claim）

Daemon 的 `pollLoop()` 正在轮询：

```
1. pollLoop 检查信号量是否还有空位 (max_concurrent_tasks)
2. 调用 POST /api/daemon/runtimes/{runtimeId}/tasks/claim
3. Server 端 ClaimTaskForRuntime:
   ├─ 列出该 runtime 的所有 pending tasks
   ├─ 按优先级尝试 ClaimAgentTask (SKIP LOCKED)
   ├─ 加载 Agent 数据 (name, instructions, skills)
   ├─ 加载 workspace repos
   └─ 返回: Task + AgentData + Skills + Repos + PriorSessionID
4. 任务状态: queued → dispatched
5. Agent 状态: idle → working
```

#### Phase 4: 环境准备（Prepare）

**handleTask → runTask**（`server/internal/daemon/daemon.go:875`）：

```
1. 检查 PriorWorkDir:
   ├─ 有 (之前处理过同一个 issue) → execenv.Reuse()
   │   └─ 保留工作目录状态，只刷新 context 文件
   └─ 无 → execenv.Prepare()
       └─ 创建 {workspacesRoot}/{wsID}/{taskID}/
           ├─ workdir/ (空目录)
           ├─ output/
           └─ logs/

2. writeContextFiles():
   ├─ .agent_context/issue_context.md (任务上下文)
   └─ Skills → 写入 provider 原生路径
       └─ .claude/skills/code-review/SKILL.md
       └─ .claude/skills/testing/SKILL.md

3. InjectRuntimeConfig():
   └─ 写入 CLAUDE.md (或 AGENTS.md)
       ├─ Agent Identity: BackendBot 的 instructions
       ├─ Commands: multica CLI 完整参考
       ├─ Repos: 可用仓库列表
       ├─ Workflow: comment-triggered 工作流
       │   "1. multica issue get <id> --output json"
       │   "2. multica issue comment list <id> --output json"
       │   "3. 找到触发评论 (ID: xxx)"
       │   "4. multica issue comment add <id> --parent <comment-id> --content ..."
       ├─ Skills: code-review, testing
       └─ Mentions, Attachments, Output Guidelines
```

#### Phase 5: 启动执行（Execute）

```
1. BuildPrompt():
   "You are running as a local coding agent...
    Your assigned issue ID is: <uuid>
    Start by running `multica issue get <uuid> --output json`"

2. 设置环境变量 + PATH 注入

3. agent.New("claude", config) → claudeBackend

4. backend.Execute(ctx, prompt, opts):
   ├─ 启动: claude -p --output-format stream-json --strict-mcp-config
   ├─ 工作目录: {workdir}
   ├─ 模型: 来自 Agent 配置或默认
   └─ 如果有 prior_session_id: --resume {sessionID}

5. Session 启动:
   ├─ Messages channel: 流式事件
   └─ Result channel: 最终结果
```

**此时 Agent CLI 内部的 Agent Loop 开始运行**：

```
Agent 内部循环 (由 Claude Code/Codex/etc. 管理):
  Think: 分析任务，规划步骤
  Act:   调用工具 (multica CLI, 文件操作, git)
  Observe: 读取工具输出
  Repeat...
```

#### Phase 6: 消息流式传输（Stream）

**Daemon 的消息转发 goroutine**：

```
session.Messages channel → 批量累积 → ReportTaskMessages API

每条消息包含:
  seq: 自增序列号
  type: text / thinking / tool-use / tool-result / error
  content / tool / input / output: 具体内容
```

**Server 端处理**：
1. 持久化消息到数据库
2. 通过 EventBus 广播 `task:message` 事件
3. WebSocket Hub 广播到 workspace room

**前端实时渲染**：
```
WS event: task:message
  → TanStack Query cache invalidation
  → Issue 详情页的 Task Card 更新
  → 实时显示 Agent 的思考、工具调用、执行结果
```

用户在 Issue 详情页能看到 Agent 的每一步操作：正在思考什么、调用了什么工具、工具返回了什么结果。

#### Phase 7: 完成（Complete）

**Agent 完成工作后**：

```
1. Session.Result 返回:
   ├─ status: "completed" / "failed" / "blocked"
   ├─ output: Agent 的最终输出文本
   ├─ session_id: 可用于下次恢复
   ├─ usage: token 用量 (按模型分组)
   └─ duration_ms: 执行时长

2. Daemon 处理结果:
   ├─ ReportTaskUsage() → 记录 token 消耗
   └─ CompleteTask():
       ├─ 任务状态 → completed
       ├─ Agent 输出作为评论发布到 Issue
       │   (author_type = 'agent', author_id = BackendBot)
       ├─ Agent 状态 → idle (reconcileAgentStatus)
       ├─ 保存 session_id + work_dir 到数据库 (供后续恢复)
       └─ 发布 task:completed 事件

3. 事件传播:
   EventBus → Listeners:
   ├─ WebSocket: BroadcastToWorkspace(task:completed)
   ├─ Notification: 为 Issue 订阅者创建 inbox_item
   │   "BackendBot completed task on MUL-117"
   └─ Activity: 记录 activity_log
```

#### Phase 8: 通知与同步（Notify）

```
Server → WebSocket → Frontend:

1. task:completed → Issue 详情页更新 Task Card 状态
2. comment:created → 新评论出现在评论列表 (Agent 的输出)
3. agent:status → Agent 状态从 working 变为 idle
4. inbox:new → Issue 订阅者收到通知
5. activity:created → 活动日志记录
```

**Frontend 的响应**：

```
use-realtime-sync hook 订阅所有 WS 事件:
  ├─ onIssueUpdated → 精确更新 cache 中的 issue 数据
  ├─ onCommentCreated → 追加评论到 cache
  ├─ agent:status → 更新 Agent 列表和详情页
  ├─ task:completed → 更新 Task Card
  ├─ inbox:new → 触发 inbox 列表 refetch
  └─ 100ms debounce 避免 bulk 操作导致的重复更新
```

### 3.2 错误与韧性（Resilience）

**任务失败路径**：

```
Agent 执行出错:
  1. Session.Result.status = "failed"
  2. FailTask() → 任务状态 = failed
  3. 错误信息作为系统评论发布到 Issue
  4. Agent 状态 reconcile → idle (可接受新任务)
  5. 发布 task:failed 事件 → 通知用户
```

**取消路径**：

```
用户取消 / Issue 被重新分配:
  1. CancelTask() → 任务状态 = cancelled
  2. Daemon 每 5s 轮询 GetTaskStatus
  3. 检测到 cancelled → context.Cancel()
  4. Agent CLI 进程被终止
  5. 结果被丢弃 (不上报 complete/fail)
```

**Stale 清理**（Runtime Sweeper，每 30s）：

```
1. Runtime 心跳超时 (>45s) → 标记 offline
2. Dispatched 任务 (>5min) → 标记 failed
3. Running 任务 (>2.5h) → 标记 failed
4. 所有受影响 Agent 状态 reconcile
```

### 3.3 三种任务类型的生命周期对比

```
                     Assignment          Comment Mention       Chat
                     ──────────────      ────────────────      ──────────
触发方式:            分配 Agent           @mention Agent       发送消息
入队函数:            EnqueueTaskForIssue  EnqueueTaskForMention EnqueueChatTask
Prompt:             "get issue..."       "get issue..."        "user message: ..."
Meta Skill 工作流:   完整 (status 管理)   只读 + 回复           交互式
输出方式:            Issue 评论           Issue 评论            Chat 回复
Session 复用:        支持 (同 agent+issue) 支持                 不适用
```

---

## 结语：设计哲学的总结

Multica 的多 Agent 编排架构体现了几条核心设计哲学：

**1. Agent 是一等公民，不是工具**。多态 Assignee 设计让 Agent 拥有和人类团队成员相同的身份模型 —— 可以被分配、可以创建、可以评论、可以被 @mention。这不是"调用 AI 工具"，而是"给 AI 团队成员分配工作"。

**2. Harness 管调度，Agent 管推理**。Multica 不实现 Think-Act-Observe 循环，它实现的是任务的入队、认领、环境装配、消息转发、结果收集。推理循环完全委托给 Agent CLI。这种分层让系统天然支持多种 Agent 后端。

**3. Context Engineering 重于 Prompt Engineering**。与其写一个复杂的 prompt，不如构建一个丰富的上下文环境：CLAUDE.md/AGENTS.md 提供完整的环境说明书，Skills 提供可插拔的领域知识，CLI 提供按需的数据检索能力。Agent 在一个信息充沛的环境中自主工作。

**4. 委托而非重新实现**。MCP 委托给 Agent CLI，Skill 发现委托给 Provider 的原生机制，推理循环委托给 Agent CLI。Multica 专注于它最擅长的事：任务编排、身份管理、环境隔离和实时通信。

**5. 隔离是安全的基础**。三层 Workspace 隔离（DB/Middleware/WebSocket）、每个任务独立的执行环境、独立的认证 Token、`FOR UPDATE SKIP LOCKED` 的并发安全 —— 这些不是附加功能，而是多 Agent 系统可靠运行的前提。
