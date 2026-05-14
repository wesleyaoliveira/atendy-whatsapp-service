// Postgres-backed Baileys auth state — replaces useMultiFileAuthState.
// Persists creds + signal keys so sessions survive restarts.

import {
  initAuthCreds,
  proto,
  BufferJSON,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import { pool } from "./db.js";

async function readKey(sessionId: string, key: string): Promise<unknown | null> {
  const { rows } = await pool.query("SELECT value FROM auth_keys WHERE session_id=$1 AND key=$2", [sessionId, key]);
  if (!rows[0]) return null;
  return JSON.parse(JSON.stringify(rows[0].value), BufferJSON.reviver);
}

async function writeKey(sessionId: string, key: string, value: unknown) {
  const serialized = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
  await pool.query(
    `INSERT INTO auth_keys(session_id,key,value) VALUES($1,$2,$3)
     ON CONFLICT (session_id,key) DO UPDATE SET value=EXCLUDED.value`,
    [sessionId, key, serialized],
  );
}

async function deleteKey(sessionId: string, key: string) {
  await pool.query("DELETE FROM auth_keys WHERE session_id=$1 AND key=$2", [sessionId, key]);
}

export async function deleteAllAuth(sessionId: string) {
  await pool.query("DELETE FROM auth_keys WHERE session_id=$1", [sessionId]);
}

export async function usePostgresAuthState(sessionId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const credsRaw = (await readKey(sessionId, "creds")) as AuthenticationCreds | null;
  const creds: AuthenticationCreds = credsRaw ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result: { [id: string]: SignalDataTypeMap[typeof type] } = {};
          await Promise.all(
            ids.map(async (id) => {
              const v = await readKey(sessionId, `${type}-${id}`);
              if (v) {
                result[id] =
                  type === "app-state-sync-key"
                    ? (proto.Message.AppStateSyncKeyData.fromObject(v as object) as never)
                    : (v as never);
              }
            }),
          );
          return result;
        },
        set: async (data) => {
          const tasks: Promise<unknown>[] = [];
          for (const category in data) {
            const cat = data[category as keyof SignalDataTypeMap];
            if (!cat) continue;
            for (const id in cat) {
              const value = (cat as Record<string, unknown>)[id];
              const k = `${category}-${id}`;
              tasks.push(value ? writeKey(sessionId, k, value) : deleteKey(sessionId, k));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeKey(sessionId, "creds", creds);
    },
  };
}
