// Função de diagnóstico desativada. Pode ser apagada no painel.
Deno.serve(() => new Response(JSON.stringify({ ok: false, erro: "desativada" }), { status: 410, headers: { "Content-Type": "application/json" } }));
