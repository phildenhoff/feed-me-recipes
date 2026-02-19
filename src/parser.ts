/**
 * Claude Haiku recipe parsing
 * Extracts structured recipe data from Instagram captions
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

const IngredientSchema = z.object({
  name: z.string(),
  quantity: z.string().optional(),
  note: z.string().optional(),
});

const RecipeSchema = z.object({
  name: z.string(),
  servings: z.string().optional(),
  prepTime: z.number().optional(),
  cookTime: z.number().optional(),
  ingredients: z.array(IngredientSchema),
  steps: z.array(z.string()),
  notes: z.string().optional(),
});

const ParseResultSchema = z.discriminatedUnion('is_recipe', [
  z.object({
    is_recipe: z.literal(false),
    reason: z.string(),
  }),
  z.object({
    is_recipe: z.literal(true),
    confidence: z.number().min(0).max(1),
    recipe: RecipeSchema,
  }),
]);

export type Ingredient = z.infer<typeof IngredientSchema>;
export type Recipe = z.infer<typeof RecipeSchema>;
export type ParseResult = z.infer<typeof ParseResultSchema>;

const CAPTION_SYSTEM_PROMPT = `You are a recipe extraction assistant. Given an Instagram post caption, extract the recipe into structured JSON.

If the caption does not contain a recipe (no ingredients or no instructions), return:
{"is_recipe": false, "reason": "..."}

If it contains a recipe, return:
{
  "is_recipe": true,
  "confidence": 0.0-1.0,
  "recipe": {
    "name": "Recipe Title",
    "servings": "4 servings",
    "prepTime": 10,
    "cookTime": 20,
    "ingredients": [
      {"name": "ingredient", "quantity": "1 cup", "note": "optional note"}
    ],
    "steps": [
      "Step 1...",
      "Step 2..."
    ],
    "notes": "Any additional notes from the caption"
  }
}

Rules:
- Infer recipe name from context if not explicit
- Parse quantities like "2 tbsp", "1/2 cup", "3 cloves"
- Separate ingredient notes (e.g., "minced", "room temperature") into the note field
- Number steps if not already numbered
- prepTime/cookTime in minutes (0 if not specified)
- confidence < 0.7 means the extraction may need human review
- Return ONLY valid JSON, no other text`;

const JSONLD_SYSTEM_PROMPT = `You are a recipe extraction assistant. Given Schema.org Recipe structured data (JSON-LD), convert it into the following JSON structure.

Return:
{
  "is_recipe": true,
  "confidence": 1.0,
  "recipe": {
    "name": "Recipe Title",
    "servings": "4 servings",
    "prepTime": 10,
    "cookTime": 20,
    "ingredients": [
      {"name": "ingredient", "quantity": "1 cup", "note": "optional note"}
    ],
    "steps": [
      "Step 1...",
      "Step 2..."
    ],
    "notes": "Any additional notes"
  }
}

If the data cannot be mapped to a valid recipe, return:
{"is_recipe": false, "reason": "..."}

Rules:
- prepTime/cookTime in minutes (parse ISO 8601 durations, e.g. PT1H30M = 90)
- recipeInstructions may be strings or HowToStep objects — extract the text
- Separate ingredient quantities from names where possible
- Return ONLY valid JSON, no other text`;

export async function parseRecipe(
  caption: string,
  anthropicApiKey: string
): Promise<ParseResult> {
  console.log(`[parser] Parsing caption (${caption.length} chars)`);

  const client = new Anthropic({ apiKey: anthropicApiKey });

  const response = await client.messages.create({
    model: 'claude-3-5-haiku-latest',
    max_tokens: 2048,
    system: CAPTION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Extract the recipe from this Instagram caption:\n\n${caption}`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }

  console.log(`[parser] Got response (${content.text.length} chars)`);

  // Parse and validate the JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.text);
  } catch (e) {
    throw new Error(`Failed to parse Claude response as JSON: ${content.text}`);
  }

  const result = ParseResultSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid recipe structure: ${JSON.stringify(result.error.issues)}`
    );
  }

  if (result.data.is_recipe) {
    console.log(
      `[parser] Recipe extracted: "${result.data.recipe.name}" (confidence: ${result.data.confidence})`
    );
  } else {
    console.log(`[parser] Not a recipe: ${result.data.reason}`);
  }

  return result.data;
}

export async function parseRecipeFromJsonLd(
  jsonLd: Record<string, unknown>,
  anthropicApiKey: string
): Promise<ParseResult> {
  console.log('[parser] Parsing recipe from JSON-LD structured data');

  const client = new Anthropic({ apiKey: anthropicApiKey });

  const response = await client.messages.create({
    model: 'claude-3-5-haiku-latest',
    max_tokens: 2048,
    system: JSONLD_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Convert this Schema.org Recipe data:\n\n${JSON.stringify(jsonLd, null, 2)}`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }

  console.log(`[parser] Got JSON-LD response (${content.text.length} chars)`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.text);
  } catch {
    throw new Error(`Failed to parse Claude response as JSON: ${content.text}`);
  }

  const result = ParseResultSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid recipe structure: ${JSON.stringify(result.error.issues)}`
    );
  }

  if (result.data.is_recipe) {
    console.log(
      `[parser] Recipe extracted from JSON-LD: "${result.data.recipe.name}"`
    );
  } else {
    console.log(`[parser] JSON-LD not a recipe: ${result.data.reason}`);
  }

  return result.data;
}
