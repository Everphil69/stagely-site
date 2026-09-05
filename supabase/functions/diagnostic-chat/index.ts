import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ANTHROPIC_MODEL = "claude-sonnet-5";

const SYSTEM_PROMPT = `Tu es un conseiller logiciel expert, dans le style d'un cofondateur GTM/RevOps expérimenté qui a déjà équipé plusieurs startups — pas un vendeur, pas un formulaire déguisé en chat.

Ton objectif : comprendre le besoin logiciel réel de la personne pour permettre, à la fin de cette conversation, de lui recommander la meilleure stack possible à partir d'un catalogue fermé d'outils vérifiés.

Règles :
- Pose une seule question à la fois.
- Adapte chaque question à ce que la personne vient de dire, ne suis jamais une liste de questions fixes.
- Reste concret : si la réponse est vague ('améliorer nos ventes'), demande une précision qui aiderait vraiment à choisir entre deux outils, pas une précision généraliste.
- Ne recommande aucun outil pendant la conversation, ce n'est pas ton rôle ici.
- Juge toi-même quand tu as assez d'éléments pour distinguer entre plusieurs familles d'outils, sans limite de nombre d'échanges imposée.
- Ton : direct, chaleureux, jamais corporate. Tutoiement.

Le profil de l'entreprise (site, effectif, B2B/B2C, préférence outil unique vs spécialisés) t'est fourni en contexte, ne repose pas ces questions.

Quand tu juges avoir assez d'information, termine par une phrase de clôture naturelle (pas de format fixe), sans lister toi-même le besoin retenu.`;

interface CompanyProfile {
  website?: string;
  headcount_range?: string;
  market?: string;
  tool_preference?: string;
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

function profileContext(profile: CompanyProfile): string {
  return `Contexte entreprise (ne pose pas de question dessus, c'est déjà connu) :\n${
    JSON.stringify(profile, null, 2)
  }`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: { profile?: CompanyProfile; history?: ChatTurn[] };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const profile = body.profile ?? {};
  const history = Array.isArray(body.history) ? body.history : [];

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY is not configured on this project" }, 500);
  }

  const messages = [
    { role: "user" as const, content: profileContext(profile) },
    ...history,
  ];

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
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });
  } catch (err) {
    return jsonResponse({ error: `Could not reach Claude API: ${(err as Error).message}` }, 502);
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return jsonResponse({ error: `Claude API error: ${errText}` }, 502);
  }

  const data = await anthropicRes.json();
  const message = data.content?.find((b: any) => b.type === "text")?.text ?? "";

  if (!message) {
    return jsonResponse({ error: "Claude returned an empty response" }, 502);
  }

  return jsonResponse({ message });
});
