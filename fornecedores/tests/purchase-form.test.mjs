import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const sourceUrl=new URL('../quality.js',import.meta.url);

test('nova compra começa sem produto e sem quantidade pré-selecionados',async()=>{
  const source=await readFile(sourceUrl,'utf8');

  assert.match(source,/new Option\('Selecione um produto','',true,!hasPreferred\)/);
  assert.match(source,/select\.value=hasPreferred\?preferred:''/);
  assert.match(source,/data-item="qty"[^>]+required placeholder="Informe"/);
  assert.doesNotMatch(source,/data-item="qty"[^>]+value="1"/);
});

test('salvamento permanece bloqueado enquanto algum item estiver incompleto',async()=>{
  const source=await readFile(sourceUrl,'utf8');

  assert.match(source,/row\.querySelector\('\[data-item=product\]'\)\.value&&values\[index\]!==null/);
  assert.match(source,/saveButton\.disabled=!complete/);
});
