// CRM de Aluguel — porta de entrada.
// A Evolution avisa esta função a cada mensagem que chega no WhatsApp das atendentes de locação
// (Thainara = ALUGUELARA, Milene = central).
// Cliente que começa conversa nova cai na tela "Entrada" (crm_aluguel_contatos com classificacao = null),
// marcado como "Novo" ou "Cliente já com histórico".
//
// Ações (todas com ?token=... — o token fica em crm_aluguel_config.webhook_token):
//   POST (sem acao)                         webhook da Evolution (eventos messages.upsert e send.message)
//   GET  acao=webhook_atual&instancia=X     mostra o webhook configurado hoje na instância
//   POST acao=ligar_webhook&instancia=X     aponta o webhook da instância para esta função
//   GET  acao=historico&instancia=X&jid=Y   diagnóstico: o que a função acharia de histórico para esse contato
//
// Segredo usado (já existe no projeto): EVOLUTION_API_KEY

import { createClient } from "npm:@supabase/supabase-js@2";

const EVOLUTION_URL = Deno.env.get("EVOLUTION_URL") ?? "https://dinastia-evolution.saxddq.easypanel.host";
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

// Instâncias que alimentam o CRM de aluguel e o nome de quem atende cada uma.
// Para incluir outra atendente, acrescente aqui (e na lista ATENDENTES da tela).
const ATENDENTES: Record<string, string> = { ALUGUELARA: "Thainara", central: "Milene" };
const INSTANCIAS = new Set(Object.keys(ATENDENTES));

// Mensagens mais antigas que isso contam como "conversa anterior" (histórico).
const JANELA_HISTORICO_HORAS = 24;

const json = { "Content-Type": "application/json; charset=utf-8" };
function responder(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: json });
}

async function evo(caminho: string, init?: RequestInit) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${EVOLUTION_URL}${caminho}`, {
      ...init,
      signal: ctrl.signal,
      headers: { apikey: EVOLUTION_API_KEY, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const texto = await res.text();
    let corpo: unknown = texto;
    try { corpo = JSON.parse(texto); } catch { /* texto */ }
    return { ok: res.ok, status: res.status, corpo };
  } finally {
    clearTimeout(t);
  }
}

// ---------- utilidades (mesmas regras do Radar de Atendimento) ----------

function textoDaMensagem(msg: any): string {
  msg = msg ?? {};
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage) return msg.imageMessage.caption ? `[foto] ${msg.imageMessage.caption}` : "[foto]";
  if (msg.videoMessage) return msg.videoMessage.caption ? `[vídeo] ${msg.videoMessage.caption}` : "[vídeo]";
  if (msg.audioMessage) return "[áudio]";
  if (msg.documentMessage) return `[documento] ${msg.documentMessage.fileName ?? ""}`.trim();
  if (msg.documentWithCaptionMessage) return "[documento]";
  if (msg.stickerMessage) return "[figurinha]";
  if (msg.locationMessage) return "[localização]";
  if (msg.contactMessage || msg.contactsArrayMessage) return "[contato]";
  if (msg.reactionMessage) return "";
  if (msg.protocolMessage) return "";
  if (msg.editedMessage) return "[mensagem editada]";
  const t = msg.templateMessage?.hydratedTemplate ?? msg.templateMessage?.hydratedFourRowTemplate;
  if (t?.hydratedContentText) return t.hydratedContentText;
  if (msg.buttonsMessage?.contentText) return msg.buttonsMessage.contentText;
  if (msg.listMessage?.description) return msg.listMessage.description;
  if (msg.viewOnceMessage?.message) return textoDaMensagem(msg.viewOnceMessage.message);
  if (msg.ephemeralMessage?.message) return textoDaMensagem(msg.ephemeralMessage.message);
  const chaves = Object.keys(msg).filter((k) => k !== "messageContextInfo");
  return chaves.length ? `[${chaves[0]}]` : "";
}

function numeroLimpo(jid: string, alt?: string | null): string {
  const base = (alt && alt.includes("@s.whatsapp.net")) ? alt : jid;
  return (base ?? "").split("@")[0].replace(/\D/g, "");
}

function ehConversaDeCliente(jid: string): boolean {
  if (!jid) return false;
  return !(jid.endsWith("@g.us") || jid.includes("broadcast") || jid.includes("newsletter"));
}

function ultimos8(numero: string): string {
  return String(numero ?? "").replace(/\D/g, "").slice(-8);
}

let cacheInternos: { numeros: Set<string>; ate: number } | null = null;
async function numerosInternos(): Promise<Set<string>> {
  if (cacheInternos && cacheInternos.ate > Date.now()) return cacheInternos.numeros;
  const numeros = new Set<string>();
  const r = await evo("/instance/fetchInstances");
  for (const i of Array.isArray(r.corpo) ? r.corpo : []) {
    const d = (i as any).instance ?? i;
    const n = ultimos8(String(d.ownerJid ?? d.owner ?? "").split("@")[0]);
    if (n.length === 8) numeros.add(n);
  }
  const { data } = await db.from("corretores").select("telefone");
  for (const c of data ?? []) {
    const n = ultimos8(c.telefone);
    if (n.length === 8) numeros.add(n);
  }
  cacheInternos = { numeros, ate: Date.now() + 10 * 60 * 1000 };
  return numeros;
}

async function tokenValido(token: string | null): Promise<boolean> {
  if (!token) return false;
  const { data } = await db.from("crm_aluguel_config").select("valor").eq("chave", "webhook_token").maybeSingle();
  return !!data?.valor && data.valor === token;
}

async function configNumero(chave: string, padrao: number): Promise<number> {
  const { data } = await db.from("crm_aluguel_config").select("valor").eq("chave", chave).maybeSingle();
  const n = Number(data?.valor);
  return Number.isFinite(n) ? n : padrao;
}

// ---------- expediente (mesmo horário do Radar de Atendimento) ----------

const FUSO_OFFSET_HORAS = -3; // Brasília
const MANHA_TARDE: [number, number][] = [[8, 12], [13.5, 18]];
const EXPEDIENTE: Record<number, [number, number][]> = {
  0: [], 1: MANHA_TARDE, 2: MANHA_TARDE, 3: MANHA_TARDE, 4: MANHA_TARDE, 5: MANHA_TARDE,
  6: [[8, 12]],
};

function diaDaSemanaBR(epoch: number): number {
  return new Date((epoch + FUSO_OFFSET_HORAS * 3600) * 1000).getUTCDay();
}

// Minutos de expediente entre dois instantes — cliente que escreve às 22h não "esperou" a noite toda.
function minutosUteis(inicio: number, fim: number): number {
  if (fim <= inicio) return 0;
  let total = 0, cursor = inicio, voltas = 0;
  while (cursor < fim && voltas++ < 90) {
    const meiaNoiteBR = Math.floor((cursor + FUSO_OFFSET_HORAS * 3600) / 86400) * 86400 - FUSO_OFFSET_HORAS * 3600;
    for (const [h1, h2] of EXPEDIENTE[diaDaSemanaBR(cursor)] ?? []) {
      const abre = meiaNoiteBR + h1 * 3600;
      const fecha = meiaNoiteBR + h2 * 3600;
      total += Math.max(0, Math.min(fim, fecha) - Math.max(inicio, abre));
    }
    cursor = meiaNoiteBR + 86400;
  }
  return Math.round(total / 60);
}

// ---------- histórico ----------

// Procura na Evolution mensagens dessa conversa com mais de 24h. Devolve a mais recente delas.
async function conversaAnteriorNaEvolution(instancia: string, jid: string, agoraSeg: number) {
  const limite = agoraSeg - JANELA_HISTORICO_HORAS * 3600;
  let maisRecenteAntiga: number | null = null;
  let total = 0;
  for (let page = 1; page <= 3; page++) {
    const r = await evo(`/chat/findMessages/${encodeURIComponent(instancia)}`, {
      method: "POST",
      body: JSON.stringify({ where: { key: { remoteJid: jid } }, page, offset: 100 }),
    });
    const bloco = (r.corpo as any)?.messages ?? r.corpo;
    const registros: any[] = bloco?.records ?? (Array.isArray(bloco) ? bloco : []);
    total = Number(bloco?.total ?? registros.length);
    for (const m of registros) {
      // proteção: se a Evolution ignorar o filtro, não confunde com outras conversas
      if (m?.key?.remoteJid && m.key.remoteJid !== jid) continue;
      const ts = Number(m.messageTimestamp ?? 0);
      if (ts && ts < limite && (maisRecenteAntiga === null || ts > maisRecenteAntiga)) maisRecenteAntiga = ts;
    }
    if (maisRecenteAntiga !== null) break;
    if (!bloco?.pages || page >= Number(bloco.pages)) break;
  }
  return { maisRecenteAntiga, total };
}

async function verificarHistorico(instancia: string, jid: string, telefone: string, agoraSeg: number) {
  const motivos: string[] = [];
  let ultima: number | null = null;

  const evoRes = await conversaAnteriorNaEvolution(instancia, jid, agoraSeg).catch(() => ({ maisRecenteAntiga: null, total: 0 }));
  if (evoRes.maisRecenteAntiga) {
    motivos.push(`já conversou com a ${ATENDENTES[instancia] ?? "atendente"}`);
    ultima = evoRes.maisRecenteAntiga;
  }

  const fim8 = ultimos8(telefone);
  if (fim8.length === 8) {
    const { data: leads } = await db.from("leads").select("id, created_at, telefone").ilike("telefone", `%${fim8.slice(0, 4)}%${fim8.slice(4)}%`).limit(20);
    // lead criado agora há pouco é o próprio cadastro que trouxe o cliente, não histórico
    const limite = agoraSeg - JANELA_HISTORICO_HORAS * 3600;
    const criadoEm = (l: any) => Date.parse(l.created_at + (/[Z+]/.test(String(l.created_at).slice(10)) ? "" : "Z")) / 1000;
    const achou = (leads ?? []).filter((l: any) => ultimos8(l.telefone) === fim8 && criadoEm(l) < limite);
    if (achou.length) {
      motivos.push("já está no CRM de leads");
      const t = Math.max(...achou.map(criadoEm));
      if (Number.isFinite(t) && (ultima === null || t > ultima)) ultima = t;
    }

    const { data: antigos } = await db.from("crm_aluguel_contatos").select("ultima_mensagem_em")
      .eq("instancia", instancia).eq("telefone", telefone).order("ultima_mensagem_em", { ascending: false }).limit(1);
    if (antigos?.length) {
      if (!motivos.length) motivos.push("já passou pelo CRM de aluguel");
      const t = Date.parse(antigos[0].ultima_mensagem_em) / 1000;
      if (ultima === null || t > ultima) ultima = t;
    }
  }

  return {
    tem_historico: motivos.length > 0,
    historico_detalhe: motivos.join(" · ") || null,
    ultima_conversa_anterior: ultima ? new Date(ultima * 1000).toISOString() : null,
  };
}

// ---------- webhook ----------

// Mensagem automática que sai do WhatsApp da atendente quando alguém se cadastra no site
// ("Olá {nome}, aqui é a Thainara, da Projetar Imóveis. Vi que você se cadastrou em nosso site ... /imovel/...").
// Comparação sem acentos e em minúsculas; nome do cliente, da atendente e imóvel variam.
const PADRAO_CADASTRO_SITE = /aqui e a [a-z]+.*cadastrou em nosso site/;
const LINK_IMOVEL = /https?:\/\/(www\.)?projetarimoveis\.com\.br\/\S+/i;

function semAcento(t: string) {
  return t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ");
}

async function configTexto(chave: string, padrao: string): Promise<string> {
  const { data } = await db.from("crm_aluguel_config").select("valor").eq("chave", chave).maybeSingle();
  return data?.valor ?? padrao;
}

const ABERTO = (c: any) =>
  c.classificacao === null ||
  (c.classificacao === "aluguel" && !["realizado", "perdido", "descartado", "reprovado"].includes(c.etapa));

async function receberMensagem(instancia: string, d: any) {
  const key = d?.key ?? {};
  const jid: string = key.remoteJid ?? "";
  if (!ehConversaDeCliente(jid)) return { ignorado: "grupo/lista/canal" };

  const textoCompleto = textoDaMensagem(d.message);
  const texto = textoCompleto.slice(0, 500);
  if (!texto) return { ignorado: "mensagem sem conteúdo (reação/sistema)" };

  // Mensagem da própria atendente: a automática do cadastro do site abre um contato;
  // qualquer outra serve para medir o tempo de primeira resposta.
  const cadastroSite = !!key.fromMe && PADRAO_CADASTRO_SITE.test(semAcento(textoCompleto));
  const agoraSeg = Number(d.messageTimestamp ?? 0) || Math.floor(Date.now() / 1000);
  const quando = new Date(agoraSeg * 1000).toISOString();

  const telefone = numeroLimpo(jid, key.remoteJidAlt ?? key.senderPn ?? null);
  if (key.fromMe && !cadastroSite) return registrarResposta(instancia, jid, telefone, agoraSeg);
  if (!telefone) return { ignorado: "sem número" };
  if ((await numerosInternos()).has(ultimos8(telefone))) return { ignorado: "número interno ou corretor" };
  // pushName de mensagem enviada é o nome da atendente, não do cliente
  const nome = (!key.fromMe && d.pushName && d.pushName !== telefone) ? String(d.pushName).slice(0, 120) : null;
  const imovelLink = cadastroSite ? (textoCompleto.match(LINK_IMOVEL)?.[0] ?? null) : null;

  const { data: existentes } = await db.from("crm_aluguel_contatos").select("*")
    .eq("instancia", instancia).eq("telefone", telefone).order("criado_em", { ascending: false }).limit(5);

  const reabrirAposDias = await configNumero("reabrir_apos_dias", 7);
  const aberto = (existentes ?? []).find(ABERTO);
  const recente = (existentes ?? [])[0];
  const quieto = recente ? (agoraSeg * 1000 - Date.parse(recente.ultima_mensagem_em)) / 86400000 : Infinity;

  // Já está na Entrada ou no funil, ou foi resolvido há pouco (ex.: "Outros" que manda mensagem todo dia):
  // só atualiza a última mensagem.
  const alvo = aberto ?? (quieto < reabrirAposDias ? recente : null);
  if (alvo) {
    const mudancas: Record<string, unknown> = { jid, nome: alvo.nome ?? nome, atualizado_em: new Date().toISOString() };
    if (cadastroSite) {
      // cliente já conhecido que se cadastrou de novo no site: guarda o imóvel, sem trocar a última fala dele
      if (imovelLink) mudancas.imovel_link = imovelLink;
    } else {
      mudancas.ultima_mensagem = texto;
      mudancas.ultima_mensagem_em = quando;
      // cadastro do site: o relógio da 1ª resposta começa quando o cliente responde a automática
      if (!alvo.cliente_falou_em) mudancas.cliente_falou_em = quando;
    }
    await db.from("crm_aluguel_contatos").update(mudancas).eq("id", alvo.id);
    return { atualizado: alvo.id, cadastroSite };
  }

  const hist = await verificarHistorico(instancia, jid, telefone, agoraSeg);
  const novo: Record<string, unknown> = {
    instancia, telefone, jid, nome,
    primeira_mensagem: cadastroSite ? "Cadastro no site (mensagem automática enviada)" : texto,
    primeira_mensagem_em: quando,
    ultima_mensagem: cadastroSite ? null : texto,
    ultima_mensagem_em: quando,
    origem: cadastroSite ? "cadastro_site" : "whatsapp",
    cliente_falou_em: cadastroSite ? null : quando,
    imovel_link: imovelLink,
    ...hist,
  };
  if (cadastroSite && (await configTexto("cadastro_site_destino", "entrada")) === "atendimento") {
    Object.assign(novo, {
      classificacao: "aluguel", classificado_em: quando,
      etapa: "atendimento", etapa_em: quando, entrou_funil_em: quando,
    });
  }
  const { data, error } = await db.from("crm_aluguel_contatos").insert(novo).select("id, classificacao").single();
  if (!error && data.classificacao === "aluguel") {
    await db.from("crm_aluguel_movimentos").insert({ contato_id: data.id, de: "cadastro_site", para: "atendimento" });
  }
  if (error) {
    // duas mensagens ao mesmo tempo: a outra chamada já criou o registro
    if (String(error.code) === "23505") return receberMensagem(instancia, d);
    throw error;
  }
  return { criado: data.id, ...hist };
}

// 1ª mensagem da atendente depois que o cliente falou = tempo de primeira resposta.
async function registrarResposta(instancia: string, jid: string, telefone: string, agoraSeg: number) {
  let q = db.from("crm_aluguel_contatos")
    .select("id, cliente_falou_em, criado_em")
    .eq("instancia", instancia)
    .not("cliente_falou_em", "is", null)
    .is("primeira_resposta_em", null)
    .order("criado_em", { ascending: false })
    .limit(1);
  // com @lid sem número junto, procura pela conversa
  q = telefone && !jid.endsWith("@lid") ? q.eq("telefone", telefone) : q.eq("jid", jid);
  const { data } = await q;
  const c = data?.[0];
  if (!c) return { ignorado: "mensagem da atendente (nada esperando resposta)" };

  const inicio = Math.floor(Date.parse(c.cliente_falou_em) / 1000);
  if (agoraSeg < inicio) return { ignorado: "mensagem da atendente anterior à do cliente" };

  const minutos = Math.round((agoraSeg - inicio) / 60);
  const uteis = minutosUteis(inicio, agoraSeg);
  await db.from("crm_aluguel_contatos").update({
    primeira_resposta_em: new Date(agoraSeg * 1000).toISOString(),
    primeira_resposta_min: minutos,
    primeira_resposta_min_expediente: uteis,
  }).eq("id", c.id).is("primeira_resposta_em", null);
  return { primeira_resposta: c.id, minutos, minutos_expediente: uteis };
}

// ---------- servidor ----------

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (!(await tokenValido(url.searchParams.get("token")))) return responder({ erro: "token inválido" }, 401);
  if (!EVOLUTION_API_KEY) return responder({ erro: "Falta o segredo EVOLUTION_API_KEY no Supabase." }, 500);

  const acao = url.searchParams.get("acao");
  const instParam = url.searchParams.get("instancia") ?? "ALUGUELARA";

  try {
    if (acao === "webhook_atual") {
      return responder((await evo(`/webhook/find/${encodeURIComponent(instParam)}`)).corpo);
    }

    if (acao === "ligar_webhook" && req.method === "POST") {
      if (!INSTANCIAS.has(instParam)) return responder({ erro: "instância fora do CRM de aluguel" }, 400);
      const token = url.searchParams.get("token");
      const destino = `${SUPABASE_URL}/functions/v1/crm-aluguel-entrada?token=${token}`;
      const r = await evo(`/webhook/set/${encodeURIComponent(instParam)}`, {
        method: "POST",
        body: JSON.stringify({ webhook: { enabled: true, url: destino, byEvents: false, base64: false, events: ["MESSAGES_UPSERT", "SEND_MESSAGE"] } }),
      });
      return responder({ ok: r.ok, status: r.status, resposta: r.corpo }, r.ok ? 200 : 502);
    }

    if (acao === "historico") {
      const jid = url.searchParams.get("jid") ?? "";
      const tel = url.searchParams.get("telefone") ?? numeroLimpo(jid);
      const agora = Math.floor(Date.now() / 1000);
      const evoRes = await conversaAnteriorNaEvolution(instParam, jid, agora);
      return responder({ evolution: evoRes, resultado: await verificarHistorico(instParam, jid, tel, agora) });
    }

    // Webhook da Evolution
    const corpo = await req.json().catch(() => null);
    if (!corpo) return responder({ ignorado: "sem corpo" });
    const evento = String(corpo.event ?? "").toLowerCase().replace("_", ".");
    const instancia = corpo.instance ?? instParam;
    // messages.upsert = mensagens recebidas e enviadas pelo celular; send.message = enviadas pela API (automação)
    if (evento !== "messages.upsert" && evento !== "send.message") return responder({ ignorado: `evento ${corpo.event}` });
    if (!INSTANCIAS.has(instancia)) return responder({ ignorado: `instância ${instancia}` });

    const itens = Array.isArray(corpo.data) ? corpo.data : [corpo.data];
    const resultados = [];
    for (const d of itens) resultados.push(await receberMensagem(instancia, d));
    return responder({ ok: true, resultados });
  } catch (e) {
    console.error(e);
    return responder({ erro: String((e as Error)?.message ?? e) }, 500);
  }
});
