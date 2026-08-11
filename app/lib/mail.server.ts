const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  idempotencyKey?: string;
}

export interface MailConfiguration {
  configured: boolean;
  from: string | null;
}

export function mailConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): MailConfiguration {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.MERIDIAN_EMAIL_FROM?.trim();
  return { configured: Boolean(apiKey && from), from: from || null };
}

/** Deliver transactional mail through Resend. */
export async function sendEmail(
  message: EmailMessage,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<{ id: string }> {
  const env = options.env ?? process.env;
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.MERIDIAN_EMAIL_FROM?.trim();
  if (!apiKey || !from) {
    throw new Error(
      "Email is not configured. Set RESEND_API_KEY and MERIDIAN_EMAIL_FROM.",
    );
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "user-agent": "MyMeridian/1.0 transactional-mail",
  };
  if (message.idempotencyKey) {
    headers["idempotency-key"] = message.idempotencyKey.slice(0, 256);
  }

  const response = await (options.fetchImpl ?? fetch)(RESEND_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({
      from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(
      `Email provider rejected the message (${response.status})${
        detail ? `: ${detail}` : "."
      }`,
    );
  }

  const payload = (await response.json()) as { id?: unknown };
  if (typeof payload.id !== "string" || payload.id.length === 0) {
    throw new Error("Email provider returned no message id.");
  }
  return { id: payload.id };
}
