// Relatórios do CRM de Aluguel no WhatsApp (diário, semanal e mensal), enviados num grupo.
// Quem envia e para onde: crm_aluguel_config (relatorio_instancia e relatorio_grupo — id do grupo, termina em @g.us).
// Os números vêm de crm_aluguel_resumo_dados, a mesma função do Painel.

const FUSO_MS = 3 * 3600 * 1000; // Brasília = UTC-3

type Evo = (caminho: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; corpo: unknown }>;

export type TipoRelatorio = "dia" | "semana" | "mes";

// Meia-noite de Brasília de uma data (ano, mês 0-11, dia), em UTC.
function meiaNoiteBR(a: number, m: number, d: number) {
  return new Date(Date.UTC(a, m, d) + FUSO_MS);
}

function hojeBR() {
  const t = new Date(Date.now() - FUSO_MS);
  return { a: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(), dow: t.getUTCDay() };
}

const DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

function ddmm(dt: Date) {
  const t = new Date(dt.getTime() - FUSO_MS);
  return `${String(t.getUTCDate()).padStart(2, "0")}/${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
}

// dia = hoje; semana = sábado a sexta (enviado no sábado, pega o fim de semana anterior); mês = mês passado.
export function periodo(tipo: TipoRelatorio) {
  const h = hojeBR();
  if (tipo === "dia") {
    const inicio = meiaNoiteBR(h.a, h.m, h.d);
    return { inicio, fim: meiaNoiteBR(h.a, h.m, h.d + 1), titulo: "Relatório diário", rotulo: `${DIAS[h.dow]}, ${ddmm(inicio)}/${h.a}` };
  }
  if (tipo === "semana") {
    const desdeSabado = (h.dow + 1) % 7;
    const fim = meiaNoiteBR(h.a, h.m, h.d - desdeSabado);
    const inicio = new Date(fim.getTime() - 7 * 86400000);
    return { inicio, fim, titulo: "Relatório semanal", rotulo: `sáb ${ddmm(inicio)} a sex ${ddmm(new Date(fim.getTime() - 86400000))}` };
  }
  const inicio = meiaNoiteBR(h.a, h.m - 1, 1);
  const t = new Date(inicio.getTime() - FUSO_MS);
  return { inicio, fim: meiaNoiteBR(h.a, h.m, 1), titulo: "Relatório mensal", rotulo: `${MESES[t.getUTCMonth()]} de ${t.getUTCFullYear()}` };
}

const MOTIVOS: Record<string, string> = {
  alugou_outra_imobiliaria: "Alugou com outra imobiliária",
  alugou_direto: "Alugou direto com o proprietário",
  desistiu_de_locar: "Desistiu de locar",
  nao_responde: "Não responde mais",
  reprovado: "Reprovado",
};
const ETAPAS: Record<string, string> = {
  atendimento: "atendimento", visita: "visita", visita_realizada: "depois da visita",
  visita_nao_realizada: "faltou na visita", ficha: "ficha", aprovado: "depois de aprovado",
};

function pct(a: number, b: number) {
  return b ? `${Math.round((a / b) * 100)}%` : "–";
}

function tempo(min: number | null) {
  if (min == null) return "–";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

export function montarTexto(tipo: TipoRelatorio, p: ReturnType<typeof periodo>, d: any, porAtendente: [string, any][]) {
  const n = (o: any, k: string) => Number(o?.[k] ?? 0);
  const et = d.agora.etapas, mv = d.movimento, cl = d.entrada.classificados;
  const foiAluguel = n(cl, "atendimento");
  const visitas = n(mv, "visita"), realizadas = n(mv, "visita_realizada"), faltas = n(mv, "visita_nao_realizada");
  const fichas = n(mv, "ficha"), aprov = n(mv, "aprovado"), reprov = n(mv, "reprovado");
  const fechados = n(mv, "realizado"), perdidos = n(mv, "perdido"), descartados = n(mv, "descartado");
  const emVisita = n(et, "visita") + n(et, "visita_realizada") + n(et, "visita_nao_realizada");

  const l: string[] = [];
  l.push(`*📊 CRM Aluguel — ${p.titulo}*`);
  l.push(`_${p.rotulo}_`);
  l.push("");
  // Pré-atendimento = contato que entrou na Entrada; lead = classificado como Aluguel na Entrada.
  const en = d.entrada;
  l.push("*Pré-atendimento → lead*");
  l.push(`• Pré-atendimentos: *${en.novos_contatos}* (${en.sem_historico} novos · ${en.com_historico} com histórico · ${en.cadastro_site} do site)`);
  if (porAtendente.length > 1) {
    l.push(`• Por atendente: ${porAtendente.map(([nome, x]) => `${nome} ${x.entrada.novos_contatos}`).join(" · ")}`);
  }
  l.push(`• Viraram *lead* (Aluguel): *${en.viraram_lead}*`);
  l.push(`• Outros destinos: Vendas ${n(cl, "vendas")} · Suporte ${n(cl, "suporte")} · Outros ${n(cl, "outros")}`);
  if (en.em_pre_atendimento) l.push(`• Ainda em pré-atendimento (sem classificar): ${en.em_pre_atendimento}`);
  l.push("");
  l.push("*Funil no período*");
  l.push(`• Visitas marcadas: ${visitas} · realizadas: ${realizadas} · faltaram: ${faltas}`);
  l.push(`• Fichas enviadas para análise: ${fichas}`);
  l.push(`• Aprovadas: ${aprov} · Reprovadas: ${reprov}`);
  l.push(`• ✅ Fechados: *${fechados}*`);
  l.push(`• ❌ Perdidos: ${perdidos} · Descartados: ${descartados}`);
  if (d.fechamento.media_dias != null) l.push(`• Tempo médio até fechar: ${String(d.fechamento.media_dias).replace(".", ",")} dias`);
  l.push("");
  l.push("*Como está agora*");
  l.push(`• Em pré-atendimento: ${d.agora.entrada} · Em atendimento: ${n(et, "atendimento")}`);
  l.push(`• Em visita: ${emVisita} · Em ficha de análise: ${n(et, "ficha")} · Aprovados aguardando: ${n(et, "aprovado")}`);
  const ag = d.agora;
  if (ag.sem_contato_vermelho || ag.sem_contato_amarelo) {
    l.push(`• ⚠️ Leads sem contato: *${n(ag, "sem_contato_vermelho")}* há 7 dias ou mais · ${n(ag, "sem_contato_amarelo")} entre 3 e 6 dias`);
  }
  l.push("");
  l.push("*Conversões*");
  l.push(`• Pré-atendimento → lead: ${pct(en.viraram_lead, en.ja_classificados)}`);
  l.push(`• Lead → visita: ${pct(visitas, foiAluguel)}`);
  l.push(`• Comparecimento na visita: ${pct(realizadas, realizadas + faltas)}`);
  l.push(`• Visita → ficha: ${pct(fichas, realizadas)}`);
  l.push(`• Aprovação de ficha: ${pct(aprov, aprov + reprov)}`);
  // dos aprovados que tiveram desfecho no período, quantos fecharam (realizado) em vez de perdidos
  l.push(`• Aprovado → fechado: ${pct(fechados, fechados + perdidos)}`);
  l.push(`• Lead → contrato: ${pct(fechados, foiAluguel)}`);
  l.push("");
  const f = d.fora_horario;
  if (f) {
    l.push("*Fora do horário* (fim de semana, antes das 8h e depois das 18h)");
    l.push(`• ${f.total} de ${f.total_periodo} pré-atendimentos (${pct(f.total, f.total_periodo)}) chegaram fora do expediente`);
    if (f.total) {
      l.push(`• Depois das 18h: ${f.depois_18h} · Antes das 8h: ${f.antes_8h} · Fim de semana: ${f.fim_de_semana}`);
      l.push(`• Esperaram em média ${tempo(f.espera_media_min)} pela 1ª resposta`);
      l.push(`• Viraram lead: ${f.foram_aluguel} · Fechados: ${f.fechados}`);
    }
    l.push("");
  }
  l.push("*1ª resposta* (horário comercial)");
  for (const [nome, x] of porAtendente) {
    const r = x.resposta;
    l.push(`• ${nome}: ${tempo(r.media_expediente)} · ${pct(r.ate_5min, r.respondidos)} em até 5 min${r.aguardando ? ` · ${r.aguardando} sem resposta` : ""}`);
  }
  if (d.perdas?.length) {
    l.push("");
    l.push("*Por que perdemos*");
    for (const x of d.perdas.slice(0, 4)) {
      l.push(`• ${MOTIVOS[x.motivo] ?? x.motivo}${ETAPAS[x.etapa] ? ` (${ETAPAS[x.etapa]})` : ""}: ${x.n}`);
    }
  }
  return l.join("\n");
}

export async function gerarRelatorio(
  db: any, evo: Evo, atendentes: Record<string, string>,
  tipo: TipoRelatorio, opcoes: { teste?: boolean; forcar?: boolean },
) {
  const p = periodo(tipo);
  const args = (inst: string | null) => ({ p_inicio: p.inicio.toISOString(), p_fim: p.fim.toISOString(), p_instancia: inst });

  const { data: total, error } = await db.rpc("crm_aluguel_resumo_dados", args(null));
  if (error) throw error;
  const porAtendente: [string, any][] = [];
  for (const [inst, nome] of Object.entries(atendentes)) {
    const { data } = await db.rpc("crm_aluguel_resumo_dados", args(inst));
    porAtendente.push([nome, data]);
  }
  const texto = montarTexto(tipo, p, total, porAtendente);
  const inicio = new Date(p.inicio.getTime() - FUSO_MS).toISOString().slice(0, 10);

  if (opcoes.teste) return { tipo, inicio, enviado: false, teste: true, texto };

  const { data: ja } = await db.from("crm_aluguel_relatorios").select("enviado_em").eq("tipo", tipo).eq("inicio", inicio).maybeSingle();
  if (ja?.enviado_em && !opcoes.forcar) return { tipo, inicio, enviado: false, motivo: "já enviado", texto };

  const { data: cfg } = await db.from("crm_aluguel_config").select("chave, valor").in("chave", ["relatorio_instancia", "relatorio_grupo"]);
  const c = Object.fromEntries((cfg ?? []).map((x: any) => [x.chave, x.valor]));
  if (!c.relatorio_instancia || !c.relatorio_grupo) {
    await db.from("crm_aluguel_relatorios").upsert({ tipo, inicio, texto, erro: "grupo ainda não configurado" });
    return { tipo, inicio, enviado: false, motivo: "grupo ainda não configurado (crm_aluguel_config.relatorio_grupo)", texto };
  }

  const r = await evo(`/message/sendText/${encodeURIComponent(c.relatorio_instancia)}`, {
    method: "POST", body: JSON.stringify({ number: c.relatorio_grupo, text: texto }),
  });
  await db.from("crm_aluguel_relatorios").upsert({
    tipo, inicio, texto, destino: c.relatorio_grupo,
    enviado_em: r.ok ? new Date().toISOString() : null,
    erro: r.ok ? null : `${r.status} ${JSON.stringify(r.corpo).slice(0, 300)}`,
  });
  return { tipo, inicio, enviado: r.ok, status: r.status, texto };
}

// Grupos de que o número de envio participa (para achar o id do grupo novo pelo nome).
export async function listarGrupos(db: any, evo: Evo) {
  const { data } = await db.from("crm_aluguel_config").select("valor").eq("chave", "relatorio_instancia").maybeSingle();
  const inst = data?.valor;
  if (!inst) return { erro: "falta relatorio_instancia" };
  const r = await evo(`/group/fetchAllGroups/${encodeURIComponent(inst)}?getParticipants=false`);
  const lista = Array.isArray(r.corpo) ? r.corpo : [];
  return { instancia: inst, ok: r.ok, grupos: lista.map((g: any) => ({ id: g.id, nome: g.subject, membros: g.size ?? null })) };
}
