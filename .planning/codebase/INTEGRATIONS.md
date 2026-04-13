# External Integrations

**Analysis Date:** 2026-04-13

## APIs & External Services

**Email (Transactional):**
- Resend (`resend-go/v2` v2.28.0) — Sends verification codes for email authentication.
  - SDK/Client: `github.com/resend/resend-go/v2`
  - Config: `RESEND_API_KEY` env var, `RESEND_FROM_EMAIL` env var (default: `noreply@multica.ai`)
  - Implementation: `server/internal/service/email.go`
  - Fallback: When `RESEND_API_KEY` is not set, verification codes are printed to stdout instead of emailed.

**File Storage:**
- AWS S3 (`aws-sdk-go-v2/service/s3` v1.97.3) — Uploads and stores user files (attachments, avatars).
  - SDK/Client: AWS SDK Go v2
  - Config: `S3_BUCKET`, `S3_REGION` (default: `us-west-2`), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
  - Implementation: `server/internal/storage/s3.go`
  - CDN: Optional CloudFront distribution via `CLOUDFRONT_DOMAIN`
  - Fallback: When `S3_BUCKET` is not set, file upload is disabled.

**CDN (Content Delivery):**
- AWS CloudFront — Signed URLs and signed cookies for private file access.
  - Implementation: `server/internal/auth/cloudfront.go`
  - Key storage: AWS Secrets Manager (`CLOUDFRONT_PRIVATE_KEY_SECRET`) or base64 env var fallback (`CLOUDFRONT_PRIVATE_KEY`)
  - Config: `CLOUDFRONT_KEY_PAIR_ID`, `CLOUDFRONT_DOMAIN`, `COOKIE_DOMAIN`

**Secrets Management:**
- AWS Secrets Manager — Stores CloudFront RSA private key for signed URL generation.
  - SDK/Client: `aws-sdk-go-v2/service/secretsmanager` v1.41.5
  - Config: `CLOUDFRONT_PRIVATE_KEY_SECRET` (secret name or ARN)
  - Implementation: `server/internal/auth/cloudfront.go` (`loadKeyFromSecretsManager()`)

**OAuth (Google):**
- Google OAuth 2.0 — "Sign in with Google" authentication flow.
  - Config: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
  - Flow: Frontend obtains authorization code, sends to backend `/auth/google`, backend exchanges for user info.
  - Implementation: `packages/core/api/client.ts` (`googleLogin()`), server handler in `server/internal/handler/`

## Data Flow Diagram: Authentication

```mermaid
sequenceDiagram
    participant User
    participant Frontend as Frontend (Web/Desktop)
    participant API as Go Backend (Chi)
    participant DB as PostgreSQL
    participant Resend as Resend Email
    participant Google as Google OAuth

    alt Email Login
        User->>Frontend: Enter email
        Frontend->>API: POST /auth/send-code
        API->>Resend: Send verification email
        Resend-->>User: Email with 6-digit code
        User->>Frontend: Enter code
        Frontend->>API: POST /auth/verify-code
        API->>DB: Verify code, create/get user
        API-->>Frontend: JWT token + user
    else Google Login
        User->>Frontend: Click "Sign in with Google"
        Frontend->>Google: OAuth redirect
        Google-->>Frontend: Authorization code
        Frontend->>API: POST /auth/google (code + redirect_uri)
        API->>Google: Exchange code for user info
        API->>DB: Create/get user
        API-->>Frontend: JWT token + user
    end

    Frontend->>Frontend: Store JWT in StorageAdapter
    Frontend->>Frontend: Set token on ApiClient
```

The diagram above shows the two authentication paths. The backend issues a JWT token (HMAC-SHA256 signed with `JWT_SECRET`). The frontend stores the token via a platform-specific `StorageAdapter` (`packages/core/platform/storage.ts` for web, Electron-specific for desktop) and sets it on the `ApiClient` instance for all subsequent requests.

## Data Storage

**Databases:**
- PostgreSQL 17 with pgvector extension
  - Image: `pgvector/pgvector:pg17`
  - Connection: `DATABASE_URL` env var (default: `postgres://multica:multica@localhost:5432/multica?sslmode=disable`)
  - Client: `pgx/v5` (v5.8.0) with connection pooling via `pgxpool`
  - Query builder: sqlc — generates type-safe Go code from raw SQL files in `server/pkg/db/queries/`
  - Generated code output: `server/pkg/db/generated/`
  - Migrations: Sequential numbered SQL files in `server/migrations/` (37 migration pairs as of analysis date)
  - Migration tool: Custom `server/cmd/migrate/main.go`

```mermaid
flowchart LR
    subgraph "Backend (Go)"
        H[Handler] --> Q[db.Queries]
        Q --> G[Generated Go code]
    end

    subgraph "SQL Source"
        S[server/pkg/db/queries/*.sql] -->|"sqlc generate"| G
        M[server/migrations/*.sql] -->|"schema reference"| G
    end

    subgraph "Database"
        P[(PostgreSQL 17<br/>+ pgvector)]
    end

    Q -->|"pgx/v5 pool"| P
```

sqlc generates Go structs and query functions from annotated SQL files. The `db.Queries` struct is created via `db.New(pool)` and injected into handlers. Connection pooling is handled by `pgxpool.New()`.

**File Storage:**
- AWS S3 (production) / disabled (development without config)
- Files are uploaded via `POST /api/upload-file` (multipart form data)
- Served via CloudFront signed URLs/cookies in production

**Caching:**
- None (server-side). TanStack Query acts as the client-side cache with `staleTime: Infinity` and WS-driven invalidation.

## Frontend-Backend Communication

### REST API

```mermaid
flowchart TD
    subgraph "Frontend"
        CC[ApiClient<br/>packages/core/api/client.ts]
        TQ[TanStack Query]
    end

    subgraph "Backend (Go)"
        CHI[Chi Router v5]
        MW[Middleware Stack]
        HD[Handlers]
    end

    CC -->|"HTTP JSON<br/>Bearer JWT"| MW
    MW --> CHI
    CHI --> HD

    subgraph "Request Flow"
        direction TB
        R1[Request Logger] --> R2[CORS]
        R2 --> R3[Auth Middleware]
        R3 --> R4[Workspace Member Check]
        R4 --> R5[Handler]
    end
```

**REST API Details:**
- Transport: HTTP with JSON bodies
- Auth: `Authorization: Bearer <JWT>` header
- Multi-tenancy: `X-Workspace-ID` header routes requests to the correct workspace
- Request tracing: `X-Request-ID` header (UUID generated client-side, 8-char prefix)
- CORS: Configurable via `CORS_ALLOWED_ORIGINS` or `FRONTEND_ORIGIN` env var. Defaults to `localhost:3000`, `localhost:5173`, `localhost:5174`.
- Client implementation: `packages/core/api/client.ts` (`ApiClient` class)

**Key API Route Groups** (from `server/cmd/server/router.go`):
- `/auth/*` — Public auth endpoints (send-code, verify-code, google)
- `/ws` — WebSocket endpoint
- `/api/me`, `/api/upload-file` — User-scoped (auth required, no workspace)
- `/api/workspaces/*` — Workspace management (role-based access)
- `/api/issues/*` — Issue CRUD, comments, timeline, reactions (workspace member required)
- `/api/agents/*` — Agent management
- `/api/runtimes/*` — Runtime management, ping, update
- `/api/skills/*` — Skill management
- `/api/inbox/*` — Inbox items
- `/api/chat/sessions/*` — Chat sessions
- `/api/projects/*` — Project management
- `/api/daemon/*` — Daemon API (agent runtime communication)

### Real-Time Updates (WebSocket)

```mermaid
sequenceDiagram
    participant FE as Frontend (WSProvider)
    participant WS as WSClient
    participant Hub as Hub (Go)
    participant Bus as Event Bus
    participant Handler as Handler

    Note over FE,Hub: Connection Setup
    FE->>WS: new WSClient(wsUrl)
    WS->>Hub: ws://host/ws?token=JWT&workspace_id=ID
    Hub->>Hub: Validate JWT + workspace membership
    Hub-->>WS: Connection established

    Note over Handler,Hub: Server-side event dispatch
    Handler->>Bus: Emit event (e.g., issue:updated)
    Bus->>Hub: BroadcastToWorkspace(workspaceID, message)
    Hub->>WS: JSON message {type, payload, actor_id}

    Note over FE: Client-side cache update
    WS->>FE: onmessage → dispatch to handlers
    FE->>FE: useRealtimeSync → invalidate TanStack Query
    FE->>FE: Query refetch → UI updates

    Note over FE,Hub: Reconnection
    WS->>WS: onclose → reconnect in 3s
    WS->>Hub: Reconnect with same token
    Hub-->>WS: Connection restored
    WS->>FE: onReconnect callback
    FE->>FE: Invalidate ALL queries → refetch
```

**WebSocket Implementation Details:**

- **Server side** (`server/internal/realtime/hub.go`):
  - `Hub` manages connections organized by workspace rooms (`map[workspaceID]map[*Client]bool`)
  - `BroadcastToWorkspace()` sends messages to all clients in a workspace
  - `SendToUser()` sends to specific user across workspace boundaries
  - `Broadcast()` sends to all connected clients (daemon events)
  - Auth: JWT or PAT (`mul_` prefix) token validation on upgrade
  - Membership check: verifies user belongs to the workspace before allowing connection

- **Client side** (`packages/core/api/ws-client.ts`):
  - `WSClient` class with auto-reconnect (3s delay)
  - Event-based subscription: `ws.on(eventType, handler)` returns unsubscribe function
  - `onAny()` handler for catch-all message processing
  - `onReconnect()` callback for full data refetch after reconnection

- **Event Bus** (`server/internal/events/`):
  - Internal Go event bus decouples handlers from WebSocket broadcasting
  - Handlers emit events after database writes, listeners forward to the Hub

- **Realtime sync** (`packages/core/realtime/use-realtime-sync.ts`):
  - Centralized hook that subscribes to all WS events
  - Uses "WS as invalidation signal" pattern: events trigger TanStack Query `invalidateQueries()` rather than writing to stores directly
  - 100ms debounce per event prefix prevents rapid-fire refetches during bulk operations
  - Side-effect handlers: workspace deletion, member removal trigger toast notifications and workspace switching

**WS Event Types** (prefix-based):
- `issue:*` — Issue CRUD events
- `comment:*` — Comment events
- `activity:*` — Timeline activity events
- `reaction:*` / `issue_reaction:*` — Reaction events
- `subscriber:*` — Issue subscriber events
- `inbox:*` — Inbox notification events
- `agent:*` — Agent configuration changes
- `member:*` — Workspace member changes
- `workspace:*` — Workspace updates/deletion
- `skill:*` — Skill changes
- `project:*` — Project changes
- `daemon:*` — Runtime heartbeat, registration, task progress

## Authentication Flow

**Architecture:**

```mermaid
flowchart TD
    subgraph "Auth Layer"
        JWT[JWT Auth<br/>golang-jwt/jwt/v5]
        PAT[PAT Auth<br/>mul_ prefix tokens]
        DAEMON[Daemon Auth<br/>mdt_ prefix tokens]
        CF[CloudFront Signer<br/>Signed cookies/URLs]
    end

    subgraph "Token Storage"
        STORE[StorageAdapter<br/>packages/core/platform/storage.ts]
        COOKIE[HTTP-only CloudFront cookies]
    end

    subgraph "Middleware"
        MW[middleware.Auth]
        WS_MEMBER[middleware.RequireWorkspaceMember]
        WS_ROLE[middleware.RequireWorkspaceRole]
    end

    JWT --> MW
    PAT --> MW
    MW --> WS_MEMBER
    WS_MEMBER --> WS_ROLE
    CF --> COOKIE
```

**Token Types:**
1. **JWT** (user sessions) — HMAC-SHA256 signed, stored in `StorageAdapter` as `multica_token`. Created on login/verify. Validated by `middleware.Auth`.
2. **PAT** (`mul_` prefix) — Personal access tokens for API/CLI access. Stored hashed (SHA-256) in database. Created via `/api/tokens`. Supports WebSocket auth.
3. **Daemon token** (`mdt_` prefix) — Agent runtime authentication. Stored hashed in database.

**Auth Middleware Chain** (from `server/internal/middleware/`):
- `Auth(queries)` — Validates JWT or PAT from `Authorization: Bearer` header. Sets user ID in request context.
- `RequireWorkspaceMember(queries)` — Reads `X-Workspace-ID` header, verifies user membership.
- `RequireWorkspaceRole(queries, ...roles)` — Verifies user has specific workspace role (owner, admin).
- `RefreshCloudFrontCookies(cfSigner)` — Refreshes CloudFront signed cookies on every authenticated request.

**Client-side auth** (`packages/core/auth/store.ts`):
- `createAuthStore()` — Zustand factory that takes `ApiClient` + `StorageAdapter` + callbacks
- `initialize()` — Reads token from storage, validates with `GET /api/me`, clears on failure
- `verifyCode()` / `loginWithGoogle()` — Stores JWT token and calls `onLogin` callback
- `logout()` — Clears token and workspace ID from storage, calls `onLogout` callback
- Singleton pattern: `registerAuthStore()` + `useAuthStore` Proxy for global access

## Monitoring & Observability

**Error Tracking:**
- Not detected (no Sentry, Datadog, or similar integration).

**Logging:**
- Backend: Go `log/slog` structured logging with `lmittmann/tint` handler. Custom `RequestLogger` middleware logs request method, path, status, duration.
- Frontend: Custom console logger (`packages/core/logger.ts`) with namespace prefixes and color-coded levels (debug, info, warn, error).
- API client: Request/response logging with request IDs (8-char UUID prefix) and duration tracking.

## CI/CD & Deployment

**Hosting:**
- Self-hosted Docker deployment via `docker-compose.selfhost.yml` (PostgreSQL + Go backend + Next.js frontend).

**CI Pipeline:**
- GitHub Actions (`.github/workflows/ci.yml`)
  - Two parallel jobs: `frontend` and `backend`
  - **Frontend job**: Node 22, pnpm, runs `pnpm build && pnpm typecheck && pnpm test`
  - **Backend job**: Go 1.26.1, `pgvector/pgvector:pg17` PostgreSQL service container, runs migrations then `go test ./...`
  - Triggers: push to `main`, PRs to `main`
  - Concurrency: cancels in-progress runs for same PR/branch

**Release Pipeline:**
- GitHub Actions (`.github/workflows/release.yml`)
  - Triggers on tag push (`v*`)
  - Runs Go tests, then GoReleaser v2 for multi-platform builds
  - Targets: `darwin/amd64`, `darwin/arm64`, `linux/amd64`, `linux/arm64`
  - Publishes to GitHub Releases and Homebrew tap (`multica-ai/homebrew-tap`)
  - Secrets: `GITHUB_TOKEN`, `HOMEBREW_TAP_GITHUB_TOKEN`

**Docker:**
- `Dockerfile` — Multi-stage Go build (golang:1.26-alpine builder, alpine:3.21 runtime). Produces `server`, `multica`, `migrate` binaries.
- `Dockerfile.web` — Multi-stage Node build (node:22-alpine). Produces standalone Next.js output.
- `docker-compose.yml` — Development PostgreSQL only (pgvector:pg17).
- `docker-compose.selfhost.yml` — Full self-hosted stack (PostgreSQL + backend + frontend).

## Environment Configuration

**Required env vars (production):**
- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — HMAC secret for JWT signing (defaults to insecure dev value)
- `PORT` — Backend server port (default: 8080)
- `FRONTEND_ORIGIN` — CORS origin for the frontend

**Required env vars (self-hosting):**
All of the above plus:
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` — Google OAuth
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL` — Email delivery

**Optional env vars:**
- `S3_BUCKET`, `S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — File uploads
- `CLOUDFRONT_DOMAIN`, `CLOUDFRONT_KEY_PAIR_ID`, `CLOUDFRONT_PRIVATE_KEY_SECRET` — CDN
- `COOKIE_DOMAIN` — CloudFront cookie scope
- `CORS_ALLOWED_ORIGINS` — Additional CORS origins (comma-separated)
- `MULTICA_APP_URL` — Public app URL for CLI/daemon configuration

**Secrets location:**
- Local development: `.env` file (gitignored)
- Worktree: `.env.worktree` (gitignored, auto-generated)
- Production: Docker env vars or `.env` file
- CloudFront private key: AWS Secrets Manager or base64-encoded env var

## Webhooks & Callbacks

**Incoming:**
- None detected.

**Outgoing:**
- None detected (no webhook dispatch to external services).

## Platform Bridge Architecture

```mermaid
flowchart TD
    subgraph "Web App (Next.js)"
        WP[apps/web/platform/<br/>Next.js APIs, cookies, redirects]
        WC[apps/web/app/<br/>Next.js page routes]
    end

    subgraph "Desktop App (Electron)"
        DP[apps/desktop/src/renderer/src/platform/<br/>react-router-dom wiring]
        DR[apps/desktop/src/renderer/src/router.tsx]
    end

    subgraph "Shared Packages"
        CP[CoreProvider<br/>packages/core/platform/core-provider.tsx]
        CV[packages/views/<br/>Shared pages/components]
        CC[packages/core/<br/>Stores, queries, hooks]
        CU[packages/ui/<br/>Atomic components]
    end

    WP --> CP
    DP --> CP
    CP --> CC
    CP --> CV
    CV --> CU
    CV --> CC
```

The platform bridge pattern allows both apps to share all business logic and UI. Each app wraps its root with `<CoreProvider>` from `packages/core/platform/core-provider.tsx`, which initializes:
1. `ApiClient` — HTTP client with base URL and auth
2. Auth store — Zustand store for user/session state
3. Workspace store — Zustand store for current workspace
4. Chat store — Zustand store for chat UI state
5. `QueryProvider` — TanStack Query client (staleTime: Infinity, gcTime: 10m)
6. `AuthInitializer` — Loads token from storage, validates with API
7. `WSProvider` — WebSocket connection with realtime sync

Each app provides a `NavigationAdapter` implementation for framework-specific routing (Next.js `next/navigation` or Electron `react-router-dom`).

---

*Integration audit: 2026-04-13*
