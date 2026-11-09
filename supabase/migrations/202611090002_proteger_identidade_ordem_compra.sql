-- Defesa em profundidade: uma notinha agrupada nunca pode trocar de fornecedor,
-- data ou identificador depois de criada. Quantidade, preço e observação continuam
-- editáveis pelo fluxo autorizado, com histórico no fin_history.
begin;

create function public.fin_guard_purchase_order_identity() returns trigger
language plpgsql set search_path='' as $$
begin
 if old.purchase_order_id is not null and (
  new.purchase_order_id is distinct from old.purchase_order_id
  or new.supplier is distinct from old.supplier
  or new.date is distinct from old.date
  or new.type is distinct from old.type
 ) then
  raise exception 'A identidade da ordem de compra não pode ser alterada. Cancele e registre outra.';
 end if;
 return new;
end $$;

revoke all on function public.fin_guard_purchase_order_identity() from public,anon,authenticated;

create trigger fin_entries_purchase_order_identity_guard
before update of type,date,supplier,purchase_order_id on public.fin_entries
for each row execute function public.fin_guard_purchase_order_identity();

commit;
