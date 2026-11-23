-- Espalha os horários dos jobs agendados.
-- Antes, 10 a 12 jobs disparavam no mesmo minuto (:00, :10, :20...) e algumas chamadas às funções estouravam o limite de 10 s.
-- Cada job mantém o mesmo intervalo e o mesmo comando; só o minuto de partida muda. Pico por minuto: de 11 para 4.
select cron.alter_job((select jobid from cron.job where jobname = 'ml-sincronizar-chat'),     schedule => '1-59/5 * * * *');
select cron.alter_job((select jobid from cron.job where jobname = 'sandy-varrer'),            schedule => '2-59/5 * * * *');
select cron.alter_job((select jobid from cron.job where jobname = 'fin-backup-fornecedores'), schedule => '3-59/5 * * * *');
select cron.alter_job((select jobid from cron.job where jobname = 'chat-sincronizar'),        schedule => '4-59/5 * * * *');
select cron.alter_job((select jobid from cron.job where jobname = 'devol-itens'),             schedule => '1-59/10 * * * *');
select cron.alter_job((select jobid from cron.job where jobname = 'metas-atualizar-auto'),    schedule => '7-59/10 * * * *');
select cron.alter_job((select jobid from cron.job where jobname = 'push-meta-lucro'),         schedule => '3-59/10 11-23,0-2 * * *');
