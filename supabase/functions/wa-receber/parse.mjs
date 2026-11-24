// Leitura por regra das mensagens dos grupos de fornecedores. Sem IA: texto fixo, resultado previsível.
// Retorna {tipo:'ok',dia,itens,total} | {tipo:'revisao',motivo} | {tipo:'ignorar'}.

const dinheiro=s=>{ // "14.784,00" -> 1478400 (centavos); "6.048" (sem centavos) -> 604800
 const m=/^(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})$/.exec(s.trim());
 if(m)return Number(m[1].replace(/\./g,''))*100+Number(m[2]);
 const r=/^(\d{1,3}(?:\.\d{3})*|\d+),?$/.exec(s.trim());
 return r?Number(r[1].replace(/\./g,''))*100:null;
};
const iso=(d,m,a)=>{
 const dt=new Date(Date.UTC(a,m-1,d));
 return dt.getUTCFullYear()===a&&dt.getUTCMonth()===m-1&&dt.getUTCDate()===d?`${a}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`:null;
};
const limpo=t=>String(t??'').replace(/\r/g,'').split('\n').map(l=>l.replace(/[*_~`]/g,'').trim()).filter(l=>l&&!/^[—–\-_=•·\s]{3,}$/.test(l));

export function lerPechincha(texto){
 const linhas=limpo(texto);
 let dia=null,total=null;const itens=[];let suspeita=false;
 for(const l of linhas){
  let m;
  if((m=/^data\s*:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})$/i.exec(l))){dia=iso(+m[1],+m[2],+m[3]);if(!dia)return{tipo:'revisao',motivo:'data inválida'};continue}
  if((m=/^total\s*:\s*(?:r\$)?\s*([\d.,]+)$/i.exec(l))){total=dinheiro(m[1]);if(total===null)return{tipo:'revisao',motivo:'total ilegível'};continue}
  if((m=/^-?\s*(\d+)\s+par(?:es)?\s+cancelad[oa]s?$/i.exec(l))){itens.push({cancelados:Number(m[1])});continue}
  // "84 Pares de Mizon RMax (-2 cancelados)": a quantidade inclui os cancelados; o abate vem como item à parte.
  if((m=/^(\d+)\s+par(?:es)?\s+(?:de\s+)?(.+?)\s*\(\s*-?\s*(\d+)\s+cancelad[oa]s?\s*\)$/i.exec(l))){itens.push({modelo:m[2].trim(),qtd:Number(m[1])},{cancelados:Number(m[3])});continue}
  if((m=/^(\d+)\s+par(?:es)?\s+(?:de\s+)?(.+)$/i.exec(l))){itens.push({modelo:m[2].trim(),qtd:Number(m[1])});continue}
  if(/\bpar(?:es)?\b/i.test(l))suspeita=true;
 }
 if(!dia&&!itens.length&&total===null)return{tipo:'ignorar'};
 if(!dia)return{tipo:'revisao',motivo:'sem data'};
 if(!itens.length)return{tipo:'revisao',motivo:'sem itens'};
 if(suspeita)return{tipo:'revisao',motivo:'linha não reconhecida'};
 if(itens.some(i=>(i.qtd??i.cancelados)<=0))return{tipo:'revisao',motivo:'quantidade zero'};
 return{tipo:'ok',dia,itens,total};
}

export function lerWbox(texto,diaDoEnvio){
 const t=limpo(texto).join(' ');
 let m=/^(\d{1,6})\s*par(?:es)?$/i.exec(t);
 if(m){const q=Number(m[1]);return q>0?{tipo:'ok',dia:diaDoEnvio,itens:[{qtd:q}],total:null}:{tipo:'revisao',motivo:'quantidade zero'}}
 if(/\d/.test(t)&&/\bpar(?:es)?\b/i.test(t))return{tipo:'revisao',motivo:'formato diferente do usual'};
 return{tipo:'ignorar'};
}

export const ler=(formato,texto,diaDoEnvio)=>formato==='pechincha'?lerPechincha(texto):lerWbox(texto,diaDoEnvio);

// Número puro do remetente: "5511999999999@c.us" / "...@s.whatsapp.net" / "...@lid" -> dígitos.
export const numero=id=>String(id??'').split('@')[0].split(':')[0].replace(/\D/g,'');

// Data em São Paulo (sem horário de verão: UTC-3).
export function diaSP(segundosEpoch){
 const d=new Date(segundosEpoch*1000-3*3600*1000);
 return d.toISOString().slice(0,10);
}
export function horaSP(segundosEpoch){return new Date(segundosEpoch*1000-3*3600*1000).getUTCHours();}
