export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS (allow your GitHub Pages origin; or allow all)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Persist-Key",
    };
    if (request.method === "OPTIONS") {
      return new Response("", { status: 204, headers: corsHeaders });
    }

    if (url.pathname !== "/save") {
      return new Response("Not found", { status: 404, headers: corsHeaders });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    // Optional shared secret check
    if (env.PERSIST_SECRET) {
      const k = request.headers.get("X-Persist-Key") || "";
      if (k !== env.PERSIST_SECRET) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders });
      }
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response("Bad JSON", { status: 400, headers: corsHeaders });
    }

    const rawRoomId = String(body?.roomId || "").trim().toUpperCase();
    const roomId = (rawRoomId === "NIGHT" || rawRoomId === "NIG") ? "MON" : rawRoomId;
    if (!["DAY", "MON"].includes(roomId)) {
      return new Response("Invalid roomId", { status: 400, headers: corsHeaders });
    }

    const record = body?.record;
    if (!record || typeof record !== "object") {
      return new Response("Invalid record", { status: 400, headers: corsHeaders });
    }

    // Basic size guard (avoid huge commits)
    const jsonText = JSON.stringify(record);
    if (jsonText.length > 300_000) {
      return new Response("Record too large", { status: 413, headers: corsHeaders });
    }

    // Ensure updatedAt is set server-side
    const now = new Date().toISOString();
    record.roomId = roomId;
    record.updatedAt = now;

    const owner = env.GH_OWNER;
    const repo = env.GH_REPO;
    const branch = env.GH_BRANCH || "main";
    const dir = env.GH_DIR || "records";
    const token = env.GITHUB_TOKEN;

    if (!owner || !repo || !token) {
      return new Response("Worker not configured", { status: 500, headers: corsHeaders });
    }

    const path = `${dir}/${roomId}.json`;
    const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;

    const ghHeaders = {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "hke9-workers",
    };

    // 1) Read current file to get sha (and avoid overwriting without sha)
    let currentSha = null;

    // Retry once on race conditions
    for (let attempt = 0; attempt < 2; attempt++) {
      const getRes = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, { headers: ghHeaders });
      if (getRes.status === 404) {
        currentSha = null; // new file
        break;
      }
      if (!getRes.ok) {
        const t = await getRes.text().catch(() => "");
        return new Response(`GitHub GET failed: ${getRes.status} ${t.slice(0, 160)}`, { status: 502, headers: corsHeaders });
      }
      const getJson = await getRes.json();
      currentSha = getJson?.sha || null;

      // 2) PUT update
      const contentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(record, null, 2))));
      const putBody = {
        message: `HKE9 persist ${roomId} @ ${now}`,
        content: contentB64,
        branch,
        ...(currentSha ? { sha: currentSha } : {}),
      };

      const putRes = await fetch(apiBase, {
        method: "PUT",
        headers: { ...ghHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(putBody),
      });

      if (putRes.ok) {
        return new Response(JSON.stringify({ ok: true, roomId, updatedAt: now }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // If sha mismatch (409/422), retry once by refetching sha
      const putTxt = await putRes.text().catch(() => "");
      if ((putRes.status === 409 || putRes.status === 422) && attempt === 0) continue;

      return new Response(`GitHub PUT failed: ${putRes.status} ${putTxt.slice(0, 200)}`, {
        status: 502,
        headers: corsHeaders,
      });
    }

    return new Response("Unexpected error", { status: 500, headers: corsHeaders });
  },
};