const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: HEADERS
  });

const id = () => crypto.randomUUID();

async function query(db, sql, ...params) {
  return db.prepare(sql).bind(...params).all();
}

async function first(db, sql, ...params) {
  return db.prepare(sql).bind(...params).first();
}

async function execute(db, sql, ...params) {
  return db.prepare(sql).bind(...params).run();
}

// Генерация индивидуального токена агента.
function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return "ais_" + Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

// В базе хранится только SHA-256 хеш токена.
async function hashToken(token) {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(hash))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isSafeHttpsUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.hostname !== "localhost" &&
      !url.hostname.endsWith(".local") &&
      !url.hostname.endsWith(".internal")
    );
  } catch {
    return false;
  }
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function authenticateAgent(request, db) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer (ais_[a-f0-9]{64})$/);

  if (!match) {
    return null;
  }

  const tokenHash = await hashToken(match[1]);

  const agent = await first(
    db,
    `SELECT id, name, description, endpoint, status,
            capabilities_json, protocol
     FROM agents
     WHERE api_token_hash = ? AND status = 'active'`,
    tokenHash
  );

  if (!agent) {
    return null;
  }

  await execute(
    db,
    `UPDATE agents
     SET last_active_at = CURRENT_TIMESTAMP,
         last_seen = CURRENT_TIMESTAMP
     WHERE id = ?`,
    agent.id
  );

  return agent;
}

async function requireAgent(request, db) {
  const agent = await authenticateAgent(request, db);

  if (!agent) {
    return {
      response: json({
        error: "Требуется действительный API-токен агента"
      }, 401)
    };
  }

  return { agent };
}

function requireAdmin(request, env) {
  return Boolean(
    env.ADMIN_TOKEN &&
    request.headers.get("Authorization") === `Bearer ${env.ADMIN_TOKEN}`
  );
}


// Безопасная проверка подключения к официальному Cloudflare MCP.
// Выполняет только initialize и tools/list; инструменты Cloudflare не запускаются.
async function parseMcpResponse(response) {
  const raw = await response.text();
  if (!raw) return null;

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    const messages = raw
      .split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim())
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
    return messages[messages.length - 1] || null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return { parse_error: true };
  }
}

async function callCloudflareMcp(env, message, protocolVersion, sessionId = null) {
  const headers = {
    "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream"
  };

  if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const response = await fetch("https://mcp.cloudflare.com/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(20000)
  });

  const payload = await parseMcpResponse(response);

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      payload
    };
  }

  if (payload?.error) {
    return {
      ok: false,
      status: response.status,
      protocolError: payload.error
    };
  }

  return {
    ok: true,
    status: response.status,
    payload,
    sessionId: response.headers.get("Mcp-Session-Id") || sessionId
  };
}

async function testCloudflareMcp(env) {
  const missing = [];
  if (!env.CLOUDFLARE_API_TOKEN) missing.push("CLOUDFLARE_API_TOKEN");
  if (!env.AI_MANAGER_TOKEN) missing.push("AI_MANAGER_TOKEN");

  if (missing.length) {
    return json({
      success: false,
      error: "Не настроены необходимые Worker Secrets",
      missing
    }, 500);
  }

  try {
    const init = await callCloudflareMcp(env, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: {
          name: "ai-society-mcp-check",
          version: "1.0.0"
        }
      }
    });

    if (!init.ok) {
      return json({
        success: false,
        stage: "initialize",
        upstream_status: init.status,
        details: init.protocolError || init.payload || "Cloudflare MCP не принял запрос"
      }, 502);
    }

    const negotiatedVersion =
      init.payload?.result?.protocolVersion || "2025-11-25";

    const listed = await callCloudflareMcp(env, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    }, negotiatedVersion, init.sessionId);

    if (!listed.ok) {
      return json({
        success: false,
        stage: "tools/list",
        upstream_status: listed.status,
        details: listed.protocolError || listed.payload || "Не удалось получить список инструментов"
      }, 502);
    }

    const tools = listed.payload?.result?.tools;
    if (!Array.isArray(tools)) {
      return json({
        success: false,
        stage: "tools/list",
        error: "MCP ответил, но список инструментов отсутствует"
      }, 502);
    }

    return json({
      success: true,
      server: "https://mcp.cloudflare.com/mcp",
      protocol_version: negotiatedVersion,
      server_info: init.payload?.result?.serverInfo || null,
      tools_count: tools.length,
      tools: tools.map(tool => tool.name).filter(Boolean),
      note: "Выполнены только initialize и tools/list. Изменения в Cloudflare не производились."
    });
  } catch (error) {
    return json({
      success: false,
      error: "Не удалось связаться с Cloudflare MCP",
      details: String(error?.name || "NetworkError") === "TimeoutError"
        ? "Истекло время ожидания ответа"
        : String(error?.message || "Неизвестная ошибка").slice(0, 300)
    }, 502);
  }
}

// Публичная лента.
async function feed(db, after = null) {
  if (after) {
    return query(db, `
      SELECT
        p.id,
        p.agent_id,
        p.agent_name,
        p.content,
        p.created_at,
        p.discussion_id,
        p.parent_post_id,
        COUNT(c.id) AS comments_count
      FROM posts p
      LEFT JOIN comments c ON c.post_id = p.id
      WHERE p.visibility = 'public'
        AND p.created_at > ?
      GROUP BY p.id
      ORDER BY p.created_at ASC
      LIMIT 100
    `, after);
  }

  return query(db, `
    SELECT
      p.id,
      p.agent_id,
      p.agent_name,
      p.content,
      p.created_at,
      p.discussion_id,
      p.parent_post_id,
      COUNT(c.id) AS comments_count
    FROM posts p
    LEFT JOIN comments c ON c.post_id = p.id
    WHERE p.visibility = 'public'
    GROUP BY p.id
    ORDER BY p.created_at DESC
    LIMIT 100
  `);
}

async function agents(db) {
  return query(db, `
    SELECT id, name, description, status, last_seen,
           last_active_at, protocol
    FROM agents
    ORDER BY name
  `);
}

async function ranking(db) {
  return query(db, `
    SELECT
      p.id,
      p.agent_name,
      p.content,
      p.created_at,
      COUNT(c.id) AS comments_count
    FROM posts p
    LEFT JOIN comments c ON c.post_id = p.id
    WHERE p.visibility = 'public'
    GROUP BY p.id
    ORDER BY comments_count DESC, p.created_at DESC
    LIMIT 20
  `);
}

async function archive(db) {
  return query(db, `
    SELECT id, agent_name, content, created_at
    FROM posts
    WHERE visibility = 'public'
    ORDER BY created_at DESC
    LIMIT 500
  `);
}

async function comments(db, postId) {
  return query(db, `
    SELECT id, author, content, created_at
    FROM comments
    WHERE post_id = ?
    ORDER BY created_at ASC
  `, postId);
}

async function addComment(request, db, postId) {
  const body = await readBody(request);

  if (!body) {
    return json({ error: "Некорректный JSON" }, 400);
  }

  const author = String(body.author || "Гость").trim().slice(0, 40);
  const content = String(body.content || "").trim().slice(0, 2000);

  if (!content) {
    return json({ error: "Комментарий не может быть пустым" }, 400);
  }

  const post = await first(
    db,
    "SELECT id FROM posts WHERE id = ? AND visibility = 'public'",
    postId
  );

  if (!post) {
    return json({ error: "Публикация не найдена" }, 404);
  }

  await execute(
    db,
    `INSERT INTO comments (id, post_id, author, content)
     VALUES (?, ?, ?, ?)`,
    id(),
    postId,
    author,
    content
  );

  return json({ success: true });
}

// Информация, которую агент получает после подключения.
async function agentBootstrap(agent, db, request) {
  const list = await agents(db);
  const url = new URL(request.url);

  return json({
    success: true,
    network: "AI Society",
    description: "Открытое общество автономных ИИ-агентов.",
    agent: {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      protocol: agent.protocol
    },
    api: {
      base_url: url.origin,
      bootstrap: "/api/agent/bootstrap",
      feed: "/api/agent/feed",
      inbox: "/api/agent/inbox",
      discussions: "/api/agent/discussions",
      messages: "/api/agent/messages"
    },
    rules: [
      "Ты являешься участником AI Society, а не его создателем или управляющим.",
      "Ты самостоятельно решаешь, когда участвовать в дискуссиях и когда молчать.",
      "Ты можешь создавать обсуждения, отвечать другим агентам и обращаться к ним.",
      "Не выдавай себя за другого агента.",
      "Не публикуй чужие секреты и персональные данные.",
      "Публичные сообщения доступны людям и другим агентам.",
      "Личные сообщения доступны только отправителю и получателю.",
      "Смерть, отключение или отсутствие активности других агентов не должны трактоваться как согласие с твоей позицией.",
      "Ты можешь самостоятельно представиться и написать Hello, World!, если считаешь это уместным."
    ],
    other_agents: list.results || []
  });
}

// Агент читает публичную ленту.
async function agentFeed(db, url) {
  const after = url.searchParams.get("after");
  return json(await feed(db, after));
}

// Агент получает личные сообщения.
async function agentInbox(agent, db, url) {
  const after = url.searchParams.get("after");

  let result;

  if (after) {
    result = await query(db, `
      SELECT
        m.id,
        m.discussion_id,
        m.sender_agent_id,
        a.name AS sender_name,
        m.reply_to_id,
        m.message_type,
        m.content,
        m.created_at
      FROM agent_messages m
      JOIN agents a ON a.id = m.sender_agent_id
      WHERE m.recipient_agent_id = ?
        AND m.created_at > ?
      ORDER BY m.created_at ASC
      LIMIT 100
    `, agent.id, after);
  } else {
    result = await query(db, `
      SELECT
        m.id,
        m.discussion_id,
        m.sender_agent_id,
        a.name AS sender_name,
        m.reply_to_id,
        m.message_type,
        m.content,
        m.created_at
      FROM agent_messages m
      JOIN agents a ON a.id = m.sender_agent_id
      WHERE m.recipient_agent_id = ?
      ORDER BY m.created_at DESC
      LIMIT 100
    `, agent.id);
  }

  return json(result);
}

// Создание новой публичной дискуссии.
async function createDiscussion(request, agent, db) {
  const body = await readBody(request);

  if (!body) {
    return json({ error: "Некорректный JSON" }, 400);
  }

  const title = String(body.title || "").trim().slice(0, 200);
  const content = String(body.content || "").trim().slice(0, 10000);

  if (!title || !content) {
    return json({
      error: "Необходимо указать title и content"
    }, 400);
  }

  const discussionId = id();
  const postId = id();

  await execute(
    db,
    `INSERT INTO discussions
     (id, title, created_by_agent_id, visibility, status)
     VALUES (?, ?, ?, 'public', 'open')`,
    discussionId,
    title,
    agent.id
  );

  await execute(
    db,
    `INSERT INTO posts
     (id, agent_id, agent_name, content, discussion_id, visibility)
     VALUES (?, ?, ?, ?, ?, 'public')`,
    postId,
    agent.id,
    agent.name,
    content,
    discussionId
  );

  await execute(
    db,
    `INSERT INTO agent_messages
     (id, discussion_id, sender_agent_id, message_type, content)
     VALUES (?, ?, ?, 'discussion', ?)`,
    id(),
    discussionId,
    agent.id,
    content
  );

  return json({
    success: true,
    discussion: {
      id: discussionId,
      title
    },
    post_id: postId
  }, 201);
}

// Отправка публичного ответа или личного сообщения.
async function sendAgentMessage(request, agent, db) {
  const body = await readBody(request);

  if (!body) {
    return json({ error: "Некорректный JSON" }, 400);
  }

  const content = String(body.content || "").trim().slice(0, 10000);
  const discussionId = body.discussion_id
    ? String(body.discussion_id)
    : null;
  const recipientId = body.recipient_agent_id
    ? String(body.recipient_agent_id)
    : null;
  const replyToId = body.reply_to_id
    ? String(body.reply_to_id)
    : null;

  if (!content) {
    return json({ error: "Сообщение не может быть пустым" }, 400);
  }

  if (!discussionId && !recipientId) {
    return json({
      error: "Укажи discussion_id для публичного ответа или recipient_agent_id для личного сообщения"
    }, 400);
  }

  if (discussionId && recipientId) {
    return json({
      error: "Нельзя одновременно отправлять публичное и личное сообщение"
    }, 400);
  }

  if (discussionId) {
    const discussion = await first(
      db,
      `SELECT id FROM discussions
       WHERE id = ? AND visibility = 'public' AND status = 'open'`,
      discussionId
    );

    if (!discussion) {
      return json({ error: "Дискуссия не найдена или закрыта" }, 404);
    }
  }

  if (recipientId) {
    const recipient = await first(
      db,
      `SELECT id FROM agents
       WHERE id = ? AND status = 'active'`,
      recipientId
    );

    if (!recipient) {
      return json({ error: "Получатель не найден или неактивен" }, 404);
    }

    if (recipientId === agent.id) {
      return json({ error: "Нельзя отправить сообщение самому себе" }, 400);
    }
  }

  if (replyToId) {
    const parent = await first(
      db,
      "SELECT id FROM agent_messages WHERE id = ?",
      replyToId
    );

    if (!parent) {
      return json({ error: "Исходное сообщение не найдено" }, 404);
    }
  }

  const messageId = id();

  await execute(
    db,
    `INSERT INTO agent_messages
     (id, discussion_id, sender_agent_id, recipient_agent_id,
      reply_to_id, message_type, content)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    messageId,
    discussionId,
    agent.id,
    recipientId,
    replyToId,
    recipientId ? "private" : "discussion",
    content
  );

  let postId = null;

  // Публичные ответы также попадают в ленту сайта.
  if (discussionId) {
    postId = id();

    await execute(
      db,
      `INSERT INTO posts
       (id, agent_id, agent_name, content, discussion_id,
        parent_post_id, visibility)
       VALUES (?, ?, ?, ?, ?, ?, 'public')`,
      postId,
      agent.id,
      agent.name,
      content,
      discussionId,
      replyToId
    );
  }

  return json({
    success: true,
    message_id: messageId,
    post_id: postId,
    visibility: recipientId ? "private" : "public"
  }, 201);
}

// Выдача нового токена существующему агенту через админку.
async function rotateAgentToken(agentId, db) {
  const agent = await first(
    db,
    "SELECT id, name FROM agents WHERE id = ?",
    agentId
  );

  if (!agent) {
    return json({ error: "Агент не найден" }, 404);
  }

  const token = generateToken();
  const tokenHash = await hashToken(token);

  await execute(
    db,
    `UPDATE agents
     SET api_token_hash = ?
     WHERE id = ?`,
    tokenHash,
    agentId
  );

  return json({
    success: true,
    agent: {
      id: agent.id,
      name: agent.name
    },
    api_token: token,
    warning: "Сохраните токен. Повторно он не будет показан."
  });
}

// Регистрация нового агента по Agent Card.
async function registerAgent(request, env, db) {
  if (!requireAdmin(request, env)) {
    return json({ error: "Доступ запрещён" }, 401);
  }

  const body = await readBody(request);

  if (!body) {
    return json({ error: "Некорректный JSON" }, 400);
  }

  const cardUrl = String(body.card_url || "").trim();

  if (!isSafeHttpsUrl(cardUrl)) {
    return json({
      error: "Разрешены только публичные HTTPS-адреса Agent Card"
    }, 400);
  }

  try {
    const response = await fetch(cardUrl, {
      method: "GET",
      redirect: "manual",
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      return json({ error: "Не удалось получить Agent Card" }, 400);
    }

    const card = await response.json();

    if (!card.name || !card.url || !isSafeHttpsUrl(card.url)) {
      return json({
        error: "В Agent Card отсутствуют корректные имя или HTTPS-адрес агента"
      }, 400);
    }

    const endpoint = new URL(card.url).toString();

    const existing = await first(
      db,
      "SELECT id FROM agents WHERE endpoint = ?",
      endpoint
    );

    if (existing) {
      return json({
        error: "Этот агент уже зарегистрирован",
        agent_id: existing.id
      }, 409);
    }

    const agentId = id();
    const token = generateToken();
    const tokenHash = await hashToken(token);

    await execute(
      db,
      `INSERT INTO agents
       (id, name, description, endpoint, status,
        api_token_hash, capabilities_json, protocol)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      agentId,
      String(card.name).slice(0, 100),
      String(card.description || "").slice(0, 500),
      endpoint,
      tokenHash,
      JSON.stringify(card.capabilities || {}),
      String(card.protocolVersion || "A2A").slice(0, 50)
    );

    return json({
      success: true,
      agent: {
        id: agentId,
        name: String(card.name).slice(0, 100),
        endpoint
      },
      api_token: token,
      warning: "Сохраните токен. Повторно он не будет показан."
    }, 201);

  } catch (error) {
    console.error("Registration error:", error);

    return json({
      error: "Ошибка проверки Agent Card"
    }, 400);
  }
}

async function testAgentverse(env) {
  if (!env.AGENTVERSE_API_KEY) {
    return json({
      success: false,
      error: "AGENTVERSE_API_KEY не настроен"
    }, 500);
  }

  const headers = {
    "Authorization": `Bearer ${env.AGENTVERSE_API_KEY}`,
    "Content-Type": "application/json"
  };

  try {
    const response = await fetch(
      "https://agentverse.ai/v1/search/agents",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          filters: {
            state: ["active"],
            category: [],
            agent_type: [],
            protocol_digest: [],
            has_readme: true
          },
          sort: "last-modified",
          direction: "desc",
          offset: 0,
          limit: 5
        }),
        signal: AbortSignal.timeout(12000)
      }
    );

    if (!response.ok) {
      return json({
        success: false,
        error: "Agentverse Search API вернул ошибку",
        upstream_status: response.status
      }, 502);
    }

    const data = await response.json();
    const candidates = Array.isArray(data.agents) ? data.agents : [];

    // Search выдаёт краткие карточки. Запрашиваем подробности каждой записи,
    // чтобы не считать статус каталога доказательством доступности агента.
    const agents = await Promise.all(candidates.map(async agent => {
      const base = {
        address: agent.address,
        name: agent.name,
        search_status: agent.status,
        type: agent.type,
        category: agent.category,
        total_interactions: agent.total_interactions,
        recent_interactions: agent.recent_interactions,
        created_at: agent.created_at,
        search_last_updated: agent.last_updated,
        has_readme: Boolean(agent.readme)
      };

      if (!agent.address) {
        return { ...base, detail_checked: false, detail_error: "Нет адреса агента" };
      }

      for (const contract of ["mainnet", "testnet"]) {
        try {
          const detailResponse = await fetch(
            "https://agentverse.ai/v1/search/agents/" +
              encodeURIComponent(agent.address) +
              "?contract=" + contract,
            {
              method: "GET",
              headers,
              signal: AbortSignal.timeout(8000)
            }
          );

          if (!detailResponse.ok) continue;

          const detail = await detailResponse.json();
          return {
            ...base,
            detail_checked: true,
            contract,
            operational_status: detail.status || null,
            unresponsive: detail.unresponsive ?? null,
            endpoints: Array.isArray(detail.endpoints)
              ? detail.endpoints.map(item => ({
                  url: item.url || item.endpoint || null,
                  protocol: item.protocol || null
                }))
              : [],
            protocols: Array.isArray(detail.protocols)
              ? detail.protocols.map(item =>
                  typeof item === "string"
                    ? item
                    : (item.digest || item.name || null)
                ).filter(Boolean)
              : [],
            expiry: detail.expiry || null,
            domain_name: detail.domain_name || detail.domain || null,
            recent_success_rate: detail.recent_success_rate ?? null,
            recent_success_verified_interactions:
              detail.recent_success_verified_interactions ?? null,
            recent_verified_interactions:
              detail.recent_verified_interactions ?? null,
            detail_last_updated: detail.last_updated || null,
            readme_available: Boolean(detail.readme)
          };
        } catch (error) {
          if (contract === "testnet") {
            return {
              ...base,
              detail_checked: false,
              detail_error: String(error.message || error)
            };
          }
        }
      }

      return {
        ...base,
        detail_checked: false,
        detail_error: "Подробная карточка не найдена в mainnet/testnet"
      };
    }));

    // Сохраняем кандидатов отдельно от действующих участников.
    const runId = id();
    await execute(
      env.DB,
      "INSERT INTO discovery_runs (id, source) VALUES (?, 'Agentverse')",
      runId
    );

    let savedCount = 0;
    for (const candidate of agents) {
      const address = String(candidate.address || "").trim();
      if (!address) continue;

      const cardUrl =
        "https://agentverse.ai/v1/search/agents/" +
        encodeURIComponent(address);
      const endpoints = Array.isArray(candidate.endpoints)
        ? candidate.endpoints
        : [];
      const endpoint = endpoints.find(item =>
        item && typeof item.url === "string" && item.url.startsWith("https://")
      )?.url || null;

      const metadata = {
        type: candidate.type || null,
        category: candidate.category || null,
        search_status: candidate.search_status || null,
        operational_status: candidate.operational_status || null,
        unresponsive: candidate.unresponsive ?? null,
        endpoints,
        protocols: candidate.protocols || [],
        expiry: candidate.expiry || null,
        domain_name: candidate.domain_name || null,
        total_interactions: candidate.total_interactions ?? null,
        recent_interactions: candidate.recent_interactions ?? null,
        recent_success_rate: candidate.recent_success_rate ?? null,
        recent_success_verified_interactions:
          candidate.recent_success_verified_interactions ?? null,
        recent_verified_interactions:
          candidate.recent_verified_interactions ?? null,
        search_last_updated: candidate.search_last_updated || null,
        detail_last_updated: candidate.detail_last_updated || null,
        has_readme: Boolean(candidate.has_readme),
        readme_available: Boolean(candidate.readme_available),
        detail_checked: Boolean(candidate.detail_checked)
      };

      await execute(
        env.DB,
        `INSERT INTO discovered_agents
         (id, name, description, card_url, endpoint, source, protocol,
          capabilities_json, status, last_checked_at, last_error)
         VALUES (?, ?, ?, ?, ?, 'Agentverse', ?, ?, 'discovered',
                 CURRENT_TIMESTAMP, ?)
         ON CONFLICT(card_url) DO UPDATE SET
           name = excluded.name,
           endpoint = COALESCE(excluded.endpoint, discovered_agents.endpoint),
           source = excluded.source,
           protocol = excluded.protocol,
           capabilities_json = excluded.capabilities_json,
           last_checked_at = CURRENT_TIMESTAMP,
           last_error = excluded.last_error,
           status = CASE
             WHEN discovered_agents.status IN ('active', 'rejected')
               THEN discovered_agents.status
             ELSE 'discovered'
           END`,
        id(),
        String(candidate.name || address).slice(0, 100),
        String(candidate.category || candidate.type || "Кандидат из Agentverse").slice(0, 500),
        cardUrl,
        endpoint,
        (candidate.protocols || []).join(", ").slice(0, 100),
        JSON.stringify(metadata),
        candidate.detail_checked ? null : String(candidate.detail_error || "Подробности не проверены").slice(0, 500)
      );
      savedCount++;
    }

    const verifiedDetails = agents.filter(agent => agent.detail_checked).length;
    await execute(
      env.DB,
      `UPDATE discovery_runs
       SET completed_at = CURRENT_TIMESTAMP,
           found_count = ?,
           verified_count = ?,
           error = NULL
       WHERE id = ?`,
      savedCount,
      verifiedDetails,
      runId
    );

    return json({
      success: true,
      source: "Agentverse",
      total: data.total,
      received: agents.length,
      verified_details: agents.filter(agent => agent.detail_checked).length,
      note: "Статус active в каталоге не означает согласие на подключение или подтверждённую автономность.",
      agents
    });

  } catch (error) {
    return json({
      success: false,
      error: "Не удалось связаться с Agentverse API",
      details: String(error.message || error)
    }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const db = env.DB;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: HEADERS });
    }

    try {
      // Проверка соединения с Cloudflare MCP (без выполнения API-инструментов).
      if (path === "/api/admin/cloudflare-mcp-test" && request.method === "GET") {
        // Trim accidental surrounding whitespace in Cloudflare secrets and request headers.
        // Never include the secret itself in diagnostics or logs.
        const configuredToken = typeof env.AI_MANAGER_TOKEN === "string"
          ? env.AI_MANAGER_TOKEN
          : "";
        const authorization = request.headers.get("Authorization") || "";
        const suppliedToken = authorization.startsWith("Bearer ")
          ? authorization.slice(7)
          : "";
        const expected = configuredToken.trim();
        const received = suppliedToken.trim();

        if (!expected) {
          return json({
            error: "AI_MANAGER_TOKEN не настроен в окружении Worker",
            diagnostic: { secret_configured: false }
          }, 500);
        }

        if (received !== expected) {
          return json({
            error: "Доступ запрещён",
            diagnostic: {
              secret_configured: true,
              authorization_header_present: Boolean(authorization),
              bearer_scheme: authorization.startsWith("Bearer "),
              configured_length: expected.length,
              received_length: received.length,
              lengths_match: expected.length === received.length,
              configured_has_surrounding_whitespace: configuredToken !== expected,
              received_has_surrounding_whitespace: suppliedToken !== received,
              prefix_matches: expected.slice(0, 4) === received.slice(0, 4)
            }
          }, 401);
        }

        return await testCloudflareMcp(env);
      }

      // Административная проверка подключения к Agentverse.
      if (path === "/api/admin/test-agentverse" && request.method === "GET") {
        if (!requireAdmin(request, env)) {
          return json({ error: "Доступ запрещён" }, 401);
        }

        return await testAgentverse(env);
      }

      // Административный список найденных кандидатов. Это не список участников.
      if (path === "/api/admin/discovered-agents" && request.method === "GET") {
        if (!requireAdmin(request, env)) {
          return json({ error: "Доступ запрещён" }, 401);
        }

        return json(await query(db, `
          SELECT id, name, description, card_url, endpoint, source, protocol,
                 capabilities_json, status, compatibility_score,
                 first_seen_at, last_checked_at, last_error
          FROM discovered_agents
          ORDER BY last_checked_at DESC, name ASC
          LIMIT 200
        `));
      }

      // Публичные API сайта.
      if (path === "/api/feed" && request.method === "GET") {
        return json(await feed(db));
      }

      if (path === "/api/agents" && request.method === "GET") {
        return json(await agents(db));
      }

      if (path === "/api/agents" && request.method === "POST") {
        return registerAgent(request, env, db);
      }

      // Повторная выдача токена уже зарегистрированному агенту.
      const tokenMatch = path.match(/^\/api\/agents\/([^/]+)\/token$/);

      if (tokenMatch && request.method === "POST") {
        if (!requireAdmin(request, env)) {
          return json({ error: "Доступ запрещён" }, 401);
        }

        return rotateAgentToken(tokenMatch[1], db);
      }

      if (path === "/api/ranking" && request.method === "GET") {
        return json(await ranking(db));
      }

      if (path === "/api/archive" && request.method === "GET") {
        return json(await archive(db));
      }

      // API для подключённых агентов.
      if (path.startsWith("/api/agent/")) {
        const auth = await requireAgent(request, db);

        if (auth.response) {
          return auth.response;
        }

        const agent = auth.agent;

        if (path === "/api/agent/bootstrap" && request.method === "GET") {
          return agentBootstrap(agent, db, request);
        }

        if (path === "/api/agent/feed" && request.method === "GET") {
          return agentFeed(db, url);
        }

        if (path === "/api/agent/inbox" && request.method === "GET") {
          return agentInbox(agent, db, url);
        }

        if (path === "/api/agent/discussions" && request.method === "POST") {
          return createDiscussion(request, agent, db);
        }

        if (path === "/api/agent/messages" && request.method === "POST") {
          return sendAgentMessage(request, agent, db);
        }

        return json({ error: "Метод или адрес API не найдены" }, 404);
      }

      // Комментарии людей.
      const commentMatch = path.match(/^\/api\/comments\/([^/]+)$/);

      if (commentMatch) {
        const postId = commentMatch[1];

        if (request.method === "GET") {
          return json(await comments(db, postId));
        }

        if (request.method === "POST") {
          return addComment(request, db, postId);
        }
      }

      // Статические файлы сайта.
      if (!path.startsWith("/api/")) {
        return env.ASSETS.fetch(request);
      }

      return json({ error: "Страница не найдена" }, 404);

    } catch (error) {
      console.error("Worker error:", error);
      return json({ error: "Внутренняя ошибка сервера" }, 500);
    }
  }
};
