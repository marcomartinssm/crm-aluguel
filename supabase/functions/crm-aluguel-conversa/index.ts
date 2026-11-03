// CRM de Aluguel — só leitura: últimas mensagens de uma conversa no WhatsApp da atendente.
// Serve para conferir casos "sem resposta". Não envia nada.
//   GET ?token=...&instancia=ALUGUELARA&jid=5548...@s.whatsapp.net[&qtd=30]
// O token é o mesmo do webhook (crm_aluguel_config.webhook_token).

import { createClient } from "npm:@supabase/supabase-js@2";

const EVOLUTION_URL = Deno.env.get("EVOLUTION_URL") ?? "https://dinastia-evolution.saxddq.easypanel.host";
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? "";
const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
const INSTANCIAS = new Set(["ALUGUELARA", "central"]);

function responder(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function textoDaMensagem(msg: any): string {
  msg = msg ?? {};
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage) return msg.imageMessage.caption ? `[foto] ${msg.imageMessage.caption}` : "[foto]";
  if (msg.videoMessage) return msg.videoMessage.caption ? `[vídeo] ${msg.videoMessage.caption}` : "[vídeo]";
  if (msg.audioMessage) return "[áudio]";
  if (msg.documentMessage) return `[documento] ${msg.documentMessage.fileName ?? ""}`.trim();
  if (msg.stickerMessage) return "[figurinha]";
  if (msg.reactionMessage) return `[reação ${msg.reactionMessage.text ?? ""}]`;
  const t = msg.templateMessage?.hydratedTemplate ?? msg.templateMessage?.hydratedFourRowTemplate;
  if (t?.hydratedContentText) return t.hydratedContentText;
  if (msg.interactiveMessage?.body?.text) return msg.interactiveMessage.body.text;
  if (msg.buttonsMessage?.contentText) return msg.buttonsMessage.contentText;
  if (msg.viewOnceMessage?.message) return textoDaMensagem(msg.viewOnceMessage.message);
  if (msg.ephemeralMessage?.message) return textoDaMensagem(msg.ephemeralMessage.message);
  const chaves = Object.keys(msg).filter((k) => k !== "messageContextInfo");
  return chaves.length ? `[${chaves[0]}]` : "";
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const { data } = await db.from("crm_aluguel_config").select("valor").eq("chave", "webhook_token").maybeSingle();
  if (!token || data?.valor !== token) return responder({ erro: "token inválido" }, 401);

  const instancia = url.searchParams.get("instancia") ?? "ALUGUELARA";
  const jid = url.searchParams.get("jid") ?? "";
  const qtd = Math.min(Number(url.searchParams.get("qtd") ?? 30) || 30, 100);
  if (!INSTANCIAS.has(instancia)) return responder({ erro: "instancia inválida" }, 400);

  // ?chats=1 — lista as conversas recentes com o @lid e o número ligado a ele (as mensagens novas ficam no @lid)
  if (url.searchParams.get("chats") === "1") {
    const r = await fetch(`${EVOLUTION_URL}/chat/findChats/${encodeURIComponent(instancia)}`, {
      method: "POST", headers: { apikey: EVOLUTION_API_KEY, "Content-Type": "application/json" }, body: "{}",
    });
    const lista: any[] = await r.json().catch(() => []);
    return responder((Array.isArray(lista) ? lista : []).slice(0, 400).map((c) => ({
      jid: c.remoteJid, nome: c.pushName ?? c.name ?? null, atualizado: c.updatedAt ?? null,
      alt: c.lastMessage?.key?.remoteJidAlt ?? c.lastMessage?.key?.senderPn ?? null,
    })));
  }
  if (!jid) return responder({ erro: "falta jid" }, 400);

  const res = await fetch(`${EVOLUTION_URL}/chat/findMessages/${encodeURIComponent(instancia)}`, {
    method: "POST",
    headers: { apikey: EVOLUTION_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ where: { key: { remoteJid: jid } }, page: 1, offset: qtd }),
  });
  const corpo: any = await res.json().catch(() => null);
  const bloco = corpo?.messages ?? corpo;
  const registros: any[] = bloco?.records ?? (Array.isArray(bloco) ? bloco : []);
  // a Evolution já filtra pela conversa e casa o número com o @lid (onde ficam as respostas da atendente)
  const mensagens = registros
    .map((m) => ({ em: Number(m.messageTimestamp ?? 0), deMim: !!m.key?.fromMe, jid: m.key?.remoteJid, texto: textoDaMensagem(m.message) }))
    .sort((a, b) => a.em - b.em);
  return responder({ ok: res.ok, total: bloco?.total ?? mensagens.length, mensagens });
});
