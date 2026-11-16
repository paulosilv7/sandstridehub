// Função de teste desativada (fase 0 do Gestor de Ads). Pode ser apagada no painel.
Deno.serve(() => new Response(JSON.stringify({ ok: false, erro: "desativada" }), { status: 410, headers: { "Content-Type": "application/json" } }));
