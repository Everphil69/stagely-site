# Stagely — contexte projet

## Le produit
SaaS/GTM pour fondateurs de startups early-stage sans équipe RevOps dédiée.
One-liner : *le bon stack pour votre équipe et votre stade.*

4 fonctions :
1. Diagnostique les besoins d'une entreprise à partir d'une description
2. Recommande un package logiciel adapté
3. Vérifie si l'entreprise paie trop cher (vs. prix réellement négociés)
4. Vérifie la compatibilité avec la stack existante

Ton : clean et digne de confiance, mais peer-to-peer fondateur — pas corporate/enterprise.

## Statut
v1 — premiers écrans construits, pas encore de vrais utilisateurs. Le fondateur (Jean) est
lui-même l'early adopter cible pour l'instant.

## Nom
**Stagely**. Vérifié sans conflit majeur en logiciel/SaaS (recherche rapide, pas de dépôt de
marque formel). `stagely.app` est pris par une app théâtre sans rapport (risque jugé faible).
`stagely.fr` disponible mais **pas encore acheté**. `.com` non vérifié.

## Brand kit
- **Couleurs** : teal profond `#0F6E56` (primaire), corail chaud `#D85A30` (accent, usage
  parcimonieux), ivoire chaud `#F7F5F1` (fond), encre `#2C2C2A` (texte), gris `#5F5E5A`
  (texte secondaire)
- **Typo** : Fraunces (titres, serif, 500–600) + Inter (corps, sans, 400–500), via Google Fonts
- **Logo** : 3 barres ascendantes, la dernière accentuée en corail — symbolise "le bon stade,
  pas le plus gros stack"

## Stack technique
- **Frontend** : HTML/CSS/JS vanilla, pas de framework, pas de build step
- **Backend** : Supabase (project ID `wbksebogmyqyjqthwamw`, région eu-west-3)
- **Hébergement** : Netlify, connecté au repo GitHub `Everphil69/stagely-site`,
  déploiement auto à chaque push sur `main`

## Schéma Supabase (état actuel)
- `software_categories` — 17 lignes, colonnes : id, name, slug, description, parent_category_id
  (hiérarchie parent/enfant existe mais pas encore exploitée dans l'UI)
- `software_products` — 15 lignes, colonnes principales : name, slug, short_description,
  pricing_model (flat/per_seat/usage_based/quote_only), starting_price_usd, verified_at,
  website_url
- `software_product_categories` — table de liaison many-to-many (product_id, category_id,
  is_primary). **Important** : `category_id` a été supprimé de `software_products`, toute
  jointure catégorie↔produit passe par cette table.
- `companies`, `diagnoses`, `diagnosis_needs`, `recommendations`, `company_tools`,
  `company_enrichment_snapshots`, `feedback` — tables pour le futur moteur de diagnostic,
  vides pour l'instant (pas encore de logique applicative dessus)
- RLS activé sur toutes les tables. Toute nouvelle table doit avoir ses policies + GRANT
  SELECT pour `anon`/`authenticated` ajoutés explicitement (le projet a "Automatically
  expose new tables" désactivé)

## Pages du site actuel
- `index.html` — landing page (hero, 3 features : diagnostic/benchmark/compatibilité)
- `diagnostic.html` — maquette de l'écran de résultat diagnostic (statique, données fictives
  "Northwind Analytics")
- `catalogue.html` — catalogue connecté en direct à Supabase (clé anon publique, safe à
  exposer car RLS lecture publique sur categories/products), recherche live, catégories
  affichées à plat (pas encore de hiérarchie parent/sous-catégorie dans l'UI)

## Décisions à ne pas remettre en cause sans le dire au fondateur
- Pas de données de pricing dans les imports de logiciels (trop complexe à standardiser)
- Clay identifié comme mécanisme futur de détection de croissance, volontairement mis de
  côté tant qu'il n'y a pas de vrais clients
- Le fondateur préfère l'exécution directe à la planification prolongée — construire plutôt
  que sur-designer en amont

## Style de travail préféré
- Toujours challenger les décisions produit/marque comme le ferait un co-fondateur, pas
  juste exécuter sans recul
- Ne jamais inventer d'information non vérifiée (noms, disponibilité domaine, etc.) —
  vérifier ou dire explicitement que ce n'est pas vérifié
- Éviter le caractère "—" dans les textes rédigés
