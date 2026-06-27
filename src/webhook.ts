import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" }).child({ mod: "webhook" });
const TOKEN = () => process.env.SERVICE_TOKEN ?? "";

export async function postWebhook(webhookUrl: string, event: string, data: any) {
  const payload = {
    event,
    data,
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const responseBody = await res.text().catch(() => "");

    console.log("POST_WEBHOOK_NON_2XX", {
      event,
      url: webhookUrl,
      status: res.status,
      response: responseBody.slice(0, 500),
      payload: {
        event,
        messagesCount: Array.isArray(data?.messages) ? data.messages.length : null,
        status: data?.status ?? null,
        hasQr: Boolean(data?.qr),
      },
    });

    return {
      ok: false,
      status: res.status,
      response: responseBody,
    };
  }

  console.log("POST_WEBHOOK_SUCCESS", {
    event,
    url: webhookUrl,
    status: res.status,
    payload: {
      messagesCount: Array.isArray(data?.messages) ? data.messages.length : null,
      status: data?.status ?? null,
      hasQr: Boolean(data?.qr),
    },
  });

  return {
    ok: true,
    status: res.status,
  };
}
