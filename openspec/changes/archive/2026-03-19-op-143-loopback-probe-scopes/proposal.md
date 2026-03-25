## Why

`openclaw status --deep` reports two issues on local (loopback) deployments:

1. **Gateway: `unreachable (missing scope: operator.read)`**
2. **Last heartbeat: `unavailable`**

Both stem from the same root cause: the CLI probe deliberately disables device identity for loopback connections (`probe.ts:44-50`), but the gateway's handshake logic clears self-declared scopes for any client without a device identity (`message-handler.ts:537`). The probe connects successfully (token auth passes, `roleCanSkipDeviceIdentity` returns true), but with empty scopes — so any RPC requiring `operator.read` is rejected.

This means `openclaw status --deep` cannot fetch heartbeat data, config snapshots, or other operator-scoped information on the very machine running the gateway.

The `dangerouslyDisableDeviceAuth` config flag does NOT fix this — it only applies to Control UI browser connections, not CLI/probe connections.

Commit `f4fef64fc1` ("treat scope-limited probe RPC as degraded reachability") acknowledged this as a known limitation but did not resolve the underlying scope-clearing behavior for local probes.

## Root Cause Analysis

**Connection flow for `openclaw status --deep` on loopback:**

1. `probeGateway()` in `probe.ts` creates a `GatewayClient` with:
   - `scopes: ["operator.read"]`
   - `clientName: "cli"`, `mode: "probe"`
   - `deviceIdentity: null` (explicitly disabled for loopback — line 44-50)

2. Gateway handshake in `message-handler.ts`:
   - Token auth succeeds → `authOk = true`, `sharedAuthOk = true`
   - `evaluateMissingDeviceIdentity()` returns `{ kind: "allow" }` because `roleCanSkipDeviceIdentity("operator", true)` returns `true`
   - BUT line 537: `if (!device && (!isControlUi || decision.kind !== "allow")) { clearUnboundScopes(); }`
   - The probe is NOT `isControlUi`, so `(!isControlUi || ...)` is `true` → scopes are cleared

3. Connection succeeds with empty scopes → all `operator.read`-gated RPCs fail

**The key tension:** The gateway correctly prevents untrusted clients from self-declaring scopes, but the CLI probe IS a trusted client (it has the gateway token). On loopback, the threat model that device identity protects against (MitM, session hijacking) doesn't apply.

## What Changes

The `shouldSkipBackendSelfPairing` function in `handshake-auth-helpers.ts` already identifies trusted local backend clients and skips pairing for them. The scope-clearing logic in `message-handler.ts` should apply the same trust signal: if a client qualifies for `shouldSkipBackendSelfPairing`, its self-declared scopes should be preserved (not cleared).

### Option A: Extend scope preservation to backend self-pairing clients (recommended)

Modify the scope-clearing guard in `message-handler.ts:537` to also preserve scopes for clients that pass `shouldSkipBackendSelfPairing`:

```typescript
// Current (line 537):
if (!device && (!isControlUi || decision.kind !== "allow")) {
  clearUnboundScopes();
}

// Proposed:
const isBackendSelfPairing = shouldSkipBackendSelfPairing({
  connectParams,
  isLocalClient,
  hasBrowserOriginHeader,
  sharedAuthOk,
  authMethod,
});
if (!device && !isBackendSelfPairing && (!isControlUi || decision.kind !== "allow")) {
  clearUnboundScopes();
}
```

**However**, the probe uses `clientName: "cli"` and `mode: "probe"` — NOT `"gateway-client"` / `"backend"`. So `shouldSkipBackendSelfPairing` returns `false` for probes.

### Option B: Add probe-specific trust (alternative)

Add a new function `shouldPreserveScopesForLocalProbe` that recognizes the probe client as trusted when:

- `isLocalClient === true`
- `sharedAuthOk === true` (token matches)
- `connectParams.client.mode === "probe"`
- `authMethod === "token" || authMethod === "password"`

```typescript
function shouldPreserveScopesForLocalProbe(params: {
  connectParams: ConnectParams;
  isLocalClient: boolean;
  sharedAuthOk: boolean;
  authMethod: string | undefined;
}): boolean {
  return (
    params.isLocalClient &&
    params.sharedAuthOk &&
    params.connectParams.client.mode === GATEWAY_CLIENT_MODES.PROBE &&
    (params.authMethod === "token" || params.authMethod === "password")
  );
}
```

### Option C: Change probe to use backend mode (simplest)

In `probe.ts`, change the probe to use `mode: GATEWAY_CLIENT_MODES.BACKEND` and `clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT` for loopback connections, making it match the existing `shouldSkipBackendSelfPairing` path without any gateway changes.

```typescript
// In probeGateway(), for loopback:
const isLoopback = isLoopbackHost(new URL(opts.url).hostname);
const client = new GatewayClient({
  ...
  clientName: isLoopback ? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT : GATEWAY_CLIENT_NAMES.CLI,
  mode: isLoopback ? GATEWAY_CLIENT_MODES.BACKEND : GATEWAY_CLIENT_MODES.PROBE,
  ...
});
```

## Recommendation

**Option C** is the smallest, safest change — it makes the loopback probe behave identically to the gateway's own backend client, which already has established trust semantics. No changes to the gateway auth pipeline needed.

Options A and B are more principled but touch security-critical handshake logic and would need careful review and testing.

## Capabilities

### Modified Capabilities

- `cli-probe`: Loopback probe preserves `operator.read` scope via backend client identity

## Impact

- **Files:** `src/gateway/probe.ts` (Option C — ~5 lines changed)
- **Risk:** Low — loopback-only change, no impact on remote probes or security posture
- **Tests:** Existing `gateway-status` tests + new assertion for loopback probe scope preservation
- **Expected result:** `openclaw status --deep` shows `reachable` instead of `unreachable (missing scope: operator.read)`, and `Last heartbeat` shows actual data
