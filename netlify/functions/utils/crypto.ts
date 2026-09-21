/**
 * Cifratura a riposo delle configurazioni cliente ricevute dall'Hub.
 *
 * Le API key arrivano dall'Hub alla validazione del launch token e vanno
 * conservate lato server per poterle riusare quando non c'e' un utente
 * collegato (postback di DataForSEO, scansione pianificata).
 *
 * Restano cifrate in `pt_client_credentials` con AES-256-GCM: chi ottenesse
 * una copia del database non leggerebbe comunque le chiavi senza
 * `APP_SESSION_SECRET`, che vive solo fra le variabili d'ambiente di Netlify.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { requireEnv } from './http';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // raccomandato per GCM
/** Contesto della derivazione: separa questa chiave da quella di firma del JWT. */
const HKDF_INFO = 'moca-price-tracker/client-credentials/v1';
const HKDF_SALT = 'moca-price-tracker';

function key(): Buffer {
  const secret = requireEnv('APP_SESSION_SECRET');
  // HKDF invece del segreto grezzo: `APP_SESSION_SECRET` firma anche i JWT, e
  // le due chiavi non devono essere lo stesso materiale.
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret), HKDF_SALT, HKDF_INFO, 32));
}

/** Formato compatto `iv.tag.ciphertext`, tutto in base64url. */
export function encryptJson(value: unknown): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf-8'),
    cipher.final(),
  ]);

  return [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString('base64url')).join('.');
}

/**
 * Restituisce null se il testo cifrato e' illeggibile (segreto ruotato,
 * record corrotto): il chiamante ripiega sulle altre sorgenti invece di
 * interrompere l'operazione.
 */
export function decryptJson<T>(payload: string): T | null {
  try {
    const [ivPart, tagPart, dataPart] = payload.split('.');
    if (!ivPart || !tagPart || !dataPart) return null;

    const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]);

    return JSON.parse(plaintext.toString('utf-8')) as T;
  } catch {
    // Non logghiamo il payload: e' materiale sensibile.
    console.warn('[crypto] Configurazioni cifrate non leggibili, si riparte dall\'Hub');
    return null;
  }
}
