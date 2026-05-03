// Supabase Edge Function: nvidia-chat
// Deploy via Dashboard -> Edge Functions -> nvidia-chat -> Edit
//
// Proxies NVIDIA chat completions, bypassing the http extension's 5s timeout.
// Logs usage (model, tokens, status) to nvidia_usage table.
// Auto-purges records older than 72 hours on each call.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
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

    // Call NVIDIA
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

    // Log usage to DB (fire-and-forget — don't block the response)
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (supabaseUrl && serviceKey) {
      const sb = createClient(supabaseUrl, serviceKey);
      const usage = body?.usage;

      // Insert usage row
      sb.from("nvidia_usage").insert({
        model: p_model,
        prompt_tokens: usage?.prompt_tokens ?? 0,
        completion_tokens: usage?.completion_tokens ?? 0,
        total_tokens: usage?.total_tokens ?? 0,
        status: response.status,
      }).then(() => {});

      // Purge records older than 72h
      sb.from("nvidia_usage")
        .delete()
        .lt("created_at", new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString())
        .then(() => {});
    }

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
