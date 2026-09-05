import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ANTHROPIC_MODEL = "claude-sonnet-5";

interface DiagnosticInput {
  website?: string;
  description?: string;
  headcount_range?: string;
  market?: string;
  function?: string;
  raw_input?: string;
}

interface CatalogueProduct {
  id: string;
  name: string;
  category: string | null;
  short_description: string;
  pricing_model: string | null;
  starting_price_usd: number | null;
  min_company_size: number | null;
  max_company_size: number | null;
  target_market: string | null;
  website_url: string | null;
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let input: DiagnosticInput;
  try {
    input = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!input.description || !input.description.trim()) {
    return jsonResponse({ error: "Missing 'description'" }, 400);
  }

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY is not configured on this project" }, 500);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  );

  const { data: rows, error: dbError } = await supabase
    .from("software_products")
    .select(`
      id, name, short_description, pricing_model, starting_price_usd,
      min_company_size, max_company_size, target_market, website_url,
      software_product_categories ( is_primary, software_categories ( name ) )
    `);

  if (dbError) {
    return jsonResponse({ error: `Database error: ${dbError.message}` }, 500);
  }

  const catalogue: CatalogueProduct[] = (rows ?? []).map((p: any) => {
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

  const systemPrompt = `Tu es le moteur de diagnostic de Stagely, un outil qui recommande le bon stack logiciel a des fondateurs de startups early-stage sans equipe RevOps dediee.

On te donne une description d'entreprise et un catalogue de logiciels disponibles (JSON). Tu dois :
1. Identifier le stade de l'entreprise (amorcage, early_stage, ou croissance) a partir de sa taille et de sa description.
2. Recommander UNIQUEMENT des logiciels presents dans le catalogue fourni, en utilisant leur "id" exact. Ne jamais inventer un outil absent du catalogue. Si aucun outil du catalogue ne convient a un besoin, ne force pas une recommandation.
3. Pour chaque recommandation, expliquer brievement pourquoi cet outil convient a ce stade precis (pas plus gros que necessaire), en francais, ton direct et peer-to-peer fondateur (pas corporate).
4. Donner une courte note de compatibilite qualitative entre les outils recommandes (pas de score chiffre invente).

Reponds UNIQUEMENT avec un objet JSON valide, sans texte avant ni apres, exactement dans ce format :
{
  "stage": "amorcage" | "early_stage" | "croissance",
  "headline": "phrase d'accroche courte",
  "summary": "1-2 phrases resumant la situation de l'entreprise",
  "recommendations": [
    { "product_id": "uuid exact du catalogue", "priority": "must_have" | "nice_to_have", "reasoning": "1-2 phrases" }
  ],
  "compatibility_note": "1-2 phrases qualitatives sur la compatibilite entre les outils recommandes"
}`;

  const userMessage = JSON.stringify({ company: input, catalogue });

  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return jsonResponse({ error: `Claude API error: ${errText}` }, 502);
  }

  const anthropicData = await anthropicRes.json();
  const textBlock = anthropicData.content?.find((b: any) => b.type === "text")?.text ?? "";

  let parsed: any;
  try {
    parsed = extractJson(textBlock);
  } catch {
    return jsonResponse({ error: "Could not parse Claude's response", raw: textBlock }, 502);
  }

  const catalogueById = new Map(catalogue.map((p) => [p.id, p]));
  const recommendations = (parsed.recommendations ?? [])
    .filter((r: any) => catalogueById.has(r.product_id))
    .map((r: any) => ({
      priority: r.priority,
      reasoning: r.reasoning,
      product: catalogueById.get(r.product_id),
    }));

  return jsonResponse({
    stage: parsed.stage,
    headline: parsed.headline,
    summary: parsed.summary,
    compatibility_note: parsed.compatibility_note,
    recommendations,
  });
});
