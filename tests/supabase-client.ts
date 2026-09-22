/**
 * Regressione: il client Supabase deve costruirsi anche senza WebSocket
 * globale (Node < 22, che e' il runtime delle Netlify Functions).
 *
 * Il costruttore di RealtimeClient risolve sempre un WebSocket, anche se qui
 * il realtime non si usa mai. Senza un transport esplicito `createClient`
 * lancia e OGNI endpoint risponde 500: e' esattamente il guasto che ha tenuto
 * l'app ferma, quindi vale un test dedicato.
 *
 * Sta in un file separato da unit-checks perche' deve togliere
 * `globalThis.WebSocket` prima di qualunque altro import.
 *
 * Esecuzione: `npm test`
 */

// @ts-expect-error rimozione deliberata: simula un runtime Node < 22
delete globalThis.WebSocket;

import { supabaseAdmin, resetSupabaseAdmin, normalizeSupabaseUrl } from '../netlify/functions/utils/supabase-admin';

let failed = 0;
const check = (label: string, condition: boolean) => {
  if (condition) console.log(`ok   ${label}`);
  else {
    failed += 1;
    console.log(`FAIL ${label}`);
  }
};

check(
  'nessun WebSocket globale (simulazione Node < 22)',
  typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined',
);

process.env.SUPABASE_URL = 'https://abc.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'chiave-di-test';

resetSupabaseAdmin();
let client: ReturnType<typeof supabaseAdmin> | null = null;
let errore: string | null = null;

try {
  client = supabaseAdmin();
} catch (err) {
  errore = (err as Error).message;
}

check(`client costruito senza WebSocket globale${errore ? ` (errore: ${errore})` : ''}`, client !== null);
check('query builder disponibile', typeof client?.from === 'function');
check('rpc disponibile', typeof client?.rpc === 'function');

// La cache non deve rifare il lavoro a ogni chiamata.
check('istanza riusata dalla cache', supabaseAdmin() === client);

// URL normalizzata anche qui, dove viene davvero usata.
resetSupabaseAdmin();
process.env.SUPABASE_URL = 'abc.supabase.co';
check('URL senza schema accettata', (() => {
  try {
    supabaseAdmin();
    return true;
  } catch {
    return false;
  }
})());
check('normalizzazione coerente', normalizeSupabaseUrl('abc.supabase.co/') === 'https://abc.supabase.co');

console.log(failed === 0 ? '\nCLIENT SUPABASE: CONTROLLI SUPERATI' : `\nCLIENT SUPABASE: ${failed} CONTROLLI FALLITI`);
process.exit(failed === 0 ? 0 : 1);
