/**
 * ip-pool settings bridge (docs/ip-pool.md §5.3) — the webServer routes the
 * settings card needs beyond the official settings transport: live pool
 * runtime state (/status, /models) and actions (/probe, /exit, /usage).
 * Settings reads/writes ride the official settings.describe/mutate RPCs, so
 * this bridge carries NO settings proxy surface.
 *
 * Split by concern: views.ts (read model), guard.ts (who may call),
 * handlers.ts (actions), routes.ts (HTTP framing). This module is the public
 * face the rest of the plugin imports.
 */

export {
  USAGE_SESSION_LIMIT,
  buildStatusView,
  buildUsageView,
  type ExitRowView,
  type PoolStatusView,
  type ProberView,
  type ProjectResolver,
  type SubscriptionView,
  type UsageDayView,
  type UsageProjectView,
  type UsageSessionView,
  type UsageView,
} from './views.ts'
export { bridgeRejection, isTrustedBridgeRequest, type ConnectionFence, type ConnectionReader } from './guard.ts'
export { makeBridgeHandlers, type BridgeHandlers, type BridgeResult, type ListLiveModels, type WritePin } from './handlers.ts'
export { IP_POOL_BRIDGE_PREFIX, makeBridgeRoutes, type BridgeRoute } from './routes.ts'
