-- Avisos de chat desligados (ficariam excessivos): remove o gatilho da Sandy.
drop trigger if exists ao_registrar_sandy_push on public.sandy_registros;
drop function if exists public.push_chat();
