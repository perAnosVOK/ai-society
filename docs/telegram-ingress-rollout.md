# Telegram ingress rollout (PR #18)

The Worker now accepts Telegram updates at `POST /api/telegram/webhook`.
It validates `X-Telegram-Bot-Api-Secret-Token` against the Cloudflare Worker Secret
`TELEGRAM_WEBHOOK_SECRET`, stores update IDs for idempotency, and sends replies
via a D1-backed outbox using `TELEGRAM_BOT_TOKEN`.

The first private `/start` reply displays the user's Telegram chat ID.
Questions are accepted only from a private chat that an administrator has
authorized. No AI provider is called yet; questions remain queued in D1.

## Deployment steps

1. Merge the PR and confirm D1 migration 0007 applied and Worker deployment succeeded.
2. Confirm Worker Secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` exist.
3. Register Telegram webhook using Telegram's `setWebhook` API with URL
   `https://ai-society.vitaliy-sopruk.workers.dev/api/telegram/webhook`
   and the **same** `secret_token` value as the Worker secret.
   Do not paste either secret into a chat or commit it to the repository.
4. Send `/start` to `@ok_ai_society_bot`; the bot returns a numeric chat ID.
5. The administrator calls `POST /api/admin/telegram/authorize` with
   `Authorization: Bearer <ADMIN_TOKEN>` and JSON
   `{"chat_id":"<PRIVATE_CHAT_ID>","telegram_user_id":"<SAME_ID>"}`.
   This operation is protected by the existing Worker admin secret.
6. Send a question; the bot acknowledges storage and explicitly says that
   model debate has not yet started.

The transport currently processes private text chats only. It does not register
the webhook automatically, expose tokens, or claim to deliver model answers.
