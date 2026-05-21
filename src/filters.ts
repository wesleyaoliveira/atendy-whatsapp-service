export const GROUP_SUFFIX = "@g.us";
export const BROADCAST_SUFFIXES = ["@broadcast", "status@broadcast"];
export const NEWSLETTER_SUFFIX = "@newsletter";
export const INDIVIDUAL_SUFFIX = "@s.whatsapp.net";
export const LID_SUFFIX = "@lid";

export type IgnoreReason =
  | "GROUP_MESSAGE_IGNORED"
  | "BROADCAST_IGNORED"
  | "NEWSLETTER_IGNORED"
  | "FROM_ME_IGNORED"
  | "EMPTY_MESSAGE_IGNORED"
  | "NO_REMOTE_JID_IGNORED"
  | "LID_UNMAPPED_IGNORED";

export function shouldIgnoreIncoming(msg: any): IgnoreReason | null {
  if (msg?.key?.fromMe) return "FROM_ME_IGNORED";

  const jid: string = (msg?.key?.remoteJid ?? "").toString();

  if (!jid) return "NO_REMOTE_JID_IGNORED";

  if (jid.endsWith(GROUP_SUFFIX)) return "GROUP_MESSAGE_IGNORED";

  if (BROADCAST_SUFFIXES.some((s) => jid.endsWith(s) || jid === s)) {
    return "BROADCAST_IGNORED";
  }

  if (jid.endsWith(NEWSLETTER_SUFFIX) || /newsletter/i.test(jid)) {
    return "NEWSLETTER_IGNORED";
  }

  const m = msg?.message ?? {};

  const text: string =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    "";

  if (!text || !String(text).trim()) return "EMPTY_MESSAGE_IGNORED";

  return null;
}

export function isGroupJid(jid: string): boolean {
  return typeof jid === "string" && jid.endsWith(GROUP_SUFFIX);
}

export function isSupportedIndividualJid(jid: string): boolean {
  return jid.endsWith(INDIVIDUAL_SUFFIX) || jid.endsWith(LID_SUFFIX);
}
