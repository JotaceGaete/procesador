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

/** MVP: un único proyecto activo. Devuelve el más antiguo, o lo crea si no existe. */
export async function getActiveProject(): Promise<Project> {
  const { data, error } = await db().from("projects").select("*").order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (error) throw error;
  if (data) return data as Project;

  const { data: created, error: insertError } = await db().from("projects").insert({}).select("*").single();
  if (insertError) throw insertError;
  return created as Project;
}
