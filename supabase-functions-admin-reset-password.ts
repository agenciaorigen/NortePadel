// ============================================================
// Edge Function: admin-reset-password
// ============================================================
// Qué hace: blanquea la clave de un jugador. Solo la puede llamar alguien
// que ya esté logueado Y figure en la tabla `admins` — se valida ACÁ, del
// lado del servidor, no confiando en el chequeo del cliente.
//
// CÓMO DEPLOYARLA (sin instalar nada en tu computadora):
//   1. Supabase Dashboard -> tu proyecto -> Edge Functions -> "Deploy a new function"
//   2. Nombre de la función: admin-reset-password (tiene que ser EXACTO,
//      así lo llama app.js)
//   3. Pegá todo este archivo como código de la función -> Deploy
//   (Supabase le da a la función SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY
//   solas, como variables de entorno -- por eso no hace falta que me pases
//   esa clave en ningún momento, ni que quede pegada en app.js)
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try {
    const { email, nuevaClave } = await req.json();
    if (!email || !nuevaClave || String(nuevaClave).length < 6) {
      return new Response(JSON.stringify({ error: "Falta email o la clave nueva es muy corta" }), { status: 400 });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1) identificar quién llama, a partir del token que manda sb.functions.invoke
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: { user }, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "No autenticado" }), { status: 401 });
    }

    // 2) confirmar que quien llama es admin (misma tabla que usa el resto de la app)
    const { data: adminRow } = await admin.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
    if (!adminRow) {
      return new Response(JSON.stringify({ error: "No autorizado" }), { status: 403 });
    }

    // 3) buscar al jugador de destino por email/usuario
    const { data: jugador } = await admin.from("jugadores").select("id, auth_user_id").eq("email", email).maybeSingle();
    if (!jugador?.auth_user_id) {
      return new Response(JSON.stringify({ error: "No se encontró ese usuario" }), { status: 404 });
    }

    // 4) blanquear la clave y marcarle que la tiene que cambiar al entrar
    //    (mismo flag que usan las cuentas importadas con clave provisoria)
    const { error: updErr } = await admin.auth.admin.updateUserById(jugador.auth_user_id, { password: nuevaClave });
    if (updErr) return new Response(JSON.stringify({ error: updErr.message }), { status: 500 });
    await admin.from("jugadores").update({ debe_cambiar_clave: true }).eq("id", jugador.id);

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
