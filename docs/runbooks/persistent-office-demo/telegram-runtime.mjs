// Minimal real Telegram Bot API long-poll runtime for the persistent-office
// demo (TASK-060). Implements just enough of services/gateway-telegram's
// TelegramClient + TelegramApprovalPort seams to drive one live demo
// session — this is NOT a production bot runtime (no retry/backoff
// hardening, no multi-chat routing beyond the single demo chat). Uses only
// Node 22's native fetch; no new dependency.
//
// Never logs the bot token. TELEGRAM_BOT_TOKEN is read from env once at
// construction and closed over, never re-printed.

const API_ROOT = "https://api.telegram.org";

export function createTelegramRuntime(botToken) {
  if (typeof botToken !== "string" || botToken.trim().length === 0) {
    throw new Error("TELEGRAM_BOT_TOKEN must be set.");
  }
  const base = `${API_ROOT}/bot${botToken}`;
  let offset = 0;
  const messageHandlers = [];
  const callbackHandlers = [];
  let polling = false;

  async function call(method, body) {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const json = await res.json();
    if (json.ok !== true) {
      throw new Error(`Telegram API ${method} failed: ${JSON.stringify(json)}`);
    }
    return json.result;
  }

  async function pollOnce() {
    const updates = await call("getUpdates", { offset, timeout: 25 });
    for (const update of updates) {
      offset = update.update_id + 1;
      if (update.message?.text !== undefined) {
        for (const h of messageHandlers) {
          await h({ chatId: update.message.chat.id, text: update.message.text });
        }
      }
      if (update.callback_query !== undefined) {
        const cq = update.callback_query;
        for (const h of callbackHandlers) {
          await h({
            callbackId: cq.id,
            chatId: cq.message?.chat?.id,
            userId: String(cq.from?.id ?? "unknown"),
            data: cq.data ?? "",
          });
        }
      }
    }
  }

  async function startPolling() {
    polling = true;
    while (polling) {
      try {
        await pollOnce();
      } catch (err) {
        console.error("[telegram-runtime] poll error", err.message);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  return {
    // TelegramClient (gateway-telegram/src/index.ts)
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    async sendMessage(chatId, text) {
      await call("sendMessage", { chat_id: chatId, text });
    },

    // TelegramApprovalPort (gateway-telegram/src/approvals/index.ts)
    async sendApprovalMessage(chatId, text, keyboard) {
      await call("sendMessage", {
        chat_id: chatId,
        text,
        reply_markup: {
          inline_keyboard: keyboard.map((row) =>
            row.map((btn) => ({ text: btn.text, callback_data: btn.callbackData })),
          ),
        },
      });
    },
    onApprovalCallback(handler) {
      callbackHandlers.push(handler);
    },
    async answerApprovalCallback(callbackId, text) {
      await call("answerCallbackQuery", { callback_query_id: callbackId, text });
    },
    async requestApprovalEdit() {
      // Not exercised by this demo (approve/reject only).
      return null;
    },

    start: startPolling,
    stop() {
      polling = false;
    },
  };
}
