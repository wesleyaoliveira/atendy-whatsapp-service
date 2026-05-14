import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" }).child({ mod: "webhook" });
const TOKEN = () => process.env.SERVICE_TOKEN ?? "";

export async function postWebhook(url: string, event: string, data: unknown) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN()}`,
      },
      body: JSON.stringify({ event, data }),
    });
    if (!res.ok) log.warn({ status: res.status, url, event }, "webhook non-2xx");
  } catch (e) {
    log.error({ err: e, url, event }, "webhook error");
  }
}
