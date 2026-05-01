import test from "node:test";
import assert from "node:assert/strict";
import { computeDesktopOnlyMode } from "../dist/ui/messaging/notificationEngine.js";

test("desktop-only mode when user active and policy allows desktop", () => {
  const mode = computeDesktopOnlyMode(
    "normal",
    {
      idleEnabled: true,
      idleThresholdSeconds: 120,
      alwaysDesktopWhenActive: true,
      dndActive: false,
    },
    {
      inTelegramConversation: false,
      uiActive: false,
      idleSeconds: 10,
    },
  );
  assert.equal(mode.desktopOnly, true);
});

test("suppressed in dnd for non-high priority", () => {
  const mode = computeDesktopOnlyMode(
    "normal",
    {
      idleEnabled: true,
      idleThresholdSeconds: 120,
      alwaysDesktopWhenActive: true,
      dndActive: true,
    },
    {
      inTelegramConversation: false,
      uiActive: false,
      idleSeconds: 999,
    },
  );
  assert.equal(mode.suppressedReason, "dnd");
});

test("high priority bypasses idle and dnd", () => {
  const mode = computeDesktopOnlyMode(
    "high",
    {
      idleEnabled: true,
      idleThresholdSeconds: 120,
      alwaysDesktopWhenActive: false,
      dndActive: true,
    },
    {
      inTelegramConversation: false,
      uiActive: true,
      idleSeconds: 1,
    },
  );
  assert.equal(mode.desktopOnly, false);
  assert.equal(mode.suppressedReason, undefined);
});
