// Supabase Edge Function: nvidia-chat
// Deploy via Dashboard → Edge Functions → New Function → name: "nvidia-chat"
// Paste this as index.ts
//
// Replaces the nvidia_chat SQL/RPC function which hits the http extension's
// 5-second internal timeout on larger models.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const { p_api_key, p_model, p_prompt } = await req.json();

    if (!p_api_key || !p_model || !p_prompt) {
      return new Response(
        JSON.stringify({ status: 400, body: { error: "Missing p_api_key, p_model, or p_prompt" } }),
        { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${p_api_key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: p_model,
        messages: [{ role: "user", content: p_prompt }],
        max_tokens: 256,
      }),
    });

    const body = await response.json();
    return new Response(
      JSON.stringify({ status: response.status, body }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ status: 500, body: { error: e.message } }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});
