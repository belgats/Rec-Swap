import catalogue from "../../catalog.json";

const MODEL = "@cf/baai/bge-m3";
const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store" }
});

function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

function cosine(a, b) {
  let dot = 0, an = 0, bn = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    an += a[i] * a[i];
    bn += b[i] * b[i];
  }
  return dot / (Math.sqrt(an * bn) || 1);
}

function overlap(a, b) {
  const union = new Set([...a, ...b]);
  return union.size ? a.filter(tag => b.includes(tag)).length / union.size : 0;
}

function attributeScore(source, candidate) {
  const price = Math.max(0, 1 - Math.abs(source.p - candidate.p) / Math.max(source.p, candidate.p));
  const size = Math.max(0, 1 - Math.abs(source.s - candidate.s) / Math.max(source.s, candidate.s));
  return (source.c === candidate.c ? 0.4 : 0) + price * 0.3 + size * 0.2 + overlap(source.t, candidate.t) * 0.1;
}

function historyScore(user, candidate, products) {
  if (!user) return 0;
  const history = user.h.map(id => products.find(item => item.id === id)).filter(Boolean);
  const brand = Math.min(1, history.filter(item => item.b === candidate.b).length / 2);
  const tags = candidate.t.reduce((score, tag) =>
    score + Math.min(1, history.filter(item => item.t.includes(tag)).length / 2), 0) / candidate.t.length;
  const sameAisle = history.filter(item => item.a === candidate.a);
  const averagePrice = sameAisle.length
    ? sameAisle.reduce((sum, item) => sum + item.p, 0) / sameAisle.length
    : candidate.p;
  const priceFit = Math.max(0, 1 - Math.abs(averagePrice - candidate.p) / Math.max(averagePrice, candidate.p));
  const repurchase = user.h.includes(candidate.id) ? 1 : 0;
  return 0.3 * brand + 0.3 * tags + 0.2 * priceFit + 0.2 * repurchase;
}

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: "Cross-origin request rejected" }, 403);
  if (!env.AI) return json({ error: "Workers AI binding is not configured" }, 503);
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json" }, 415);
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 4096) return json({ error: "Request is too large" }, 413);
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return json({ error: "Request body must be valid JSON" }, 400);
  }
  if (!Number.isInteger(input?.itemId) || !Number.isInteger(input?.userIndex)
      || input.userIndex < 0 || input.userIndex > 3) {
    return json({ error: "itemId and a valid userIndex are required" }, 400);
  }

  const { products, users } = catalogue;
  const source = products.find(item => item.id === input.itemId);
  if (!source) return json({ error: "Unknown source product" }, 404);
  const user = users[input.userIndex];
  const context = input.context || {};
  const temp = Number.isFinite(context.temp) && context.temp >= 15 && context.temp <= 50 ? context.temp : 34;
  const hour = Number.isInteger(context.hour) && context.hour >= 8 && context.hour <= 23 ? context.hour : 14;
  const rules = context.rules && typeof context.rules === "object" ? context.rules : {};
  const enabled = key => typeof rules[key] === "boolean" ? rules[key] : true;
  const candidates = products.filter(candidate =>
    candidate.id !== source.id
    && candidate.a === source.a
    && candidate.st > 0
    && (!enabled("stock") || candidate.st >= 10)
    && (!enabled("price") || candidate.p <= source.p * 1.6)
    && (!enabled("heat") || temp < 38 || hour < 11 || hour > 16 || candidate.a !== "dairy")
    && !user.ex.some(tag => candidate.t.includes(tag))
  );
  if (!candidates.length) return json({ items: [], model: MODEL });

  let embeddings;
  try {
    const result = await env.AI.run(MODEL, {
      text: [source, ...candidates].map(item => `${item.n}. ${item.d}. ${item.t.join(", ")}`)
    });
    embeddings = result?.data;
  } catch {
    return json({ error: "AI inference is temporarily unavailable" }, 502);
  }
  if (!Array.isArray(embeddings) || embeddings.length !== candidates.length + 1
      || embeddings.some(vector => !Array.isArray(vector) || !vector.length
        || vector.some(value => typeof value !== "number" || !Number.isFinite(value)))
      || embeddings.some(vector => vector.length !== embeddings[0].length)) {
    return json({ error: "AI inference returned an invalid embedding response" }, 502);
  }

  const weights = input.weights && ["t", "a", "h"].every(key =>
    Number.isFinite(input.weights[key]) && input.weights[key] >= 0 && input.weights[key] <= 1)
    ? { t: input.weights.t, a: input.weights.a, h: input.weights.h }
    : { t: 0.55, a: 0.25, h: 0.2 };
  const totalWeight = weights.t + weights.a + weights.h || 1;
  const ranked = candidates.map((candidate, index) => {
    const scores = {
      t: Math.max(0, cosine(embeddings[0], embeddings[index + 1])),
      a: attributeScore(source, candidate),
      h: historyScore(user, candidate, products)
    };
    const score = (scores.t * weights.t + scores.a * weights.a + scores.h * weights.h) / totalWeight;
    const reasonKey = Object.keys(scores).sort((a, b) => scores[b] * weights[b] - scores[a] * weights[a])[0];
    const reason = { t: "AI-matched product description", a: "Similar price, size and product details", h: "Matches your shopping history" }[reasonKey];
    return { id: candidate.id, score, reason };
  }).sort((a, b) => b.score - a.score);

  return json({ items: ranked.slice(0, 3), model: MODEL });
}
