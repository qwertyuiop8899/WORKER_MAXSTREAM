// Small authenticated vision service for the current Uprot image challenge.
const MAX_BODY = 256 * 1024;
async function authorized(provided, expected) {
  if (!expected || !provided) return false;
  const encoder = new TextEncoder();
  const hashes = await Promise.all([provided, expected].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const left = new Uint8Array(hashes[0]), right = new Uint8Array(hashes[1]);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}
async function readJson(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid-body');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) throw new Error('body-too-large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
// Uprot link (msf/ID, msfi/B64, msei/B64) -> MaxStream player page: shared by all plugin users, one captcha per title.
const CACHE_KEY = /^ms(?:fi?|ei)\/[A-Za-z0-9+/=_.-]{4,300}$/;
const PLAYER_URL = /^https:\/\/maxstream\.video\/[A-Za-z0-9]{3,24}\/[A-Za-z0-9]{6,32}$/;
// Bounds how long a wrong (or poisoned, the key is public) entry can survive.
const PLAYER_TTL = 30 * 86400;
async function playerCache(request, env, url) {
  if (!env.VIDS) return Response.json({error: 'kv-not-bound'}, {status: 500});
  if (request.method === 'GET') {
    const key = url.searchParams.get('k') || '';
    if (!CACHE_KEY.test(key)) return Response.json({error: 'invalid-key'}, {status: 400});
    return Response.json({player: await env.VIDS.get(key)});
  }
  if (request.method !== 'POST') return Response.json({error: 'method-not-allowed'}, {status: 405});
  let data;
  try { data = await readJson(request); }
  catch { return Response.json({error: 'invalid-body'}, {status: 400}); }
  if (typeof data.k !== 'string' || !CACHE_KEY.test(data.k) || typeof data.player !== 'string' || !PLAYER_URL.test(data.player)) {
    return Response.json({error: 'invalid-entry'}, {status: 400});
  }
  await env.VIDS.put(data.k, data.player, {expirationTtl: PLAYER_TTL});
  return Response.json({ok: true});
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/player') {
      if (!await authorized(request.headers.get('x-worker-auth'), env.AUTH_TOKEN)) return Response.json({error: 'unauthorized'}, {status: 401});
      return playerCache(request, env, url);
    }
    if (request.method === 'GET') return Response.json({ok: true, service: 'upcaptcha-vision'});
    if (request.method !== 'POST') return Response.json({error: 'method-not-allowed'}, {status: 405});
    if (!await authorized(request.headers.get('x-worker-auth'), env.AUTH_TOKEN)) return Response.json({error: 'unauthorized'}, {status: 401});
    let data;
    try { data = await readJson(request); }
    catch { return Response.json({error: 'invalid-body'}, {status: 400}); }
    if (!Array.isArray(data.images) || data.images.length < 2 || data.images.length > 9
      || data.images.some(image => typeof image !== 'string' || image.length > 40000 || !/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(image))
      || typeof data.target !== 'string' || !/^[\p{L} -]{1,40}$/u.test(data.target)) {
      return Response.json({error: 'invalid-challenge'}, {status: 400});
    }
    const content = [{type: 'text', text: `Identify ALL images containing ${data.target}. Images are numbered starting at 0. Reply ONLY with a JSON array of matching indices, for example [0,2,5].`}];
    data.images.forEach((image, index) => content.push({type: 'text', text: `Image ${index}`}, {type: 'image_url', image_url: {url: image}}));
    const started = Date.now();
    try {
      const result = await env.AI.run('@cf/google/gemma-4-26b-a4b-it', {
        messages: [{role: 'user', content}], max_completion_tokens:96, temperature:0,
        chat_template_kwargs:{enable_thinking:false},
      });
      const answer = result.response || result.choices?.[0]?.message?.content || '';
      const raw = String(answer).trim();
      const match = raw.match(/\[[\d,\s]*\]/);
      const indices = match ? JSON.parse(match[0]) : /^\d+(?:\s*,\s*\d+)*$/.test(raw)
        ? raw.split(',').map(value => Number(value.trim())) : null;
      if (!Array.isArray(indices) || indices.some(i => !Number.isInteger(i) || i < 0 || i >= data.images.length)) {
        const diagnostic = {reason:!Array.isArray(indices) ? 'missing-indices' : 'out-of-range-indices',
          outputChars:raw.length, resultKind:typeof result,
          hasResponse:typeof result.response==='string', hasChoices:Array.isArray(result.choices),
          choiceCount:Array.isArray(result.choices) ? result.choices.length : 0,
          finishReason:['stop','length','tool_calls','content_filter'].includes(result.choices?.[0]?.finish_reason)
            ? result.choices[0].finish_reason : null,
          contentKind:typeof result.choices?.[0]?.message?.content,
          textKind:typeof result.choices?.[0]?.text,
          deltaKind:typeof result.choices?.[0]?.delta?.content};
        console.warn(JSON.stringify({event:'invalid-vision-answer', images:data.images.length,
          ...diagnostic, ms:Date.now()-started}));
        return Response.json({error: 'invalid-vision-answer', ...diagnostic}, {status: 422});
      }
      console.log(JSON.stringify({event: 'image-challenge', images: data.images.length, matches: indices.length, ms: Date.now() - started}));
      return Response.json({indices: [...new Set(indices)]});
    } catch (error) {
      const detail=String(error.message || '');
      const summary=detail.replace(/data:image\/\w+;base64,[A-Za-z0-9+/=]+/g,'[image]')
        .replace(/https?:\/\/\S+/g,'[url]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]')
        .replace(/[A-Za-z0-9_-]{32,}/g,'[redacted]').slice(0,240);
      const reason=/quota|neurons|rate.limit|daily.limit/i.test(detail) ? 'quota-or-rate-limit'
        : /license|agreement|agree|terms/i.test(detail) ? 'model-license'
        : /schema|guided|input|parameter|unsupported/i.test(detail) ? 'model-input'
        : /auth|permission/i.test(detail) ? 'model-auth' : 'model-request';
      console.warn(JSON.stringify({event: 'vision-failed', name: error.name, reason, ms: Date.now() - started}));
      return Response.json({error: 'vision-unavailable', reason, summary}, {status: 502});
    }
  },
};
