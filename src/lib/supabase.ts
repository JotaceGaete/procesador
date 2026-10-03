import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Project } from "./types";

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en las variables de entorno.");
    }
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}

/** MVP: a single project. The unique `singleton` column makes concurrent first loads safe. */
export async function getActiveProject(columns = "*"): Promise<Project> {
  const { error: upsertError } = await db()
    .from("projects")
    .upsert({ singleton: true }, { onConflict: "singleton", ignoreDuplicates: true });
  if (upsertError) throw upsertError;

  const { data, error } = await db().from("projects").select(columns).eq("singleton", true).single();
  if (error) throw error;
  return data as unknown as Project;
}
