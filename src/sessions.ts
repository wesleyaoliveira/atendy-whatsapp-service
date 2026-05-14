import { Router } from "express";
import pino from "pino";
import QRCode from "qrcode";
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { pool } from "./db.js";
import { usePostgresAuthState, deleteAllAuth } from "./auth.js";
import { postWebhook } from "./webhook.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

type SessionState = {
  sock?: WASocket;
  webhookUrl: string;
  status: "pending" | "qr" | "connecting" | "connected" | "disconnected" | "error";
  qr?: string | null;
  phone?: string | null;
  profileName?: string | null;
  profilePicUrl?: string | null;
  retries: number;
  starting?: boolean;
};

const sessions = new Map<string, SessionState>();

function snap(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  return {
    sessionId,
    status: s.status,
    qr: s.qr ?? null,
    phone: s.phone ?? null,
    profileName: s.profileName ?? null,
    profilePicUrl: s.profilePicUrl ?? null,
  };
}

async function persistSession(sessionId: string, webhookUrl: string) {
  await pool.query(
    `INSERT INTO sessions(session_id,webhook_url,status) VALUES($1,$2,'pending')
     ON CONFLICT (session_id) DO UPDATE SET webhook_url=EXCLUDED.webhook_url, updated_at=now()`,
    [sessionId, webhookUrl],
  );
}

async function updateStatus(sessionId: string, patch: Partial<SessionState>) {
  const s = sessions.get(sessionId);
  if (!s) return;
  Object.assign(s, patch);
  await pool.query(
    `UPDATE sessions SET status=$2, phone=$3, profile_name=$4, updated_at=now() WHERE session_id=$1`,
    [sessionId, s.status, s.phone ?? null, s.profileName ?? null],
  );
}

async function startSession(sessionId: string): Promise<void> {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("session missing");
  if (s.starting) return;
  s.starting = true;

  try {
    const { state, saveCreds } = await usePostgresAuthState(sessionId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: log.child({ sid: sessionId }) as never,
      browser: ["AtendyApp", "Chrome", "1.0"],
      syncFullHistory: false,
      markOnlineOnConnect: true,
    });
    s.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (u) => {
      const { connection, lastDisconnect, qr } = u;

      if (qr) {
        try {
          const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
          s.qr = dataUrl;
          await updateStatus(sessionId, { status: "qr", qr: dataUrl });
          await postWebhook(s.webhookUrl, "qr", { qr: dataUrl });
        } catch (e) {
          log.error({ err: e }, "qr render error");
        }
      }

      if (connection === "connecting") {
        await updateStatus(sessionId, { status: "connecting" });
        await postWebhook(s.webhookUrl, "connection.update", { status: "connecting" });
      }

      if (connection === "open") {
        s.retries = 0;
        const me = sock.user;
        const phone = me?.id?.split("@")[0]?.split(":")[0] ?? null;
        const profileName = me?.name ?? null;
        let profilePicUrl: string | null = null;
        try {
          if (me?.id) profilePicUrl = await sock.profilePictureUrl(me.id, "image");
        } catch { /* ignore */ }

        await updateStatus(sessionId, {
          status: "connected",
          qr: null,
          phone,
          profileName,
          profilePicUrl,
        });
        await postWebhook(s.webhookUrl, "connection.update", {
          status: "connected",
          phone,
          profileName,
          profilePicUrl,
        });
      }

      if (connection === "close") {
        const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        s.sock = undefined;

        if (loggedOut) {
          await deleteAllAuth(sessionId);
          await updateStatus(sessionId, { status: "disconnected", qr: null, phone: null, profileName: null });
          await postWebhook(s.webhookUrl, "connection.update", { status: "logged_out" });
        } else {
          await updateStatus(sessionId, { status: "disconnected" });
          await postWebhook(s.webhookUrl, "connection.update", { status: "disconnected" });
          // exponential backoff reconnect
          const delay = Math.min(60_000, 2_000 * 2 ** Math.min(s.retries, 5));
          s.retries += 1;
          setTimeout(() => {
            s.starting = false;
            startSession(sessionId).catch((e) => log.error({ err: e }, "reconnect err"));
          }, delay);
          return;
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      const out = messages.map((m) => {
        const msg = m.message ?? {};
        const text =
          msg.conversation ??
          msg.extendedTextMessage?.text ??
          msg.imageMessage?.caption ??
          msg.videoMessage?.caption ??
          "";
        const mediaType =
          msg.imageMessage ? "image" :
          msg.videoMessage ? "video" :
          msg.audioMessage ? "audio" :
          msg.documentMessage ? "document" :
          undefined;
        return {
          id: m.key.id,
          from: m.key.remoteJid,
          fromMe: m.key.fromMe ?? false,
          pushName: m.pushName ?? null,
          timestamp: Number(m.messageTimestamp ?? 0),
          text,
          mediaType,
        };
      });
      await postWebhook(s.webhookUrl, "messages.upsert", { messages: out });
    });
  } finally {
    s.starting = false;
  }
}

export async function restoreAllSessions() {
  const { rows } = await pool.query("SELECT session_id, webhook_url FROM sessions");
  for (const row of rows) {
    sessions.set(row.session_id, {
      webhookUrl: row.webhook_url,
      status: "pending",
      retries: 0,
    });
    startSession(row.session_id).catch((e) => log.error({ err: e, sid: row.session_id }, "restore err"));
  }
  log.info({ count: rows.length }, "sessions restored");
}

/* -------------------- HTTP router -------------------- */

export const sessionsRouter = Router();

// POST /sessions  { sessionId, webhookUrl }
sessionsRouter.post("/", async (req, res) => {
  const { sessionId, webhookUrl } = req.body ?? {};
  if (typeof sessionId !== "string" || typeof webhookUrl !== "string") {
    return res.status(400).json({ error: "sessionId and webhookUrl required" });
  }
  await persistSession(sessionId, webhookUrl);
  let s = sessions.get(sessionId);
  if (!s) {
    s = { webhookUrl, status: "pending", retries: 0 };
    sessions.set(sessionId, s);
  } else {
    s.webhookUrl = webhookUrl;
  }
  if (!s.sock) {
    startSession(sessionId).catch((e) => log.error({ err: e }, "start err"));
  }
  // give it a brief moment to surface QR if one already exists in cache
  await new Promise((r) => setTimeout(r, 250));
  res.json(snap(sessionId));
});

// GET /sessions/:id
sessionsRouter.get("/:id", (req, res) => {
  const s = snap(req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  res.json(s);
});

// POST /sessions/:id/restart
sessionsRouter.post("/:id/restart", async (req, res) => {
  const id = req.params.id;
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: "not found" });
  try { s.sock?.end(undefined); } catch { /* noop */ }
  s.sock = undefined;
  s.retries = 0;
  startSession(id).catch((e) => log.error({ err: e }, "restart err"));
  res.json(snap(id));
});

// DELETE /sessions/:id
sessionsRouter.delete("/:id", async (req, res) => {
  const id = req.params.id;
  const s = sessions.get(id);
  try { await s?.sock?.logout(); } catch { /* noop */ }
  try { s?.sock?.end(undefined); } catch { /* noop */ }
  sessions.delete(id);
  await deleteAllAuth(id);
  await pool.query("DELETE FROM sessions WHERE session_id=$1", [id]);
  if (s) await postWebhook(s.webhookUrl, "session.deleted", {});
  res.json({ ok: true });
});

// POST /sessions/:id/send  { to, text }
sessionsRouter.post("/:id/send", async (req, res) => {
  const id = req.params.id;
  const { to, text } = req.body ?? {};
  if (typeof to !== "string" || typeof text !== "string") {
    return res.status(400).json({ error: "to and text required" });
  }
  const s = sessions.get(id);
  if (!s?.sock || s.status !== "connected") {
    return res.status(409).json({ error: "session not connected" });
  }
  const jid = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`;
  try {
    const sent = await s.sock.sendMessage(jid, { text });
    res.json({ ok: true, id: sent?.key?.id ?? null });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
