import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const stylesheetUrl=new URL('../quality.css',import.meta.url);

test('extrato alinha cabeçalhos numéricos com os respectivos lançamentos',async()=>{
  const css=await readFile(stylesheetUrl,'utf8');
  assert.match(css,/\.statement-detail table\{width:100%;table-layout:fixed/);
  assert.match(css,/\.statement-detail th:nth-child\(n\+3\),\.statement-detail td:nth-child\(n\+3\)\{[^}]*text-align:right/);
  assert.match(css,/\.statement-detail th:nth-child\(8\)\{width:22%\}/);
  assert.match(css,/\.statement-detail th:nth-child\(9\)\{width:11%\}/);
});
