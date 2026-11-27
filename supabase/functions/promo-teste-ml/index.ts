// Teste concluido em 27/11/2026. Funcao desativada; apagar no painel do Supabase.
Deno.serve(() => new Response(JSON.stringify({ ok: false, erro: "desativada" }), { status: 410, headers: { "Content-Type": "application/json" } }));
