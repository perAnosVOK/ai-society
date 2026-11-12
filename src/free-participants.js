// Independent first-round responses from Gemini and Groq.
// This is not a multi-round debate or a consensus mechanism.
const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();
const providers = [
  { key: "gemini", name: "Google Gemini", model: "gemini-2.5-flash", secret: "GEMINI_API_KEY" },
  { key: "groq", name: "Groq", model: "openai/gpt-oss-20b", secret: "GROQ_API_KEY" }
];
const instruction = "Ты независимый участник AI Society. Отвечай на языке пользователя кратко, конкретно и по существу: обычно 100–180 слов, максимум 3–5 коротких пунктов, если они действительно нужны. Сначала прямой ответ, затем только ключевые аргументы или шаги. Не добавляй длинные вступления, таблицы, повторения, общие предупреждения и предложения дальнейшей помощи без необходимости. Если пользователь явно просит подробности или код, дай достаточную для задачи полноту. Не утверждай, что другие модели согласились с тобой.";
async function discoverGeminiModels(env) {
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=100", {
    headers: { "x-goog-api-key": env.GEMINI_API_KEY },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error("Gemini model listing HTTP " + response.status);
  const data = await response.json();
  const supported = (data.models || []).filter(m =>
    m.supportedGenerationMethods?.includes("generateContent") &&
    /gemini.*flash/.test(m.name || "") &&
    !/image|tts|live|preview|image-generation/.test(m.name || "")
  ).map(m => m.name.startsWith("models/") ? m.name.slice(7) : m.name);
  if (!supported.length) throw new Error("No Gemini Flash generateContent model available for this API key");
  return supported.sort((a, b) => {
    const priority = name => /gemini-3[.]1-flash$/.test(name) ? 0
      : /gemini-3-flash$/.test(name) ? 1
      : /gemini-2[.]0-flash$/.test(name) ? 2
      : /gemini-2[.]5-flash$/.test(name) ? 9 : 3;
    return priority(a) - priority(b);
  });
}
async function generate(env, provider, question) {
  if (!env[provider.secret]) throw new Error("API key not configured");
  let response;
  if (provider.key === "gemini") {
    const models = await discoverGeminiModels(env);
    for (const model of models.slice(0, 2)) {
      provider = { ...provider, model };
      response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
        method: "POST",
        headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instruction }] },
          contents: [{ role: "user", parts: [{ text: question }] }],
          generationConfig: { maxOutputTokens: 1200 }
        }),
        signal: AbortSignal.timeout(12000)
      });
      if (![404, 429, 503].includes(response.status)) break;
    }
  } else {
    response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.GROQ_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "system", content: instruction }, { role: "user", content: question }],
        max_completion_tokens: 1200
      }),
      signal: AbortSignal.timeout(45000)
    });
  }
  if (!response.ok) {
    if (provider.key === "gemini") {
      let detail = "";
      try {
        const error = await response.json();
        detail = String(error?.error?.message || "").replace(/AIza[\\w-]+/g, "[redacted]").slice(0, 280);
      } catch {}
      throw new Error("Gemini generateContent HTTP " + response.status + (detail ? ": " + detail : ""));
    }
    throw new Error("HTTP " + response.status);
  }
  const data = await response.json();
  const text = provider.key === "gemini"
    ? (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n").trim()
    : (data.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("No text returned");
  const truncated = provider.key === "gemini"
    ? data.candidates?.[0]?.finishReason === "MAX_TOKENS"
    : data.choices?.[0]?.finish_reason === "length";
  return { text, model: provider.model, truncated };
}
async function notify(db, conversation, message) {
  for (const chunk of message.match(/[\s\S]{1,3500}/g) || []) {
    await run(db, "INSERT INTO telegram_outbox (id, conversation_id, chat_id, message_text) VALUES (?, ?, ?, ?)",
      crypto.randomUUID(), conversation.id, conversation.telegram_chat_id, chunk);
  }
}
export async function answerWithGeminiGroq(env, conversationId) {
  const db = env.DB;
  const conversation = await db.prepare(
    "SELECT id, telegram_chat_id, question FROM ai_conversations WHERE id = ? AND status = 'queued'"
  ).bind(conversationId).first();
  if (!conversation) return;
  const claim = await run(db,
    "UPDATE ai_conversations SET status = 'collecting_initial', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued'",
    conversationId);
  if (!claim.meta?.changes) return;
  const outcomes = await Promise.all(providers.map(async provider => {
    const participantId = crypto.randomUUID();
    await run(db,
      "INSERT INTO ai_conversation_participants (id, conversation_id, provider_key, display_name, model_id) VALUES (?, ?, ?, ?, ?)",
      participantId, conversationId, provider.key, provider.name, provider.model);
    try {
      const result = await generate(env, provider, conversation.question);
      const answer = result.text + (result.truncated ? "\\n\\n[Ответ достиг лимита токенов и может быть неполным.]" : "");
      await run(db,
        "INSERT INTO ai_discussion_messages (id, conversation_id, participant_id, provider_key, message_type, content) VALUES (?, ?, ?, ?, 'initial_answer', ?)",
        crypto.randomUUID(), conversationId, participantId, provider.key, answer);
      await run(db, "UPDATE ai_conversation_participants SET model_id = ? WHERE id = ?", result.model, participantId);
      await run(db,
        "UPDATE ai_conversation_participants SET participation_status = 'responded', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        participantId);
      await notify(db, conversation, provider.name + " (" + result.model + ") — независимый ответ:\n\n" + answer);
      return { name: provider.name, answer };
    } catch (error) {
      const reason = String(error?.message || "provider unavailable").slice(0,180);
      console.error(provider.key + " failed:", reason);
      await run(db,
        "UPDATE ai_conversation_participants SET participation_status = 'unavailable', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        participantId);
      await notify(db, conversation, provider.name + ": ответ пока недоступен (" + reason + ").");
      return { name: provider.name, error: reason };
    }
  }));
  const successful = outcomes.filter(x => x.answer);
  const summary = successful.map(x => x.name + ":\n" + x.answer).join("\n\n");
  await run(db,
    "UPDATE ai_conversations SET status = ?, consensus_status = 'not_reached', final_answer = ?, failure_reason = ?, updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
    successful.length ? "completed" : "failed", summary || null,
    successful.length ? null : outcomes.map(x => x.name + ": " + x.error).join("; ").slice(0,400),
    conversationId);
  await notify(db, conversation, "Первый раунд завершён: ответили " + successful.length + " из 2 моделей. Совместное обсуждение и консенсус пока не реализованы.");
}

export async function recoverStalledConversations(env) {
  const db = env.DB;
  // Reclaim queued questions if a webhook's background task was interrupted.
  const queued = await db.prepare(
    "SELECT id FROM ai_conversations WHERE status = 'queued' AND created_at < datetime('now', '-2 minutes') LIMIT 5"
  ).all();
  for (const item of queued.results || []) {
    try { await answerWithGeminiGroq(env, item.id); }
    catch (error) { console.error("Queued conversation recovery failed:", item.id, String(error?.message || error)); }
  }
  // A stalled collecting_initial task may have already sent some answers.
  // Finalize it using persisted messages; never duplicate provider calls or responses.
  const stalled = await db.prepare(
    "SELECT id, telegram_chat_id FROM ai_conversations WHERE status = 'collecting_initial' AND updated_at < datetime('now', '-3 minutes') LIMIT 10"
  ).all();
  for (const conversation of stalled.results || []) {
    try {
      const messages = await db.prepare(
        "SELECT provider_key, content FROM ai_discussion_messages WHERE conversation_id = ? AND message_type = 'initial_answer' ORDER BY rowid"
      ).bind(conversation.id).all();
      const answers = messages.results || [];
      const summary = answers.map(x => x.provider_key + ":\\n" + x.content).join("\\n\\n");
      const claim = await run(db,
        "UPDATE ai_conversations SET status = ?, consensus_status = 'not_reached', final_answer = ?, failure_reason = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'collecting_initial' AND updated_at < datetime('now', '-3 minutes')",
        answers.length ? "completed" : "failed", summary || null,
        answers.length ? null : "Background processing interrupted", conversation.id);
      if (!claim.meta?.changes) continue;
      await run(db,
        "UPDATE ai_conversation_participants SET participation_status = 'unavailable', updated_at = CURRENT_TIMESTAMP WHERE conversation_id = ? AND participation_status NOT IN ('responded', 'unavailable')",
        conversation.id);
      await notify(db, conversation, "Обработка прервалась. Сохранено ответов: " + answers.length + " из 2. Незавершённый раунд закрыт автоматически.");
    } catch (error) {
      console.error("Stalled conversation recovery failed:", conversation.id, String(error?.message || error));
    }
  }
}
