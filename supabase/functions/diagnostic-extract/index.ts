import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const PROMPT_VERSION = "extract-v1";

const SYSTEM_PROMPT = `On te fournit, entre balises <transcript>, la transcription d'une conversation de diagnostic logiciel entre un assistant et un fondateur de startup. Ce n'est PAS une conversation a continuer : ton unique tache est de l'analyser et d'en extraire des donnees structurees.

Extrait les informations suivantes et reponds UNIQUEMENT avec un objet JSON valide, sans texte avant ni apres, sans balise markdown, exactement dans ce format :
{
  "need_summary": "resume du besoin logiciel reel en 1-3 phrases, en francais",
  "categories": ["categorie de logiciel en langage courant", "..."],
  "constraints": ["contrainte ou signal important releve dans la conversation (budget, outil existant, delai, volume...), le cas echeant"]
}

"categories" doit lister les familles de logiciels concernees en langage courant (ex: "CRM", "outil de facturation"), pas des noms de produits precis. "constraints" peut etre un tableau vide si rien de notable n'a ete dit. Ne reponds jamais par la suite de la conversation, uniquement par le JSON demande.`;

interface CompanyProfile {
  website?: string;
  headcount_range?: string;
  market?: string;
  tool_preference?: string;
  description?: string;
}

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  return JSON.parse(raw.trim());
}

function transcriptToText(transcript: ChatTurn[]): string {
  return transcript.map((t) => `${t.role}: ${t.content}`).join("\n\n");
}

function transcriptToPrompt(transcript: ChatTurn[]): string {
  return `<transcript>\n${transcriptToText(transcript)}\n</transcript>\n\nRappel : reponds uniquement avec l'objet JSON demande, rien d'autre.`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: { profile?: CompanyProfile; transcript?: ChatTurn[]; company_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const transcript = Array.isArray(body.transcript) ? body.transcript : [];
  if (transcript.length === 0) {
    return jsonResponse({ error: "Missing 'transcript'" }, 400);
  }
  const profile = body.profile ?? {};

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY is not configured on this project" }, 500);
  }

  // This client forwards the caller's own access token so RLS applies as that
  // user. A real (even anonymous) Supabase auth session is required for the
  // companies/diagnoses writes below — see project notes on anonymous auth.
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return jsonResponse({
      error:
        "No authenticated Supabase session. Sign in anonymously (supabase.auth.signInAnonymously()) before calling this function.",
    }, 401);
  }

  let anthropicRes: Response;
  try {
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: transcriptToPrompt(transcript) }],
      }),
    });
  } catch (err) {
    return jsonResponse({ error: `Could not reach Claude API: ${(err as Error).message}` }, 502);
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return jsonResponse({ error: `Claude API error: ${errText}` }, 502);
  }

  const anthropicData = await anthropicRes.json();
  const textBlock = anthropicData.content?.find((b: any) => b.type === "text")?.text ?? "";

  if (anthropicData.stop_reason === "max_tokens") {
    return jsonResponse({ error: "Claude's response was cut off (max_tokens reached)" }, 502);
  }

  let extractedProfile: any;
  try {
    extractedProfile = extractJson(textBlock);
  } catch {
    return jsonResponse({ error: "Could not parse Claude's response", raw: textBlock }, 502);
  }

  let companyId = body.company_id;

  if (companyId) {
    const { data: existing, error: fetchErr } = await supabase
      .from("companies")
      .select("id")
      .eq("id", companyId)
      .maybeSingle();
    if (fetchErr || !existing) {
      return jsonResponse({ error: "company_id not found or not owned by this session" }, 403);
    }
  } else {
    const { data: company, error: companyErr } = await supabase
      .from("companies")
      .insert({
        user_id: user.id,
        name: profile.website ?? null,
        description: profile.description || extractedProfile.need_summary || "Diagnostic Stagely",
        headcount_range: profile.headcount_range ?? null,
      })
      .select("id")
      .single();
    if (companyErr) {
      return jsonResponse({ error: `Could not create company: ${companyErr.message}` }, 500);
    }
    companyId = company.id;
  }

  const { data: diagnosis, error: diagnosisErr } = await supabase
    .from("diagnoses")
    .insert({
      company_id: companyId,
      raw_input: transcriptToText(transcript),
      extracted_profile: extractedProfile,
      model_used: ANTHROPIC_MODEL,
      prompt_version: PROMPT_VERSION,
      trigger_reason: "initial",
    })
    .select("id")
    .single();

  if (diagnosisErr) {
    return jsonResponse({ error: `Could not create diagnosis: ${diagnosisErr.message}` }, 500);
  }

  return jsonResponse({
    company_id: companyId,
    diagnosis_id: diagnosis.id,
    extracted_profile: extractedProfile,
  });
});
