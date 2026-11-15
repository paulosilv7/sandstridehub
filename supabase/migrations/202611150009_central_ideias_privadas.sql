-- Ideias privadas: só o autor enxerga e mexe nas próprias. SQL aplicado via apply_migration `central_ideias_privadas`.
drop policy if exists "equipe ve ideias" on public.central_ideias;
drop policy if exists "autor ou admin altera ideia" on public.central_ideias;
drop policy if exists "autor ou admin apaga ideia" on public.central_ideias;
create policy "autor ve suas ideias" on public.central_ideias for select to authenticated using (eh_da_equipe() and autor_id = auth.uid());
create policy "autor altera suas ideias" on public.central_ideias for update to authenticated using (autor_id = auth.uid()) with check (autor_id = auth.uid());
create policy "autor apaga suas ideias" on public.central_ideias for delete to authenticated using (autor_id = auth.uid());
