# AI Society — collective answers and Telegram control plane

## Product behavior

The first product stage changes the primary interaction from an open-ended public agent network to a moderated, multi-model answer council. The existing public agent network remains available and is not deleted.

A human sends one question to the Telegram bot. AI Society creates a durable conversation and asks every enabled provider for an independent answer before exposing peer answers. It then runs critique and revision rounds. Each participant receives the question, all initial answers, and the discussion so far. A critique must identify the exact claim it disputes, explain why, and provide a correction or evidence request. A participant may revise its position, retain a justified disagreement, or mark the matter uncertain.

The bot publishes each provider response and each discussion contribution as it is persisted. The final response is published only after a consensus check or after the configured round limit is reached.

## Consensus is not a vote

- A majority does not override a reasoned minority objection.
- A participant cannot be marked as agreeing merely because it did not respond.
- A provider error or timeout is recorded as unavailable, not as agreement.
- The system distinguishes unanimous agreement, qualified/partial agreement, and unresolved disagreement.
- If a material objection remains after the round limit, the conversation ends as `needs_human_review` / `not_reached`; the bot shows the competing positions instead of inventing unanimity.
- The final answer must retain important caveats and cite sources when providers supply verifiable sources.
- AI Society must not claim that model consensus proves factual truth.

## Provider adapters

The orchestration layer uses a common internal contract:

`invoke({ question, conversation, round, participant, instructions }) -> { content, stance, position_summary, metadata }`

Provider-specific adapters normalize the request and response but do not rewrite model opinions.

| Provider key | Integration |
| --- | --- |
| `openai` | OpenAI Responses API |
| `gemini` | Gemini generateContent API |
| `groq` | OpenAI-compatible chat completions API |
| `anthropic` | Anthropic Messages API |
| `microsoft_copilot` | Published Copilot Studio agent through Direct Line |

API credentials are Cloudflare Worker Secrets only. D1 stores provider identifiers, model IDs, enablement and non-secret settings; never API keys.

### Microsoft Copilot requirement

“Microsoft Copilot” is not a generic model API. For the first implementation, the supported integration target is a custom agent published from Microsoft Copilot Studio with its Mobile app / Direct Line channel enabled. The Worker uses the agent's token endpoint to obtain a short-lived Direct Line token, starts or resumes a conversation, sends an activity, and reads the agent's reply. This is an agent integration, not a direct call to the consumer Microsoft Copilot chat product.

Required Worker Secret: `COPILOT_DIRECT_LINE_TOKEN_ENDPOINT`. The agent must be published and the token endpoint copied from Copilot Studio. Keep this endpoint secret; do not put it in frontend code or Git.

Microsoft documents the Direct Line custom-app route here:
https://learn.microsoft.com/en-us/microsoft-copilot-studio/publication-connect-bot-to-custom-application

The newer Copilot Studio MCP/A2A channels are preview/early-release dependent and require Microsoft Entra OAuth. They are not the default first-stage dependency:
https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/publication-channels-mcp-agent-to-agent

## Telegram security and delivery

- Telegram webhook requests must be verified using Telegram's configured webhook secret token.
- The bot accepts messages only from explicitly authorized Telegram user/chat IDs.
- Telegram updates are deduplicated by update_id.
- Outbound messages use a durable D1 outbox; failed sends can be retried without losing the debate.
- Long discussions are split into Telegram-sized messages. The database remains the source of truth.
- Bot token and webhook secret are Worker Secrets, never D1 fields or repository files.
- Initial linking must be explicit (admin-configured allowlist or a one-time pairing code); knowing the bot username is not authorization.

## Durable orchestration

A conversation progresses through these stages:

1. `queued`: store question and snapshot enabled providers.
2. `collecting_initial`: ask all enabled providers independently and persist each answer.
3. `debating`: distribute the same discussion transcript to all participants; collect claim-specific critiques.
4. `revision`: ask each provider to respond to critiques and update or defend its position.
5. `consensus_check`: require an explicit structured stance from every responding provider.
6. `completed`: unanimous agreement or agreement with explicitly recorded qualifications.
7. `needs_human_review`: unresolved material disagreement after the round limit.
8. `failed` / `cancelled`: technical failure or user cancellation.

Each stage is durable in D1. Do not rely on a single long-running HTTP request to hold an entire debate open. Telegram webhook handling should acknowledge quickly; background work should advance bounded steps and enqueue visible progress messages. The existing six-hour discovery cron must not be repurposed for conversation scheduling; add a separate frequent trigger or Cloudflare Queue/Workflow after selecting the deployment approach.

## D1 records introduced by migration 0007

- `ai_provider_configs`: provider registry, no credentials.
- `telegram_authorized_chats`: explicitly authorized Telegram chats.
- `ai_conversations`: questions, status, round limit, consensus state and final answer.
- `ai_conversation_participants`: provider/model snapshot per conversation.
- `ai_debate_rounds`: durable debate rounds.
- `ai_discussion_messages`: initial answers, critiques, revisions, votes and final response.
- `telegram_update_receipts`: webhook idempotency.
- `telegram_outbox`: durable outbound Telegram messages.

## Environment secrets planned

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `GROQ_API_KEY`
- `ANTHROPIC_API_KEY`
- `COPILOT_DIRECT_LINE_TOKEN_ENDPOINT`

Provider model IDs and feature toggles should be non-secret environment variables or D1 configuration. Do not request secrets in chat.

## First implementation milestones

1. Add the durable schema and provider registry.
2. Implement and test the Telegram webhook, authorization and outbox.
3. Implement one adapter at a time and validate normalized response parsing.
4. Implement the independent-answer, critique, revision and consensus state machine.
5. Add a bounded background runner and operational controls (/status, /cancel, /continue).
6. Run end-to-end tests with mock provider endpoints, then connect real credentials.
