"use strict";

(function () {
  if (window.__AUTOGROK_V59_BRIDGE__) return;
  window.__AUTOGROK_V59_BRIDGE__ = true;

  const originalSend = WebSocket.prototype.send;
  const originalAdd = WebSocket.prototype.addEventListener;
  const originalRemove = WebSocket.prototype.removeEventListener;
  const callbackMap = new WeakMap();
  const seenStart = Object.create(null);

  // ---------- STATE ----------

  // globalBlock: when true, ALL WS sends are blocked unless a valid gate is active+unconsumed.
  // AutoGrok activates this at the start of processOnePrompt and deactivates after download.
  // This is the primary fix for "generation without prompt" and "two simultaneous generations".
  let globalBlock = false;

  let gate = {
    active: false,
    expected: "",
    hash: "",
    consumed: false,
    setAt: 0
  };

  // Extra page-level anti-double guard
  const recentPrompts = Object.create(null);
  const RECENT_TTL = 180000;

  // ---------- HELPERS ----------

  function emit(type, detail) {
    window.dispatchEvent(new CustomEvent(type, { detail: detail || {} }));
  }

  function norm(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function extractPrompt(payload) {
    try {
      if (typeof payload !== "string") return null;
      if (!payload.includes("conversation.item.create")) return null;
      const data = JSON.parse(payload);
      if (data?.type !== "conversation.item.create") return null;
      const content = data?.item?.content;
      if (!Array.isArray(content)) return "";
      const input = content.find(x => x && x.type === "input_text");
      return typeof input?.text === "string" ? input.text : "";
    } catch {
      return null;
    }
  }

  // ---------- GLOBAL BLOCK EVENTS ----------

  window.addEventListener("autogrok:v4-global-block-on", () => {
    globalBlock = true;
    // Reset gate when entering global block — it will be re-set just before the send click.
    gate.active = false;
    gate.expected = "";
    gate.hash = "";
    gate.consumed = false;
    gate.setAt = 0;
    emit("autogrok:v4-gate-status", { status: "global-block-on" });
  });

  window.addEventListener("autogrok:v4-global-block-off", () => {
    globalBlock = false;
    gate.active = false;
    gate.expected = "";
    gate.hash = "";
    gate.consumed = false;
    gate.setAt = 0;
    emit("autogrok:v4-gate-status", { status: "global-block-off" });
  });

  // ---------- GATE EVENTS ----------

  window.addEventListener("autogrok:v4-gate-set", (e) => {
    gate = {
      active: true,
      expected: norm(e.detail?.expected || ""),
      hash: String(e.detail?.hash || ""),
      consumed: false,
      setAt: Date.now()
    };
    emit("autogrok:v4-gate-status", { status: "set", hash: gate.hash });
  });

  window.addEventListener("autogrok:v4-gate-reset", () => {
    gate.active = false;
    gate.expected = "";
    gate.hash = "";
    gate.consumed = false;
    gate.setAt = 0;
    emit("autogrok:v4-gate-status", { status: "reset" });
  });

  // ---------- WEBSOCKET INTERCEPT ----------

  WebSocket.prototype.send = function (...args) {
    try {
      if (this.url && this.url.includes("grok.com/ws/imagine")) {
        const prompt = extractPrompt(args[0]);
        if (prompt !== null) {
          const clean = norm(prompt);
          emit("autogrok:v4-ws-outgoing", { prompt: clean, at: Date.now() });

          // ── GLOBAL BLOCK CHECK ──────────────────────────────────────────────
          // When AutoGrok is in control (globalBlock=true), block every send
          // unless we have an active, unconsumed, matching gate.
          // This prevents:
          //   1. Grok auto-sending a stale/empty prompt on page load
          //   2. A second generation firing before AutoGrok is ready
          if (globalBlock) {
            if (!gate.active || gate.consumed) {
              emit("autogrok:v4-ws-blocked", {
                reason: "global-block-no-gate",
                expected: gate.expected,
                actual: clean,
                hash: gate.hash
              });
              return; // ← BLOCK: no gate set yet, or gate already used
            }
          }
          // ────────────────────────────────────────────────────────────────────

          // Instant duplicate guard (still active even outside globalBlock)
          if (clean) {
            const key = clean.slice(0, 220);
            const last = recentPrompts[key] || 0;
            if (Date.now() - last < 120000) {
              emit("autogrok:v4-ws-blocked", {
                reason: "instant-duplicate-send",
                expected: gate.expected,
                actual: clean,
                hash: gate.hash
              });
              return;
            }
          }

          // Gate match check (runs when gate.active, whether or not globalBlock)
          if (gate.active) {
            const expectedShort = gate.expected.replace(/\s+/g, " ").trim().split(/\s+/).slice(0, 9).join(" ").toLowerCase();
            const cleanShort = clean.replace(/\s+/g, " ").trim().split(/\s+/).slice(0, 9).join(" ").toLowerCase();
            const ok = clean && gate.expected && cleanShort === expectedShort;

            if (!ok) {
              emit("autogrok:v4-ws-blocked", {
                reason: "wrong-or-empty-prompt",
                expected: gate.expected,
                actual: clean,
                hash: gate.hash
              });
              return;
            }

            if (gate.consumed) {
              emit("autogrok:v4-ws-blocked", {
                reason: "duplicate-send",
                expected: gate.expected,
                actual: clean,
                hash: gate.hash
              });
              return;
            }

            gate.consumed = true;
            recentPrompts[clean.slice(0, 220)] = Date.now();
            emit("autogrok:v4-ws-accepted", {
              prompt: clean,
              hash: gate.hash,
              at: Date.now()
            });
          }
        }
      }
    } catch (err) {
      emit("autogrok:v4-bridge-error", { error: String(err?.message || err) });
    }

    return originalSend.apply(this, args);
  };

  function handleMessage(event) {
    const original = callbackMap.get(this);
    if (typeof original === "function") {
      try { original.call(this, event); } catch {}
    }

    try {
      const data = JSON.parse(event.data || "{}");

      if (data.type === "json") {
        emit("autogrok:v4-ws-json", {
          status: data.current_status || data.stage || "",
          requestId: data.request_id || "",
          raw: data,
          at: Date.now()
        });

        if (data.current_status === "start_stage" && data.request_id && !seenStart[data.request_id]) {
          seenStart[data.request_id] = true;
          emit("autogrok:v4-generation-started", {
            requestId: data.request_id,
            raw: data,
            at: Date.now()
          });
        }
      }

      if (data.type === "image" && Number(data.percentage_complete) > 0) {
        const percent = Number(data.percentage_complete);
        emit("autogrok:v4-generation-progress", {
          percent,
          raw: data,
          at: Date.now()
        });
        if (percent >= 100) {
          emit("autogrok:v4-generation-finished", {
            percent,
            raw: data,
            at: Date.now()
          });
        }
      }
    } catch {}
  }

  WebSocket.prototype.addEventListener = function (...args) {
    try {
      if (args[0] === "message" && this.url && this.url.includes("grok.com/ws/imagine") && typeof args[1] === "function") {
        callbackMap.set(this, args[1]);
        args[1] = handleMessage;
      }
    } catch {}
    return originalAdd.apply(this, args);
  };

  WebSocket.prototype.removeEventListener = function (...args) {
    try {
      if (args[0] === "message" && this.url && this.url.includes("grok.com/ws/imagine") && callbackMap.get(this) === args[1]) {
        args[1] = handleMessage;
        callbackMap.delete(this);
      }
    } catch {}
    return originalRemove.apply(this, args);
  };

  try {
    Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
    Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
    document.hasFocus = () => true;
  } catch {}

  console.log("[AutoGrok v6.0 Human-Grok bridge] installed");
})();
