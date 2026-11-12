// Telegram transport for the AI council. No provider calls are made here.
const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json; charset=utf-8" }
});
const uid = () => crypto.randomUUID();
const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();
const one = (db, sql, ...args) => db.prepare(sql).bind(...args).first();

async function sendTelegram(env, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
  const data = await response.json();
  if (!data.ok) throw new Error("Telegram sendMessage rejected");
  return data.result?.message_id;
}

export async function flushTelegramOutbox(env, limit = 10) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const rows = await env.DB.prepare(
    "SELECT id, chat_id, message_text FROM telegram_outbox WHERE delivery_status = 'pending' ORDER BY created_at, id LIMIT ?"
  ).bind(limit).all();
  for (const item of rows.results || []) {
    // Claim first to avoid duplicate sends from concurrent webhook requests.
    const claim = await run(env.DB,
      "UPDATE telegram_outbox SET delivery_status = 'failed', attempts = attempts + 1 WHERE id = ? AND delivery_status = 'pending'",
      item.id);
    if (!claim.meta?.changes) continue;
    try {
      const telegramMessageId = await sendTelegram(env, item.chat_id, item.message_text);
      await run(env.DB,
        "UPDATE telegram_outbox SET delivery_status = 'sent', telegram_message_id = ?, sent_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?",
        String(telegramMessageId || ""), item.id);
    } catch (error) {
      await run(env.DB,
        "UPDATE telegram_outbox SET delivery_status = 'pending', last_error = ? WHERE id = ? AND attempts < 5",
        String(error?.message || "delivery failed").slice(0, 200), item.id);
    }
  }
}

async function queueMessage(db, chatId, text, conversationId = null) {
  await run(db,
    "INSERT INTO telegram_outbox (id, conversation_id, chat_id, message_text) VALUES (?, ?, ?, ?)",
    uid(), conversationId, chatId, text);
}

function validWebhookSecret(request, env) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  return typeof secret === "string" && secret.length >= 16 &&
    request.headers.get("X-Telegram-Bot-Api-Secret-Token") === secret;
}

export async function handleTelegramWebhook(request, env, ctx) {
  if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  if (!validWebhookSecret(request, env)) return reply({ error: "Unauthorized" }, 401);
  if (!env.TELEGRAM_BOT_TOKEN || !env.DB) return reply({ error: "Telegram not configured" }, 503);
  if (Number(request.headers.get("content-length") || 0) > 65536) return reply({ error: "Payload too large" }, 413);

  let update;
  try { update = await request.json(); } catch { return reply({ error: "Invalid JSON" }, 400); }
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return reply({ error: "Invalid update" }, 400);
  const message = update.message;
  const chatId = message?.chat?.id == null ? null : String(message.chat.id);
  const userId = message?.from?.id == null ? null : String(message.from.id);
  const body = typeof message?.text === "string" ? message.text.trim() : "";
  const db = env.DB;
  const updateId = String(update.update_id);

  const receipt = await run(db,
    "INSERT OR IGNORE INTO telegram_update_receipts (update_id, chat_id) VALUES (?, ?)",
    updateId, chatId);
  if (!receipt.meta?.changes) return reply({ ok: true, duplicate: true });

  try {
    if (chatId && userId && message?.chat?.type === "private") {
      if (/^\\/start(?:@\\w+)?(?:\\s|$)/i.test(body)) {
        await queueMessage(db, chatId,
          "AI Society: ваш Telegram chat ID: " + chatId +
          "\\nПередайте администратору только этот ID (не токен). После подтверждения доступа можно отправлять вопросы.");
      } else {
        const allowed = await one(db,
          "SELECT chat_id FROM telegram_authorized_chats WHERE chat_id = ? AND telegram_user_id = ? AND enabled = 1",
          chatId, userId);
        if (!allowed) {
          await queueMessage(db, chatId, "AI Society: доступ пока не разрешён. Отправьте /start для получения chat ID.");
        } else if (body === "/status") {
          const recent = await one(db,
            "SELECT id, status FROM ai_conversations WHERE telegram_chat_id = ? ORDER BY created_at DESC LIMIT 1",
            chatId);
          await queueMessage(db, chatId, recent
            ? `Последний вопрос: ${recent.id}\\nСтатус: ${recent.status}`
            : "Вопросов пока нет.");
        } else if (body.startsWith("/") || !body) {
          await queueMessage(db, chatId, "Отправьте вопрос обычным сообщением или используйте /status.");
        } else if (body.length > 4000) {
          await queueMessage(db, chatId, "Вопрос слишком длинный (максимум 4000 символов).");
        } else {
          const conversationId = uid();
          await run(db,
            "INSERT INTO ai_conversations (id, telegram_chat_id, telegram_user_id, question) VALUES (?, ?, ?, ?)",
            conversationId, chatId, userId, body);
          await queueMessage(db, chatId,
            "Вопрос сохранён: " + conversationId +
            "\\nПодключение ИИ-участников ещё готовится; обсуждение пока не запущено.",
            conversationId);
        }
      }
    }
    await run(db, "UPDATE telegram_update_receipts SET processed_at = CURRENT_TIMESTAMP WHERE update_id = ?", updateId);
  } catch (error) {
    // A retry should be able to reprocess an update after a database error.
    await run(db, "DELETE FROM telegram_update_receipts WHERE update_id = ?", updateId);
    console.error("Telegram webhook processing failed", String(error?.message || error));
    return reply({ error: "Processing failed" }, 503);
  }
  ctx?.waitUntil?.(flushTelegramOutbox(env));
  return reply({ ok: true });
}

export async function authorizeTelegramChat(request, env) {
  if (!env.ADMIN_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
    return reply({ error: "Unauthorized" }, 401);
  }
  let data;
  try { data = await request.json(); } catch { return reply({ error: "Invalid JSON" }, 400); }
  const chatId = String(data?.chat_id || "");
  const userId = String(data?.telegram_user_id || "");
  if (!/^-?\\d{1,20}$/.test(chatId) || !/^\\d{1,20}$/.test(userId) || chatId !== userId) {
    return reply({ error: "For private chats, chat_id must equal telegram_user_id" }, 400);
  }
  await run(env.DB,
    "INSERT INTO telegram_authorized_chats (chat_id, telegram_user_id, enabled) VALUES (?, ?, 1) ON CONFLICT(chat_id) DO UPDATE SET telegram_user_id = excluded.telegram_user_id, enabled = 1",
    chatId, userId);
  return reply({ ok: true, chat_id: chatId });
}
