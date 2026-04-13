# Codebase Structure

**Analysis Date:** 2026-04-13

## Directory Layout

```
multica/                          # Monorepo root
├── apps/                         # Application shells
│   ├── web/                      # Next.js web app (App Router, port 3000)
│   ├── desktop/                  # Electron desktop app (electron-vite)
│   └── docs/                     # Documentation site (Fumadocs)
├── packages/                     # Shared packages (internal, no pre-compilation)
│   ├── core/                     # Headless business logic (zero react-dom)
│   ├── ui/                       # Atomic UI components (zero business logic)
│   ├── views/                    # Shared business pages/components
│   ├── tsconfig/                 # Shared TypeScript configuration
│   └── eslint-config/            # Shared ESLint configuration
├── server/                       # Go backend
│   ├── cmd/                      # Command entry points
│   │   ├── server/               # HTTP server (main + router)
│   │   ├── multica/              # CLI tool (auth, config, daemon, etc.)
│   │   └── migrate/              # Database migration runner
│   ├── internal/                 # Private Go packages
│   │   ├── auth/                 # JWT, PAT hashing, CloudFront signing
│   │   ├── cli/                  # CLI config/credentials management
│   │   ├── daemon/               # Local agent runtime (task polling + execution)
│   │   ├── events/               # Synchronous event bus
│   │   ├── handler/              # HTTP request handlers
│   │   ├── logger/               # Structured logging setup
│   │   ├── mention/              # @mention expansion
│   │   ├── middleware/           # Chi middleware (auth, workspace, logging)
│   │   ├── realtime/             # WebSocket hub (workspace rooms)
│   │   ├── service/              # Background services (email, task dispatch)
│   │   ├── storage/              # S3 file storage
│   │   └── util/                 # Shared Go utilities
│   ├── migrations/               # SQL migrations (46 pairs, numbered)
│   └── pkg/                      # Public Go packages
│       ├── agent/                # Agent backend adapters (Claude, Codex, etc.)
│       ├── db/                   # Database access (sqlc generated + raw queries)
│       ├── protocol/             # WS event type constants
│       └── redact/               # Secret redaction utilities
├── e2e/                          # Playwright end-to-end tests
├── docker/                       # Docker entrypoint scripts
├── scripts/                      # Dev/CI helper scripts
├── docs/                         # Project documentation (plans, analysis)
├── package.json                  # Root monorepo config (pnpm + turbo scripts)
├── pnpm-workspace.yaml           # Workspace + catalog definitions
├── turbo.json                    # Turborepo task configuration
└── Makefile                      # Go build/dev orchestration
```

---

## Directory Purposes

### `apps/web/` — Next.js Web Application

Thin shell that wires Next.js routing to shared views. Uses App Router with route groups.

| Path | Purpose |
|------|---------|
| `app/layout.tsx` | Root layout: fonts, ThemeProvider, WebProviders |
| `app/(auth)/login/page.tsx` | Login page: wraps shared `LoginPage` with Google OAuth config |
| `app/(landing)/` | Public landing pages (homepage, about, changelog) |
| `app/(dashboard)/layout.tsx` | Dashboard shell: `DashboardLayout` + platform-specific slots |
| `app/(dashboard)/issues/page.tsx` | Issues list: renders `IssuesPage` from `@multica/views` |
| `app/(dashboard)/issues/[id]/page.tsx` | Issue detail: renders `IssueDetail` from `@multica/views` |
| `app/(dashboard)/inbox/page.tsx` | Inbox page |
| `app/(dashboard)/agents/page.tsx` | Agents page |
| `app/(dashboard)/projects/page.tsx` | Projects page |
| `app/(dashboard)/settings/page.tsx` | Settings page |
| `app/auth/callback/page.tsx` | Google OAuth callback handler |
| `platform/navigation.tsx` | **ONLY place** for `next/navigation` imports; creates `NavigationAdapter` |
| `components/web-providers.tsx` | `CoreProvider` wrapper with `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_WS_URL` |
| `components/theme-provider.tsx` | next-themes provider |
| `components/locale-sync.tsx` | Browser locale sync |
| `features/auth/auth-cookie.ts` | Cookie management for SSR auth state |
| `features/landing/` | Landing page components + i18n (web-only, not shared) |
| `test/` | Web-specific test setup |

**Pattern:** Every dashboard page is a thin "use client" wrapper that imports and renders a component from `@multica/views`. The page file handles framework-specific routing (dynamic params) but delegates all UI to shared packages.

### `apps/desktop/` — Electron Desktop Application

Multi-tab Electron app using electron-vite for build and react-router-dom for per-tab routing.

| Path | Purpose |
|------|---------|
| `src/main/index.ts` | Electron main process (window management, IPC) |
| `src/preload/index.ts` | Preload bridge (contextBridge) |
| `src/renderer/src/App.tsx` | Root: `CoreProvider` + auth gate → DesktopShell |
| `src/renderer/src/main.tsx` | React DOM entry |
| `src/renderer/src/routes.tsx` | **Route definitions** shared by all tabs (react-router-dom) |
| `src/renderer/src/platform/navigation.tsx` | **ONLY place** for `react-router-dom` navigation wiring |
| `src/renderer/src/stores/tab-store.ts` | Tab management (open/close/reorder, per-tab memory router) |
| `src/renderer/src/components/desktop-layout.tsx` | Desktop shell: sidebar + tab bar + content area |
| `src/renderer/src/components/tab-bar.tsx` | Draggable tab bar (dnd-kit) |
| `src/renderer/src/components/tab-content.tsx` | Per-tab RouterProvider wrapper |
| `src/renderer/src/pages/login.tsx` | Desktop-specific login page |
| `src/renderer/src/pages/issue-detail-page.tsx` | Issue detail with `useParams` from react-router-dom |
| `src/renderer/src/pages/project-detail-page.tsx` | Project detail with `useParams` |
| `src/renderer/src/hooks/` | Desktop-specific hooks (document title, tab sync, tab history) |
| `resources/` | App icons and assets |

### `packages/core/` — Headless Business Logic

All shared state, API communication, and business rules. Zero `react-dom`, zero `localStorage` direct access, zero UI libraries.

| Path | Purpose |
|------|---------|
| `index.ts` | Public entry: `useWorkspaceId`, `WorkspaceIdProvider`, `createQueryClient`, `QueryProvider` |
| `api/index.ts` | ApiClient singleton via Proxy (`api.listIssues(...)`) |
| `api/client.ts` | `ApiClient` class — all REST endpoints as typed methods |
| `api/ws-client.ts` | `WSClient` class — WebSocket connection with auto-reconnect |
| `auth/index.ts` | `useAuthStore` singleton proxy + `registerAuthStore` |
| `auth/store.ts` | `createAuthStore` factory (verifyCode, loginWithGoogle, logout) |
| `workspace/index.ts` | `useWorkspaceStore` singleton proxy + `registerWorkspaceStore` |
| `workspace/store.ts` | `createWorkspaceStore` factory (hydrate, switch, refresh) |
| `workspace/queries.ts` | TanStack Query options for workspaces, members, agents, skills |
| `workspace/mutations.ts` | Mutations for workspace/member CRUD |
| `workspace/hooks.ts` | `useCurrentWorkspaceId`, `useWorkspaceMembers` hooks |
| `chat/index.ts` | `useChatStore` singleton proxy + `registerChatStore` |
| `chat/store.ts` | `createChatStore` factory (open/close, session, timeline) |
| `chat/queries.ts` | Chat session/message query options |
| `chat/mutations.ts` | Send message, archive session mutations |
| `issues/index.ts` | Re-exports from queries, mutations, stores, ws-updaters |
| `issues/queries.ts` | Query key factory (`issueKeys`) + query options |
| `issues/mutations.ts` | All issue CRUD mutations (optimistic updates) |
| `issues/ws-updaters.ts` | WS event → cache update functions (`onIssueCreated`, etc.) |
| `issues/config/` | Status and priority configuration enums |
| `issues/stores/` | Client-side stores (view/filter, selection, draft, scope) |
| `inbox/queries.ts` | Inbox query options |
| `inbox/mutations.ts` | Inbox mutations (mark read, archive) |
| `inbox/ws-updaters.ts` | Inbox WS cache updaters |
| `projects/queries.ts` | Project query options |
| `projects/mutations.ts` | Project CRUD mutations |
| `projects/config.ts` | Project status/priority config |
| `runtimes/queries.ts` | Runtime query options (list, usage, activity) |
| `runtimes/mutations.ts` | Runtime mutations (ping, update) |
| `runtimes/hooks.ts` | `useRuntimeVersion` hook |
| `realtime/provider.tsx` | `WSProvider` — creates WSClient, passes to `useRealtimeSync` |
| `realtime/hooks.ts` | `useWSEvent`, `useWSReconnect` hooks |
| `realtime/use-realtime-sync.ts` | Central WS → Query cache sync (all event handlers) |
| `navigation/store.ts` | `useNavigationStore` — persisted last path |
| `modals/store.ts` | `useModalStore` — modal state (open/close, type, data) |
| `hooks.tsx` | `WorkspaceIdProvider` + `useWorkspaceId` (React Context) |
| `hooks/use-file-upload.ts` | File upload helper hook |
| `query-client.ts` | `createQueryClient` factory (staleTime: Infinity, gcTime: 10min) |
| `provider.tsx` | `QueryProvider` (QueryClientProvider + ReactQueryDevtools) |
| `logger.ts` | `createLogger(namespace)` factory |
| `utils.ts` | Shared utility functions |
| `constants/upload.ts` | Upload constraints (max size, allowed types) |
| `types/` | TypeScript type definitions (issue, agent, workspace, events, etc.) |
| `platform/core-provider.tsx` | `CoreProvider` — orchestrates all initialization |
| `platform/auth-initializer.tsx` | Boot-time auth + workspace hydration |
| `platform/storage.ts` | SSR-safe localStorage adapter (`defaultStorage`) |
| `platform/persist-storage.ts` | Zustand persist storage adapter |
| `platform/workspace-storage.ts` | Workspace-aware key namespacing + rehydration registry |
| `platform/storage-cleanup.ts` | Workspace storage cleanup on delete/remove |

### `packages/ui/` — Atomic UI Components

Pure UI primitives from shadcn (Base UI variant). Zero business logic, zero `@multica/core` imports.

| Path | Purpose |
|------|---------|
| `components/ui/` | ~60 shadcn components (button, dialog, sidebar, tabs, etc.) |
| `components/common/` | Shared compound components (actor-avatar, multica-icon, emoji-picker, etc.) |
| `markdown/` | Markdown rendering (react-markdown + shiki + remark-gfm) |
| `hooks/` | Shared UI hooks |
| `lib/utils.ts` | `cn()` utility (clsx + tailwind-merge) |
| `styles/tokens.css` | Design token definitions |
| `styles/base.css` | Base layer styles (scrollbar, keyframes) |
| `components.json` | shadcn configuration (Base UI variant, base-nova style) |

### `packages/views/` — Shared Business Pages

Full page components and domain-specific components. Zero `next/*`, zero `react-router-dom`, zero store definitions.

| Path | Purpose |
|------|---------|
| `navigation/context.tsx` | `NavigationProvider` + `useNavigation` (React Context) |
| `navigation/types.ts` | `NavigationAdapter` interface |
| `navigation/app-link.tsx` | Cross-platform link component |
| `layout/app-sidebar.tsx` | Sidebar with workspace switcher, nav items |
| `layout/dashboard-layout.tsx` | Main layout: sidebar + content + modals |
| `layout/dashboard-guard.tsx` | Auth + workspace check + `WorkspaceIdProvider` |
| `layout/use-dashboard-guard.ts` | Guard hook (redirect if unauthenticated) |
| `issues/components/issues-page.tsx` | Issues list page (board + list views) |
| `issues/components/issue-detail.tsx` | Issue detail page (description, comments, timeline) |
| `issues/components/board-view.tsx` | Kanban board view |
| `issues/components/list-view.tsx` | List view |
| `issues/components/comment-card.tsx` | Comment rendering with reactions |
| `issues/components/comment-input.tsx` | Comment editor with TipTap |
| `issues/hooks/` | Issue-specific hooks (useIssueTimeline, etc.) |
| `issues/utils/` | Filter, sort, redact utilities |
| `agents/` | Agent management page + agent detail tabs |
| `inbox/` | Inbox page + notification components |
| `chat/` | Chat FAB + window + message list + input |
| `projects/` | Project list + detail pages |
| `my-issues/` | My Issues page (user-scoped view) |
| `runtimes/` | Runtime management page + activity charts |
| `skills/` | Skill management page |
| `settings/` | Settings page with tabs (account, workspace, members, etc.) |
| `search/` | Command palette search (cmdk) |
| `editor/` | TipTap rich text editor (description, title, content) |
| `modals/registry.tsx` | Modal registry (renders active modal by name) |
| `modals/create-issue.tsx` | Create issue modal |
| `modals/create-workspace.tsx` | Create workspace modal |
| `auth/` | Shared login page component |
| `common/` | Shared view-level components (actor-avatar, markdown) |
| `workspace/` | Workspace avatar component |
| `test/` | Shared test utilities |

### `server/` — Go Backend

| Path | Purpose |
|------|---------|
| `cmd/server/main.go` | Server entry point: DB connect, event bus, WS hub, router, graceful shutdown |
| `cmd/server/router.go` | Chi router setup: all routes + middleware chain |
| `cmd/multica/main.go` | CLI entry point (cobra) |
| `cmd/multica/cmd_*.go` | CLI subcommands (auth, config, daemon, issue, workspace, etc.) |
| `cmd/migrate/main.go` | Migration runner |
| `internal/handler/handler.go` | Handler struct + shared helpers (publish, resolveActor, loadIssueForUser) |
| `internal/handler/issue.go` | Issue CRUD handlers |
| `internal/handler/agent.go` | Agent CRUD + task handlers |
| `internal/handler/workspace.go` | Workspace + member handlers |
| `internal/handler/inbox.go` | Inbox handlers |
| `internal/handler/comment.go` | Comment CRUD handlers |
| `internal/handler/daemon.go` | Daemon register/deregister/heartbeat |
| `internal/handler/chat.go` | Chat session handlers |
| `internal/handler/file.go` | File upload handler |
| `internal/handler/project.go` | Project CRUD handlers |
| `internal/handler/skill.go` | Skill CRUD handlers |
| `internal/handler/runtime.go` | Runtime list/delete handlers |
| `internal/handler/runtime_ping.go` | Runtime ping handlers |
| `internal/handler/runtime_update.go` | Runtime update handlers |
| `internal/handler/search_test.go` | Search handler tests |
| `internal/handler/subscriber.go` | Subscriber handlers |
| `internal/handler/activity.go` | Activity/timeline handlers |
| `internal/handler/reaction.go` | Comment reaction handlers |
| `internal/handler/issue_reaction.go` | Issue reaction handlers |
| `internal/handler/personal_access_token.go` | PAT handlers |
| `internal/middleware/auth.go` | JWT + PAT auth middleware |
| `internal/middleware/workspace.go` | Workspace membership/role middleware |
| `internal/middleware/request_logger.go` | Request logging middleware |
| `internal/middleware/cloudfront.go` | CloudFront cookie refresh |
| `internal/middleware/daemon_auth.go` | Daemon token auth |
| `internal/events/bus.go` | Synchronous event bus (Publish/Subscribe/SubscribeAll) |
| `internal/realtime/hub.go` | WebSocket hub (workspace rooms, broadcast) |
| `internal/auth/` | JWT signing, PAT hashing, CloudFront signer |
| `internal/daemon/` | Daemon main loop + agent execution |
| `internal/daemon/execenv/` | Execution environment setup |
| `internal/daemon/repocache/` | Git repo caching for agent tasks |
| `internal/daemon/usage/` | Usage tracking |
| `internal/service/email.go` | Email service (Resend) |
| `internal/service/task.go` | Task dispatch service |
| `internal/storage/s3.go` | S3 file storage |
| `internal/mention/expand.go` | @mention expansion logic |
| `internal/logger/` | Structured logging init |
| `internal/util/` | UUID/text conversion helpers |
| `internal/cli/` | CLI config/credentials management |
| `pkg/agent/agent.go` | Agent Backend interface + Session/Message types |
| `pkg/agent/claude.go` | Claude Code adapter |
| `pkg/agent/codex.go` | Codex adapter |
| `pkg/agent/opencode.go` | OpenCode adapter |
| `pkg/agent/openclaw.go` | OpenClaw adapter |
| `pkg/agent/hermes.go` | Hermes adapter |
| `pkg/agent/version.go` | Version detection |
| `pkg/db/queries/*.sql` | Hand-written SQL queries (sqlc input) |
| `pkg/db/generated/*.go` | sqlc-generated Go code (models + query functions) |
| `pkg/protocol/events.go` | WS event type string constants |
| `pkg/protocol/messages.go` | WS message struct definitions |
| `pkg/redact/` | Secret redaction |
| `migrations/` | 46 pairs of SQL migration files (up/down) |

### `e2e/` — End-to-End Tests

| Path | Purpose |
|------|---------|
| `auth.spec.ts` | Authentication flow tests |
| `issues.spec.ts` | Issue CRUD tests |
| `comments.spec.ts` | Comment CRUD tests |
| `navigation.spec.ts` | Navigation/routing tests |
| `settings.spec.ts` | Settings page tests |
| `fixtures.ts` | `TestApiClient` fixture (data setup/teardown) |
| `helpers.ts` | Test helpers (login, create API) |

### `packages/tsconfig/` — Shared TypeScript Config

| File | Purpose |
|------|---------|
| `base.json` | Base config (strict, ES2022, bundler resolution) |
| `react-library.json` | Extends base for React packages (JSX, DOM types) |

### `packages/eslint-config/` — Shared ESLint Config

| File | Purpose |
|------|---------|
| `base.js` | Base JS/TS rules |
| `react.js` | React-specific rules |
| `next.js` | Next.js-specific rules |

---

## Key File Locations

### Entry Points

| File | Purpose |
|------|---------|
| `apps/web/app/layout.tsx` | Next.js root layout — fonts, ThemeProvider, WebProviders |
| `apps/desktop/src/renderer/src/main.tsx` | Electron renderer entry — React DOM mount |
| `apps/desktop/src/main/index.ts` | Electron main process — window creation |
| `server/cmd/server/main.go` | Go server entry — DB, event bus, WS hub, HTTP server |
| `server/cmd/multica/main.go` | CLI entry — cobra commands |
| `packages/core/platform/core-provider.tsx` | Frontend initialization orchestrator |

### Configuration

| File | Purpose |
|------|---------|
| `package.json` | Root monorepo scripts (dev, build, test, lint) |
| `pnpm-workspace.yaml` | Workspace paths + catalog version pinning |
| `turbo.json` | Task dependency graph (build, dev, typecheck, test, lint) |
| `Makefile` | Go build/dev commands, DB management |
| `server/go.mod` | Go module + dependency versions |
| `apps/web/next.config.*` | Next.js config (may exist as .mjs or .ts) |
| `apps/desktop/electron.vite.config.ts` | electron-vite config |
| `packages/ui/components.json` | shadcn config (Base UI variant) |

### Core Logic

| File | Purpose |
|------|---------|
| `packages/core/api/client.ts` | All REST API methods (issues, agents, inbox, etc.) |
| `packages/core/api/ws-client.ts` | WebSocket client with auto-reconnect |
| `packages/core/realtime/use-realtime-sync.ts` | Central WS → Query cache sync |
| `packages/core/issues/queries.ts` | Query key factory + query options |
| `packages/core/issues/mutations.ts` | Optimistic mutation hooks |
| `packages/core/auth/store.ts` | Auth state management |
| `packages/core/workspace/store.ts` | Workspace state management |
| `server/internal/handler/handler.go` | Handler struct + shared helpers |
| `server/cmd/server/router.go` | Complete route definitions |
| `server/internal/events/bus.go` | Event bus implementation |
| `server/internal/realtime/hub.go` | WebSocket hub implementation |

### Testing

| File | Purpose |
|------|---------|
| `packages/core/vitest.config.ts` | Vitest config for core (Node env) |
| `packages/views/vitest.config.ts` | Vitest config for views (jsdom env) |
| `apps/web/vitest.config.ts` | Vitest config for web (jsdom + framework mocks) |
| `e2e/fixtures.ts` | Playwright TestApiClient |
| `e2e/helpers.ts` | E2E test helpers |
| `server/internal/handler/*_test.go` | Go handler tests |
| `server/internal/realtime/hub_test.go` | WS hub tests |
| `server/internal/events/bus_test.go` | Event bus tests |

---

## Naming Conventions

### Files

| Pattern | Example | Location |
|---------|---------|----------|
| `kebab-case.tsx` for components | `issues-page.tsx`, `comment-card.tsx` | `packages/views/` |
| `kebab-case.ts` for logic | `selection-store.ts`, `ws-updaters.ts` | `packages/core/` |
| `kebab-case.go` for Go files | `handler.go`, `issue.go` | `server/` |
| `*.sql` for sqlc queries | `issue.sql`, `agent.sql` | `server/pkg/db/queries/` |
| `*.spec.ts` for E2E tests | `issues.spec.ts`, `auth.spec.ts` | `e2e/` |
| `*.test.tsx` for unit/component tests | `issues-page.test.tsx` | Colocated with source |

### Directories

| Pattern | Example | Description |
|---------|---------|-------------|
| Domain directories | `issues/`, `agents/`, `inbox/` | Organized by business domain |
| Component subdirectories | `components/`, `hooks/`, `utils/` | Standard sub-structure per domain |
| Route groups (Next.js) | `(auth)/`, `(dashboard)/`, `(landing)/` | App Router route groups |
| Platform directories | `platform/` | Framework-specific adapters (per app) |

---

## Where to Add New Code

### New Feature (e.g., "Labels")

```
1. Type definitions:     packages/core/types/label.ts
                         → export from packages/core/types/index.ts
2. API methods:          Add to packages/core/api/client.ts
3. Query options:        packages/core/labels/queries.ts
4. Mutations:            packages/core/labels/mutations.ts
5. WS updaters:          packages/core/labels/ws-updaters.ts (if real-time)
6. Exports:              Add to packages/core/package.json exports
7. UI page:              packages/views/labels/components/labels-page.tsx
8. Export page:          packages/views/labels/index.ts + package.json exports
9. Web route:            apps/web/app/(dashboard)/labels/page.tsx
10. Desktop route:       Add to apps/desktop/src/renderer/src/routes.tsx
11. Web sidebar:         Update packages/views/layout/app-sidebar.tsx
12. Backend handler:     server/internal/handler/label.go
13. Backend SQL:         server/pkg/db/queries/label.sql
14. Regenerate:          Run `make sqlc` to generate Go code
15. Router:              Add route to server/cmd/server/router.go
16. Migration:           server/migrations/XXX_labels.up/down.sql
```

### New Component (UI primitive)

```
1. Install via shadcn:   pnpm ui:add <component>
                         → packages/ui/components/ui/<component>.tsx
2. If custom:            Create in packages/ui/components/ui/
3. Use in views:         Import from @multica/ui/components/ui/<component>
```

### New Shared Hook (business logic)

```
1. Create:               packages/core/hooks/use-<name>.ts
2. Export:               Add to packages/core/package.json exports as "./hooks/<name>"
3. Use in views:         Import from @multica/core/hooks/<name>
```

### New Page (shared between web and desktop)

```
1. Component:            packages/views/<domain>/components/<domain>-page.tsx
2. Export:               packages/views/<domain>/index.ts
3. Package exports:      Add to packages/views/package.json exports
4. Web route:            apps/web/app/(dashboard)/<domain>/page.tsx
                         — "use client"; import and render the shared component
5. Desktop route:        Add entry to apps/desktop/src/renderer/src/routes.tsx
6. Sidebar nav:          Update packages/views/layout/app-sidebar.tsx
```

### New Zustand Store

```
1. Factory + store:      packages/core/<domain>/store.ts
                         — Use create<State>((set) => ({ ... }))
2. Singleton proxy:      packages/core/<domain>/index.ts
                         — Proxy pattern (see auth/index.ts for template)
3. Register in init:     packages/core/platform/core-provider.tsx
                         — Add to initCore()
4. If workspace-scoped:  Use createWorkspaceAwareStorage for persist
```

### New Backend Handler

```
1. SQL queries:          server/pkg/db/queries/<domain>.sql
2. Generate:             make sqlc
3. Handler:              server/internal/handler/<domain>.go
4. Register routes:      server/cmd/server/router.go
5. Event types:          server/pkg/protocol/events.go (if WS events needed)
6. Event listeners:      server/cmd/server/main.go (registerListeners, etc.)
```

---

## Special Directories

| Directory | Purpose | Generated | Committed |
|-----------|---------|-----------|-----------|
| `server/pkg/db/generated/` | sqlc output (Go code from SQL queries) | Yes (`make sqlc`) | Yes |
| `server/migrations/` | Database schema migrations | No | Yes |
| `.next/` | Next.js build output | Yes | No (gitignored) |
| `apps/desktop/out/` | Electron build output | Yes | No (gitignored) |
| `node_modules/` | npm dependencies | Yes (`pnpm install`) | No |
| `.planning/` | GSD planning documents | No | Yes |
| `docs/` | Project documentation/plans | No | Yes |

---

*Structure analysis: 2026-04-13*
