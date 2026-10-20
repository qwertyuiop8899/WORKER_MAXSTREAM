# Worker Cloudflare `upcaptcha-vision` per PriSynx

Il worker fa due cose per i plugin PriSynx (CB01, Eurostreaming, Filmez, OnlineSerieTV):

- **risolve i captcha a immagini di Uprot** con Workers AI;
- **condivide in cache** i link già sbloccati, cioè il link Uprot e la pagina player MaxStream corrispondente. Così ogni titolo richiede un solo captcha per tutti gli utenti.

Il codice è nel file [`upcaptcha-vision.mjs`](./upcaptcha-vision.mjs).

---

## 1. Creare il worker

1. Accedi a <https://dash.cloudflare.com>. Un account gratuito va bene.
2. Nel menu a sinistra apri **Compute (Workers)** → **Workers & Pages**.
3. Premi **Create** → **Create Worker** (oppure "Start with Hello World").
4. Scegli un nome, per esempio `upcaptcha-nuvio3`, e premi **Deploy**.
5. Annota l'URL del worker: `https://upcaptcha-nuvio3.<sottodominio>.workers.dev`.

## 2. Inserire il codice

1. Apri il worker e premi **Edit code**.
2. Cancella tutto il contenuto di `worker.js`.
3. Incolla l'intero contenuto di [`upcaptcha-vision.mjs`](./upcaptcha-vision.mjs).
4. Premi **Deploy**.

## 3. Creare il namespace KV

1. Nel menu a sinistra apri **Storage & Databases** → **Workers KV**.
2. Premi **Create namespace**.
3. Inserisci un nome qualsiasi, per esempio `VIDS`, e premi **Add**.

## 4. Collegare KV e Workers AI (Bindings)

Apri il worker → **Settings** → **Bindings** → **Add binding**:

| Tipo | Variable name (esatto) | Valore |
|---|---|---|
| **KV namespace** | `VIDS` | il namespace creato al punto 3 |
| **Workers AI** | `AI` | nessun valore da scegliere |

> Il codice usa `env.VIDS` ed `env.AI`: i nomi devono essere **esattamente** questi, maiuscole comprese.
> Workers AI non va creato a parte: basta il binding.

## 5. Token di accesso (secret)

Apri **Settings** → **Variables and Secrets** → **Add** e compila così:

| Campo | Valore |
|---|---|
| Type | **Secret** |
| Name | `AUTH_TOKEN` |
| Value | `prisynx` |

I plugin mandano questo valore nell'header `x-worker-auth`. Dopo averlo aggiunto premi **Deploy**.

## 6. Verifica

```sh
curl https://upcaptcha-nuvio3.<sottodominio>.workers.dev/
# {"ok":true,"service":"upcaptcha-vision"}

curl -H "x-worker-auth: prisynx" \
  "https://upcaptcha-nuvio3.<sottodominio>.workers.dev/player?k=msf/test1234"
# {"player":null}
```

| Risposta | Causa |
|---|---|
| `{"error":"unauthorized"}` | `AUTH_TOKEN` mancante o con valore diverso |
| `{"error":"kv-not-bound"}` | manca il binding KV `VIDS` |
| `{"error":"vision-unavailable","reason":"model-license"}` | va accettata la licenza del modello AI (vedi sotto) |
| `{"error":"vision-unavailable","reason":"quota-or-rate-limit"}` | quota giornaliera di Workers AI esaurita |

**Licenza del modello.** Se compare `model-license`, apri **AI** → **Workers AI** nella dashboard, cerca il modello `@cf/google/gemma-4-26b-a4b-it` e accetta i termini. In alternativa invia una volta il messaggio `agree` al modello dal Playground.

## 7. Endpoint

| Metodo | Percorso | Auth | Funzione |
|---|---|---|---|
| `GET` | `/` | no | stato del servizio |
| `POST` | `/` | sì | captcha: `{"target":"gatto","images":["data:image/jpeg;base64,..."]}` → `{"indices":[0,3]}` |
| `GET` | `/player?k=msf/ID` | sì | legge dalla cache → `{"player":"https://maxstream.video/..."}` oppure `null` |
| `POST` | `/player` | sì | scrive in cache `{"k":"msf/ID","player":"https://maxstream.video/xxx/yyy"}` (scade dopo 30 giorni) |

## 8. Aggiungere il worker ai plugin

Nei plugin gli URL dei worker sono salvati mascherati in due liste:

- `UC_URLS`: worker che risolvono i captcha e scrivono in cache;
- `UC_PEERS`: worker usati solo per leggere dalla cache.

Per ottenere il valore mascherato, incolla questo nella console del browser (F12):

```js
const u = 'https://upcaptcha-nuvio3.<sottodominio>.workers.dev', k = 'q7Lx2Vd';
[...u].reverse()
  .map((c, i) => (c.charCodeAt(0) ^ k.charCodeAt(i % k.length)).toString(16).padStart(2, '0'))
  .join('');
```

Aggiungi la stringa ottenuta a `UC_URLS` o a `UC_PEERS` in tutti i plugin che usano MaxStream e aumenta la loro versione in `manifest.json`. Dopo il push, in Nuvio apri **Impostazioni → Plugin** e premi **aggiorna** sul repo.

## Limiti del piano gratuito (per worker)

- **KV:** 100.000 letture e 1.000 scritture al giorno.
- **Workers AI:** quota giornaliera gratuita di "neurons"; quando si esaurisce, i plugin passano al worker successivo.
- **Workers:** 100.000 richieste al giorno.

Più worker, anche su account diversi, distribuiscono il carico.
