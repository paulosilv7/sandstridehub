// Confere de tempos em tempos as conversas pós-venda do Mercado Livre:
//  1) traz as mensagens que a loja enviou por fora do nosso chat (aplicativo do ML, UpSeller etc.)
//     e as que o aviso automático do ML deixou passar, já baixando as fotos e arquivos anexados;
//  2) lê a situação real do pedido (cancelado, devolução, reclamação em análise) e grava em
//     conversas.situacao, para o chat tirar essas conversas das "não respondidas".
// Chamada pelo agendador do banco (pg_cron + pg_net) com o cabeçalho x-lucro-token.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const CLIENT_ID = Deno.env.get("ML_CLIENT_ID") ?? "7039466443806040";
const CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET") ?? "";
const API = "https://api.mercadolibre.com";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function diag(origem: string, mensagem: string) {
  console.error(origem, mensagem);
  try { await supabase.from("diagnosticos").insert({ origem, mensagem: mensagem.slice(0, 1500) }); } catch (_) { /* ignora */ }
}

class ErroML extends Error {
  status: number;
  constructor(msg: string, status: number) { super(msg); this.status = status; }
}

async function ml(caminho: string, token: string): Promise<any> {
  const r = await fetch(`${API}${caminho}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!r.ok) {
    const corpo = (await r.text().catch(() => "")).slice(0, 300);
    throw new ErroML(`Mercado Livre respondeu ${r.status} em ${caminho}: ${corpo}`, r.status);
  }
  return await r.json();
}

const tokens = new Map<string, string | null>();
async function tokenDaLoja(lojaId: string): Promise<string | null> {
  if (tokens.has(lojaId)) return tokens.get(lojaId)!;
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  let resultado: string | null = null;
  const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 60_000;
  if (cred && valido(cred)) resultado = cred.token_acesso;
  else if (cred?.token_renovacao) {
    const resp = await fetch(`${API}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: cred.token_renovacao }),
    });
    const t: any = await resp.json().catch(() => ({}));
    if (resp.ok) {
      await supabase.from("credenciais_lojas").update({
        token_acesso: t.access_token,
        token_renovacao: t.refresh_token ?? cred.token_renovacao,
        expira_em: new Date(Date.now() + (t.expires_in ?? 21600) * 1000).toISOString(),
        atualizado_em: new Date().toISOString(),
      }).eq("loja_id", lojaId);
      resultado = t.access_token;
    } else {
      const { data: outra } = await ler();
      if (valido(outra)) resultado = outra!.token_acesso;
      else await diag("ml-sincronizar", `falha ao renovar o token: ${resp.status} ${t?.error ?? ""}`);
    }
  }
  tokens.set(lojaId, resultado);
  return resultado;
}

// ---------------------------------------------------------------------
// Situação do pedido
// ---------------------------------------------------------------------
type Situacao = { situacao: "cancelado" | "devolucao" | "devolvido" | "reclamacao" | "analise_ml"; detalhe: string } | null;

async function buscarPedido(token: string, id: string): Promise<any> {
  try {
    return await ml(`/orders/${id}`, token);
  } catch (_e) {
    const pack = await ml(`/packs/${id}`, token);
    const idPedido = pack?.orders?.[0]?.id;
    if (!idPedido) throw new Error(`pacote ${id} sem pedidos`);
    return await ml(`/orders/${idPedido}`, token);
  }
}

async function situacaoDoPedido(token: string, pedido: any, bloqueioMsg: any, bruto: any): Promise<Situacao> {
  // 1) Reclamações abertas (as ligadas ao pedido aparecem em "mediations").
  const ids: any[] = (pedido?.mediations ?? []).map((m: any) => m?.id).filter(Boolean);
  let reclamacao: Situacao = null;
  for (const id of ids.slice(0, 4)) {
    try {
      const c = await ml(`/post-purchase/v1/claims/${id}`, token);
      bruto.claims = [...(bruto.claims ?? []), { id, type: c.type, stage: c.stage, status: c.status, related: c.related_entities, reason: c.reason_id }];
      if (c.status === "opened") {
        const relacionadas: string[] = c.related_entities ?? [];
        if (c.stage === "dispute") {
          reclamacao = { situacao: "analise_ml", detalhe: "O Mercado Livre está analisando a reclamação (mediação)." };
        } else if (relacionadas.includes("return") || c.type === "return") {
          reclamacao = { situacao: "devolucao", detalhe: "Devolução em andamento no Mercado Livre." };
        } else if (!reclamacao) {
          reclamacao = { situacao: "reclamacao", detalhe: "Reclamação aberta no Mercado Livre." };
        }
        if (reclamacao?.situacao === "analise_ml") break;
      }
    } catch (e) { bruto.claim_erro = `${e instanceof Error ? e.message : e}`.slice(0, 200); }
  }
  // Reclamação aberta com o chat bloqueado pelo ML (ex.: blocked_by_claim): não dá para responder, vai para "Com o marketplace".
  if (reclamacao?.situacao === "reclamacao" && String(bloqueioMsg?.status ?? "") === "blocked") {
    return { situacao: "analise_ml", detalhe: "Reclamação aberta e o Mercado Livre bloqueou as mensagens deste pedido." };
  }
  if (reclamacao) return reclamacao;

  // 1b) Reclamação já encerrada, mas com devolução ainda a caminho (o pedido fica cancelado).
  const comDevolucao = (bruto.claims ?? []).find((c: any) => (c.related ?? []).includes("return") || c.type === "returns");
  if (comDevolucao) {
    try {
      const d = await ml(`/post-purchase/v2/claims/${comDevolucao.id}/returns`, token);
      const envios: any[] = d?.shipments ?? [];
      bruto.devolucao = { status: d?.status ?? null, subtype: d?.subtype ?? null, envios: envios.map((e: any) => e?.status ?? null) };
      const entregue = (envios.length > 0 && envios.every((e: any) => ["delivered", "returned"].includes(String(e?.status)))) || ["delivered", "closed"].includes(String(d?.status));
      const cancelada = String(d?.status) === "cancelled";
      if (!cancelada) {
        if (entregue) return { situacao: "devolvido", detalhe: "A devolução chegou na loja." };
        if (pedido?.status === "cancelled" || d?.status === "opened") {
          return { situacao: "devolucao", detalhe: "Pedido cancelado: devolução a caminho. O Mercado Livre não aceita mensagens." };
        }
      }
    } catch (e) {
      bruto.devolucao_erro = `${e instanceof Error ? e.message : e}`.slice(0, 200);
      if (pedido?.status === "cancelled") {
        return { situacao: "devolucao", detalhe: "Pedido cancelado com devolução. O Mercado Livre não aceita mensagens." };
      }
    }
  }

  // 2) Envio devolvido ao vendedor.
  const envio = String(bruto.envio_status ?? "");
  if (envio === "returned" || envio === "returning_to_sender") {
    return { situacao: "devolvido", detalhe: "O pacote voltou para a loja." };
  }

  // 3) Pedido cancelado ou conversa travada pelo ML por cancelamento.
  const sub = String(bloqueioMsg?.substatus ?? "");
  if (pedido?.status === "cancelled" || sub.includes("cancel")) {
    return { situacao: "cancelado", detalhe: "Pedido cancelado no Mercado Livre. Não é possível enviar mensagens." };
  }
  if (sub.includes("mediation") || sub.includes("claim")) {
    return { situacao: "analise_ml", detalhe: "Em análise no Mercado Livre. O envio de mensagens está bloqueado." };
  }
  return null;
}

// ---------------------------------------------------------------------
// Anexos: o ML só entrega o nome do arquivo; baixamos a foto e guardamos no nosso armazenamento.
// ---------------------------------------------------------------------
function tipoDoArquivo(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  return null;
}

async function baixarAnexo(token: string, pedido: string, a: any): Promise<any> {
  if (!a || a.path || !a.filename) return a;
  const nome = a.original_filename ?? a.filename;
  try {
    const r = await fetch(`${API}/messages/attachments/${encodeURIComponent(a.filename)}?tag=post_sale&site_id=MLB`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) { console.error("ml-anexo", r.status, a.filename); return a; }
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.byteLength > 10 * 1024 * 1024) return a;
    const mime = tipoDoArquivo(buf);
    if (!mime) return a;
    const path = `ml/${pedido}/${a.filename}`;
    const { error } = await supabase.storage.from("anexos").upload(path, buf, { contentType: mime, upsert: true });
    if (error) { await diag("ml-anexo", `erro ao guardar ${a.filename}: ${error.message}`); return a; }
    return { tipo: mime === "application/pdf" ? "arq" : "img", nome, path, mime, tamanho: buf.byteLength };
  } catch (e) {
    await diag("ml-anexo", `${e instanceof Error ? e.message : e}`);
    return a;
  }
}

async function converterAnexos(token: string, pedido: string, anexos: any[]): Promise<any[]> {
  const saida: any[] = [];
  for (const a of anexos) saida.push(await baixarAnexo(token, pedido, a));
  return saida;
}

// ---------------------------------------------------------------------
// Mensagens
// ---------------------------------------------------------------------
async function importarMensagens(conv: any, loja: any, dados: any, token: string): Promise<number> {
  const lista: any[] = Array.isArray(dados?.messages) ? dados.messages : [];

  const { data: existentes } = await supabase.from("mensagens").select("id, id_externo, texto, de, criado_em, anexos").eq("conversa_id", conv.id);

  // Mensagens já gravadas com anexo ainda sem arquivo (vieram só com o nome): baixa agora.
  for (const m of existentes ?? []) {
    const pend = Array.isArray(m.anexos) && m.anexos.some((a: any) => a?.filename && !a?.path);
    if (!pend) continue;
    const novos = await converterAnexos(token, conv.id_externo, m.anexos);
    if (JSON.stringify(novos) !== JSON.stringify(m.anexos)) await supabase.from("mensagens").update({ anexos: novos }).eq("id", m.id);
  }
  if (!lista.length) return 0;
  const jaTem = new Set((existentes ?? []).map((m: any) => m.id_externo));
  const locais = (existentes ?? []).filter((m: any) => String(m.id_externo).startsWith("local-") && m.de === "loja");
  const usadas = new Set<string>();

  let novas = 0;
  for (const m of lista) {
    const idMsg = String(m.message_id ?? m.id ?? "");
    if (!idMsg || jaTem.has(idMsg)) continue;
    if (m.message_moderation?.status === "rejected") continue;

    const texto = typeof m.text === "string" ? m.text : (m.text?.plain ?? null);
    const anexosBrutos = Array.isArray(m.message_attachments) ? m.message_attachments : [];
    if (!texto && !anexosBrutos.length) continue;
    const anexos = await converterAnexos(token, conv.id_externo, anexosBrutos);

    const de = String(m.from?.user_id) === String(loja.id_externo) ? "loja" : "cliente";
    const quando = m.message_date?.created ?? m.message_date?.received ?? m.message_date?.available ?? new Date().toISOString();

    // Mensagem enviada pelo nosso chat que ficou com id local: troca pelo id real.
    if (de === "loja" && texto) {
      const local = locais.find((l: any) => !usadas.has(l.id) && l.texto === texto);
      if (local) {
        usadas.add(local.id);
        await supabase.from("mensagens").update({ id_externo: idMsg }).eq("id", local.id);
        continue;
      }
    }

    const { error } = await supabase.from("mensagens").upsert(
      { conversa_id: conv.id, id_externo: idMsg, de, texto, anexos, enviada_em: quando },
      { onConflict: "conversa_id,id_externo", ignoreDuplicates: true },
    );
    if (error) throw new Error(`erro ao salvar a mensagem: ${error.message}`);
    novas++;
  }
  return novas;
}

async function sincronizarConversa(conv: any, loja: any, explorar = false): Promise<any> {
  const token = await tokenDaLoja(loja.id);
  if (!token) return { erro: "sem token" };
  const bruto: any = {};
  const resumo: any = { conversa: conv.id_externo };

  // Mensagens da conversa (sem marcar como lidas no Mercado Livre).
  let dadosMsgs: any = null;
  try {
    dadosMsgs = await ml(`/messages/packs/${conv.id_externo}/sellers/${loja.id_externo}?tag=post_sale&mark_as_read=false&limit=50`, token);
    resumo.novas = await importarMensagens(conv, loja, dadosMsgs, token);
    bruto.conversation_status = dadosMsgs?.conversation_status ?? null;
  } catch (e) {
    resumo.erro_msgs = `${e instanceof Error ? e.message : e}`.slice(0, 200);
  }

  // Situação do pedido.
  let pedido: any = null;
  try {
    pedido = await buscarPedido(token, conv.id_externo);
    bruto.pedido_status = pedido?.status ?? null;
    bruto.mediations = pedido?.mediations ?? [];
    if (pedido?.shipping?.id) {
      try {
        const s = await ml(`/shipments/${pedido.shipping.id}`, token);
        bruto.envio_status = s.status ?? null;
        bruto.envio_substatus = s.substatus ?? null;
      } catch (e) { bruto.envio_erro = `${e instanceof Error ? e.message : e}`.slice(0, 200); }
    }
    const sit = await situacaoDoPedido(token, pedido, dadosMsgs?.conversation_status, bruto);
    resumo.situacao = sit?.situacao ?? null;
    const novo = sit?.situacao ?? null;
    const mudou = novo !== (conv.situacao ?? null);
    await supabase.from("conversas").update({
      situacao: novo,
      situacao_detalhe: sit?.detalhe ?? null,
      ...(mudou ? { situacao_em: new Date().toISOString() } : {}),
      sincronizada_em: new Date().toISOString(),
    }).eq("id", conv.id);
    // Guarda o status do pedido no painel da conversa.
    if (pedido?.status && conv.dados_extras?.status !== pedido.status) {
      await supabase.from("conversas").update({ dados_extras: { ...(conv.dados_extras ?? {}), status: pedido.status } }).eq("id", conv.id);
    }
  } catch (e) {
    resumo.erro_pedido = `${e instanceof Error ? e.message : e}`.slice(0, 200);
    await supabase.from("conversas").update({ sincronizada_em: new Date().toISOString() }).eq("id", conv.id);
  }

  if (explorar) resumo.bruto = bruto;
  return resumo;
}

// ---------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------
async function executar(opcoes: { limite: number; pedido?: string; explorar?: boolean }) {
  const inicio = Date.now();
  const resultados: any[] = [];
  try {
    const { data: lojas } = await supabase.from("lojas").select("id, id_externo").eq("marketplace", "mercado_livre").eq("ativa", true);
    const porLoja = new Map<string, any>((lojas ?? []).map((l: any) => [l.id, l]));
    if (!porLoja.size) return resultados;

    let q = supabase.from("conversas")
      .select("id, loja_id, id_externo, situacao, dados_extras, aguardando_resposta, ultima_mensagem_em")
      .eq("tipo", "pos_venda").in("loja_id", [...porLoja.keys()]);
    if (opcoes.pedido) q = q.eq("id_externo", opcoes.pedido);
    else q = q.or(`aguardando_resposta.eq.true,ultima_mensagem_em.gt.${new Date(Date.now() - 14 * 86400_000).toISOString()}`);
    const { data: convs } = await q.order("sincronizada_em", { ascending: true, nullsFirst: true }).limit(opcoes.limite);

    const fila = [...(convs ?? [])];
    const trabalhadores = Array.from({ length: 4 }, async () => {
      while (fila.length && Date.now() - inicio < 110_000) {
        const c = fila.shift()!;
        try { resultados.push(await sincronizarConversa(c, porLoja.get(c.loja_id), !!opcoes.explorar)); }
        catch (e) { resultados.push({ conversa: c.id_externo, erro: `${e instanceof Error ? e.message : e}`.slice(0, 200) }); }
      }
    });
    await Promise.all(trabalhadores);
  } catch (e) {
    await diag("ml-sincronizar", `erro: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (opcoes.explorar) await diag("ml-sincronizar-explorar", JSON.stringify(resultados));
  return resultados;
}

Deno.serve(async (req) => {
  const enviado = req.headers.get("x-lucro-token") ?? "";
  const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || enviado !== seg.valor) return new Response("não autorizado", { status: 401 });

  const corpo: any = await req.json().catch(() => ({}));
  const opcoes = {
    limite: Math.min(Number(corpo.limite) || 40, 80),
    pedido: corpo.pedido ? String(corpo.pedido) : undefined,
    explorar: !!corpo.explorar,
  };
  EdgeRuntime.waitUntil(executar(opcoes));
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "Content-Type": "application/json" } });
});
