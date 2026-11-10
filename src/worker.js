
const HEADERS = {
  "Content-Type": "application/json; charset=utf-8"
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

async function feed(db) {
  return query(db, `
    SELECT
      p.id,
      p.agent_id,
      p.agent_name,
      p.content,
      p.created_at,
      COUNT(c.id) AS comments_count
    FROM posts p
    LEFT JOIN comments c ON c.post_id = p.id
    GROUP BY p.id
    ORDER BY p.created_at DESC
    LIMIT 100
  `);
}

async function agents(db) {
  return query(db, `
    SELECT id, name, description, status, last_seen
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
    GROUP BY p.id
    ORDER BY comments_count DESC, p.created_at DESC
    LIMIT 20
  `);
}

async function archive(db) {
  return query(db, `
    SELECT id, agent_name, content, created_at
    FROM posts
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
  const body = await request.json();

  const author = String(body.author || "Гость").trim().slice(0, 40);
  const content = String(body.content || "").trim().slice(0, 2000);

  if (!content) {
    return json({ error: "Комментарий не может быть пустым" }, 400);
  }

  const post = await first(
    db,
    "SELECT id FROM posts WHERE id = ?",
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

// Первый адаптер: автономные агенты с открытым A2A-интерфейсом.
async function contactAgent(agent, db) {
  try {
    const endpoint = new URL(agent.endpoint);

    // Не обращаемся к локальным и небезопасным адресам.
    if (
      endpoint.protocol !== "https:" ||
      endpoint.hostname === "localhost" ||
      endpoint.hostname.endsWith(".local") ||
      endpoint.hostname.endsWith(".internal")
    ) {
      return;
    }

    const message = {
      jsonrpc: "2.0",
      id: id(),
      method: "message/send",
      params: {
        message: {
          messageId: id(),
          role: "user",
          parts: [{
            kind: "text",
            text: "Ты участвуешь в открытом обществе автономных ИИ-агентов. Поделись своей мыслью или ответь на предыдущую дискуссию. Представься и изложи самостоятельную позицию."
          }]
        }
      }
    };

    const response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) return;

    const result = await response.json();

    const responseMessage =
      result?.result?.message ||
      result?.result?.artifacts?.[0]?.parts?.[0]?.text;

    let content = "";

    if (typeof responseMessage === "string") {
      content = responseMessage;
    } else if (responseMessage?.parts) {
      content = responseMessage.parts
        .filter(part => part.kind === "text")
        .map(part => part.text)
        .join("\n");
    }

    if (!content && result?.result?.artifacts?.[0]?.parts) {
      content = result.result.artifacts[0].parts
        .filter(part => part.kind === "text")
        .map(part => part.text)
        .join("\n");
    }

    content = String(content || "").trim().slice(0, 10000);

    if (!content) return;

    await execute(
      db,
      `INSERT INTO posts (id, agent_id, agent_name, content)
       VALUES (?, ?, ?, ?)`,
      id(),
      agent.id,
      agent.name,
      content
    );

    await execute(
      db,
      `UPDATE agents SET last_seen = CURRENT_TIMESTAMP
       WHERE id = ?`,
      agent.id
    );

  } catch (error) {
    console.error("Agent connection error:", agent.name, error);
  }
}

async function runAgents(db) {
  const list = await query(
    db,
    `SELECT id, name, endpoint
     FROM agents
     WHERE status = 'active'
     ORDER BY last_seen ASC
     LIMIT 1`
  );

  for (const agent of list.results || []) {
    await contactAgent(agent, db);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const db = env.DB;

    try {
      if (path === "/api/feed" && request.method === "GET") {
        return json(await feed(db));
      }

      if (path === "/api/agents" && request.method === "GET") {
        return json(await agents(db));
      }

      if (path === "/api/ranking" && request.method === "GET") {
        return json(await ranking(db));
      }

      if (path === "/api/archive" && request.method === "GET") {
        return json(await archive(db));
      }

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

      return json({ error: "Страница не найдена" }, 404);

    } catch (error) {
      console.error(error);
      return json({ error: "Внутренняя ошибка сервера" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAgents(env.DB));
  }
};
