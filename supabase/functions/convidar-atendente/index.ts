// Convida uma pessoa para a equipe (só administradores). A pessoa recebe um e-mail para criar a senha.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function resp(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return resp({ ok: false, erro: "Método não permitido." }, 405);
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u } = await supabase.auth.getUser(jwt);
    if (!u?.user) return resp({ ok: false, erro: "Sessão expirada. Entre de novo." }, 401);
    const { data: eu } = await supabase.from("equipe").select("papel").eq("usuario_id", u.user.id).maybeSingle();
    if (eu?.papel !== "admin") return resp({ ok: false, erro: "Só administradores convidam pessoas." }, 403);

    const corpo: any = await req.json().catch(() => ({}));
    const nome = String(corpo.nome ?? "").trim().slice(0, 60);
    const email = String(corpo.email ?? "").trim().toLowerCase();
    const papel = corpo.papel === "admin" ? "admin" : "atendente";
    const redirectTo = typeof corpo.redirect_to === "string" ? corpo.redirect_to : undefined;
    if (!nome || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return resp({ ok: false, erro: "Informe o nome e um e-mail válido." }, 400);
    }

    const { data: convite, error } = await supabase.auth.admin.inviteUserByEmail(email, { data: { nome }, redirectTo });
    if (error || !convite?.user) {
      console.error("convidar-atendente:", error?.message);
      const jaExiste = /already|registered/i.test(error?.message ?? "");
      return resp({ ok: false, erro: jaExiste ? "Esse e-mail já tem conta." : "Não consegui enviar o convite. Tente de novo." }, 400);
    }
    const { error: ee } = await supabase.from("equipe").upsert({ usuario_id: convite.user.id, nome, papel }, { onConflict: "usuario_id" });
    if (ee) {
      console.error("convidar-atendente: equipe", ee.message);
      return resp({ ok: false, erro: "O convite foi enviado, mas houve erro ao cadastrar na equipe." }, 500);
    }
    return resp({ ok: true });
  } catch (e) {
    console.error("convidar-atendente: erro", e instanceof Error ? e.message : String(e));
    return resp({ ok: false, erro: "Algo deu errado. Tente de novo." }, 500);
  }
});
