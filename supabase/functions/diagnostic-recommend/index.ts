import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ANTHROPIC_MODEL = "claude-sonnet-5";
const TIERS = ["min", "recommended", "max"] as const;
type Tier = typeof TIERS[number];

const SYSTEM_PROMPT = `Tu es le moteur de recommandation de Stagely. On te donne le profil d'une entreprise, le besoin logiciel extrait d'un diagnostic, et un catalogue ferme de logiciels verifies (JSON).

Construis une recommandation de stack sur 3 paliers : "min" (le strict necessaire, le moins d'outils/depense possible), "recommended" (l'equilibre qu'on conseillerait vraiment a ce stade), "max" (une version plus complete, pour une equipe qui veut couvrir plus de terrain des maintenant).

Regles :
- Utilise UNIQUEMENT des produits presents dans le catalogue fourni, en reference par leur "id" exact. N'invente jamais un produit absent du catalogue.
- Un palier peut consolider plusieurs categories de besoin sur un seul outil s'il les couvre reellement (consolidation), ou empiler plusieurs outils sur une meme categorie si c'est justifie (empilement) — uniquement si le catalogue le permet.
- Chaque palier superieur doit rester coherent avec le precedent (ne pas changer totalement de logique d'un palier a l'autre sans raison).
- Si le catalogue ne couvre pas correctement un besoin, ne force pas une recommandation bancale : omets ce besoin plutot que de recommander un outil inadapte.
- Pour chaque outil recommande, donne un rang (ordre d'importance dans le palier, 1 = le plus important) et un score de correspondance entre 0 et 1.
- Ton des "reasoning" : direct, peer-to-peer fondateur, en francais.

Reponds UNIQUEMENT avec un objet JSON valide, sans texte avant ni apres, exactement dans ce format :
{
  "min": [ { "product_id": "uuid exact du catalogue", "rank": 1, "match_score": 0.8, "reasoning": "..." } ],
  "recommended": [ ... ],
  "max": [ ... ]
}`;

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: { diagnosis_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!body.diagnosis_id) {
    return jsonResponse({ error: "Missing 'diagnosis_id'" }, 400);
  }

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY is not configured on this project" }, 500);
  }

  // Forwards the caller's own access token so RLS scopes every read/write to
  // their session (own diagnosis, own recommendations). Requires a real
  // (even anonymous) Supabase auth session — see project notes.
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

  const { data: diagnosis, error: diagnosisErr } = await supabase
    .from("diagnoses")
    .select("id, extracted_profile, companies ( description, headcount_range, stage )")
    .eq("id", body.diagnosis_id)
    .maybeSingle();

  if (diagnosisErr) {
    return jsonResponse({ error: `Database error: ${diagnosisErr.message}` }, 500);
  }
  if (!diagnosis) {
    return jsonResponse({ error: "diagnosis_id not found or not owned by this session" }, 404);
  }
  if (!diagnosis.extracted_profile) {
    return jsonResponse({ error: "This diagnosis has no extracted_profile yet" }, 400);
  }

  const { data: rows, error: catalogueErr } = await supabase
    .from("software_products")
    .select(`
      id, name, short_description, pricing_model, starting_price_usd,
      min_company_size, max_company_size, target_market, website_url,
      software_product_categories ( is_primary, software_categories ( name ) )
    `);

  if (catalogueErr) {
    return jsonResponse({ error: `Database error: ${catalogueErr.message}` }, 500);
  }

  const catalogue = (rows ?? []).map((p: any) => {
    const primaryLink = (p.software_product_categories ?? []).find((l: any) => l.is_primary) ??
      (p.software_product_categories ?? [])[0];
    return {
      id: p.id,
      name: p.name,
      category: primaryLink?.software_categories?.name ?? null,
      short_description: p.short_description,
      pricing_model: p.pricing_model,
      starting_price_usd: p.starting_price_usd,
      min_company_size: p.min_company_size,
      max_company_size: p.max_company_size,
      target_market: p.target_market,
      website_url: p.website_url,
    };
  });
  const catalogueById = new Map(catalogue.map((p) => [p.id, p]));

  const userMessage = JSON.stringify({
    company: diagnosis.companies,
    extracted_profile: diagnosis.extracted_profile,
    catalogue,
  });

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
        max_tokens: 3000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
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

  let parsed: Record<Tier, any[]>;
  try {
    parsed = extractJson(textBlock) as Record<Tier, any[]>;
  } catch {
    return jsonResponse({ error: "Could not parse Claude's response", raw: textBlock }, 502);
  }

  const rowsToInsert: any[] = [];
  const responseByTier: Record<Tier, any[]> = { min: [], recommended: [], max: [] };

  for (const tier of TIERS) {
    for (const item of parsed[tier] ?? []) {
      const product = catalogueById.get(item.product_id);
      if (!product) continue; // drop anything not in the real catalogue
      rowsToInsert.push({
        diagnosis_id: body.diagnosis_id,
        product_id: item.product_id,
        rank: item.rank ?? 1,
        match_score: item.match_score ?? null,
        reasoning: item.reasoning ?? null,
        tier,
        status: "suggested",
      });
      responseByTier[tier].push({
        product,
        rank: item.rank ?? 1,
        match_score: item.match_score ?? null,
        reasoning: item.reasoning ?? null,
      });
    }
  }

  // Replace any previous recommendation set for this diagnosis so re-running
  // stays idempotent instead of accumulating duplicates.
  const { error: deleteErr } = await supabase
    .from("recommendations")
    .delete()
    .eq("diagnosis_id", body.diagnosis_id);
  if (deleteErr) {
    return jsonResponse({ error: `Could not clear previous recommendations: ${deleteErr.message}` }, 500);
  }

  if (rowsToInsert.length > 0) {
    const { error: insertErr } = await supabase.from("recommendations").insert(rowsToInsert);
    if (insertErr) {
      return jsonResponse({ error: `Could not save recommendations: ${insertErr.message}` }, 500);
    }
  }

  return jsonResponse({ diagnosis_id: body.diagnosis_id, tiers: responseByTier });
});
