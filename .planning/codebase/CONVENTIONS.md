# Coding Conventions

**Analysis Date:** 2026-04-13

## Naming Patterns

**Files:**
- kebab-case for all source files: `login-page.tsx`, `view-store.ts`, `ws-client.ts`
- Test files colocated: `login-page.test.tsx`, `persist-storage.test.ts`
- Go files: snake_case: `handler.go`, `handler_test.go`, `issue_reaction.go`
- Barrel/index files: `index.ts` in every module directory

**Functions & Hooks:**
- React hooks prefixed with `use`: `useCreateIssue()`, `useNavigationStore()`, `useWSEvent()`
- Factory functions prefixed with `create`: `createAuthStore()`, `createQueryClient()`, `createLogger()`
- Query option factories suffixed with `Options`: `issueListOptions()`, `issueDetailOptions()`
- Helper functions: camelCase, verb-first: `writeJSON()`, `writeError()`, `parseUUID()`
- Event handler functions: `handleSendCode`, `onLogin`, `onLogout`

**Variables:**
- camelCase for all variables: `wsId`, `issueKeys`, `mockSendCode`
- CONSTANTS in UPPER_SNAKE_CASE: `CLOSED_PAGE_SIZE`, `ALL_STATUSES`
- Private module-level singletons prefixed with `_`: `_api`, `_store`

**Types & Interfaces:**
- PascalCase for types and interfaces: `Issue`, `TimelineEntry`, `AuthState`
- Request types suffixed with `Request`: `CreateIssueRequest`, `UpdateIssueRequest`
- Response types suffixed with `Response`: `IssueResponse`, `LoginResponse`, `ListIssuesResponse`
- Generic props: PascalCase suffixed with `Props`: `CoreProviderProps`, `WSProviderProps`
- Store state interfaces suffixed with `State`: `IssueViewState`, `ModalStore`, `AuthState`

**Exported Constants:**
- Status/order arrays: `ALL_STATUSES`, `BOARD_STATUSES`, `STATUS_ORDER`, `PRIORITY_ORDER`
- Config maps: `STATUS_CONFIG`, `PRIORITY_CONFIG`
- Options arrays: `SORT_OPTIONS`, `CARD_PROPERTY_OPTIONS`

## Code Style

**Formatting:**
- ESLint via `@multica/eslint-config/react` (shared config)
- All packages use `eslint.config.mjs` with flat config format
- Config: `packages/core/eslint.config.mjs`, `packages/views/eslint.config.mjs`, `packages/ui/eslint.config.mjs`

```javascript
// packages/core/eslint.config.mjs
import reactConfig from "@multica/eslint-config/react";
export default [...reactConfig];
```

**TypeScript Strict Mode:**
Enabled in `packages/tsconfig/base.json` with all strict flags:
- `strict: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`
- `noImplicitReturns: true`
- `noUncheckedIndexedAccess: true`
- `isolatedModules: true`

All packages extend from `@multica/tsconfig/react-library.json` which adds `"jsx": "react-jsx"` and DOM libs.

**Comments:**
- English only in code comments
- Section separators use dashed comment blocks:

```typescript
// ---------------------------------------------------------------------------
// Section Name
// ---------------------------------------------------------------------------
```

- JSDoc-style comments on exported functions describing purpose
- Inline comments explain WHY, not WHAT

## Import Organization

**Order:**
1. React imports (`useState`, `useCallback`, `useMemo`, etc.)
2. Third-party libraries (`zustand`, `@tanstack/react-query`, `lucide-react`)
3. Internal packages (`@multica/core/*`, `@multica/ui/*`)
4. Relative imports (`./queries`, `../api`, `../../navigation`)
5. Types (using `import type`)

**Example from `packages/core/issues/mutations.ts`:**
```typescript
import { useState, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { issueKeys, CLOSED_PAGE_SIZE } from "./queries";
import { useWorkspaceId } from "../hooks";
import type { Issue, IssueReaction } from "../types";
import type { CreateIssueRequest, UpdateIssueRequest, ListIssuesResponse } from "../types";
import type { TimelineEntry, IssueSubscriber, Reaction } from "../types";
```

**Path Aliases:**
- Web app: `@/` maps to `apps/web/`, `@core/` maps to `apps/web/core/`
- Shared packages: deep imports via `@multica/core/api`, `@multica/core/issues/queries`
- No path aliases in shared packages -- they use relative imports

## Package Architecture & Boundaries

**Hard rules (enforced by convention, not build tools):**

| Package | Can Import | Cannot Import |
|---------|-----------|---------------|
| `packages/core/` | zustand, react-query, react | react-dom, localStorage, next/*, process.env |
| `packages/ui/` | React, CVA, base-ui | @multica/core, business logic |
| `packages/views/` | @multica/core, @multica/ui | next/*, react-router-dom, stores |
| `apps/web/platform/` | next/navigation, next/headers | (only place for Next.js APIs) |
| `apps/desktop/src/renderer/src/platform/` | react-router-dom | (only place for router APIs) |

**Internal Packages Pattern:**
All shared packages export raw `.ts`/`.tsx` files via `package.json` `exports` map. No pre-compilation. The consuming app's bundler compiles them directly.

```json
// packages/core/package.json exports
{
  "exports": {
    ".": "./index.ts",
    "./api": "./api/index.ts",
    "./auth": "./auth/index.ts",
    "./issues/queries": "./issues/queries.ts",
    "./issues/mutations": "./issues/mutations.ts"
  }
}
```

## Component Patterns

**React Components:**
- Functional components only, no class components
- `"use client"` directive on components using hooks/state (for Next.js compatibility)
- Components accept explicit props interfaces, not inline types
- Platform-specific UI injected via props/slots (`extra`, `topSlot`, `logo`, `onSuccess`)

**Page Component Pattern (`packages/views/`):**
```typescript
// packages/views/issues/components/issues-page.tsx
export function IssuesPage() {
  // Uses shared hooks from @multica/core
  // No next/* or react-router-dom imports
  // Navigation via useNavigation().push() or <AppLink>
}
```

**App Wiring Pattern (`apps/web/`):**
```typescript
// apps/web/app/(dashboard)/issues/page.tsx
// Next.js page file -- thin wrapper that provides platform context
```

## State Management

**Store Factory Pattern:**
Stores use a factory + singleton registration pattern for testability:

```typescript
// packages/core/auth/index.ts
export function createAuthStore(options: AuthStoreOptions) {
  return create<AuthState>((set) => ({ /* ... */ }));
}

let _store: AuthStoreInstance | null = null;
export function registerAuthStore(store: AuthStoreInstance) { _store = store; }

// Proxy-based hook so existing call-sites work transparently
export const useAuthStore: AuthStoreInstance = new Proxy(/* ... */);
```

**Store Types:**
- Factory-created stores: `auth`, `workspace`, `chat` (depend on API client, registered at boot)
- Module-level stores: `useIssueStore`, `useModalStore`, `useNavigationStore` (no dependencies)
- Context-scoped stores: `useIssueViewStore` (created per workspace via `ViewStoreProvider`)

**Query Pattern:**
Query options are factory functions returning `queryOptions()`:
```typescript
export function issueListOptions(wsId: string) {
  return queryOptions({
    queryKey: issueKeys.list(wsId),
    queryFn: async () => { /* ... */ },
  });
}
```

**Mutation Pattern:**
Mutations are optimistic by default with `onMutate`/`onError`/`onSettled`:
```typescript
export function useUpdateIssue() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ id, ...data }) => api.updateIssue(id, data),
    onMutate: ({ id, ...data }) => { /* optimistic update */ return { prevList, prevDetail }; },
    onError: (_err, _vars, ctx) => { /* rollback */ },
    onSettled: () => { qc.invalidateQueries({ queryKey: issueKeys.list(wsId) }); },
  });
}
```

## CSS Conventions

**Design Tokens:**
Use semantic tokens exclusively. Never hardcode Tailwind colors:
- `bg-background`, `text-foreground`, `border-border`
- `text-muted-foreground`, `text-destructive`, `text-warning`, `text-success`, `text-info`
- `hover:bg-accent`, `hover:bg-muted`

**shadcn Components:**
55 components in `packages/ui/components/ui/`. Installed via:
```bash
pnpm ui:add <component>   # Adds to packages/ui/components/ui/
```
All use Base UI primitives (`@base-ui/react`), not Radix.

**Component Styling:**
Use CVA (class-variance-authority) for variant-based components:
```typescript
const buttonVariants = cva("base-classes", {
  variants: { variant: { /* ... */ }, size: { /* ... */ } },
  defaultVariants: { variant: "default", size: "default" },
});
```

## API Conventions

**Client Architecture (`packages/core/api/client.ts`):**
- `ApiClient` class with `fetch<T>()` generic method
- Auth headers injected automatically: `Authorization: Bearer <token>`, `X-Workspace-ID: <id>`
- Error responses parsed from `{ error: string }` JSON body
- 401 responses trigger `onUnauthorized` callback
- 204 responses return `undefined`
- Request ID header: `X-Request-ID`

**REST Endpoints (Go backend):**
```
POST   /auth/send-code           # Send verification code
POST   /auth/verify-code         # Verify code, get JWT
POST   /auth/google              # Google OAuth
GET    /api/me                   # Current user
PATCH  /api/me                   # Update user
GET    /api/issues               # List issues (query params)
POST   /api/issues               # Create issue
GET    /api/issues/:id           # Get issue
PUT    /api/issues/:id           # Update issue
DELETE /api/issues/:id           # Delete issue
GET    /api/issues/:id/comments  # List comments
POST   /api/issues/:id/comments  # Create comment
GET    /api/issues/:id/timeline  # Activity timeline
POST   /api/issues/batch-update  # Batch update
POST   /api/issues/batch-delete  # Batch delete
GET    /api/workspaces           # List workspaces
POST   /api/workspaces           # Create workspace
```

**Error Format:**
```json
{ "error": "Human-readable message" }
```

**Multi-tenancy:**
All queries filter by `workspace_id`. Set via `X-Workspace-ID` header on every request.

## Go Backend Conventions

**Structure:**
- Handlers in `server/internal/handler/`
- Database queries via sqlc: `server/pkg/db/queries/` (SQL) -> `server/pkg/db/generated/` (Go code)
- Response types defined in handler files: `type IssueResponse struct`
- Helper functions: `writeJSON()`, `writeError()`, `parseUUID()`
- Standard Go conventions: gofmt, go vet

**Error Responses:**
```go
func writeError(w http.ResponseWriter, status int, msg string) {
    writeJSON(w, status, map[string]string{"error": msg})
}
```

## Logging

**Frontend:**
Custom logger in `packages/core/logger.ts` with namespace support:
```typescript
const logger = createLogger("api");
logger.info("-> GET /api/issues", { rid, duration: `${ms}ms` });
```
Levels: debug, info, warn, error. Color-coded console output with timestamps.

**Backend:**
Go standard `log/slog` structured logging.

## Error Handling

**Frontend:**
- API errors thrown as `Error` with server message
- Mutations: optimistic update -> rollback on error -> invalidate on settle
- UI errors displayed via `sonner` toast: `toast.error("message")`
- Component error boundaries for graceful degradation

**Backend:**
- `writeError(w, status, message)` for HTTP errors
- Error propagation via standard Go error returns
- 404 logged as warning, other errors as errors

## Git Conventions

**Commit Messages:**
Conventional format: `type(scope): description`

Examples from git log:
- `fix(views): show user-scoped done count on My Issues page`
- `docs: add v0.1.22 changelog with categorized sections`
- `feat(desktop): drag-to-reorder tabs via dnd-kit`

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`

**Branch Strategy:**
- `main` is the primary branch
- Feature branches merged via PR
- Agent branches: `agent/agent/<hash>`

---

*Convention analysis: 2026-04-13*
