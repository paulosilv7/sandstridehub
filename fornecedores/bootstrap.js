import { SUPABASE_URL, SUPABASE_KEY } from '../js/config.js';
window.SANDSTRIDE_SUPABASE={url:SUPABASE_URL,publishableKey:SUPABASE_KEY,sharedLogin:true};
await import('./connection.js');
