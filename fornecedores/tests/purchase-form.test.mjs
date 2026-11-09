import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const sourceUrl=new URL('../quality.js',import.meta.url);

test('nova compra começa sem produto e sem quantidade pré-selecionados',async()=>{
  const source=await readFile(sourceUrl,'utf8');

  assert.match(source,/new Option\('Selecione um produto','',true,!hasPreferred\)/);
  assert.match(source,/select\.value=hasPreferred\?preferred:''/);
  assert.match(source,/data-item="qty" type="text" inputmode="numeric" pattern="\[1-9\]\[0-9\]\*" autocomplete="off" required placeholder="Informe"/);
  assert.doesNotMatch(source,/data-item="qty"[^>]+value="1"/);
});

test('salvamento permanece bloqueado enquanto algum item estiver incompleto',async()=>{
  const source=await readFile(sourceUrl,'utf8');

  assert.match(source,/row\.querySelector\('\[data-item=product\]'\)\.value&&values\[index\]!==null/);
  assert.match(source,/saveButton\.disabled=!complete/);
});

test('fornecedor do contexto nasce travado e é reconferido antes da gravação',async()=>{
  const source=await readFile(sourceUrl,'utf8');

  assert.match(source,/setupPurchaseBatch\(form,workspaceSupplier\)/);
  assert.match(source,/form\.dataset\.lockedSupplier=hasLockedSupplier\?lockedSupplier:''/);
  assert.match(source,/data\.supplier!==lockedSupplier/);
  assert.match(source,/workspaceSupplier!==lockedSupplier/);
  assert.match(source,/entry\.supplier!==data\.supplier\|\|entry\.qty!==F\.quantity\(items\[index\]\.qty\)/);
});

test('compra global também exige escolha explícita do fornecedor',async()=>{
  const source=await readFile(sourceUrl,'utf8');

  assert.match(source,/initialSupplier=hasLockedSupplier\?lockedSupplier:''/);
  assert.match(source,/Selecione um fornecedor/);
});

test('confirmação final mostra fornecedor, quantidade e total antes do commit',async()=>{
  const source=await readFile(sourceUrl,'utf8');

  assert.match(source,/CONFIRA ANTES DE SALVAR/);
  assert.match(source,/Fornecedor: \$\{data\.supplier\}/);
  assert.match(source,/Quantidade total: \$\{quantity\}/);
  assert.match(source,/Valor total: \$\{money\(Number\(total\)\)\}/);
});
