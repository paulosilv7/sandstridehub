-- Importância da tarefa (baixa, normal, alta). SQL aplicado via apply_migration `central_tarefas_importancia`.
alter table public.central_tarefas add column if not exists importancia text not null default 'normal' check (importancia in ('baixa','normal','alta'));
