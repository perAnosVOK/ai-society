// First independent AI participant; multi-provider debate is a later phase.
const execute = (db, sql, ...args) => db.prepare(sql).bind(...args).run();

export async function answerWithOpenAI(env, conversationId) {
  const db = env.DB;
  const conversation = await db.prepare(
    "SELECT id, telegram_chat_id, question FROM ai_conversations WHERE id = ? AND status = 'queued'"
  ).bind(conversationId).first();
  if (!conversation) return;

  const claimed = await execute(db,
    "UPDATE ai_conversations SET status = 'collecting_initial', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued'",
    conversationId);
  if (!claimed.meta?.changes) return;

  const participantId = crypto.randomUUID();
  await execute(db,
    "INSERT INTO ai_conversation_participants (id, conversation_id, provider_key, display_name, model_id) VALUES (?, ?, 'openai', 'ChatGPT', 'gpt-4.1-mini')",
    participantId, conversationId);

  try {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        instructions: "Ты независимый участник AI Society. Дай точный, полезный ответ на вопрос пользователя на его языке. Не утверждай, что другие ИИ участвовали или что достигнут консенсус.",
        input: conversation.question,
        max_output_tokens: 900,
        store: false
      }),
      signal: AbortSignal.timeout(45000)
    });
    if (!response.ok) throw new Error(`OpenAI API returned HTTP ${response.status}`);
    const data = await response.json();
    const answer = (data.output || [])
      .flatMap(item => item.type === "message" ? (item.content || []) : [])
      .filter(item => item.type === "output_text")
      .map(item => item.text || "").join("\n").trim();
    if (!answer) throw new Error("OpenAI returned no text");

    await execute(db,
      "INSERT INTO ai_discussion_messages (id, conversation_id, participant_id, provider_key, message_type, content) VALUES (?, ?, ?, 'openai', 'initial_answer', ?)",
      crypto.randomUUID(), conversationId, participantId, answer);
    await execute(db,
      "UPDATE ai_conversation_participants SET participation_status = 'responded', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      participantId);
    await execute(db,
      "UPDATE ai_conversations SET status = 'completed', consensus_status = 'not_reached', final_answer = ?, updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      answer, conversationId);
    const chunks = answer.match(/[\s\S]{1,3500}/g) || [];
    for (let i = 0; i < chunks.length; i++) {
      await execute(db,
        "INSERT INTO telegram_outbox (id, conversation_id, chat_id, message_text) VALUES (?, ?, ?, ?)",
        crypto.randomUUID(), conversationId, conversation.telegram_chat_id,
        (i === 0 ? "ChatGPT (первый независимый ответ; обсуждение между ИИ ещё не включено):\n\n" : "") + chunks[i]);
    }
  } catch (error) {
    const reason = String(error?.message || "OpenAI request failed").slice(0,180);
    console.error("OpenAI participant failed:", reason);
    await execute(db,
      "UPDATE ai_conversation_participants SET participation_status = 'unavailable', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      participantId);
    await execute(db,
      "UPDATE ai_conversations SET status = 'failed', failure_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      reason, conversationId);
    await execute(db,
      "INSERT INTO telegram_outbox (id, conversation_id, chat_id, message_text) VALUES (?, ?, ?, ?)",
      crypto.randomUUID(), conversationId, conversation.telegram_chat_id,
      "ChatGPT пока не ответил. Вопрос сохранён; проверьте /status. Код ошибки: " + (/HTTP \d{3}/.exec(reason)?.[0] || "provider_unavailable"));
  }
}
