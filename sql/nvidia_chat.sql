-- Enable the HTTP extension (needed for server-side HTTP calls)
CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA extensions;

-- Proxy function: calls NVIDIA chat completions API from Supabase
-- Avoids CORS issues since the request is made server-side.
CREATE OR REPLACE FUNCTION nvidia_chat(p_api_key text, p_model text, p_prompt text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  resp record;
BEGIN
  SELECT * INTO resp FROM extensions.http((
    'POST',
    'https://integrate.api.nvidia.com/v1/chat/completions',
    ARRAY[extensions.http_header('Authorization', 'Bearer ' || p_api_key)],
    'application/json',
    json_build_object(
      'model', p_model,
      'messages', json_build_array(json_build_object('role', 'user', 'content', p_prompt)),
      'max_tokens', 256
    )::text
  )::extensions.http_request);

  RETURN json_build_object('status', resp.status, 'body', resp.content::json);
END;
$$;
