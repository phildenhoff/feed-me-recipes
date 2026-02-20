/**
 * Claude Haiku recipe parsing
 * Extracts structured recipe data from Instagram captions
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

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

const ParseResultSchema = z.discriminatedUnion("is_recipe", [
  z.object({
    is_recipe: z.literal(false),
    reason: z.string(),
  }),
  z.object({
    is_recipe: z.literal(true),
    confidence: z.number(),
    recipe: RecipeSchema,
  }),
]);

export type Ingredient = z.infer<typeof IngredientSchema>;
export type Recipe = z.infer<typeof RecipeSchema>;
export type ParseResult = z.infer<typeof ParseResultSchema>;

const CAPTION_SYSTEM_PROMPT = `You are a recipe extraction assistant. Given an Instagram post caption, extract the recipe into structured data.

If the caption does not contain a recipe (no ingredients or no instructions), set is_recipe to false and provide a reason.

If it contains a recipe, set is_recipe to true and populate the recipe fields. Rules:
- Infer recipe name from context if not explicit
- Parse quantities like "2 tbsp", "1/2 cup", "3 cloves" into the quantity field
- Separate ingredient notes (e.g., "minced", "room temperature") into the note field
- Number steps if not already numbered
- prepTime/cookTime in minutes (omit if not specified)
- confidence: 0.0-1.0 — use < 0.7 when the extraction may need human review`;

const JSONLD_WITH_CAPTION_SYSTEM_PROMPT = `You are a recipe extraction assistant. You are given two sources:
1. Schema.org Recipe JSON-LD (structured data from the recipe's website) — treat this as authoritative for measurements, steps, and timings.
2. An Instagram caption from the recipe creator — use this for personal notes, tips, variations, and any context not captured in the structured data.

Merge both sources into the structured recipe output. Rules:
- Use JSON-LD quantities and measurements verbatim — do NOT invent or adjust quantities
- prepTime/cookTime in minutes (parse ISO 8601 durations, e.g. PT1H30M = 90)
- recipeInstructions may be strings or HowToStep objects — extract the text
- Separate ingredient quantities from names where possible
- Capture creator tips, personal notes, or variations from the Instagram caption in the notes field
- Set confidence to 1.0 when JSON-LD is present
- If the data cannot be mapped to a valid recipe, set is_recipe to false`;

const JSONLD_SYSTEM_PROMPT = `You are a recipe extraction assistant. Given Schema.org Recipe structured data (JSON-LD), convert it into structured recipe output. Rules:
- prepTime/cookTime in minutes (parse ISO 8601 durations, e.g. PT1H30M = 90)
- recipeInstructions may be strings or HowToStep objects — extract the text
- Separate ingredient quantities from names where possible
- Set confidence to 1.0
- If the data cannot be mapped to a valid recipe, set is_recipe to false`;

const OUTPUT_FORMAT = zodOutputFormat(ParseResultSchema);

export async function parseRecipe(
  caption: string,
  anthropicApiKey: string,
): Promise<ParseResult> {
  console.log(`[parser] Parsing caption (${caption.length} chars)`);

  const client = new Anthropic({ apiKey: anthropicApiKey });

  const response = await client.beta.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    system: CAPTION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Extract the recipe from this Instagram caption:\n\n${caption}`,
      },
    ],
    output_config: { format: OUTPUT_FORMAT },
  });

  const text = response.content[0];
  if (text.type !== "text") throw new Error("Unexpected response type");
  const result = ParseResultSchema.parse(JSON.parse(text.text));

  if (result.is_recipe) {
    console.log(
      `[parser] Recipe extracted: "${result.recipe.name}" (confidence: ${result.confidence})`,
    );
  } else {
    console.log(`[parser] Not a recipe: ${result.reason}`);
  }

  return result;
}

export async function parseRecipeFromJsonLdAndCaption(
  jsonLd: Record<string, unknown>,
  caption: string,
  anthropicApiKey: string,
): Promise<ParseResult> {
  console.log("[parser] Parsing recipe from JSON-LD + Instagram caption");

  const client = new Anthropic({ apiKey: anthropicApiKey });

  const response = await client.beta.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    system: JSONLD_WITH_CAPTION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `JSON-LD structured data:\n\n${JSON.stringify(jsonLd, null, 2)}\n\n---\n\nInstagram caption:\n\n${caption}`,
      },
    ],
    output_config: { format: OUTPUT_FORMAT },
  });

  const text = response.content[0];
  if (text.type !== "text") throw new Error("Unexpected response type");
  const result = ParseResultSchema.parse(JSON.parse(text.text));

  if (result.is_recipe) {
    console.log(
      `[parser] Recipe extracted from JSON-LD+caption: "${result.recipe.name}"`,
    );
  } else {
    console.log(`[parser] JSON-LD+caption not a recipe: ${result.reason}`);
  }

  return result;
}

export async function parseRecipeFromJsonLd(
  jsonLd: Record<string, unknown>,
  anthropicApiKey: string,
): Promise<ParseResult> {
  console.log("[parser] Parsing recipe from JSON-LD structured data");

  const client = new Anthropic({ apiKey: anthropicApiKey });

  const response = await client.beta.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    system: JSONLD_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Convert this Schema.org Recipe data:\n\n${JSON.stringify(jsonLd, null, 2)}`,
      },
    ],
    output_config: { format: OUTPUT_FORMAT },
  });

  const text = response.content[0];
  if (text.type !== "text") throw new Error("Unexpected response type");
  const result = ParseResultSchema.parse(JSON.parse(text.text));

  if (result.is_recipe) {
    console.log(
      `[parser] Recipe extracted from JSON-LD: "${result.recipe.name}"`,
    );
  } else {
    console.log(`[parser] JSON-LD not a recipe: ${result.reason}`);
  }

  return result;
}
