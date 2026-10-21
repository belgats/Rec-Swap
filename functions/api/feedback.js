const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store" }
});

function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: "Cross-origin request rejected" }, 403);
  if (!env.DB) return json({ error: "D1 database binding is not configured" }, 503);
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json" }, 415);
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 1024) return json({ error: "Request is too large" }, 413);
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return json({ error: "Request body must be valid JSON" }, 400);
  }
  if (!Number.isInteger(input?.userIndex) || input.userIndex < 0 || input.userIndex > 3
      || !Number.isInteger(input?.itemId) || input.itemId < 1 || input.itemId > 22
      || !Number.isInteger(input?.candidateId) || input.candidateId < 1 || input.candidateId > 22
      || input.itemId === input.candidateId
      || typeof input.accepted !== "boolean"
      || !Number.isInteger(input.position) || input.position < 1 || input.position > 3) {
    return json({ error: "Invalid feedback event" }, 400);
  }

  try {
    await env.DB.prepare(
      "INSERT INTO feedback (user_index, source_product_id, candidate_product_id, accepted, position) VALUES (?, ?, ?, ?, ?)"
    ).bind(input.userIndex, input.itemId, input.candidateId, Number(input.accepted), input.position).run();
  } catch {
    return json({ error: "Feedback could not be saved" }, 503);
  }
  return json({ saved: true }, 201);
}

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ error: "D1 database binding is not configured" }, 503);
  try {
    const result = await env.DB.prepare(
      "SELECT position, COUNT(*) AS responses, SUM(accepted) AS accepted FROM feedback GROUP BY position ORDER BY position"
    ).all();
    return json({ positions: result.results });
  } catch {
    return json({ error: "Feedback summary is unavailable" }, 503);
  }
}
