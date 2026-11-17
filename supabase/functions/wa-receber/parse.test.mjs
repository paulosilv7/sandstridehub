import test from 'node:test';
import assert from 'node:assert/strict';
import {lerPechincha,lerWbox,numero,diaSP,horaSP} from './parse.mjs';

const calc=(itens,preco)=>itens.reduce((a,i)=>a+(i.qtd?i.qtd*(preco[i.modelo]??4200):-i.cancelados*4200),0);

test('Pechincha 13/11: três modelos e total',()=>{
 const r=lerPechincha(`Data: 13/11/2026

———————

161 Pares de Vulcstar
165 Pares de Mizon RMax
26 Pares de Revelation
———————

Total: R$14.784,00`);
 assert.equal(r.tipo,'ok');assert.equal(r.dia,'2026-11-13');assert.equal(r.total,1478400);
 assert.deepEqual(r.itens,[{modelo:'Vulcstar',qtd:161},{modelo:'Mizon RMax',qtd:165},{modelo:'Revelation',qtd:26}]);
 assert.equal(r.itens.reduce((a,i)=>a+i.qtd*4200,0),r.total);
});

test('Pechincha 11/11: pares cancelados sem modelo',()=>{
 const r=lerPechincha(`Data: 11/11/2026
———————
113 Pares de Vulcstar
82 Pares de Mizon RMax
12 Pares de Revelation
-3 Pares Cancelados
———————
Total: R$ 8.568,00`);
 assert.equal(r.tipo,'ok');assert.equal(r.total,856800);
 assert.deepEqual(r.itens.at(-1),{cancelados:3});
 assert.equal(r.itens.length,4);
 assert.equal(calc(r.itens,{}),r.total);
});

test('Pechincha 09/11: "01 Par Room X" (singular, sem "de")',()=>{
 const r=lerPechincha(`Data: 09/11/2026
———————
84 Pares de Vulcstar
138 Pares de Mizon RMax
31 Pares de Revelation
01 Par Room X
———————
Total: R$ 10.657,00`);
 assert.equal(r.tipo,'ok');assert.equal(r.total,1065700);
 assert.deepEqual(r.itens.at(-1),{modelo:'Room X',qtd:1});
 // 253 pares a R$ 42 + 1 par Room X a R$ 31
 assert.equal(calc(r.itens,{'Room X':3100}),r.total);
});

test('Pechincha: conversa comum é ignorada, formato estranho vai para revisão',()=>{
 assert.equal(lerPechincha('Bom dia pessoal, tudo certo por aí?').tipo,'ignorar');
 assert.equal(lerPechincha('mandei hoje 100 pares').tipo,'ignorar');
 assert.equal(lerPechincha('Data: 11/11/2026\n113 Pares de Vulcstar\nmais uns 20 pares la').tipo,'revisao');
 assert.equal(lerPechincha('113 Pares de Vulcstar\nTotal: R$ 4.746,00').tipo,'revisao'); // sem data
 assert.equal(lerPechincha('Data: 31/02/2026\n1 Par Room X').tipo,'revisao');          // data impossível
});

test('W-Box: só a quantidade',()=>{
 assert.deepEqual(lerWbox('255 pares','2026-11-13'),{tipo:'ok',dia:'2026-11-13',itens:[{qtd:255}],total:null});
 assert.equal(lerWbox('150 Pares ','2026-11-13').itens[0].qtd,150);
 assert.equal(lerWbox('1 par','2026-11-13').itens[0].qtd,1);
 assert.equal(lerWbox('ok, recebido','2026-11-13').tipo,'ignorar');
 assert.equal(lerWbox('saiu 255 pares hoje','2026-11-13').tipo,'revisao');
});

test('Número do remetente e dia/hora em São Paulo',()=>{
 assert.equal(numero('5511999998888@c.us'),'5511999998888');
 assert.equal(numero('5511999998888:12@s.whatsapp.net'),'5511999998888');
 // 2026-11-17 02:30 UTC = 16/11 23:30 em São Paulo
 const t=Date.UTC(2026,10,17,2,30)/1000;
 assert.equal(diaSP(t),'2026-11-16');assert.equal(horaSP(t),23);
 assert.equal(horaSP(Date.UTC(2026,10,17,20,0)/1000),17);
});

test('Palavra "para" não é confundida com "par"',()=>{
 assert.equal(lerPechincha('Data: 11/11/2026\n113 Pares de Vulcstar\nobrigado, segue para vocês').tipo,'ok');
 assert.equal(lerWbox('vou ligar para 2 pessoas','2026-11-13').tipo,'ignorar');
});
