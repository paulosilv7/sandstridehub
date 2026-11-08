// Recebe os avisos do Mercado Livre (mensagens pós-venda e perguntas),
// busca o conteúdo na API e grava nas tabelas conversas e mensagens.
// Também guarda os dados do pedido ou do anúncio para o painel da conversa.
// O Mercado Livre exige resposta 200 em até 500 ms; por isso respondemos
// na hora e processamos em segundo plano.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const CLIENT_ID = Deno.env.get("ML_CLIENT_ID") ?? "7039466443806040";
const CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET") ?? "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Guarda o motivo de falhas na tabela diagnosticos (os registros da função nem sempre ficam à mão).
async function diag(origem: string, mensagem: string) {
  console.error(origem, mensagem);
  try { await supabase.from("diagnosticos").insert({ origem, mensagem: mensagem.slice(0, 1500) }); } catch (_) { /* ignora */ }
}

async function ml(caminho: string, token: string): Promise<any> {
  const r = await fetch(`https://api.mercadolibre.com${caminho}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!r.ok) {
    const corpo = (await r.text().catch(() => "")).slice(0, 300);
    throw new Error(`Mercado Livre respondeu ${r.status} em ${caminho}: ${corpo}`);
  }
  return await r.json();
}

async function tokenDaLoja(lojaId: string): Promise<string | null> {
  const ler = () =>
    supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em")
      .eq("loja_id", lojaId).maybeSingle();

  const { data: cred } = await ler();
  if (!cred) return null;

  const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 60_000;
  if (valido(cred)) return cred.token_acesso;
  if (!cred.token_renovacao) return null;

  const resp = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: cred.token_renovacao,
    }),
  });
  const t: any = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const { data: outra } = await ler();
    if (valido(outra)) return outra!.token_acesso;
    await diag("ml-notificacoes", `falha ao renovar o token: ${resp.status} ${t?.error ?? ""}`);
    return null;
  }

  await supabase.from("credenciais_lojas").update({
    token_acesso: t.access_token,
    token_renovacao: t.refresh_token ?? cred.token_renovacao,
    expira_em: new Date(Date.now() + (t.expires_in ?? 21600) * 1000).toISOString(),
    atualizado_em: new Date().toISOString(),
  }).eq("loja_id", lojaId);
  return t.access_token;
}

// Dados do pedido para o painel. O número da conversa pós-venda é o do pacote;
// se não for um pedido direto, buscamos o pedido dentro do pacote.
async function buscarPedido(token: string, id: string): Promise<any> {
  try {
    return await ml(`/orders/${id}`, token);
  } catch (_e1) {
    const pack = await ml(`/packs/${id}`, token);
    const idPedido = pack?.orders?.[0]?.id;
    if (!idPedido) throw new Error(`pacote ${id} sem pedidos`);
    return await ml(`/orders/${idPedido}`, token);
  }
}

const limpa = (v: any) => (typeof v === "string" ? v.trim() : "");

async function dadosDoPedido(token: string, idPedido: string) {
  const o = await buscarPedido(token, idPedido);
  const item = o.order_items?.[0];
  const dados: any = {
    tipo: "pedido",
    status: o.status ?? null,
    feito_em: o.date_created ?? null,
    total: o.total_amount ?? null,
    item: {
      titulo: item?.item?.title ?? null,
      variacao: (item?.item?.variation_attributes ?? []).map((a: any) => a.value_name).filter(Boolean).join(" · ") || null,
      quantidade: item?.quantity ?? null,
      preco: item?.unit_price ?? null,
    },
    pagamento: o.payments?.[0]?.payment_type ?? null,
    numero_pedido: o.id ?? null,
    apelido: o.buyer?.nickname ?? null,
  };

  // Nome real: do comprador no pedido ou do destinatário do envio.
  let nome = [limpa(o.buyer?.first_name), limpa(o.buyer?.last_name)].filter(Boolean).join(" ");
  try {
    if (o.shipping?.id) {
      const s = await ml(`/shipments/${o.shipping.id}`, token);
      dados.envio = {
        status: s.status ?? null,
        substatus: s.substatus ?? null,
        rastreio: s.tracking_number ?? null,
        cidade: s.receiver_address?.city?.name ?? null,
        uf: s.receiver_address?.state?.id ?? null,
      };
      const dest = limpa(s.receiver_address?.receiver_name);
      if (!nome && dest) nome = dest;
    }
  } catch (e) { await diag("ml-envio", `${e instanceof Error ? e.message : e}`); }

  if (!nome) {
    try {
      const b = await ml(`/orders/${o.id}/billing_info`, token);
      const bi = b?.billing_info ?? b;
      const n = [limpa(bi?.name), limpa(bi?.last_name)].filter(Boolean).join(" ");
      if (n) nome = n;
    } catch (e) { await diag("ml-faturamento", `${e instanceof Error ? e.message : e}`.slice(0, 300)); }
  }

  dados.nome_real = nome || null;
  return { dados, comprador: o.buyer ?? null, nome, titulo: item?.item?.title ?? null };
}

async function dadosDoAnuncio(token: string, itemId: string) {
  const i = await ml(`/items/${itemId}`, token);
  return {
    dados: {
      tipo: "anuncio",
      item_id: itemId,
      titulo: i.title ?? null,
      preco: i.price ?? null,
      estoque: i.available_quantity ?? null,
      vendidos: i.sold_quantity ?? null,
      status: i.status ?? null,
      link: i.permalink ?? null,
    },
    titulo: i.title ?? null,
  };
}

// ---------------------------------------------------------------------
// Mensagens pós-venda
// ---------------------------------------------------------------------
async function salvarMensagemPosVenda(loja: any, token: string, m: any) {
  const recursos: any[] = m.message_resources ?? [];
  const ref = recursos.find((r) => r.name === "packs") ?? recursos.find((r) => r.name === "orders");
  if (!ref) throw new Error("mensagem sem pacote ou pedido associado");
  const idConversa = String(ref.id);

  const de = String(m.from?.user_id) === String(loja.id_externo) ? "loja" : "cliente";
  const enviadaEm = m.message_date?.received ?? m.message_date?.created ?? m.message_date?.available ?? new Date().toISOString();
  const textoMsg = typeof m.text === "string" ? m.text : (m.text?.plain ?? null);
  const idMsg = String(m.message_id ?? m.id);

  const { data: conv, error: e1 } = await supabase.from("conversas")
    .upsert(
      { loja_id: loja.id, tipo: "pos_venda", id_externo: idConversa, pedido_id_externo: idConversa },
      { onConflict: "loja_id,tipo,id_externo" },
    )
    .select("id, cliente_nome, dados_extras")
    .single();
  if (e1 || !conv) throw new Error(`erro ao salvar a conversa: ${e1?.message}`);

  // Nome do comprador e dados do pedido (se falhar, segue sem).
  const semDados = !conv.dados_extras || Object.keys(conv.dados_extras).length === 0;
  if (!conv.cliente_nome || semDados) {
    const atualiza: any = {};
    try {
      const p = await dadosDoPedido(token, idConversa);
      if (!conv.cliente_nome) {
        const nome = p.nome || p.comprador?.nickname;
        if (nome) {
          atualiza.cliente_nome = nome;
          atualiza.cliente_id_externo = String(p.comprador?.id ?? "");
        }
      }
      if (semDados) {
        atualiza.dados_extras = p.dados;
        if (p.titulo) atualiza.produto_titulo = p.titulo;
      }
    } catch (e) {
      await diag("ml-dados-pedido", `${e instanceof Error ? e.message : e}`);
    }
    // Plano B para o nome: o usuário que enviou a mensagem.
    if (!conv.cliente_nome && !atualiza.cliente_nome && de === "cliente" && m.from?.user_id) {
      try {
        const u = await ml(`/users/${m.from.user_id}`, token);
        if (u?.nickname) { atualiza.cliente_nome = u.nickname; atualiza.cliente_id_externo = String(m.from.user_id); }
      } catch (e) { await diag("ml-nome", `${e instanceof Error ? e.message : e}`); }
    }
    if (Object.keys(atualiza).length) await supabase.from("conversas").update(atualiza).eq("id", conv.id);
  }

  // Se a loja respondeu pela nossa tela, trocamos o id local pelo id real (evita duplicar).
  if (de === "loja" && textoMsg) {
    const { data: jaExiste } = await supabase.from("mensagens").select("id")
      .eq("conversa_id", conv.id).eq("id_externo", idMsg).maybeSingle();
    if (!jaExiste) {
      const desde = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { data: local } = await supabase.from("mensagens").select("id")
        .eq("conversa_id", conv.id).like("id_externo", "local-%").eq("texto", textoMsg)
        .gte("criado_em", desde).order("criado_em", { ascending: false }).limit(1).maybeSingle();
      if (local) {
        await supabase.from("mensagens").update({ id_externo: idMsg }).eq("id", local.id);
        return;
      }
    }
  }

  const { error: e2 } = await supabase.from("mensagens").upsert(
    {
      conversa_id: conv.id,
      id_externo: idMsg,
      de,
      texto: textoMsg,
      anexos: Array.isArray(m.message_attachments) ? m.message_attachments : [],
      enviada_em: enviadaEm,
    },
    { onConflict: "conversa_id,id_externo" },
  );
  if (e2) throw new Error(`erro ao salvar a mensagem: ${e2.message}`);
}

async function processarMensagem(loja: any, token: string, resource: string) {
  const caminho = resource.startsWith("/") ? resource : `/messages/${resource}`;
  const dados = await ml(`${caminho}${caminho.includes("?") ? "&" : "?"}tag=post_sale`, token);
  const lista: any[] = Array.isArray(dados?.messages) ? dados.messages : [dados];
  for (const m of lista) await salvarMensagemPosVenda(loja, token, m);
}

// ---------------------------------------------------------------------
// Perguntas dos anúncios
// ---------------------------------------------------------------------
async function processarPergunta(loja: any, token: string, resource: string) {
  const caminho = resource.startsWith("/") ? resource : `/questions/${resource}`;
  const q = await ml(caminho, token);
  const idPergunta = String(q.id);
  const clienteId = q.from?.id != null ? String(q.from.id) : null;

  const { data: conv, error: e1 } = await supabase.from("conversas")
    .upsert(
      { loja_id: loja.id, tipo: "pergunta", id_externo: idPergunta, cliente_id_externo: clienteId },
      { onConflict: "loja_id,tipo,id_externo" },
    )
    .select("id, cliente_nome, dados_extras")
    .single();
  if (e1 || !conv) throw new Error(`erro ao salvar a conversa: ${e1?.message}`);

  if (!conv.cliente_nome && clienteId) {
    try {
      const u = await ml(`/users/${clienteId}`, token);
      if (u?.nickname) await supabase.from("conversas").update({ cliente_nome: u.nickname }).eq("id", conv.id);
    } catch (e) { await diag("ml-nome", `${e instanceof Error ? e.message : e}`); }
  }

  const semDados = !conv.dados_extras || Object.keys(conv.dados_extras).length === 0;
  if (semDados && q.item_id) {
    try {
      const a = await dadosDoAnuncio(token, String(q.item_id));
      await supabase.from("conversas").update({ dados_extras: a.dados, produto_titulo: a.titulo }).eq("id", conv.id);
    } catch (e) { await diag("ml-anuncio", `${e instanceof Error ? e.message : e}`); }
  }

  const linhas: any[] = [
    {
      conversa_id: conv.id,
      id_externo: `p-${idPergunta}`,
      de: "cliente",
      texto: q.text ?? null,
      anexos: q.item_id ? [{ tipo: "anuncio", item_id: q.item_id }] : [],
      enviada_em: q.date_created ?? new Date().toISOString(),
    },
  ];
  if (q.answer?.text) {
    linhas.push({
      conversa_id: conv.id,
      id_externo: `r-${idPergunta}`,
      de: "loja",
      texto: q.answer.text,
      anexos: [],
      enviada_em: q.answer.date_created ?? new Date().toISOString(),
    });
  }
  // Não sobrescrevemos a resposta que a própria tela já gravou (guarda quem enviou).
  for (const l of linhas) {
    const { data: existe } = await supabase.from("mensagens").select("id")
      .eq("conversa_id", conv.id).eq("id_externo", l.id_externo).maybeSingle();
    if (existe) continue;
    const { error: e2 } = await supabase.from("mensagens").insert(l);
    if (e2) throw new Error(`erro ao salvar a pergunta: ${e2.message}`);
  }
}

// ---------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------
async function processar(corpo: any) {
  try {
    const { topic, resource, user_id } = corpo ?? {};
    if (!topic || !resource || !user_id) return;
    if (topic !== "messages" && topic !== "questions") return;

    const { data: loja } = await supabase.from("lojas").select("id, id_externo")
      .eq("marketplace", "mercado_livre").eq("id_externo", String(user_id)).eq("ativa", true).maybeSingle();
    if (!loja) {
      await diag("ml-notificacoes", `aviso de uma loja que não está conectada: ${user_id}`);
      return;
    }

    const token = await tokenDaLoja(loja.id);
    if (!token) {
      await diag("ml-notificacoes", `sem token válido para a loja ${loja.id}`);
      return;
    }

    if (topic === "messages") await processarMensagem(loja, token, String(resource));
    else await processarPergunta(loja, token, String(resource));
  } catch (e) {
    await diag("ml-notificacoes", `erro: ${e instanceof Error ? e.message : String(e)}`);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });
  let corpo: any = null;
  try {
    corpo = await req.json();
  } catch (_) {
    return new Response("ok", { status: 200 });
  }
  EdgeRuntime.waitUntil(processar(corpo));
  return new Response("ok", { status: 200 });
});
