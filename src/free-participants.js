// Independent first-round responses from Gemini and Groq.
// This is not a multi-round debate or a consensus mechanism.
const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();
const providers = [
  { key: "gemini", name: "Google Gemini", model: "gemini-2.5-flash", secret: "GEMINI_API_KEY" },
  { key: "groq", name: "Groq", model: "openai/gpt-oss-20b", secret: "GROQ_API_KEY" }
];
const instruction = "Ты независимый участник AI Society. Ответь на языке пользователя ясно и по существу. Не утверждай, что другие модели согласились с тобой.";
async function generate(env, provider, question) {
  if (!env[provider.secret]) throw new Error("API key not configured");
  let response;
  if (provider.key === "gemini") {
    response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + provider.model + ":generateContent", {
      method: "POST",
      headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instruction }] },
        contents: [{ role: "user", parts: [{ text: question }] }],
        generationConfig: { maxOutputTokens: 1024 }
      }),
      signal: AbortSignal.timeout(45000)
    });
  } else {
    response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.GROQ_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "system", content: instruction }, { role: "user", content: question }],
        max_completion_tokens: 1024
      }),
      signal: AbortSignal.timeout(45000)
    });
  }
  if (!response.ok) throw new Error("HTTP " + response.status);
  const data = await response.json();
  const text = provider.key === "gemini"
    ? (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n").trim()
    : (data.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("No text returned");
  return text;
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
      const answer = await generate(env, provider, conversation.question);
      await run(db,
        "INSERT INTO ai_discussion_messages (id, conversation_id, participant_id, provider_key, message_type, content) VALUES (?, ?, ?, ?, 'initial_answer', ?)",
        crypto.randomUUID(), conversationId, participantId, provider.key, answer);
      await run(db,
        "UPDATE ai_conversation_participants SET participation_status = 'responded', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        participantId);
      await notify(db, conversation, provider.name + " (" + provider.model + ") — независимый ответ:\n\n" + answer);
      return { name: provider.name, answer };
    } catch (error) {
      const reason = String(error?.message || "provider unavailable").slice(0,120);
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
