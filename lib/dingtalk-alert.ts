import crypto from "crypto";

type DingTalkAlertPayload = {
  title: string;
  message: string;
  tags?: Record<string, string | number | boolean | null | undefined>;
};

const DINGTALK_ALERT_TIMEOUT_MS = 2500;

function buildSignedWebhook(webhookUrl: string, secret?: string) {
  if (!secret) {
    return webhookUrl;
  }

  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto.createHmac("sha256", secret).update(stringToSign).digest("base64");
  const url = new URL(webhookUrl);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);
  return url.toString();
}

export function isDingTalkAlertConfigured() {
  return Boolean(process.env.DINGTALK_WEBHOOK_URL?.trim());
}

export async function sendDingTalkAlert(payload: DingTalkAlertPayload) {
  const webhookUrl = process.env.DINGTALK_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    return { skipped: true };
  }

  const lines = [
    `### ${payload.title}`,
    payload.message,
    ...(payload.tags
      ? Object.entries(payload.tags)
          .filter(([, value]) => value !== undefined && value !== null && value !== "")
          .map(([key, value]) => `- ${key}: ${String(value)}`)
      : []),
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DINGTALK_ALERT_TIMEOUT_MS);

  try {
    const response = await fetch(buildSignedWebhook(webhookUrl, process.env.DINGTALK_SECRET?.trim()), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: {
          title: payload.title,
          text: lines.join("\n\n"),
        },
      }),
    });

    clearTimeout(timeout);
    if (!response.ok) {
      return { skipped: false, ok: false, status: response.status };
    }
    return { skipped: false, ok: true };
  } catch (error) {
    clearTimeout(timeout);
    console.error("DingTalk alert failed", error);
    return { skipped: false, ok: false };
  }
}
