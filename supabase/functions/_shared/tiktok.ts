// Cliente único das chamadas assinadas ao TikTok Shop. Quando o TikTok pede calma (HTTP 429), espera e tenta de novo.
// deno-lint-ignore-file no-explicit-any
export const TT_API = "https://open-api.tiktokglobalshop.com";

export async function hmac(chave: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Aceita a credencial como { token, cipher, app: { k, s } } ou como { token, cipher, k, s }.
export type CredTikTok = { token: string; cipher: string; app?: { k: string; s: string }; k?: string; s?: string };

const ESPERAS_MS = [1500, 4000, 9000];
const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function tts(metodo: "GET" | "POST", caminho: string, c: CredTikTok, extra: Record<string, string>, corpo?: unknown) {
  const k = c.app?.k ?? c.k ?? "", s = c.app?.s ?? c.s ?? "";
  const body = corpo ? JSON.stringify(corpo) : "";
  for (let tentativa = 0; ; tentativa++) {
    const q: Record<string, string> = { app_key: k, timestamp: String(Math.floor(Date.now() / 1000)), shop_cipher: c.cipher, ...extra };
    q.sign = await hmac(s, s + caminho + Object.keys(q).sort().map((x) => x + q[x]).join("") + body + s);
    const r = await fetch(`${TT_API}${caminho}?${new URLSearchParams(q)}`, {
      method: metodo, headers: { "x-tts-access-token": c.token, "Content-Type": "application/json" }, ...(body ? { body } : {}),
    });
    const j: any = await r.json().catch(() => ({}));
    if (r.status === 429 && tentativa < ESPERAS_MS.length) {
      const pedido = Number(r.headers.get("retry-after"));
      await dorme(Number.isFinite(pedido) && pedido > 0 ? Math.min(pedido * 1000, 15_000) : ESPERAS_MS[tentativa]);
      continue;
    }
    if (!r.ok || (j.code ?? 0) !== 0) throw new Error(`TikTok ${r.status} ${caminho}: ${j.code} ${String(j.message ?? "").slice(0, 160)}`);
    return j.data;
  }
}
