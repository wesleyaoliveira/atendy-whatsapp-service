import {
  shouldIgnoreIncoming,
  isGroupJid,
  isSupportedIndividualJid,
  unwrapMessageContent,
} from "./filters.js";
import { Router } from "express";
import pino from "pino";
import QRCode from "qrcode";
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
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
  status: "pending" | "qr" | "connecting" | "connected" | "disconnected" | "needs_reconnect" | "error";
  qr?: string | null;
  phone?: string | null;
  profileName?: string | null;
  profilePicUrl?: string | null;
  retries: number;
  starting?: boolean;
};

const sessions = new Map<string, SessionState>();
const manuallyStoppedSessions = new Set<string>();
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
function getIncomingMediaInfo(msg: any) {
  const m = unwrapMessageContent(msg?.message ?? msg ?? {});

  if (m.imageMessage) {
    return {
      mediaType: "image",
      mimetype: m.imageMessage.mimetype ?? "image/jpeg",
      caption: m.imageMessage.caption ?? "",
      fileName: null,
      fileSize: Number(m.imageMessage.fileLength ?? 0),
      duration: null,
    };
  }

  if (m.videoMessage) {
    return {
      mediaType: "video",
      mimetype: m.videoMessage.mimetype ?? "video/mp4",
      caption: m.videoMessage.caption ?? "",
      fileName: null,
      fileSize: Number(m.videoMessage.fileLength ?? 0),
      duration: m.videoMessage.seconds ?? null,
    };
  }

  if (m.audioMessage) {
    return {
      mediaType: "audio",
      mimetype: m.audioMessage.mimetype ?? "audio/ogg",
      caption: "",
      fileName: null,
      fileSize: Number(m.audioMessage.fileLength ?? 0),
      duration: m.audioMessage.seconds ?? null,
    };
  }

  if (m.documentMessage) {
    return {
      mediaType: "document",
      mimetype: m.documentMessage.mimetype ?? "application/octet-stream",
      caption: m.documentMessage.caption ?? "",
      fileName: m.documentMessage.fileName ?? "arquivo",
      fileSize: Number(m.documentMessage.fileLength ?? 0),
      duration: null,
    };
  }

  if (m.stickerMessage) {
    return {
      mediaType: "sticker",
      mimetype: m.stickerMessage.mimetype ?? "image/webp",
      caption: "",
      fileName: "sticker.webp",
      fileSize: Number(m.stickerMessage.fileLength ?? 0),
      duration: null,
    };
  }

  return null;
}
function isDecryptSessionError(e: unknown) {
  const msg = String((e as Error)?.message || e || "");
  return /Bad MAC|Failed to decrypt|No matching sessions|decrypt/i.test(msg);
}

async function destroySession(sessionId: string, options: { wipeAuth?: boolean; removeDb?: boolean } = {}) {
manuallyStoppedSessions.add(sessionId);
log.info({ sid: sessionId }, "SESSION_MANUAL_STOP_REGISTERED");
  
  const wipeAuth = options.wipeAuth ?? true;
  const removeDb = options.removeDb ?? false;

  log.info({ sid: sessionId }, "SESSION_RESET_STARTED");

  const s = sessions.get(sessionId);

  if (s?.sock) {
    try {
      log.info({ sid: sessionId }, "SESSION_LOGOUT_STARTED");
      await s.sock.logout();
    } catch (e) {
      log.warn({ err: e, sid: sessionId }, "SESSION_LOGOUT_ERROR");
    }

    try {
      s.sock.ws?.close?.();
    } catch {
      /* ignore */
    }

    try {
      s.sock.end?.(undefined);
    } catch {
      /* ignore */
    }

    log.info({ sid: sessionId }, "SESSION_SOCKET_CLOSED");
  }

  sessions.delete(sessionId);
  log.info({ sid: sessionId }, "SESSION_MEMORY_REMOVED");

  if (wipeAuth) {
    try {
      log.info({ sid: sessionId }, "SESSION_AUTH_CLEANUP_STARTED");
      await deleteAllAuth(sessionId);
      log.info({ sid: sessionId }, "SESSION_AUTH_CLEANUP_SUCCESS");
    } catch (e) {
      log.error({ err: e, sid: sessionId }, "SESSION_AUTH_CLEANUP_ERROR");
    }
  }

  if (removeDb) {
    await pool.query("DELETE FROM sessions WHERE session_id=$1", [sessionId]);
  } else {
    await pool.query(
      "UPDATE sessions SET status='disconnected', phone=NULL, profile_name=NULL, updated_at=now() WHERE session_id=$1",
      [sessionId],
    );
  }

  log.info({ sid: sessionId }, "SESSION_RESET_SUCCESS");

  return { ok: true };
}

async function markSessionNeedsReconnect(sessionId: string, webhookUrl?: string) {
  const s = sessions.get(sessionId);

  if (s) {
    s.status = "needs_reconnect";
    s.qr = null;
  }

  await pool.query(
    "UPDATE sessions SET status='needs_reconnect', updated_at=now() WHERE session_id=$1",
    [sessionId],
  );

  log.warn({ sid: sessionId }, "SESSION_MARKED_NEEDS_RECONNECT");

  if (webhookUrl) {
    try {
      await postWebhook(webhookUrl, "connection.update", {
        status: "needs_reconnect",
        reason: "decrypt_bad_mac",
      });
    } catch (e) {
      log.warn({ err: e, sid: sessionId }, "NEEDS_RECONNECT_WEBHOOK_ERROR");
    }
  }
}
async function startSession(sessionId: string): Promise<void> {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("session missing");

  if (manuallyStoppedSessions.has(sessionId)) {
    log.info({ sid: sessionId }, "SESSION_RECONNECT_SKIPPED_MANUAL_STOP");
    return;
  }

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
  if (me?.id) {
    profilePicUrl = (await sock.profilePictureUrl(me.id, "image")) ?? null;
  }
} catch {
  /* ignore */
}

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

  if (manuallyStoppedSessions.has(sessionId)) {
    log.info({ sid: sessionId }, "SESSION_RECONNECT_SKIPPED_MANUAL_STOP");
    return;
  }

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
  try {
    if (type !== "notify") return;

    log.info(
      {
        sid: sessionId,
        count: messages?.length ?? 0,
        type,
      },
      "MESSAGES_UPSERT_RECEIVED",
    );

    const out = [];

    for (const m of messages ?? []) {
      const reason = shouldIgnoreIncoming(m);

      if (reason) {
        log.info(
          {
            sid: sessionId,
            reason,
            remoteJid: m?.key?.remoteJid,
            fromMe: m?.key?.fromMe,
            pushName: m?.pushName,
          },
          reason,
        );
        continue;
      }

      const msg = unwrapMessageContent(m.message ?? {});

      const text =
        msg.conversation ??
        msg.extendedTextMessage?.text ??
        msg.imageMessage?.caption ??
        msg.videoMessage?.caption ??
        msg.documentMessage?.caption ??
        "";

      const mediaInfo = getIncomingMediaInfo(m);

      if (mediaInfo) {
        log.info(
          {
            sid: sessionId,
            remoteJid: m?.key?.remoteJid,
            mediaType: mediaInfo.mediaType,
            mimetype: mediaInfo.mimetype,
            fileName: mediaInfo.fileName,
            fileSize: mediaInfo.fileSize,
          },
          "INCOMING_MEDIA_DETECTED",
        );

        if (!text) {
          log.info(
            {
              sid: sessionId,
              remoteJid: m?.key?.remoteJid,
              mediaType: mediaInfo.mediaType,
            },
            "INCOMING_MEDIA_WITHOUT_CAPTION_ACCEPTED",
          );
        }
      }

      let mediaBase64: string | null = null;
      let downloadedFileSize = mediaInfo?.fileSize ?? null;

      if (mediaInfo) {
        try {
          log.info(
            {
              sid: sessionId,
              remoteJid: m?.key?.remoteJid,
              mediaType: mediaInfo.mediaType,
            },
            "INCOMING_MEDIA_DOWNLOAD_STARTED",
          );

          const buffer = await downloadMediaMessage(
            m,
            "buffer",
            {},
            {
              logger: log.child({ sid: sessionId, mod: "media-download" }) as never,
              reuploadRequest: sock.updateMediaMessage,
            },
          );

          const sizeBytes = Buffer.byteLength(buffer);
          downloadedFileSize = sizeBytes;

          if (sizeBytes > 25 * 1024 * 1024) {
            log.warn(
              {
                sid: sessionId,
                remoteJid: m?.key?.remoteJid,
                mediaType: mediaInfo.mediaType,
                sizeBytes,
              },
              "INCOMING_MEDIA_TOO_LARGE",
            );
          } else {
            mediaBase64 = buffer.toString("base64");

            log.info(
              {
                sid: sessionId,
                remoteJid: m?.key?.remoteJid,
                mediaType: mediaInfo.mediaType,
                sizeBytes,
              },
              "INCOMING_MEDIA_DOWNLOAD_SUCCESS",
            );
          }
        } catch (e) {
          if (isDecryptSessionError(e)) {
            log.error(
              {
                err: e,
                sid: sessionId,
                remoteJid: m?.key?.remoteJid,
              },
              "WHATSAPP_DECRYPT_BAD_MAC_DETECTED",
            );

            await markSessionNeedsReconnect(sessionId, s.webhookUrl);
            return;
          }

          log.error(
            {
              err: e,
              sid: sessionId,
              remoteJid: m?.key?.remoteJid,
              mediaType: mediaInfo.mediaType,
            },
            "INCOMING_MEDIA_DOWNLOAD_ERROR",
          );
        }
      }

      const remoteJid = m.key.remoteJid ?? null;

      const remoteJidAlt =
        (m.key as any)?.remoteJidAlt ??
        (m as any)?.remoteJidAlt ??
        null;

      const senderPn =
        (m.key as any)?.senderPn ??
        (m.key as any)?.participantPn ??
        (m as any)?.senderPn ??
        null;

      const participant =
        m.key.participant ??
        (m.key as any)?.participant ??
        null;

      const addressingMode =
        (m.key as any)?.addressingMode ??
        (m as any)?.addressingMode ??
        null;

      out.push({
        id: m.key.id,
        from: remoteJid,
        remoteJid,
        remoteJidAlt,
        senderPn,
        participant,
        addressingMode,
        fromMe: m.key.fromMe ?? false,
        pushName: m.pushName ?? null,
        timestamp: Number(m.messageTimestamp ?? 0),
        text,
        mediaType: mediaInfo?.mediaType ?? null,
        mimetype: mediaInfo?.mimetype ?? null,
        fileName: mediaInfo?.fileName ?? null,
        fileSize: downloadedFileSize,
        caption: mediaInfo?.caption ?? null,
        duration: mediaInfo?.duration ?? null,
        mediaBase64,
      });
    }

    if (!out.length) return;

    log.info(
      {
        sid: sessionId,
        webhookUrl: s.webhookUrl,
        count: out.length,
      },
      "POST_WEBHOOK_ATTEMPT",
    );

    await postWebhook(s.webhookUrl, "messages.upsert", { messages: out });

    log.info(
      {
        sid: sessionId,
        webhookUrl: s.webhookUrl,
        count: out.length,
        hasMedia: out.some((m) => !!m.mediaType),
      },
      "POST_WEBHOOK_SUCCESS",
    );

    if (out.some((m) => !!m.mediaType)) {
      log.info(
        {
          sid: sessionId,
          count: out.filter((m) => !!m.mediaType).length,
        },
        "INCOMING_MEDIA_WEBHOOK_SENT",
      );
    }
  } catch (e) {
    if (isDecryptSessionError(e)) {
      log.error(
        {
          err: e,
          sid: sessionId,
        },
        "WHATSAPP_DECRYPT_BAD_MAC_DETECTED",
      );

      await markSessionNeedsReconnect(sessionId, s.webhookUrl);
      return;
    }

    log.error(
      {
        err: e,
        sid: sessionId,
      },
      "MESSAGES_UPSERT_ERROR",
    );
  }
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
  
  if (manuallyStoppedSessions.delete(sessionId)) {
  log.info({ sid: sessionId }, "SESSION_MANUAL_STOP_CLEARED_ON_NEW_CONNECT");
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
  
if (manuallyStoppedSessions.delete(id)) {
  log.info({ sid: id }, "SESSION_MANUAL_STOP_CLEARED_ON_RESTART");
}
  
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: "not found" });
  
  try { s.sock?.end(undefined); } catch { /* noop */ }
  s.sock = undefined;
  s.retries = 0;
  startSession(id).catch((e) => log.error({ err: e }, "restart err"));
  res.json(snap(id));
});

// POST /sessions/:id/reset
sessionsRouter.post("/:id/reset", async (req, res) => {
  const id = req.params.id;

  try {
    await destroySession(id, { wipeAuth: true, removeDb: false });

    const s = sessions.get(id);

    if (!s) {
      return res.json({ ok: true, status: "disconnected" });
    }

    return res.json(snap(id));
  } catch (e) {
    log.error({ err: e, sid: id }, "SESSION_RESET_ERROR");

    return res.status(500).json({
      ok: false,
      error: (e as Error).message,
    });
  }
});

// DELETE /sessions/:id
sessionsRouter.delete("/:id", async (req, res) => {
  const id = req.params.id;
  const s = sessions.get(id);

  try {
    await destroySession(id, { wipeAuth: true, removeDb: true });

    if (s?.webhookUrl) {
      await postWebhook(s.webhookUrl, "session.deleted", {});
    }

    return res.json({ ok: true });
  } catch (e) {
    log.error({ err: e, sid: id }, "SESSION_DELETE_ERROR");

    return res.status(500).json({
      ok: false,
      error: (e as Error).message,
    });
  }
});

// POST /sessions/:id/send  { to, text }
sessionsRouter.post("/:id/send", async (req, res) => {
  const id = req.params.id;
  const { to, text } = req.body ?? {};

  if (typeof to !== "string" || typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "to and text required" });
  }

  const s = sessions.get(id);

  log.info(
    {
      sid: id,
      status: s?.status,
      to,
      textLength: text.length,
    },
    "SEND_REQUEST_RECEIVED",
  );

  if (!s?.sock || s.status !== "connected") {
    return res.status(409).json({ error: "session not connected" });
  }

  let jid = to.trim();

  if (!jid.includes("@")) {
    jid = `${jid.replace(/\D/g, "")}@s.whatsapp.net`;
  }

  if (isGroupJid(jid)) {
    return res.status(400).json({
      error: "Envio para grupos está desabilitado no MVP.",
    });
  }

  if (!isSupportedIndividualJid(jid)) {
    return res.status(400).json({
      error: `JID não suportado no MVP: ${jid}`,
    });
  }

  try {
    log.info(
      {
        sid: id,
        jid,
      },
      "TO_JID",
    );

    const sent = await s.sock.sendMessage(jid, { text });

    log.info(
      {
        sid: id,
        jid,
        messageId: sent?.key?.id ?? null,
      },
      "MESSAGE_SENT",
    );

    res.json({
      ok: true,
      id: sent?.key?.id ?? null,
    });
  } catch (e) {
    log.error(
      {
        err: e,
        jid,
        sid: id,
      },
      "SEND_ERROR",
    );

    res.status(500).json({
      error: (e as Error).message,
    });
  }
});

// POST /sessions/:id/send-media  { to, type, url, caption, fileName, mimetype }
sessionsRouter.post("/:id/send-media", async (req, res) => {
  const id = req.params.id;
  const { to, type, url, caption, fileName, mimetype } = req.body ?? {};

  if (typeof to !== "string" || typeof type !== "string" || typeof url !== "string") {
    return res.status(400).json({
      error: "to, type and url are required",
    });
  }

  const s = sessions.get(id);

  log.info(
    {
      sid: id,
      status: s?.status,
      to,
      type,
      url,
      mimetype,
      fileName,
    },
    "SEND_MEDIA_REQUEST_RECEIVED",
  );

  if (!s?.sock || s.status !== "connected") {
    return res.status(409).json({
      error: "session not connected",
    });
  }

  let jid = to.trim();

  if (!jid.includes("@")) {
    jid = `${jid.replace(/\D/g, "")}@s.whatsapp.net`;
  }

  if (isGroupJid(jid)) {
    return res.status(400).json({
      error: "Envio para grupos está desabilitado no MVP.",
    });
  }

  if (!isSupportedIndividualJid(jid)) {
    return res.status(400).json({
      error: `JID não suportado no MVP: ${jid}`,
    });
  }

  const mediaType = type === "file" ? "document" : type;

  if (!["image", "video", "audio", "document"].includes(mediaType)) {
    return res.status(400).json({
      error: `Tipo de mídia não suportado: ${type}`,
    });
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return res.status(400).json({
      error: "URL da mídia precisa ser pública e começar com http ou https.",
    });
  }

  try {
    log.info(
      {
        sid: id,
        jid,
        mediaType,
        url,
      },
      "SEND_MEDIA_ATTEMPT",
    );

    let payload: any;

    if (mediaType === "image") {
      payload = {
        image: { url },
        caption: caption || undefined,
        mimetype: mimetype || "image/jpeg",
      };
    }

    if (mediaType === "video") {
      payload = {
        video: { url },
        caption: caption || undefined,
        mimetype: mimetype || "video/mp4",
      };
    }

    if (mediaType === "audio") {
      payload = {
        audio: { url },
        mimetype: mimetype || "audio/mpeg",
        ptt: false,
      };
    }

    if (mediaType === "document") {
      payload = {
        document: { url },
        fileName: fileName || "arquivo",
        mimetype: mimetype || "application/octet-stream",
        caption: caption || undefined,
      };
    }

    const sent = await s.sock.sendMessage(jid, payload);

    log.info(
      {
        sid: id,
        jid,
        mediaType,
        messageId: sent?.key?.id ?? null,
      },
      "SEND_MEDIA_SUCCESS",
    );

    return res.json({
      ok: true,
      id: sent?.key?.id ?? null,
    });
  } catch (e) {
    log.error(
      {
        err: e,
        sid: id,
        jid,
        type,
        url,
      },
      "SEND_MEDIA_ERROR",
    );

    return res.status(500).json({
      error: (e as Error).message,
    });
  }
});
